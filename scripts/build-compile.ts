import { cpSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { hostBuildArch, machoArchName, resolveBuildArch } from "./lib/build-arch.ts";

const repo = resolve(import.meta.dir, "..");
const arch = resolveBuildArch(process.argv.slice(2), process.env);
const platformName = process.platform === "darwin" ? "darwin" : process.platform;
// darwin-x64 uses bun's baseline (no-AVX) build. Rosetta 2 does not emulate AVX and bun
// declares non-baseline builds unsupported on no-AVX CPUs ("strange crashes may occur"), so the
// release Rosetta smoke in certify-release would gate on an unsupported configuration. Every
// Intel Mac that can run macOS 14 has AVX2, so baseline only costs some SIMD on real hardware.
const bunTarget = platformName === "darwin" && arch === "x64" ? "bun-darwin-x64-baseline" : `bun-${platformName}-${arch}`;
const compiledPath = join(repo, "dist", "compile", `${platformName}-${arch}`, "nutshell");
const binPath = join(repo, "bin", "nutshell");
const distPath = join(repo, "dist", "nutshell");
const identifier = process.env.NUTSHELL_CODESIGN_IDENTIFIER || "com.winterfell.nutshell";

mkdirSync(dirname(compiledPath), { recursive: true });

await run(["bun", "build", "./src/cli.ts", "--compile", `--target=${bunTarget}`, "--outfile", compiledPath]);
await verifyArch(compiledPath);

const identity = await codesignIdentity();
if (identity) {
  await signBinary(compiledPath, identity);
} else if (process.platform === "darwin" && process.env.NUTSHELL_CODESIGN !== "skip") {
  console.warn("warning: no code signing identity found; macOS permissions may not persist across upgrades");
}

if (arch === hostBuildArch()) {
  mkdirSync(join(repo, "bin"), { recursive: true });
  cpSync(compiledPath, binPath);
  cpSync(compiledPath, distPath);
  if (identity) {
    await signBinary(binPath, identity);
    await signBinary(distPath, identity);
  }
}

process.stdout.write(`${compiledPath}\n`);

async function verifyArch(path: string): Promise<void> {
  if (process.platform !== "darwin") return;
  const result = await runResult(["lipo", "-archs", path]);
  if (result.code !== 0) throw new Error(`lipo -archs ${path} failed\n${result.stdout}${result.stderr}`);
  const archs = result.stdout.trim();
  const expected = machoArchName(arch);
  if (archs !== expected) throw new Error(`${path} architecture mismatch: lipo reported "${archs}", expected "${expected}"`);
}

async function codesignIdentity(): Promise<string | null> {
  if (process.env.NUTSHELL_CODESIGN === "skip") return null;
  if (process.env.NUTSHELL_CODESIGN_IDENTITY) return process.env.NUTSHELL_CODESIGN_IDENTITY;
  if (process.platform !== "darwin") return null;

  const identities = await runText(["security", "find-identity", "-v", "-p", "codesigning"]);
  const developerIds = identities
    .split("\n")
    .map((line) => line.match(/"([^"]*Developer ID Application:[^"]+)"/)?.[1])
    .filter((item): item is string => Boolean(item));

  return developerIds.length === 1 ? developerIds[0] ?? null : null;
}

async function signBinary(path: string, identity: string): Promise<void> {
  const args = [
    "codesign",
    "--force",
    "--timestamp",
    "--identifier",
    identifier,
    "--sign",
    identity,
    path,
  ];
  await run(args);
}

async function run(cmd: string[]): Promise<void> {
  const result = await runResult(cmd);
  if (result.code !== 0) throw new Error(`${cmd.join(" ")} failed\n${result.stdout}${result.stderr}`);
}

async function runText(cmd: string[]): Promise<string> {
  const result = await runResult(cmd);
  if (result.code !== 0) return "";
  return result.stdout;
}

async function runResult(cmd: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, { cwd: repo, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
}
