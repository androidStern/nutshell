import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, resolveRoot } from "../src/config/config";

test("default config is JSONC and points storage at the Nutshell data root", () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-config-"));
  try {
    const config = loadConfig(root);
    expect(config.path).toBe(join(root, "nutconfig.jsonc"));
    expect(config.root).toBe(root);
    expect(existsSync(config.path)).toBe(true);
    expect(readFileSync(config.path, "utf8")).toContain("// Nutshell configuration.");
    expect(config.data.storage).toEqual({ root });
    expect(config.data.store).toEqual({ sqlitePath: "nutshell.sqlite" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("root can be resolved from nutconfig.jsonc without a command-line root", () => {
  const home = mkdtempSync(join(tmpdir(), "nutshell-config-home-"));
  const dataRoot = join(home, "Nutshell");
  const configPath = join(home, "nutconfig.jsonc");
  const previousConfig = process.env.NUTSHELL_CONFIG;
  const previousRoot = process.env.NUTSHELL_ROOT;
  try {
    process.env.NUTSHELL_CONFIG = configPath;
    delete process.env.NUTSHELL_ROOT;
    writeFileSync(configPath, `{ storage: { root: "${dataRoot}" } }\n`, "utf8");
    expect(resolveRoot(undefined, configPath)).toBe(dataRoot);
  } finally {
    if (previousConfig === undefined) delete process.env.NUTSHELL_CONFIG;
    else process.env.NUTSHELL_CONFIG = previousConfig;
    if (previousRoot === undefined) delete process.env.NUTSHELL_ROOT;
    else process.env.NUTSHELL_ROOT = previousRoot;
    rmSync(home, { recursive: true, force: true });
  }
});
