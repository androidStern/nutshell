import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultLaunchdPathEnv, launchdPlist } from "../src/launchd/plist";
import { inspectLaunchd, parseLaunchdPrint } from "../src/launchd/status";

const samplePrint = `gui/502/com.winterfell.nutshell = {
\tactive count = 0
\tpath = /Users/winterfell/Nutshell/launchd/com.winterfell.nutshell.plist
\ttype = LaunchAgent
\tstate = not running

\tprogram = /opt/homebrew/bin/nutshell
\targuments = {
\t\t/opt/homebrew/bin/nutshell
\t\tsync
\t\tall
\t\t--mode
\t\trecent
\t\t--json
\t}

\tworking directory = /Users/winterfell/Nutshell
\tstdout path = /Users/winterfell/Nutshell/logs/launchd.out.log
\tstderr path = /Users/winterfell/Nutshell/logs/launchd.err.log
\truns = 25
\tlast exit code = 2
\trun interval = 900 seconds
\tproperties = runatload | inferred program
}`;

test("launchd print output is parsed into scheduler health facts", () => {
  const report = parseLaunchdPrint(samplePrint, {
    domain: "gui/502",
    plistPath: "/Users/winterfell/Nutshell/launchd/com.winterfell.nutshell.plist",
    plistExists: true,
    launchctlPath: "/bin/launchctl",
  });

  expect(report.loaded).toBe(true);
  expect(report.status).toBe("warning");
  expect(report.state).toBe("not running");
  expect(report.lastExitCode).toBe(2);
  expect(report.runs).toBe(25);
  expect(report.intervalSeconds).toBe(900);
  expect(report.runAtLoad).toBe(true);
  expect(report.arguments.join(" ")).toContain("sync");
  expect(report.arguments.join(" ")).not.toContain("--root");
});

test("launchd plist runs the installed nutshell command without bun, zsh, or root flags", () => {
  const plist = launchdPlist("/Users/winterfell/Nutshell", "/Users/winterfell/nutconfig.jsonc", ["/opt/homebrew/bin/nutshell"], 900, "/opt/homebrew/bin:/usr/bin:/bin");
  expect(plist).toContain("<string>/opt/homebrew/bin/nutshell</string>");
  expect(plist).toContain("<string>sync</string>");
  expect(plist).not.toContain("<string>--root</string>");
  expect(plist).not.toContain("<string>/bin/zsh</string>");
  expect(plist).not.toContain("<string>bun</string>");
  expect(plist).toContain("<key>NUTSHELL_CONFIG</key>");
});

test("launchd default PATH is stable and not inherited from Codex", () => {
  const path = defaultLaunchdPathEnv("/Users/winterfell");
  expect(path).toContain("/Users/winterfell/.local/bin");
  expect(path).toContain("/opt/homebrew/bin");
  expect(path).not.toContain("Codex.app");
  expect(path).not.toContain(".codex/tmp");
});

test("launchd inspector reports a missing job without throwing", async () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-launchd-"));
  try {
    const report = await inspectLaunchd(root, async () => ({
      code: 113,
      stdout: "",
      stderr: "Could not find service",
      timedOut: false,
    }));

    expect(report.loaded).toBe(false);
    expect(report.status).toBe("not_loaded");
    expect(report.message).toContain("Could not find service");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
