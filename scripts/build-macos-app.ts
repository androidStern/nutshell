import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "..");
const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { version: string };
const appName = "Nutshell.app";
const appBundleId = "com.winterfell.nutshell";
const buildRoot = join(tmpdir(), "nutshell-macos-build");
const appRoot = join(buildRoot, appName);
const distAppRoot = join(repo, "dist", "macos", appName);
const installPath = "/Applications/Nutshell.app";
const coreEntitlements = join(repo, "macos", "nutshell-core.entitlements.plist");
const install = process.argv.includes("--install");
const swiftTarget = process.env.NUTSHELL_SWIFT_TARGET ?? "arm64-apple-macosx14.0";

await ensureCore();
buildBundle();
await compileSwift();
await signBundle();

if (install) {
  rmSync(installPath, { recursive: true, force: true });
  await copyBundle(appRoot, installPath);
  process.stdout.write(`${installPath}\n`);
} else {
  rmSync(distAppRoot, { recursive: true, force: true });
  mkdirSync(join(repo, "dist", "macos"), { recursive: true });
  await copyBundle(appRoot, distAppRoot);
  process.stdout.write(`${distAppRoot}\n`);
}

async function ensureCore(): Promise<void> {
  await run(["bun", "run", "build:compile"]);
}

function buildBundle(): void {
  rmSync(buildRoot, { recursive: true, force: true });
  mkdirSync(join(appRoot, "Contents", "MacOS"), { recursive: true });
  mkdirSync(join(appRoot, "Contents", "Resources"), { recursive: true });
  mkdirSync(join(appRoot, "Contents", "Library", "LaunchAgents"), { recursive: true });
  mkdirSync(join(appRoot, "Contents", "Library", "LaunchServices"), { recursive: true });

  writeVersionedInfoPlist(join(appRoot, "Contents", "Info.plist"));
  cpSync(join(repo, "macos", "Nutshell.icns"), join(appRoot, "Contents", "Resources", "Nutshell.icns"));
  cpSync(join(repo, "macos", "nutshell-ascii-animation.mp4"), join(appRoot, "Contents", "Resources", "nutshell-ascii-animation.mp4"));
  cpSync(
    join(repo, "macos", "com.winterfell.nutshell.agent.plist"),
    join(appRoot, "Contents", "Library", "LaunchAgents", "com.winterfell.nutshell.agent.plist"),
  );
  cpSync(join(repo, "bin", "nutshell"), join(appRoot, "Contents", "Resources", "nutshell-core"));
}

function writeVersionedInfoPlist(destination: string): void {
  const source = readFileSync(join(repo, "macos", "Info.plist"), "utf8")
    .replace(
      /(<key>CFBundleShortVersionString<\/key>\s*<string>)[^<]+(<\/string>)/,
      `$1${pkg.version}$2`,
    )
    .replace(
      /(<key>CFBundleVersion<\/key>\s*<string>)[^<]+(<\/string>)/,
      `$1${pkg.version}$2`,
    );
  writeFileSync(destination, source);
}

async function compileSwift(): Promise<void> {
  await run([
    "xcrun",
    "swiftc",
    "-O",
    "-target",
    swiftTarget,
    "-o",
    join(appRoot, "Contents", "MacOS", "Nutshell"),
    join(repo, "macos", "NutshellApp.swift"),
  ]);
  await run([
    "xcrun",
    "swiftc",
    "-O",
    "-target",
    swiftTarget,
    "-o",
    join(appRoot, "Contents", "Library", "LaunchServices", "NutshellAgent"),
    join(repo, "macos", "NutshellAgent.swift"),
  ]);
  await run(["chmod", "0755", join(appRoot, "Contents", "MacOS", "Nutshell")]);
  await run(["chmod", "0755", join(appRoot, "Contents", "Library", "LaunchServices", "NutshellAgent")]);
  await run(["chmod", "0755", join(appRoot, "Contents", "Resources", "nutshell-core")]);
  await stripXattrs(appRoot);
}

async function signBundle(): Promise<void> {
  if (process.platform !== "darwin" || process.env.NUTSHELL_CODESIGN === "skip") return;
  const identity = await codesignIdentity();
  if (!identity) {
    console.warn("warning: no Developer ID Application identity found; app bundle is unsigned");
    return;
  }

  await stripXattrs(appRoot);
  await sign(join(appRoot, "Contents", "Resources", "nutshell-core"), identity, appBundleId, coreEntitlements);
  await sign(join(appRoot, "Contents", "Library", "LaunchServices", "NutshellAgent"), identity, `${appBundleId}.agent`);
  await stripXattrs(appRoot);
  await run([
    "codesign",
    "--force",
    "--timestamp",
    "--options",
    "runtime",
    "--sign",
    identity,
    appRoot,
  ]);
}

async function sign(path: string, identity: string, identifier: string, entitlements?: string): Promise<void> {
  const command = [
    "codesign",
    "--force",
    "--timestamp",
    "--options",
    "runtime",
    "--identifier",
    identifier,
  ];
  if (entitlements) {
    command.push("--entitlements", entitlements);
  }
  command.push(
    "--sign",
    identity,
    path,
  );
  await run(command);
}

async function copyBundle(from: string, to: string): Promise<void> {
  await run(["ditto", "--noextattr", "--noqtn", from, to]);
}

async function stripXattrs(path: string): Promise<void> {
  await runResult(["xattr", "-cr", path]);
  for (const attr of [
    "com.apple.ResourceFork",
    "com.apple.fileprovider.fpfs#P",
    "com.apple.macl",
    "com.apple.provenance",
    "com.apple.FinderInfo",
  ]) {
    await runResult(["xattr", "-r", "-d", attr, path]);
  }
  await runResult(["xattr", "-d", "com.apple.FinderInfo", path]);
}

async function codesignIdentity(): Promise<string | null> {
  if (process.env.NUTSHELL_CODESIGN_IDENTITY) return process.env.NUTSHELL_CODESIGN_IDENTITY;
  const identities = await runText(["security", "find-identity", "-v", "-p", "codesigning"]);
  const developerIds = identities
    .split("\n")
    .map((line) => line.match(/"([^"]*Developer ID Application:[^"]+)"/)?.[1])
    .filter((item): item is string => Boolean(item));
  return developerIds.length === 1 ? developerIds[0] : null;
}

async function run(cmd: string[]): Promise<void> {
  const result = await runResult(cmd);
  if (result.code !== 0) throw new Error(`${cmd.join(" ")} failed\n${result.stdout}${result.stderr}`);
}

async function runText(cmd: string[]): Promise<string> {
  const result = await runResult(cmd);
  return result.code === 0 ? result.stdout : "";
}

async function runResult(cmd: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, { cwd: repo, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
}
