import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { Database } from "bun:sqlite";
import type { Cookie } from "@steipete/sweet-cookie";
import type { BrowserCookieRequest, BrowserCookieSet } from "./cookies";

const CHROME_EPOCH_OFFSET_MICROS = 11_644_473_600_000_000n;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

interface ChromeCookieRow {
  name?: unknown;
  value?: unknown;
  host_key?: unknown;
  path?: unknown;
  expires_utc?: unknown;
  samesite?: unknown;
  encrypted_value?: unknown;
  is_secure?: unknown;
  is_httponly?: unknown;
}

export async function readMacChromeCookiesWithPassword(request: BrowserCookieRequest, safeStoragePassword: string): Promise<BrowserCookieSet> {
  const dbPath = resolveChromeCookiesDb(request.profile);
  if (!dbPath) {
    return { cookies: [], warnings: ["Chrome cookies database not found."] };
  }
  const password = safeStoragePassword.trim();
  if (!password) {
    return { cookies: [], warnings: ["Chrome Safe Storage password override was empty."] };
  }

  const tempDir = mkdtempSync(join(tmpdir(), "nutshell-chrome-cookies-"));
  const tempDbPath = join(tempDir, "Cookies");
  try {
    try {
      copyFileSync(dbPath, tempDbPath);
      copySidecar(dbPath, `${tempDbPath}-wal`, "-wal");
      copySidecar(dbPath, `${tempDbPath}-shm`, "-shm");
    } catch (error) {
      return { cookies: [], warnings: [`Failed to copy Chrome cookie DB: ${error instanceof Error ? error.message : String(error)}`] };
    }

    const hosts = cookieHosts(request);
    const rows = readCookieRows(tempDbPath, hosts);
    const metaVersion = readMetaVersion(tempDbPath);
    const stripHashPrefix = metaVersion >= 24;
    const key = pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
    const allowlist = request.names?.length ? new Set(request.names) : null;
    const warnings: string[] = [];
    const cookies: Cookie[] = [];
    let v20DecryptFailureCount = 0;

    for (const row of rows) {
      const name = typeof row.name === "string" ? row.name : null;
      if (!name || (allowlist && !allowlist.has(name))) continue;
      const hostKey = typeof row.host_key === "string" ? row.host_key : null;
      if (!hostKey || !hostMatchesAny(hosts, hostKey)) continue;

      const valueString = typeof row.value === "string" ? row.value : null;
      let value = valueString && valueString.length ? valueString : null;
      if (value === null) {
        const encrypted = encryptedBytes(row.encrypted_value);
        if (!encrypted) continue;
        const prefix = encryptedPrefix(encrypted);
        value = decryptChromiumAes128CbcCookieValue(encrypted, key, stripHashPrefix);
        if (value === null && prefix === "v20") v20DecryptFailureCount++;
      }
      if (value === null) continue;

      const expires = normalizeChromeExpiration(row.expires_utc);
      if (expires !== undefined && expires < Math.floor(Date.now() / 1000)) continue;
      const profile = request.profile || undefined;
      const cookie: Cookie = {
        name,
        value,
        domain: hostKey.startsWith(".") ? hostKey.slice(1) : hostKey,
        path: typeof row.path === "string" && row.path ? row.path : "/",
        secure: boolish(row.is_secure),
        httpOnly: boolish(row.is_httponly),
        source: profile ? { browser: "chrome", profile } : { browser: "chrome" },
      };
      if (expires !== undefined) cookie.expires = expires;
      const sameSite = normalizeSameSite(row.samesite);
      if (sameSite) cookie.sameSite = sameSite;
      cookies.push(cookie);
    }

    if (v20DecryptFailureCount) {
      warnings.push(`${v20DecryptFailureCount} Chromium cookie(s) use v20 App-Bound Encryption and could not be decrypted.`);
    }

    return { cookies: dedupeCookies(cookies), warnings };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function resolveChromeCookiesDb(profile: string | undefined): string | null {
  const chromeRoot = join(homedir(), "Library", "Application Support", "Google", "Chrome");
  const candidates: string[] = [];
  if (profile) {
    const expanded = expandHome(profile);
    if (basename(expanded) === "Cookies") candidates.push(expanded);
    candidates.push(join(expanded, "Network", "Cookies"), join(expanded, "Cookies"));
    candidates.push(join(chromeRoot, profile, "Network", "Cookies"), join(chromeRoot, profile, "Cookies"));
  } else {
    candidates.push(join(chromeRoot, "Default", "Network", "Cookies"), join(chromeRoot, "Default", "Cookies"));
  }
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function readCookieRows(dbPath: string, hosts: string[]): ChromeCookieRow[] {
  const where = buildHostWhereClause(hosts);
  const db = new Database(dbPath, { readonly: true, create: false });
  try {
    return db
      .query(
        `SELECT name, value, host_key, path, expires_utc, samesite, encrypted_value, is_secure, is_httponly
         FROM cookies WHERE (${where}) ORDER BY expires_utc DESC`,
      )
      .all() as ChromeCookieRow[];
  } finally {
    db.close();
  }
}

function readMetaVersion(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true, create: false });
  try {
    const row = db.query("SELECT value FROM meta WHERE key = 'version'").get() as { value?: unknown } | null;
    const value = row?.value;
    if (typeof value === "number") return Math.floor(value);
    if (typeof value === "bigint") return Number(value);
    if (typeof value === "string") {
      const parsed = Number.parseInt(value, 10);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
  } catch {
    return 0;
  } finally {
    db.close();
  }
}

function cookieHosts(request: BrowserCookieRequest): string[] {
  return [request.url, ...(request.origins ?? [])].map((origin) => new URL(origin).hostname);
}

function buildHostWhereClause(hosts: string[]): string {
  const clauses: string[] = [];
  for (const host of hosts) {
    for (const candidate of expandHostCandidates(host)) {
      clauses.push(`host_key = ${sqlLiteral(candidate)}`);
      clauses.push(`host_key = ${sqlLiteral(`.${candidate}`)}`);
      clauses.push(`host_key LIKE ${sqlLiteral(`%.${candidate}`)}`);
    }
  }
  return clauses.length ? clauses.join(" OR ") : "1=0";
}

function expandHostCandidates(host: string): string[] {
  const parts = host.split(".").filter(Boolean);
  if (parts.length <= 1) return [host];
  const candidates = new Set<string>([host]);
  for (let index = 1; index <= parts.length - 2; index++) {
    candidates.add(parts.slice(index).join("."));
  }
  return Array.from(candidates);
}

function hostMatchesAny(hosts: string[], cookieHost: string): boolean {
  const cookieDomain = cookieHost.startsWith(".") ? cookieHost.slice(1) : cookieHost;
  return hosts.some((host) => host === cookieDomain || host.endsWith(`.${cookieDomain}`));
}

function decryptChromiumAes128CbcCookieValue(encryptedValue: Uint8Array, key: Buffer, stripHashPrefix: boolean): string | null {
  const buffer = Buffer.from(encryptedValue);
  const prefix = encryptedPrefix(buffer);
  if (!prefix) return decodeCookieValueBytes(buffer, false);
  if (buffer.length <= 3) return "";
  if (prefix === "v20") return null;
  try {
    const iv = Buffer.alloc(16, 0x20);
    const decipher = createDecipheriv("aes-128-cbc", key, iv);
    decipher.setAutoPadding(false);
    const decrypted = removePkcs7Padding(Buffer.concat([decipher.update(buffer.subarray(3)), decipher.final()]));
    return decodeCookieValueBytes(decrypted, stripHashPrefix);
  } catch {
    return null;
  }
}

function encryptedPrefix(value: Uint8Array): string | null {
  if (value.length < 3) return null;
  const prefix = Buffer.from(value).subarray(0, 3).toString("utf8");
  return /^v\d\d$/.test(prefix) ? prefix : null;
}

function removePkcs7Padding(value: Buffer): Buffer {
  if (!value.length) return value;
  const padding = value[value.length - 1];
  if (!padding || padding > 16) return value;
  return value.subarray(0, value.length - padding);
}

function decodeCookieValueBytes(value: Uint8Array, stripHashPrefix: boolean): string | null {
  const bytes = stripHashPrefix && value.length >= 32 ? value.subarray(32) : value;
  try {
    return stripLeadingControlChars(UTF8_DECODER.decode(bytes));
  } catch {
    return null;
  }
}

function stripLeadingControlChars(value: string): string {
  let index = 0;
  while (index < value.length && value.charCodeAt(index) < 0x20) index++;
  return value.slice(index);
}

function normalizeChromeExpiration(value: unknown): number | undefined {
  const raw = typeof value === "bigint" ? value : typeof value === "number" ? BigInt(Math.trunc(value)) : typeof value === "string" ? BigInt(value || "0") : 0n;
  if (raw <= 0n) return undefined;
  const unixMicros = raw - CHROME_EPOCH_OFFSET_MICROS;
  if (unixMicros <= 0n) return undefined;
  return Number(unixMicros / 1_000_000n);
}

function normalizeSameSite(value: unknown): Cookie["sameSite"] | undefined {
  const numeric = typeof value === "bigint" ? Number(value) : typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : undefined;
  if (numeric === 2) return "Strict";
  if (numeric === 1) return "Lax";
  if (numeric === 0) return "None";
  return undefined;
}

function encryptedBytes(value: unknown): Uint8Array | null {
  return value instanceof Uint8Array ? value : null;
}

function boolish(value: unknown): boolean {
  return value === 1 || value === 1n || value === "1" || value === true;
}

function dedupeCookies(cookies: Cookie[]): Cookie[] {
  const seen = new Map<string, Cookie>();
  for (const cookie of cookies) {
    const key = `${cookie.name}|${cookie.domain ?? ""}|${cookie.path ?? ""}`;
    if (!seen.has(key)) seen.set(key, cookie);
  }
  return Array.from(seen.values());
}

function copySidecar(sourceDbPath: string, target: string, suffix: string): void {
  const sidecar = `${sourceDbPath}${suffix}`;
  if (existsSync(sidecar)) copyFileSync(sidecar, target);
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return resolve(value);
}
