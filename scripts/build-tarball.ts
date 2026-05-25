import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "..");
const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { version: string };
const platform = process.platform === "darwin" ? "darwin" : process.platform;
const arch = process.arch;
const name = `nutshell-${pkg.version}-${platform}-${arch}`;
const releaseRoot = join(repo, "dist", "release");
const stage = join(releaseRoot, name);
const tarball = join(releaseRoot, `${name}.tar.gz`);
const binary = join(repo, "bin", "nutshell");
const appBundle = join(repo, "dist", "macos", "Nutshell.app");
const releaseHomepage = "https://github.com/androidStern/nutshell";
const defaultReleaseBaseUrl = `${releaseHomepage}/releases/download`;

await run(["bun", "run", "build:compile"]);
if (process.platform === "darwin") {
  await run(["bun", "run", "build:macos-app"]);
}

if (!existsSync(binary)) {
  throw new Error("bin/nutshell is missing. Run `bun run build:compile` first.");
}
if (process.platform === "darwin" && !existsSync(appBundle)) {
  throw new Error("dist/macos/Nutshell.app is missing. Run `bun run build:macos-app` before `bun run build:tarball`.");
}

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

const formula = homebrewFormula(pkg.version, releaseUrl(pkg.version, basename(tarball)), sha);
mkdirSync(join(releaseRoot, "homebrew"), { recursive: true });
writeFileSync(join(releaseRoot, "homebrew", "nutshell.rb"), formula);
rmSync(stage, { recursive: true, force: true });

process.stdout.write(`${tarball}\n${tarball}.sha256\n${join(releaseRoot, "homebrew", "nutshell.rb")}\n`);

async function run(cmd: string[]): Promise<void> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
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

function homebrewFormula(version: string, url: string, sha256: string): string {
  return `class Nutshell < Formula
  desc "Local personal trace ingestion runtime"
  homepage "${releaseHomepage}"
  url "${url}"
  version "${version}"
  sha256 "${sha256}"
  license "MIT"

  def install
    bin.install "bin/nutshell"
    prefix.install "Nutshell.app" if File.directory?("Nutshell.app")
  end

  def caveats
    <<~EOS
      Run \`nutshell setup\` after install. Protected-data sync is owned by Nutshell.app, not a Homebrew service.
    EOS
  end

  test do
    ENV["NUTSHELL_CONFIG"] = testpath/"nutconfig.jsonc"
    ENV["NUTSHELL_ROOT"] = testpath/"Nutshell"
    system bin/"nutshell", "--version"
    assert_match "nutshell setup", shell_output("#{bin}/nutshell help")
  end
end
`;
}
