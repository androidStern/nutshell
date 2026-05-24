import type { HealthFinding, Json, JsonObject, PluginRecordReader, SyncBudget, TraceRecord } from "../../../core/types";
import { sleep } from "../../../core/time";
import { finding } from "../../interface";

export type TweetEnrichmentStatus =
  | "pending"
  | "enriched"
  | "unavailable"
  | "rate_limited"
  | "temporary_failure"
  | "permanent_failure";

export type TweetEnrichmentReason =
  | "archive_authored"
  | "archive_like"
  | "archive_bookmark"
  | "live_authored"
  | "live_like"
  | "live_bookmark"
  | "quoted_tweet"
  | "reply_parent";

export interface TweetEnrichmentTarget {
  tweetId: string;
  reason: TweetEnrichmentReason;
  sourceRecordIds: string[];
  firstSeenAt: Date;
}

export interface EnrichedTweet {
  tweetId: string;
  canonicalUrl: string;
  text: string | null;
  createdAt: Date | null;
  author: {
    id: string | null;
    name: string | null;
    username: string | null;
    avatarUrl: string | null;
    verified: boolean | null;
    blueVerified: boolean | null;
  };
  media: Array<{
    type: "photo" | "video" | "gif" | "unknown";
    url: string | null;
    previewUrl: string | null;
    width: number | null;
    height: number | null;
  }>;
  quotedTweetId: string | null;
  quotedTweet: EnrichedTweetSummary | null;
  parentTweetId: string | null;
  parentTweet: EnrichedTweetSummary | null;
  raw: Json;
}

export interface EnrichedTweetSummary {
  tweetId: string;
  canonicalUrl: string;
  text: string | null;
  authorName: string | null;
  authorUsername: string | null;
  authorAvatarUrl: string | null;
  mediaPreviewUrl: string | null;
}

export interface TweetDisplayPayload {
  cardKind: "tweet";
  action: "authored" | "liked" | "bookmarked";
  tweetId: string;
  canonicalUrl: string;
  status: TweetEnrichmentStatus;
  tweet: EnrichedTweet | null;
  fallback: {
    text: string | null;
    url: string | null;
    happenedAt: string | null;
    reason: "not_enriched_yet" | "unavailable" | "private_or_deleted" | "temporary_failure" | "rate_limited";
  } | null;
}

type TweetDisplayFallbackReason = NonNullable<TweetDisplayPayload["fallback"]>["reason"];

export interface TweetEnrichmentRecordPayload extends JsonObject {
  tweetId: string;
  status: TweetEnrichmentStatus;
  enriched: JsonObject | null;
  attempts: number;
  firstSeenAt: string;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  updatedAt: string;
}

export type TwitterEnrichmentState = JsonObject & {
  queue?: Record<string, QueuedTweetTarget>;
  lastRunAt?: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastRateLimitedAt?: string;
};

interface QueuedTweetTarget extends JsonObject {
  tweetId: string;
  reasons: string[];
  sourceRecordIds: string[];
  firstSeenAt: string;
  attempts: number;
  nextAttemptAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
}

export interface TweetFetchResult {
  status: TweetEnrichmentStatus;
  tweet: EnrichedTweet | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface TweetEnrichmentFetcher {
  fetch(tweetId: string, signal: AbortSignal): Promise<TweetFetchResult>;
}

export interface EnrichDueOptions {
  now: Date;
  limit: number;
  budget: SyncBudget;
  signal: AbortSignal;
  fetcher: TweetEnrichmentFetcher;
}

export interface EnrichDueResult {
  records: TraceRecord[];
  state: TwitterEnrichmentState;
  health: HealthFinding[];
  metrics: JsonObject;
  partial: boolean;
}

const TERMINAL_ENRICHMENT_STATUSES = new Set<TweetEnrichmentStatus>(["enriched", "unavailable", "permanent_failure"]);
const ENRICHMENT_LOOKUP_CHUNK_SIZE = 400;

export function enqueueTweetTargets(state: TwitterEnrichmentState, targets: TweetEnrichmentTarget[]): number {
  const queue = (state.queue ??= {});
  let inserted = 0;
  for (const target of targets) {
    const tweetId = normalizeTweetId(target.tweetId);
    if (!tweetId) continue;
    const existing = queue[tweetId];
    if (existing) {
      existing.reasons = uniqueStrings([...existing.reasons, target.reason]);
      existing.sourceRecordIds = uniqueStrings([...existing.sourceRecordIds, ...target.sourceRecordIds]);
      continue;
    }
    queue[tweetId] = {
      tweetId,
      reasons: [target.reason],
      sourceRecordIds: uniqueStrings(target.sourceRecordIds),
      firstSeenAt: target.firstSeenAt.toISOString(),
      attempts: 0,
      nextAttemptAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
    };
    inserted += 1;
  }
  return inserted;
}

export async function enqueueUnresolvedTweetTargets(
  records: PluginRecordReader,
  state: TwitterEnrichmentState,
  targets: TweetEnrichmentTarget[],
): Promise<number> {
  const terminalIds = await terminalEnrichmentIds(records, targets);
  const queue = (state.queue ??= {});
  for (const tweetId of terminalIds) delete queue[tweetId];
  return enqueueTweetTargets(
    state,
    targets.filter((target) => !terminalIds.has(normalizeTweetId(target.tweetId))),
  );
}

export async function enrichDueTargets(state: TwitterEnrichmentState, options: EnrichDueOptions): Promise<EnrichDueResult> {
  const queue = state.queue ?? {};
  const due = Object.values(queue)
    .filter((item) => !item.nextAttemptAt || Date.parse(item.nextAttemptAt) <= options.now.getTime())
    .sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt))
    .slice(0, Math.max(0, options.limit));
  const records: TraceRecord[] = [];
  const health: HealthFinding[] = [];
  let enriched = 0;
  let unavailable = 0;
  let temporaryFailures = 0;
  let rateLimited = false;

  for (const item of due) {
    if (options.signal.aborted) break;
    const result = await options.fetcher.fetch(item.tweetId, options.signal);
    const attempts = item.attempts + 1;
    const payload = enrichmentRecordPayload(item, result, attempts, options.now);
    records.push(enrichmentTraceRecord(payload, options.now));
    if (result.status === "enriched" || result.status === "unavailable" || result.status === "permanent_failure") {
      delete queue[item.tweetId];
      if (result.status === "enriched") enriched += 1;
      else unavailable += 1;
    } else {
      item.attempts = attempts;
      item.lastErrorCode = result.errorCode;
      item.lastErrorMessage = result.errorMessage;
      item.nextAttemptAt = retryAt(result.status, attempts, options.now);
      if (result.status === "rate_limited") {
        rateLimited = true;
        state.lastRateLimitedAt = options.now.toISOString();
      } else {
        temporaryFailures += 1;
      }
      if (result.status === "rate_limited" && options.budget.stopOnRateLimit) break;
    }
    if (options.budget.minDelayMs > 0) await sleep(options.budget.minDelayMs, options.signal);
  }

  state.queue = queue;
  state.lastRunAt = options.now.toISOString();
  if (enriched > 0) state.lastSuccessAt = options.now.toISOString();
  if (temporaryFailures > 0 || rateLimited) state.lastFailureAt = options.now.toISOString();
  if (rateLimited) {
    health.push(finding("critical", "twitter", "twitter_enrichment_rate_limited", "Twitter enrichment is rate limited", { pending: Object.keys(queue).length }, options.now));
  } else if (temporaryFailures > 0) {
    health.push(finding("warning", "twitter", "twitter_enrichment_partial", "Some Twitter enrichment requests failed temporarily", { temporaryFailures }, options.now));
  }

  return {
    records,
    state,
    health,
    metrics: {
      due: due.length,
      enriched,
      unavailable,
      temporaryFailures,
      rateLimited,
      pending: Object.keys(queue).length,
    },
    partial: rateLimited || temporaryFailures > 0 || Object.keys(queue).length > 0,
  };
}

export function enrichmentTraceRecord(payload: TweetEnrichmentRecordPayload, observedAt: Date): TraceRecord {
  const enriched = payload.enriched as JsonObject | null;
  const title = typeof enriched?.text === "string" ? enriched.text.slice(0, 120) : `Tweet ${payload.tweetId} ${payload.status}`;
  return {
    source: "twitter",
    collection: "enrichment",
    kind: "entity",
    type: "twitter.tweet_enrichment",
    sourceId: payload.tweetId,
    happenedAt: null,
    observedAt,
    title,
    url: canonicalTweetUrl(payload.tweetId, enriched),
    bodyText: typeof enriched?.text === "string" ? enriched.text : null,
    artifactRefs: [],
    payload,
  };
}

export function buildTweetDisplayPayload(input: {
  action: TweetDisplayPayload["action"];
  tweetId: string;
  fallbackText: string | null;
  fallbackUrl: string | null;
  happenedAt: Date | null;
  enrichment?: TweetEnrichmentRecordPayload | null;
}): TweetDisplayPayload {
  const status = input.enrichment?.status ?? "pending";
  const enriched = input.enrichment?.enriched as JsonObject | null | undefined;
  const tweet = status === "enriched" && enriched ? (enriched as unknown as EnrichedTweet) : null;
  return {
    cardKind: "tweet",
    action: input.action,
    tweetId: input.tweetId,
    canonicalUrl: tweet?.canonicalUrl ?? input.fallbackUrl ?? `https://x.com/i/web/status/${input.tweetId}`,
    status,
    tweet,
    fallback: tweet
      ? null
      : {
          text: input.fallbackText,
          url: input.fallbackUrl,
          happenedAt: input.happenedAt ? input.happenedAt.toISOString() : null,
          reason: fallbackReason(status),
        },
  };
}

export function withTweetDisplay<T extends JsonObject>(
  payload: T,
  display: TweetDisplayPayload,
): T & { display: Json } {
  return { ...payload, display: display as unknown as Json } as T & { display: Json };
}

export function tweetTarget(tweetId: string, reason: TweetEnrichmentReason, sourceRecordId: string, firstSeenAt: Date): TweetEnrichmentTarget | null {
  const normalized = normalizeTweetId(tweetId);
  if (!normalized) return null;
  return { tweetId: normalized, reason, sourceRecordIds: [sourceRecordId], firstSeenAt };
}

export function quoteAndReplyTargets(payload: JsonObject, sourceRecordId: string, firstSeenAt: Date): TweetEnrichmentTarget[] {
  const targets: Array<TweetEnrichmentTarget | null> = [
    tweetTarget(stringAt(payload, "quotedTweetId") || stringAt(payload, "quoted_tweet_id") || stringAt(objectAt(payload, "quotedTweet"), "id"), "quoted_tweet", sourceRecordId, firstSeenAt),
    tweetTarget(stringAt(payload, "inReplyToStatusId") || stringAt(payload, "in_reply_to_status_id_str") || stringAt(payload, "in_reply_to_status_id"), "reply_parent", sourceRecordId, firstSeenAt),
  ];
  const nestedTweet = objectChild(payload, "tweet");
  if (nestedTweet) targets.push(...quoteAndReplyTargets(nestedTweet, sourceRecordId, firstSeenAt));
  return targets.filter((target): target is TweetEnrichmentTarget => Boolean(target));
}

export function normalizeTweetId(value: string | null | undefined): string {
  const match = String(value ?? "").match(/\d{8,22}/);
  return match?.[0] ?? "";
}

async function terminalEnrichmentIds(records: PluginRecordReader, targets: TweetEnrichmentTarget[]): Promise<Set<string>> {
  const candidateIds = uniqueStrings(targets.map((target) => normalizeTweetId(target.tweetId)).filter(Boolean));
  const terminalIds = new Set<string>();
  for (let index = 0; index < candidateIds.length; index += ENRICHMENT_LOOKUP_CHUNK_SIZE) {
    const sourceIds = candidateIds.slice(index, index + ENRICHMENT_LOOKUP_CHUNK_SIZE);
    const page = await records.query({
      source: "twitter",
      kind: "entity",
      type: "twitter.tweet_enrichment",
      sourceIds,
      limit: sourceIds.length,
    });
    for (const record of page.records) {
      if (isTerminalEnrichmentRecord(record)) terminalIds.add(record.sourceId);
    }
  }
  return terminalIds;
}

function isTerminalEnrichmentRecord(record: TraceRecord): boolean {
  const payload = record.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const status = (payload as JsonObject).status;
  return typeof status === "string" && TERMINAL_ENRICHMENT_STATUSES.has(status as TweetEnrichmentStatus);
}

export function canonicalTweetUrl(tweetId: string, enriched?: JsonObject | null): string {
  const author = objectAt(enriched ?? {}, "author");
  const username = stringAt(author, "username");
  return username ? `https://x.com/${username}/status/${tweetId}` : `https://x.com/i/web/status/${tweetId}`;
}

function enrichmentRecordPayload(
  item: QueuedTweetTarget,
  result: TweetFetchResult,
  attempts: number,
  now: Date,
): TweetEnrichmentRecordPayload {
  return {
    tweetId: item.tweetId,
    status: result.status,
    enriched: result.tweet ? (result.tweet as unknown as JsonObject) : null,
    attempts,
    firstSeenAt: item.firstSeenAt,
    lastAttemptAt: now.toISOString(),
    nextAttemptAt: result.status === "temporary_failure" || result.status === "rate_limited" ? retryAt(result.status, attempts, now) : null,
    lastErrorCode: result.errorCode,
    lastErrorMessage: result.errorMessage,
    updatedAt: now.toISOString(),
  };
}

function retryAt(status: TweetEnrichmentStatus, attempts: number, now: Date): string {
  const delayMs = status === "rate_limited" ? 6 * 60 * 60_000 : Math.min(60 * 60_000, 2 ** Math.min(attempts, 8) * 60_000);
  return new Date(now.getTime() + delayMs).toISOString();
}

function fallbackReason(status: TweetEnrichmentStatus): TweetDisplayFallbackReason {
  if (status === "rate_limited") return "rate_limited";
  if (status === "temporary_failure") return "temporary_failure";
  if (status === "unavailable" || status === "permanent_failure") return "private_or_deleted";
  return "not_enriched_yet";
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function objectAt(value: Json, key: string): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const child = value[key];
    if (child && typeof child === "object" && !Array.isArray(child)) return child;
  }
  return {};
}

function objectChild(value: JsonObject, key: string): JsonObject | null {
  const child = value[key];
  return child && typeof child === "object" && !Array.isArray(child) ? child : null;
}

function stringAt(value: JsonObject, key: string): string {
  const child = value[key];
  return typeof child === "string" ? child : "";
}
