import { expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBuildArch, resolveBuildArch } from "../scripts/lib/build-arch.ts";
import { homebrewFormula } from "../scripts/lib/homebrew-formula.ts";

test("tarball installer copies CLI and app without removed commands", async () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-install-test-"));
  const home = join(root, "home");
  const fakeHomebrewBin = join(root, "opt-homebrew-bin");
    const release = join(root, "release");
    const sourceBin = join(release, "bin", "nutshell");
    const sourceApp = join(release, "Nutshell.app", "Contents", "MacOS");
    const logPath = join(root, "commands.log");

  try {
    mkdirSync(join(release, "bin"), { recursive: true });
    mkdirSync(sourceApp, { recursive: true });
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    mkdirSync(join(home, "Applications"), { recursive: true });
    mkdirSync(fakeHomebrewBin, { recursive: true });
    cpSync(join(process.cwd(), "packaging", "tarball", "install.sh"), join(release, "install.sh"));
    chmodSync(join(release, "install.sh"), 0o755);
    writeFileSync(join(sourceApp, "Nutshell"), "#!/usr/bin/env sh\nexit 0\n", { mode: 0o755 });
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
    expect(existsSync(join(home, "Applications", "Nutshell.app", "Contents", "MacOS", "Nutshell"))).toBe(true);
    expect(existsSync(join(fakeHomebrewBin, "nutshell"))).toBe(false);
    const commandLog = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
    expect(commandLog).not.toMatch(/\b(init|launchd|migrate|legacy|waive|preserve|canonical|enrich)\b/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("homebrew packaging does not define raw protected-data service", () => {
  const files = [
    join(process.cwd(), "packaging", "homebrew", "nutshell.rb"),
    join(process.cwd(), "scripts", "build-tarball.ts"),
    join(process.cwd(), "scripts", "lib", "homebrew-formula.ts"),
  ];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    expect(text).not.toMatch(/service\s+do/);
    expect(text).not.toMatch(/brew\s+services/);
    expect(text).not.toMatch(/nutshell\s+sync/);
  }
});

test("generated homebrew formula selects per-architecture tarballs", () => {
  const armUrl = "https://github.com/androidStern/nutshell/releases/download/v9.9.9/nutshell-9.9.9-darwin-arm64.tar.gz";
  const x64Url = "https://github.com/androidStern/nutshell/releases/download/v9.9.9/nutshell-9.9.9-darwin-x64.tar.gz";
  const armSha = "a".repeat(64);
  const x64Sha = "b".repeat(64);
  const formula = homebrewFormula({
    version: "9.9.9",
    homepage: "https://github.com/androidStern/nutshell",
    arm64: { url: armUrl, sha256: armSha },
    x64: { url: x64Url, sha256: x64Sha },
  });

  expect(formula).toContain("class Nutshell < Formula");
  expect(formula).toContain('desc "Local personal trace ingestion runtime"');
  expect(formula).toContain('version "9.9.9"');
  // The Swift app is built with -target <arch>-apple-macosx14.0, so the formula floor is Sonoma.
  expect(formula).toContain("depends_on macos: :sonoma");
  expect(formula).toContain(`on_arm do\n    url "${armUrl}"\n    sha256 "${armSha}"\n  end`);
  expect(formula).toContain(`on_intel do\n    url "${x64Url}"\n    sha256 "${x64Sha}"\n  end`);
  // No top-level url/sha256 outside the per-arch blocks (two-space indent is formula body level).
  expect(formula).not.toMatch(/\n {2}url /);
  expect(formula).not.toMatch(/\n {2}sha256 /);
  expect(formula).toContain('bin.install "bin/nutshell"');
  expect(formula).toContain('prefix.install "Nutshell.app" if File.directory?("Nutshell.app")');
  expect(formula).toContain("def caveats");
  expect(formula).toContain("nutshell setup");
  expect(formula).toContain("test do");
  expect(formula).toContain('system bin/"nutshell", "--version"');
});

test("build arch resolution prefers flag, then env, then host", () => {
  expect(resolveBuildArch(["--arch", "x64"], {})).toBe("x64");
  expect(resolveBuildArch(["--arch=arm64"], { NUTSHELL_BUILD_ARCH: "x64" })).toBe("arm64");
  expect(resolveBuildArch([], { NUTSHELL_BUILD_ARCH: "x64" })).toBe("x64");
  expect(resolveBuildArch([], {})).toBe(parseBuildArch(process.arch));
  expect(() => resolveBuildArch(["--arch", "riscv"], {})).toThrow(/unsupported build arch/);
  expect(() => resolveBuildArch(["--arch"], {})).toThrow(/--arch requires a value/);
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
