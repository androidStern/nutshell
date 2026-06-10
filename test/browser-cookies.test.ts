import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createCipheriv, pbkdf2Sync } from "node:crypto";
import { join } from "node:path";
import { readBrowserCookies } from "../src/browser/cookies";
import { readMacChromeCookiesWithPassword } from "../src/browser/chrome-macos";

const CHROME_EPOCH_OFFSET_MICROS = 11_644_473_600_000_000n;

test("macOS Chrome reader decrypts cookies with supplied Safe Storage password", async () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-chrome-cookies-"));
  try {
    const dbPath = join(root, "Cookies");
    createChromeCookieDb(dbPath, {
      host: ".google.com",
      name: "SID",
      value: "sid-value",
      safeStoragePassword: "safe-storage-secret",
    });

    const result = await readMacChromeCookiesWithPassword(
      { url: "https://myactivity.google.com/myactivity", names: ["SID"], profile: dbPath },
      "safe-storage-secret",
    );

    expect(result.warnings).toEqual([]);
    expect(result.cookies).toHaveLength(1);
    expect(result.cookies[0]?.name).toBe("SID");
    expect(result.cookies[0]?.value).toBe("sid-value");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "darwin")("browser cookie reader uses app-provided Chrome Safe Storage password on macOS", async () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-chrome-cookies-"));
  const previous = process.env.NUTSHELL_CHROME_SAFE_STORAGE_PASSWORD;
  try {
    const dbPath = join(root, "Cookies");
    createChromeCookieDb(dbPath, {
      host: ".x.com",
      name: "auth_token",
      value: "x-value",
      safeStoragePassword: "safe-storage-secret",
    });
    process.env.NUTSHELL_CHROME_SAFE_STORAGE_PASSWORD = "safe-storage-secret";

    const result = await readBrowserCookies({ url: "https://x.com/home", names: ["auth_token"], browser: "chrome", profile: dbPath });

    expect(result.warnings).toEqual([]);
    expect(result.cookies.map((cookie) => cookie.value)).toEqual(["x-value"]);
  } finally {
    if (previous === undefined) delete process.env.NUTSHELL_CHROME_SAFE_STORAGE_PASSWORD;
    else process.env.NUTSHELL_CHROME_SAFE_STORAGE_PASSWORD = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

function createChromeCookieDb(
  path: string,
  input: { host: string; name: string; value: string; safeStoragePassword: string },
): void {
  const db = new Database(path, { create: true });
  try {
    db.run("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT)");
    db.run("INSERT INTO meta(key, value) VALUES ('version', '24')");
    db.run(
      `CREATE TABLE cookies(
        host_key TEXT,
        name TEXT,
        value TEXT,
        encrypted_value BLOB,
        path TEXT,
        expires_utc INTEGER,
        samesite INTEGER,
        is_secure INTEGER,
        is_httponly INTEGER
      )`,
    );
    const expires = (BigInt(Math.floor(Date.now() / 1000) + 3600) * 1_000_000n + CHROME_EPOCH_OFFSET_MICROS).toString();
    db.query(
      `INSERT INTO cookies(host_key, name, value, encrypted_value, path, expires_utc, samesite, is_secure, is_httponly)
       VALUES (?, ?, '', ?, '/', ?, 1, 1, 1)`,
    ).run(input.host, input.name, encryptedCookie(input.value, input.safeStoragePassword), expires);
  } finally {
    db.close();
  }
}

function encryptedCookie(value: string, safeStoragePassword: string): Buffer {
  const key = pbkdf2Sync(safeStoragePassword, "saltysalt", 1003, 16, "sha1");
  const iv = Buffer.alloc(16, 0x20);
  const cipher = createCipheriv("aes-128-cbc", key, iv);
  const plaintext = Buffer.concat([Buffer.alloc(32), Buffer.from(value)]);
  return Buffer.concat([Buffer.from("v10"), cipher.update(plaintext), cipher.final()]);
}
