import { existsSync, readFileSync, statfsSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TraceConfig } from "../config/config";
import { logPath, objectAt, pluginConfig } from "../config/config";
import { pluginSetupFindings, pluginSetupStatus } from "../setup/config-draft";
import type {
  AppBackgroundStatus,
  BackfillHealthItem,
  BackfillLaneHealth,
  HealthFinding,
  HealthReport,
  HealthScope,
  Json,
  JsonObject,
  PluginManifest,
  PluginContext,
  RecentHealthItem,
  SchedulerHealth,
  SourceId,
} from "../core/types";
import { localDateKey } from "../core/time";
import { CLI_NAME, PRODUCT_NAME } from "../core/product";
import { appStatusJson, inspectNutshellApp } from "../macos/app-status";
import type { PluginRegistry } from "../plugins/registry";
import { PODCASTS_FINDINGS } from "../plugins/builtin/podcasts/findings";
import { TWITTER_FINDINGS } from "../plugins/builtin/twitter/findings";
import { inspectLock } from "../runtime/lock";
import { JsonlLogger } from "../runtime/logger";
import type { TraceStore } from "../store/interface";
import { reportStatus } from "./health";
import { SYSTEM_FINDINGS, restoredSetupFindings, systemFinding } from "./system-findings";

export async function evaluateHealth(config: TraceConfig, store: TraceStore, registry: PluginRegistry, scope: HealthScope = {}): Promise<HealthReport> {
  const findings: HealthFinding[] = [];
  const checkedAt = new Date();
  const runtimeCfg = objectAt(config.data, "runtime");
  const app = await inspectNutshellApp(config);
  findings.push(...appFindings(app));

  const rootWriteFinding = checkRootWritable(config.root);
  if (rootWriteFinding) findings.push(rootWriteFinding);

  const lock = await inspectLock(join(config.root, "run.lock"), numberAt(runtimeCfg, "staleLockMs", 10 * 60_000));
  if (lock.present) {
    findings.push(
      SYSTEM_FINDINGS.make(lock.stale ? "lock_stale" : "lock_active", lock.stale ? "A stale runtime lock exists" : "A runtime lock is active", {
        reason: lock.reason,
        command: lock.command,
        heartbeatAgeMs: lock.heartbeatAgeMs,
        payload: lock.payload as unknown as JsonObject,
      }),
    );
  }

  try {
    const free = statSync(config.root);
    if (!free.isDirectory()) {
      findings.push(SYSTEM_FINDINGS.make("root_not_directory", `${PRODUCT_NAME} data root is not a directory`, { root: config.root }));
    }
  } catch (error) {
    findings.push(SYSTEM_FINDINGS.make("root_missing", `${PRODUCT_NAME} data root is missing`, { error: String(error) }));
  }

  const diskFinding = checkDiskFree(config.root, runtimeCfg);
  if (diskFinding) findings.push(diskFinding);

  const snapshot = await store.healthSnapshot();
  if (!snapshot.dbOk) {
    findings.push(SYSTEM_FINDINGS.make("sqlite_quick_check", "SQLite quick_check failed", { detail: snapshot.dbDetail }));
  }

  const enabledSources = registry.enabled(config).map((plugin) => plugin.manifest.id).filter((source) => !scope.source || source === scope.source);
  const latestFindingBySource = rowBySource(snapshot.latestFindings);
  const recentRunBySource = rowBySource(snapshot.lastRuns);
  const backfill = evaluateBackfill(config, enabledSources, snapshot.recordCounts, snapshot.lastRuns, snapshot.lastBackfillRuns, snapshot.sourceStates, snapshot.latestFindings, checkedAt);
  for (const item of backfill) {
    if (item.status === "backfill_incomplete" || item.status === "backfill_partial") {
      findings.push(
        systemFinding(
          item.status,
          item.source,
          `${item.source} coverage is ${item.status === "backfill_partial" ? "partial" : "incomplete"} for the configured cutoff`,
          {
            ...(item as unknown as JsonObject),
            nextCommand: item.bulkBackfill.nextCommand ?? item.liveBackfill.nextCommand,
          },
        ),
      );
    }
  }

  for (const run of snapshot.lastRuns) {
    if (!run || typeof run !== "object" || Array.isArray(run)) continue;
    const row = run as JsonObject;
    const source = String(row.source ?? "system") as SourceId;
    if (scope.source && source !== scope.source) continue;
    const status = String(row.status ?? "");
    const partial = Number(row.partial ?? 0) === 1;
    const completed = Number(row.completed ?? 0) === 1;
    const latestFinding = normalizeLatestFinding(findingForRun(latestFindingBySource.get(source), row));
    if (status === "critical") {
      findings.push(
        systemFinding("last_run_failed", source, `${source} last sync failed`, {
          startedAt: String(row.started_at ?? ""),
          finishedAt: String(row.finished_at ?? ""),
          status,
          latestFinding,
        }),
      );
    } else if (partial || !completed) {
      findings.push(
        systemFinding("last_run_partial", source, `${source} last sync was partial`, {
          startedAt: String(row.started_at ?? ""),
          finishedAt: String(row.finished_at ?? ""),
          status,
          partial,
          completed,
          latestFinding,
        }),
      );
    }
  }

  const logger = new JsonlLogger(logPath(config));
  const sourceStateBySource = rowBySource(snapshot.sourceStates);
  const twitterEnrichment = twitterEnrichmentHealth(parseState(sourceStateBySource.get("twitter")), checkedAt);
  const twitterPending = numberAt(twitterEnrichment, "pending", 0);
  const twitterRateLimited = numberAt(twitterEnrichment, "rateLimited", 0);
  const twitterFailures = numberAt(twitterEnrichment, "failed", 0);
  if ((!scope.source || scope.source === "twitter") && twitterRateLimited > 0) {
    findings.push(
      TWITTER_FINDINGS.make("twitter_enrichment_rate_limited", "Twitter enrichment is paused by rate limits", twitterEnrichment),
    );
  } else if ((!scope.source || scope.source === "twitter") && twitterPending > 0) {
    findings.push(
      TWITTER_FINDINGS.make("twitter_enrichment_pending", "Twitter enrichment has queued tweets that are not ready for dashboard rendering", twitterEnrichment),
    );
  } else if ((!scope.source || scope.source === "twitter") && twitterFailures > 0) {
    findings.push(
      TWITTER_FINDINGS.make("twitter_enrichment_failed", "Twitter enrichment has retryable failures", twitterEnrichment),
    );
  }
  for (const plugin of registry.enabled(config).filter((plugin) => !scope.source || plugin.manifest.id === scope.source)) {
    const setupStatus = pluginSetupStatus(config, plugin.manifest.id);
    if (setupStatus === "degraded") {
      findings.push(
        systemFinding("plugin_setup_degraded", plugin.manifest.id, `${plugin.manifest.displayName} setup is degraded`, {
          setupFindings: restoredSetupFindings(pluginSetupFindings(config, plugin.manifest.id)),
          nextAction: `${CLI_NAME} setup`,
        }),
      );
      continue;
    }
    const sourceState = parseState(sourceStateBySource.get(plugin.manifest.id));
    if (plugin.manifest.id === "podcasts" && typeof sourceState.permissionBlockedAt === "string") {
      findings.push(
        PODCASTS_FINDINGS.make("podcasts_permission_blocked", "Apple Podcasts sync is paused until app-data permission is fixed", {
          blockedAt: sourceState.permissionBlockedAt,
          blockCode: typeof sourceState.permissionBlockCode === "string" ? sourceState.permissionBlockCode : "unknown",
          nextAction: "Run `nutshell setup`, grant Full Disk Access to Nutshell.app, then run `nutshell sync podcasts --mode recent --json` once.",
        }),
      );
      continue;
    }
    if (plugin.manifest.authKind === "local_os" && app.installed) {
      const appOwnedFinding = localOsAppOwnedHealthFinding(plugin.manifest, recentRunBySource.get(plugin.manifest.id));
      if (appOwnedFinding) findings.push(appOwnedFinding);
      continue;
    }
    const ctx: PluginContext = {
      root: config.root,
      config: pluginConfig(config, plugin.manifest.id),
      logger,
      signal: new AbortController().signal,
      now: () => new Date(),
      records: {
        query: (query) => store.query(query),
      },
      writeArtifact: async () => {
        throw new Error("health check cannot write artifacts");
      },
    };
    try {
      findings.push(...(await plugin.check(ctx)));
    } catch (error) {
      findings.push(systemFinding("plugin_check_crashed", plugin.manifest.id, "Plugin health check crashed", { error: String(error) }));
    }
  }

  findings.push(...checkProjectionFreshness(config.root, snapshot.lastRuns, runtimeCfg));

  const scheduler = schedulerHealth(config, snapshot.lastRuns, app, checkedAt);

  return { status: reportStatus(findings), checkedAt, findings, backfill, app, scheduler };
}

function localOsAppOwnedHealthFinding(manifest: PluginManifest, latestRun: JsonObject | undefined): HealthFinding | null {
  if (latestRun) return null;
  return systemFinding("app_owned_sync_not_verified", manifest.id, `${manifest.displayName} has not been verified by an app-owned sync yet`, {
    reason: "This source depends on macOS app permissions, so terminal health avoids probing it directly.",
    nextAction: `${CLI_NAME} sync ${manifest.id} --mode recent --json, or wait for the app-owned background sync to run.`,
  });
}

function schedulerHealth(config: TraceConfig, lastRuns: Json[], app: AppBackgroundStatus, now: Date): SchedulerHealth {
  const intervalSeconds = numberAt(objectAt(config.data, "scheduler"), "intervalSeconds", 900);
  const lastRunAt = latestRecentRunFinishedAt(lastRuns)?.toISOString() ?? null;
  if (app.backgroundSync !== "enabled" || app.agent !== "enabled") {
    return {
      intervalSeconds,
      lastRunAt,
      nextRunAt: null,
      lastAgentEventAt: null,
      lastAgentMessage: null,
      source: "disabled",
    };
  }

  const event = latestAgentLogEvent(config.root);
  const agentNext = event ? scheduledTimeFromAgentEvent(event, intervalSeconds) : null;
  if (agentNext) {
    return {
      intervalSeconds,
      lastRunAt,
      nextRunAt: agentNext,
      lastAgentEventAt: event!.timestamp,
      lastAgentMessage: event!.message,
      source: "agent_log",
    };
  }

  if (lastRunAt) {
    return {
      intervalSeconds,
      lastRunAt,
      nextRunAt: new Date(Date.parse(lastRunAt) + intervalSeconds * 1000).toISOString(),
      lastAgentEventAt: event?.timestamp ?? null,
      lastAgentMessage: event?.message ?? null,
      source: "last_run",
    };
  }

  return {
    intervalSeconds,
    lastRunAt,
    nextRunAt: now.toISOString(),
    lastAgentEventAt: event?.timestamp ?? null,
    lastAgentMessage: event?.message ?? null,
    source: "first_run_due",
  };
}

interface AgentLogEvent {
  timestamp: string;
  message: string;
  detail: JsonObject;
}

function latestAgentLogEvent(root: string): AgentLogEvent | null {
  const path = join(root, "logs", "nutshell-agent.jsonl");
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, "utf8").trim().split("\n").reverse();
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as JsonObject;
      const timestamp = typeof event.timestamp === "string" ? event.timestamp : "";
      const message = typeof event.message === "string" ? event.message : "";
      if (!timestamp || !message) continue;
      return { timestamp, message, detail: objectAt(event, "detail") };
    } catch {
      continue;
    }
  }
  return null;
}

function scheduledTimeFromAgentEvent(event: AgentLogEvent, intervalSeconds: number): string | null {
  const explicit = typeof event.detail.nextRunAt === "string" ? event.detail.nextRunAt : null;
  if (explicit && !Number.isNaN(Date.parse(explicit))) return new Date(explicit).toISOString();
  if (Number.isNaN(Date.parse(event.timestamp))) return null;
  const eventIntervalSeconds = numberAt(event.detail, "intervalSeconds", intervalSeconds);
  if (
    event.message === "next sync scheduled" ||
    event.message === "sync disabled; sleeping" ||
    event.message === "sync disabled; waiting" ||
    event.message === "Full Disk Access is not granted; sync skipped" ||
    event.message === "sync finished"
  ) {
    return new Date(Date.parse(event.timestamp) + eventIntervalSeconds * 1000).toISOString();
  }
  return null;
}

function appFindings(app: AppBackgroundStatus): HealthFinding[] {
  const detail = appStatusJson(app);
  if (!app.installed) {
    return [SYSTEM_FINDINGS.make("nutshell_app_missing", `${PRODUCT_NAME}.app is not installed or could not be found`, detail)];
  }
  const findings: HealthFinding[] = [];
  if (app.fullDiskAccess === "missing") {
    findings.push(SYSTEM_FINDINGS.make("nutshell_app_full_disk_access_missing", `${PRODUCT_NAME}.app does not have Full Disk Access`, detail));
  } else if (app.fullDiskAccess === "unknown") {
    findings.push(SYSTEM_FINDINGS.make("nutshell_app_full_disk_access_unknown", `${PRODUCT_NAME}.app Full Disk Access could not be determined`, detail));
  }
  if (app.agent === "requiresApproval") {
    findings.push(SYSTEM_FINDINGS.make("nutshell_agent_requires_approval", `${PRODUCT_NAME} background agent requires approval`, detail));
  } else if (app.agent === "notRegistered" || app.agent === "notFound") {
    findings.push(SYSTEM_FINDINGS.make("nutshell_agent_not_enabled", `${PRODUCT_NAME} background agent is not enabled`, detail));
  }
  if (app.backgroundSync === "disabled") {
    findings.push(SYSTEM_FINDINGS.make("nutshell_background_sync_disabled", `${PRODUCT_NAME} background sync is disabled`, detail));
  }
  return findings;
}

function evaluateBackfill(
  config: TraceConfig,
  sources: SourceId[],
  recordCounts: Json[],
  lastRuns: Json[],
  lastBackfillRuns: Json[],
  sourceStates: Json[],
  latestFindings: Json[],
  now: Date,
): BackfillHealthItem[] {
  const countsBySource = new Map<string, JsonObject>();
  const rangesBySource = new Map<string, JsonObject>();
  for (const row of recordCounts) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const source = String(row.source ?? "");
    const type = String(row.type ?? "");
    if (!source || !type) continue;
    const counts = countsBySource.get(source) ?? {};
    counts[type] = Number(row.count ?? 0);
    countsBySource.set(source, counts);
    const ranges = rangesBySource.get(source) ?? {};
    ranges[type] = {
      oldest: typeof row.oldest === "string" ? row.oldest : null,
      newest: typeof row.newest === "string" ? row.newest : null,
    };
    rangesBySource.set(source, ranges);
  }

  const recentBySource = rowBySource(lastRuns);
  const backfillBySource = rowBySource(lastBackfillRuns);
  const stateBySource = rowBySource(sourceStates);
  const latestFindingBySource = rowBySource(latestFindings);
  return sources.map((source) => {
    const cutoff = cutoffDateFor(config, source, now);
    const ranges = rangesBySource.get(source) ?? {};
    const counts = countsBySource.get(source) ?? {};
    const recent = recentHealthFor(recentBySource.get(source));
    const backfillRun = backfillBySource.get(source);
    const state = parseState(stateBySource.get(source));
    const latestFinding = latestRelevantFinding(latestFindingBySource.get(source), recentBySource.get(source), backfillRun);
    const coverage = coverageForRanges(ranges, cutoff);
    const provider = providerImportHealth(source, state, cutoff);
    const live = liveCoverageHealth(source, coverage, recent, backfillRun, latestFinding, cutoff);
    const status =
      live.status === "partial" || provider.status === "partial"
        ? "backfill_partial"
        : live.status === "complete" || provider.status === "complete"
          ? "backfill_complete"
          : "backfill_incomplete";
    return {
      source,
      status,
      counts,
      targets: { cutoffDate: cutoff },
      recentStatus: recent.status,
      lastBackfillStatus: backfillRun ? String(backfillRun.status ?? "") : null,
      recent,
      bulkBackfill: provider,
      liveBackfill: live,
      detail: {
        sourceStateVersion: Number(stateBySource.get(source)?.version ?? 0),
        sourceStateUpdatedAt: String(stateBySource.get(source)?.updated_at ?? ""),
        latestFinding: normalizeLatestFinding(latestFinding),
        recordRanges: ranges,
        ...(source === "twitter" ? { twitterEnrichment: twitterEnrichmentHealth(state, now) } : {}),
      },
    };
  });
}

function twitterEnrichmentHealth(state: JsonObject, now: Date): JsonObject {
  const enrichment = objectAt(state, "enrichment");
  const queue = objectAt(enrichment, "queue");
  const items = Object.values(queue).filter((item): item is JsonObject => Boolean(item && typeof item === "object" && !Array.isArray(item)));
  const firstSeenValues = items
    .map((item) => (typeof item.firstSeenAt === "string" ? item.firstSeenAt : ""))
    .filter(Boolean)
    .sort();
  const oldestPendingAt = firstSeenValues[0] ?? null;
  const oldestPendingAgeMs = oldestPendingAt ? Math.max(0, now.getTime() - Date.parse(oldestPendingAt)) : null;
  return {
    pending: items.length,
    failed: items.filter((item) => typeof item.lastErrorCode === "string" && item.lastErrorCode.length > 0).length,
    rateLimited: items.filter((item) => item.lastErrorCode === "rate_limited" || item.lastErrorCode === "too_many_requests").length,
    oldestPendingAt,
    oldestPendingAgeMs,
    lastRunAt: typeof enrichment.lastRunAt === "string" ? enrichment.lastRunAt : null,
    lastSuccessAt: typeof enrichment.lastSuccessAt === "string" ? enrichment.lastSuccessAt : null,
    lastFailureAt: typeof enrichment.lastFailureAt === "string" ? enrichment.lastFailureAt : null,
    lastRateLimitedAt: typeof enrichment.lastRateLimitedAt === "string" ? enrichment.lastRateLimitedAt : null,
    nextCommand: items.length ? `${CLI_NAME} sync twitter --mode recent --json` : null,
  };
}

function providerImportHealth(source: SourceId, state: JsonObject, cutoff: string): BackfillLaneHealth {
  const imports = objectAt(objectAt(state, "backfill"), "imports");
  if (source !== "youtube" && source !== "twitter") {
    return {
      status: "unsupported",
      reason: "No official provider export importer is configured for this source",
      nextCommand: null,
      counts: {},
      targets: { cutoffDate: cutoff },
      detail: {},
    };
  }
  const key = source === "youtube" ? "google_youtube" : "x_archive";
  const item = objectAt(imports, key);
  const oldest = typeof item.oldest === "string" ? item.oldest : null;
  const complete = Boolean(oldest && oldest.slice(0, 10) <= cutoff);
  return {
    status: complete ? "complete" : "incomplete",
    reason: complete ? null : `${source} official provider export has not covered the configured cutoff`,
    nextCommand: source === "youtube" ? `${CLI_NAME} import youtube <provider-export> --json` : `${CLI_NAME} import twitter <provider-export> --json`,
    counts: objectAt(item, "counts"),
    targets: { cutoffDate: cutoff },
    detail: item,
  };
}

function liveCoverageHealth(
  source: SourceId,
  coverage: { complete: boolean; oldest: string | null },
  recent: RecentHealthItem,
  backfillRun: JsonObject | undefined,
  latestFinding: JsonObject | undefined,
  cutoff: string,
): BackfillLaneHealth {
  const partial = isPartialRun(backfillRun) || recent.partial === true;
  const status = partial ? "partial" : coverage.complete ? "complete" : "incomplete";
  return {
    status,
    reason:
      status === "complete"
        ? null
        : latestFinding
          ? String(latestFinding.message ?? latestFinding.code ?? `${source} coverage is incomplete`)
          : `${source} records do not yet cover the configured cutoff`,
    nextCommand: status === "complete" ? null : `${CLI_NAME} sync ${source} --mode backfill --json`,
    counts: {},
    targets: { cutoffDate: cutoff },
    detail: {
      oldest: coverage.oldest,
      latestFinding: normalizeLatestFinding(latestFinding),
    },
  };
}

function coverageForRanges(ranges: JsonObject, cutoff: string): { complete: boolean; oldest: string | null } {
  let oldest: string | null = null;
  for (const value of Object.values(ranges)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const candidate = typeof value.oldest === "string" ? value.oldest : null;
    if (!candidate) continue;
    if (!oldest || candidate < oldest) oldest = candidate;
  }
  return { complete: Boolean(oldest && oldest.slice(0, 10) <= cutoff), oldest };
}

function cutoffDateFor(config: TraceConfig, source: SourceId, now: Date): string {
  const backfill = objectAt(config.data, "backfill");
  const cutoffs = objectAt(backfill, "cutoffDates");
  const explicit = typeof cutoffs[source] === "string" ? String(cutoffs[source]) : typeof backfill.cutoffDate === "string" ? String(backfill.cutoffDate) : "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(explicit)) return explicit;
  const months = numberAt(backfill, "lookbackMonths", 6);
  const date = new Date(now);
  date.setUTCMonth(date.getUTCMonth() - months);
  return date.toISOString().slice(0, 10);
}

function recentHealthFor(row: JsonObject | undefined): RecentHealthItem {
  if (!row) return { status: null, lastRunAt: null, completed: null, partial: null };
  return {
    status: String(row.status ?? ""),
    lastRunAt: String(row.finished_at ?? row.started_at ?? ""),
    completed: Number(row.completed ?? 0) === 1,
    partial: Number(row.partial ?? 0) === 1,
  };
}

function findingForRun(finding: JsonObject | undefined, run: JsonObject | undefined): JsonObject | undefined {
  if (!finding || !run) return undefined;
  const findingRunId = typeof finding.run_id === "string" ? finding.run_id : "";
  const runId = typeof run?.id === "string" ? run.id : "";
  return findingRunId && runId && findingRunId !== runId ? undefined : finding;
}

function latestRelevantFinding(finding: JsonObject | undefined, recentRun: JsonObject | undefined, backfillRun: JsonObject | undefined): JsonObject | undefined {
  return findingForRun(finding, backfillRun) ?? findingForRun(finding, recentRun);
}

function rowBySource(rows: Json[]): Map<string, JsonObject> {
  const map = new Map<string, JsonObject>();
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const source = String((row as JsonObject).source ?? "");
    if (source) map.set(source, row as JsonObject);
  }
  return map;
}

function parseState(row: JsonObject | undefined): JsonObject {
  const raw = row?.state_json;
  if (typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw) as Json;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeLatestFinding(row: JsonObject | undefined): JsonObject | null {
  if (!row) return null;
  let detail: Json = {};
  if (typeof row.detail_json === "string") {
    try {
      detail = JSON.parse(row.detail_json) as Json;
    } catch {
      detail = row.detail_json;
    }
  }
  return {
    level: row.level ?? null,
    code: row.code ?? null,
    message: row.message ?? null,
    observedAt: row.observed_at ?? null,
    detail,
  };
}

function isPartialRun(row: JsonObject | undefined): boolean {
  return Boolean(row && (String(row.status ?? "") === "partial" || Number(row.partial ?? 0) === 1));
}

function checkRootWritable(root: string): HealthFinding | null {
  const writeTest = join(root, `.health-write-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    writeFileSync(writeTest, "ok\n", "utf8");
  } catch (error) {
    return SYSTEM_FINDINGS.make("root_not_writable", `${PRODUCT_NAME} data root is not writable`, { phase: "write", error: String(error) });
  }
  try {
    unlinkSync(writeTest);
  } catch (error) {
    if (isMissingFileError(error)) return null;
    return SYSTEM_FINDINGS.make("root_write_test_cleanup_failed", `${PRODUCT_NAME} data root is writable, but health could not remove its temporary write test file`, {
      phase: "cleanup",
      path: writeTest,
      error: String(error),
    });
  }
  return null;
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT");
}

function checkDiskFree(root: string, runtimeCfg: JsonObject): HealthFinding | null {
  try {
    const stats = statfsSync(root);
    const availableBytes = Number(stats.bavail) * Number(stats.bsize);
    const totalBytes = Number(stats.blocks) * Number(stats.bsize);
    const warningBytes = numberAt(runtimeCfg, "diskWarningBytes", 2_000_000_000);
    const criticalBytes = numberAt(runtimeCfg, "diskCriticalBytes", 500_000_000);
    const detail = { root, availableBytes, totalBytes, warningBytes, criticalBytes };
    if (availableBytes < criticalBytes) return SYSTEM_FINDINGS.make("disk_free_low", `${PRODUCT_NAME} data root disk free space is critically low`, detail, "critical");
    if (availableBytes < warningBytes) return SYSTEM_FINDINGS.make("disk_free_low", `${PRODUCT_NAME} data root disk free space is low`, detail);
    return null;
  } catch (error) {
    return SYSTEM_FINDINGS.make("disk_free_unknown", `${PRODUCT_NAME} data root disk free space could not be checked`, { root, error: String(error) });
  }
}

function checkProjectionFreshness(root: string, lastRuns: Json[], runtimeCfg: JsonObject): HealthFinding[] {
  const findings: HealthFinding[] = [];
  const projectionsRoot = join(root, "projections");
  if (!existsSync(projectionsRoot)) {
    return [SYSTEM_FINDINGS.make("projections_missing", "Projection directory is missing", {})];
  }
  const latestRunAt = latestRecentRunFinishedAt(lastRuns);
  const dashboard = projectionFile(root, "dashboard", "status.json");
  const today = localDateKey(new Date());
  const dailyJson = projectionFile(root, "daily-json", `${today}.json`);
  const dailyMarkdown = projectionFile(root, "daily-markdown", `${today}.md`);
  const staleMs = numberAt(runtimeCfg, "projectionStaleMs", 24 * 60 * 60 * 1000);
  for (const file of [dashboard, dailyJson, dailyMarkdown]) {
    const finding = projectionFileFinding(file, latestRunAt, staleMs);
    if (finding) findings.push(finding);
  }
  return findings;
}

function projectionFile(root: string, kind: string, name: string): { kind: string; path: string } {
  return { kind, path: join(root, "projections", kind, name) };
}

function projectionFileFinding(file: { kind: string; path: string }, latestRunAt: Date | null, staleMs: number): HealthFinding | null {
  if (!existsSync(file.path)) {
    return SYSTEM_FINDINGS.make("projection_missing", `${file.kind} projection is missing`, { kind: file.kind, path: file.path });
  }
  const stat = statSync(file.path);
  const ageMs = Date.now() - stat.mtime.getTime();
  const behindLatestRunMs = latestRunAt ? latestRunAt.getTime() - stat.mtime.getTime() : 0;
  const detail = {
    kind: file.kind,
    path: file.path,
    mtime: stat.mtime.toISOString(),
    ageMs,
    staleMs,
    latestRunAt: latestRunAt ? latestRunAt.toISOString() : null,
    behindLatestRunMs,
  };
  if (behindLatestRunMs > 5_000) return SYSTEM_FINDINGS.make("projection_stale", `${file.kind} projection is older than the latest recent sync`, detail);
  if (ageMs > staleMs) return SYSTEM_FINDINGS.make("projection_stale", `${file.kind} projection is stale`, detail);
  return null;
}

function latestRecentRunFinishedAt(lastRuns: Json[]): Date | null {
  let latest: Date | null = null;
  for (const row of lastRuns) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const raw = typeof row.finished_at === "string" ? row.finished_at : typeof row.started_at === "string" ? row.started_at : "";
    if (!raw) continue;
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.valueOf())) continue;
    if (!latest || parsed > latest) latest = parsed;
  }
  return latest;
}

function numberAt(value: JsonObject, key: string, fallback: number): number {
  const child = value[key];
  return typeof child === "number" && Number.isFinite(child) ? child : fallback;
}
