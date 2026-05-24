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
const defaultReleaseBaseUrl = "https://github.com/winterfell/nutshell/releases/download";

if (!existsSync(binary)) {
  throw new Error("bin/nutshell is missing. Run `bun run build:compile` first.");
}

rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, "bin"), { recursive: true });
cpSync(binary, join(stage, "bin", "nutshell"));
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
  homepage "https://github.com/winterfell/nutshell"
  url "${url}"
  sha256 "${sha256}"
  license "MIT"

  def install
    bin.install "bin/nutshell"
  end

  service do
    run [opt_bin/"nutshell", "sync", "all", "--mode", "recent", "--json"]
    run_type :interval
    interval 900
    environment_variables PATH: std_service_path_env
  end

  test do
    ENV["NUTSHELL_CONFIG"] = testpath/"nutconfig.jsonc"
    ENV["NUTSHELL_ROOT"] = testpath/"Nutshell"
    system bin/"nutshell", "--version"
    system bin/"nutshell", "init"
    assert_match "\\"status\\"", shell_output("#{bin}/nutshell health --json", 2)
  end
end
`;
}
