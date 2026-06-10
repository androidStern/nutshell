import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SYNC_BUDGET } from "../src/config/defaults";
import { loadConfig } from "../src/config/config";
import { APP_PATH_ENV, PRODUCT_NAME } from "../src/core/product";
import type { Checkpoint, HealthFinding, JsonObject, PluginContext, PluginManifest, PluginSyncResult, ProviderExportImportRequest, SyncRequest } from "../src/core/types";
import { makeFinding } from "../src/health/health";
import { AppleNotesPlugin } from "../src/plugins/builtin/apple-notes/plugin";
import { PodcastsPlugin } from "../src/plugins/builtin/podcasts/plugin";
import { TwitterPlugin } from "../src/plugins/builtin/twitter/plugin";
import { YouTubePlugin } from "../src/plugins/builtin/youtube/plugin";
import type { TracePlugin } from "../src/plugins/interface";
import { PluginRegistry } from "../src/plugins/registry";
import { DEFAULT_PERMISSION_HANDOFF_TIMEOUT_MS, SetupRuntime, exitCodeForSetup, permissionHandoffTimeoutMs, type AppCommandRunner } from "../src/setup/setup-runtime";
import type { SetupProber } from "../src/setup/probe";
import type { HostCapabilities, HostRunResult, MacAppStatus, MacHostCapabilities, PluginSetupContext } from "../src/setup/types";
import { pluginSetupFindings, pluginSetupStatus } from "../src/setup/config-draft";
import { FakeSetupProber } from "../src/testing/fake-prober";
import { FakeSetupUI } from "../src/testing/fake-setup-ui";
import { openStore } from "../src/store/sqlite-store";

test("setup permission handoff timeout defaults to a real user window and can be overridden", () => {
  expect(DEFAULT_PERMISSION_HANDOFF_TIMEOUT_MS).toBe(60 * 60_000);
  expect(permissionHandoffTimeoutMs({})).toBe(DEFAULT_PERMISSION_HANDOFF_TIMEOUT_MS);
  expect(permissionHandoffTimeoutMs({ NUTSHELL_SETUP_PERMISSION_TIMEOUT_MS: "1234" })).toBe(1234);
  expect(permissionHandoffTimeoutMs({ NUTSHELL_SETUP_PERMISSION_TIMEOUT_MS: "nope" })).toBe(DEFAULT_PERMISSION_HANDOFF_TIMEOUT_MS);
});

test("setup marks selected plugins ready without source-specific core steps", async () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-setup-"));
  try {
    const config = loadConfig(root);
    config.data.plugins = {};
    const ui = new FakeSetupUI();
    ui.multiselectValues = [["ready", "other"]];
    const runtime = new SetupRuntime({
      root,
      config,
      registry: new PluginRegistry([new SetupPlugin("ready"), new SetupPlugin("other")]),
      ui,
      host: new FakeHost(),
      prober: new FakeSetupProber(),
    });

    const report = await runtime.run({ json: false, assumeYes: false, backgroundAgent: false, syncHandoff: false });

    expect(report.status).toBe("ok");
    expect(report.plugins.filter((item) => item.status === "ready").map((item) => item.source).sort()).toEqual(["other", "ready"]);
    const reloaded = loadConfig(root);
    expect(pluginSetupStatus(reloaded, "ready")).toBe("ready");
    expect(pluginSetupStatus(reloaded, "other")).toBe("ready");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setup isolates a degraded plugin and keeps other selected plugins ready", async () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-setup-"));
  try {
    const config = loadConfig(root);
    config.data.plugins = {};
    const ui = new FakeSetupUI();
    ui.multiselectValues = [["ready", "broken"]];
    const runtime = new SetupRuntime({
      root,
      config,
      registry: new PluginRegistry([
        new SetupPlugin("ready"),
        new SetupPlugin("broken", [makeFinding("critical", "broken", "broken_auth", "Broken plugin auth failed")]),
      ]),
      ui,
      host: new FakeHost(),
      prober: new FakeSetupProber(),
    });

    const report = await runtime.run({ json: false, assumeYes: false, backgroundAgent: false, syncHandoff: false });

    expect(report.status).toBe("warning");
    expect(report.plugins.find((item) => item.source === "ready")?.status).toBe("ready");
    expect(report.plugins.find((item) => item.source === "broken")?.status).toBe("degraded");
    const reloaded = loadConfig(root);
    expect(pluginSetupStatus(reloaded, "ready")).toBe("ready");
    expect(pluginSetupStatus(reloaded, "broken")).toBe("degraded");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setup enforces a core-owned timeout around plugin setup", async () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-setup-timeout-"));
  try {
    const config = loadConfig(root);
    config.data.plugins = {};
    const ui = new FakeSetupUI();
    ui.multiselectValues = [["slow", "ready"]];
    const runtime = new SetupRuntime({
      root,
      config,
      registry: new PluginRegistry([new SlowSetupPlugin("slow"), new SetupPlugin("ready")]),
      ui,
      host: new FakeHost(),
      prober: new FakeSetupProber(),
      setupPluginTimeoutMs: 5,
    });

    const report = await runtime.run({ json: false, assumeYes: false, backgroundAgent: false, syncHandoff: false });

    expect(report.status).toBe("warning");
    expect(report.plugins.find((item) => item.source === "slow")?.status).toBe("degraded");
    const timeoutFinding = report.plugins.find((item) => item.source === "slow")?.findings[0];
    expect(timeoutFinding?.code).toBe("plugin_setup_timeout");
    expect(timeoutFinding?.source).toBe("slow");
    expect(timeoutFinding?.guidance?.state).toBe("blocked_bug");
    expect(timeoutFinding?.guidance?.fix?.length).toBeGreaterThan(0);
    expect(timeoutFinding?.guidance?.confirm?.length).toBeGreaterThan(0);
    expect(report.plugins.find((item) => item.source === "ready")?.status).toBe("ready");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setup preserves disabled as a user choice distinct from degraded", async () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-setup-"));
  try {
    const config = loadConfig(root);
    config.data.plugins = {};
    const ui = new FakeSetupUI();
    ui.multiselectValues = [["enabled"]];
    const runtime = new SetupRuntime({
      root,
      config,
      registry: new PluginRegistry([new SetupPlugin("enabled"), new SetupPlugin("disabled")]),
      ui,
      host: new FakeHost(),
      prober: new FakeSetupProber(),
    });

    const report = await runtime.run({ json: false, assumeYes: false, backgroundAgent: false, syncHandoff: false });

    expect(report.plugins.find((item) => item.source === "enabled")?.status).toBe("ready");
    expect(report.plugins.find((item) => item.source === "disabled")?.status).toBe("disabled");
    const reloaded = loadConfig(root);
    expect((reloaded.data.plugins as JsonObject).disabled).toEqual({
      enabled: false,
      setup: expect.objectContaining({ status: "disabled" }),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setup can skip archive import without creating pending state", async () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-setup-"));
  try {
    const config = loadConfig(root);
    config.data.plugins = {};
    const ui = new FakeSetupUI();
    ui.multiselectValues = [["archive"]];
    ui.confirms = [false];
    const runtime = new SetupRuntime({
      root,
      config,
      registry: new PluginRegistry([new SetupPlugin("archive", [], true)]),
      ui,
      host: new FakeHost(),
      prober: new FakeSetupProber(),
    });

    const report = await runtime.run({ json: false, assumeYes: false, backgroundAgent: false, syncHandoff: false });

    const plugin = report.plugins.find((item) => item.source === "archive");
    expect(plugin?.archiveImport).toBe("skipped");
    expect(plugin?.importCommand).toBe("nutshell import archive <archive.zip> --json");
    expect(JSON.stringify(loadConfig(root).data)).not.toContain("pending");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setup can run a plugin-owned archive import immediately", async () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-setup-"));
  try {
    const archivePath = join(root, "archive.zip");
    const config = loadConfig(root);
    config.data.plugins = {};
    const ui = new FakeSetupUI();
    ui.multiselectValues = [["archive"]];
    ui.confirms = [true];
    const plugin = new SetupPlugin("archive", [], true);
    const runtime = new SetupRuntime({
      root,
      config,
      registry: new PluginRegistry([plugin]),
      ui,
      host: new FakeHost(archivePath),
      prober: new FakeSetupProber(),
    });

    const report = await runtime.run({ json: false, assumeYes: false, backgroundAgent: false, syncHandoff: false });

    expect(report.plugins.find((item) => item.source === "archive")?.archiveImport).toBe("imported");
    expect(plugin.importedPath).toBe(archivePath);
    expect(statSync(join(root, "nutshell.sqlite")).isFile()).toBe(true);
    const store = openStore(join(root, "nutshell.sqlite"));
    try {
      const page = await store.query({ source: "archive" });
      expect(page.total).toBe(1);
    } finally {
      await store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cancelled setup does not commit the config draft", async () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-setup-"));
  try {
    const config = loadConfig(root);
    const original = { ...config.data, plugins: { existing: { enabled: true } } };
    writeFileSync(config.path, `${JSON.stringify(original, null, 2)}\n`, "utf8");
    const before = readFileSync(config.path, "utf8");
    class CancelledUI extends FakeSetupUI {
      async multiselect<T>(): Promise<T[]> {
        throw new Error("setup cancelled");
      }
    }
    const runtime = new SetupRuntime({
      root,
      config: loadConfig(root),
      registry: new PluginRegistry([new SetupPlugin("ready")]),
      ui: new CancelledUI(),
      host: new FakeHost(),
      prober: new FakeSetupProber(),
    });

    await expect(runtime.run({ json: false, assumeYes: false, backgroundAgent: false, syncHandoff: false })).rejects.toThrow("setup cancelled");
    expect(readFileSync(config.path, "utf8")).toBe(before);
    // honest-setup #9: secrets are also untouched — the secret draft commits
    // only after the plugin loop, which the cancel never reached.
    expect(existsSync(join(root, "Nutshell", "secrets.json"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setup does not mark plugins ready when secret commit fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-setup-secret-fail-"));
  try {
    const config = loadConfig(root);
    config.data.plugins = {};
    const ui = new FakeSetupUI();
    ui.multiselectValues = [["ready"]];
    const runtime = new SetupRuntime({
      root,
      config,
      registry: new PluginRegistry([new SetupPlugin("ready", [], false, true)]),
      ui,
      host: new FakeHost(),
      prober: new FakeSetupProber(),
      secretStore: new FailingSecretStore() as never,
    });

    await expect(runtime.run({ json: false, assumeYes: false, backgroundAgent: false, syncHandoff: false })).rejects.toThrow("secret commit failed");
    const reloaded = loadConfig(root);
    expect(pluginSetupStatus(reloaded, "ready")).not.toBe("ready");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setup asks a plugin for its summary exactly once", async () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-setup-summary-"));
  try {
    const config = loadConfig(root);
    config.data.plugins = {};
    const ui = new FakeSetupUI();
    ui.multiselectValues = [["archive"]];
    ui.confirms = [false];
    const plugin = new SetupPlugin("archive", [], true);
    const runtime = new SetupRuntime({
      root,
      config,
      registry: new PluginRegistry([plugin]),
      ui,
      host: new FakeHost(),
      prober: new FakeSetupProber(),
    });

    await runtime.run({ json: false, assumeYes: false, backgroundAgent: false, syncHandoff: false });
    expect(plugin.summarizeCount).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setup records protected sources as degraded instead of probing them in-process when the app is missing", async () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-setup-protected-"));
  const previousAppPath = process.env[APP_PATH_ENV];
  // Point the app path at a path that does not exist: the real prober must
  // report the missing app honestly instead of running plugin checks (browser
  // cookies, Notes automation, protected reads) in the terminal process.
  process.env[APP_PATH_ENV] = join(root, "Applications", "Nutshell.app");
  try {
    const config = loadConfig(root);
    config.data.plugins = {};
    const ui = new FakeSetupUI();
    ui.multiselectValues = [["youtube", "podcasts", "apple_notes", "twitter"]];
    const runtime = new SetupRuntime({
      root,
      config,
      registry: new PluginRegistry([new YouTubePlugin(), new PodcastsPlugin(), new AppleNotesPlugin(), new TwitterPlugin()]),
      ui,
      host: new ProtectedAccessFailingHost(),
      // Intentionally no fake prober: this test pins the DefaultSetupProber
      // contract that fake-ready is impossible without the app.
    });

    const report = await runtime.run({ json: false, assumeYes: false, backgroundAgent: false, syncHandoff: false });

    expect(report.status).toBe("warning");
    expect(exitCodeForSetup(report)).toBe(1);
    const reloaded = loadConfig(root);
    for (const source of ["youtube", "podcasts", "apple_notes", "twitter"]) {
      const plugin = report.plugins.find((item) => item.source === source);
      expect(plugin?.status).toBe("degraded");
      const appMissing = plugin?.findings.find((finding) => finding.code === "nutshell_app_missing");
      expect(appMissing?.level).toBe("critical");
      expect(appMissing?.guidance?.state).toBe("needs_permission");
      expect(pluginSetupStatus(reloaded, source)).toBe("degraded");
    }
  } finally {
    if (previousAppPath === undefined) delete process.env[APP_PATH_ENV];
    else process.env[APP_PATH_ENV] = previousAppPath;
    rmSync(root, { recursive: true, force: true });
  }
});

test("setup enables background sync through the installed app helper", async () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-setup-app-owned-"));
  try {
    const appPath = join(root, "Applications", "Nutshell.app");
    const executable = installFakeApp(appPath);
    const grantedMarker = join(root, "permission-granted");
    const enabledMarker = join(root, "background-enabled");
    writeFileSync(grantedMarker, "yes\n");
    const config = loadConfig(root);
    config.data.plugins = {};
    config.data.app = { path: appPath };
    const ui = new FakeSetupUI();
    ui.multiselectValues = [["ready"]];
    ui.confirms = [true];
    const host = new FakeHost(
      null,
      (run) => {
        if (run.args[0] === "enable-sync") writeFileSync(enabledMarker, "yes\n");
      },
      { appPath, grantedMarker, enabledMarker },
    );
    const runtime = new SetupRuntime({
      root,
      config,
      registry: new PluginRegistry([new SetupPlugin("ready")]),
      ui,
      host,
      prober: new FakeSetupProber(),
      appCommandRunner: emptySmokeSyncRunner(),
    });

    const report = await runtime.run({ json: false, assumeYes: false, backgroundAgent: true, syncHandoff: true });

    expect(report.backgroundAgent.ok).toBe(true);
    expect(report.syncHandoff.ok).toBe(true);
    expect(report.syncHandoff.attempted).toBe(true);
    expect((loadConfig(root).data.app as JsonObject).path).toBe(appPath);
    // Full Disk Access was already granted: the permission window never opens.
    expect(host.permissionWindowOpens).toBe(0);
    expect(host.runs.map((run) => [run.command, ...run.args])).toEqual([
      [executable, "enable-sync"],
      [executable, "register-agent"],
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setup opens the app permission window before any plugin probe and before enabling background sync", async () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-setup-permission-"));
  try {
    const appPath = join(root, "Applications", "Nutshell.app");
    const executable = installFakeApp(appPath);
    const grantedMarker = join(root, "permission-granted");
    const enabledMarker = join(root, "background-enabled");
    const events: string[] = [];
    const config = loadConfig(root);
    config.data.plugins = {};
    config.data.app = { path: appPath };
    const ui = new FakeSetupUI();
    ui.multiselectValues = [["probed"]];
    // The permission loop is user-driven: the window 'grants' FDA via the
    // marker file, then the user answers "I granted it — check again".
    ui.selectedValues = ["check"];
    ui.confirms = [true];
    const host = new FakeHost(
      null,
      (run) => {
        if (run.args[0] === "enable-sync") writeFileSync(enabledMarker, "yes\n");
      },
      { appPath, grantedMarker, enabledMarker, grantOnWindowOpen: true, events },
    );
    const prober = new FakeSetupProber({}, events);
    const runtime = new SetupRuntime({
      root,
      config,
      registry: new PluginRegistry([new ProbedPlugin("probed")]),
      ui,
      host,
      prober,
      appCommandRunner: emptySmokeSyncRunner(),
    });

    const report = await runtime.run({ json: false, assumeYes: false, backgroundAgent: true, syncHandoff: true });

    expect(host.permissionWindowOpens).toBe(1);
    expect(events).toContain("permission-window-opened");
    expect(events).toContain("probe:probed");
    expect(events.indexOf("permission-window-opened")).toBeLessThan(events.indexOf("probe:probed"));
    expect(report.plugins.find((item) => item.source === "probed")?.status).toBe("ready");
    expect(report.backgroundAgent.ok).toBe(true);
    expect(report.syncHandoff.ok).toBe(true);
    expect(host.runs.map((run) => [run.command, ...run.args])).toEqual([
      [executable, "enable-sync"],
      [executable, "register-agent"],
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setup refuses to claim handoff when app-owned status stays disabled", async () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-setup-background-fail-"));
  try {
    const appPath = join(root, "Applications", "Nutshell.app");
    const executable = installFakeApp(appPath);
    const grantedMarker = join(root, "permission-granted");
    const enabledMarker = join(root, "background-enabled");
    writeFileSync(grantedMarker, "yes\n");
    const config = loadConfig(root);
    config.data.plugins = {};
    config.data.app = { path: appPath };
    const ui = new FakeSetupUI();
    ui.multiselectValues = [["ready"]];
    ui.confirms = [true];
    // No onRun hook: enable-sync never flips the marker, so the app-owned
    // status stays disabled even though the helper commands exit 0.
    const host = new FakeHost(null, null, { appPath, grantedMarker, enabledMarker });
    const runtime = new SetupRuntime({
      root,
      config,
      registry: new PluginRegistry([new SetupPlugin("ready")]),
      ui,
      host,
      prober: new FakeSetupProber(),
    });

    const report = await runtime.run({ json: false, assumeYes: false, backgroundAgent: true, syncHandoff: true });

    expect(report.status).toBe("warning");
    expect(report.backgroundAgent.ok).toBe(false);
    expect(report.syncHandoff.ok).toBe(false);
    expect(report.syncHandoff.message).toContain("not handed off");
    expect(host.runs.map((run) => [run.command, ...run.args])).toEqual([
      [executable, "enable-sync"],
      [executable, "register-agent"],
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setup runs one bounded smoke sync through the app identity and reports its real result", async () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-setup-smoke-sync-"));
  try {
    const appPath = join(root, "Applications", "Nutshell.app");
    installFakeApp(appPath);
    const grantedMarker = join(root, "permission-granted");
    const enabledMarker = join(root, "background-enabled");
    writeFileSync(grantedMarker, "yes\n");
    const config = loadConfig(root);
    config.data.plugins = {};
    config.data.app = { path: appPath };
    const ui = new FakeSetupUI();
    ui.multiselectValues = [["ready"]];
    ui.confirms = [true];
    const host = new FakeHost(
      null,
      (run) => {
        if (run.args[0] === "enable-sync") writeFileSync(enabledMarker, "yes\n");
      },
      { appPath, grantedMarker, enabledMarker },
    );
    const runnerCalls: Array<{ appPath: string; args: string[]; timeoutMs: number }> = [];
    const runtime = new SetupRuntime({
      root,
      config,
      registry: new PluginRegistry([new SetupPlugin("ready")]),
      ui,
      host,
      prober: new FakeSetupProber(),
      appCommandRunner: async (commandAppPath, args, timeoutMs) => {
        runnerCalls.push({ appPath: commandAppPath, args: [...args], timeoutMs });
        return {
          code: 0,
          stdout: JSON.stringify({
            status: "ok",
            sources: [
              { source: "youtube", status: "ok", commit: { insertedRecords: 5 } },
              { source: "podcasts", status: "ok", commit: { insertedRecords: 7 } },
              { source: "apple_notes", status: "ok" },
              { source: "twitter", status: "warning", commit: { insertedRecords: 0 } },
            ],
          }),
          stderr: "",
          timedOut: false,
        };
      },
    });

    const report = await runtime.run({ json: false, assumeYes: false, backgroundAgent: true, syncHandoff: true });

    expect(runnerCalls.length).toBe(1);
    expect(runnerCalls[0]?.appPath).toBe(appPath);
    const args = runnerCalls[0]!.args;
    expect(args).toContain("--timeout");
    const modeIndex = args.indexOf("--mode");
    expect(modeIndex).toBeGreaterThanOrEqual(0);
    expect(args[modeIndex + 1]).toBe("recent");
    expect(report.syncHandoff.attempted).toBe(true);
    expect(report.syncHandoff.ok).toBe(true);
    expect(report.syncHandoff.message).toContain("12 records");
    expect(report.status).toBe("ok");
    // The real result appears in the final summary, not just the report JSON.
    expect(ui.notes.some((note) => note.includes("smoke sync ok: 12 records across 4 sources"))).toBe(true);
    expect(ui.notes.every((note) => !note.includes("handed off to background agent"))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a smoke sync that fails to run is reported honestly and degrades the setup report", async () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-setup-smoke-fail-"));
  try {
    const appPath = join(root, "Applications", "Nutshell.app");
    installFakeApp(appPath);
    const grantedMarker = join(root, "permission-granted");
    const enabledMarker = join(root, "background-enabled");
    writeFileSync(grantedMarker, "yes\n");
    const config = loadConfig(root);
    config.data.plugins = {};
    config.data.app = { path: appPath };
    const ui = new FakeSetupUI();
    ui.multiselectValues = [["ready"]];
    ui.confirms = [true];
    const host = new FakeHost(
      null,
      (run) => {
        if (run.args[0] === "enable-sync") writeFileSync(enabledMarker, "yes\n");
      },
      { appPath, grantedMarker, enabledMarker },
    );
    const runtime = new SetupRuntime({
      root,
      config,
      registry: new PluginRegistry([new SetupPlugin("ready")]),
      ui,
      host,
      prober: new FakeSetupProber(),
      appCommandRunner: async () => ({ code: 2, stdout: "launchctl exploded mid-flight", stderr: "boom", timedOut: false }),
    });

    const report = await runtime.run({ json: false, assumeYes: false, backgroundAgent: true, syncHandoff: true });

    expect(report.syncHandoff.attempted).toBe(true);
    expect(report.syncHandoff.ok).toBe(false);
    expect(report.syncHandoff.message).toBe("smoke sync failed to run");
    expect(report.syncHandoff.detail.code).toBe(2);
    expect(report.status).toBe("warning");
    expect(exitCodeForSetup(report)).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("declining the background service skips the smoke sync with an honest message", async () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-setup-smoke-declined-"));
  try {
    const appPath = join(root, "Applications", "Nutshell.app");
    installFakeApp(appPath);
    const grantedMarker = join(root, "permission-granted");
    const enabledMarker = join(root, "background-enabled");
    writeFileSync(grantedMarker, "yes\n");
    const config = loadConfig(root);
    config.data.plugins = {};
    config.data.app = { path: appPath };
    const ui = new FakeSetupUI();
    ui.multiselectValues = [["ready"]];
    ui.confirms = [false];
    const host = new FakeHost(null, null, { appPath, grantedMarker, enabledMarker });
    const runnerCalls: string[][] = [];
    const runtime = new SetupRuntime({
      root,
      config,
      registry: new PluginRegistry([new SetupPlugin("ready")]),
      ui,
      host,
      prober: new FakeSetupProber(),
      appCommandRunner: async (_appPath, args) => {
        runnerCalls.push([...args]);
        return { code: 0, stdout: JSON.stringify({ status: "ok", sources: [] }), stderr: "", timedOut: false };
      },
    });

    const report = await runtime.run({ json: false, assumeYes: false, backgroundAgent: true, syncHandoff: true });

    expect(runnerCalls.length).toBe(0);
    expect(report.syncHandoff.attempted).toBe(false);
    expect(report.syncHandoff.ok).toBe(true);
    expect(report.syncHandoff.message).toBe("initial sync not scheduled; background service was not enabled");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an already-imported archive renders imported and is not re-offered", async () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-setup-already-imported-"));
  try {
    // Seed the store with an import-shaped checkpoint: the official YouTube
    // export already covers the configured cutoff, exactly what a real
    // `nutshell import youtube <export.zip>` leaves behind.
    const store = openStore(join(root, "nutshell.sqlite"));
    try {
      await store.commitSync({
        source: "youtube",
        run: { id: "seed-import", command: "import youtube", mode: "backfill", startedAt: new Date() },
        result: {
          ...fakeResult("youtube"),
          observations: [],
          records: [],
          nextCheckpoint: {
            backfill: {
              imports: {
                google_youtube: { oldest: "2001-01-01T00:00:00.000Z", newest: "2026-01-01T00:00:00.000Z", counts: { records: 3 } },
              },
            },
          },
        },
        expectedCheckpointVersion: 0,
      });
    } finally {
      await store.close();
    }
    const config = loadConfig(root);
    config.data.plugins = {};
    const ui = new FakeSetupUI();
    ui.multiselectValues = [["youtube"]];
    // Sentinel: if setup offered the archive import anyway, this confirm
    // would be consumed and the import path would run.
    ui.confirms = [true];
    const plugin = new SetupPlugin("youtube", [], true);
    const runtime = new SetupRuntime({
      root,
      config,
      registry: new PluginRegistry([plugin]),
      ui,
      host: new FakeHost(),
      prober: new FakeSetupProber(),
    });

    const report = await runtime.run({ json: false, assumeYes: false, backgroundAgent: false, syncHandoff: false });

    expect(report.plugins.find((item) => item.source === "youtube")?.archiveImport).toBe("imported");
    expect(plugin.importedPath).toBeNull();
    expect(ui.confirms.length).toBe(1);
    expect(ui.notes.some((note) => note.includes("history import complete"))).toBe(true);
    expect(ui.notes.every((note) => !note.includes("history import pending"))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setup retries a failing probe and records ready only after it passes", async () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-setup-retry-"));
  try {
    const config = loadConfig(root);
    config.data.plugins = {};
    const ui = new FakeSetupUI();
    ui.multiselectValues = [["probed"]];
    ui.selectedValues = ["retry"];
    const prober = new FakeSetupProber({ probed: [[criticalProbeFinding("probed")], []] });
    const runtime = new SetupRuntime({
      root,
      config,
      registry: new PluginRegistry([new ProbedPlugin("probed")]),
      ui,
      host: new FakeHost(),
      prober,
    });

    const report = await runtime.run({ json: false, assumeYes: false, backgroundAgent: false, syncHandoff: false });

    expect(report.status).toBe("ok");
    expect(report.plugins.find((item) => item.source === "probed")?.status).toBe("ready");
    expect(prober.callCount("probed")).toBe(2);
    expect(pluginSetupStatus(loadConfig(root), "probed")).toBe("ready");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("skipping a failing probe records degraded with the probe finding and exits 1", async () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-setup-skip-"));
  try {
    const config = loadConfig(root);
    config.data.plugins = {};
    const ui = new FakeSetupUI();
    ui.multiselectValues = [["probed"]];
    ui.selectedValues = ["skip"];
    const failing = criticalProbeFinding("probed");
    const prober = new FakeSetupProber({ probed: [[failing]] });
    const runtime = new SetupRuntime({
      root,
      config,
      registry: new PluginRegistry([new ProbedPlugin("probed")]),
      ui,
      host: new FakeHost(),
      prober,
    });

    const report = await runtime.run({ json: false, assumeYes: false, backgroundAgent: false, syncHandoff: false });

    expect(report.status).toBe("warning");
    expect(exitCodeForSetup(report)).toBe(1);
    expect(report.plugins.find((item) => item.source === "probed")?.status).toBe("degraded");
    const reloaded = loadConfig(root);
    expect(pluginSetupStatus(reloaded, "probed")).toBe("degraded");
    const stored = pluginSetupFindings(reloaded, "probed");
    expect(stored.length).toBe(1);
    expect(stored[0]?.code).toBe("probed_signed_out");
    expect(stored[0]?.guidance).toEqual({ ...failing.guidance });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the probe loop opens the guidance url and re-verifies on the open-and-retry choice", async () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-setup-open-url-"));
  try {
    const url = "https://x.com/login";
    const config = loadConfig(root);
    config.data.plugins = {};
    const ui = new FakeSetupUI();
    ui.multiselectValues = [["probed"]];
    ui.selectedValues = ["open"];
    const prober = new FakeSetupProber({ probed: [[criticalProbeFinding("probed", url)], []] });
    const host = new FakeHost();
    const runtime = new SetupRuntime({
      root,
      config,
      registry: new PluginRegistry([new ProbedPlugin("probed")]),
      ui,
      host,
      prober,
    });

    const report = await runtime.run({ json: false, assumeYes: false, backgroundAgent: false, syncHandoff: false });

    expect(host.openedUrls).toEqual([url]);
    expect(prober.callCount("probed")).toBe(2);
    expect(report.plugins.find((item) => item.source === "probed")?.status).toBe("ready");
    expect(pluginSetupStatus(loadConfig(root), "probed")).toBe("ready");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a plugin whose probe always fails is never recorded ready", async () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-setup-never-ready-"));
  try {
    const config = loadConfig(root);
    config.data.plugins = {};
    // Entirely unscripted UI: multiselect defaults to every plugin and the
    // probe-loop select falls through to the last option (skip).
    const ui = new FakeSetupUI();
    const prober = new FakeSetupProber({ probed: [[criticalProbeFinding("probed")]] });
    const runtime = new SetupRuntime({
      root,
      config,
      registry: new PluginRegistry([new ProbedPlugin("probed")]),
      ui,
      host: new FakeHost(),
      prober,
    });

    const report = await runtime.run({ json: false, assumeYes: false, backgroundAgent: false, syncHandoff: false });

    expect(report.status).toBe("warning");
    expect(report.plugins.find((item) => item.source === "probed")?.status).toBe("degraded");
    expect(pluginSetupStatus(loadConfig(root), "probed")).toBe("degraded");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a third-party plugin with its own verify completes fail-retry-pass through the generic loop", async () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-setup-third-party-"));
  try {
    const config = loadConfig(root);
    config.data.plugins = {};
    const ui = new FakeSetupUI();
    ui.multiselectValues = [["thirdparty"]];
    ui.selectedValues = ["retry"];
    const plugin = new ThirdPartyPlugin("thirdparty", [[criticalProbeFinding("thirdparty")], []]);
    const prober = new FakeSetupProber();
    const runtime = new SetupRuntime({
      root,
      config,
      registry: new PluginRegistry([plugin]),
      ui,
      host: new FakeHost(),
      prober,
    });

    const report = await runtime.run({ json: false, assumeYes: false, backgroundAgent: false, syncHandoff: false });

    expect(report.status).toBe("ok");
    expect(report.plugins.find((item) => item.source === "thirdparty")?.status).toBe("ready");
    expect(plugin.verifyCalls).toBe(2);
    // The plugin's own verify takes precedence: the injected prober is unused.
    expect(prober.calls.length).toBe(0);
    expect(pluginSetupStatus(loadConfig(root), "thirdparty")).toBe("ready");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("re-run setup reviews current truth and walks only failing sources through the loop", async () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-setup-rerun-fix-"));
  try {
    const config = loadConfig(root);
    config.data.plugins = {
      alpha: { enabled: true, setup: { status: "ready", updatedAt: "2026-06-01T00:00:00.000Z", findings: [] } },
      beta: { enabled: true, setup: { status: "ready", updatedAt: "2026-06-01T00:00:00.000Z", findings: [] } },
    };
    const ui = new NoMultiselectUI();
    ui.selectedValues = ["fix", "retry"];
    const prober = new FakeSetupProber({ alpha: [[]], beta: [[criticalProbeFinding("beta")], []] });
    const runtime = new SetupRuntime({
      root,
      config,
      registry: new PluginRegistry([new ProbedPlugin("alpha"), new ProbedPlugin("beta")]),
      ui,
      host: new FakeHost(),
      prober,
    });

    const report = await runtime.run({ json: false, assumeYes: false, backgroundAgent: false, syncHandoff: false });

    // No first-run intro on a re-run.
    expect(ui.notes.some((note) => note.startsWith(`${PRODUCT_NAME} setup`))).toBe(false);
    expect(ui.notes.some((note) => note.includes("1 of 2 sources working"))).toBe(true);
    // Passing source: probed once at the review only. Failing source: review
    // probe plus the in-loop probe after retry.
    expect(prober.callCount("alpha")).toBe(1);
    expect(prober.callCount("beta")).toBe(2);
    expect(report.status).toBe("ok");
    const reloaded = loadConfig(root);
    expect(pluginSetupStatus(reloaded, "alpha")).toBe("ready");
    expect(pluginSetupStatus(reloaded, "beta")).toBe("ready");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("re-run setup exit records review truth without walking the plugin loop", async () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-setup-rerun-exit-"));
  try {
    const config = loadConfig(root);
    config.data.plugins = {
      alpha: { enabled: true, setup: { status: "ready", updatedAt: "2026-06-01T00:00:00.000Z", findings: [] } },
      beta: { enabled: true, setup: { status: "ready", updatedAt: "2026-06-01T00:00:00.000Z", findings: [] } },
    };
    const ui = new NoMultiselectUI();
    ui.selectedValues = ["exit"];
    const prober = new FakeSetupProber({ alpha: [[]], beta: [[criticalProbeFinding("beta")]] });
    const runtime = new SetupRuntime({
      root,
      config,
      registry: new PluginRegistry([new ProbedPlugin("alpha"), new ProbedPlugin("beta")]),
      ui,
      host: new FakeHost(),
      prober,
    });

    const report = await runtime.run({ json: false, assumeYes: false, backgroundAgent: true, syncHandoff: true });

    expect(report.status).toBe("warning");
    expect(exitCodeForSetup(report)).toBe(1);
    expect(report.backgroundAgent.message).toContain("status review");
    // Review probes only — no plugin-loop probes after choosing exit.
    expect(prober.callCount("alpha")).toBe(1);
    expect(prober.callCount("beta")).toBe(1);
    const reloaded = loadConfig(root);
    expect(pluginSetupStatus(reloaded, "alpha")).toBe("ready");
    expect(pluginSetupStatus(reloaded, "beta")).toBe("degraded");
    expect(pluginSetupFindings(reloaded, "beta").map((finding) => finding.code)).toContain("beta_signed_out");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a probe that never resolves is bounded by the core timeout and recorded honestly", async () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-setup-hang-"));
  try {
    const config = loadConfig(root);
    config.data.plugins = {};
    const ui = new FakeSetupUI();
    ui.multiselectValues = [["stuck"]];
    const prober: SetupProber = { probe: () => new Promise<never>(() => {}) };
    const runtime = new SetupRuntime({
      root,
      config,
      registry: new PluginRegistry([new ProbedPlugin("stuck")]),
      ui,
      host: new FakeHost(),
      prober,
      setupPluginTimeoutMs: 50,
    });

    const report = await runtime.run({ json: false, assumeYes: false, backgroundAgent: false, syncHandoff: false });

    expect(report.status).toBe("warning");
    const plugin = report.plugins.find((item) => item.source === "stuck");
    expect(plugin?.status).toBe("degraded");
    expect(plugin?.findings.map((finding) => finding.code)).toContain("plugin_setup_timeout");
    expect(pluginSetupStatus(loadConfig(root), "stuck")).toBe("degraded");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function criticalProbeFinding(source: string, url?: string): HealthFinding {
  return makeFinding("critical", source, `${source}_signed_out`, `${source} session is signed out`, {}, {
    state: "needs_auth",
    fix: `Sign into ${source} in the browser profile Nutshell uses`,
    confirm: `nutshell doctor ${source}`,
    ...(url ? { url } : {}),
  });
}

function installFakeApp(appPath: string): string {
  const executable = join(appPath, "Contents", "MacOS", "Nutshell");
  mkdirSync(join(appPath, "Contents", "MacOS"), { recursive: true });
  writeFileSync(executable, "");
  return executable;
}

// A scripted app-command runner whose smoke sync succeeds with no sources.
function emptySmokeSyncRunner(): AppCommandRunner {
  return async () => ({ code: 0, stdout: JSON.stringify({ status: "ok", sources: [] }), stderr: "", timedOut: false });
}

class NoMultiselectUI extends FakeSetupUI {
  async multiselect<T>(): Promise<T[]> {
    throw new Error("re-run setup must not re-ask plugin selection");
  }
}

class SetupPlugin implements TracePlugin {
  importedPath: string | null = null;
  summarizeCount = 0;
  readonly manifest: PluginManifest;

  constructor(
    id: string,
    private readonly verifyFindings: HealthFinding[] = [],
    private readonly archive = false,
    private readonly writeSecret = false,
  ) {
    this.manifest = {
      id,
      displayName: id,
      authKind: "none",
      collections: ["default"],
      supportsBackfill: archive,
      defaultBudget: DEFAULT_SYNC_BUDGET,
    };
  }

  // verify takes precedence over the injected prober — intended here, so these
  // tests stay independent of any prober scripting.
  readonly setup = {
    summarize: async (_ctx: PluginSetupContext) => {
      this.summarizeCount += 1;
      return {
        title: this.manifest.displayName,
        body: "fake setup",
        archiveImport: this.archive
          ? {
              title: "Import archive?",
              body: "fake archive",
              laterCommand: `nutshell import ${this.manifest.id} <archive.zip> --json`,
              allowedExtensions: ["zip"],
            }
          : undefined,
      };
    },
    run: async (ctx: PluginSetupContext) => {
      if (this.writeSecret) await ctx.secrets.set("token", "secret-token");
      return { findings: [] };
    },
    verify: async (_ctx: PluginSetupContext) => this.verifyFindings,
  };

  async check(): Promise<HealthFinding[]> {
    return this.verifyFindings;
  }

  async sync(_ctx: PluginContext, _request: SyncRequest, checkpoint: Checkpoint): Promise<PluginSyncResult> {
    return { ...fakeResult(this.manifest.id), nextCheckpoint: checkpoint.state };
  }

  async importProviderExport(_ctx: PluginContext, request: ProviderExportImportRequest, _checkpoint: Checkpoint): Promise<PluginSyncResult> {
    this.importedPath = request.path;
    return fakeResult(this.manifest.id);
  }
}

// A plugin with no custom setup at all: core verifies it through the injected
// prober — the generic path every third-party plugin gets for free.
class ProbedPlugin implements TracePlugin {
  readonly manifest: PluginManifest;

  constructor(id: string) {
    this.manifest = {
      id,
      displayName: id,
      authKind: "none",
      collections: ["default"],
      supportsBackfill: false,
      defaultBudget: DEFAULT_SYNC_BUDGET,
    };
  }

  async check(): Promise<HealthFinding[]> {
    return [];
  }

  async sync(_ctx: PluginContext, _request: SyncRequest, checkpoint: Checkpoint): Promise<PluginSyncResult> {
    return { ...fakeResult(this.manifest.id), nextCheckpoint: checkpoint.state };
  }
}

// A plugin that owns verification via setup.verify, sequenced like a probe:
// each call consumes the next findings array and the last entry repeats.
class ThirdPartyPlugin implements TracePlugin {
  verifyCalls = 0;
  readonly manifest: PluginManifest;

  constructor(
    id: string,
    private readonly verifySequence: HealthFinding[][],
  ) {
    this.manifest = {
      id,
      displayName: id,
      authKind: "none",
      collections: ["default"],
      supportsBackfill: false,
      defaultBudget: DEFAULT_SYNC_BUDGET,
    };
  }

  readonly setup = {
    summarize: async (_ctx: PluginSetupContext) => ({ title: this.manifest.displayName, body: "third-party setup" }),
    verify: async (_ctx: PluginSetupContext) => {
      this.verifyCalls += 1;
      if (!this.verifySequence.length) return [];
      return this.verifySequence.length > 1 ? this.verifySequence.shift()! : this.verifySequence[0]!;
    },
  };

  async check(): Promise<HealthFinding[]> {
    return [];
  }

  async sync(_ctx: PluginContext, _request: SyncRequest, checkpoint: Checkpoint): Promise<PluginSyncResult> {
    return { ...fakeResult(this.manifest.id), nextCheckpoint: checkpoint.state };
  }
}

class SlowSetupPlugin implements TracePlugin {
  readonly manifest: PluginManifest;

  constructor(id: string) {
    this.manifest = {
      id,
      displayName: id,
      authKind: "none",
      collections: ["default"],
      supportsBackfill: false,
      defaultBudget: DEFAULT_SYNC_BUDGET,
    };
  }

  readonly setup = {
    summarize: async (_ctx: PluginSetupContext) => ({ title: this.manifest.displayName, body: "slow setup" }),
    run: async (ctx: PluginSetupContext) => {
      await new Promise<never>((_, reject) => {
        if (ctx.signal.aborted) {
          reject(ctx.signal.reason ?? new Error("aborted"));
          return;
        }
        ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason ?? new Error("aborted")), { once: true });
      });
      return { findings: [] };
    },
    verify: async (_ctx: PluginSetupContext) => [],
  };

  async check(): Promise<HealthFinding[]> {
    return [];
  }

  async sync(_ctx: PluginContext, _request: SyncRequest, checkpoint: Checkpoint): Promise<PluginSyncResult> {
    return { ...fakeResult(this.manifest.id), nextCheckpoint: checkpoint.state };
  }
}

class FailingSecretStore {
  async draft() {
    return {
      plugin: () => ({
        get: async () => null,
        set: async () => undefined,
        delete: async () => undefined,
        listKeys: async () => [],
      }),
      commit: async () => {
        throw new Error("secret commit failed");
      },
    };
  }
}

interface FakeMacosOptions {
  appPath: string;
  grantedMarker: string;
  enabledMarker: string;
  // Simulates the user granting Full Disk Access in the window that opens.
  grantOnWindowOpen?: boolean;
  // Shared event log across fakes for ordering assertions.
  events?: string[];
}

class FakeHost implements HostCapabilities {
  runs: Array<{ command: string; args: string[] }> = [];
  openedUrls: string[] = [];
  permissionWindowOpens = 0;
  readonly macos?: MacHostCapabilities;

  constructor(
    private readonly file: string | null = null,
    private readonly onRun: ((run: { command: string; args: string[] }) => void) | null = null,
    macosOptions?: FakeMacosOptions,
  ) {
    if (macosOptions) {
      this.macos = {
        openPrivacyPane: async () => {},
        showNutshellPermissionWindow: async () => {
          this.permissionWindowOpens += 1;
          macosOptions.events?.push("permission-window-opened");
          if (macosOptions.grantOnWindowOpen) writeFileSync(macosOptions.grantedMarker, "granted\n");
        },
        appStatus: async (): Promise<MacAppStatus> => {
          const installed = existsSync(join(macosOptions.appPath, "Contents", "MacOS", "Nutshell"));
          const granted = existsSync(macosOptions.grantedMarker);
          const enabled = existsSync(macosOptions.enabledMarker);
          return {
            installed,
            path: macosOptions.appPath,
            fullDiskAccess: granted ? "granted" : "missing",
            backgroundSync: enabled ? "enabled" : "disabled",
            agent: enabled ? "enabled" : "notRegistered",
            raw: "",
          };
        },
      };
    }
  }

  async openUrl(url: string): Promise<void> {
    this.openedUrls.push(url);
  }
  async revealPath(): Promise<void> {}
  async openApp(_pathOrBundleId: string): Promise<void> {}
  async chooseFile(): Promise<string | null> {
    return this.file;
  }
  async run(input: { command: string; args: string[] }): Promise<HostRunResult> {
    const run = { command: input.command, args: [...input.args] };
    this.runs.push(run);
    this.onRun?.(run);
    return { code: 0, stdout: "", stderr: "" };
  }
}

class ProtectedAccessFailingHost extends FakeHost {
  override async openUrl(url: string): Promise<void> {
    throw new Error(`setup attempted to open URL during protected-source setup: ${url}`);
  }
  override async openApp(pathOrBundleId: string): Promise<void> {
    throw new Error(`setup attempted to open app during protected-source setup: ${pathOrBundleId}`);
  }
  override async chooseFile(): Promise<string | null> {
    throw new Error("setup attempted to choose an archive file without user confirmation");
  }
  override async run(input: { command: string; args: string[] }): Promise<HostRunResult> {
    throw new Error(`setup attempted to run host command during protected-source setup: ${[input.command, ...input.args].join(" ")}`);
  }
}

function fakeResult(source: string): PluginSyncResult {
  const observedAt = new Date("2026-05-24T12:00:00Z");
  return {
    observations: [
      {
        source,
        observedAt,
        sourceRecordId: "one",
        fingerprint: `${source}:one`,
        payload: {},
        artifactPaths: [],
      },
    ],
    records: [
      {
        source,
        collection: "default",
        kind: "event",
        type: "fake.event",
        sourceId: "one",
        happenedAt: observedAt,
        observedAt,
        title: "one",
        url: null,
        bodyText: null,
        artifactRefs: [],
        payload: {},
      },
    ],
    nextCheckpoint: { imported: true },
    health: [],
    metrics: {},
    completed: true,
    partial: false,
  };
}
