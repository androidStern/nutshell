import type {
  Checkpoint,
  HealthFinding,
  JsonObject,
  PluginContext,
  PluginManifest,
  PluginSyncResult,
  RawObservation,
  SyncRequest,
  TraceRecord,
} from "../../../core/types";
import { overlapWindow } from "../../../core/time";
import { CLI_NAME } from "../../../core/product";
import { numberAt, stringAt } from "../../../config/config";
import { finding, type TracePlugin } from "../../interface";
import { dateKeyToDate, youtubeEventType, youtubeFingerprint, youtubeHappenedAt, youtubeSourceId, type YouTubeActivityItem } from "./identity";
import { collectYouTubeFromMyActivityHttp, type MyActivityHttpResult } from "./myactivity-http";

type YouTubeCollector = typeof collectYouTubeFromMyActivityHttp;

interface YouTubeState {
  lastRunAt?: string;
  lastCutoff?: string;
  lastScroll?: JsonObject;
}

export class YouTubePlugin implements TracePlugin {
  constructor(private readonly collect: YouTubeCollector = collectYouTubeFromMyActivityHttp) {}

  readonly manifest: PluginManifest = {
    id: "youtube",
    displayName: "YouTube My Activity",
    authKind: "browser_profile",
    collections: ["watched", "searched"],
    supportsBackfill: true,
    defaultBudget: { maxRuntimeMs: 180_000, maxRequests: null, minDelayMs: 900, stopOnRateLimit: true },
  };

  async check(ctx: PluginContext) {
    const cfg = config(ctx);
    if (cfg.accessMode === "myactivity_http") {
      return [];
    }
    return [finding("critical", "youtube", "youtube_access_mode_unsupported", "Only direct My Activity HTTP sync is supported", { accessMode: cfg.accessMode })];
  }

  async sync(ctx: PluginContext, request: SyncRequest, checkpoint: Checkpoint): Promise<PluginSyncResult> {
    const cfg = config(ctx);
    const observedAt = ctx.now();
    const state = normalizeState(checkpoint.state);
    const health: HealthFinding[] = [];
    try {
      if (request.mode === "backfill") {
        return emptyResult(
          checkpoint,
          [
            finding("warning", "youtube", "youtube_provider_export_required", "YouTube historical backfill requires an official Google export import", {
              nextCommand: `${CLI_NAME} import youtube --path <provider-export> --json`,
            }),
          ],
          { providerExportRequired: true },
        );
      }
      if (cfg.accessMode === "myactivity_http") {
        const window = request.window ?? overlapWindow(cfg.overlapHours, observedAt);
        const cutoffDate = window.start;
        const cutoffYmd = ymd(cutoffDate ?? new Date(observedAt.getTime() - cfg.overlapHours * 60 * 60 * 1000));
        const resumeCursor = null;
        const maxPages = request.budget.maxRequests
          ? Math.max(1, Math.trunc(request.budget.maxRequests))
          : cfg.httpMaxPages;
        const result = await this.collect({
          cutoffYmd,
          maxPages,
          cursor: resumeCursor,
          cookieBrowser: cfg.cookieBrowser,
          cookieProfile: cfg.cookieProfile,
          cookieTimeoutMs: cfg.cookieTimeoutMs,
          signal: ctx.signal,
        });
        return normalizeCollectionResult(result, state, window, observedAt, cutoffYmd, health);
      }
      return emptyResult(checkpoint, [
        finding("critical", "youtube", "youtube_access_mode_unsupported", "Only direct My Activity HTTP sync is supported", { accessMode: cfg.accessMode }),
      ]);
    } catch (error) {
      return emptyResult(checkpoint, [
        finding("critical", "youtube", "youtube_sync_failed", "YouTube sync failed", { error: String(error) }),
      ]);
    }
  }
}

export function createYouTubePlugin(): TracePlugin {
  return new YouTubePlugin();
}

function config(ctx: PluginContext) {
  const cfg = ctx.config as JsonObject;
  return {
    accessMode: stringAt(cfg, "accessMode", "chrome"),
    cookieBrowser: stringAt(cfg, "cookieBrowser", "chrome"),
    cookieProfile: stringAt(cfg, "cookieProfile", ""),
    cookieTimeoutMs: numberAt(cfg, "cookieTimeoutMs", 30_000),
    overlapHours: numberAt(cfg, "overlapHours", 48),
    httpMaxPages: numberAt(cfg, "httpMaxPages", 10),
  };
}

function normalizeCollectionResult(
  result: MyActivityHttpResult,
  state: YouTubeState,
  window: { start: Date | null; end: Date | null } | null,
  observedAt: Date,
  cutoffYmd: string,
  health: HealthFinding[],
): PluginSyncResult {
  const items = result.items;
  const scroll = result.scroll;
  const filtered = items.filter((item) => {
    const happened = dateKeyToDate(item.date_key);
    if (!happened) return false;
    return Boolean(window && (!window.start || happened >= window.start) && (!window.end || happened < window.end));
  });

  if (scroll.stoppedForCursorLoop) {
    health.push(finding("critical", "youtube", "youtube_cursor_loop", "YouTube collector cursor looped before cutoff", scroll));
  }
  if (!scroll.reachedCutoff) {
    health.push(finding("critical", "youtube", "youtube_cutoff_not_reached", "YouTube collector did not reach cutoff", scroll));
  }
  if (scroll.stoppedForStagnation) {
    health.push(finding("warning", "youtube", "youtube_stagnation", "YouTube collector stopped for stagnation", scroll));
  }
  if (items.length === 0 && Number(scroll.loadedCardCount || 0) > 0) {
    health.push(finding("critical", "youtube", "youtube_unexpected_empty", "YouTube parsed no items despite loaded cards", scroll));
  }

  const observations: RawObservation[] = filtered.map((item) => ({
    source: "youtube",
    observedAt,
    sourceRecordId: youtubeSourceId(item),
    fingerprint: youtubeFingerprint(item),
    payload: item as JsonObject,
    artifactPaths: [],
  }));
  const records: TraceRecord[] = filtered.map((item) => ({
    source: "youtube",
    collection: youtubeEventType(item).endsWith("searched") ? "searched" : "watched",
    kind: "event",
    type: youtubeEventType(item),
    sourceId: youtubeSourceId(item),
    happenedAt: youtubeHappenedAt(item),
    observedAt,
    title: item.title || null,
    url: item.title_url || null,
    bodyText: item.raw_text || null,
    artifactRefs: [],
    payload: item as JsonObject,
  }));
  const critical = health.some((item) => item.level === "critical");
  const cutoffNotReached = scroll.reachedCutoff !== true;
  const partial = critical || cutoffNotReached;
  const nextCheckpoint = nextState(state, observedAt, cutoffYmd, scroll);
  return {
    observations,
    records,
    nextCheckpoint,
    health,
    metrics: {
      fetched: items.length,
      emitted: filtered.length,
      window: window ? { start: window.start?.toISOString() ?? null, end: window.end?.toISOString() ?? null } : null,
      scroll,
    },
    completed: !partial,
    partial,
  };
}

function normalizeState(value: unknown): YouTubeState {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as YouTubeState) : {};
}

function nextState(
  state: YouTubeState,
  observedAt: Date,
  cutoffYmd: string,
  scroll: JsonObject,
): JsonObject {
  const next: YouTubeState = {
    ...state,
    lastRunAt: observedAt.toISOString(),
    lastCutoff: cutoffYmd,
    lastScroll: scroll,
  };
  return next as unknown as JsonObject;
}

function ymd(date: Date): string {
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
}

function emptyResult(checkpoint: Checkpoint, health: HealthFinding[] = [], metrics: JsonObject = {}): PluginSyncResult {
  return {
    observations: [],
    records: [],
    nextCheckpoint: checkpoint.state,
    health,
    metrics,
    completed: false,
    partial: true,
  };
}
