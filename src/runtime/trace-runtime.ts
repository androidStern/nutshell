import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type {
  ArtifactRef,
  Checkpoint,
  EnrichmentRequest,
  EnrichmentSourceReport,
  HealthReport,
  HealthScope,
  JsonObject,
  PluginContext,
  ProjectionReport,
  ProjectionRequest,
  ProviderExportImportRequest,
  SyncReport,
  SyncRequest,
  SyncSourceReport,
  TraceQuery,
  RecordPage,
  SyncBudget,
  WriteArtifactInput,
} from "../core/types";
import { sha256, runId } from "../core/ids";
import { DEFAULT_SYNC_BUDGET } from "../config/defaults";
import { booleanAt, loadConfig, logPath, numberAt, objectAt, pluginConfig, storePath, type TraceConfig } from "../config/config";
import { pluginSetupFindings, pluginSetupStatus } from "../setup/config-draft";
import { loadBuiltinPlugins, type PluginRegistry } from "../plugins/registry";
import type { TracePlugin } from "../plugins/interface";
import type { TraceStore } from "../store/interface";
import { openStore } from "../store/sqlite-store";
import { RuntimeLock } from "./lock";
import { JsonlLogger } from "./logger";
import { evaluateHealth } from "../health/checks";
import { renderDailyJson } from "../projections/daily-json";
import { renderDailyMarkdown } from "../projections/daily-markdown";
import { renderDashboardData } from "../projections/dashboard-data";

export interface TraceRuntimeOptions {
  root: string;
  configPath?: string;
  config?: TraceConfig;
  store?: TraceStore;
  registry?: PluginRegistry;
}

export class TraceRuntime {
  readonly config: TraceConfig;
  readonly store: TraceStore;
  readonly registry: PluginRegistry;
  readonly logger: JsonlLogger;

  constructor(options: TraceRuntimeOptions) {
    this.config = options.config ?? loadConfig(options.root, options.configPath);
    this.store = options.store ?? openStore(storePath(this.config));
    this.registry = options.registry ?? loadBuiltinPlugins();
    this.logger = new JsonlLogger(logPath(this.config));
  }

  async sync(request: SyncRequest): Promise<SyncReport> {
    const startedAt = new Date();
    const runtimeCfg = objectAt(this.config.data, "runtime");
    const lock = new RuntimeLock(join(this.config.root, "run.lock"), commandForRequest(request), this.logger, {
      heartbeatMs: typeof runtimeCfg.lockHeartbeatMs === "number" ? runtimeCfg.lockHeartbeatMs : 30_000,
      staleMs: typeof runtimeCfg.staleLockMs === "number" ? runtimeCfg.staleLockMs : 10 * 60_000,
    });
    await lock.acquire();
    try {
      this.logger.event("runtime: sync started", {
        mode: request.mode,
        source: request.source ?? "all",
        collections: request.collections,
      });
      const plugins =
        request.source && request.source !== "all"
          ? [this.registry.get(request.source)]
          : this.registry.enabled(this.config);
      const sources: SyncSourceReport[] = [];
      for (const plugin of plugins) {
        const sourceStarted = new Date();
        const setupStatus = pluginSetupStatus(this.config, plugin.manifest.id);
        if (!request.source && setupStatus === "degraded") {
          const finishedAt = new Date();
          const finding = {
            level: "critical" as const,
            source: plugin.manifest.id,
            code: "plugin_setup_degraded",
            message: `${plugin.manifest.displayName} setup is degraded; skipping scheduled sync until setup or doctor repairs it`,
            detail: { setupFindings: pluginSetupFindings(this.config, plugin.manifest.id) },
            observedAt: finishedAt,
          };
          sources.push({
            source: plugin.manifest.id,
            status: "skipped",
            startedAt: sourceStarted,
            finishedAt,
            durationMs: finishedAt.getTime() - sourceStarted.getTime(),
            findings: [finding],
            metrics: { skipped: true, reason: "plugin_setup_degraded" },
          });
          this.logger.warn("runtime: source skipped", { source: plugin.manifest.id, reason: "plugin_setup_degraded" });
          continue;
        }
        const controller = new AbortController();
        const budget = { ...plugin.manifest.defaultBudget, ...request.budget };
        const timeout = setTimeout(() => controller.abort(new Error("plugin timeout")), budget.maxRuntimeMs);
        let checkpoint: Checkpoint | null = null;
        try {
          checkpoint = await this.store.loadCheckpoint(plugin.manifest.id);
          const ctx: PluginContext = {
            root: this.config.root,
            config: pluginConfig(this.config, plugin.manifest.id),
            logger: this.logger,
            signal: controller.signal,
            now: () => new Date(),
            records: this.pluginRecordReader(),
            writeArtifact: request.dryRun ? dryRunWriteArtifact : (input) => this.writeArtifact(input),
          };
          const result = request.dryRun
            ? await plugin.sync(ctx, { ...request, budget }, checkpoint)
            : await plugin.sync(ctx, { ...request, budget }, checkpoint);
          const commit = request.dryRun
            ? undefined
            : await this.store.commitSync({
                source: plugin.manifest.id,
                run: {
                  id: runId(plugin.manifest.id),
                  command: commandForRequest(request),
                  mode: request.mode,
                  startedAt: sourceStarted,
                },
                result,
                expectedCheckpointVersion: checkpoint.version,
              });
          const finishedAt = new Date();
          const sourceReport: SyncSourceReport = {
            source: plugin.manifest.id,
            status: sourceStatus(result.health, result.partial),
            startedAt: sourceStarted,
            finishedAt,
            durationMs: finishedAt.getTime() - sourceStarted.getTime(),
            commit,
            findings: result.health,
            metrics: result.metrics,
          };
          this.logger.event("runtime: source finished", {
            source: plugin.manifest.id,
            status: sourceReport.status,
            durationMs: sourceReport.durationMs,
            metrics: result.metrics as JsonObject,
          });
          const enrichment = await this.runAutomaticEnrichment(plugin, request, sourceReport);
          if (enrichment) sourceReport.enrichment = enrichment;
          sources.push(sourceReport);
        } catch (error) {
          const finishedAt = new Date();
          const finding = {
            level: "critical" as const,
            source: plugin.manifest.id,
            code: "plugin_runtime_error",
            message: `${plugin.manifest.id} failed before commit`,
            detail: { error: String(error) },
            observedAt: finishedAt,
          };
          const report: SyncSourceReport = {
            source: plugin.manifest.id,
            status: "critical",
            startedAt: sourceStarted,
            finishedAt,
            durationMs: finishedAt.getTime() - sourceStarted.getTime(),
            findings: [finding],
            metrics: {},
          };
          if (!request.dryRun && checkpoint) {
            try {
              const commit = await this.store.commitSync({
                source: plugin.manifest.id,
                run: {
                  id: runId(plugin.manifest.id),
                  command: commandForRequest(request),
                  mode: request.mode,
                  startedAt: sourceStarted,
                },
                result: {
                  observations: [],
                  records: [],
                  nextCheckpoint: checkpoint.state as JsonObject,
                  health: [finding],
                  metrics: {},
                  completed: false,
                  partial: true,
                },
                expectedCheckpointVersion: checkpoint.version,
              });
              report.commit = commit;
            } catch (commitError) {
              this.logger.error("runtime: failed to persist source failure", {
                source: plugin.manifest.id,
                error: String(commitError),
              });
            }
          }
          this.logger.error("runtime: source failed", {
            source: plugin.manifest.id,
            error: String(error),
          });
          sources.push(report);
        } finally {
          clearTimeout(timeout);
        }
      }
      if (!request.dryRun) await this.projectAfterMutation();
      const finishedAt = new Date();
      const report: SyncReport = {
        status: reportStatus(sources),
        startedAt,
        finishedAt,
        sources,
      };
      this.logger.event("runtime: sync finished", { status: report.status, sourceCount: sources.length });
      return report;
    } finally {
      lock.release();
    }
  }

  async importProviderExport(request: ProviderExportImportRequest): Promise<SyncSourceReport> {
    return this.withRuntimeLock(`${this.configCommandName()} import ${request.source} ${request.path}`, async () => {
      const plugin = this.registry.get(request.source);
      if (!plugin.importProviderExport) throw new Error(`${request.source} does not support provider export import`);
      const startedAt = new Date();
      const checkpoint = await this.store.loadCheckpoint(plugin.manifest.id);
      const ctx = this.pluginContext(plugin.manifest.id, new AbortController().signal, request.dryRun);
      const result = await plugin.importProviderExport(ctx, request, checkpoint);
      const commit = request.dryRun
        ? undefined
        : await this.store.commitSync({
            source: plugin.manifest.id,
            run: {
              id: runId(`${plugin.manifest.id}_import`),
              command: `${this.configCommandName()} import ${plugin.manifest.id} ${request.path}`,
              mode: "backfill",
              startedAt,
            },
            result,
            expectedCheckpointVersion: checkpoint.version,
          });
      const finishedAt = new Date();
      if (!request.dryRun) await this.projectAfterMutation();
      return {
        source: plugin.manifest.id,
        status: sourceStatus(result.health, result.partial),
        startedAt,
        finishedAt,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        commit,
        findings: result.health,
        metrics: result.metrics,
      };
    });
  }

  async enrich(request: EnrichmentRequest): Promise<SyncSourceReport> {
    return this.withRuntimeLock(`${this.configCommandName()} enrich ${request.source}`, async () => {
      const plugin = this.registry.get(request.source);
      if (!plugin.enrich) throw new Error(`${request.source} does not support enrichment`);
      const report = await this.runEnrichmentCommit(plugin, request, `${this.configCommandName()} enrich ${plugin.manifest.id}`);
      if (!request.dryRun) await this.projectAfterMutation();
      return { source: plugin.manifest.id, ...report };
    });
  }

  async health(scope: HealthScope = {}): Promise<HealthReport> {
    return evaluateHealth(this.config, this.store, this.registry, scope);
  }

  async project(request: ProjectionRequest): Promise<ProjectionReport> {
    const outputs: string[] = [];
    if (request.kind === "daily-json" || request.kind === "all") {
      outputs.push(...(await renderDailyJson(this.store, request, this.config.root)).outputs);
    }
    if (request.kind === "daily-markdown" || request.kind === "all") {
      outputs.push(...(await renderDailyMarkdown(this.store, request, this.config.root)).outputs);
    }
    if (request.kind === "dashboard" || request.kind === "all") {
      outputs.push(...(await renderDashboardData(this.store, this.config.root)).outputs);
    }
    return { outputs };
  }

  async query(query: TraceQuery): Promise<RecordPage> {
    return this.store.query(query);
  }

  async close(): Promise<void> {
    await this.store.close();
  }

  private pluginContext(source: string, signal: AbortSignal, dryRun = false): PluginContext {
    return {
      root: this.config.root,
      config: pluginConfig(this.config, source),
      logger: this.logger,
      signal,
      now: () => new Date(),
      records: this.pluginRecordReader(),
      writeArtifact: dryRun ? dryRunWriteArtifact : (input) => this.writeArtifact(input),
    };
  }

  private pluginRecordReader() {
    return {
      query: (query: TraceQuery) => this.store.query(query),
    };
  }

  private configCommandName(): string {
    return "nutshell";
  }

  private async runAutomaticEnrichment(
    plugin: TracePlugin,
    request: SyncRequest,
    sourceReport: SyncSourceReport,
  ): Promise<EnrichmentSourceReport | null> {
    if (!plugin.enrich) return null;
    if (request.dryRun) return null;
    if (request.mode !== "recent") return null;
    if (sourceReport.status === "critical" || !sourceReport.commit) return null;
    const settings = this.automaticEnrichmentSettings(request.budget);
    if (!settings.enabled || settings.limit <= 0) return null;
    const enrichmentRequest: EnrichmentRequest = {
      source: plugin.manifest.id,
      limit: settings.limit,
      dryRun: false,
      budget: settings.budget,
    };
    const report = await this.runEnrichmentCommit(
      plugin,
      enrichmentRequest,
      `${commandForRequest(request)} --auto-enrich ${plugin.manifest.id}`,
    );
    this.logger.event("runtime: source enrichment finished", {
      source: plugin.manifest.id,
      status: report.status,
      durationMs: report.durationMs,
      metrics: report.metrics as JsonObject,
    });
    return report;
  }

  private async runEnrichmentCommit(
    plugin: TracePlugin,
    request: EnrichmentRequest,
    command: string,
  ): Promise<EnrichmentSourceReport> {
    if (!plugin.enrich) throw new Error(`${request.source} does not support enrichment`);
    const startedAt = new Date();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("plugin enrichment timeout")), request.budget.maxRuntimeMs);
    let checkpoint: Checkpoint | null = null;
    try {
      checkpoint = await this.store.loadCheckpoint(plugin.manifest.id);
      const ctx = this.pluginContext(plugin.manifest.id, controller.signal, request.dryRun);
      const result = await plugin.enrich(ctx, request, checkpoint);
      const commit = request.dryRun
        ? undefined
        : await this.store.commitSync({
            source: plugin.manifest.id,
            run: {
              id: runId(`${plugin.manifest.id}_enrich`),
              command,
              mode: "recent",
              startedAt,
            },
            result,
            expectedCheckpointVersion: checkpoint.version,
          });
      const finishedAt = new Date();
      return {
        status: sourceStatus(result.health, result.partial),
        startedAt,
        finishedAt,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        commit,
        findings: result.health,
        metrics: result.metrics,
      };
    } catch (error) {
      const finishedAt = new Date();
      const finding = {
        level: "critical" as const,
        source: plugin.manifest.id,
        code: "plugin_enrichment_runtime_error",
        message: `${plugin.manifest.id} enrichment failed`,
        detail: { error: String(error) },
        observedAt: finishedAt,
      };
      const report: EnrichmentSourceReport = {
        status: "critical",
        startedAt,
        finishedAt,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        findings: [finding],
        metrics: {},
      };
      if (!request.dryRun && checkpoint) {
        try {
          report.commit = await this.store.commitSync({
            source: plugin.manifest.id,
            run: {
              id: runId(`${plugin.manifest.id}_enrich`),
              command,
              mode: "recent",
              startedAt,
            },
            result: {
              observations: [],
              records: [],
              nextCheckpoint: checkpoint.state as JsonObject,
              health: [finding],
              metrics: {},
              completed: false,
              partial: true,
            },
            expectedCheckpointVersion: checkpoint.version,
          });
        } catch (commitError) {
          this.logger.error("runtime: failed to persist enrichment failure", {
            source: plugin.manifest.id,
            error: String(commitError),
          });
        }
      }
      this.logger.error("runtime: source enrichment failed", {
        source: plugin.manifest.id,
        error: String(error),
      });
      return report;
    } finally {
      clearTimeout(timeout);
    }
  }

  private automaticEnrichmentSettings(syncBudget: SyncBudget): { enabled: boolean; limit: number; budget: SyncBudget } {
    const runtimeCfg = objectAt(this.config.data, "runtime");
    const configuredMaxRequests = Math.max(0, Math.trunc(numberAt(runtimeCfg, "enrichmentMaxRequests", 10)));
    const maxRequests = syncBudget.maxRequests === null ? configuredMaxRequests : Math.min(configuredMaxRequests, syncBudget.maxRequests);
    return {
      enabled: booleanAt(runtimeCfg, "enrichmentAfterSync", true),
      limit: maxRequests,
      budget: {
        maxRuntimeMs: Math.min(numberAt(runtimeCfg, "enrichmentMaxRuntimeMs", 120_000), syncBudget.maxRuntimeMs),
        maxRequests,
        minDelayMs: Math.max(numberAt(runtimeCfg, "enrichmentMinDelayMs", 1_000), syncBudget.minDelayMs),
        stopOnRateLimit: booleanAt(runtimeCfg, "enrichmentStopOnRateLimit", true) || syncBudget.stopOnRateLimit,
      },
    };
  }

  private async projectAfterMutation(): Promise<void> {
    const runtimeCfg = objectAt(this.config.data, "runtime");
    if (runtimeCfg.projectionAfterSync === false) return;
    await this.project({ kind: "all" }).catch((error) => {
      this.logger.warn("runtime: projection failed", { error: String(error) });
    });
  }

  private async withRuntimeLock<T>(command: string, run: () => Promise<T>): Promise<T> {
    const runtimeCfg = objectAt(this.config.data, "runtime");
    const lock = new RuntimeLock(join(this.config.root, "run.lock"), command, this.logger, {
      heartbeatMs: typeof runtimeCfg.lockHeartbeatMs === "number" ? runtimeCfg.lockHeartbeatMs : 30_000,
      staleMs: typeof runtimeCfg.staleLockMs === "number" ? runtimeCfg.staleLockMs : 10 * 60_000,
    });
    await lock.acquire();
    try {
      return await run();
    } finally {
      lock.release();
    }
  }

  private async writeArtifact(input: WriteArtifactInput): Promise<ArtifactRef> {
    const target = resolve(this.config.root, "artifacts", input.relativePath);
    mkdirSync(dirname(target), { recursive: true });
    const bytes = typeof input.content === "string" ? new TextEncoder().encode(input.content) : input.content;
    const contentHash = sha256(bytes);
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, bytes);
    renameSync(tmp, target);
    return {
      path: target,
      contentHash,
      mimeType: input.mimeType ?? null,
      bytes: bytes.byteLength,
    };
  }
}

async function dryRunWriteArtifact(): Promise<ArtifactRef> {
  throw new Error("dry_run_artifact_write_blocked: dry-run cannot write artifacts");
}

function commandForRequest(request: SyncRequest): string {
  return `nutshell sync ${request.source ?? "all"} --mode ${request.mode}`;
}

function sourceStatus(findings: SyncSourceReport["findings"], partial: boolean): SyncSourceReport["status"] {
  if (findings.some((item) => item.level === "critical")) return "critical";
  if (partial) return "partial";
  if (findings.some((item) => item.level === "warning")) return "warning";
  return "ok";
}

function reportStatus(sources: SyncSourceReport[]): SyncReport["status"] {
  const statuses = sources.flatMap((item) => [item.status, item.enrichment?.status].filter(Boolean));
  if (statuses.some((status) => status === "critical")) return "critical";
  if (sources.some((item) => item.status === "warning" || item.status === "partial" || item.status === "skipped" || item.enrichment?.status === "warning" || item.enrichment?.status === "partial" || item.enrichment?.status === "skipped" || item.findings.some((finding) => finding.level !== "ok") || item.enrichment?.findings.some((finding) => finding.level !== "ok"))) return "warning";
  return "ok";
}

export function defaultSyncRequest(source: string | null = null): SyncRequest {
  return {
    source,
    mode: "recent",
    window: null,
    collections: [],
    budget: DEFAULT_SYNC_BUDGET,
    dryRun: false,
  };
}
