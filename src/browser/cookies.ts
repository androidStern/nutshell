import { getCookies, toCookieHeader, type BrowserName, type Cookie } from "@steipete/sweet-cookie";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readMacChromeCookiesWithPassword } from "./chrome-macos";

export interface BrowserCookieRequest {
  url: string;
  origins?: string[];
  names?: string[];
  browser?: string;
  profile?: string;
  timeoutMs?: number;
}

export interface BrowserCookieHeader {
  header: string;
  warnings: string[];
}

export interface BrowserCookieSet {
  cookies: Cookie[];
  warnings: string[];
}

export async function readBrowserCookieHeader(request: BrowserCookieRequest): Promise<BrowserCookieHeader> {
  const result = await readBrowserCookies(request);
  const header = toCookieHeader(result.cookies, { dedupeByName: true, sort: "name" });
  return { header, warnings: result.warnings };
}

export async function readBrowserCookies(request: BrowserCookieRequest): Promise<BrowserCookieSet> {
  const safeStoragePassword = chromeSafeStoragePasswordOverride();
  if (process.platform === "darwin" && safeStoragePassword && usesChrome(request.browser)) {
    return readMacChromeCookiesWithPassword(request, safeStoragePassword);
  }
  const browsers = request.browser ? [normalizeBrowserName(request.browser)] : undefined;
  const result = await getCookies({
    url: request.url,
    origins: request.origins,
    names: request.names,
    browsers,
    chromeProfile: request.profile || undefined,
    chromiumBrowser: request.browser === "brave" || request.browser === "arc" || request.browser === "chromium" ? request.browser : undefined,
    timeoutMs: request.timeoutMs,
    mode: "merge",
  });
  return { cookies: result.cookies, warnings: result.warnings };
}

export function chromeSafeStoragePasswordOverride(env: Record<string, string | undefined> = process.env): string | null {
  const direct = env.NUTSHELL_CHROME_SAFE_STORAGE_PASSWORD?.trim();
  if (direct) return direct;

  const explicitFile = env.NUTSHELL_CHROME_SAFE_STORAGE_PASSWORD_FILE?.trim();
  const candidates = [
    explicitFile ? resolve(expandHome(explicitFile)) : "",
    join(homedir(), "Nutshell", ".private", "chrome-safe-storage-password"),
  ].filter(Boolean);
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const value = readFileSync(path, "utf8").trim();
    if (value) return value;
  }
  return null;
}

function usesChrome(value: string | undefined): boolean {
  return !value || value === "chrome";
}

export function cookieValue(cookies: readonly Cookie[], name: string): string | null {
  const found = cookies.find((cookie) => cookie.name === name && cookie.value.length > 0);
  return found?.value ?? null;
}

function normalizeBrowserName(value: string): BrowserName {
  if (value === "edge" || value === "firefox" || value === "safari") return value;
  return "chrome";
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}
