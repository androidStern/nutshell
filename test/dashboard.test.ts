import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config/config";
import type { PluginSyncResult, TraceRecord } from "../src/core/types";
import { handleDashboardRequest, serveDashboard } from "../src/dashboard/server";
import { PluginRegistry } from "../src/plugins/registry";
import { TraceRuntime } from "../src/runtime/trace-runtime";
import { openStore } from "../src/store/sqlite-store";
import { FakePlugin } from "../src/testing/fake-plugin";

const LOCALHOST_BIND_AVAILABLE = canBindLocalhost();

test("dashboard status API uses app-owned health and config model", async () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-dashboard-"));
  try {
    const runtime = runtimeFor(root);
    const response = await handleDashboardRequest(runtime, new Request("http://127.0.0.1/api/status"));
    const json = (await response.json()) as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(json.product).toBe("nutshell");
    expect(json.root).toBe(root);
    expect(json.health).toBeTruthy();
    expect(json.app).toBeTruthy();
    expect(json).not.toHaveProperty("launchd");
    await runtime.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dashboard days API returns deterministic grouped records and truncated note excerpts", async () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-dashboard-"));
  try {
    const runtime = runtimeFor(root);
    await commitRecord(runtime, "youtube", record("youtube", "youtube.watched", "yt1", "A long video title", "2026-05-21T12:00:00Z", "https://youtube.com/watch?v=abc123XYZ_9"));
    await commitRecord(runtime, "apple_notes", record("apple_notes", "apple_note", "note1", "A note", "2026-05-21T13:00:00Z", null, "x ".repeat(260)));
    await commitRecord(runtime, "twitter", record("twitter", "twitter.tweet", "tweet-support", "Support tweet entity", "2026-05-21T13:30:00Z", "https://x.com/i/web/status/support"));
    await commitRecord(runtime, "twitter", record("twitter", "twitter.liked", "likes:1", "Liked post one", "2026-05-21T14:00:00Z", "https://x.com/i/web/status/1"));
    await commitRecord(runtime, "twitter", record("twitter", "twitter.liked", "likes:2", "Liked post two", "2026-05-21T15:00:00Z", "https://x.com/i/web/status/2"));
    const response = await handleDashboardRequest(runtime, new Request("http://127.0.0.1/api/days?from=2026-05-21&to=2026-05-22"));
    const json = (await response.json()) as { days: Array<{ date: string; sources: Record<string, Array<Record<string, unknown>>> }> };
    expect(json.days[0]?.date).toBe("2026-05-21");
    expect(json.days[0]?.sources.youtube?.[0]?.thumbnailUrl).toContain("i.ytimg.com");
    const note = json.days[0]?.sources.apple_notes?.[0];
    expect(String(note?.excerpt).length).toBeLessThan(370);
    expect(String(note?.excerpt).endsWith("...")).toBe(true);
    const likes = json.days[0]?.sources.twitter?.[0];
    expect(likes?.type).toBe("twitter.likes_group");
    expect(likes?.count).toBe(2);
    expect(Array.isArray(likes?.items)).toBe(true);
    expect(json.days[0]?.sources.twitter?.some((item) => item.type === "twitter.tweet")).toBe(false);

    const filteredResponse = await handleDashboardRequest(runtime, new Request("http://127.0.0.1/api/days?from=2026-05-21&to=2026-05-22&sources=youtube"));
    const filtered = (await filteredResponse.json()) as { days: Array<{ sources: Record<string, Array<Record<string, unknown>>> }> };
    expect(filtered.days[0]?.sources.youtube?.length).toBe(1);
    expect(filtered.days[0]?.sources.apple_notes).toBeUndefined();
    await runtime.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dashboard renders Twitter cards from cached enrichment without widget network code", async () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-dashboard-"));
  try {
    const runtime = runtimeFor(root);
    const tweetId = "1234567890123456789";
    await commitRecord(
      runtime,
      "twitter",
      recordWithPayload("twitter", "twitter.liked", `likes:${tweetId}`, "Sparse liked post", "2026-05-21T14:00:00Z", `https://x.com/i/web/status/${tweetId}`, {
        display: {
          cardKind: "tweet",
          action: "liked",
          tweetId,
          canonicalUrl: `https://x.com/i/web/status/${tweetId}`,
          status: "pending",
          tweet: null,
          fallback: {
            text: "Sparse liked post",
            url: `https://x.com/i/web/status/${tweetId}`,
            happenedAt: "2026-05-21T14:00:00.000Z",
            reason: "not_enriched_yet",
          },
        },
      }),
    );
    await commitRecord(
      runtime,
      "twitter",
      recordWithPayload("twitter", "twitter.tweet_enrichment", tweetId, "Enriched liked post", "2026-05-21T14:01:00Z", `https://x.com/someone/status/${tweetId}`, {
        tweetId,
        status: "enriched",
        attempts: 1,
        firstSeenAt: "2026-05-21T14:00:00.000Z",
        lastAttemptAt: "2026-05-21T14:01:00.000Z",
        nextAttemptAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
        updatedAt: "2026-05-21T14:01:00.000Z",
        enriched: {
          tweetId,
          canonicalUrl: `https://x.com/someone/status/${tweetId}`,
          text: "Real enriched liked tweet",
          createdAt: "2026-05-20T12:00:00.000Z",
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
          parentTweetId: null,
          parentTweet: null,
          raw: { fixture: true },
        },
      }),
    );

    const response = await handleDashboardRequest(runtime, new Request("http://127.0.0.1/api/days?from=2026-05-21&to=2026-05-22"));
    const json = (await response.json()) as { days: Array<{ sources: Record<string, Array<Record<string, unknown>>> }> };
    const likes = json.days[0]?.sources.twitter?.[0] as Record<string, unknown>;
    const item = ((likes.items as Array<Record<string, unknown>>)[0] ?? {}) as Record<string, unknown>;
    const display = item.display as Record<string, unknown>;
    const tweet = display.tweet as Record<string, unknown>;
    const author = tweet.author as Record<string, unknown>;
    expect(display.status).toBe("enriched");
    expect(display.canonicalUrl).toBe(`https://x.com/someone/status/${tweetId}`);
    expect(author.avatarUrl).toBe("https://example.com/avatar.jpg");
    expect(item.thumbnailUrl).toBe("https://example.com/preview.jpg");
    expect(JSON.stringify(display)).toContain("Quoted text");
    expect(JSON.stringify(display)).toContain("https://x.com/quoted/status/2222222222222222222");

    const jsResponse = await handleDashboardRequest(runtime, new Request("http://127.0.0.1/assets/dashboard.js"));
    const js = await jsResponse.text();
    expect(js).not.toContain("platform.twitter.com/widgets.js");
    expect(js).not.toContain("twitter-tweet");
    await runtime.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dashboard diagnostics and config APIs redact secret-looking local data", async () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-dashboard-"));
  try {
    const runtime = runtimeFor(root);
    runtime.config.data.google = { youtube: { apiKey: "secret-api-key", clientSecret: "secret-client" } };
    runtime.logger.event("secret fixture", { token: "secret-token" });
    const configResponse = await handleDashboardRequest(runtime, new Request("http://127.0.0.1/api/config"));
    const config = (await configResponse.json()) as Record<string, unknown>;
    expect(JSON.stringify(config)).not.toContain("secret-api-key");
    expect(JSON.stringify(config)).not.toContain("secret-client");
    expect(JSON.stringify(config)).toContain("<redacted>");

    const diagnosticsResponse = await handleDashboardRequest(runtime, new Request("http://127.0.0.1/api/diagnostics"));
    const diagnostics = (await diagnosticsResponse.json()) as Record<string, unknown>;
    expect(JSON.stringify(diagnostics)).not.toContain("secret-token");
    await runtime.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dashboard config save validates and creates a backup before writing", async () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-dashboard-"));
  try {
    const runtime = runtimeFor(root);
    const response = await handleDashboardRequest(
      runtime,
      new Request("http://127.0.0.1/api/config", {
        method: "POST",
        body: JSON.stringify({
          settings: {
            scheduler: { intervalSeconds: 1200 },
            dashboard: { remoteMedia: false },
            plugins: {
              youtube: { enabled: false, overlapHours: 72, cookieProfile: "Profile 1", httpMaxPages: 12 },
              podcasts: { dbPath: "~/Library/Podcasts.sqlite", overlapHours: 24, limit: 250 },
              apple_notes: { includeFolders: ["Work"], excludeFolders: ["Recently Deleted", "Archive"] },
              twitter: { collections: ["bookmarks", "authored"], cookieProfile: "Default", maxPages: 25, delayMs: 5000 },
            },
          },
        }),
      }),
    );
    const json = (await response.json()) as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(existsSync(String(json.backup))).toBe(true);
    expect(JSON.stringify(json.changes)).toContain("plugins.youtube.enabled");
    expect(JSON.stringify(json.changes)).toContain("plugins.twitter.collections");
    const raw = readFileSync(runtime.config.path, "utf8");
    expect(raw).toContain("\"intervalSeconds\": 1200");
    expect(raw).toContain("\"remoteMedia\": false");
    expect(raw).toContain("\"cookieProfile\": \"Profile 1\"");
    expect(raw).toContain("\"collections\": [");
    expect(raw).toContain("\"includeFolders\": [");
    await runtime.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dashboard config validation failure does not write", async () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-dashboard-"));
  try {
    const runtime = runtimeFor(root);
    const before = readFileSync(runtime.config.path, "utf8");
    const response = await handleDashboardRequest(
      runtime,
      new Request("http://127.0.0.1/api/config", {
        method: "POST",
        body: JSON.stringify({ raw: "{\"version\":1}" }),
      }),
    );
    expect(response.status).toBe(500);
    expect(readFileSync(runtime.config.path, "utf8")).toBe(before);
    await runtime.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dashboard raw config save treats placeholder text as ordinary local config", async () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-dashboard-"));
  try {
    const runtime = runtimeFor(root);
    const response = await handleDashboardRequest(
      runtime,
      new Request("http://127.0.0.1/api/config", {
        method: "POST",
        body: JSON.stringify({ raw: "{\"plugins\":{\"youtube\":{\"apiKey\":\"<redacted>\"}}}" }),
      }),
    );
    expect(response.status).toBe(200);
    const json = (await response.json()) as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(readFileSync(runtime.config.path, "utf8")).toContain("<redacted>");
    await runtime.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dashboard sync action uses runtime plugins and returns source status", async () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-dashboard-"));
  try {
    const runtime = runtimeFor(root);
    const response = await handleDashboardRequest(
      runtime,
      new Request("http://127.0.0.1/api/sync", { method: "POST", body: JSON.stringify({ source: "youtube" }) }),
    );
    const json = (await response.json()) as { status: string; sources: Array<{ source: string; status: string }> };
    expect(response.status).toBe(200);
    expect(json.status).toBe("ok");
    expect(json.sources[0]).toMatchObject({ source: "youtube", status: "ok" });
    await runtime.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(!LOCALHOST_BIND_AVAILABLE)("dashboard server starts on a local port without opening a browser", async () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-dashboard-cli-"));
  let runtime: TraceRuntime | null = null;
  let server: Awaited<ReturnType<typeof serveDashboard>> | null = null;
  try {
    runtime = runtimeFor(root);
    server = await serveDashboard(runtime, { host: "127.0.0.1", port: 0, openBrowser: false });
    expect(server.url).toStartWith("http://127.0.0.1:");
    const response = await fetch(server.url);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Your trace, organized by day");
  } finally {
    server?.stop();
    await runtime?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("compiled dashboard binary includes bundled UI assets when binary exists", () => {
  const binary = join(process.cwd(), "bin", "nutshell");
  if (!existsSync(binary)) return;
  const bytes = readFileSync(binary).toString("latin1");
  expect(bytes).toContain("Your trace, organized by day");
  expect(bytes).toContain("/api/status");
  expect(bytes).toContain("/assets/dashboard.js");
});

function runtimeFor(root: string): TraceRuntime {
  const config = loadConfig(root);
  const store = openStore(join(root, "nutshell.sqlite"));
  const registry = new PluginRegistry([
    new FakePlugin("youtube", () => result("youtube")),
    new FakePlugin("podcasts", () => result("podcasts")),
    new FakePlugin("apple_notes", () => result("apple_notes")),
    new FakePlugin("twitter", () => result("twitter")),
  ]);
  return new TraceRuntime({ root, config, store, registry });
}

async function commitRecord(runtime: TraceRuntime, source: string, traceRecord: TraceRecord): Promise<void> {
  const checkpoint = await runtime.store.loadCheckpoint(source);
  await runtime.store.commitSync({
    source,
    run: { id: `${source}-${traceRecord.sourceId}`, command: "test", mode: "recent", startedAt: new Date("2026-05-21T12:00:00Z") },
    result: {
      observations: [],
      records: [traceRecord],
      nextCheckpoint: {},
      health: [],
      metrics: {},
      completed: true,
      partial: false,
    },
    expectedCheckpointVersion: checkpoint.version,
  });
}

function result(source: string): PluginSyncResult {
  return {
    observations: [],
    records: [record(source, `${source}.event`, "one", `${source} event`, "2026-05-21T12:00:00Z")],
    nextCheckpoint: {},
    health: [],
    metrics: { ok: true },
    completed: true,
    partial: false,
  };
}

function record(source: string, type: string, sourceId: string, title: string, happenedAt: string, url: string | null = null, bodyText: string | null = null): TraceRecord {
  return {
    source,
    collection: type.split(".").pop() ?? null,
    kind: source === "apple_notes" ? "entity" : "event",
    type,
    sourceId,
    happenedAt: new Date(happenedAt),
    observedAt: new Date(happenedAt),
    title,
    url,
    bodyText,
    artifactRefs: [],
    payload: { channel: "Channel", folderPath: "Notes", text: bodyText ?? "" },
  };
}

function recordWithPayload(source: string, type: string, sourceId: string, title: string, happenedAt: string, url: string | null, payload: Record<string, unknown>): TraceRecord {
  return {
    ...record(source, type, sourceId, title, happenedAt, url, typeof payload.text === "string" ? payload.text : null),
    collection: type === "twitter.tweet_enrichment" ? "enrichment" : type.split(".").pop() ?? null,
    kind: type === "twitter.tweet_enrichment" ? "entity" : "event",
    payload: payload as never,
  };
}

function canBindLocalhost(): boolean {
  try {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
    server.stop(true);
    return true;
  } catch {
    return false;
  }
}
