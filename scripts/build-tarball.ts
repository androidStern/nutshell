import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { archFlag, hostBuildArch, parseBuildArch, type BuildArch } from "./lib/build-arch.ts";
import { homebrewFormula } from "./lib/homebrew-formula.ts";

const repo = resolve(import.meta.dir, "..");
const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { version: string };
const platform = process.platform === "darwin" ? "darwin" : process.platform;
const releaseRoot = join(repo, "dist", "release");
const releaseHomepage = "https://github.com/androidStern/nutshell";
const defaultReleaseBaseUrl = `${releaseHomepage}/releases/download`;

const arches = targetArches();
const outputs: string[] = [];
const shaByArch = new Map<BuildArch, string>();

for (const arch of arches) {
  shaByArch.set(arch, await buildArchTarball(arch));
}

const armSha = shaByArch.get("arm64");
const x64Sha = shaByArch.get("x64");
if (armSha !== undefined && x64Sha !== undefined) {
  const formula = homebrewFormula({
    version: pkg.version,
    homepage: releaseHomepage,
    arm64: { url: releaseUrl(pkg.version, tarballName("arm64")), sha256: armSha },
    x64: { url: releaseUrl(pkg.version, tarballName("x64")), sha256: x64Sha },
  });
  mkdirSync(join(releaseRoot, "homebrew"), { recursive: true });
  const formulaPath = join(releaseRoot, "homebrew", "nutshell.rb");
  writeFileSync(formulaPath, formula);
  outputs.push(formulaPath);
} else {
  console.warn(`warning: single-arch build (${arches.join(", ")}); skipping Homebrew formula generation, which needs both arm64 and x64 SHAs`);
}

process.stdout.write(`${outputs.join("\n")}\n`);

function targetArches(): BuildArch[] {
  const requested = archFlag(process.argv.slice(2)) ?? process.env.NUTSHELL_BUILD_ARCH;
  if (requested !== undefined) {
    const arch = parseBuildArch(requested);
    if (platform !== "darwin" && arch !== hostBuildArch()) {
      throw new Error(`cross-arch builds are only supported on darwin; host is ${hostBuildArch()}`);
    }
    return [arch];
  }
  if (platform === "darwin") return ["arm64", "x64"];
  return [hostBuildArch()];
}

async function buildArchTarball(arch: BuildArch): Promise<string> {
  await run(["bun", "run", join(repo, "scripts", "build-compile.ts"), "--arch", arch]);
  if (platform === "darwin") {
    await run(["bun", "run", join(repo, "scripts", "build-macos-app.ts"), "--arch", arch]);
  }

  const binary = join(repo, "dist", "compile", `${platform}-${arch}`, "nutshell");
  const appBundle = join(repo, "dist", "macos", `darwin-${arch}`, "Nutshell.app");
  if (!existsSync(binary)) {
    throw new Error(`${binary} is missing. Run \`bun run scripts/build-compile.ts --arch ${arch}\` first.`);
  }
  if (platform === "darwin" && !existsSync(appBundle)) {
    throw new Error(`${appBundle} is missing. Run \`bun run scripts/build-macos-app.ts --arch ${arch}\` before \`bun run build:tarball\`.`);
  }

  const name = `nutshell-${pkg.version}-${platform}-${arch}`;
  const stage = join(releaseRoot, name);
  const tarball = join(releaseRoot, `${name}.tar.gz`);

  rmSync(stage, { recursive: true, force: true });
  mkdirSync(join(stage, "bin"), { recursive: true });
  cpSync(binary, join(stage, "bin", "nutshell"));
  if (existsSync(appBundle)) {
    cpSync(appBundle, join(stage, "Nutshell.app"), { recursive: true });
  }
  cpSync(join(repo, "packaging", "tarball", "install.sh"), join(stage, "install.sh"));
  cpSync(join(repo, "packaging", "tarball", "uninstall.sh"), join(stage, "uninstall.sh"));
  cpSync(join(repo, "packaging", "tarball", "README.md"), join(stage, "README.md"));
  writeFileSync(join(stage, "VERSION"), `${pkg.version}\n`);
  writeFileSync(join(stage, "manifest.json"), `${JSON.stringify(manifest(stage, pkg.version, platform, arch), null, 2)}\n`);

  await run(["chmod", "0755", join(stage, "bin", "nutshell"), join(stage, "install.sh"), join(stage, "uninstall.sh")]);
  rmSync(tarball, { force: true });
  await run(["tar", "-C", releaseRoot, "-czf", tarball, name]);

  const sha = createHash("sha256").update(readFileSync(tarball)).digest("hex");
  writeFileSync(`${tarball}.sha256`, `${sha}  ${basename(tarball)}\n`);
  rmSync(stage, { recursive: true, force: true });

  outputs.push(tarball, `${tarball}.sha256`);
  return sha;
}

function tarballName(arch: BuildArch): string {
  return `nutshell-${pkg.version}-${platform}-${arch}.tar.gz`;
}

async function run(cmd: string[]): Promise<void> {
  const proc = Bun.spawn(cmd, { cwd: repo, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) {
    throw new Error(`${cmd.join(" ")} failed\n${stdout}${stderr}`);
  }
}

function manifest(stageRoot: string, version: string, platformName: string, archName: string): unknown {
  const files = fileList(stageRoot).map((path) => {
    const bytes = readFileSync(join(stageRoot, path));
    return {
      path,
      size: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  });
  return {
    name: "nutshell",
    version,
    platform: platformName,
    arch: archName,
    generatedAt: new Date().toISOString(),
    files,
  };
}

function fileList(root: string): string[] {
  const output: string[] = [];
  walk("");
  return output.sort();

  function walk(relativeDir: string): void {
    const absoluteDir = join(root, relativeDir);
    for (const entry of readdirSync(absoluteDir)) {
      const relativePath = relativeDir ? join(relativeDir, entry) : entry;
      const absolutePath = join(root, relativePath);
      if (statSync(absolutePath).isDirectory()) walk(relativePath);
      else output.push(relativePath);
    }
  }
}

function releaseUrl(version: string, fileName: string): string {
  const base = process.env.NUTSHELL_RELEASE_BASE_URL || `${defaultReleaseBaseUrl}/v${version}`;
  return `${base.replace(/\/$/, "")}/${fileName}`;
}
