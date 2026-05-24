import { expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("tarball installer defaults to ~/.local/bin instead of a writable Homebrew prefix", async () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-install-test-"));
  const home = join(root, "home");
  const fakeHomebrewBin = join(root, "opt-homebrew-bin");
  const release = join(root, "release");
  const sourceBin = join(release, "bin", "nutshell");
  const logPath = join(root, "commands.log");

  try {
    mkdirSync(join(release, "bin"), { recursive: true });
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    mkdirSync(fakeHomebrewBin, { recursive: true });
    cpSync(join(process.cwd(), "packaging", "tarball", "install.sh"), join(release, "install.sh"));
    chmodSync(join(release, "install.sh"), 0o755);
    writeFileSync(
      sourceBin,
      `#!/usr/bin/env sh\nprintf '%s\\n' "$*" >> "${logPath}"\nexit 0\n`,
      { mode: 0o755 },
    );

    const result = await run([join(release, "install.sh")], {
      HOME: home,
      PATH: `${fakeHomebrewBin}:${join(home, ".local", "bin")}:/usr/bin:/bin`,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`Installed Nutshell at ${join(home, ".local", "bin", "nutshell")}`);
    expect(existsSync(join(home, ".local", "bin", "nutshell"))).toBe(true);
    expect(existsSync(join(fakeHomebrewBin, "nutshell"))).toBe(false);
    expect(readFileSync(logPath, "utf8")).toContain("launchd install");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function run(cmd: string[], env: Record<string, string>): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { exitCode, stdout, stderr };
}
