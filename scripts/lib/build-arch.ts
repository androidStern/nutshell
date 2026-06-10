export type BuildArch = "arm64" | "x64";

export const BUILD_ARCHES: readonly BuildArch[] = ["arm64", "x64"];

export function hostBuildArch(): BuildArch {
  return parseBuildArch(process.arch);
}

export function parseBuildArch(value: string): BuildArch {
  if (value === "arm64" || value === "x64") return value;
  throw new Error(`unsupported build arch: ${JSON.stringify(value)} (expected "arm64" or "x64")`);
}

export function resolveBuildArch(argv: readonly string[], env: Record<string, string | undefined>): BuildArch {
  const requested = archFlag(argv) ?? env.NUTSHELL_BUILD_ARCH;
  if (requested === undefined) return hostBuildArch();
  return parseBuildArch(requested);
}

export function archFlag(argv: readonly string[]): string | undefined {
  const index = argv.indexOf("--arch");
  if (index !== -1) {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error("--arch requires a value (arm64 or x64)");
    return value;
  }
  const inline = argv.find((argument) => argument.startsWith("--arch="));
  return inline?.slice("--arch=".length);
}

export function machoArchName(arch: BuildArch): "arm64" | "x86_64" {
  return arch === "arm64" ? "arm64" : "x86_64";
}
