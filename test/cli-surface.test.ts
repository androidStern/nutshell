import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("help exposes only the minimal product CLI", async () => {
  const result = await runCli(["help"]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("nutshell sync [source|all] [--mode recent|backfill]");
  expect(result.stdout).toContain("nutshell import [youtube|twitter] --path <provider-export>");
  expect(result.stdout).toContain("nutshell enrich twitter [--limit N]");
  expect(result.stdout).toContain("nutshell dashboard [--no-open]");
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
    ]) {
      const result = await runCli(args);
      expect(result.exitCode).not.toBe(0);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("version command uses the public nutshell name", async () => {
  const result = await runCli(["--version"]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout.startsWith("nutshell ")).toBe(true);
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
