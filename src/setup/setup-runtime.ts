import { existsSync } from "node:fs";
import type { HealthFinding, JsonObject, SourceId, UserState } from "../core/types";
import { DEFAULT_SYNC_BUDGET } from "../config/defaults";
import { loadConfig, logPath, numberAt, objectAt, resolveConfigPath, resolveRoot, storePath, type TraceConfig } from "../config/config";
import { CLI_NAME, PRODUCT_NAME } from "../core/product";
import { backfillStatusFromStore } from "../health/checks";
import { reportStatus as healthReportStatus } from "../health/health";
import { setupFinding } from "./setup-findings";
import { appExecutable, ensureStableAppPath, runNutshellAppCommand } from "../macos/app-status";
import { loadBuiltinPlugins, type PluginRegistry } from "../plugins/registry";
import type { TracePlugin } from "../plugins/interface";
import { redactText } from "../core/redaction";
import { JsonlLogger } from "../runtime/logger";
import { TraceRuntime } from "../runtime/trace-runtime";
import { openStore } from "../store/sqlite-store";
import { JsonConfigDraft } from "./config-draft";
import { defaultSecretStore, type FileSecretStore } from "./secret-store";
import { DefaultHostCapabilities } from "./host";
import { DefaultSetupProber, type SetupProber } from "./probe";
import { ClackSetupUI } from "./ui-clack";
import type {
  ConfigDraft,
  HostCapabilities,
  MacAppStatus,
  PluginArchiveImportOffer,
  PluginSetupContext,
  PluginSetupSummary,
  SetupPluginReport,
  SetupReport,
  SetupRequest,
  SetupUI,
} from "./types";

// Runs a Nutshell.app helper command through the app identity. Defaults to
// the real app bridge; tests inject a scripted runner.
export type AppCommandRunner = (appPath: string, args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }>;

export interface SetupRuntimeOptions {
  root?: string;
  configPath?: string;
  config?: TraceConfig;
  registry?: PluginRegistry;
  ui?: SetupUI;
  host?: HostCapabilities;
  secretStore?: FileSecretStore;
  prober?: SetupProber;
  appCommandRunner?: AppCommandRunner;
  setupPluginTimeoutMs?: number;
  permissionHandoffTimeoutMs?: number;
}

export const DEFAULT_PERMISSION_HANDOFF_TIMEOUT_MS = 60 * 60_000;

// The smoke sync is bounded twice: the sync itself runs in recent mode with a
// 60s per-source budget, and the app command as a whole is killed after this.
const SMOKE_SYNC_ARGS = ["sync", "all", "--mode", "recent", "--timeout", "60", "--json"];
const SMOKE_SYNC_TIMEOUT_MS = 180_000;

// Humans never hit this; it exists so a misbehaving scripted UI (tests,
// automation) fails loudly instead of spinning forever.
const RUNAWAY_LOOP_LIMIT = 100;

interface PendingImport {
  source: SourceId;
  path: string;
}

interface PluginSetupOutcome {
  report: SetupPluginReport;
  summary: PluginSetupSummary;
}

interface AppPermissionOutcome {
  attempted: boolean;
  status: MacAppStatus | null;
  granted: boolean;
  // true when this run performed the grant flow (window opened), meaning any
  // probe results captured before it are stale.
  changed: boolean;
}

type ReviewAction = "fix" | "change" | "reverify" | "exit";

interface StateReview {
  action: ReviewAction;
  enabled: TracePlugin[];
  failing: TracePlugin[];
  findings: Map<SourceId, HealthFinding[]>;
}

export class SetupRuntime {
  readonly config: TraceConfig;
  readonly registry: PluginRegistry;
  readonly ui: SetupUI;
  readonly host: HostCapabilities;
  readonly logger: JsonlLogger;
  readonly secretStore: FileSecretStore;
  readonly prober: SetupProber;
  readonly appCommandRunner: AppCommandRunner;
  readonly setupPluginTimeoutMs: number;
  readonly permissionHandoffTimeoutMs: number;

  constructor(options: SetupRuntimeOptions = {}) {
    const configPath = options.configPath ?? resolveConfigPath(options.root);
    const root = options.root ? resolveRoot(options.root, configPath) : resolveRoot(undefined, configPath);
    this.config = options.config ?? loadConfig(root, configPath);
    this.registry = options.registry ?? loadBuiltinPlugins();
    this.ui = options.ui ?? new ClackSetupUI();
    this.host = options.host ?? new DefaultHostCapabilities(ensureStableAppPath(this.config));
    this.logger = new JsonlLogger(logPath(this.config));
    this.secretStore = options.secretStore ?? defaultSecretStore(this.config.root);
    this.prober = options.prober ?? new DefaultSetupProber(this.config, this.logger);
    this.appCommandRunner = options.appCommandRunner ?? runNutshellAppCommand;
    this.setupPluginTimeoutMs = options.setupPluginTimeoutMs ?? setupPluginTimeoutMs(this.config);
    this.permissionHandoffTimeoutMs = options.permissionHandoffTimeoutMs ?? permissionHandoffTimeoutMs();
  }

  async run(request: SetupRequest): Promise<SetupReport> {
    const startedAt = new Date();
    const draft = new JsonConfigDraft(this.config);
    const secretDraft = await this.secretStore.draft();
    const controller = new AbortController();
    const reports: SetupPluginReport[] = [];
    const pendingImports: PendingImport[] = [];

    const rerun = this.isRerun(draft);
    this.logger.event("setup: started", { rerun });
    if (!rerun) {
      await this.ui.intro({
        title: `${PRODUCT_NAME} setup`,
        body: `Data root: ${this.config.root}\nConfig: ${this.config.path}`,
      });
    }

    const installedAppPath = ensureStableAppPath(this.config);
    if (existsSync(appExecutable(installedAppPath))) {
      const appConfig = draft.data.app && typeof draft.data.app === "object" && !Array.isArray(draft.data.app) ? (draft.data.app as JsonObject) : {};
      draft.data.app = { ...appConfig, path: installedAppPath };
    }

    // Selection. Re-runs open with a probed status table and only walk through
    // what needs attention; first runs ask which sources to enable. The
    // app/permission step always precedes plugin verification — on re-runs
    // that means before the review probes, so the table shows post-grant truth.
    let toSetup: TracePlugin[];
    let priorFindings = new Map<SourceId, HealthFinding[]>();
    let appPermission: AppPermissionOutcome | null = null;
    if (rerun) {
      appPermission = await this.prepareAppPermission(request);
      const review = await this.reviewCurrentState(draft, controller.signal);
      priorFindings = review.findings;
      if (review.action === "exit") {
        return this.finishAtReview(startedAt, draft, secretDraft, review);
      }
      if (review.action === "change") {
        toSetup = await this.selectPlugins(draft);
        priorFindings = new Map();
      } else if (review.action === "reverify") {
        toSetup = review.enabled;
        priorFindings = new Map();
      } else {
        toSetup = review.failing;
        for (const plugin of review.enabled) {
          if (review.failing.includes(plugin)) continue;
          const findings = review.findings.get(plugin.manifest.id) ?? [];
          draft.setPluginSetupStatus(plugin.manifest.id, "ready", findings);
          reports.push(this.pluginReport(plugin, "ready", findings));
        }
      }
    } else {
      toSetup = await this.selectPlugins(draft);
    }

    const setupIds = new Set(toSetup.map((plugin) => plugin.manifest.id));
    for (const plugin of this.registry.list()) {
      const enabled = setupIds.has(plugin.manifest.id) || reports.some((report) => report.source === plugin.manifest.id && report.status !== "disabled");
      draft.setPluginEnabled(plugin.manifest.id, enabled);
      if (!enabled) {
        reports.push(this.pluginReport(plugin, "disabled", []));
      }
    }

    // First runs reach the app/permission step here, after source selection
    // and before any plugin verification.
    appPermission ??= await this.prepareAppPermission(request);

    // Already-imported archives render "imported" and are not re-offered. Read
    // and release the store before any offers run — the import path opens its
    // own runtime and needs the database lock free.
    const importedArchives = await this.completedArchiveImports(toSetup);

    for (const plugin of toSetup) {
      const ctx = this.pluginSetupContext(plugin, draft, secretDraft.plugin(plugin.manifest.id), controller.signal);
      const { report, summary } = await this.setupPlugin(plugin, ctx, priorFindings.get(plugin.manifest.id));
      reports.push(report);
      draft.setPluginSetupStatus(plugin.manifest.id, report.status, report.findings);
      if (report.status === "ready" && report.importCommand && plugin.importProviderExport) {
        if (importedArchives.has(plugin.manifest.id)) {
          report.archiveImport = "imported";
          this.logger.event("setup: archive already imported", { source: plugin.manifest.id });
        } else {
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
    }

    await secretDraft.commit();
    await draft.commit();
    this.logger.event("setup: config committed", { setupPlugins: [...setupIds] });

    const imports = await this.runImports(pendingImports);
    for (const imported of imports) {
      const report = reports.find((item) => item.source === imported.source);
      if (!report) continue;
      report.archiveImport = imported.ok ? "imported" : "failed";
      if (!imported.ok) report.findings.push(imported.finding);
    }

    const backgroundAgent = request.backgroundAgent
      ? await this.enableBackgroundAgent(request, appPermission)
      : skippedAction("background agent disabled by request");
    const syncHandoff = request.syncHandoff ? await this.handOffInitialSync(backgroundAgent) : skippedAction("background sync handoff disabled by request");
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
    await this.ui.note({ title: "Setup complete", body: formatSetupSummaryText(report) });
    return report;
  }

  private isRerun(draft: ConfigDraft): boolean {
    return this.registry.list().some((plugin) => {
      const setup = draft.pluginConfig(plugin.manifest.id).setup;
      return Boolean(setup && typeof setup === "object" && !Array.isArray(setup) && typeof (setup as JsonObject).status === "string");
    });
  }

  // Re-run entry: probe every enabled source so the table shows current truth,
  // then let the user fix what fails, change sources, or leave.
  private async reviewCurrentState(draft: ConfigDraft, signal: AbortSignal): Promise<StateReview> {
    const enabled = this.registry.list().filter((plugin) => draft.pluginConfig(plugin.manifest.id).enabled !== false);
    const findings = new Map<SourceId, HealthFinding[]>();
    for (const plugin of enabled) {
      findings.set(plugin.manifest.id, await this.runProbe(plugin, signal));
    }
    const failing = enabled.filter((plugin) => hasCritical(findings.get(plugin.manifest.id) ?? []));
    const working = enabled.length - failing.length;
    const lines = enabled.map((plugin) => {
      const pluginFindings = findings.get(plugin.manifest.id) ?? [];
      const ok = !hasCritical(pluginFindings);
      return `${ok ? "✓" : "✗"} ${plugin.manifest.displayName} — ${stateWord(pluginFindings)}`;
    });
    await this.ui.note({
      title: `${working} of ${enabled.length} ${enabled.length === 1 ? "source" : "sources"} working`,
      body: lines.join("\n") || "No sources are enabled yet.",
    });

    const options: Array<{ label: string; value: ReviewAction; hint?: string }> = [];
    if (failing.length) {
      const names = failing.map((plugin) => plugin.manifest.displayName).join(", ");
      options.push({ label: `Fix ${names} now`, value: "fix" });
    } else if (enabled.length) {
      options.push({ label: "Finish — everything is verified", value: "exit" });
    }
    options.push({ label: "Change which sources are enabled", value: "change" });
    if (!failing.length && enabled.length) {
      options.push({ label: "Re-verify all sources", value: "reverify" });
    }
    if (failing.length) {
      options.push({ label: "Exit — leave everything as is", value: "exit", hint: `come back anytime with: ${CLI_NAME} setup` });
    }
    if (!enabled.length) {
      return { action: "change", enabled, failing, findings };
    }
    const action = await this.ui.select<ReviewAction>({ title: "What do you want to do?", options });
    return { action, enabled, failing, findings };
  }

  private async finishAtReview(
    startedAt: Date,
    draft: JsonConfigDraft,
    secretDraft: Awaited<ReturnType<FileSecretStore["draft"]>>,
    review: StateReview,
  ): Promise<SetupReport> {
    const reports: SetupPluginReport[] = [];
    for (const plugin of this.registry.list()) {
      if (review.enabled.includes(plugin)) {
        const findings = review.findings.get(plugin.manifest.id) ?? [];
        const status = hasCritical(findings) ? "degraded" : "ready";
        draft.setPluginSetupStatus(plugin.manifest.id, status, findings);
        reports.push(this.pluginReport(plugin, status, findings));
      } else {
        reports.push(this.pluginReport(plugin, "disabled", []));
      }
    }
    await secretDraft.commit();
    await draft.commit();
    const backgroundAgent = skippedAction("not changed at the status review");
    const report: SetupReport = {
      status: reports.some((item) => item.status === "degraded") ? "warning" : "ok",
      startedAt,
      finishedAt: new Date(),
      plugins: reports,
      backgroundAgent,
      syncHandoff: skippedAction("not changed at the status review"),
    };
    this.logger.event("setup: finished at review", {
      status: report.status,
      plugins: reports.map((item) => ({ source: item.source, status: item.status })),
    });
    await this.ui.note({ title: "Status recorded", body: formatSetupSummaryText(report) });
    return report;
  }

  private pluginReport(plugin: TracePlugin, status: SetupPluginReport["status"], findings: HealthFinding[]): SetupPluginReport {
    return {
      source: plugin.manifest.id,
      displayName: plugin.manifest.displayName,
      status,
      findings,
      archiveImport: "unavailable",
      importCommand: null,
    };
  }

  private async selectPlugins(draft: ConfigDraft): Promise<TracePlugin[]> {
    const plugins = this.registry.list();
    const initialValues = plugins.filter((plugin) => draft.pluginConfig(plugin.manifest.id).enabled !== false).map((plugin) => plugin.manifest.id);
    const selectedIds = await this.ui.multiselect<SourceId>({
      title: `Choose which sources ${PRODUCT_NAME} should sync`,
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

  private async setupPlugin(plugin: TracePlugin, ctx: PluginSetupContext, prior?: HealthFinding[]): Promise<PluginSetupOutcome> {
    const source = plugin.manifest.id;
    const started = new Date();
    this.logger.event("setup: plugin started", { source });
    let summary: PluginSetupSummary;
    try {
      summary = await pluginSummary(plugin, ctx);
    } catch (error) {
      summary = { title: plugin.manifest.displayName, body: "" };
      this.logger.error("setup: plugin summary failed", { source, error: String(error) });
    }
    if (summary.body) await this.ui.note({ title: summary.title, body: summary.body });

    let findings: HealthFinding[];
    try {
      const custom = plugin.setup?.run
        ? await this.withPluginSetupDeadline(plugin, ctx, (deadlineCtx) => plugin.setup!.run!(deadlineCtx))
        : { findings: [] };
      findings = await this.probeLoop(plugin, ctx, prior, custom.findings ?? []);
    } catch (error) {
      const timedOut = error instanceof SetupPluginTimeoutError;
      findings = [
        timedOut
          ? setupFinding("plugin_setup_timeout", source, `${plugin.manifest.displayName} setup timed out`, { timeoutMs: error.timeoutMs })
          : setupFinding("plugin_setup_failed", source, `${plugin.manifest.displayName} setup failed`, { error: String(error) }),
      ];
      this.logger.error("setup: plugin failed", { source, error: String(error) });
    }

    const status: SetupPluginReport["status"] = hasCritical(findings) ? "degraded" : "ready";
    const archiveImport: SetupPluginReport["archiveImport"] = summary.archiveImport ? "skipped" : "unavailable";
    const report: SetupPluginReport = {
      source,
      displayName: plugin.manifest.displayName,
      status,
      findings,
      archiveImport,
      importCommand: summary.archiveImport?.laterCommand ?? null,
    };
    this.logger.event("setup: plugin finished", {
      source,
      status: report.status,
      durationMs: Date.now() - started.getTime(),
      findingCount: report.findings.length,
    });
    return { report, summary };
  }

  // One loop, three verbs: probe, then on a critical finding offer retry
  // (optionally opening the page that fixes it) or skip. The user drives the
  // loop; nothing polls and nothing times out while they think.
  private async probeLoop(plugin: TracePlugin, ctx: PluginSetupContext, prior?: HealthFinding[], baseline: HealthFinding[] = []): Promise<HealthFinding[]> {
    // baseline carries findings from the plugin's custom setup step; the loop
    // evaluates them together with probe results so "verified" is never shown
    // while a custom-step failure stands (retrying the probe cannot clear it).
    let probeFindings = prior ?? (await this.runProbe(plugin, ctx.signal, ctx));
    for (let iteration = 0; ; iteration += 1) {
      if (iteration >= RUNAWAY_LOOP_LIMIT) throw new Error(`${plugin.manifest.id} setup retry loop exceeded ${RUNAWAY_LOOP_LIMIT} iterations; a scripted UI is misbehaving`);
      const findings = [...baseline, ...probeFindings];
      const problems = findings.filter((finding) => finding.level === "critical");
      if (!problems.length) {
        await this.ui.note({ title: plugin.manifest.displayName, body: `✓ ${plugin.manifest.displayName} verified` });
        return findings;
      }
      const lead = problems[0]!;
      // Title names the state ("not signed in" / "needs permission" / …) so the
      // user knows what kind of problem this is at a glance. Body is the
      // problem in plain words, then the one action. The confirm command is
      // omitted here — Retry below IS the check; the command belongs on the
      // non-interactive surfaces (doctor/health) instead.
      const body = lead.guidance ? `${lead.message}\n\nFix: ${lead.guidance.fix}` : lead.message;
      await this.ui.note({ title: `${plugin.manifest.displayName} — ${stateWord([lead])}`, body });

      type Choice = "open" | "retry" | "skip";
      const url = lead.guidance?.url;
      const options: Array<{ label: string; value: Choice; hint?: string }> = [
        ...(url ? [{ label: `Open ${displayUrl(url)} and retry`, value: "open" as Choice }] : []),
        { label: "Retry", value: "retry" as Choice },
        { label: "Skip for now", value: "skip" as Choice, hint: `finish later with: ${CLI_NAME} setup` },
      ];
      const choice = await this.ui.select<Choice>({ title: "What do you want to do?", options });
      if (choice === "skip") {
        this.logger.event("setup: plugin skipped by user", { source: plugin.manifest.id, code: lead.code });
        return findings;
      }
      if (choice === "open" && url) await this.host.openUrl(url);
      probeFindings = await this.runProbe(plugin, ctx.signal, ctx);
    }
  }

  private async runProbe(plugin: TracePlugin, signal: AbortSignal, ctx?: PluginSetupContext): Promise<HealthFinding[]> {
    const source = plugin.manifest.id;
    try {
      return await this.ui.spinner({
        title: `Checking ${plugin.manifest.displayName}`,
        run: () =>
          this.withProbeDeadline(source, async (deadlineSignal) => {
            if (plugin.setup?.verify && ctx) return plugin.setup.verify({ ...ctx, signal: deadlineSignal });
            return this.prober.probe(plugin, deadlineSignal);
          }),
      });
    } catch (error) {
      if (error instanceof SetupPluginTimeoutError) {
        return [setupFinding("plugin_setup_timeout", source, `${plugin.manifest.displayName} verification timed out`, { timeoutMs: error.timeoutMs })];
      }
      return [setupFinding("plugin_setup_failed", source, `${plugin.manifest.displayName} verification failed`, { error: String(error) })];
    }
  }

  private async withProbeDeadline<T>(source: SourceId, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const timeoutMs = Math.max(1, Math.trunc(this.setupPluginTimeoutMs));
    const timeoutController = new AbortController();
    const timeoutError = new SetupPluginTimeoutError(source, timeoutMs);
    const timeout = setTimeout(() => timeoutController.abort(timeoutError), timeoutMs);
    try {
      return await Promise.race([
        run(timeoutController.signal),
        new Promise<never>((_, reject) => {
          timeoutController.signal.addEventListener("abort", () => reject(timeoutError), { once: true });
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
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

  // Full Disk Access handoff, before plugin verification. Interactive runs use
  // a user-driven check loop (no polling while the user reads instructions);
  // --yes runs keep the bounded poll for unattended automation.
  private async prepareAppPermission(request: SetupRequest): Promise<AppPermissionOutcome> {
    const macos = this.host.macos;
    if (!macos) return { attempted: false, status: null, granted: false, changed: false };
    let status: MacAppStatus;
    try {
      status = await macos.appStatus();
    } catch (error) {
      this.logger.error("setup: app status failed", { error: String(error) });
      return { attempted: true, status: null, granted: false, changed: false };
    }
    if (!status.installed) {
      await this.ui.note({
        title: `${PRODUCT_NAME}.app is not installed`,
        body: `Protected sources cannot be verified until ${PRODUCT_NAME}.app is installed. Reinstall ${PRODUCT_NAME} (brew reinstall nutshell or the tarball installer), then rerun ${CLI_NAME} setup.`,
      });
      return { attempted: true, status, granted: false, changed: false };
    }
    if (status.fullDiskAccess === "granted") {
      return { attempted: true, status, granted: true, changed: false };
    }
    await this.ui.note({
      title: "macOS permission required",
      body: `${PRODUCT_NAME}.app needs Full Disk Access to read protected local data (Podcasts, browser sessions, Notes). The ${PRODUCT_NAME} window will open now — grant access there, then return here.`,
    });
    await macos.showNutshellPermissionWindow();
    if (request.assumeYes) {
      status = await this.waitForFullDiskAccess(macos);
      return { attempted: true, status, granted: status.fullDiskAccess === "granted", changed: true };
    }
    for (let iteration = 0; ; iteration += 1) {
      if (iteration >= RUNAWAY_LOOP_LIMIT) throw new Error(`permission check loop exceeded ${RUNAWAY_LOOP_LIMIT} iterations; a scripted UI is misbehaving`);
      const choice = await this.ui.select<"check" | "skip">({
        title: "Grant Full Disk Access in the Nutshell window, then continue.",
        options: [
          { label: "I granted it — check again", value: "check" },
          { label: "Skip for now", value: "skip", hint: "protected sources will stay unverified" },
        ],
      });
      if (choice === "skip") break;
      status = await this.ui.spinner({ title: "Checking Full Disk Access", run: () => macos.appStatus() });
      if (status.fullDiskAccess === "granted") {
        await this.ui.note({ title: "Full Disk Access", body: "✓ Full Disk Access granted" });
        break;
      }
      await this.ui.note({
        title: "Not granted yet",
        body: `Full Disk Access is still missing for ${PRODUCT_NAME}.app. In the ${PRODUCT_NAME} window, drag the app icon into the Full Disk Access list and turn its switch on.`,
      });
    }
    return { attempted: true, status, granted: status.fullDiskAccess === "granted", changed: true };
  }

  private async waitForFullDiskAccess(macos: NonNullable<HostCapabilities["macos"]>): Promise<MacAppStatus> {
    const deadline = Date.now() + this.permissionHandoffTimeoutMs;
    let status = await macos.appStatus();
    while (status.fullDiskAccess !== "granted" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      status = await macos.appStatus();
    }
    return status;
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

  // Sources whose official provider export already covers the configured
  // cutoff. Their archive offers are answered by the store, not the user. A
  // missing store is a normal first run; a store that cannot be read is
  // treated the same way (offer again — imports stay idempotent) with a
  // warning in the log.
  private async completedArchiveImports(plugins: TracePlugin[]): Promise<Set<SourceId>> {
    const sources = plugins.filter((plugin) => plugin.importProviderExport).map((plugin) => plugin.manifest.id);
    if (!sources.length) return new Set();
    const path = storePath(this.config);
    if (!existsSync(path)) return new Set();
    try {
      const store = openStore(path);
      try {
        const items = await backfillStatusFromStore(this.config, store, sources);
        return new Set(items.filter((item) => item.bulkBackfill.status === "complete").map((item) => item.source));
      } finally {
        await store.close();
      }
    } catch (error) {
      this.logger.warn("setup: could not read archive import status; offering imports again", { path, error: String(error) });
      return new Set();
    }
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
            finding: setupFinding("setup_archive_import_failed", item.source, `${item.source} archive import failed`, {
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

  private async enableBackgroundAgent(request: SetupRequest, permission: AppPermissionOutcome): Promise<SetupReport["backgroundAgent"]> {
    const appPath = ensureStableAppPath(this.config);
    const executable = appExecutable(appPath);
    if (!existsSync(executable)) return { attempted: true, ok: false, message: `${PRODUCT_NAME}.app is not installed`, detail: { appPath } };
    const status = permission.status;
    if (status && status.backgroundSync === "enabled" && status.agent === "enabled") {
      return {
        attempted: true,
        ok: true,
        message: "background agent enabled",
        detail: { status: macStatusJson(status) },
      };
    }
    if (!permission.granted) {
      return {
        attempted: true,
        ok: false,
        message: "Full Disk Access is required before background sync can be enabled",
        detail: { status: status ? macStatusJson(status) : null },
      };
    }
    const confirmed = request.assumeYes
      ? true
      : await this.ui.confirm({
          title: "Do you want to enable the background service now?",
          body: `${PRODUCT_NAME} can keep syncing in the background using the permissions you just granted.`,
          initialValue: true,
        });
    if (!confirmed) {
      return {
        attempted: true,
        ok: true,
        message: "background service left disabled by user choice",
        detail: { status: status ? macStatusJson(status) : null },
      };
    }
    const enable = await this.host.run({ command: executable, args: ["enable-sync"], timeoutMs: 30_000 });
    const register = await this.host.run({ command: executable, args: ["register-agent"], timeoutMs: 30_000 });
    const finalStatus = this.host.macos ? await this.host.macos.appStatus() : null;
    const ok = register.code === 0 && enable.code === 0 && finalStatus?.agent === "enabled" && finalStatus?.backgroundSync === "enabled";
    return {
      attempted: true,
      ok,
      message: ok ? "background agent enabled" : "background agent enablement failed",
      detail: { register: jsonRunResult(register), enable: jsonRunResult(enable), status: finalStatus ? macStatusJson(finalStatus) : null },
    };
  }

  // The smoke sync only runs once the background agent is proven enabled;
  // everything else gets an honest non-attempt message.
  private async handOffInitialSync(backgroundAgent: SetupReport["backgroundAgent"]): Promise<SetupReport["syncHandoff"]> {
    if (!backgroundAgent.ok) {
      return {
        attempted: false,
        ok: false,
        message: "initial sync not handed off; background agent is not enabled",
        detail: { reason: backgroundAgent.message, backgroundAgent: backgroundAgent.detail },
      };
    }
    if (backgroundAgent.message !== "background agent enabled") {
      return {
        attempted: false,
        ok: true,
        message: "initial sync not scheduled; background service was not enabled",
        detail: { reason: backgroundAgent.message },
      };
    }
    return this.runSmokeSync();
  }

  // One bounded smoke sync through the app identity. It proves the enabled
  // agent can actually ingest; it never grows into full ingestion (recent
  // mode, per-source budget, hard app-command timeout).
  private async runSmokeSync(): Promise<SetupReport["syncHandoff"]> {
    const appPath = ensureStableAppPath(this.config);
    this.logger.event("setup: smoke sync started", { appPath });
    let result: { code: number; stdout: string; stderr: string; timedOut: boolean };
    try {
      result = await this.ui.spinner({
        title: "Running a quick first sync",
        run: () => this.appCommandRunner(appPath, [...SMOKE_SYNC_ARGS], SMOKE_SYNC_TIMEOUT_MS),
      });
    } catch (error) {
      this.logger.error("setup: smoke sync failed to run", { error: String(error) });
      return { attempted: true, ok: false, message: "smoke sync failed to run", detail: { error: redactText(String(error)) } };
    }
    const parsed = result.timedOut ? null : parseSmokeSyncReport(result.stdout);
    if (!parsed) {
      this.logger.error("setup: smoke sync failed to run", { code: result.code, timedOut: result.timedOut });
      return {
        attempted: true,
        ok: false,
        message: "smoke sync failed to run",
        detail: {
          code: result.code,
          timedOut: result.timedOut,
          stderr: redactText(result.stderr.slice(-800)),
          stdout: redactText(result.stdout.slice(-400)),
        },
      };
    }
    const ok = parsed.status !== "critical";
    const records = parsed.sources.reduce((sum, source) => sum + source.insertedRecords, 0);
    const firstCritical = parsed.sources.find((source) => source.status === "critical")?.source;
    const message = ok
      ? `smoke sync ok: ${records} ${records === 1 ? "record" : "records"} across ${parsed.sources.length} ${parsed.sources.length === 1 ? "source" : "sources"}`
      : `smoke sync critical: ${firstCritical ?? "no source completed"}`;
    this.logger.event("setup: smoke sync finished", { status: parsed.status, records });
    return {
      attempted: true,
      ok,
      message,
      detail: {
        status: parsed.status,
        sources: parsed.sources.map((source) => ({ source: source.source, status: source.status, insertedRecords: source.insertedRecords })),
      },
    };
  }
}

export function permissionHandoffTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const value = env.NUTSHELL_SETUP_PERMISSION_TIMEOUT_MS;
  if (!value) return DEFAULT_PERMISSION_HANDOFF_TIMEOUT_MS;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PERMISSION_HANDOFF_TIMEOUT_MS;
}

function skippedAction(message: string): SetupReport["backgroundAgent"] {
  return { attempted: false, ok: true, message, detail: {} };
}

interface SmokeSyncSource {
  source: string;
  status: string;
  insertedRecords: number;
}

interface SmokeSyncReport {
  status: string;
  sources: SmokeSyncSource[];
}

// Parses the `sync all --json` report the app prints. Returns null for
// anything that is not a recognizable sync report, so the caller reports an
// honest failure instead of inventing a result.
export function parseSmokeSyncReport(stdout: string): SmokeSyncReport | null {
  const start = stdout.indexOf("{");
  if (start < 0) return null;
  try {
    const parsed = JSON.parse(stdout.slice(start)) as { status?: unknown; sources?: unknown };
    if (typeof parsed.status !== "string" || !Array.isArray(parsed.sources)) return null;
    const sources: SmokeSyncSource[] = [];
    for (const raw of parsed.sources) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
      const record = raw as { source?: unknown; status?: unknown; commit?: unknown };
      if (typeof record.source !== "string" || typeof record.status !== "string") return null;
      const commit = record.commit && typeof record.commit === "object" && !Array.isArray(record.commit) ? (record.commit as { insertedRecords?: unknown }) : null;
      sources.push({
        source: record.source,
        status: record.status,
        insertedRecords: typeof commit?.insertedRecords === "number" ? commit.insertedRecords : 0,
      });
    }
    return { status: parsed.status, sources };
  } catch {
    return null;
  }
}

function jsonRunResult(result: { code: number; stdout: string; stderr: string }): JsonObject {
  return {
    code: result.code,
    stdout: redactText(result.stdout),
    stderr: redactText(result.stderr),
  };
}

function macStatusJson(status: MacAppStatus): JsonObject {
  return {
    installed: status.installed,
    path: status.path,
    fullDiskAccess: status.fullDiskAccess,
    backgroundSync: status.backgroundSync,
    agent: status.agent,
  };
}

async function pluginSummary(plugin: TracePlugin, ctx: PluginSetupContext): Promise<PluginSetupSummary> {
  if (plugin.setup) return plugin.setup.summarize(ctx);
  return {
    title: plugin.manifest.displayName,
    body: `${PRODUCT_NAME} verifies this source with its health probe.`,
  };
}

function hasCritical(findings: HealthFinding[]): boolean {
  return findings.some((finding) => finding.level === "critical");
}

const STATE_WORDS: Record<UserState, string> = {
  not_configured: "not configured",
  needs_auth: "needs login",
  needs_permission: "needs permission",
  ready_empty: "no data found",
  ready_with_data: "verified",
  blocked_bug: "blocked",
};

export function stateWord(findings: HealthFinding[]): string {
  const critical = findings.filter((finding) => finding.level === "critical");
  if (!critical.length) return findings.length ? "verified (with warnings)" : "verified";
  const state = critical.find((finding) => finding.guidance)?.guidance?.state;
  return state ? STATE_WORDS[state] : "needs attention";
}

function displayUrl(url: string): string {
  return url.replace(/^https:\/\/(www\.)?/, "").replace(/\/$/, "");
}

export function formatSetupSummaryText(report: SetupReport): string {
  const lines: string[] = [];
  for (const plugin of report.plugins) {
    if (plugin.status === "disabled") {
      lines.push(`· ${plugin.displayName} — disabled`);
      continue;
    }
    if (plugin.status === "ready") {
      lines.push(`✓ ${plugin.displayName} — verified`);
    } else {
      lines.push(`✗ ${plugin.displayName} — ${stateWord(plugin.findings)}`);
      const lead = plugin.findings.find((finding) => finding.level === "critical") ?? plugin.findings[0];
      if (lead?.guidance) {
        lines.push(`    fix:  ${lead.guidance.fix}`);
        lines.push(`    then: ${lead.guidance.confirm}`);
      }
    }
    if (plugin.archiveImport === "imported") {
      lines.push("    history import complete ✓");
    }
    if (plugin.archiveImport === "skipped" && plugin.importCommand) {
      lines.push(`    history import pending — when your export arrives: ${plugin.importCommand}`);
    }
    if (plugin.archiveImport === "failed") {
      const importFinding = plugin.findings.find((finding) => finding.code === "setup_archive_import_failed");
      if (importFinding?.guidance) {
        lines.push(`    archive import failed — fix: ${importFinding.guidance.fix}`);
      }
    }
  }
  lines.push(`Background: ${report.backgroundAgent.message}`);
  lines.push(`Sync: ${report.syncHandoff.message}`);
  const degraded = report.plugins.some((plugin) => plugin.status === "degraded");
  lines.push(degraded ? `Finish anytime: rerun ${CLI_NAME} setup` : "All selected sources are verified.");
  return lines.join("\n");
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
