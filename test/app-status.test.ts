import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configuredAppPath, ensureStableAppPath, parseNutshellAppStatus } from "../src/macos/app-status";

test("app status parser preserves app-owned permission and agent states", () => {
  const missing = parseNutshellAppStatus(
    [
      "App: /Applications/Nutshell.app",
      "Bundle ID: com.winterfell.nutshell",
      "Agent: com.winterfell.nutshell.agent",
      "Agent status: requiresApproval",
      "Full Disk Access: not granted",
      "Background sync: disabled",
      "Data root: /Users/example/Nutshell",
    ].join("\n"),
    "/Applications/Nutshell.app",
  );
  expect(missing.fullDiskAccess).toBe("missing");
  expect(missing.agent).toBe("requiresApproval");
  expect(missing.backgroundSync).toBe("disabled");
  expect(missing.dataRoot).toBe("/Users/example/Nutshell");

  const enabled = parseNutshellAppStatus(
    [
      "Agent status: enabled",
      "Full Disk Access: granted",
      "Background sync: enabled",
    ].join("\n"),
    "/Applications/Nutshell.app",
  );
  expect(enabled.fullDiskAccess).toBe("granted");
  expect(enabled.agent).toBe("enabled");
  expect(enabled.backgroundSync).toBe("enabled");
});

test("app discovery ignores stale configured paths when an installed app exists", () => {
  const priorHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "nutshell-app-home-"));
  try {
    process.env.HOME = home;
    const app = join(home, "Applications", "Nutshell.app");
    mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
    writeFileSync(join(app, "Contents", "MacOS", "Nutshell"), "");

    const path = configuredAppPath({
      root: join(home, "Nutshell"),
      path: join(home, "nutconfig.jsonc"),
      data: {
        app: {
          path: join(home, "stale-cellar", "Nutshell.app"),
        },
      },
    });

    expect(path).toBe(app);
  } finally {
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("app discovery prefers the current Homebrew app over an older configured Cellar app", () => {
  const priorHome = process.env.HOME;
  const priorArgv = process.argv[1] ?? "";
  const home = mkdtempSync(join(tmpdir(), "nutshell-app-homebrew-"));
  try {
    process.env.HOME = home;
    const oldApp = join(home, "homebrew", "Cellar", "nutshell", "0.1.5", "Nutshell.app");
    const currentBin = join(home, "homebrew", "Cellar", "nutshell", "0.1.7", "bin", "nutshell");
    const currentApp = join(home, "homebrew", "Cellar", "nutshell", "0.1.7", "Nutshell.app");
    mkdirSync(join(oldApp, "Contents", "MacOS"), { recursive: true });
    mkdirSync(join(currentApp, "Contents", "MacOS"), { recursive: true });
    mkdirSync(join(currentBin, ".."), { recursive: true });
    writeFileSync(join(oldApp, "Contents", "MacOS", "Nutshell"), "");
    writeFileSync(join(currentApp, "Contents", "MacOS", "Nutshell"), "");
    process.argv[1] = currentBin;

    const path = configuredAppPath({
      root: join(home, "Nutshell"),
      path: join(home, "nutconfig.jsonc"),
      data: {
        app: {
          path: oldApp,
        },
      },
    });

    expect(path).toBe(currentApp);
  } finally {
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    process.argv[1] = priorArgv;
    rmSync(home, { recursive: true, force: true });
  }
});

test("stable app installer promotes the current Homebrew app into user Applications", () => {
  const priorHome = process.env.HOME;
  const priorArgv = process.argv[1] ?? "";
  const home = mkdtempSync(join(tmpdir(), "nutshell-stable-app-homebrew-"));
  try {
    process.env.HOME = home;
    const currentBin = join(home, "homebrew", "Cellar", "nutshell", "0.1.8", "bin", "nutshell");
    const currentApp = join(home, "homebrew", "Cellar", "nutshell", "0.1.8", "Nutshell.app");
    const stableApp = join(home, "Applications", "Nutshell.app");
    mkdirSync(join(currentApp, "Contents", "MacOS"), { recursive: true });
    mkdirSync(join(currentBin, ".."), { recursive: true });
    writeFileSync(join(currentApp, "Contents", "MacOS", "Nutshell"), "homebrew-app");
    process.argv[1] = currentBin;

    const path = ensureStableAppPath({
      root: join(home, "Nutshell"),
      path: join(home, "nutconfig.jsonc"),
      data: {},
    });

    expect(path).toBe(stableApp);
    expect(existsSync(join(stableApp, "Contents", "MacOS", "Nutshell"))).toBe(true);
    expect(configuredAppPath({ root: join(home, "Nutshell"), path: join(home, "nutconfig.jsonc"), data: {} })).toBe(stableApp);
  } finally {
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    process.argv[1] = priorArgv;
    rmSync(home, { recursive: true, force: true });
  }
});
