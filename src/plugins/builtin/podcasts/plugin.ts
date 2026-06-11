import { existsSync } from "node:fs";
import type {
  Checkpoint,
  HealthFinding,
  Json,
  JsonObject,
  PluginContext,
  PluginManifest,
  PluginSmokeResult,
  PluginSyncResult,
  RawObservation,
  SyncRequest,
  TraceRecord,
} from "../../../core/types";
import { fingerprint } from "../../../core/ids";
import { overlapWindow, sleep } from "../../../core/time";
import { numberAt, stringArrayAt, stringAt } from "../../../config/config";
import type { TracePlugin } from "../../interface";
import type { PluginSetupContext } from "../../../setup/types";
import { PODCASTS_FINDINGS } from "./findings";
import { podcastEpisodeId, podcastListenId, type PodcastEpisodeRow } from "./identity";
import { probePodcastDatabase, probePodcastFileAccess, readPodcastBackfillPage, readPodcastRows, type PodcastBackfillCursor } from "./sqlite-source";

interface PodcastsState {
  lastRunAt?: string;
  overlapSince?: string;
  backfill?: JsonObject;
  counts?: JsonObject;
  lastSuccessfulDbPath?: string;
  permissionBlockedAt?: string | null;
  permissionBlockCode?: string | null;
}

const SMOKE_CHECK_TIMEOUT_MS = 2_000;

export class PodcastsPlugin implements TracePlugin {
  readonly manifest: PluginManifest = {
    id: "podcasts",
    displayName: "Apple Podcasts",
    authKind: "local_os",
    collections: ["listened"],
    supportsBackfill: true,
    defaultBudget: { maxRuntimeMs: 60_000, maxRequests: null, minDelayMs: 0, stopOnRateLimit: true },
  };

  readonly findings = PODCASTS_FINDINGS;

  readonly setup = {
    summarize: async (_ctx: PluginSetupContext) => ({
      title: "Apple Podcasts",
      body:
        "Nutshell reads the local Apple Podcasts library database in read-only mode and verifies access now, through Nutshell.app.",
    }),
  };

  async check(ctx: PluginContext) {
    const cfg = config(ctx);
    return this.checkWithConfig(cfg);
  }

  async smoke(ctx: PluginContext): Promise<PluginSmokeResult> {
    const cfg = config(ctx);
    const findings = await this.checkWithConfig({
      ...cfg,
      checkTimeoutMs: Math.min(cfg.checkTimeoutMs, SMOKE_CHECK_TIMEOUT_MS),
    });
    return {
      message: findings[0]?.message ?? "Apple Podcasts database is readable.",
      findings,
      metrics: { checkedPaths: existingDbPaths(cfg).length, timeoutMs: Math.min(cfg.checkTimeoutMs, SMOKE_CHECK_TIMEOUT_MS) },
    };
  }

  private async checkWithConfig(cfg: ReturnType<typeof configFromJson>): Promise<HealthFinding[]> {
    const paths = existingDbPaths(cfg);
    if (!paths.length) {
      return [PODCASTS_FINDINGS.make("podcasts_db_missing", "Apple Podcasts database is missing", { dbPath: cfg.dbPath, dbPaths: cfg.dbPaths })];
    }
    const failures: JsonObject[] = [];
    for (const dbPath of paths) {
      try {
        const fileAccess = await probePodcastFileAccess(dbPath, Math.min(cfg.checkTimeoutMs, 5_000));
        if (!fileAccess.ok) {
          return [podcastsFileAccessFinding(dbPath, cfg, fileAccess)];
        }
        await probePodcastDatabase(dbPath, cfg.checkTimeoutMs);
        return [];
      } catch (error) {
        failures.push({ dbPath, error: String(error) });
      }
    }
    const errorText = failures.map((item) => `${item.dbPath}: ${item.error}`).join("\n");
    const timeout = isTimeoutError(errorText);
    return [
      PODCASTS_FINDINGS.make(
        timeout ? "podcasts_db_timeout" : "podcasts_db_probe_failed",
        timeout ? "Apple Podcasts database probe timed out" : "Apple Podcasts database probe failed",
        {
          dbPath: cfg.dbPath,
          dbPaths: cfg.dbPaths,
          failures,
          timeoutMs: cfg.checkTimeoutMs,
        },
      ),
    ];
  }

  async sync(ctx: PluginContext, request: SyncRequest, checkpoint: Checkpoint): Promise<PluginSyncResult> {
    const cfg = config(ctx);
    const observedAt = ctx.now();
    const state = normalizeState(checkpoint.state);
    const blocked = permissionBlockedResult(state, request, observedAt);
    if (blocked) return blocked;
    if (request.mode === "backfill") {
      return syncBackfill(ctx, cfg, state, observedAt, request.budget.maxRequests);
    }
    const window = request.window ?? overlapWindow(cfg.overlapHours, observedAt);
    const since = window.start ?? new Date(observedAt.getTime() - cfg.overlapHours * 60 * 60 * 1000);
    let lastError: unknown = null;
    const paths = orderedDbPaths(cfg, state);
    if (!paths.length) {
      return missingDbResult(checkpoint, cfg);
    }
    try {
      for (let attempt = 1; attempt <= cfg.attempts; attempt += 1) {
        for (const dbPath of paths) {
          try {
            const rows = await readPodcastRows(dbPath, since, cfg.limit, cfg.timeoutMs);
            const filtered = rows.filter((row) => {
              const happened = row.last_played_at ? new Date(row.last_played_at) : null;
              return happened && (!window.end || happened < window.end);
            });
            const normalized = normalizePodcastRows(filtered, observedAt);
            return {
              observations: normalized.observations,
              records: normalized.records,
              nextCheckpoint: {
                ...state,
                lastRunAt: observedAt.toISOString(),
                overlapSince: since.toISOString(),
                lastSuccessfulDbPath: dbPath,
                permissionBlockedAt: null,
                permissionBlockCode: null,
              } as unknown as JsonObject,
              health: [],
              metrics: { rows: rows.length, emitted: filtered.length, attempts: attempt, dbPath },
              completed: true,
              partial: false,
            };
          } catch (error) {
            lastError = error;
            ctx.logger.warn("podcasts: attempt failed", { attempt, dbPath, error: String(error) });
          }
        }
        if (attempt < cfg.attempts) await sleep(500 * attempt, ctx.signal);
      }
    } catch (error) {
      lastError = error;
    }
    const errorText = String(lastError);
    const timeout = isTimeoutError(errorText);
    return {
      observations: [],
      records: [],
      nextCheckpoint: checkpoint.state,
      health: [
        PODCASTS_FINDINGS.make(timeout ? "podcasts_db_timeout" : "podcasts_sync_failed", timeout ? "Apple Podcasts database access timed out" : "Apple Podcasts sync failed after retries", {
          error: errorText,
          attempts: cfg.attempts,
          dbPath: cfg.dbPath,
          dbPaths: cfg.dbPaths,
        }),
      ],
      metrics: { attempts: cfg.attempts },
      completed: false,
      partial: true,
    };
  }
}

export function createPodcastsPlugin(): TracePlugin {
  return new PodcastsPlugin();
}

function config(ctx: PluginContext) {
  return configFromJson(ctx.config as JsonObject);
}

function configFromJson(cfg: JsonObject) {
  const dbPath = stringAt(cfg, "dbPath");
  return {
    dbPath,
    dbPaths: [dbPath, ...stringArrayAt(cfg, "alternateDbPaths")].filter(Boolean),
    overlapHours: numberAt(cfg, "overlapHours", 48),
    limit: numberAt(cfg, "limit", 500),
    backfillLimit: numberAt(cfg, "backfillLimit", 10_000),
    attempts: numberAt(cfg, "attempts", 3),
    timeoutMs: numberAt(cfg, "timeoutMs", 10_000),
    checkTimeoutMs: numberAt(cfg, "checkTimeoutMs", 3_000),
  };
}

function existingDbPaths(cfg: ReturnType<typeof config>): string[] {
  return [...new Set(cfg.dbPaths)].filter((path) => existsSync(path));
}

function orderedDbPaths(cfg: ReturnType<typeof config>, state: PodcastsState): string[] {
  const existing = existingDbPaths(cfg);
  const preferred = state.lastSuccessfulDbPath && existing.includes(state.lastSuccessfulDbPath) ? state.lastSuccessfulDbPath : null;
  return preferred ? [preferred, ...existing.filter((path) => path !== preferred)] : existing;
}

function missingDbResult(checkpoint: Checkpoint, cfg: ReturnType<typeof config>): PluginSyncResult {
  return {
    observations: [],
    records: [],
    nextCheckpoint: checkpoint.state,
    health: [
      PODCASTS_FINDINGS.make("podcasts_db_missing", "Apple Podcasts database is missing", {
        dbPath: cfg.dbPath,
        dbPaths: cfg.dbPaths,
      }),
    ],
    metrics: {},
    completed: false,
    partial: true,
  };
}

function isTimeoutError(errorText: string): boolean {
  return /worker exited 143|timed out|timeout budget|aborted|SIGTERM|signal/i.test(errorText);
}

async function syncBackfill(
  ctx: PluginContext,
  cfg: ReturnType<typeof config>,
  state: PodcastsState,
  observedAt: Date,
  maxRequests: number | null,
): Promise<PluginSyncResult> {
  const liveState = podcastsLiveState(state);
  if (liveState.done) {
    return {
      observations: [],
      records: [],
      nextCheckpoint: state as unknown as JsonObject,
      health: [],
      metrics: { rows: 0, emitted: 0, done: true },
      completed: true,
      partial: false,
    };
  }
  let lastError: unknown = null;
  const paths = orderedDbPaths(cfg, state);
  if (!paths.length) {
    return {
      observations: [],
      records: [],
      nextCheckpoint: state as unknown as JsonObject,
      health: [
        PODCASTS_FINDINGS.make("podcasts_db_missing", "Apple Podcasts database is missing", {
          dbPath: cfg.dbPath,
          dbPaths: cfg.dbPaths,
        }),
      ],
      metrics: {},
      completed: false,
      partial: true,
    };
  }
  for (let attempt = 1; attempt <= cfg.attempts; attempt += 1) {
    for (const dbPath of paths) {
      try {
        const limit = maxRequests ? Math.max(1, Math.min(cfg.backfillLimit, Math.trunc(maxRequests))) : cfg.backfillLimit;
        const page = await readPodcastBackfillPage(dbPath, liveState.cursor, limit, cfg.timeoutMs);
        const normalized = normalizePodcastRows(page.rows, observedAt);
        const backfill = state.backfill && typeof state.backfill === "object" && !Array.isArray(state.backfill) ? state.backfill : {};
        const existingLive = backfill.live && typeof backfill.live === "object" && !Array.isArray(backfill.live) ? (backfill.live as JsonObject) : {};
        const nextState: PodcastsState = {
          ...state,
          lastRunAt: observedAt.toISOString(),
          lastSuccessfulDbPath: dbPath,
          permissionBlockedAt: null,
          permissionBlockCode: null,
          backfill: {
            ...backfill,
            live: {
              ...existingLive,
              cursor: page.nextCursor as unknown as Json,
              done: !page.nextCursor,
              updatedAt: observedAt.toISOString(),
            },
          },
        };
        return {
          observations: normalized.observations,
          records: normalized.records,
          nextCheckpoint: nextState as unknown as JsonObject,
          health: [],
          metrics: { rows: page.rows.length, emitted: page.rows.length, attempts: attempt, done: !page.nextCursor, dbPath },
          completed: !page.nextCursor,
          partial: Boolean(page.nextCursor),
        };
      } catch (error) {
        lastError = error;
        ctx.logger.warn("podcasts: backfill attempt failed", { attempt, dbPath, error: String(error) });
      }
    }
    if (attempt < cfg.attempts) await sleep(500 * attempt, ctx.signal);
  }
  return {
    observations: [],
    records: [],
    nextCheckpoint: state as unknown as JsonObject,
    health: [
      PODCASTS_FINDINGS.make("podcasts_backfill_failed", "Apple Podcasts backfill failed after retries", {
        error: String(lastError),
        attempts: cfg.attempts,
      }),
    ],
    metrics: { attempts: cfg.attempts },
    completed: false,
    partial: true,
  };
}

function permissionBlockedResult(state: PodcastsState, request: SyncRequest, observedAt: Date): PluginSyncResult | null {
  if (!state.permissionBlockedAt || request.source === "podcasts") return null;
  return {
    observations: [],
    records: [],
    nextCheckpoint: state as unknown as JsonObject,
    health: [],
    metrics: { skipped: true, reason: "permission_blocked" },
    completed: true,
    partial: false,
  };
}

function permissionBlockedState(checkpointState: Json, access: Awaited<ReturnType<typeof probePodcastFileAccess>>, observedAt: Date): JsonObject {
  const state = checkpointState && typeof checkpointState === "object" && !Array.isArray(checkpointState) ? (checkpointState as JsonObject) : {};
  return {
    ...state,
    permissionBlockedAt: observedAt.toISOString(),
    permissionBlockCode: access.code,
  };
}

function podcastsFileAccessFinding(
  dbPath: string,
  cfg: ReturnType<typeof config>,
  access: Awaited<ReturnType<typeof probePodcastFileAccess>>,
) {
  const timeout = access.code === "timeout";
  const permission = access.code === "permission_denied";
  return PODCASTS_FINDINGS.make(
    permission ? "podcasts_full_disk_access_required" : timeout ? "podcasts_db_read_timeout" : "podcasts_db_read_failed",
    permission
      ? "Apple Podcasts database is blocked by macOS privacy permissions"
      : timeout
        ? "Apple Podcasts database read probe timed out"
        : "Apple Podcasts database could not be read",
    {
      dbPath,
      dbPaths: cfg.dbPaths,
      probe: { ...access },
      requiredPermission: "Full Disk Access",
      currentRunner: {
        execPath: process.execPath,
        argv0: process.argv[0] ?? "",
        script: process.argv[1] ?? "",
        xpcServiceName: process.env.XPC_SERVICE_NAME ?? "",
      },
    },
  );
}

function normalizePodcastRows(rows: PodcastEpisodeRow[], observedAt: Date): { observations: RawObservation[]; records: TraceRecord[] } {
  const observations: RawObservation[] = rows.map((row) => ({
    source: "podcasts",
    observedAt,
    sourceRecordId: podcastListenId(row),
    fingerprint: fingerprint(row as JsonObject),
    payload: row as JsonObject,
    artifactPaths: [],
  }));
  const records: TraceRecord[] = [];
  for (const row of rows) {
    const episodeId = podcastEpisodeId(row);
    records.push({
      source: "podcasts",
      collection: "episodes",
      kind: "entity",
      type: "podcast.episode",
      sourceId: episodeId,
      happenedAt: row.published_at ? new Date(row.published_at) : null,
      observedAt,
      title: row.episode_title || null,
      url: row.webpage_url || row.audio_url || null,
      bodyText: row.podcast_title || null,
      artifactRefs: [],
      payload: row as JsonObject,
    });
    records.push({
      source: "podcasts",
      collection: "listened",
      kind: "event",
      type: "podcast.listened",
      sourceId: podcastListenId(row),
      happenedAt: row.last_played_at ? new Date(row.last_played_at) : null,
      observedAt,
      title: row.episode_title || null,
      url: row.webpage_url || row.audio_url || null,
      bodyText: row.podcast_title || null,
      artifactRefs: [],
      payload: row as JsonObject,
    });
  }
  return { observations, records };
}

function podcastsLiveState(state: PodcastsState): { cursor: PodcastBackfillCursor | null; done: boolean } {
  const backfill = state.backfill && typeof state.backfill === "object" && !Array.isArray(state.backfill) ? state.backfill : {};
  const live = backfill.live && typeof backfill.live === "object" && !Array.isArray(backfill.live) ? (backfill.live as JsonObject) : {};
  const candidate = Object.keys(live).length ? live : backfill;
  const cursor = candidate.cursor && typeof candidate.cursor === "object" && !Array.isArray(candidate.cursor) ? candidate.cursor : null;
  return {
    cursor:
      cursor && typeof cursor.lastPlayedRaw === "number" && typeof cursor.episodePk === "number"
        ? { lastPlayedRaw: cursor.lastPlayedRaw, episodePk: cursor.episodePk }
        : null,
    done: candidate.done === true,
  };
}

function normalizeState(value: unknown): PodcastsState {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as PodcastsState) : {};
}
