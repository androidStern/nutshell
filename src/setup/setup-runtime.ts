import { existsSync } from "node:fs";
import type { HealthFinding, JsonObject, PluginContext, SourceId } from "../core/types";
import { DEFAULT_SYNC_BUDGET } from "../config/defaults";
import { loadConfig, logPath, numberAt, objectAt, pluginConfig, resolveConfigPath, resolveRoot, type TraceConfig } from "../config/config";
import { makeFinding, reportStatus as healthReportStatus } from "../health/health";
import { appExecutable, appStatusJson, ensureStableAppPath, inspectNutshellApp } from "../macos/app-status";
import { loadBuiltinPlugins, type PluginRegistry } from "../plugins/registry";
import type { TracePlugin } from "../plugins/interface";
import { redactText } from "../core/redaction";
import { JsonlLogger } from "../runtime/logger";
import { TraceRuntime } from "../runtime/trace-runtime";
import { JsonConfigDraft } from "./config-draft";
import { defaultSecretStore, type FileSecretStore } from "./secret-store";
import { DefaultHostCapabilities } from "./host";
import { ClackSetupUI } from "./ui-clack";
import type {
  ConfigDraft,
  HostCapabilities,
  PluginArchiveImportOffer,
  PluginSetupContext,
  PluginSetupSummary,
  SetupPluginReport,
  SetupReport,
  SetupRequest,
  SetupUI,
} from "./types";

export interface SetupRuntimeOptions {
  root?: string;
  configPath?: string;
  config?: TraceConfig;
  registry?: PluginRegistry;
  ui?: SetupUI;
  host?: HostCapabilities;
  secretStore?: FileSecretStore;
  setupPluginTimeoutMs?: number;
}

interface PendingImport {
  source: SourceId;
  path: string;
}

interface PluginSetupOutcome {
  report: SetupPluginReport;
  summary: PluginSetupSummary;
}

export class SetupRuntime {
  readonly config: TraceConfig;
  readonly registry: PluginRegistry;
  readonly ui: SetupUI;
  readonly host: HostCapabilities;
  readonly logger: JsonlLogger;
  readonly secretStore: FileSecretStore;
  readonly setupPluginTimeoutMs: number;

  constructor(options: SetupRuntimeOptions = {}) {
    const configPath = options.configPath ?? resolveConfigPath(options.root);
    const root = options.root ? resolveRoot(options.root, configPath) : resolveRoot(undefined, configPath);
    this.config = options.config ?? loadConfig(root, configPath);
    this.registry = options.registry ?? loadBuiltinPlugins();
    this.ui = options.ui ?? new ClackSetupUI();
    this.host = options.host ?? new DefaultHostCapabilities(ensureStableAppPath(this.config));
    this.logger = new JsonlLogger(logPath(this.config));
    this.secretStore = options.secretStore ?? defaultSecretStore(this.config.root);
    this.setupPluginTimeoutMs = options.setupPluginTimeoutMs ?? setupPluginTimeoutMs(this.config);
  }

  async run(request: SetupRequest): Promise<SetupReport> {
    const startedAt = new Date();
    const draft = new JsonConfigDraft(this.config);
    const secretDraft = await this.secretStore.draft();
    const controller = new AbortController();
    const reports: SetupPluginReport[] = [];
    const pendingImports: PendingImport[] = [];

    this.logger.event("setup: started", {});
    await this.ui.intro({
      title: "Nutshell setup",
      body: `Data root: ${this.config.root}\nConfig: ${this.config.path}`,
    });

    const selected = await this.selectPlugins(draft);
    const selectedIds = new Set(selected.map((plugin) => plugin.manifest.id));
    const installedAppPath = ensureStableAppPath(this.config);
    if (existsSync(appExecutable(installedAppPath))) {
      const appConfig = draft.data.app && typeof draft.data.app === "object" && !Array.isArray(draft.data.app) ? (draft.data.app as JsonObject) : {};
      draft.data.app = { ...appConfig, path: installedAppPath };
    }
    for (const plugin of this.registry.list()) {
      draft.setPluginEnabled(plugin.manifest.id, selectedIds.has(plugin.manifest.id));
      if (!selectedIds.has(plugin.manifest.id)) {
        reports.push({
          source: plugin.manifest.id,
          displayName: plugin.manifest.displayName,
          status: "disabled",
          findings: [],
          archiveImport: "unavailable",
          importCommand: null,
        });
      }
    }

    for (const plugin of selected) {
      const ctx = this.pluginSetupContext(plugin, draft, secretDraft.plugin(plugin.manifest.id), controller.signal);
      const { report, summary } = await this.setupPlugin(plugin, ctx);
      reports.push(report);
      draft.setPluginSetupStatus(plugin.manifest.id, report.status, report.findings);
      if (report.status === "ready" && report.importCommand && plugin.importProviderExport) {
        const offer = summary?.archiveImport;
        const archivePath = offer ? await this.offerArchiveImport(offer) : null;
        if (archivePath) {
          pendingImports.push({ source: plugin.manifest.id, path: archivePath });
          report.archiveImport = "imported";
        } else if (offer) {
          report.archiveImport = "skipped";
        }
      }
    }

    await secretDraft.commit();
    await draft.commit();
    this.logger.event("setup: config committed", { selectedPlugins: [...selectedIds] });

    const imports = await this.runImports(pendingImports);
    for (const imported of imports) {
      const report = reports.find((item) => item.source === imported.source);
      if (!report) continue;
      report.archiveImport = imported.ok ? "imported" : "failed";
      if (!imported.ok) report.findings.push(imported.finding);
    }

    const backgroundAgent = request.backgroundAgent ? await this.enableBackgroundAgent(request) : skippedAction("background agent disabled by request");
    const syncHandoff = request.syncHandoff ? syncHandoffAction(backgroundAgent) : skippedAction("background sync handoff disabled by request");
    const finishedAt = new Date();
    const status =
      reports.some((item) => item.status === "degraded" || item.archiveImport === "failed") || !backgroundAgent.ok || !syncHandoff.ok
        ? "warning"
        : "ok";
    const report: SetupReport = {
      status,
      startedAt,
      finishedAt,
      plugins: reports,
      backgroundAgent,
      syncHandoff,
    };
    this.logger.event("setup: finished", {
      status,
      plugins: reports.map((item) => ({ source: item.source, status: item.status, archiveImport: item.archiveImport })),
      backgroundAgent,
      syncHandoff,
    });
    await this.ui.note({ title: "Setup complete", body: setupSummaryText(report) });
    return report;
  }

  private async selectPlugins(draft: ConfigDraft): Promise<TracePlugin[]> {
    const plugins = this.registry.list();
    const initialValues = plugins.filter((plugin) => draft.pluginConfig(plugin.manifest.id).enabled !== false).map((plugin) => plugin.manifest.id);
    const selectedIds = await this.ui.multiselect<SourceId>({
      title: "Choose plugins to enable",
      options: plugins.map((plugin) => ({
        label: plugin.manifest.displayName,
        value: plugin.manifest.id,
        hint: plugin.manifest.collections.join(", "),
      })),
      initialValues,
    });
    const selected = new Set(selectedIds);
    return plugins.filter((plugin) => selected.has(plugin.manifest.id));
  }

  private async setupPlugin(plugin: TracePlugin, ctx: PluginSetupContext): Promise<PluginSetupOutcome> {
    const source = plugin.manifest.id;
    const started = new Date();
    this.logger.event("setup: plugin started", { source });
    try {
      const { report, summary } = await this.withPluginSetupDeadline(plugin, ctx, async (deadlineCtx) => {
        const summary = await pluginSummary(plugin, deadlineCtx);
        await this.ui.note({ title: summary.title, body: summary.body });
        const setupFindings = plugin.setup ? (await plugin.setup.run(deadlineCtx)).findings ?? [] : [];
        const verifyFindings = plugin.setup ? await plugin.setup.verify(deadlineCtx) : await this.defaultVerify(plugin, deadlineCtx.signal);
        const findings = [...setupFindings, ...verifyFindings];
        const degraded = findings.some((finding) => finding.level === "critical");
        const status: SetupPluginReport["status"] = degraded ? "degraded" : "ready";
        const archiveImport: SetupPluginReport["archiveImport"] = summary.archiveImport ? "skipped" : "unavailable";
        return {
          summary,
          report: {
            source,
            displayName: plugin.manifest.displayName,
            status,
            findings,
            archiveImport,
            importCommand: summary.archiveImport?.laterCommand ?? null,
          },
        };
      });
      this.logger.event("setup: plugin finished", {
        source,
        status: report.status,
        durationMs: Date.now() - started.getTime(),
        findingCount: report.findings.length,
      });
      return { report, summary };
    } catch (error) {
      const timedOut = error instanceof SetupPluginTimeoutError;
      const finding = makeFinding(
        "critical",
        source,
        timedOut ? "plugin_setup_timeout" : "plugin_setup_failed",
        timedOut ? `${plugin.manifest.displayName} setup timed out` : `${plugin.manifest.displayName} setup failed`,
        timedOut ? { timeoutMs: error.timeoutMs } : { error: String(error) },
      );
      this.logger.error("setup: plugin failed", { source, error: String(error) });
      return {
        summary: { title: plugin.manifest.displayName, body: "Setup failed before the plugin could finish." },
        report: {
          source,
          displayName: plugin.manifest.displayName,
          status: "degraded",
          findings: [finding],
          archiveImport: "unavailable",
          importCommand: null,
        },
      };
    }
  }

  private async defaultVerify(plugin: TracePlugin, signal: AbortSignal): Promise<HealthFinding[]> {
    const ctx = pluginRuntimeContext(this.config, plugin, this.logger, signal);
    return plugin.check(ctx);
  }

  private async withPluginSetupDeadline<T>(
    plugin: TracePlugin,
    ctx: PluginSetupContext,
    run: (ctx: PluginSetupContext) => Promise<T>,
  ): Promise<T> {
    const timeoutMs = Math.max(1, Math.trunc(this.setupPluginTimeoutMs));
    const timeoutController = new AbortController();
    const timeoutError = new SetupPluginTimeoutError(plugin.manifest.id, timeoutMs);
    const timeout = setTimeout(() => timeoutController.abort(timeoutError), timeoutMs);
    const deadlineCtx: PluginSetupContext = { ...ctx, signal: timeoutController.signal };
    try {
      return await Promise.race([
        run(deadlineCtx),
        new Promise<never>((_, reject) => {
          timeoutController.signal.addEventListener("abort", () => reject(timeoutError), { once: true });
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }

  private pluginSetupContext(
    plugin: TracePlugin,
    draft: ConfigDraft,
    secrets: PluginSetupContext["secrets"],
    signal: AbortSignal,
  ): PluginSetupContext {
    return {
      root: this.config.root,
      pluginId: plugin.manifest.id,
      ui: this.ui,
      config: draft,
      secrets,
      host: this.host,
      logger: this.logger,
      signal,
      now: () => new Date(),
    };
  }

  private async offerArchiveImport(offer: PluginArchiveImportOffer): Promise<string | null> {
    const importNow = await this.ui.confirm({
      title: offer.title,
      body: `${offer.body}\n\nIf you do not have it yet, run this later:\n${offer.laterCommand}`,
      initialValue: false,
    });
    if (!importNow) {
      await this.ui.note({ title: "Import later", body: offer.laterCommand });
      return null;
    }
    const selected = await this.host.chooseFile({ title: offer.title, allowedExtensions: offer.allowedExtensions });
    if (!selected) {
      const fallback = await this.ui.text({ title: "Archive path", placeholder: "/path/to/export.zip" });
      return fallback.trim() || null;
    }
    return selected;
  }

  private async runImports(imports: PendingImport[]): Promise<Array<{ source: SourceId; ok: true } | { source: SourceId; ok: false; finding: HealthFinding }>> {
    const output: Array<{ source: SourceId; ok: true } | { source: SourceId; ok: false; finding: HealthFinding }> = [];
    if (!imports.length) return output;
    const runtime = new TraceRuntime({ root: this.config.root, configPath: this.config.path, registry: this.registry });
    try {
      for (const item of imports) {
        try {
          await runtime.importProviderExport({
            source: item.source,
            path: item.path,
            dryRun: false,
            budget: DEFAULT_SYNC_BUDGET,
          });
          output.push({ source: item.source, ok: true });
        } catch (error) {
          output.push({
            source: item.source,
            ok: false,
            finding: makeFinding("critical", item.source, "setup_archive_import_failed", `${item.source} archive import failed`, {
              path: item.path,
              error: String(error),
            }),
          });
        }
      }
    } finally {
      await runtime.close();
    }
    return output;
  }

  private async enableBackgroundAgent(request: SetupRequest): Promise<SetupReport["backgroundAgent"]> {
    const appPath = ensureStableAppPath(this.config);
    const executable = appExecutable(appPath);
    if (!existsSync(executable)) return { attempted: true, ok: false, message: "Nutshell.app is not installed", detail: { appPath } };
    const permission = await this.ensureAppPermission(appPath, executable);
    if (permission.status.backgroundSync === "enabled" && permission.status.agent === "enabled") {
      return {
        attempted: true,
        ok: true,
        message: "background agent enabled",
        detail: { permissionSetup: permission.setup ? jsonRunResult(permission.setup) : null, status: appStatusJson(permission.status) },
      };
    }
    if (permission.status.fullDiskAccess !== "granted") {
      return {
        attempted: true,
        ok: false,
        message: "Full Disk Access is required before background sync can be enabled",
        detail: { permissionSetup: permission.setup ? jsonRunResult(permission.setup) : null, status: appStatusJson(permission.status) },
      };
    }
    const confirmed = request.assumeYes
      ? true
      : await this.ui.confirm({
          title: "Do you want to enable the background service now?",
          body: "Nutshell can keep syncing in the background using the permissions you just granted.",
          initialValue: true,
        });
    if (!confirmed) {
      return {
        attempted: true,
        ok: true,
        message: "background service left disabled by user choice",
        detail: { permissionSetup: permission.setup ? jsonRunResult(permission.setup) : null, status: appStatusJson(permission.status) },
      };
    }
    const enable = await this.host.run({ command: executable, args: ["enable-sync"], timeoutMs: 30_000 });
    const register = await this.host.run({ command: executable, args: ["register-agent"], timeoutMs: 30_000 });
    const status = await inspectNutshellApp(this.config, appPath);
    const ok = register.code === 0 && enable.code === 0;
    return {
      attempted: true,
      ok,
      message: ok ? "background agent enabled" : "background agent enablement failed",
      detail: { register: jsonRunResult(register), enable: jsonRunResult(enable), status: appStatusJson(status) },
    };
  }

  private async ensureAppPermission(
    appPath: string,
    executable: string,
  ): Promise<{ status: Awaited<ReturnType<typeof inspectNutshellApp>>; setup: { code: number; stdout: string; stderr: string } | null }> {
    let status = await inspectNutshellApp(this.config, appPath);
    if (status.fullDiskAccess === "granted") return { status, setup: null };
    await this.ui.note({
      title: "macOS permission required",
      body:
        "Nutshell.app needs Full Disk Access before background sync can read protected local data. The Nutshell setup window will open now. Grant access there, then return here to continue.",
    });
    const setup = process.platform === "darwin"
      ? await this.host.run({ command: "/usr/bin/open", args: ["-n", appPath, "--args", "setup"], timeoutMs: 30_000 })
      : await this.host.run({ command: executable, args: ["setup"], timeoutMs: 30_000 });
    if (setup.code !== 0) {
      status = await inspectNutshellApp(this.config, appPath);
      return { status, setup };
    }
    status = await waitForFullDiskAccess(this.config, appPath, 15 * 60_000);
    return { status, setup };
  }
}

async function waitForFullDiskAccess(config: TraceConfig, appPath: string, timeoutMs: number): Promise<Awaited<ReturnType<typeof inspectNutshellApp>>> {
  const deadline = Date.now() + timeoutMs;
  let status = await inspectNutshellApp(config, appPath);
  while (status.fullDiskAccess !== "granted" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    status = await inspectNutshellApp(config, appPath);
  }
  return status;
}

function skippedAction(message: string): SetupReport["backgroundAgent"] {
  return { attempted: false, ok: true, message, detail: {} };
}

function syncHandoffAction(backgroundAgent: SetupReport["backgroundAgent"]): SetupReport["syncHandoff"] {
  if (backgroundAgent.message === "background service left disabled by user choice") {
    return {
      attempted: false,
      ok: true,
      message: "initial sync not scheduled; background service was not enabled",
      detail: { reason: "background service was not enabled" },
    };
  }
  return {
    attempted: false,
    ok: true,
    message: "initial sync handed off to background agent",
    detail: { reason: "setup runs bounded plugin checks only; ingestion happens after setup" },
  };
}

function jsonRunResult(result: { code: number; stdout: string; stderr: string }): JsonObject {
  return {
    code: result.code,
    stdout: redactText(result.stdout),
    stderr: redactText(result.stderr),
  };
}

async function pluginSummary(plugin: TracePlugin, ctx: PluginSetupContext): Promise<PluginSetupSummary> {
  if (plugin.setup) return plugin.setup.summarize(ctx);
  return {
    title: plugin.manifest.displayName,
    body: "This plugin has no interactive setup. Nutshell will run its health probe.",
  };
}

function pluginRuntimeContext(config: TraceConfig, plugin: TracePlugin, logger: JsonlLogger, signal: AbortSignal): PluginContext {
  return {
    root: config.root,
    config: pluginConfig(config, plugin.manifest.id),
    logger,
    signal,
    now: () => new Date(),
    records: {
      query: async () => ({ records: [], total: 0, limit: 0, offset: 0 }),
    },
    writeArtifact: async () => {
      throw new Error("setup verification cannot write artifacts");
    },
  };
}

function setupSummaryText(report: SetupReport): string {
  const ready = report.plugins.filter((item) => item.status === "ready").map((item) => item.displayName);
  const degraded = report.plugins.filter((item) => item.status === "degraded").map((item) => item.displayName);
  const disabled = report.plugins.filter((item) => item.status === "disabled").map((item) => item.displayName);
  return [
    ready.length ? `Ready: ${ready.join(", ")}` : "Ready: none",
    degraded.length ? `Degraded: ${degraded.join(", ")}` : "Degraded: none",
    disabled.length ? `Disabled: ${disabled.join(", ")}` : "Disabled: none",
    `Background: ${report.backgroundAgent.message}`,
    `Sync: ${report.syncHandoff.message}`,
  ].join("\n");
}

export function exitCodeForSetup(report: SetupReport): number {
  if (report.status === "critical") return 2;
  if (report.status === "warning") return 1;
  return 0;
}

export function setupStatusFromFindings(findings: HealthFinding[]): SetupReport["status"] {
  return healthReportStatus(findings);
}

function setupPluginTimeoutMs(config: TraceConfig): number {
  return numberAt(objectAt(config.data, "runtime"), "setupPluginTimeoutMs", 5 * 60_000);
}

class SetupPluginTimeoutError extends Error {
  constructor(
    readonly source: SourceId,
    readonly timeoutMs: number,
  ) {
    super(`${source} setup timed out after ${timeoutMs}ms`);
  }
}
