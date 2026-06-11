import type {
  Checkpoint,
  EnrichmentRequest,
  HealthFinding,
  JsonObject,
  PluginContext,
  PluginManifest,
  PluginSmokeResult,
  PluginSyncResult,
  ProviderExportImportRequest,
  RawObservation,
  SyncRequest,
  TraceRecord,
} from "../../../core/types";
import { fingerprint } from "../../../core/ids";
import { sleep } from "../../../core/time";
import { CLI_NAME } from "../../../core/product";
import { numberAt, stringArrayAt, stringAt } from "../../../config/config";
import { CHROME_SAFE_STORAGE_REASON, chromeSafeStorageAccessMessage, isChromeSafeStorageAccessIssue } from "../../../browser/access-errors";
import type { TracePlugin } from "../../interface";
import type { PluginSetupContext } from "../../../setup/types";
import { BirdClient } from "./bird-client";
import { TWITTER_FINDINGS } from "./findings";
import { authorPayload, collectionEventType, profileId, tweetCreatedAt, tweetId, type BirdTweet } from "./identity";
import { looksLikeRateLimit } from "./rate-limit";
import {
  buildTweetDisplayPayload,
  enqueueUnresolvedTweetTargets,
  enrichDueTargets,
  quoteAndReplyTargets,
  tweetTarget,
  withTweetDisplay,
  type TweetEnrichmentFetcher,
  type TweetEnrichmentTarget,
  type TwitterEnrichmentState,
} from "./enrichment";
import { SyndicationTweetFetcher } from "./syndication-fetcher";
import { importXArchiveResult } from "./x-archive";

interface TwitterState {
  recent?: Record<string, { lastRunAt?: string; saturated?: boolean; partial?: boolean }>;
  knownIds?: Record<string, string[]>;
  backfill?: JsonObject;
  enrichment?: TwitterEnrichmentState;
}

const SMOKE_COOKIE_TIMEOUT_MS = 2_000;
const SMOKE_REQUEST_TIMEOUT_MS = 8_000;

export class TwitterPlugin implements TracePlugin {
  constructor(private readonly enrichmentFetcher: TweetEnrichmentFetcher = new SyndicationTweetFetcher()) {}

  readonly manifest: PluginManifest = {
    id: "twitter",
    displayName: "Twitter/X",
    authKind: "browser_profile",
    collections: ["bookmarks", "likes", "authored", "following"],
    supportsBackfill: true,
    defaultBudget: { maxRuntimeMs: 10 * 60_000, maxRequests: 50, minDelayMs: 10_000, stopOnRateLimit: true },
  };

  readonly findings = TWITTER_FINDINGS;

  readonly setup = {
    summarize: async (_ctx: PluginSetupContext) => ({
      title: "Twitter/X",
      body:
        "Nutshell reads recent X activity through your Chrome session and verifies access now, through Nutshell.app. Historical backfill is optional and uses an official X archive export.",
      archiveImport: {
        title: "Import official X archive now?",
        body: "Use this only if you already have the official X archive export from x.com.",
        laterCommand: `${CLI_NAME} import twitter <x-archive.zip> --json`,
        allowedExtensions: ["zip", "js", "json"],
      },
    }),
  };

  async check(ctx: PluginContext) {
    const cfg = config(ctx);
    return this.checkWithConfig(cfg, ctx.signal);
  }

  async smoke(ctx: PluginContext): Promise<PluginSmokeResult> {
    const cfg = config(ctx);
    const findings = await this.checkWithConfig(
      {
        ...cfg,
        cookieTimeoutMs: Math.min(cfg.cookieTimeoutMs, SMOKE_COOKIE_TIMEOUT_MS),
        timeoutMs: Math.min(cfg.timeoutMs, SMOKE_REQUEST_TIMEOUT_MS),
      },
      ctx.signal,
    );
    return {
      message: findings[0]?.message ?? "X browser session is readable.",
      findings,
      metrics: { timeoutMs: Math.min(cfg.timeoutMs, SMOKE_REQUEST_TIMEOUT_MS) },
    };
  }

  private async checkWithConfig(cfg: ReturnType<typeof configFromJson>, signal: AbortSignal): Promise<HealthFinding[]> {
    const findings: HealthFinding[] = [];
    const client = new BirdClient(cfg);
    const result = await client.check(signal);
    if (!result.ok || result.authFailed) {
      const text = result.text.slice(-1200);
      if (isChromeSafeStorageAccessIssue(result.text)) {
        findings.push(
          TWITTER_FINDINGS.make("twitter_keychain_blocked", chromeSafeStorageAccessMessage("X"), {
            reason: CHROME_SAFE_STORAGE_REASON,
            text,
          }),
        );
      } else if (result.authFailed) {
        findings.push(TWITTER_FINDINGS.make("twitter_signed_out", "X browser session is signed out", { text }));
      } else if (!result.rateLimited) {
        findings.push(TWITTER_FINDINGS.make("twitter_session_check_failed", "X browser session check failed", { text }));
      }
    }
    if (result.rateLimited) {
      findings.push(TWITTER_FINDINGS.make("twitter_rate_limited", "X reported a rate limit", { text: result.text.slice(-1200) }));
    }
    return findings;
  }

  async sync(ctx: PluginContext, request: SyncRequest, checkpoint: Checkpoint): Promise<PluginSyncResult> {
    if (request.mode === "backfill") {
      return {
        observations: [],
        records: [],
        nextCheckpoint: checkpoint.state,
        health: [
          TWITTER_FINDINGS.make("twitter_provider_export_required", "Twitter/X historical backfill requires an official X archive import", {
            nextCommand: `${CLI_NAME} import twitter <provider-export> --json`,
          }),
        ],
        metrics: { providerExportRequired: true },
        completed: false,
        partial: true,
      };
    }

    const cfg = config(ctx);
    const client = new BirdClient(cfg);
    let state = normalizeState(cloneState(checkpoint.state));
    const collections = request.collections.length ? request.collections : cfg.collections;
    const observedAt = ctx.now();
    const observations: RawObservation[] = [];
    const records: TraceRecord[] = [];
    const health: HealthFinding[] = [];
    const metrics: JsonObject = {};
    let partial = false;
    const requestPageLimit = request.budget.maxRequests ? Math.max(1, Math.trunc(request.budget.maxRequests)) : cfg.maxPages;
    const explicitCollections = request.collections.length > 0;

    for (const collection of collections) {
      const stateBeforeCollection = cloneState(state);
      try {
        if (collection === "following") {
          if (request.mode === "recent" && !explicitCollections) {
            const skip = followingSkipReason(state, observedAt, cfg.followingSnapshotTtlMs);
            if (skip) {
              metrics.following = skip;
              continue;
            }
          }
          const page = await client.following(Math.min(cfg.maxPages, requestPageLimit), cfg.followingPageSize, ctx.signal);
          const result = normalizeFollowing(page.users, page.nextCursor, cfg.accountId, observedAt);
          observations.push(...result.observations);
          records.push(...result.records);
          metrics.following = { count: page.users.length, nextCursor: page.nextCursor };
          const recent = (state.recent ??= {});
          recent.following = { lastRunAt: observedAt.toISOString(), saturated: !page.nextCursor, partial: Boolean(page.nextCursor) };
          mirrorTwitterLiveCollection(state, "following", {
            done: !page.nextCursor,
            partial: Boolean(page.nextCursor),
            cursor: page.nextCursor,
            updatedAt: observedAt.toISOString(),
            count: page.users.length,
          });
          partial = partial || Boolean(page.nextCursor);
          if (page.nextCursor) {
            health.push(
              TWITTER_FINDINGS.make("twitter_following_incomplete", "Following snapshot did not reach cursor exhaustion", {
                nextCursor: page.nextCursor,
                fetched: page.users.length,
                maxPages: cfg.maxPages,
              }),
            );
          }
        } else {
          const result = await syncRecentCollection(client, collection, state, cfg, ctx, observedAt, requestPageLimit);
          observations.push(...result.observations);
          records.push(...result.records);
          const queued = await enqueueUnresolvedTweetTargets(ctx.records, enrichmentState(state), result.enrichmentTargets);
          metrics[collection] = {
            ...result.metrics,
            observations: result.observations.length,
            records: result.records.length,
            enrichmentTargets: result.enrichmentTargets.length,
          };
          (metrics[collection] as JsonObject).enrichmentQueued = queued;
          partial = partial || result.partial;
          const recent = (state.recent ??= {});
          recent[collection] = {
            lastRunAt: observedAt.toISOString(),
            saturated: !result.partial,
            partial: result.partial,
          };
          if (collection === "authored" && !result.partial) {
            mirrorTwitterLiveCollection(state, collection, {
              done: true,
              partial: false,
              updatedAt: observedAt.toISOString(),
              pages: Number((result.metrics as JsonObject).pages ?? 0),
            });
          }
        }
      } catch (error) {
        state = stateBeforeCollection;
        const text = String(error);
        partial = true;
        health.push(
          TWITTER_FINDINGS.make(looksLikeRateLimit(text) ? "twitter_rate_limited" : "twitter_collection_failed", `Twitter ${collection} sync failed`, {
            error: text,
          }),
        );
        if (ctx.signal.aborted) break;
        if (looksLikeRateLimit(text) && request.budget.stopOnRateLimit) break;
      }
    }

    return {
      observations,
      records,
      nextCheckpoint: state as unknown as JsonObject,
      health,
      metrics: {
        ...metrics,
        observations: observations.length,
        records: records.length,
      },
      completed: !partial && !health.some((item) => item.level === "critical"),
      partial,
    };
  }

  async importProviderExport(ctx: PluginContext, request: ProviderExportImportRequest, checkpoint: Checkpoint): Promise<PluginSyncResult> {
    const existingState = checkpoint.state && typeof checkpoint.state === "object" && !Array.isArray(checkpoint.state) ? (checkpoint.state as JsonObject) : {};
    return importXArchiveResult(request.path, cloneState(existingState) as unknown as JsonObject, ctx.now(), ctx.records);
  }

  async enrich(ctx: PluginContext, request: EnrichmentRequest, checkpoint: Checkpoint): Promise<PluginSyncResult> {
    const state = normalizeState(cloneState(checkpoint.state));
    const result = await enrichDueTargets(enrichmentState(state), {
      now: ctx.now(),
      limit: request.limit,
      budget: request.budget,
      signal: ctx.signal,
      fetcher: this.enrichmentFetcher,
    });
    return {
      observations: [],
      records: result.records,
      nextCheckpoint: state as unknown as JsonObject,
      health: result.health,
      metrics: result.metrics,
      completed: !result.partial && !result.health.some((item) => item.level === "critical"),
      partial: result.partial,
    };
  }
}

export function createTwitterPlugin(): TracePlugin {
  return new TwitterPlugin();
}

function config(ctx: PluginContext) {
  return configFromJson(ctx.config as JsonObject);
}

function configFromJson(cfg: JsonObject) {
  return {
    accountId: stringAt(cfg, "accountId", "acct_primary"),
    accountUserId: stringAt(cfg, "accountUserId", ""),
    accountHandle: stringAt(cfg, "accountHandle", ""),
    cookieBrowser: stringAt(cfg, "cookieBrowser", "chrome"),
    cookieProfile: stringAt(cfg, "cookieProfile", ""),
    cookieTimeoutMs: numberAt(cfg, "cookieTimeoutMs", 30_000),
    timeoutMs: numberAt(cfg, "timeoutMs", 120_000),
    collections: stringArrayAt(cfg, "collections"),
    maxPages: numberAt(cfg, "maxPages", 50),
    recentMaxPages: numberAt(cfg, "recentMaxPages", 3),
    pageSize: numberAt(cfg, "pageSize", 20),
    followingPageSize: numberAt(cfg, "followingPageSize", 100),
    followingSnapshotTtlMs: numberAt(cfg, "followingSnapshotTtlMs", 6 * 60 * 60 * 1000),
    delayMs: numberAt(cfg, "delayMs", 10_000),
    saturationPages: numberAt(cfg, "saturationPages", 1),
    recentSeedPages: numberAt(cfg, "recentSeedPages", 1),
  };
}

function normalizeState(value: unknown): TwitterState {
  const state = value && typeof value === "object" ? (value as TwitterState) : {};
  state.recent ??= {};
  state.enrichment ??= {};
  state.enrichment.queue ??= {};
  return state;
}

function cloneState(value: unknown): TwitterState {
  if (!value || typeof value !== "object") return {};
  return JSON.parse(JSON.stringify(value)) as TwitterState;
}

function followingSkipReason(state: TwitterState, observedAt: Date, ttlMs: number): JsonObject | null {
  if (ttlMs <= 0) return null;
  const recent = state.recent?.following;
  if (!recent || recent.partial === true || recent.saturated !== true) return null;
  const lastRunAtText = typeof recent.lastRunAt === "string" ? recent.lastRunAt : null;
  const lastRunAt = lastRunAtText ? Date.parse(lastRunAtText) : Number.NaN;
  if (!Number.isFinite(lastRunAt)) return null;
  const ageMs = observedAt.getTime() - lastRunAt;
  if (ageMs < 0 || ageMs >= ttlMs) return null;
  return {
    skipped: true,
    reason: "fresh_following_snapshot",
    lastRunAt: lastRunAtText,
    ageMs,
    ttlMs,
    nextDueAt: new Date(lastRunAt + ttlMs).toISOString(),
  };
}

async function syncRecentCollection(
  client: BirdClient,
  collection: string,
  state: TwitterState,
  cfg: ReturnType<typeof config>,
  ctx: PluginContext,
  observedAt: Date,
  requestPageLimit: number,
) {
  let cursor: string | null = null;
  let pages = 0;
  let saturatedPages = 0;
  const observations: RawObservation[] = [];
  const records: TraceRecord[] = [];
  const enrichmentTargets: TweetEnrichmentTarget[] = [];
  const knownIds = new Set((state.knownIds ??= {})[collection] ?? []);
  const seedMode = knownIds.size === 0;
  const recentPageLimit = Math.max(1, Math.min(cfg.maxPages, cfg.recentMaxPages, requestPageLimit));
  const pageLimit = seedMode ? Math.max(1, Math.min(recentPageLimit, cfg.recentSeedPages)) : recentPageLimit;
  while (pages < pageLimit) {
    const page = await client.page(collection, cursor, cfg.pageSize, ctx.signal);
    pages += 1;
    const tweets = page.tweets as BirdTweet[];
    const ids = tweets.map((tweet) => tweetId(tweet));
    const newIds = new Set(ids.filter((id) => !knownIds.has(id)));
    const pageKnown = ids.length > 0 && ids.every((id) => knownIds.has(id));
    ids.forEach((id) => knownIds.add(id));
    const normalized = normalizeTweets(tweets, collection, observedAt, (id) => shouldEmitCollectionEvent(collection, seedMode, newIds.has(id)));
    observations.push(...normalized.observations);
    records.push(...normalized.records);
    enrichmentTargets.push(...normalized.enrichmentTargets);
    saturatedPages = pageKnown ? saturatedPages + 1 : 0;
    if (!page.nextCursor || saturatedPages >= cfg.saturationPages || (seedMode && pages >= pageLimit)) {
      state.knownIds![collection] = [...knownIds].slice(-50_000);
      return { observations, records, enrichmentTargets, partial: false, metrics: { pages, saturated: saturatedPages >= cfg.saturationPages, seeded: seedMode } };
    }
    cursor = page.nextCursor;
    await sleep(cfg.delayMs, ctx.signal);
  }
  state.knownIds![collection] = [...knownIds].slice(-50_000);
  return { observations, records, enrichmentTargets, partial: true, metrics: { pages, saturated: false, seeded: seedMode } };
}

function shouldEmitCollectionEvent(collection: string, seedMode: boolean, isNewId: boolean): boolean {
  if (collection === "authored") return true;
  if (collection === "bookmarks" || collection === "likes") return !seedMode && isNewId;
  return !seedMode && isNewId;
}

function mirrorTwitterLiveCollection(state: TwitterState, collection: string, value: JsonObject): void {
  const backfill = state.backfill && typeof state.backfill === "object" && !Array.isArray(state.backfill) ? state.backfill : {};
  const live = backfill.live && typeof backfill.live === "object" && !Array.isArray(backfill.live) ? (backfill.live as JsonObject) : {};
  const collections =
    live.collections && typeof live.collections === "object" && !Array.isArray(live.collections) ? (live.collections as JsonObject) : {};
  collections[collection] = value;
  state.backfill = {
    ...backfill,
    live: {
      ...live,
      collections,
      lastBackfillAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date().toISOString(),
    },
  };
}

function enrichmentState(state: TwitterState): TwitterEnrichmentState {
  state.enrichment ??= {};
  state.enrichment.queue ??= {};
  return state.enrichment;
}

function normalizeTweets(tweets: BirdTweet[], collection: string, observedAt: Date, shouldEmitEvent: (id: string) => boolean) {
  const observations: RawObservation[] = [];
  const records: TraceRecord[] = [];
  const enrichmentTargets: TweetEnrichmentTarget[] = [];
  for (const tweet of tweets) {
    const id = tweetId(tweet);
    const author = authorPayload(tweet);
    const happenedAt = tweetCreatedAt(tweet);
    const action = collection === "bookmarks" ? "bookmarked" : collection === "likes" ? "liked" : "authored";
    const fallbackUrl = id ? `https://x.com/i/web/status/${id}` : null;
    const display = buildTweetDisplayPayload({
      action,
      tweetId: id,
      fallbackText: tweet.text || null,
      fallbackUrl,
      happenedAt: collection === "authored" ? happenedAt : observedAt,
    });
    const sourceRecordId = collection === "authored" ? id : `${collection}:${id}`;
    observations.push({
      source: "twitter",
      observedAt,
      sourceRecordId: id,
      fingerprint: fingerprint({ collection, id, tweet: tweet as unknown as JsonObject } as JsonObject),
      payload: tweet as unknown as JsonObject,
      artifactPaths: [],
    });
    records.push({
      source: "twitter",
      collection: "tweets",
      kind: "entity",
      type: "twitter.tweet",
      sourceId: id,
      happenedAt,
      observedAt,
      title: tweet.text?.slice(0, 120) || id,
      url: id ? `https://x.com/i/web/status/${id}` : null,
      bodyText: tweet.text || null,
      artifactRefs: [],
      payload: tweet as unknown as JsonObject,
    });
    records.push({
      source: "twitter",
      collection: "profiles",
      kind: "entity",
      type: "twitter.profile",
      sourceId: profileId(tweet),
      happenedAt: null,
      observedAt,
      title: author.displayName,
      url: author.handle ? `https://x.com/${author.handle}` : null,
      bodyText: null,
      artifactRefs: [],
      payload: author as JsonObject,
    });
    if (collection === "bookmarks" || collection === "likes") {
      records.push({
        source: "twitter",
        collection,
        kind: "relation",
        type: collection === "bookmarks" ? "twitter.bookmark.current" : "twitter.like.current",
        sourceId: `${collection}:${id}`,
        happenedAt: null,
        observedAt,
        title: tweet.text?.slice(0, 120) || id,
        url: id ? `https://x.com/i/web/status/${id}` : null,
        bodyText: tweet.text || null,
        artifactRefs: [],
        payload: withTweetDisplay({ collection, tweet } as unknown as JsonObject, display),
      });
    }
    if (shouldEmitEvent(id)) {
      records.push({
        source: "twitter",
        collection,
        kind: "event",
        type: collectionEventType(collection),
        sourceId: `${collection}:${id}`,
        happenedAt: collection === "authored" ? happenedAt : observedAt,
        observedAt,
        title: tweet.text?.slice(0, 120) || id,
        url: id ? `https://x.com/i/web/status/${id}` : null,
        bodyText: tweet.text || null,
        artifactRefs: [],
        payload: withTweetDisplay({ collection, tweet } as unknown as JsonObject, display),
      });
    }
    const reason = collection === "bookmarks" ? "live_bookmark" : collection === "likes" ? "live_like" : "live_authored";
    const target = tweetTarget(id, reason, sourceRecordId, observedAt);
    if (target) enrichmentTargets.push(target);
    enrichmentTargets.push(...quoteAndReplyTargets(tweet as unknown as JsonObject, sourceRecordId, observedAt));
  }
  return { observations, records, enrichmentTargets };
}

function normalizeFollowing(users: unknown[], nextCursor: string | null, accountId: string, observedAt: Date) {
  const payload: JsonObject = {
    accountId,
    count: users.length,
    complete: !nextCursor,
    nextCursor,
    users: users as JsonObject[],
  };
  const observations: RawObservation[] = [
    {
      source: "twitter",
      observedAt,
      sourceRecordId: `${accountId}:${observedAt.toISOString()}`,
      fingerprint: fingerprint(payload as JsonObject),
      payload: payload as JsonObject,
      artifactPaths: [],
    },
  ];
  const records: TraceRecord[] = [];
  records.push({
    source: "twitter",
    collection: "following",
    kind: "relation",
    type: "twitter.following.snapshot",
    sourceId: `${accountId}:${observedAt.toISOString()}`,
    happenedAt: observedAt,
    observedAt,
    title: `Following snapshot (${users.length})`,
    url: null,
    bodyText: null,
    artifactRefs: [],
    payload: payload as JsonObject,
  });
  for (const user of users) {
    if (!user || typeof user !== "object") continue;
    const row = user as Record<string, unknown>;
    const id = String(row.id || row.rest_id || row.userId || row.username || fingerprint(row as JsonObject));
    const username = typeof row.username === "string" ? row.username : null;
    records.push({
      source: "twitter",
      collection: "profiles",
      kind: "entity",
      type: "twitter.profile",
      sourceId: id,
      happenedAt: null,
      observedAt,
      title: typeof row.name === "string" ? row.name : username,
      url: username ? `https://x.com/${username}` : null,
      bodyText: typeof row.description === "string" ? row.description : null,
      artifactRefs: [],
      payload: row as JsonObject,
    });
    records.push({
      source: "twitter",
      collection: "following",
      kind: "relation",
      type: "twitter.following",
      sourceId: `${accountId}:${id}`,
      happenedAt: observedAt,
      observedAt,
      title: username ? `Following @${username}` : `Following ${id}`,
      url: username ? `https://x.com/${username}` : null,
      bodyText: null,
      artifactRefs: [],
      payload: { accountId, profileId: id, user: row } as JsonObject,
    });
  }
  return { observations, records };
}
