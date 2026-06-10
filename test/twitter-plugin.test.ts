import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { JsonObject, PluginContext, RecordPage, SyncRequest, TraceQuery, TraceRecord } from "../src/core/types";
import { BirdClient, type BirdClientConfig, type BirdFollowingPage } from "../src/plugins/builtin/twitter/bird-client";
import {
  enqueueUnresolvedTweetTargets,
  type TweetEnrichmentFetcher,
  type TweetEnrichmentTarget,
  type TwitterEnrichmentState,
} from "../src/plugins/builtin/twitter/enrichment";
import { looksLikeAuthFailure } from "../src/plugins/builtin/twitter/rate-limit";
import { TwitterPlugin } from "../src/plugins/builtin/twitter/plugin";

const originalPage = BirdClient.prototype.page;
const originalFollowing = BirdClient.prototype.following;
const originalCheck = BirdClient.prototype.check;
const originalClient = (BirdClient.prototype as unknown as { client: unknown }).client;

setDefaultTimeout(15_000);

afterEach(() => {
  BirdClient.prototype.page = originalPage;
  BirdClient.prototype.following = originalFollowing;
  BirdClient.prototype.check = originalCheck;
  (BirdClient.prototype as unknown as { client: unknown }).client = originalClient;
});

test("twitter backfill refuses live transport and requires official X archive import", async () => {
  const plugin = new TwitterPlugin();
  const result = await plugin.sync(context(), request(), {
    version: 1,
    state: { existing: true },
  });

  expect(result.partial).toBe(true);
  expect(result.completed).toBe(false);
  expect(result.records).toHaveLength(0);
  expect(result.observations).toHaveLength(0);
  expect(result.health[0]?.code).toBe("twitter_provider_export_required");
  expect(((result.health[0]?.detail as JsonObject).nextCommand)).toBe("nutshell import twitter <provider-export> --json");
  expect(result.health[0]?.guidance?.state).toBe("ready_empty");
  expect(result.health[0]?.guidance?.fix.length).toBeGreaterThan(0);
  expect(result.health[0]?.guidance?.confirm).toBe("nutshell import twitter <x-archive.zip> --json");
  expect(result.nextCheckpoint).toEqual({ existing: true });
});

// "twitter finding catalog attaches actionable guidance to every code" was
// removed by the test traceability audit (docs/test-traceability.md): strictly
// weaker duplicate of test/finding-guidance.test.ts "every spec carries a valid
// state, a concrete fix, and a runnable confirm command", which iterates every
// plugin catalog (including TWITTER_FINDINGS) with stronger assertions.
test("twitter auth check fails closed even when account identity is configured", async () => {
  (BirdClient.prototype as unknown as { client: () => Promise<unknown> }).client = async () => ({
    getCurrentUser: async () => ({ success: false, error: "401 unauthorized" }),
  });
  const client = new BirdClient(birdConfig({ accountUserId: "12345", accountHandle: "winterfell" }));

  const result = await client.check(new AbortController().signal);

  expect(result.ok).toBe(false);
  expect(result.authFailed).toBe(true);
  expect(result.text).toContain("401");
});

test("twitter health probe reports Chrome Safe Storage as a permission block", async () => {
  BirdClient.prototype.check = async () => ({
    ok: false,
    text: "Timed out after 10000ms reading Chrome Safe Storage from macOS Keychain.",
    rateLimited: false,
    authFailed: false,
  });
  const plugin = new TwitterPlugin();

  const findings = await plugin.check(context());

  expect(findings).toHaveLength(1);
  expect(findings[0]?.code).toBe("twitter_keychain_blocked");
  expect(findings[0]?.message).toContain("macOS blocked access to Chrome Safe Storage");
  expect((findings[0]?.detail as JsonObject).reason).toBe("chrome_safe_storage_keychain");
  expect(findings[0]?.guidance?.state).toBe("needs_permission");
  expect(findings[0]?.guidance?.fix).toContain("Chrome Safe Storage");
  expect(findings[0]?.guidance?.confirm).toBe("nutshell doctor twitter");
});

test("missing X auth cookies classify as signed out, not a transient failure", async () => {
  // Regression: the v0.1.23 signed-out VM gate caught buildClient's own
  // "X auth cookies missing" message routing to twitter_session_check_failed
  // (blocked_bug, "retry shortly") instead of telling the user to sign in.
  expect(looksLikeAuthFailure("X auth cookies missing; warnings=[]")).toBe(true);
  BirdClient.prototype.check = async () => {
    const text = "Error: X auth cookies missing; warnings=[]";
    return { ok: false, text, rateLimited: false, authFailed: looksLikeAuthFailure(text) };
  };
  const plugin = new TwitterPlugin();

  const findings = await plugin.check(context());

  expect(findings).toHaveLength(1);
  expect(findings[0]?.code).toBe("twitter_signed_out");
  expect(findings[0]?.guidance?.state).toBe("needs_auth");
});

test("twitter health probe reports signed-out sessions as needs_auth", async () => {
  BirdClient.prototype.check = async () => ({
    ok: false,
    text: "401 unauthorized: login required",
    rateLimited: false,
    authFailed: true,
  });
  const plugin = new TwitterPlugin();

  const findings = await plugin.check(context());

  expect(findings).toHaveLength(1);
  expect(findings[0]?.code).toBe("twitter_signed_out");
  expect(findings[0]?.guidance?.state).toBe("needs_auth");
  expect(findings[0]?.guidance?.url).toBe("https://x.com");
  expect(findings[0]?.guidance?.fix).toContain("x.com");
  expect(findings[0]?.guidance?.confirm).toBe("nutshell doctor twitter");
});

test("twitter health probe reports non-auth session check failures as blocked bug", async () => {
  BirdClient.prototype.check = async () => ({
    ok: false,
    text: "X current user check timed out after 30000ms",
    rateLimited: false,
    authFailed: false,
  });
  const plugin = new TwitterPlugin();

  const findings = await plugin.check(context());

  expect(findings).toHaveLength(1);
  expect(findings[0]?.code).toBe("twitter_session_check_failed");
  expect(findings[0]?.message).toBe("X browser session check failed");
  expect(findings[0]?.guidance?.state).toBe("blocked_bug");
  expect(findings[0]?.guidance?.fix.length).toBeGreaterThan(0);
  expect(findings[0]?.guidance?.confirm).toBe("nutshell doctor twitter");
});

test("twitter health probe reports rate limits without a duplicate session finding", async () => {
  BirdClient.prototype.check = async () => ({
    ok: false,
    text: "429 too many requests",
    rateLimited: true,
    authFailed: false,
  });
  const plugin = new TwitterPlugin();

  const findings = await plugin.check(context());

  expect(findings.map((item) => item.code)).toEqual(["twitter_rate_limited"]);
  expect(findings[0]?.guidance?.state).toBe("blocked_bug");
  expect(findings[0]?.guidance?.fix).toContain("rate limit");
  expect(findings[0]?.guidance?.confirm).toBe("nutshell doctor twitter");
});

test("twitter internal timeout override fails closed when Bird library shape changes", () => {
  const client = new BirdClient(birdConfig());
  const installFetchGuard = (client as unknown as { installFetchGuard: (target: unknown) => void }).installFetchGuard.bind(client);

  expect(() => installFetchGuard({})).toThrow("@steipete/bird fetchWithTimeout API changed");
});

test("twitter recent sync skips fresh following snapshots during scheduled all-collection runs", async () => {
  let followingCalls = 0;
  BirdClient.prototype.following = (async (): Promise<BirdFollowingPage> => {
    followingCalls += 1;
    throw new Error("following should not be fetched while snapshot is fresh");
  }) as typeof BirdClient.prototype.following;

  const plugin = new TwitterPlugin();
  const result = await plugin.sync(context({ collections: ["following"], followingSnapshotTtlMs: 6 * 60 * 60 * 1000 }), recentRequest([]), {
    version: 1,
    state: {
      recent: {
        following: {
          lastRunAt: "2026-05-22T11:30:00.000Z",
          saturated: true,
          partial: false,
        },
      },
    },
  });

  expect(followingCalls).toBe(0);
  expect(result.completed).toBe(true);
  expect(result.partial).toBe(false);
  expect(((result.metrics as JsonObject).following as JsonObject).skipped).toBe(true);
});

test("twitter recent sync forces following snapshot when explicitly requested", async () => {
  let followingCalls = 0;
  BirdClient.prototype.following = (async (): Promise<BirdFollowingPage> => {
    followingCalls += 1;
    return { users: [{ id: "user-1", username: "someone", name: "Someone" }], nextCursor: null };
  }) as typeof BirdClient.prototype.following;

  const plugin = new TwitterPlugin();
  const result = await plugin.sync(context({ collections: ["following"], followingSnapshotTtlMs: 6 * 60 * 60 * 1000 }), recentRequest(["following"]), {
    version: 1,
    state: {
      recent: {
        following: {
          lastRunAt: "2026-05-22T11:30:00.000Z",
          saturated: true,
          partial: false,
        },
      },
    },
  });

  expect(followingCalls).toBe(1);
  expect(result.completed).toBe(true);
  expect(result.partial).toBe(false);
  expect(((result.metrics as JsonObject).following as JsonObject).count).toBe(1);
  expect(result.records.some((record) => record.type === "twitter.following.snapshot")).toBe(true);
});

test("twitter recent sync caps scheduled page walks", async () => {
  let pageCalls = 0;
  BirdClient.prototype.page = (async () => {
    pageCalls += 1;
    return {
      tweets: [
        {
          id: `tweet-${pageCalls}`,
          text: `tweet ${pageCalls}`,
          createdAt: "2026-05-22T12:00:00.000Z",
          author: { id: "user-1", username: "someone", name: "Someone" },
        },
      ],
      nextCursor: `cursor-${pageCalls}`,
    };
  }) as typeof BirdClient.prototype.page;

  const plugin = new TwitterPlugin();
  const result = await plugin.sync(context({ collections: ["likes"], recentMaxPages: 2, maxPages: 50, delayMs: 0 }), recentRequest([]), {
    version: 1,
    state: { knownIds: { likes: ["older-known-id"] } },
  });

  expect(pageCalls).toBe(2);
  expect(result.partial).toBe(true);
  expect(((result.metrics as JsonObject).likes as JsonObject).pages).toBe(2);
});

test("twitter recent seed establishes likes baseline without timeline events", async () => {
  BirdClient.prototype.page = (async () => ({
    tweets: [
      {
        id: "tweet-seed",
        text: "Existing liked post seen during setup",
        createdAt: "2025-02-12T16:45:00.000Z",
        author: { id: "user-1", username: "someone", name: "Someone" },
      },
    ],
    nextCursor: null,
  })) as typeof BirdClient.prototype.page;

  const plugin = new TwitterPlugin();
  const result = await plugin.sync(context({ collections: ["likes"], recentMaxPages: 1, maxPages: 1, delayMs: 0 }), recentRequest(["likes"]), {
    version: 1,
    state: {},
  });

  expect(result.records.some((record) => record.type === "twitter.tweet")).toBe(true);
  expect(result.records.some((record) => record.type === "twitter.like.current")).toBe(true);
  expect(result.records.some((record) => record.type === "twitter.liked")).toBe(false);
  expect(((result.metrics as JsonObject).likes as JsonObject).seeded).toBe(true);
  expect(((result.nextCheckpoint as JsonObject).knownIds as JsonObject).likes).toEqual(["tweet-seed"]);
});

test("twitter recent collection events stay on the collection sync day", async () => {
  BirdClient.prototype.page = (async () => ({
    tweets: [
      {
        id: "tweet-old",
        text: "An older liked post collected today",
        createdAt: "2025-02-12T16:45:00.000Z",
        author: { id: "user-1", username: "someone", name: "Someone" },
      },
    ],
    nextCursor: null,
  })) as typeof BirdClient.prototype.page;

  const plugin = new TwitterPlugin();
  const result = await plugin.sync(context({ collections: ["bookmarks"], recentMaxPages: 1, maxPages: 1, delayMs: 0 }), recentRequest(["bookmarks"]), {
    version: 1,
    state: { knownIds: { bookmarks: ["already-known"] } },
  });

  const tweet = result.records.find((record) => record.type === "twitter.tweet");
  const current = result.records.find((record) => record.type === "twitter.bookmark.current");
  const bookmark = result.records.find((record) => record.type === "twitter.bookmarked");
  expect(tweet?.happenedAt?.toISOString()).toBe("2025-02-12T16:45:00.000Z");
  expect(current?.kind).toBe("relation");
  expect(bookmark?.happenedAt?.toISOString()).toBe("2026-05-22T12:00:00.000Z");
});

test("twitter recent sync does not refresh known like events into today", async () => {
  BirdClient.prototype.page = (async () => ({
    tweets: [
      {
        id: "tweet-known",
        text: "Known liked post should not become today's event",
        createdAt: "2025-02-12T16:45:00.000Z",
        author: { id: "user-1", username: "someone", name: "Someone" },
      },
    ],
    nextCursor: null,
  })) as typeof BirdClient.prototype.page;

  const plugin = new TwitterPlugin();
  const result = await plugin.sync(context({ collections: ["likes"], recentMaxPages: 1, maxPages: 1, delayMs: 0 }), recentRequest(["likes"]), {
    version: 1,
    state: { knownIds: { likes: ["tweet-known"] } },
  });

  expect(result.records.some((record) => record.type === "twitter.tweet")).toBe(true);
  expect(result.records.some((record) => record.type === "twitter.like.current")).toBe(true);
  expect(result.records.some((record) => record.type === "twitter.liked")).toBe(false);
  expect(((result.metrics as JsonObject).likes as JsonObject).saturated).toBe(true);
});

test("twitter live sync enqueues tweet enrichment and writes display payloads", async () => {
  BirdClient.prototype.page = (async () => ({
    tweets: [
      {
        id: "1234567890123456789",
        text: "A bookmarked post that should be enriched",
        createdAt: "2025-02-12T16:45:00.000Z",
        author: { id: "user-1", username: "someone", name: "Someone" },
      },
    ],
    nextCursor: null,
  })) as typeof BirdClient.prototype.page;

  const plugin = new TwitterPlugin();
  const result = await plugin.sync(context({ collections: ["bookmarks"], recentMaxPages: 1, maxPages: 1, delayMs: 0 }), recentRequest(["bookmarks"]), {
    version: 1,
    state: { knownIds: { bookmarks: ["already-known"] } },
  });

  const event = result.records.find((record) => record.type === "twitter.bookmarked");
  const display = (event?.payload as JsonObject).display as JsonObject;
  const queue = (((result.nextCheckpoint as JsonObject).enrichment as JsonObject).queue as JsonObject);
  expect(display.status).toBe("pending");
  expect(display.tweetId).toBe("1234567890123456789");
  expect(queue["1234567890123456789"]).toBeTruthy();
  expect(((result.metrics as JsonObject).bookmarks as JsonObject).enrichmentQueued).toBe(1);
});

test("twitter live sync skips terminal enrichment records and keeps retryable targets", async () => {
  const terminalEnriched = "1111111111111111111";
  const newId = "2222222222222222222";
  const temporaryId = "3333333333333333333";
  const rateLimitedId = "4444444444444444444";
  const malformedId = "5555555555555555555";
  const terminalUnavailable = "6666666666666666666";
  const terminalPermanent = "7777777777777777777";
  const relationTweet = "8888888888888888888";
  const quotedTerminal = "9999999999999999999";
  const replyRetryable = "1010101010101010101";
  const rateRetryAt = "2026-05-23T12:00:00.000Z";

  BirdClient.prototype.page = (async () => ({
    tweets: [
      tweet(terminalEnriched),
      tweet(newId),
      tweet(temporaryId),
      tweet(rateLimitedId),
      tweet(malformedId),
      tweet(terminalUnavailable),
      tweet(terminalPermanent),
      {
        ...tweet(relationTweet),
        quotedTweet: { id: quotedTerminal },
        inReplyToStatusId: replyRetryable,
      },
    ],
    nextCursor: null,
  })) as typeof BirdClient.prototype.page;

  const seedRecords = [
    enrichmentRecord(terminalEnriched, "enriched"),
    enrichmentRecord(temporaryId, "temporary_failure"),
    enrichmentRecord(rateLimitedId, "rate_limited"),
    enrichmentRecord(malformedId, null),
    enrichmentRecord(terminalUnavailable, "unavailable"),
    enrichmentRecord(terminalPermanent, "permanent_failure"),
    enrichmentRecord(quotedTerminal, "enriched"),
    enrichmentRecord(replyRetryable, "temporary_failure"),
  ];

  const plugin = new TwitterPlugin();
  const result = await plugin.sync(
    context({ collections: ["bookmarks"], recentMaxPages: 1, maxPages: 1, delayMs: 0 }, seedRecords),
    recentRequest(["bookmarks"]),
    {
      version: 1,
      state: {
        knownIds: { bookmarks: ["already-known"] },
        enrichment: {
          queue: {
            [terminalEnriched]: {
              tweetId: terminalEnriched,
              reasons: ["archive_like"],
              sourceRecordIds: [`likes:${terminalEnriched}`],
              firstSeenAt: "2026-05-21T12:00:00.000Z",
              attempts: 1,
              nextAttemptAt: null,
              lastErrorCode: null,
              lastErrorMessage: null,
            },
            [rateLimitedId]: {
              tweetId: rateLimitedId,
              reasons: ["archive_like"],
              sourceRecordIds: [`likes:${rateLimitedId}`],
              firstSeenAt: "2026-05-21T12:00:00.000Z",
              attempts: 2,
              nextAttemptAt: rateRetryAt,
              lastErrorCode: "rate_limited",
              lastErrorMessage: "too many requests",
            },
          },
        },
      },
    },
  );

  const queue = (((result.nextCheckpoint as JsonObject).enrichment as JsonObject).queue as JsonObject);
  expect(queue[terminalEnriched]).toBeUndefined();
  expect(queue[terminalUnavailable]).toBeUndefined();
  expect(queue[terminalPermanent]).toBeUndefined();
  expect(queue[quotedTerminal]).toBeUndefined();
  expect(queue[newId]).toBeTruthy();
  expect(queue[temporaryId]).toBeTruthy();
  expect(queue[rateLimitedId]).toBeTruthy();
  expect((queue[rateLimitedId] as JsonObject).nextAttemptAt).toBe(rateRetryAt);
  expect(queue[malformedId]).toBeTruthy();
  expect(queue[relationTweet]).toBeTruthy();
  expect(queue[replyRetryable]).toBeTruthy();
});

test("twitter live sync merges duplicate primary, quoted, and reply enrichment targets", async () => {
  const sharedId = "1234567890123456789";
  const parentId = "9876543210987654321";
  BirdClient.prototype.page = (async () => ({
    tweets: [
      tweet(sharedId),
      {
        ...tweet("2234567890123456789"),
        quotedTweet: { id: sharedId },
        inReplyToStatusId: parentId,
      },
      {
        ...tweet("3234567890123456789"),
        inReplyToStatusId: parentId,
      },
    ],
    nextCursor: null,
  })) as typeof BirdClient.prototype.page;

  const plugin = new TwitterPlugin();
  const result = await plugin.sync(context({ collections: ["bookmarks"], recentMaxPages: 1, maxPages: 1, delayMs: 0 }), recentRequest(["bookmarks"]), {
    version: 1,
    state: { knownIds: { bookmarks: ["already-known"] } },
  });

  const queue = (((result.nextCheckpoint as JsonObject).enrichment as JsonObject).queue as JsonObject);
  expect(Object.keys(queue).sort()).toEqual([parentId, sharedId, "2234567890123456789", "3234567890123456789"].sort());
  expect(((queue[sharedId] as JsonObject).reasons as string[]).sort()).toEqual(["live_bookmark", "quoted_tweet"]);
  expect(((queue[sharedId] as JsonObject).sourceRecordIds as string[]).sort()).toEqual([`bookmarks:${sharedId}`, "bookmarks:2234567890123456789"].sort());
  expect(((queue[parentId] as JsonObject).reasons as string[])).toEqual(["reply_parent"]);
  expect(((queue[parentId] as JsonObject).sourceRecordIds as string[]).sort()).toEqual(["bookmarks:2234567890123456789", "bookmarks:3234567890123456789"].sort());
});

test("twitter enrichment queue lookup handles large mixed terminal and retryable batches", async () => {
  const terminalIds = Array.from({ length: 450 }, (_, index) => generatedTweetId(index));
  const retryableIds = Array.from({ length: 125 }, (_, index) => generatedTweetId(index + 1_000));
  const missingIds = Array.from({ length: 125 }, (_, index) => generatedTweetId(index + 2_000));
  const recordsById = new Map<string, TraceRecord>();
  terminalIds.forEach((id, index) => {
    const statuses = ["enriched", "unavailable", "permanent_failure"];
    recordsById.set(id, enrichmentRecord(id, statuses[index % statuses.length] ?? "enriched"));
  });
  retryableIds.forEach((id, index) => {
    const statuses = ["pending", "temporary_failure", "rate_limited", null];
    recordsById.set(id, enrichmentRecord(id, statuses[index % statuses.length] ?? null));
  });
  const queryBatchSizes: number[] = [];
  const records = {
    async query(query: TraceQuery): Promise<RecordPage> {
      const sourceIds = query.sourceIds ?? [];
      queryBatchSizes.push(sourceIds.length);
      const pageRecords = sourceIds.map((id) => recordsById.get(id)).filter((record): record is TraceRecord => Boolean(record));
      return { records: pageRecords, total: pageRecords.length, limit: query.limit ?? 200, offset: query.offset ?? 0 };
    },
  };
  const state: TwitterEnrichmentState = {
    queue: {
      [terminalIds[0]!]: queuedTarget(terminalIds[0]!),
      [retryableIds[0]!]: { ...queuedTarget(retryableIds[0]!), nextAttemptAt: "2026-05-23T12:00:00.000Z" },
    },
  };
  const now = new Date("2026-05-22T12:00:00.000Z");
  const targets: TweetEnrichmentTarget[] = [...terminalIds, ...retryableIds, ...missingIds].map((tweetId) => ({
    tweetId,
    reason: "archive_like",
    sourceRecordIds: [`likes:${tweetId}`],
    firstSeenAt: now,
  }));
  targets.push({
    tweetId: retryableIds[0]!,
    reason: "quoted_tweet",
    sourceRecordIds: ["quote-source"],
    firstSeenAt: now,
  });

  await enqueueUnresolvedTweetTargets(records, state, targets);

  expect(queryBatchSizes.length).toBeGreaterThan(1);
  expect(queryBatchSizes.every((size) => size <= 400)).toBe(true);
  for (const id of terminalIds) expect(state.queue?.[id]).toBeUndefined();
  for (const id of retryableIds) expect(state.queue?.[id]).toBeTruthy();
  for (const id of missingIds) expect(state.queue?.[id]).toBeTruthy();
  expect((state.queue?.[retryableIds[0]!] as JsonObject).nextAttemptAt).toBe("2026-05-23T12:00:00.000Z");
  expect(((state.queue?.[retryableIds[0]!] as JsonObject).reasons as string[]).sort()).toEqual(["archive_like", "quoted_tweet"]);
  expect(((state.queue?.[retryableIds[0]!] as JsonObject).sourceRecordIds as string[]).sort()).toEqual([`likes:${retryableIds[0]}`, "quote-source"].sort());
});

test("twitter enrichment stores cached tweet display data and clears completed queue items", async () => {
  const fetcher: TweetEnrichmentFetcher = {
    async fetch(tweetId) {
      return {
        status: "enriched",
        errorCode: null,
        errorMessage: null,
        tweet: {
          tweetId,
          canonicalUrl: `https://x.com/someone/status/${tweetId}`,
          text: "Enriched tweet text",
          createdAt: new Date("2026-05-22T12:00:00.000Z"),
          author: {
            id: "user-1",
            name: "Someone",
            username: "someone",
            avatarUrl: "https://example.com/avatar.jpg",
            verified: false,
            blueVerified: true,
          },
          media: [{ type: "photo", url: "https://example.com/photo.jpg", previewUrl: "https://example.com/preview.jpg", width: 1200, height: 800 }],
          quotedTweetId: "2222222222222222222",
          quotedTweet: {
            tweetId: "2222222222222222222",
            canonicalUrl: "https://x.com/quoted/status/2222222222222222222",
            text: "Quoted text",
            authorName: "Quoted",
            authorUsername: "quoted",
            authorAvatarUrl: "https://example.com/quoted.jpg",
            mediaPreviewUrl: "https://example.com/quoted-media.jpg",
          },
          parentTweetId: "3333333333333333333",
          parentTweet: {
            tweetId: "3333333333333333333",
            canonicalUrl: "https://x.com/parent/status/3333333333333333333",
            text: "Parent text",
            authorName: "Parent",
            authorUsername: "parent",
            authorAvatarUrl: "https://example.com/parent.jpg",
            mediaPreviewUrl: null,
          },
          raw: { fixture: true },
        },
      };
    },
  };

  const plugin = new TwitterPlugin(fetcher);
  const result = await plugin.enrich(context(), {
    source: "twitter",
    limit: 10,
    dryRun: false,
    budget: { maxRuntimeMs: 30_000, maxRequests: 10, minDelayMs: 0, stopOnRateLimit: true },
  }, {
    version: 1,
    state: {
      enrichment: {
        queue: {
          "1111111111111111111": {
            tweetId: "1111111111111111111",
            reasons: ["archive_like"],
            sourceRecordIds: ["likes:1111111111111111111"],
            firstSeenAt: "2026-05-22T11:00:00.000Z",
            attempts: 0,
            nextAttemptAt: null,
            lastErrorCode: null,
            lastErrorMessage: null,
          },
        },
      },
    },
  });

  expect(result.records).toHaveLength(1);
  expect(result.records[0]?.type).toBe("twitter.tweet_enrichment");
  const payload = result.records[0]?.payload as JsonObject;
  const enriched = payload.enriched as JsonObject;
  const author = enriched.author as JsonObject;
  expect(payload.status).toBe("enriched");
  expect(author.avatarUrl).toBe("https://example.com/avatar.jpg");
  expect(enriched.quotedTweetId).toBe("2222222222222222222");
  expect(enriched.parentTweetId).toBe("3333333333333333333");
  expect(Object.keys((((result.nextCheckpoint as JsonObject).enrichment as JsonObject).queue as JsonObject))).toEqual([]);
});

test("twitter enrichment rate limits stop the current run and schedule retry", async () => {
  const fetcher: TweetEnrichmentFetcher = {
    async fetch() {
      return { status: "rate_limited", tweet: null, errorCode: "rate_limited", errorMessage: "too many requests" };
    },
  };

  const plugin = new TwitterPlugin(fetcher);
  const result = await plugin.enrich(context(), {
    source: "twitter",
    limit: 10,
    dryRun: false,
    budget: { maxRuntimeMs: 30_000, maxRequests: 10, minDelayMs: 0, stopOnRateLimit: true },
  }, {
    version: 1,
    state: {
      enrichment: {
        queue: {
          "1111111111111111111": {
            tweetId: "1111111111111111111",
            reasons: ["archive_like"],
            sourceRecordIds: ["likes:1111111111111111111"],
            firstSeenAt: "2026-05-22T11:00:00.000Z",
            attempts: 0,
            nextAttemptAt: null,
            lastErrorCode: null,
            lastErrorMessage: null,
          },
        },
      },
    },
  });

  const queue = (((result.nextCheckpoint as JsonObject).enrichment as JsonObject).queue as JsonObject);
  const queued = queue["1111111111111111111"] as JsonObject;
  expect(result.partial).toBe(true);
  expect(result.health[0]?.code).toBe("twitter_enrichment_rate_limited");
  expect(result.health[0]?.guidance?.state).toBe("blocked_bug");
  expect(result.health[0]?.guidance?.fix.length).toBeGreaterThan(0);
  expect(result.health[0]?.guidance?.confirm).toBe("nutshell doctor twitter");
  expect(queued.lastErrorCode).toBe("rate_limited");
  expect(typeof queued.nextAttemptAt).toBe("string");
});

test("generic runtime and store modules do not encode twitter enrichment semantics", () => {
  const files = [
    join(import.meta.dir, "../src/store/schema.sql.ts"),
    join(import.meta.dir, "../src/store/migrations.ts"),
    join(import.meta.dir, "../src/store/interface.ts"),
    join(import.meta.dir, "../src/store/sqlite-store.ts"),
    join(import.meta.dir, "../src/runtime/trace-runtime.ts"),
  ];
  // "rate_limited" is banned as the quoted enrichment-state literal; the
  // generic catalog naming contract ("codes ending in _rate_limited back off")
  // in the scheduler is not twitter knowledge.
  const forbidden = ["twitter.tweet_enrichment", "enriched", "unavailable", "permanent_failure", '"rate_limited"', "temporary_failure"];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const token of forbidden) expect(text.includes(token), `${file} should not contain ${token}`).toBe(false);
  }
});

test("production twitter paths do not shell out to Bird CLI or BirdClaw", () => {
  const files = [
    join(import.meta.dir, "../src/plugins/builtin/twitter/plugin.ts"),
    join(import.meta.dir, "../src/plugins/builtin/twitter/bird-client.ts"),
    join(import.meta.dir, "../src/plugins/builtin/twitter/x-archive.ts"),
    join(import.meta.dir, "../src/runtime/trace-runtime.ts"),
  ];
  const forbiddenSpawn = /(runProcess|Bun\.spawn|spawnSync)\s*\(\s*(?:\[)?\s*["'`](?:[^"'`]*\/)?bird(?:claw)?["'`]/;
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    expect(text, `${file} must not execute bird or birdclaw`).not.toMatch(forbiddenSpawn);
    expect(text, `${file} must not read BirdClaw state`).not.toMatch(/\.birdclaw|birdclaw\.sqlite|backfill-state\.json/);
  }
});

function request(): SyncRequest {
  return {
    source: "twitter",
    mode: "backfill",
    window: null,
    collections: ["likes"],
    budget: { maxRuntimeMs: 30_000, maxRequests: 3, minDelayMs: 0, stopOnRateLimit: true },
    dryRun: false,
  };
}

function recentRequest(collections: string[]): SyncRequest {
  return {
    source: "twitter",
    mode: "recent",
    window: null,
    collections,
    budget: { maxRuntimeMs: 30_000, maxRequests: 3, minDelayMs: 0, stopOnRateLimit: true },
    dryRun: false,
  };
}

function birdConfig(overrides: Partial<BirdClientConfig> = {}): BirdClientConfig {
  return {
    accountUserId: "",
    accountHandle: "",
    cookieBrowser: "chrome",
    cookieProfile: "",
    cookieTimeoutMs: 1_000,
    timeoutMs: 1_000,
    ...overrides,
  };
}

function tweet(id: string) {
  return {
    id,
    text: `tweet ${id}`,
    createdAt: "2025-02-12T16:45:00.000Z",
    author: { id: `user-${id}`, username: `user${id.slice(-4)}`, name: `User ${id.slice(-4)}` },
  };
}

function generatedTweetId(offset: number): string {
  return (9000000000000000000n + BigInt(offset)).toString();
}

function queuedTarget(tweetId: string): NonNullable<TwitterEnrichmentState["queue"]>[string] {
  return {
    tweetId,
    reasons: ["archive_like"],
    sourceRecordIds: [`likes:${tweetId}`],
    firstSeenAt: "2026-05-21T12:00:00.000Z",
    attempts: 1,
    nextAttemptAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
  };
}

function enrichmentRecord(tweetId: string, status: string | null): TraceRecord {
  const observedAt = new Date("2026-05-21T12:00:00.000Z");
  return {
    source: "twitter",
    collection: "enrichment",
    kind: "entity",
    type: "twitter.tweet_enrichment",
    sourceId: tweetId,
    happenedAt: null,
    observedAt,
    title: tweetId,
    url: `https://x.com/i/web/status/${tweetId}`,
    bodyText: null,
    artifactRefs: [],
    payload: status
      ? {
          tweetId,
          status,
          enriched: null,
          attempts: 1,
          firstSeenAt: observedAt.toISOString(),
          lastAttemptAt: observedAt.toISOString(),
          nextAttemptAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
          updatedAt: observedAt.toISOString(),
        }
      : { tweetId, malformed: true },
  };
}

function context(config: JsonObject = {}, seedRecords: TraceRecord[] = []): PluginContext {
  return {
    root: "/tmp/nutshell-test",
    config: {
      accountId: "acct_primary",
      accountHandle: "android_stern",
      collections: ["likes"],
      maxPages: 10,
      pageSize: 20,
      delayMs: 0,
      ...config,
    },
    logger: { event() {}, warn() {}, error() {} },
    signal: new AbortController().signal,
    now: () => new Date("2026-05-22T12:00:00.000Z"),
    records: recordReader(seedRecords),
    async writeArtifact() {
      return { path: "", contentHash: "", mimeType: null, bytes: 0 };
    },
  };
}

function recordReader(seedRecords: TraceRecord[]) {
  return {
    async query(query: TraceQuery): Promise<RecordPage> {
      const sourceIds = query.sourceIds ? new Set(query.sourceIds) : null;
      const records = seedRecords.filter((record) => {
        if (query.source && record.source !== query.source) return false;
        if (query.kind && record.kind !== query.kind) return false;
        if (query.type && record.type !== query.type) return false;
        if (query.sourceId && record.sourceId !== query.sourceId) return false;
        if (sourceIds && !sourceIds.has(record.sourceId)) return false;
        return true;
      });
      return { records, total: records.length, limit: query.limit ?? 200, offset: query.offset ?? 0 };
    },
  };
}
