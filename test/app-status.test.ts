import { expect, test } from "bun:test";
import { parseNutshellAppStatus } from "../src/macos/app-status";

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
