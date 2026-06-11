import { expect, test } from "bun:test";
import type { JsonObject, PluginContext, SyncRequest } from "../src/core/types";
import { YouTubePlugin } from "../src/plugins/builtin/youtube/plugin";
import type { YouTubeActivityItem } from "../src/plugins/builtin/youtube/identity";

test("youtube recent sync uses My Activity overlap and emits canonical events", async () => {
  const calls: Array<{ cursor?: string | null; maxPages: number }> = [];
  const plugin = new YouTubePlugin(async (input) => {
    calls.push({ cursor: input.cursor, maxPages: input.maxPages });
    return {
      items: [
        activity("20260521", "Watched", "Recent video"),
        activity("20260521", "Searched", "Recent query"),
      ],
      scroll: {
        driver: "fixture",
        pages: 1,
        maxPages: input.maxPages,
        reachedCutoff: true,
        stoppedForStagnation: false,
        stoppedForCursorLoop: false,
        stoppedForExhaustion: false,
        oldestLoadedDateKey: "20260521",
        newestLoadedDateKey: "20260521",
        loadedCardCount: 2,
        nextCursor: null,
      },
    };
  });

  const result = await plugin.sync(context(), request("recent", 1), { version: 1, state: {} });

  expect(calls).toEqual([{ cursor: null, maxPages: 1 }]);
  expect(result.completed).toBe(true);
  expect(result.partial).toBe(false);
  expect(result.records.map((record) => record.type)).toEqual(["youtube.watched", "youtube.searched"]);
  expect((result.nextCheckpoint as JsonObject).lastRunAt).toBe("2026-05-22T12:00:00.000Z");
});

test("youtube smoke uses the plugin's lightweight My Activity probe", async () => {
  const calls: Array<{ maxPages: number; cookieTimeoutMs: number }> = [];
  const plugin = new YouTubePlugin(async (input) => {
    calls.push({ maxPages: input.maxPages, cookieTimeoutMs: input.cookieTimeoutMs });
    return {
      items: [activity("20260521", "Watched", "Recent video")],
      scroll: {
        driver: "fixture",
        pages: 1,
        maxPages: input.maxPages,
        reachedCutoff: true,
        stoppedForStagnation: false,
        stoppedForCursorLoop: false,
        stoppedForExhaustion: false,
        oldestLoadedDateKey: "20260521",
        newestLoadedDateKey: "20260521",
        loadedCardCount: 1,
        nextCursor: null,
      },
    };
  });

  const result = await plugin.smoke(context({ cookieTimeoutMs: 30_000 }));

  expect(calls).toEqual([{ maxPages: 1, cookieTimeoutMs: 2_000 }]);
  expect(result.findings).toEqual([]);
  expect(result.message).toContain("YouTube browser session works");
});

test("youtube historical backfill refuses live collection and requires official Google export import", async () => {
  let calls = 0;
  const plugin = new YouTubePlugin(async () => {
    calls += 1;
    return {
      items: [],
      scroll: {
        driver: "fixture",
        pages: 0,
        maxPages: 0,
        reachedCutoff: false,
        stoppedForStagnation: false,
        stoppedForCursorLoop: false,
        stoppedForExhaustion: false,
        loadedCardCount: 0,
        nextCursor: null,
      },
    };
  });

  const result = await plugin.sync(context(), request("backfill", 1), {
    version: 1,
    state: { existing: true },
  });

  expect(calls).toBe(0);
  expect(result.partial).toBe(true);
  expect(result.completed).toBe(false);
  expect(result.records).toHaveLength(0);
  expect(result.observations).toHaveLength(0);
  expect(result.health[0]?.code).toBe("youtube_provider_export_required");
  expect((result.health[0]?.detail as JsonObject).nextCommand).toBe("nutshell import youtube <provider-export> --json");
  expect(result.health[0]?.guidance?.state).toBe("ready_empty");
  expect(result.health[0]?.guidance?.fix.length).toBeGreaterThan(0);
  expect(result.health[0]?.guidance?.confirm).toBe("nutshell import youtube <google-export.zip> --json");
  expect(result.nextCheckpoint).toEqual({ existing: true });
});

test("youtube health probe fails closed on unexpected empty access", async () => {
  const plugin = new YouTubePlugin(async () => ({
    items: [],
    scroll: {
      driver: "fixture",
      pages: 1,
      maxPages: 1,
      reachedCutoff: false,
      stoppedForStagnation: false,
      stoppedForCursorLoop: false,
      stoppedForExhaustion: false,
      loadedCardCount: 0,
      nextCursor: "cursor-1",
    },
  }));

  const findings = await plugin.check(context());

  expect(findings.some((item) => item.level === "critical" && item.code === "youtube_activity_unreadable")).toBe(true);
  expect(findings[0]?.guidance?.state).toBe("blocked_bug");
  expect(findings[0]?.guidance?.fix.length).toBeGreaterThan(0);
  expect(findings[0]?.guidance?.fix).toContain("file a bug");
  expect(findings[0]?.guidance?.fix).toContain("nutshell doctor youtube --json");
  expect(findings[0]?.guidance?.confirm).toBe("nutshell doctor youtube");
  expect(JSON.stringify(findings[0]?.detail)).toContain("cursor-1");
});

test("youtube health probe reports collector auth exceptions instead of crashing", async () => {
  const plugin = new YouTubePlugin(async () => {
    throw new Error("Google My Activity returned the signed-out shell for the configured browser profile");
  });

  const findings = await plugin.check(context());

  expect(findings).toHaveLength(1);
  expect(findings[0]?.level).toBe("critical");
  expect(findings[0]?.code).toBe("youtube_signed_out");
  expect(findings[0]?.message).toContain("not signed into Google");
  expect(findings[0]?.guidance?.state).toBe("needs_auth");
  expect(findings[0]?.guidance?.fix.length).toBeGreaterThan(0);
  expect(findings[0]?.guidance?.confirm).toBe("nutshell doctor youtube");
  expect(findings[0]?.guidance?.url).toBe("https://myactivity.google.com/myactivity?product=26");
  expect(JSON.stringify(findings[0]?.detail)).toContain("signed-out shell");
});

test("youtube health probe names Google's identity-verification interstitial, not a false signed-out", async () => {
  // Regression: a real multi-account / device-bound Google session gets bounced
  // to an identity-verification page even with valid cookies. The product must
  // tell the user to finish verification in Chrome instead of claiming "signed out".
  const plugin = new YouTubePlugin(async () => {
    throw new Error("Google could not establish a My Activity session: it served an identity-verification page for this account");
  });

  const findings = await plugin.check(context());

  expect(findings).toHaveLength(1);
  expect(findings[0]?.code).toBe("youtube_session_unverifiable");
  expect(findings[0]?.message).toContain("verification step in Chrome");
  expect(findings[0]?.guidance?.state).toBe("needs_auth");
  expect(findings[0]?.guidance?.fix).toContain("Google My Activity");
  expect(findings[0]?.guidance?.fix).not.toContain("import youtube");
  expect(findings[0]?.guidance?.fix).toContain("authUser");
  expect(findings[0]?.guidance?.confirm).toBe("nutshell doctor youtube");
  expect(findings[0]?.guidance?.url).toBe("https://myactivity.google.com/myactivity?product=26");
});

test("youtube health probe reports Chrome Safe Storage as a permission block", async () => {
  const plugin = new YouTubePlugin(async () => {
    throw new Error("Timed out after 10000ms reading Chrome Safe Storage from macOS Keychain.");
  });

  const findings = await plugin.check(context());

  expect(findings).toHaveLength(1);
  expect(findings[0]?.code).toBe("youtube_keychain_blocked");
  expect(findings[0]?.message).toContain("macOS blocked access to Chrome Safe Storage");
  expect(findings[0]?.guidance?.state).toBe("needs_permission");
  expect(findings[0]?.guidance?.fix.length).toBeGreaterThan(0);
  expect(findings[0]?.guidance?.confirm).toBe("nutshell doctor youtube");
  expect((findings[0]?.detail as JsonObject).reason).toBe("chrome_safe_storage_keychain");
});

function request(mode: "recent" | "backfill", maxRequests: number | null): SyncRequest {
  return {
    source: "youtube",
    mode,
    window: null,
    collections: [],
    budget: { maxRuntimeMs: 30_000, maxRequests, minDelayMs: 0, stopOnRateLimit: true },
    dryRun: false,
  };
}

function context(config: JsonObject = {}): PluginContext {
  return {
    root: "/tmp/nutshell-test",
    config: {
      accessMode: "myactivity_http",
      httpMaxPages: 2,
      ...config,
    },
    logger: { event() {}, warn() {}, error() {} },
    signal: new AbortController().signal,
    now: () => new Date("2026-05-22T12:00:00.000Z"),
    records: emptyRecordReader(),
    async writeArtifact() {
      return { path: "", contentHash: "", mimeType: null, bytes: 0 };
    },
  };
}

function emptyRecordReader() {
  return {
    async query() {
      return { records: [], total: 0, limit: 0, offset: 0 };
    },
  };
}

function activity(dateKey: string, verb: string, title: string): YouTubeActivityItem {
  return {
    source: "fixture",
    date_key: dateKey,
    happened_at: `${dateKey.slice(0, 4)}-${dateKey.slice(4, 6)}-${dateKey.slice(6, 8)}T12:00:00.000Z`,
    product: "YouTube",
    verb,
    title,
    title_url: `https://youtube.com/watch?v=${title.replaceAll(" ", "-").toLowerCase()}`,
    raw_text: `${verb} ${title}`,
  };
}
