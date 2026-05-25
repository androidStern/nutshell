import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configuredAppPath, parseNutshellAppStatus } from "../src/macos/app-status";

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
