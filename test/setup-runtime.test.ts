import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SYNC_BUDGET } from "../src/config/defaults";
import { loadConfig } from "../src/config/config";
import type { Checkpoint, HealthFinding, JsonObject, PluginContext, PluginManifest, PluginSyncResult, ProviderExportImportRequest, SyncRequest } from "../src/core/types";
import { makeFinding } from "../src/health/health";
import type { TracePlugin } from "../src/plugins/interface";
import { PluginRegistry } from "../src/plugins/registry";
import { SetupRuntime } from "../src/setup/setup-runtime";
import type { HostCapabilities, HostRunResult, PluginSetupContext } from "../src/setup/types";
import { pluginSetupStatus } from "../src/setup/config-draft";
import { FakeSetupUI } from "../src/testing/fake-setup-ui";
import { openStore } from "../src/store/sqlite-store";

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
      setupPluginTimeoutMs: 5,
    });

    const report = await runtime.run({ json: false, assumeYes: false, backgroundAgent: false, syncHandoff: false });

    expect(report.status).toBe("warning");
    expect(report.plugins.find((item) => item.source === "slow")?.status).toBe("degraded");
    expect(report.plugins.find((item) => item.source === "slow")?.findings[0]?.code).toBe("plugin_setup_timeout");
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
    });

    await expect(runtime.run({ json: false, assumeYes: false, backgroundAgent: false, syncHandoff: false })).rejects.toThrow("setup cancelled");
    expect(readFileSync(config.path, "utf8")).toBe(before);
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
    });

    await runtime.run({ json: false, assumeYes: false, backgroundAgent: false, syncHandoff: false });
    expect(plugin.summarizeCount).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setup enables background sync through the installed app helper", async () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-setup-app-owned-"));
  try {
    const appPath = join(root, "Applications", "Nutshell.app");
    const executable = join(appPath, "Contents", "MacOS", "Nutshell");
    const enabledMarker = join(root, "background-enabled");
    mkdirSync(join(appPath, "Contents", "MacOS"), { recursive: true });
    writeFileSync(
      executable,
      `#!/bin/sh
if [ "$1" = "status" ]; then
  echo "Full Disk Access: granted"
  if [ -f "${enabledMarker}" ]; then
    echo "Agent status: enabled"
    echo "Background sync: enabled"
  else
    echo "Agent status: notRegistered"
    echo "Background sync: disabled"
  fi
  echo "Data root: ${root}/Nutshell"
  exit 0
fi
exit 64
`,
      "utf8",
    );
    chmodSync(executable, 0o755);
    const config = loadConfig(root);
    config.data.plugins = {};
    config.data.app = { path: appPath };
    const ui = new FakeSetupUI();
    ui.multiselectValues = [["ready"]];
    ui.confirms = [true];
    const host = new FakeHost(null, (run) => {
      if (run.args[0] === "enable-sync") writeFileSync(enabledMarker, "yes\n");
    });
    const runtime = new SetupRuntime({
      root,
      config,
      registry: new PluginRegistry([new SetupPlugin("ready")]),
      ui,
      host,
    });

    const report = await runtime.run({ json: false, assumeYes: false, backgroundAgent: true, syncHandoff: true });

    expect(report.backgroundAgent.ok).toBe(true);
    expect(report.syncHandoff.ok).toBe(true);
    expect(report.syncHandoff.attempted).toBe(false);
    expect((loadConfig(root).data.app as JsonObject).path).toBe(appPath);
    expect(host.runs.map((run) => [run.command, ...run.args])).toEqual([
      [executable, "enable-sync"],
      [executable, "register-agent"],
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setup opens the app permission window before enabling protected background sync", async () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-setup-permission-"));
  try {
    const appPath = join(root, "Applications", "Nutshell.app");
    const executable = join(appPath, "Contents", "MacOS", "Nutshell");
    const grantedMarker = join(root, "permission-granted");
    const enabledMarker = join(root, "background-enabled");
    mkdirSync(join(appPath, "Contents", "MacOS"), { recursive: true });
    writeFileSync(
      executable,
      `#!/bin/sh
if [ "$1" = "status" ]; then
  if [ -f "${grantedMarker}" ]; then
    echo "Full Disk Access: granted"
    if [ -f "${enabledMarker}" ]; then
      echo "Agent status: enabled"
      echo "Background sync: enabled"
    else
      echo "Agent status: notRegistered"
      echo "Background sync: disabled"
    fi
  else
    echo "Full Disk Access: not granted"
    echo "Agent status: notRegistered"
    echo "Background sync: disabled"
  fi
  echo "Data root: ${root}/Nutshell"
  exit 0
fi
exit 0
`,
      "utf8",
    );
    chmodSync(executable, 0o755);
    const config = loadConfig(root);
    config.data.plugins = {};
    config.data.app = { path: appPath };
    const ui = new FakeSetupUI();
    ui.multiselectValues = [["ready"]];
    ui.confirms = [true];
    const host = new FakeHost(null, (run) => {
      if (run.args.includes("setup")) writeFileSync(grantedMarker, "yes\n");
      if (run.args[0] === "enable-sync") writeFileSync(enabledMarker, "yes\n");
    });
    const runtime = new SetupRuntime({
      root,
      config,
      registry: new PluginRegistry([new SetupPlugin("ready")]),
      ui,
      host,
    });

    const report = await runtime.run({ json: false, assumeYes: false, backgroundAgent: true, syncHandoff: true });
    const setupCommand =
      process.platform === "darwin" ? ["/usr/bin/open", "-n", appPath, "--args", "setup"] : [executable, "setup"];

    expect(report.backgroundAgent.ok).toBe(true);
    expect(report.syncHandoff.ok).toBe(true);
    expect(report.syncHandoff.attempted).toBe(false);
    expect(host.runs.map((run) => [run.command, ...run.args])).toEqual([
      setupCommand,
      [executable, "enable-sync"],
      [executable, "register-agent"],
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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

class FakeHost implements HostCapabilities {
  runs: Array<{ command: string; args: string[] }> = [];

  constructor(
    private readonly file: string | null = null,
    private readonly onRun: ((run: { command: string; args: string[] }) => void) | null = null,
  ) {}

  async openUrl(): Promise<void> {}
  async revealPath(): Promise<void> {}
  async openApp(): Promise<void> {}
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
