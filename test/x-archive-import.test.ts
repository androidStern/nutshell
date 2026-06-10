import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config/config";
import { DEFAULT_SYNC_BUDGET } from "../src/config/defaults";
import type { JsonObject } from "../src/core/types";
import { PluginRegistry } from "../src/plugins/registry";
import { TwitterPlugin } from "../src/plugins/builtin/twitter/plugin";
import type { TweetEnrichmentFetcher } from "../src/plugins/builtin/twitter/enrichment";
import { TraceRuntime } from "../src/runtime/trace-runtime";
import { openStore } from "../src/store/sqlite-store";

test("x archive import commits official archive records", async () => {
  const root = mkdtempSync(join(tmpdir(), "trace-x-archive-"));
  try {
    const data = join(root, "x-archive", "data");
    mkdirSync(data, { recursive: true });
    writeFileSync(
      join(data, "tweets.js"),
      `window.YTD.tweets.part0 = ${JSON.stringify([
        {
          tweet: {
            id_str: "1000000000000000001",
            full_text: "Portable trace systems should avoid machine-specific imports.",
            created_at: "Wed Jan 01 12:00:00 +0000 2025",
          },
        },
      ])}`,
      "utf8",
    );
    writeFileSync(
      join(data, "like.js"),
      `window.YTD.like.part0 = ${JSON.stringify([{ like: { tweetId: "1000000000000000002", fullText: "Liked trace idea", createdAt: "Wed Feb 05 15:30:00 +0000 2025", expandedUrl: "https://x.com/i/web/status/1000000000000000002" } }])}`,
      "utf8",
    );
    writeFileSync(
      join(data, "bookmark.js"),
      `window.YTD.bookmark.part0 = ${JSON.stringify([
        { bookmark: { tweetId: "1000000000000000003", fullText: "Bookmarked trace idea", createdAt: "Wed Feb 12 16:45:00 +0000 2025" } },
        { bookmark: { tweetId: "2022530158654280053", fullText: "Bookmarked without explicit date" } },
      ])}`,
      "utf8",
    );
    writeFileSync(
      join(data, "following.js"),
      `window.YTD.following.part0 = ${JSON.stringify([{ following: { accountId: "400", userLink: "https://x.com/intent/user?user_id=400" } }])}`,
      "utf8",
    );

    const config = loadConfig(root);
    config.data.backfill = { cutoffDate: "2025-01-01", cutoffDates: {}, lookbackMonths: 6 };
    const store = openStore(join(root, "trace.sqlite"));
    const runtime = new TraceRuntime({ root, config, store, registry: new PluginRegistry([new TwitterPlugin()]) });
    const report = await runtime.importProviderExport({
      source: "twitter",
      path: join(root, "x-archive"),
      dryRun: false,
      budget: { maxRuntimeMs: 30_000, maxRequests: 100, minDelayMs: 0, stopOnRateLimit: true },
    });

    expect(report.status).toBe("ok");
    expect((report.metrics as Record<string, unknown>).available).toBe(true);
    expect((report.metrics as Record<string, unknown>).authored).toBe(1);
    expect((report.metrics as Record<string, unknown>).likes).toBe(1);
    expect((report.metrics as Record<string, unknown>).bookmarks).toBe(2);
    expect((report.metrics as Record<string, unknown>).following).toBe(1);
    expect((report.metrics as Record<string, unknown>).enrichmentQueued).toBe(4);
    expect(report.commit?.insertedRecords).toBeGreaterThanOrEqual(4);

    const health = await runtime.health();
    const twitter = health.backfill.find((item) => item.source === "twitter");
    expect(twitter?.bulkBackfill.status).toBe("complete");
    expect(((twitter?.detail as Record<string, unknown>).twitterEnrichment as Record<string, unknown>).pending).toBe(4);
    const records = await store.query({ source: "twitter", limit: 100 });
    const bookmark = records.records.find((record) => record.type === "twitter.bookmarked" && record.sourceId === "bookmarks:1000000000000000003");
    const snowflakeBookmark = records.records.find((record) => record.type === "twitter.bookmarked" && record.sourceId === "bookmarks:2022530158654280053");
    const liked = records.records.find((record) => record.type === "twitter.liked" && record.sourceId === "likes:1000000000000000002");
    expect(((bookmark?.payload as Record<string, unknown>).display as Record<string, unknown>).status).toBe("pending");
    expect(bookmark?.happenedAt?.toISOString()).toBe("2025-02-12T16:45:00.000Z");
    expect(snowflakeBookmark?.happenedAt?.toISOString()).toBe("2026-02-14T04:35:41.273Z");
    expect(liked?.happenedAt?.toISOString()).toBe("2025-02-05T15:30:00.000Z");
    await runtime.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("x archive import flags a bad archive path with import guidance", async () => {
  const plugin = new TwitterPlugin();
  const result = await plugin.importProviderExport(
    {
      root: "/tmp/nutshell-test",
      config: {},
      logger: { event() {}, warn() {}, error() {} },
      signal: new AbortController().signal,
      now: () => new Date("2026-05-22T12:00:00.000Z"),
      records: {
        async query() {
          return { records: [], total: 0, limit: 0, offset: 0 };
        },
      },
      async writeArtifact() {
        return { path: "", contentHash: "", mimeType: null, bytes: 0 };
      },
    },
    {
      source: "twitter",
      path: join(tmpdir(), "missing-x-archive.zip"),
      dryRun: false,
      budget: { maxRuntimeMs: 30_000, maxRequests: 10, minDelayMs: 0, stopOnRateLimit: true },
    },
    { version: 0, state: {} },
  );

  expect(result.partial).toBe(true);
  expect(result.completed).toBe(false);
  expect(result.health[0]?.code).toBe("x_archive_import_issue");
  expect(result.health[0]?.guidance?.state).toBe("blocked_bug");
  expect(result.health[0]?.guidance?.fix).toContain("official X archive");
  expect(result.health[0]?.guidance?.confirm).toBe("nutshell import twitter <x-archive.zip> --json");
});

test("scheduled twitter sync drains queued enrichment by configured limit", async () => {
  const root = mkdtempSync(join(tmpdir(), "trace-x-auto-enrich-"));
  try {
    const archivePath = writeXArchiveFixture(root);
    const config = loadConfig(root);
    config.data.runtime = {
      ...(config.data.runtime as JsonObject),
      projectionAfterSync: false,
      enrichmentMaxRequests: 2,
      enrichmentMaxRuntimeMs: 30_000,
      enrichmentMinDelayMs: 0,
    };
    config.data.plugins = { twitter: { enabled: true, collections: [] } };
    const fetched: string[] = [];
    const fetcher: TweetEnrichmentFetcher = {
      async fetch(tweetId) {
        fetched.push(tweetId);
        return enrichedTweet(tweetId);
      },
    };
    const store = openStore(join(root, "trace.sqlite"));
    const runtime = new TraceRuntime({ root, config, store, registry: new PluginRegistry([new TwitterPlugin(fetcher)]) });

    await runtime.importProviderExport({
      source: "twitter",
      path: archivePath,
      dryRun: false,
      budget: { maxRuntimeMs: 30_000, maxRequests: 100, minDelayMs: 0, stopOnRateLimit: true },
    });
    const beforeQueue = twitterQueueIds(await store.loadCheckpoint("twitter"));

    const report = await runtime.sync({
      source: null,
      mode: "recent",
      window: null,
      collections: [],
      budget: DEFAULT_SYNC_BUDGET,
      dryRun: false,
    });

    const afterQueue = twitterQueueIds(await store.loadCheckpoint("twitter"));
    expect(fetched).toHaveLength(2);
    expect(afterQueue).toHaveLength(beforeQueue.length - 2);
    expect(report.sources[0]?.source).toBe("twitter");
    expect(report.sources[0]?.commit?.checkpointVersion).toBe(2);
    expect(report.sources[0]?.enrichment?.commit?.checkpointVersion).toBe(3);
    expect((report.sources[0]?.enrichment?.metrics as JsonObject).due).toBe(2);
    expect((report.sources[0]?.enrichment?.metrics as JsonObject).pending).toBe(beforeQueue.length - 2);

    const health = await runtime.health();
    const twitter = health.backfill.find((item) => item.source === "twitter");
    const enrichment = (twitter?.detail as JsonObject).twitterEnrichment as JsonObject;
    expect(enrichment.pending).toBe(beforeQueue.length - 2);
    expect(typeof enrichment.lastRunAt).toBe("string");
    expect(typeof enrichment.lastSuccessAt).toBe("string");
    await runtime.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scheduled twitter enrichment stops immediately on rate limit and persists retry state", async () => {
  const root = mkdtempSync(join(tmpdir(), "trace-x-auto-enrich-rate-limit-"));
  try {
    const archivePath = writeXArchiveFixture(root);
    const config = loadConfig(root);
    config.data.runtime = {
      ...(config.data.runtime as JsonObject),
      projectionAfterSync: false,
      enrichmentMaxRequests: 3,
      enrichmentMaxRuntimeMs: 30_000,
      enrichmentMinDelayMs: 0,
      enrichmentStopOnRateLimit: true,
    };
    config.data.plugins = { twitter: { enabled: true, collections: [] } };
    let fetchCalls = 0;
    const fetcher: TweetEnrichmentFetcher = {
      async fetch() {
        fetchCalls += 1;
        return { status: "rate_limited", tweet: null, errorCode: "rate_limited", errorMessage: "too many requests" };
      },
    };
    const store = openStore(join(root, "trace.sqlite"));
    const runtime = new TraceRuntime({ root, config, store, registry: new PluginRegistry([new TwitterPlugin(fetcher)]) });

    await runtime.importProviderExport({
      source: "twitter",
      path: archivePath,
      dryRun: false,
      budget: { maxRuntimeMs: 30_000, maxRequests: 100, minDelayMs: 0, stopOnRateLimit: true },
    });
    const beforeQueue = twitterQueueIds(await store.loadCheckpoint("twitter"));

    const report = await runtime.sync({
      source: null,
      mode: "recent",
      window: null,
      collections: [],
      budget: DEFAULT_SYNC_BUDGET,
      dryRun: false,
    });

    const checkpoint = await store.loadCheckpoint("twitter");
    const state = checkpoint.state as JsonObject;
    const queue = ((state.enrichment as JsonObject).queue as JsonObject);
    const queuedItems = Object.values(queue) as JsonObject[];
    expect(fetchCalls).toBe(1);
    expect(twitterQueueIds(checkpoint)).toHaveLength(beforeQueue.length);
    expect(queuedItems.some((item) => item.lastErrorCode === "rate_limited" && typeof item.nextAttemptAt === "string")).toBe(true);
    expect((state.enrichment as JsonObject).lastRateLimitedAt).toBeTruthy();
    expect(report.status).toBe("critical");
    expect(report.sources[0]?.commit?.checkpointVersion).toBe(2);
    expect(report.sources[0]?.enrichment?.status).toBe("critical");
    expect(report.sources[0]?.enrichment?.findings[0]?.code).toBe("twitter_enrichment_rate_limited");
    expect(report.sources[0]?.enrichment?.findings[0]?.guidance?.state).toBe("blocked_bug");
    expect((report.sources[0]?.enrichment?.findings[0]?.guidance?.fix ?? "").length).toBeGreaterThan(0);
    expect(report.sources[0]?.enrichment?.findings[0]?.guidance?.confirm).toBe("nutshell doctor twitter");
    await runtime.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scheduled twitter enrichment commits successes while keeping temporary failures queued", async () => {
  const root = mkdtempSync(join(tmpdir(), "trace-x-auto-enrich-temporary-"));
  try {
    const archivePath = writeXArchiveFixture(root);
    const config = loadConfig(root);
    config.data.runtime = {
      ...(config.data.runtime as JsonObject),
      projectionAfterSync: false,
      enrichmentMaxRequests: 3,
      enrichmentMaxRuntimeMs: 30_000,
      enrichmentMinDelayMs: 0,
    };
    config.data.plugins = { twitter: { enabled: true, collections: [] } };
    const fetched: string[] = [];
    const fetcher: TweetEnrichmentFetcher = {
      async fetch(tweetId) {
        fetched.push(tweetId);
        if (fetched.length === 2) {
          return { status: "temporary_failure", tweet: null, errorCode: "temporary_failure", errorMessage: "retry later" };
        }
        return enrichedTweet(tweetId);
      },
    };
    const store = openStore(join(root, "trace.sqlite"));
    const runtime = new TraceRuntime({ root, config, store, registry: new PluginRegistry([new TwitterPlugin(fetcher)]) });

    await runtime.importProviderExport({
      source: "twitter",
      path: archivePath,
      dryRun: false,
      budget: { maxRuntimeMs: 30_000, maxRequests: 100, minDelayMs: 0, stopOnRateLimit: true },
    });
    const beforeQueue = twitterQueueIds(await store.loadCheckpoint("twitter"));

    const report = await runtime.sync({
      source: null,
      mode: "recent",
      window: null,
      collections: [],
      budget: DEFAULT_SYNC_BUDGET,
      dryRun: false,
    });

    const checkpoint = await store.loadCheckpoint("twitter");
    const state = checkpoint.state as JsonObject;
    const queue = ((state.enrichment as JsonObject).queue as JsonObject);
    const failedItem = queue[fetched[1]!] as JsonObject;
    const enrichmentRecords = await store.query({ source: "twitter", type: "twitter.tweet_enrichment", sourceIds: fetched, limit: 10 });
    const statusById = Object.fromEntries(enrichmentRecords.records.map((record) => [record.sourceId, (record.payload as JsonObject).status]));
    expect(fetched).toHaveLength(3);
    expect(twitterQueueIds(checkpoint)).toHaveLength(beforeQueue.length - 2);
    expect(statusById[fetched[0]!]).toBe("enriched");
    expect(statusById[fetched[1]!]).toBe("temporary_failure");
    expect(statusById[fetched[2]!]).toBe("enriched");
    expect(failedItem.lastErrorCode).toBe("temporary_failure");
    expect(typeof failedItem.nextAttemptAt).toBe("string");
    expect(report.sources[0]?.commit?.checkpointVersion).toBe(2);
    expect(report.sources[0]?.enrichment?.commit?.checkpointVersion).toBe(3);
    expect(report.sources[0]?.enrichment?.findings[0]?.code).toBe("twitter_enrichment_partial");
    expect(report.sources[0]?.enrichment?.findings[0]?.guidance?.state).toBe("blocked_bug");
    expect((report.sources[0]?.enrichment?.findings[0]?.guidance?.fix ?? "").length).toBeGreaterThan(0);
    await runtime.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scheduled twitter sync dry-run leaves queued enrichment untouched", async () => {
  const root = mkdtempSync(join(tmpdir(), "trace-x-auto-enrich-dry-run-"));
  try {
    const archivePath = writeXArchiveFixture(root);
    const config = loadConfig(root);
    config.data.runtime = {
      ...(config.data.runtime as JsonObject),
      projectionAfterSync: false,
      enrichmentMaxRequests: 2,
      enrichmentMinDelayMs: 0,
    };
    config.data.plugins = { twitter: { enabled: true, collections: [] } };
    let fetchCalls = 0;
    const fetcher: TweetEnrichmentFetcher = {
      async fetch(tweetId) {
        fetchCalls += 1;
        return enrichedTweet(tweetId);
      },
    };
    const store = openStore(join(root, "trace.sqlite"));
    const runtime = new TraceRuntime({ root, config, store, registry: new PluginRegistry([new TwitterPlugin(fetcher)]) });

    await runtime.importProviderExport({
      source: "twitter",
      path: archivePath,
      dryRun: false,
      budget: { maxRuntimeMs: 30_000, maxRequests: 100, minDelayMs: 0, stopOnRateLimit: true },
    });
    const before = await store.loadCheckpoint("twitter");

    const report = await runtime.sync({
      source: null,
      mode: "recent",
      window: null,
      collections: [],
      budget: DEFAULT_SYNC_BUDGET,
      dryRun: true,
    });

    const after = await store.loadCheckpoint("twitter");
    expect(report.sources[0]?.enrichment).toBeUndefined();
    expect(fetchCalls).toBe(0);
    expect(after.version).toBe(before.version);
    expect(after.state).toEqual(before.state);
    await runtime.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("x archive reimport does not resurrect terminal enrichment queue items", async () => {
  const root = mkdtempSync(join(tmpdir(), "trace-x-archive-reimport-"));
  try {
    const archivePath = writeXArchiveFixture(root);
    const config = loadConfig(root);
    const store = openStore(join(root, "trace.sqlite"));
    const fetcher: TweetEnrichmentFetcher = {
      async fetch(tweetId) {
        if (tweetId === "1000000000000000001") {
          return {
            status: "enriched",
            errorCode: null,
            errorMessage: null,
            tweet: {
              tweetId,
              canonicalUrl: `https://x.com/example/status/${tweetId}`,
              text: "Enriched archive tweet",
              createdAt: new Date("2025-01-01T12:00:00.000Z"),
              author: {
                id: "user-1",
                name: "Example",
                username: "example",
                avatarUrl: "https://example.com/avatar.jpg",
                verified: false,
                blueVerified: false,
              },
              media: [],
              quotedTweetId: null,
              quotedTweet: null,
              parentTweetId: null,
              parentTweet: null,
              raw: { fixture: true },
            },
          };
        }
        return { status: "unavailable", tweet: null, errorCode: "unavailable", errorMessage: "not available" };
      },
    };
    const runtime = new TraceRuntime({ root, config, store, registry: new PluginRegistry([new TwitterPlugin(fetcher)]) });

    await runtime.importProviderExport({
      source: "twitter",
      path: archivePath,
      dryRun: false,
      budget: { maxRuntimeMs: 30_000, maxRequests: 100, minDelayMs: 0, stopOnRateLimit: true },
    });
    const initialQueueIds = twitterQueueIds(await store.loadCheckpoint("twitter"));
    expect(initialQueueIds.length).toBeGreaterThanOrEqual(4);

    const enrichReport = await runtime.enrich({
      source: "twitter",
      limit: 2,
      dryRun: false,
      budget: { maxRuntimeMs: 30_000, maxRequests: 10, minDelayMs: 0, stopOnRateLimit: true },
    });
    expect(enrichReport.status).toBe("partial");
    const terminalIds = (await store.query({ source: "twitter", type: "twitter.tweet_enrichment", limit: 10 })).records
      .filter((record) => {
        const status = (record.payload as JsonObject).status;
        return status === "enriched" || status === "unavailable";
      })
      .map((record) => record.sourceId);
    expect(terminalIds.length).toBe(2);

    await runtime.importProviderExport({
      source: "twitter",
      path: archivePath,
      dryRun: false,
      budget: { maxRuntimeMs: 30_000, maxRequests: 100, minDelayMs: 0, stopOnRateLimit: true },
    });
    const queueAfterReimport = twitterQueueIds(await store.loadCheckpoint("twitter"));
    for (const tweetId of terminalIds) expect(queueAfterReimport).not.toContain(tweetId);
    expect(initialQueueIds.some((tweetId) => !terminalIds.includes(tweetId) && queueAfterReimport.includes(tweetId))).toBe(true);

    await runtime.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("x archive reimport skips terminal statuses but preserves retryable statuses", async () => {
  const root = mkdtempSync(join(tmpdir(), "trace-x-archive-retryable-"));
  try {
    const archivePath = writeXArchiveFixture(root);
    const config = loadConfig(root);
    const store = openStore(join(root, "trace.sqlite"));
    const statuses: Record<string, "enriched" | "permanent_failure" | "temporary_failure" | "rate_limited"> = {
      "1000000000000000001": "enriched",
      "1000000000000000002": "permanent_failure",
      "1000000000000000003": "temporary_failure",
      "2022530158654280053": "rate_limited",
    };
    const fetcher: TweetEnrichmentFetcher = {
      async fetch(tweetId) {
        const status = statuses[tweetId] ?? "temporary_failure";
        return status === "enriched"
          ? {
              status,
              errorCode: null,
              errorMessage: null,
              tweet: {
                tweetId,
                canonicalUrl: `https://x.com/example/status/${tweetId}`,
                text: "Enriched archive tweet",
                createdAt: new Date("2025-01-01T12:00:00.000Z"),
                author: {
                  id: "user-1",
                  name: "Example",
                  username: "example",
                  avatarUrl: "https://example.com/avatar.jpg",
                  verified: false,
                  blueVerified: false,
                },
                media: [],
                quotedTweetId: null,
                quotedTweet: null,
                parentTweetId: null,
                parentTweet: null,
                raw: { fixture: true },
              },
            }
          : { status, tweet: null, errorCode: status, errorMessage: status };
      },
    };
    const runtime = new TraceRuntime({ root, config, store, registry: new PluginRegistry([new TwitterPlugin(fetcher)]) });

    await runtime.importProviderExport({
      source: "twitter",
      path: archivePath,
      dryRun: false,
      budget: { maxRuntimeMs: 30_000, maxRequests: 100, minDelayMs: 0, stopOnRateLimit: true },
    });
    await runtime.enrich({
      source: "twitter",
      limit: 4,
      dryRun: false,
      budget: { maxRuntimeMs: 30_000, maxRequests: 10, minDelayMs: 0, stopOnRateLimit: false },
    });
    await runtime.importProviderExport({
      source: "twitter",
      path: archivePath,
      dryRun: false,
      budget: { maxRuntimeMs: 30_000, maxRequests: 100, minDelayMs: 0, stopOnRateLimit: true },
    });

    const queue = twitterQueueIds(await store.loadCheckpoint("twitter"));
    expect(queue).not.toContain("1000000000000000001");
    expect(queue).not.toContain("1000000000000000002");
    expect(queue).toContain("1000000000000000003");
    expect(queue).toContain("2022530158654280053");
    const enrichmentRecords = await store.query({ source: "twitter", type: "twitter.tweet_enrichment", sourceIds: Object.keys(statuses), limit: 10 });
    const statusById = Object.fromEntries(enrichmentRecords.records.map((record) => [record.sourceId, (record.payload as JsonObject).status]));
    expect(statusById).toMatchObject(statuses);

    await runtime.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeXArchiveFixture(root: string): string {
  const data = join(root, "x-archive", "data");
  mkdirSync(data, { recursive: true });
  writeFileSync(
    join(data, "tweets.js"),
    `window.YTD.tweets.part0 = ${JSON.stringify([
      {
        tweet: {
          id_str: "1000000000000000001",
          full_text: "Portable trace systems should avoid machine-specific imports.",
          created_at: "Wed Jan 01 12:00:00 +0000 2025",
        },
      },
    ])}`,
    "utf8",
  );
  writeFileSync(
    join(data, "like.js"),
    `window.YTD.like.part0 = ${JSON.stringify([{ like: { tweetId: "1000000000000000002", fullText: "Liked trace idea", createdAt: "Wed Feb 05 15:30:00 +0000 2025", expandedUrl: "https://x.com/i/web/status/1000000000000000002" } }])}`,
    "utf8",
  );
  writeFileSync(
    join(data, "bookmark.js"),
    `window.YTD.bookmark.part0 = ${JSON.stringify([
      { bookmark: { tweetId: "1000000000000000003", fullText: "Bookmarked trace idea", createdAt: "Wed Feb 12 16:45:00 +0000 2025" } },
      { bookmark: { tweetId: "2022530158654280053", fullText: "Bookmarked without explicit date" } },
    ])}`,
    "utf8",
  );
  writeFileSync(
    join(data, "following.js"),
    `window.YTD.following.part0 = ${JSON.stringify([{ following: { accountId: "400", userLink: "https://x.com/intent/user?user_id=400" } }])}`,
    "utf8",
  );
  return join(root, "x-archive");
}

function enrichedTweet(tweetId: string) {
  return {
    status: "enriched" as const,
    errorCode: null,
    errorMessage: null,
    tweet: {
      tweetId,
      canonicalUrl: `https://x.com/example/status/${tweetId}`,
      text: `Enriched tweet ${tweetId}`,
      createdAt: new Date("2025-01-01T12:00:00.000Z"),
      author: {
        id: "user-1",
        name: "Example",
        username: "example",
        avatarUrl: "https://example.com/avatar.jpg",
        verified: false,
        blueVerified: false,
      },
      media: [],
      quotedTweetId: null,
      quotedTweet: null,
      parentTweetId: null,
      parentTweet: null,
      raw: { fixture: true },
    },
  };
}

function twitterQueueIds(checkpoint: { state: unknown }): string[] {
  const state = checkpoint.state as JsonObject;
  const enrichment = state.enrichment as JsonObject | undefined;
  const queue = enrichment?.queue as JsonObject | undefined;
  return Object.keys(queue ?? {});
}
