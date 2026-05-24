import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config/config";
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

function twitterQueueIds(checkpoint: { state: unknown }): string[] {
  const state = checkpoint.state as JsonObject;
  const enrichment = state.enrichment as JsonObject | undefined;
  const queue = enrichment?.queue as JsonObject | undefined;
  return Object.keys(queue ?? {});
}
