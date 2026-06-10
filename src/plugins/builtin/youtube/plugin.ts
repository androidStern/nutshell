import type {
  Checkpoint,
  HealthFinding,
  JsonObject,
  PluginContext,
  PluginManifest,
  PluginSyncResult,
  ProviderExportImportRequest,
  RawObservation,
  SyncRequest,
  TraceRecord,
} from "../../../core/types";
import { overlapWindow } from "../../../core/time";
import { CLI_NAME } from "../../../core/product";
import { numberAt, stringAt } from "../../../config/config";
import { CHROME_SAFE_STORAGE_REASON, chromeSafeStorageAccessMessage, isChromeSafeStorageAccessIssue } from "../../../browser/access-errors";
import type { TracePlugin } from "../../interface";
import type { PluginSetupContext } from "../../../setup/types";
import { googleTakeoutYoutubePluginResult } from "../../../imports/google-takeout-youtube";
import { dateKeyToDate, youtubeEventType, youtubeFingerprint, youtubeHappenedAt, youtubeSourceId, type YouTubeActivityItem } from "./identity";
import { collectYouTubeFromMyActivityHttp, MYACTIVITY_SESSION_UNVERIFIABLE, type MyActivityHttpResult } from "./myactivity-http";
import { YOUTUBE_FINDINGS } from "./findings";

type YouTubeCollector = typeof collectYouTubeFromMyActivityHttp;

interface YouTubeState {
  lastRunAt?: string;
  lastCutoff?: string;
  lastScroll?: JsonObject;
}

type YouTubeProbeFailureCode = "youtube_signed_out" | "youtube_keychain_blocked" | "youtube_activity_unreadable" | "youtube_session_unverifiable";

type YouTubeProbeResult =
  | { ok: true; message: string; detail: JsonObject }
  | { ok: false; code: YouTubeProbeFailureCode; message: string; detail: JsonObject };

export class YouTubePlugin implements TracePlugin {
  constructor(private readonly collect: YouTubeCollector = collectYouTubeFromMyActivityHttp) {}

  readonly findings = YOUTUBE_FINDINGS;

  readonly manifest: PluginManifest = {
    id: "youtube",
    displayName: "YouTube My Activity",
    authKind: "browser_profile",
    collections: ["watched", "searched"],
    supportsBackfill: true,
    defaultBudget: { maxRuntimeMs: 180_000, maxRequests: null, minDelayMs: 900, stopOnRateLimit: true },
  };

  readonly setup = {
    summarize: async (_ctx: PluginSetupContext) => ({
      title: "YouTube",
      body:
        "Nutshell reads recent YouTube activity through your Chrome session and verifies access now, through Nutshell.app. Historical backfill is optional and uses an official Google export.",
      archiveImport: {
        title: "Import Google YouTube export now?",
        body: "Use this only if you already have a Google Takeout or Data Portability export containing YouTube activity.",
        laterCommand: `${CLI_NAME} import youtube <google-export.zip> --json`,
        allowedExtensions: ["zip", "json", "html"],
      },
    }),
  };

  async check(ctx: PluginContext) {
    const cfg = config(ctx);
    if (cfg.accessMode !== "myactivity_http") {
      return [YOUTUBE_FINDINGS.make("youtube_access_mode_unsupported", "Only direct My Activity HTTP sync is supported", { accessMode: cfg.accessMode })];
    }
    let probe: YouTubeProbeResult;
    try {
      probe = await this.probe(cfg, ctx.signal);
    } catch (error) {
      probe = youtubeProbeException(error);
    }
    return probe.ok ? [] : [YOUTUBE_FINDINGS.make(probe.code, probe.message, probe.detail)];
  }

  async importProviderExport(_ctx: PluginContext, request: ProviderExportImportRequest, checkpoint: Checkpoint): Promise<PluginSyncResult> {
    const existingState = checkpoint.state && typeof checkpoint.state === "object" && !Array.isArray(checkpoint.state) ? (checkpoint.state as JsonObject) : {};
    return googleTakeoutYoutubePluginResult(request.path, existingState, new Date());
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
            YOUTUBE_FINDINGS.make("youtube_provider_export_required", "YouTube historical backfill requires an official Google export import", {
              nextCommand: `${CLI_NAME} import youtube <provider-export> --json`,
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
          authUser: cfg.authUser,
          signal: ctx.signal,
        });
        return normalizeCollectionResult(result, state, window, observedAt, cutoffYmd, health);
      }
      return emptyResult(checkpoint, [
        YOUTUBE_FINDINGS.make("youtube_access_mode_unsupported", "Only direct My Activity HTTP sync is supported", { accessMode: cfg.accessMode }),
      ]);
    } catch (error) {
      const access = classifyYouTubeAccessError(error);
      return emptyResult(checkpoint, [
        access
          ? YOUTUBE_FINDINGS.make(access.code, access.message, access.detail)
          : YOUTUBE_FINDINGS.make("youtube_sync_failed", "YouTube sync failed", { error: String(error) }),
      ]);
    }
  }

  private async probe(cfg: ReturnType<typeof configFromJson>, signal: AbortSignal): Promise<YouTubeProbeResult> {
    const result = await this.collect({
      cutoffYmd: ymd(new Date(Date.now() - 24 * 60 * 60 * 1000)),
      maxPages: 1,
      cursor: null,
      cookieBrowser: cfg.cookieBrowser,
      cookieProfile: cfg.cookieProfile,
      cookieTimeoutMs: cfg.cookieTimeoutMs,
      authUser: cfg.authUser,
      signal,
    });
    const loadedCards = Number(result.scroll.loadedCardCount || 0);
    if (result.items.length === 0 && result.scroll.reachedCutoff !== true) {
      return {
        ok: false,
        code: "youtube_activity_unreadable",
        message: "YouTube browser session could not prove recent activity access; the collector did not reach the probe cutoff.",
        detail: { items: result.items.length, loadedCards, scroll: result.scroll },
      };
    }
    if (result.items.length === 0 && loadedCards > 0) {
      return {
        ok: false,
        code: "youtube_activity_unreadable",
        message: "YouTube browser session loaded activity cards but parsed no usable items.",
        detail: { items: result.items.length, loadedCards, scroll: result.scroll },
      };
    }
    return {
      ok: true,
      message: `YouTube browser session works (${result.items.length} recent items visible in probe).`,
      detail: { items: result.items.length, scroll: result.scroll },
    };
  }
}

// Classifies a collector error into the two access failure modes that have
// their own user states: signed out (needs_auth) and Chrome Safe Storage /
// Keychain blocked (needs_permission). Keychain is checked first and never
// classified as an auth problem. Returns null for everything else so callers
// pick their own fallback code (probe vs sync).
function classifyYouTubeAccessError(
  error: unknown,
): { code: "youtube_signed_out" | "youtube_keychain_blocked" | "youtube_session_unverifiable"; message: string; detail: JsonObject } | null {
  const text = String(error);
  if (isChromeSafeStorageAccessIssue(text)) {
    return {
      code: "youtube_keychain_blocked",
      message: chromeSafeStorageAccessMessage("YouTube"),
      detail: { reason: CHROME_SAFE_STORAGE_REASON, error: text },
    };
  }
  if (text.includes(MYACTIVITY_SESSION_UNVERIFIABLE)) {
    return {
      code: "youtube_session_unverifiable",
      message: "Google served an identity-verification page instead of My Activity for this account; recent YouTube sync cannot establish a session.",
      detail: { error: text },
    };
  }
  if (isYouTubeSignedOutError(text)) {
    return {
      code: "youtube_signed_out",
      message: "You're not signed into Google in Chrome.",
      detail: { error: text },
    };
  }
  return null;
}

// Matches the collector's signed-out error texts: missing/invalid Google
// cookies, the signed-out My Activity shell, and login redirects.
function isYouTubeSignedOutError(text: string): boolean {
  return /signed-out|Google browser cookies were not usable|accounts\.google\.com\/(?:signin|ServiceLogin)/i.test(text);
}

function youtubeProbeException(error: unknown): YouTubeProbeResult {
  const access = classifyYouTubeAccessError(error);
  if (access) return { ok: false, ...access };
  return {
    ok: false,
    code: "youtube_activity_unreadable",
    message: "YouTube My Activity probe failed before recent activity access could be verified.",
    detail: { error: String(error) },
  };
}

export function createYouTubePlugin(): TracePlugin {
  return new YouTubePlugin();
}

function config(ctx: PluginContext) {
  return configFromJson(ctx.config as JsonObject);
}

function configFromJson(cfg: JsonObject) {
  return {
    accessMode: stringAt(cfg, "accessMode", "myactivity_http"),
    cookieBrowser: stringAt(cfg, "cookieBrowser", "chrome"),
    cookieProfile: stringAt(cfg, "cookieProfile", ""),
    cookieTimeoutMs: numberAt(cfg, "cookieTimeoutMs", 30_000),
    overlapHours: numberAt(cfg, "overlapHours", 48),
    httpMaxPages: numberAt(cfg, "httpMaxPages", 10),
    authUser: numberAt(cfg, "authUser", 0),
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
    health.push(YOUTUBE_FINDINGS.make("youtube_cursor_loop", "YouTube collector cursor looped before cutoff", scroll));
  }
  if (!scroll.reachedCutoff) {
    health.push(YOUTUBE_FINDINGS.make("youtube_cutoff_not_reached", "YouTube collector did not reach cutoff", scroll));
  }
  if (scroll.stoppedForStagnation) {
    health.push(YOUTUBE_FINDINGS.make("youtube_stagnation", "YouTube collector stopped for stagnation", scroll));
  }
  if (items.length === 0 && Number(scroll.loadedCardCount || 0) > 0) {
    health.push(YOUTUBE_FINDINGS.make("youtube_unexpected_empty", "YouTube parsed no items despite loaded cards", scroll));
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
