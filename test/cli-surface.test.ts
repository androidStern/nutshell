import { expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shouldUseAppHandoff } from "../src/cli";

setDefaultTimeout(15_000);

test("help exposes only the minimal product CLI", async () => {
  const result = await runCli(["help"]);
  expect(result.exitCode).toBe(0);
  // Exact public surface: six commands, one descriptive line each.
  expect(result.stdout.trim().split("\n")).toHaveLength(6);
  expect(result.stdout).toContain("nutshell setup");
  expect(result.stdout).toContain("safe to re-run anytime");
  expect(result.stdout).toContain("nutshell sync [all|source] [--json]");
  expect(result.stdout).toContain("nutshell health [--json]");
  expect(result.stdout).toContain("nutshell doctor [source] [--json]");
  expect(result.stdout).toContain("nutshell dashboard [--no-open]");
  expect(result.stdout).toContain("nutshell import <source> <archive>");
  expect(result.stdout).toContain("nutshell import twitter ~/Downloads/x-archive.zip");
  // Removed user surfaces must not leak back into help (mirrors certify-release).
  for (const forbidden of ["init", "launchd", "migrate", "legacy", "waive", "preserve", "canonical", "repair-plan", "enrich"]) {
    expect(result.stdout).not.toContain(forbidden);
  }
  expect(result.stdout).not.toContain("nutshell app ");
  expect(result.stdout).not.toContain("nutshell query");
  expect(result.stdout).not.toContain("nutshell day");
  expect(result.stdout).not.toContain("--root");
  for (const forbidden of [
    "trace migrate",
    "trace legacy",
    "trace backfill",
    "trace doctor",
    "trace podcasts",
    "trace google youtube",
    "trace import canonical",
    "trace project",
  ]) {
    expect(result.stdout).not.toContain(forbidden);
  }
});

test("old machine-specific commands are not accepted", async () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-cli-"));
  try {
    for (const args of [
      ["--root", root, "migrate", "current"],
      ["--root", root, "legacy", "status"],
      ["--root", root, "import", "x", "--path", "anything"],
      ["--root", root, "import", "google-takeout", "--source", "youtube", "--path", "anything"],
      ["--root", root, "import", "canonical", "--source", "podcasts", "--path", "anything"],
      ["--root", root, "backfill", "waive", "youtube", "--reason", "no"],
      ["--root", root, "init"],
      ["--root", root, "plugins"],
      ["--root", root, "query", "--json"],
      ["--root", root, "day", "2026-05-24", "--json"],
      ["--root", root, "enrich", "twitter", "--json"],
      ["--root", root, "launchd", "status", "--json"],
      ["--root", root, "launchd", "install", "--json"],
      ["--root", root, "launchd", "uninstall", "--json"],
    ]) {
      const result = await runCli(args);
      expect(result.exitCode).not.toBe(0);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// "version command uses the public nutshell name" was removed by the test
// traceability audit (docs/test-traceability.md): strictly weaker duplicate of
// the exact-match assertion below, which already pins the public name.
test("version command matches package version", async () => {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { version: string };
  const result = await runCli(["--version"]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim()).toBe(`nutshell ${pkg.version}`);
});

test("packaged macOS protected commands hand off to Nutshell.app", () => {
  expect(shouldUseAppHandoff("health", {}, "/opt/homebrew/bin/nutshell", "darwin")).toBe(true);
  expect(shouldUseAppHandoff("doctor", {}, "/opt/homebrew/bin/nutshell", "darwin")).toBe(true);
  expect(shouldUseAppHandoff("sync", {}, "/opt/homebrew/bin/nutshell", "darwin")).toBe(true);
  expect(shouldUseAppHandoff("import", {}, "/opt/homebrew/bin/nutshell", "darwin")).toBe(false);
  expect(shouldUseAppHandoff("doctor", { NUTSHELL_APP_BUNDLE_ID: "com.winterfell.nutshell" }, "/opt/homebrew/bin/nutshell", "darwin")).toBe(false);
  expect(shouldUseAppHandoff("doctor", {}, "src/cli.ts", "darwin")).toBe(false);
  expect(shouldUseAppHandoff("doctor", {}, "/opt/homebrew/bin/nutshell", "linux")).toBe(false);
});

test("subcommand help is side-effect free", async () => {
  for (const args of [
    ["sync", "--help"],
    ["health", "--help"],
    ["doctor", "--help"],
    ["dashboard", "--help"],
    ["import", "--help"],
  ]) {
    const root = mkdtempSync(join(tmpdir(), "nutshell-cli-help-"));
    try {
      const result = await runCli(["--root", root, ...args]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("nutshell setup");
      expect(existsSync(join(root, "nutconfig.jsonc"))).toBe(false);
      expect(existsSync(join(root, "nutshell.sqlite"))).toBe(false);
      expect(existsSync(join(root, "run.lock"))).toBe(false);
      expect(existsSync(join(root, "logs"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("invalid numeric flags fail before runtime state is created", async () => {
  for (const args of [
    ["sync", "all", "--timeout", "soon", "--json"],
    ["sync", "all", "--max-requests", "many", "--json"],
    ["dashboard", "--port", "local", "--no-open"],
  ]) {
    const root = mkdtempSync(join(tmpdir(), "nutshell-cli-invalid-"));
    try {
      const result = await runCli(["--root", root, ...args]);
      expect(result.exitCode).toBe(64);
      expect(result.stderr).toContain("must be an integer");
      expect(existsSync(join(root, "nutconfig.jsonc"))).toBe(false);
      expect(existsSync(join(root, "nutshell.sqlite"))).toBe(false);
      expect(existsSync(join(root, "run.lock"))).toBe(false);
      expect(existsSync(join(root, "logs"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

async function runCli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, "src/cli.ts", ...args], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { exitCode, stdout, stderr };
}
