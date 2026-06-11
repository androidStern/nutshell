import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { hostBuildArch, type BuildArch } from "./lib/build-arch.ts";

type CertStatus = "pass" | "fail";

interface CertStep {
  name: string;
  status: CertStatus;
  detail: Record<string, unknown>;
}

const repo = resolve(import.meta.dir, "..");
const tmp = mkdtempSync(join(tmpdir(), "nutshell-certify-"));
const report: CertStep[] = [];
const hostAppBundle = join(repo, "dist", "macos", `darwin-${hostBuildArch()}`, "Nutshell.app");

await step("build, tests, macOS app, and tarball", async () => {
  await run(["bun", "run", "typecheck"]);
  await run(["bun", "test"]);
  await run(["bun", "run", "lint"]);
  await run(["bun", "run", "build"]);
  await run(["bun", "run", "build:macos-app"]);
  await run(["bun", "run", "build:tarball"]);
  return { ok: true };
});

await step("public CLI surface", async () => {
  const help = await runText(["bun", "run", "src/cli.ts", "help"]);
  const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { version: string };
  const sourceVersion = (await runText(["bun", "run", "src/cli.ts", "--version"])).trim();
  const compiledVersion = (await runText([join(repo, "bin", "nutshell"), "--version"])).trim();
  if (sourceVersion !== `nutshell ${pkg.version}`) throw new Error(`source CLI version mismatch: ${sourceVersion} vs ${pkg.version}`);
  if (compiledVersion !== `nutshell ${pkg.version}`) throw new Error(`compiled CLI version mismatch: ${compiledVersion} vs ${pkg.version}`);
  for (const expected of ["nutshell setup", "nutshell status", "nutshell sync", "nutshell sync pause", "nutshell reset", "nutshell dashboard", "nutshell doctor", "nutshell import"]) {
    if (!help.includes(expected)) throw new Error(`help is missing ${expected}`);
  }
  for (const word of forbiddenUserSurfaceWords()) {
    if (help.includes(word)) throw new Error(`help exposes removed user surface: ${word}`);
  }
  return { helpLines: help.trim().split("\n").length, version: pkg.version };
});

await step("removed commands fail", async () => {
  const commands = [
    ["bun", "run", "src/cli.ts", "init"],
    ["bun", "run", "src/cli.ts", "launchd", "status"],
    ["bun", "run", "src/cli.ts", "launchd", "install"],
    ["bun", "run", "src/cli.ts", "launchd", "uninstall"],
    ["bun", "run", "src/cli.ts", "enrich", "twitter", "--json"],
    ["bun", "run", "src/cli.ts", "migrate", "current"],
    ["bun", "run", "src/cli.ts", "legacy", "status"],
    ["bun", "run", "src/cli.ts", "backfill", "waive", "youtube"],
    ["bun", "run", "src/cli.ts", "import", "canonical", "--source", "podcasts", "--path", "anything"],
  ];
  for (const command of commands) {
    const result = await runResult(command);
    if (result.code === 0) throw new Error(`removed command succeeded: ${command.join(" ")}`);
  }
  return { checked: commands.length };
});

await step("release tarballs contain CLI and app bundle for every release arch", async () => {
  const detail: Record<string, unknown> = {};
  for (const arch of releaseArches()) {
    const tarball = releaseTarballPath(arch);
    if (!existsSync(tarball)) throw new Error(`missing tarball: ${tarball}`);
    if (!existsSync(`${tarball}.sha256`)) throw new Error(`missing sha256 file: ${tarball}.sha256`);
    await run(["tar", "-xzf", tarball, "-C", join(tmp)]);
    const extractedRoot = join(tmp, basename(tarball, ".tar.gz"));
    const manifest = JSON.parse(readFileSync(join(extractedRoot, "manifest.json"), "utf8")) as { arch: string; files: Array<{ path: string }> };
    if (manifest.arch !== arch) throw new Error(`${tarball} manifest arch mismatch: ${manifest.arch} vs ${arch}`);
    const paths = new Set(manifest.files.map((file) => file.path));
    if (!paths.has("bin/nutshell")) throw new Error(`${arch} tarball manifest is missing bin/nutshell`);
    if (process.platform === "darwin" && ![...paths].some((path) => path.startsWith("Nutshell.app/"))) {
      throw new Error(`darwin ${arch} tarball manifest is missing Nutshell.app`);
    }
    if (process.platform === "darwin" && !paths.has("Nutshell.app/Contents/Resources/Nutshell.icns")) {
      throw new Error(`darwin ${arch} tarball manifest is missing Nutshell.app icon`);
    }
    if (process.platform === "darwin" && !paths.has("Nutshell.app/Contents/Resources/nutshell-ascii-animation.mp4")) {
      throw new Error(`darwin ${arch} tarball manifest is missing Nutshell.app setup background video`);
    }
    detail[arch] = { tarball, files: paths.size };
  }
  return detail;
});

await step("homebrew formula selects per-arch tarballs with matching SHAs", async () => {
  if (process.platform !== "darwin") return { skipped: "not darwin" };
  const formulaPath = join(repo, "dist", "release", "homebrew", "nutshell.rb");
  const formula = readFileSync(formulaPath, "utf8");
  if (!formula.includes("depends_on macos: :sonoma")) {
    throw new Error("formula is missing `depends_on macos: :sonoma` (the Swift app targets macosx14.0)");
  }
  const blocks: Record<string, { url: string; sha256: string }> = {};
  for (const [arch, blockName] of [["arm64", "on_arm"], ["x64", "on_intel"]] as const) {
    const match = formula.match(new RegExp(`${blockName} do\\n\\s+url "([^"]+)"\\n\\s+sha256 "([0-9a-f]{64})"\\n\\s+end`));
    if (!match || !match[1] || !match[2]) throw new Error(`formula is missing a ${blockName} block with url and sha256`);
    const [, url, sha256] = match;
    const tarball = releaseTarballPath(arch);
    if (basename(url) !== basename(tarball)) {
      throw new Error(`${blockName} url points at ${basename(url)}, expected ${basename(tarball)}`);
    }
    const recordedSha = readFileSync(`${tarball}.sha256`, "utf8").trim().split(/\s+/)[0];
    if (sha256 !== recordedSha) throw new Error(`${blockName} sha256 ${sha256} does not match ${tarball}.sha256 (${recordedSha})`);
    blocks[blockName] = { url, sha256 };
  }
  return { formulaPath, ...blocks };
});

await step("x64 artifacts run under Rosetta", async () => {
  if (process.platform !== "darwin") return { skipped: "not darwin" };
  const rosetta = await runResult(["arch", "-x86_64", "/usr/bin/true"]);
  if (rosetta.code !== 0) return { skipped: "Rosetta is not installed (`arch -x86_64 /usr/bin/true` failed); x64 smoke not run on this host" };
  const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { version: string };
  const tarball = releaseTarballPath("x64");
  const smokeRoot = join(tmp, "intel-smoke");
  mkdirSync(smokeRoot, { recursive: true });
  await run(["tar", "-xzf", tarball, "-C", smokeRoot]);
  const extractedRoot = join(smokeRoot, basename(tarball, ".tar.gz"));
  const cli = join(extractedRoot, "bin", "nutshell");
  const version = (await runText(["arch", "-x86_64", cli, "--version"])).trim();
  if (version !== `nutshell ${pkg.version}`) throw new Error(`x64 CLI version mismatch under Rosetta: ${version} vs ${pkg.version}`);
  const help = await runText(["arch", "-x86_64", cli, "help"]);
  if (!help.includes("nutshell setup")) throw new Error("x64 CLI help under Rosetta is missing nutshell setup");
  const appExecutable = join(extractedRoot, "Nutshell.app", "Contents", "MacOS", "Nutshell");
  const appHelp = await runText(["arch", "-x86_64", appExecutable, "help"]);
  for (const expected of ["register-agent", "enable-sync", "status", "verify"]) {
    if (!appHelp.includes(expected)) throw new Error(`x64 Nutshell.app help under Rosetta is missing ${expected}`);
  }
  return { tarball, version, appExecutable };
});

await step("app-owned helper surface is present and setup uses it", async () => {
  const appExecutable = join(hostAppBundle, "Contents", "MacOS", "Nutshell");
  if (process.platform === "darwin" && !existsSync(appExecutable)) throw new Error(`missing app executable: ${appExecutable}`);
  if (existsSync(appExecutable)) {
    const help = await runText([appExecutable, "help"]);
    for (const expected of ["register-agent", "enable-sync", "status", "verify"]) {
      if (!help.includes(expected)) throw new Error(`Nutshell.app help is missing ${expected}`);
    }
    const status = await runText([appExecutable, "status"]);
    for (const expected of ["Agent status:", "Full Disk Access:", "Background sync:"]) {
      if (!status.includes(expected)) throw new Error(`Nutshell.app status is missing ${expected}`);
    }
  }
  const setupRuntime = readFileSync(join(repo, "src", "setup", "setup-runtime.ts"), "utf8");
  for (const expected of ['"register-agent"', '"enable-sync"']) {
    if (!setupRuntime.includes(expected)) throw new Error(`setup runtime is missing app-owned command ${expected}`);
  }
  if (setupRuntime.includes('"__sync-once"')) throw new Error("setup may run only a bounded app-owned connection check; the __sync-once bridge is banned in setup");
  for (const expected of ['"--smoke"', '"--json"']) {
    if (!setupRuntime.includes(expected)) throw new Error(`setup may run only a bounded app-owned connection check; setup runtime is missing ${expected}`);
  }
  if (setupRuntime.includes('"--mode", "backfill"')) throw new Error('setup may run only a bounded app-owned connection check; "--mode", "backfill" is banned in setup');
  return { appExecutable };
});

await step("macOS app does not link beta-only Swift runtime libraries", async () => {
  if (process.platform !== "darwin") return { skipped: "not darwin" };
  const executables = [
    join(hostAppBundle, "Contents", "MacOS", "Nutshell"),
    join(hostAppBundle, "Contents", "Library", "LaunchServices", "NutshellAgent"),
  ];
  for (const executable of executables) {
    const libraries = await runText(["otool", "-L", executable]);
    if (libraries.includes("libswift_DarwinFoundation2.dylib")) {
      throw new Error(`${executable} links libswift_DarwinFoundation2.dylib; build with a stable macOS Swift target`);
    }
  }
  return { checked: executables };
});

await step("packaging does not start protected sync from package manager service", async () => {
  const generatedFormula = join(repo, "dist", "release", "homebrew", "nutshell.rb");
  const sources = [
    join(repo, "packaging", "tarball", "install.sh"),
    join(repo, "packaging", "tarball", "uninstall.sh"),
    join(repo, "packaging", "homebrew", "nutshell.rb"),
    generatedFormula,
  ];
  for (const file of sources) {
    const text = readFileSync(file, "utf8");
    if (/service\s+do/.test(text)) throw new Error(`${file} defines a package-manager service`);
    if (/nutshell\s+(init|launchd|enrich|migrate|legacy)/.test(text)) throw new Error(`${file} calls a removed command`);
    if (/brew\s+services/.test(text)) throw new Error(`${file} controls a package-manager service`);
  }
  return { checked: sources.length };
});

await step("package tarball installs command into path", async () => {
  const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { version: string };
  const packDir = join(tmp, "pack");
  mkdirSync(packDir, { recursive: true });
  await run(["bun", "pm", "pack", "--destination", packDir]);
  const tgz = readdirSync(packDir).find((file) => file.endsWith(".tgz"));
  if (!tgz) throw new Error("package tarball was not generated");
  const home = join(tmp, "home");
  const bunInstall = join(tmp, "bun");
  mkdirSync(home, { recursive: true });
  await run(["bun", "install", "-g", join(packDir, tgz)], {
    HOME: home,
    BUN_INSTALL: bunInstall,
    PATH: `${join(bunInstall, "bin")}:${process.env.PATH ?? ""}`,
  });
  const command = (await runText(["sh", "-lc", "command -v nutshell"], {
    HOME: home,
    BUN_INSTALL: bunInstall,
    PATH: `${join(bunInstall, "bin")}:${process.env.PATH ?? ""}`,
  })).trim();
  const version = (await runText(["nutshell", "--version"], {
    HOME: home,
    BUN_INSTALL: bunInstall,
    PATH: `${join(bunInstall, "bin")}:${process.env.PATH ?? ""}`,
  })).trim();
  if (version !== `nutshell ${pkg.version}`) throw new Error(`package install version mismatch: ${version} vs ${pkg.version}`);
  return { command, version };
});

const failed = report.filter((item) => item.status === "fail");
writeReport();
process.stdout.write(`${JSON.stringify({ status: failed.length ? "fail" : "pass", report }, null, 2)}\n`);
process.exit(failed.length ? 1 : 0);

async function step(name: string, fn: () => Promise<Record<string, unknown>>): Promise<void> {
  try {
    report.push({ name, status: "pass", detail: await fn() });
  } catch (error) {
    report.push({ name, status: "fail", detail: { error: String(error) } });
  }
}

async function run(cmd: string[], env: Record<string, string> = {}): Promise<void> {
  const result = await runResult(cmd, env);
  if (result.code !== 0) throw new Error(`${cmd.join(" ")} failed\n${result.stdout}${result.stderr}`);
}

async function runText(cmd: string[], env: Record<string, string> = {}): Promise<string> {
  const result = await runResult(cmd, env);
  if (result.code !== 0) throw new Error(`${cmd.join(" ")} failed\n${result.stdout}${result.stderr}`);
  return result.stdout;
}

async function runResult(cmd: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, {
    cwd: repo,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
}

function releaseArches(): BuildArch[] {
  return process.platform === "darwin" ? ["arm64", "x64"] : [hostBuildArch()];
}

function releaseTarballPath(arch: BuildArch): string {
  const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { version: string };
  const platform = process.platform === "darwin" ? "darwin" : process.platform;
  return join(repo, "dist", "release", `nutshell-${pkg.version}-${platform}-${arch}.tar.gz`);
}

function forbiddenUserSurfaceWords(): string[] {
  return ["init", "launchd", "migrate", "legacy", "waive", "preserve", "canonical", "repair-plan", "enrich"];
}

function writeReport(): void {
  mkdirSync(join(repo, "dist", "release"), { recursive: true });
  writeFileSync(join(repo, "dist", "release", "certification-report.json"), `${JSON.stringify({ generatedAt: new Date().toISOString(), report }, null, 2)}\n`);
}
