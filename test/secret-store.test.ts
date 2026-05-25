import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactJson } from "../src/core/redaction";
import { FileSecretStore } from "../src/setup/secret-store";

test("secret store isolates plugin namespaces and writes with strict file modes", async () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-secrets-"));
  try {
    const path = join(root, "secrets.json");
    const store = new FileSecretStore(path);
    const draft = await store.draft();
    await draft.plugin("twitter").set("session", { auth_token: "secret-token", ct0: "secret-ct0" });
    await draft.plugin("youtube").set("profile", { browser: "chrome" });
    await draft.commit();

    const reloaded = await store.draft();
    expect(await reloaded.plugin("twitter").get("session")).toEqual({ auth_token: "secret-token", ct0: "secret-ct0" });
    expect(await reloaded.plugin("youtube").get("session")).toBeNull();
    expect(await reloaded.plugin("twitter").listKeys()).toEqual(["session"]);
    expect(await reloaded.plugin("youtube").listKeys()).toEqual(["profile"]);
    expect(existsSync(path)).toBe(true);
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("secret store commits are atomic at the plugin namespace interface", async () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-secrets-"));
  try {
    const path = join(root, "secrets.json");
    const store = new FileSecretStore(path);
    const first = await store.draft();
    await first.plugin("twitter").set("session", "one");
    await first.commit();

    const second = await store.draft();
    await second.plugin("twitter").set("session", "two");
    await second.plugin("youtube").set("profile", "chrome");
    await second.commit();

    const raw = JSON.parse(readFileSync(path, "utf8")) as { plugins: Record<string, Record<string, unknown>> };
    expect(raw.plugins.twitter?.session).toBe("two");
    expect(raw.plugins.youtube?.profile).toBe("chrome");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("secret store recovers stale lock files", async () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-secrets-"));
  try {
    const path = join(root, "secrets.json");
    const lock = `${path}.lock`;
    const store = new FileSecretStore(path);
    writeFileSync(lock, JSON.stringify({ pid: 999999, createdAt: "2026-05-24T12:00:00Z", version: 1 }));
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);

    const draft = await store.draft();
    await draft.plugin("twitter").set("session", "ok");
    await draft.commit();

    expect(existsSync(lock)).toBe(false);
    const reloaded = await store.draft();
    expect(await reloaded.plugin("twitter").get("session")).toBe("ok");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("secret store reports a live lock instead of corrupting writes", async () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-secrets-"));
  try {
    const path = join(root, "secrets.json");
    const lock = `${path}.lock`;
    const store = new FileSecretStore(path);
    writeFileSync(lock, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), version: 1 }));

    await expect(store.draft()).rejects.toThrow("secret store lock is held");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("redaction removes secret-looking fields and inline token strings", () => {
  expect(
    redactJson({
      safe: "chrome",
      apiKey: "secret-api-key",
      nested: { Authorization: "Bearer secret", value: "auth_token=abc; ct0=def" },
    }),
  ).toEqual({
    safe: "chrome",
    apiKey: "<redacted>",
    nested: { Authorization: "<redacted>", value: "<redacted>" },
  });
});
