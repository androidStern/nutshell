import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

type CertStatus = "pass" | "fail";

interface CertStep {
  name: string;
  status: CertStatus;
  detail: Record<string, unknown>;
}

const repo = resolve(import.meta.dir, "..");
const tmp = mkdtempSync(join(tmpdir(), "nutshell-certify-"));
const report: CertStep[] = [];

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
  for (const expected of ["nutshell setup", "nutshell sync", "nutshell health", "nutshell dashboard", "nutshell doctor", "nutshell import"]) {
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

await step("release tarball contains CLI and app bundle", async () => {
  const tarball = releaseTarballPath();
  const manifestPath = join(tarball.replace(/\.tar\.gz$/, ""), "manifest.json");
  if (!existsSync(tarball)) throw new Error(`missing tarball: ${tarball}`);
  await run(["tar", "-xzf", tarball, "-C", join(tmp)]);
  const extractedRoot = join(tmp, basename(tarball, ".tar.gz"));
  const manifest = JSON.parse(readFileSync(join(extractedRoot, "manifest.json"), "utf8")) as { files: Array<{ path: string }> };
    const paths = new Set(manifest.files.map((file) => file.path));
    if (!paths.has("bin/nutshell")) throw new Error("tarball manifest is missing bin/nutshell");
    if (process.platform === "darwin" && ![...paths].some((path) => path.startsWith("Nutshell.app/"))) {
      throw new Error("darwin tarball manifest is missing Nutshell.app");
    }
    if (process.platform === "darwin" && !paths.has("Nutshell.app/Contents/Resources/Nutshell.icns")) {
      throw new Error("darwin tarball manifest is missing Nutshell.app icon");
    }
    if (process.platform === "darwin" && !paths.has("Nutshell.app/Contents/Resources/nutshell-ascii-animation.mp4")) {
      throw new Error("darwin tarball manifest is missing Nutshell.app setup background video");
    }
    return { tarball, manifestPath, files: paths.size };
  });

await step("app-owned helper surface is present and setup uses it", async () => {
  const appExecutable = join(repo, "dist", "macos", "Nutshell.app", "Contents", "MacOS", "Nutshell");
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
  if (setupRuntime.includes('"__sync-once"')) throw new Error("setup may run only a bounded app-owned smoke sync; the __sync-once bridge is banned in setup");
  for (const expected of ['"--timeout"', '"--mode", "recent"']) {
    if (!setupRuntime.includes(expected)) throw new Error(`setup may run only a bounded app-owned smoke sync; setup runtime is missing ${expected}`);
  }
  if (setupRuntime.includes('"--mode", "backfill"')) throw new Error('setup may run only a bounded app-owned smoke sync; "--mode", "backfill" is banned in setup');
  return { appExecutable };
});

await step("macOS app does not link beta-only Swift runtime libraries", async () => {
  if (process.platform !== "darwin") return { skipped: "not darwin" };
  const executables = [
    join(repo, "dist", "macos", "Nutshell.app", "Contents", "MacOS", "Nutshell"),
    join(repo, "dist", "macos", "Nutshell.app", "Contents", "Library", "LaunchServices", "NutshellAgent"),
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

function releaseTarballPath(): string {
  const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { version: string };
  const platform = process.platform === "darwin" ? "darwin" : process.platform;
  return join(repo, "dist", "release", `nutshell-${pkg.version}-${platform}-${process.arch}.tar.gz`);
}

function forbiddenUserSurfaceWords(): string[] {
  return ["init", "launchd", "migrate", "legacy", "waive", "preserve", "canonical", "repair-plan", "enrich"];
}

function writeReport(): void {
  mkdirSync(join(repo, "dist", "release"), { recursive: true });
  writeFileSync(join(repo, "dist", "release", "certification-report.json"), `${JSON.stringify({ generatedAt: new Date().toISOString(), report }, null, 2)}\n`);
}
