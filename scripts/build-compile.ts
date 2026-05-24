import { mkdirSync, cpSync } from "node:fs";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "..");
const binPath = join(repo, "bin", "nutshell");
const distPath = join(repo, "dist", "nutshell");
const identifier = process.env.NUTSHELL_CODESIGN_IDENTIFIER || "com.winterfell.nutshell";

mkdirSync(join(repo, "bin"), { recursive: true });
mkdirSync(join(repo, "dist"), { recursive: true });

await run(["bun", "build", "./src/cli.ts", "--compile", "--outfile", "./bin/nutshell"]);

const identity = await codesignIdentity();
if (identity) {
  await signBinary(binPath, identity);
} else if (process.platform === "darwin" && process.env.NUTSHELL_CODESIGN !== "skip") {
  console.warn("warning: no code signing identity found; macOS permissions may not persist across upgrades");
}

cpSync(binPath, distPath);
if (identity) await signBinary(distPath, identity);

async function codesignIdentity(): Promise<string | null> {
  if (process.env.NUTSHELL_CODESIGN === "skip") return null;
  if (process.env.NUTSHELL_CODESIGN_IDENTITY) return process.env.NUTSHELL_CODESIGN_IDENTITY;
  if (process.platform !== "darwin") return null;

  const identities = await runText(["security", "find-identity", "-v", "-p", "codesigning"]);
  const developerIds = identities
    .split("\n")
    .map((line) => line.match(/"([^"]*Developer ID Application:[^"]+)"/)?.[1])
    .filter((item): item is string => Boolean(item));

  return developerIds.length === 1 ? developerIds[0] : null;
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
