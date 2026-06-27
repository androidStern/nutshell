import { expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shouldUseAppHandoff } from "../src/cli";

setDefaultTimeout(15_000);

test("help teaches common user workflows without exposing app plumbing", async () => {
  const result = await runCli(["help"]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Sync configured sources into a local digital trace for LLM agents.");
  expect(result.stdout).toContain("Common tasks:");
  expect(result.stdout).toContain("nutshell setup");
  expect(result.stdout).toContain("nutshell status");
  expect(result.stdout).toContain("nutshell sync");
  expect(result.stdout).toContain("nutshell sync pause");
  expect(result.stdout).toContain("nutshell sync resume");
  expect(result.stdout).toContain("nutshell reset");
  expect(result.stdout).toContain("nutshell dashboard");
  expect(result.stdout).toContain("nutshell import");
  expect(result.stdout).toContain("nutshell help sync");
  expect(result.stdout).toContain("nutshell help reset");
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

test("layered help explains sync and reset without creating state", async () => {
  for (const [args, expected] of [
    [["help", "sync"], "nutshell sync pause"],
    [["help", "reset"], "Reset does not delete Chrome login"],
    [["sync", "--help"], "nutshell sync resume"],
    [["reset", "--help"], "nutshell reset source youtube"],
  ] as const) {
    const root = mkdtempSync(join(tmpdir(), "nutshell-cli-layered-help-"));
    try {
      const result = await runCli(["--root", root, ...args]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(expected);
      expect(existsSync(join(root, "nutconfig.jsonc"))).toBe(false);
      expect(existsSync(join(root, "nutshell.sqlite"))).toBe(false);
      expect(existsSync(join(root, "logs"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

test("sync pause and resume use the automatic-sync user path", async () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-cli-sync-control-"));
  try {
    const appPath = join(root, "Nutshell.app");
    const appExecutable = installFakeApp(appPath, root);
    writeFileSync(join(root, "nutconfig.jsonc"), `${JSON.stringify({ storage: { root }, app: { path: appPath } }, null, 2)}\n`);

    const paused = await runCli(["--root", root, "sync", "pause"]);
    expect(paused.exitCode).toBe(0);
    expect(paused.stdout).toContain("Automatic sync paused");

    const resumed = await runCli(["--root", root, "sync", "resume", "--json"]);
    expect(resumed.exitCode).toBe(0);
    expect(JSON.parse(resumed.stdout)).toMatchObject({ status: "ok", action: "resume" });

    const calls = readFileSync(join(root, "calls.log"), "utf8").trim().split("\n");
    expect(calls).toEqual([
      `${appExecutable} disable-sync`,
      `${appExecutable} enable-sync`,
      `${appExecutable} register-agent`,
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sync status uses reader-facing automatic-sync text", async () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-cli-sync-status-"));
  try {
    const appPath = join(root, "Nutshell.app");
    installFakeApp(appPath, root);
    mkdirSync(join(root, "logs"), { recursive: true });
    const nextRunAt = new Date(Date.now() + 15 * 60_000).toISOString();
    writeFileSync(
      join(root, "logs", "nutshell-agent.jsonl"),
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        message: "next sync scheduled",
        detail: { intervalSeconds: 900, nextRunAt },
      })}\n`,
    );
    writeFileSync(
      join(root, "nutconfig.jsonc"),
      `${JSON.stringify(
        {
          storage: { root },
          app: { path: appPath },
          scheduler: { intervalSeconds: 900 },
          plugins: {
            youtube: { enabled: false },
            podcasts: { enabled: false },
            apple_notes: { enabled: false },
            twitter: { enabled: false },
          },
        },
        null,
        2,
      )}\n`,
    );

    const result = await runCli(["--root", root, "sync", "status"], { TZ: "America/Chicago" });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Sync status");
    expect(result.stdout).toContain("Automatic sync: on");
    expect(result.stdout).toContain("Background agent: enabled");
    expect(result.stdout).toContain("Last sync: not run yet");
    expect(result.stdout).toContain("Next sync:");
    expect(result.stdout).toContain("Run `nutshell sync` to sync immediately.");
    expect(result.stdout).not.toContain("SCHEDULE:");
    expect(result.stdout).not.toContain(`next=${nextRunAt}`);
    expect(result.stdout).not.toContain(nextRunAt);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
    ["reset", "--help"],
    ["status", "--help"],
    ["health", "--help"],
    ["doctor", "--help"],
    ["dashboard", "--help"],
    ["import", "--help"],
  ]) {
    const root = mkdtempSync(join(tmpdir(), "nutshell-cli-help-"));
    try {
      const result = await runCli(["--root", root, ...args]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("nutshell");
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

function installFakeApp(appPath: string, root: string): string {
  const executable = join(appPath, "Contents", "MacOS", "Nutshell");
  mkdirSync(join(appPath, "Contents", "MacOS"), { recursive: true });
  writeFileSync(
    executable,
    `#!/bin/sh
set -eu
printf '%s %s\\n' "$0" "$*" >> ${JSON.stringify(join(root, "calls.log"))}
case "\${1:-}" in
  status)
    echo "Full Disk Access: granted"
    echo "Agent status: enabled"
    echo "Background sync: enabled"
    echo "Data root: ${root}"
    ;;
  disable-sync) echo "automatic sync paused" ;;
  enable-sync) echo "automatic sync resumed" ;;
  register-agent) echo "automatic sync ready" ;;
  *) echo "unexpected fake app command: $*" >&2; exit 64 ;;
esac
`,
  );
  chmodSync(executable, 0o755);
  return executable;
}

async function runCli(args: string[], env: Record<string, string | undefined> = {}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, "src/cli.ts", ...args], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { exitCode, stdout, stderr };
}
