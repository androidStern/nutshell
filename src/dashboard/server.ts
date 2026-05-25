import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import JSON5 from "json5";
import { DEFAULT_SYNC_BUDGET } from "../config/defaults";
import { validateConfig } from "../config/schema";
import { CLI_NAME, PRODUCT_VERSION } from "../core/product";
import { redactJson, redactText } from "../core/redaction";
import type { Json, JsonObject, SourceId, SyncRequest, TraceRecord } from "../core/types";
import { localDateKey, localDayWindow } from "../core/time";
import { runProcess } from "../runtime/process";
import { defaultSyncRequest, TraceRuntime } from "../runtime/trace-runtime";

export interface DashboardOptions {
  host: string;
  port: number;
  openBrowser: boolean;
}

export interface DashboardServer {
  url: string;
  stop(): void;
  waitClosed(): Promise<void>;
}

type DashboardAction = "data" | "config" | "logs";

const SOURCES = ["youtube", "podcasts", "apple_notes", "twitter"] as const;

export async function serveDashboard(runtime: TraceRuntime, options: DashboardOptions): Promise<DashboardServer> {
  let resolveClosed: (() => void) | null = null;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const server = startDashboardServer(runtime, options);
  const url = `http://${options.host}:${server.port}/`;
  if (options.openBrowser) {
    await openUrl(url).catch((error) => {
      runtime.logger.warn("dashboard: open browser failed", { error: String(error) });
    });
  }

  const stop = () => {
    server.stop(true);
    resolveClosed?.();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return { url, stop, waitClosed: () => closed };
}

function startDashboardServer(runtime: TraceRuntime, options: DashboardOptions): ReturnType<typeof Bun.serve> {
  const ports = options.port === 0 ? [0, ...fallbackPorts()] : [options.port];
  let lastError: unknown = null;
  for (const port of ports) {
    try {
      return Bun.serve({
        hostname: options.host,
        port,
        fetch: (request) => handleDashboardRequest(runtime, request),
      });
    } catch (error) {
      lastError = error;
      runtime.logger.warn("dashboard: server bind failed", { host: options.host, port, error: String(error) });
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "dashboard server failed to start"));
}

function fallbackPorts(): number[] {
  const first = 49_152 + Math.floor(Math.random() * 12_000);
  return Array.from({ length: 20 }, (_, index) => 49_152 + ((first + index * 37) % (65_535 - 49_152)));
}

export async function handleDashboardRequest(runtime: TraceRuntime, request: Request): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (request.method === "GET" && url.pathname === "/") return htmlResponse(INDEX_HTML);
    if (request.method === "GET" && url.pathname === "/assets/dashboard.css") return textResponse(DASHBOARD_CSS, "text/css; charset=utf-8");
    if (request.method === "GET" && url.pathname === "/assets/dashboard.js") return textResponse(DASHBOARD_JS, "text/javascript; charset=utf-8");
    if (request.method === "GET" && url.pathname === "/api/status") return jsonResponse(await dashboardStatus(runtime));
    if (request.method === "GET" && url.pathname === "/api/sources") return jsonResponse(await dashboardSources(runtime));
    if (request.method === "GET" && url.pathname === "/api/runs") return jsonResponse(await dashboardRuns(runtime));
    if (request.method === "GET" && url.pathname === "/api/days") return jsonResponse(await dashboardDays(runtime, url));
    if (request.method === "GET" && url.pathname.startsWith("/api/day/")) return jsonResponse(await dashboardDay(runtime, decodeURIComponent(url.pathname.slice("/api/day/".length))));
    if (request.method === "GET" && url.pathname === "/api/config") return jsonResponse(dashboardConfig(runtime));
    if (request.method === "POST" && url.pathname === "/api/config") return jsonResponse(await saveDashboardConfig(runtime, await request.json()));
    if (request.method === "POST" && url.pathname === "/api/sync") return jsonResponse(await dashboardSync(runtime, await request.json().catch(() => ({}))));
    if (request.method === "POST" && url.pathname === "/api/project") return jsonResponse(await dashboardProject(runtime));
    if (request.method === "POST" && url.pathname === "/api/open") return jsonResponse(await dashboardOpen(runtime, await request.json().catch(() => ({}))));
    if (request.method === "GET" && url.pathname === "/api/diagnostics") return jsonResponse(await dashboardDiagnostics(runtime));
    return jsonResponse({ error: "not_found", message: "Dashboard route not found" }, 404);
  } catch (error) {
    return jsonResponse({ error: "dashboard_error", message: String(error instanceof Error ? error.message : error) }, 500);
  }
}

async function dashboardStatus(runtime: TraceRuntime): Promise<Record<string, unknown>> {
  const health = await runtime.health();
  const scheduler = objectAt(runtime.config.data, "scheduler");
  const intervalSeconds = numberAt(scheduler, "intervalSeconds", 900);
  const lastRunAt = latestRecentRun(health.backfill);
  const diskFinding = health.findings.find((finding) => finding.source === "system" && finding.code.startsWith("disk_"));
  return {
    product: CLI_NAME,
    version: PRODUCT_VERSION,
    checkedAt: new Date().toISOString(),
    root: runtime.config.root,
    configPath: runtime.config.path,
    health,
    app: health.app,
    scheduler: {
      intervalSeconds,
      lastRunAt,
      nextRunAt: nextRunAt(lastRunAt, intervalSeconds),
    },
    disk: {
      status: diskFinding?.level ?? "ok",
      message: diskFinding?.message ?? "disk space ok",
      detail: diskFinding?.detail ?? {},
    },
    lock: await lockSummary(runtime.config.root),
  };
}

async function dashboardSources(runtime: TraceRuntime): Promise<Record<string, unknown>> {
  const health = await runtime.health();
  const manifests = runtime.registry.enabled(runtime.config).map((plugin) => plugin.manifest);
  return {
    sources: manifests.map((manifest) => ({
      manifest,
      health: health.backfill.find((item) => item.source === manifest.id) ?? null,
      config: objectAt(objectAt(runtime.config.data, "plugins"), manifest.id),
    })),
  };
}

async function dashboardRuns(runtime: TraceRuntime): Promise<Record<string, unknown>> {
  const snapshot = await runtime.store.healthSnapshot();
  return {
    lastRuns: snapshot.lastRuns,
    lastBackfillRuns: snapshot.lastBackfillRuns,
    latestFindings: snapshot.latestFindings,
  };
}

async function dashboardDays(runtime: TraceRuntime, url: URL): Promise<Record<string, unknown>> {
  const now = new Date();
  const to = parseDateParam(url.searchParams.get("to")) ?? new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const from = parseDateParam(url.searchParams.get("from")) ?? new Date(to.getFullYear(), to.getMonth(), to.getDate() - 7);
  const sourceParams = [...url.searchParams.getAll("sources"), ...url.searchParams.getAll("source")];
  const sources = new Set(sourceParams.flatMap((item) => item.split(",")).map((item) => item.trim()).filter(Boolean));
  const records = await dashboardTimelineRecords(runtime, from, to);
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    days: groupRecordsByDay(records.filter((record) => !sources.size || sources.has(record.source))),
  };
}

async function dashboardDay(runtime: TraceRuntime, date: string): Promise<Record<string, unknown>> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Date must be YYYY-MM-DD");
  const window = localDayWindow(date);
  return { date, days: groupRecordsByDay(await dashboardTimelineRecords(runtime, window.start, window.end)) };
}

async function dashboardTimelineRecords(runtime: TraceRuntime, since: Date, until: Date): Promise<TraceRecord[]> {
  const types = ["youtube.watched", "youtube.searched", "podcast.listened", "apple_note", "twitter.authored", "twitter.bookmarked", "twitter.liked"];
  const pages = await Promise.all(types.map((type) => runtime.query({ since, until, type, limit: 1000 })));
  let records = await attachTwitterEnrichments(runtime, pages.flatMap((page) => page.records));
  if (!records.some((record) => record.source === "podcasts" && record.type === "podcast.listened")) return records;
  const episodes = await runtime.query({ source: "podcasts", type: "podcast.episode", limit: 1000 });
  return enrichPodcastListens(records, episodes.records);
}

async function attachTwitterEnrichments(runtime: TraceRuntime, records: TraceRecord[]): Promise<TraceRecord[]> {
  const tweetIds = uniqueStrings(
    records
      .filter((record) => record.source === "twitter")
      .map(tweetIdForDashboardRecord)
      .filter(Boolean),
  );
  if (!tweetIds.length) return records;
  const enrichmentByTweetId = new Map<string, TraceRecord>();
  for (let index = 0; index < tweetIds.length; index += 400) {
    const sourceIds = tweetIds.slice(index, index + 400);
    const page = await runtime.query({
      source: "twitter",
      type: "twitter.tweet_enrichment",
      sourceIds,
      limit: sourceIds.length,
    });
    for (const enrichment of page.records) enrichmentByTweetId.set(enrichment.sourceId, enrichment);
  }
  return records.map((record) => {
    if (record.source !== "twitter") return record;
    const tweetId = tweetIdForDashboardRecord(record);
    if (!tweetId) return record;
    const enrichment = enrichmentByTweetId.get(tweetId);
    return { ...record, payload: withDashboardTweetDisplay(record, enrichment) };
  });
}

function withDashboardTweetDisplay(record: TraceRecord, enrichment: TraceRecord | undefined): JsonObject {
  const payload = objectFromJson(record.payload);
  const currentDisplay = objectAt(payload, "display");
  const tweetId = stringValue(currentDisplay, "tweetId") ?? tweetIdForDashboardRecord(record);
  if (!tweetId) return payload;
  const enrichmentPayload = enrichment ? objectFromJson(enrichment.payload) : null;
  const status = stringValue(enrichmentPayload ?? {}, "status") ?? stringValue(currentDisplay, "status") ?? "pending";
  const enriched = objectOrNull(enrichmentPayload ?? {}, "enriched");
  const fallback = objectAt(currentDisplay, "fallback");
  const fallbackText = stringValue(fallback, "text") ?? record.bodyText ?? record.title;
  const fallbackUrl = stringValue(fallback, "url") ?? record.url ?? `https://x.com/i/web/status/${tweetId}`;
  const display: JsonObject = {
    cardKind: "tweet",
    action: stringValue(currentDisplay, "action") ?? actionForTwitterType(record.type),
    tweetId,
    canonicalUrl: enriched ? stringValue(enriched, "canonicalUrl") ?? fallbackUrl : fallbackUrl,
    status,
    tweet: status === "enriched" && enriched ? enriched : null,
    fallback:
      status === "enriched" && enriched
        ? null
        : {
            text: fallbackText,
            url: fallbackUrl,
            happenedAt: stringValue(fallback, "happenedAt") ?? (record.happenedAt ? record.happenedAt.toISOString() : null),
            reason: fallbackReasonForStatus(status),
          },
  };
  return { ...payload, display };
}

function tweetIdForDashboardRecord(record: TraceRecord): string {
  const display = objectAt(objectFromJson(record.payload), "display");
  const displayId = stringValue(display, "tweetId");
  if (displayId) return displayId;
  const match = record.sourceId.match(/\d{8,22}/) ?? record.url?.match(/status\/(\d{8,22})/);
  return match?.[1] ?? match?.[0] ?? "";
}

function actionForTwitterType(type: string): string {
  if (type === "twitter.liked") return "liked";
  if (type === "twitter.bookmarked") return "bookmarked";
  return "authored";
}

function fallbackReasonForStatus(status: string): string {
  if (status === "rate_limited") return "rate_limited";
  if (status === "temporary_failure") return "temporary_failure";
  if (status === "unavailable" || status === "permanent_failure") return "private_or_deleted";
  return "not_enriched_yet";
}

function enrichPodcastListens(records: TraceRecord[], episodes: TraceRecord[]): TraceRecord[] {
  const episodeById = new Map(episodes.map((episode) => [episode.sourceId, episode]));
  return records.map((record) => {
    if (record.source !== "podcasts" || record.type !== "podcast.listened" || mediaFor(record).length) return record;
    const episodeId = [...episodeById.keys()].find((id) => record.sourceId.startsWith(`${id}:`));
    const episode = episodeId ? episodeById.get(episodeId) : null;
    if (!episode || !mediaFor(episode).length) return record;
    const payload = objectFromJson(record.payload);
    const episodePayload = objectFromJson(episode.payload);
    return {
      ...record,
      bodyText: record.bodyText ?? episode.bodyText,
      payload: { ...episodePayload, ...payload, artwork_url: firstString(mediaFor(episode)) } as JsonObject,
    };
  });
}

function dashboardConfig(runtime: TraceRuntime): Record<string, unknown> {
  const raw = existsSync(runtime.config.path) ? readFileSync(runtime.config.path, "utf8") : "";
  return {
    path: runtime.config.path,
    root: runtime.config.root,
    settings: settingsFromConfig(redactJson(runtime.config.data) as JsonObject),
    config: redactJson(runtime.config.data),
    raw: redactConfigRaw(raw),
  };
}

async function saveDashboardConfig(runtime: TraceRuntime, input: unknown): Promise<Record<string, unknown>> {
  const body = objectInput(input);
  const currentRaw = existsSync(runtime.config.path) ? readFileSync(runtime.config.path, "utf8") : JSON.stringify(runtime.config.data, null, 2);
  let nextRaw: string;
  let mode: string;

  if (typeof body.raw === "string") {
    JSON5.parse(body.raw);
    nextRaw = body.raw.endsWith("\n") ? body.raw : `${body.raw}\n`;
    mode = "raw";
  } else {
    const parsed = JSON5.parse(currentRaw || "{}") as JsonObject;
    applySettings(parsed, objectAt(body, "settings"));
    nextRaw = `${JSON.stringify(parsed, null, 2)}\n`;
    mode = "settings";
  }

  const parsedNext = JSON5.parse(nextRaw) as JsonObject;
  const problems = validateConfig({ root: runtime.config.root, path: runtime.config.path, data: parsedNext });
  if (problems.length) throw new Error(`Config validation failed: ${problems.join(", ")}`);
  const currentParsed = JSON5.parse(currentRaw || "{}") as JsonObject;
  const changes = diffJson(currentParsed, parsedNext);
  const backup = backupConfig(runtime.config.path);
  writeFileSync(runtime.config.path, nextRaw, "utf8");
  return {
    ok: true,
    mode,
    backup,
    path: runtime.config.path,
    changed: currentRaw !== nextRaw,
    changes,
    restartRecommended: true,
  };
}

async function dashboardSync(runtime: TraceRuntime, input: unknown): Promise<Record<string, unknown>> {
  const body = objectInput(input);
  const source = typeof body.source === "string" && body.source !== "all" ? (body.source as SourceId) : null;
  const request: SyncRequest = { ...defaultSyncRequest(source), mode: "recent", budget: DEFAULT_SYNC_BUDGET };
  return (await runtime.sync(request)) as unknown as Record<string, unknown>;
}

async function dashboardProject(runtime: TraceRuntime): Promise<Record<string, unknown>> {
  return { ok: true, report: await runtime.project({ kind: "all" }) };
}

async function dashboardOpen(runtime: TraceRuntime, input: unknown): Promise<Record<string, unknown>> {
  const body = objectInput(input);
  const target = String(body.target ?? "");
  const path = pathForOpen(runtime, target as DashboardAction);
  if (!path) throw new Error("Unknown open target");
  await runProcess(["/usr/bin/open", path], { timeoutMs: 10_000 });
  return { ok: true, target, path };
}

async function dashboardDiagnostics(runtime: TraceRuntime): Promise<Record<string, unknown>> {
  const [health, snapshot] = await Promise.all([runtime.health(), runtime.store.healthSnapshot()]);
  const log = tailText(join(runtime.config.root, "logs", "nutshell.jsonl"), 80);
  return redactJson({
    generatedAt: new Date().toISOString(),
    version: PRODUCT_VERSION,
    root: runtime.config.root,
    configPath: runtime.config.path,
    health,
    app: health.app,
    snapshot,
    logTail: redactText(log),
  } as unknown as JsonObject) as Record<string, unknown>;
}

function redactConfigRaw(raw: string): string {
  if (!raw.trim()) return "";
  try {
    return `${JSON.stringify(redactJson(JSON5.parse(raw) as Json), null, 2)}\n`;
  } catch {
    return redactText(raw);
  }
}

function groupRecordsByDay(records: TraceRecord[]): JsonObject[] {
  const dayMap = new Map<string, Record<string, TraceRecord[]>>();
  const sorted = [...records].sort((a, b) => eventTime(b).getTime() - eventTime(a).getTime() || a.source.localeCompare(b.source));
  for (const record of sorted) {
    const day = localDateKey(eventTime(record));
    const groups = dayMap.get(day) ?? {};
    const sourceGroup = groups[record.source] ?? [];
    sourceGroup.push(record);
    groups[record.source] = sourceGroup;
    dayMap.set(day, groups);
  }
  return Array.from(dayMap.entries())
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([date, sources]) => ({
      date,
      relativeLabel: relativeDayLabel(date),
      formattedDate: formattedDayLabel(date),
      sources: Object.fromEntries(Object.entries(sources).map(([source, sourceRecords]) => [source, cardsForSource(sourceRecords)])),
    }));
}

function cardsForSource(records: TraceRecord[]): JsonObject[] {
  const likes = records.filter((record) => record.source === "twitter" && record.type === "twitter.liked");
  const youtubeSearches = records.filter((record) => record.source === "youtube" && record.type === "youtube.searched");
  const normal = records
    .filter((record) => !(record.source === "twitter" && record.type === "twitter.liked"))
    .filter((record) => !(record.source === "youtube" && record.type === "youtube.searched"))
    .map(recordCard);
  const grouped = [...normal];
  if (youtubeSearches.length) grouped.unshift(youtubeSearchGroupCard(youtubeSearches));
  if (likes.length) grouped.unshift(likeGroupCard(likes));
  return grouped;
}

function likeGroupCard(records: TraceRecord[]): JsonObject {
  const sorted = [...records].sort((a, b) => eventTime(b).getTime() - eventTime(a).getTime());
  const first = sorted[0]!;
  const items = sorted.slice(0, 5).map((record) => recordCard(record));
  return {
    source: "twitter",
    kind: "event",
    type: "twitter.likes_group",
    collection: "likes",
    sourceId: `likes:${localDateKey(eventTime(first))}`,
    title: `You liked ${records.length} X ${records.length === 1 ? "post" : "posts"}`,
    subtitle: "Your liked posts",
    bodyText: null,
    excerpt: items.map((item) => item.title).filter(Boolean).join("  "),
    url: null,
    happenedAt: first.happenedAt ? first.happenedAt.toISOString() : null,
    observedAt: first.observedAt.toISOString(),
    timeLabel: records.length === 1 ? String(items[0]?.timeLabel ?? "") : "grouped",
    thumbnailUrl: firstString(items.flatMap((item) => arrayOfStrings(item.mediaUrls))),
    mediaUrls: items.flatMap((item) => arrayOfStrings(item.mediaUrls)).slice(0, 4),
    count: records.length,
    items,
    payload: { count: records.length },
  };
}

function youtubeSearchGroupCard(records: TraceRecord[]): JsonObject {
  const sorted = [...records].sort((a, b) => eventTime(b).getTime() - eventTime(a).getTime());
  const first = sorted[0]!;
  const items = sorted.slice(0, 8).map((record) => recordCard(record));
  return {
    source: "youtube",
    kind: "event",
    type: "youtube.searches_group",
    collection: "searched",
    sourceId: `youtube-searches:${localDateKey(eventTime(first))}`,
    title: `You searched YouTube ${records.length} ${records.length === 1 ? "time" : "times"}`,
    subtitle: "YouTube searches",
    bodyText: null,
    excerpt: items.map((item) => item.title).filter(Boolean).join("  "),
    url: null,
    happenedAt: first.happenedAt ? first.happenedAt.toISOString() : null,
    observedAt: first.observedAt.toISOString(),
    timeLabel: "grouped",
    thumbnailUrl: null,
    mediaUrls: [],
    count: records.length,
    items,
    payload: { count: records.length },
  };
}

function recordCard(record: TraceRecord): JsonObject {
  if (record.source === "twitter") return twitterRecordCard(record);
  const payload = objectFromJson(record.payload);
  const time = eventTime(record);
  return {
    source: record.source,
    kind: record.kind,
    type: record.type,
    collection: record.collection,
    sourceId: record.sourceId,
    sourceLabel: sourceLabel(record.source),
    title: record.title ?? fallbackTitle(record),
    subtitle: subtitleFor(record, payload),
    bodyText: record.bodyText,
    excerpt: excerpt(record.bodyText ?? stringValue(payload, "text") ?? stringValue(payload, "fullText") ?? "", 360),
    url: record.url,
    happenedAt: record.happenedAt ? record.happenedAt.toISOString() : null,
    observedAt: record.observedAt.toISOString(),
    timeLabel: time.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
    thumbnailUrl: thumbnailFor(record),
    mediaUrls: mediaFor(record),
    payload,
  };
}

function twitterRecordCard(record: TraceRecord): JsonObject {
  const payload = objectFromJson(record.payload);
  const display = objectAt(payload, "display");
  const tweet = objectOrNull(display, "tweet");
  const fallback = objectAt(display, "fallback");
  const author = objectAt(tweet ?? {}, "author");
  const mediaUrls = tweet ? displayTweetMediaUrls(tweet) : [];
  const text = tweet ? stringValue(tweet, "text") : stringValue(fallback, "text") ?? record.bodyText ?? record.title;
  const action = stringValue(display, "action") ?? actionForTwitterType(record.type);
  const status = stringValue(display, "status") ?? "pending";
  const name = stringValue(author, "name");
  const username = stringValue(author, "username");
  const subtitle = tweet
    ? [name, username ? `@${username}` : null].filter(Boolean).join(" ")
    : statusLabel(status);
  const url = stringValue(display, "canonicalUrl") ?? stringValue(fallback, "url") ?? record.url;
  const time = eventTime(record);
  return {
    source: record.source,
    kind: record.kind,
    type: record.type,
    collection: record.collection,
    sourceId: record.sourceId,
    sourceLabel: "X",
    title: excerpt(text ?? record.title ?? fallbackTitle(record), 160),
    subtitle,
    bodyText: text,
    excerpt: excerpt(text ?? "", 360),
    url,
    happenedAt: record.happenedAt ? record.happenedAt.toISOString() : null,
    observedAt: record.observedAt.toISOString(),
    timeLabel: time.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
    thumbnailUrl: firstString(mediaUrls),
    mediaUrls,
    display,
    payload: { display },
  };
}

function displayTweetMediaUrls(tweet: JsonObject): string[] {
  const media = Array.isArray(tweet.media) ? tweet.media : [];
  return uniqueStrings(
    media
      .flatMap((item) => {
        const entry = objectFromJson(item as Json);
        return [stringValue(entry, "previewUrl"), stringValue(entry, "url")];
      })
      .filter((item): item is string => Boolean(item && /^https?:\/\//.test(item))),
  );
}

function statusLabel(status: string): string {
  if (status === "unavailable" || status === "permanent_failure") return "Unavailable, private, or deleted";
  if (status === "rate_limited") return "Enrichment paused by rate limit";
  if (status === "temporary_failure") return "Enrichment failed temporarily";
  return "Enrichment pending";
}

function thumbnailFor(record: TraceRecord): string | null {
  const media = mediaFor(record);
  if (media[0]) return media[0];
  return null;
}

function mediaFor(record: TraceRecord): string[] {
  if (record.source === "youtube") {
    const id = youtubeVideoId(record.url ?? record.sourceId);
    return id ? [`https://i.ytimg.com/vi/${encodeURIComponent(id)}/hqdefault.jpg`] : [];
  }
  if (record.source === "podcasts") {
    return mediaUrlsFrom(objectFromJson(record.payload));
  }
  return [];
}

function mediaUrlsFrom(value: JsonObject): string[] {
  const urls = [
    stringValue(value, "thumbnailUrl"),
    stringValue(value, "mediaUrl"),
    stringValue(value, "imageUrl"),
    stringValue(value, "artworkUrl"),
    stringValue(value, "artwork_url"),
    stringValue(value, "artwork"),
    stringValue(value, "podcast_artwork_url"),
    stringValue(value, "podcast_image_url"),
    stringValue(value, "podcast_logo_image_url"),
    stringValue(value, "episode_artwork_url"),
    stringValue(value, "feedArtworkUrl"),
    stringValue(value, "profile_image_url"),
    stringValue(value, "profile_image_url_https"),
    stringValue(value, "media_url"),
    stringValue(value, "media_url_https"),
  ];
  for (const key of ["media", "photos", "images", "entities", "extended_entities"]) {
    urls.push(...deepImageUrls(value[key]));
  }
  return uniqueStrings(urls.filter((item): item is string => Boolean(item && /^https?:\/\//.test(item))));
}

function deepImageUrls(value: Json | undefined, depth = 0): string[] {
  if (!value || depth > 4) return [];
  if (typeof value === "string") return /^https?:\/\/.+\.(?:jpg|jpeg|png|webp)(?:\?|$)/i.test(value) ? [value] : [];
  if (typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((item) => deepImageUrls(item, depth + 1));
  const direct = [
    stringValue(value, "media_url_https"),
    stringValue(value, "media_url"),
    stringValue(value, "image_url"),
    stringValue(value, "imageUrl"),
    stringValue(value, "thumbnail_url"),
    stringValue(value, "thumbnailUrl"),
    stringValue(value, "artwork_url"),
    stringValue(value, "artworkUrl"),
    stringValue(value, "artwork"),
    stringValue(value, "podcast_artwork_url"),
    stringValue(value, "podcast_image_url"),
    stringValue(value, "podcast_logo_image_url"),
    stringValue(value, "episode_artwork_url"),
    stringValue(value, "feedArtworkUrl"),
    stringValue(value, "profile_image_url"),
    stringValue(value, "profile_image_url_https"),
  ].filter((item): item is string => Boolean(item && /^https?:\/\//.test(item)));
  return uniqueStrings([...direct, ...Object.values(value).flatMap((item) => deepImageUrls(item, depth + 1))]);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function firstString(values: string[]): string | null {
  return values.find(Boolean) ?? null;
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function youtubeVideoId(value: string): string | null {
  const match = value.match(/(?:v=|youtu\.be\/|shorts\/)([A-Za-z0-9_-]{6,})/);
  return match?.[1] ?? null;
}

function subtitleFor(record: TraceRecord, payload: JsonObject): string | null {
  return (
    stringValue(payload, "channel") ??
    stringValue(payload, "channelName") ??
    stringValue(payload, "show") ??
    stringValue(payload, "showTitle") ??
    stringValue(payload, "author") ??
    stringValue(payload, "screenName") ??
    stringValue(payload, "folderPath") ??
    record.collection
  );
}

function sourceLabel(source: string): string {
  if (source === "apple_notes") return "Notes";
  if (source === "twitter") return "X";
  if (source === "youtube") return "YouTube";
  if (source === "podcasts") return "Podcasts";
  return source;
}

function fallbackTitle(record: TraceRecord): string {
  if (record.source === "youtube") return record.type.includes("searched") ? "YouTube search" : "YouTube video";
  if (record.source === "podcasts") return "Podcast episode";
  if (record.source === "apple_notes") return "Untitled note";
  if (record.source === "twitter") return "X item";
  return record.type;
}

function settingsFromConfig(config: JsonObject): JsonObject {
  const plugins = objectAt(config, "plugins");
  const dashboard = objectAt(config, "dashboard");
  return {
    scheduler: { intervalSeconds: numberAt(objectAt(config, "scheduler"), "intervalSeconds", 900) },
    storage: { root: stringAt(objectAt(config, "storage"), "root", "~/Nutshell") },
    backfill: {
      cutoffDate: stringAt(objectAt(config, "backfill"), "cutoffDate", ""),
      lookbackMonths: numberAt(objectAt(config, "backfill"), "lookbackMonths", 6),
    },
    dashboard: { remoteMedia: booleanAt(dashboard, "remoteMedia", true) },
    plugins: Object.fromEntries(
      SOURCES.map((source) => {
        const cfg = objectAt(plugins, source);
        return [
          source,
          {
            enabled: booleanAt(cfg, "enabled", true),
            overlapHours: numberAt(cfg, "overlapHours", 48),
            collections: Array.isArray(cfg.collections) ? cfg.collections : [],
            delayMs: numberAt(cfg, "delayMs", 0),
            maxPages: numberAt(cfg, "maxPages", 0),
            httpMaxPages: numberAt(cfg, "httpMaxPages", 0),
            limit: numberAt(cfg, "limit", 0),
            includeFolders: Array.isArray(cfg.includeFolders) ? cfg.includeFolders : [],
            excludeFolders: Array.isArray(cfg.excludeFolders) ? cfg.excludeFolders : [],
            cookieProfile: stringAt(cfg, "cookieProfile", ""),
            dbPath: stringAt(cfg, "dbPath", ""),
          },
        ];
      }),
    ),
  };
}

function applySettings(config: JsonObject, settings: JsonObject): void {
  const scheduler = ensureObject(config, "scheduler");
  const storage = ensureObject(config, "storage");
  const backfill = ensureObject(config, "backfill");
  const dashboard = ensureObject(config, "dashboard");
  const plugins = ensureObject(config, "plugins");

  const schedulerIn = objectAt(settings, "scheduler");
  if (typeof schedulerIn.intervalSeconds === "number" && schedulerIn.intervalSeconds >= 60) scheduler.intervalSeconds = schedulerIn.intervalSeconds;
  const storageIn = objectAt(settings, "storage");
  if (typeof storageIn.root === "string" && storageIn.root.trim()) storage.root = storageIn.root.trim();
  const backfillIn = objectAt(settings, "backfill");
  if (typeof backfillIn.cutoffDate === "string") backfill.cutoffDate = backfillIn.cutoffDate;
  if (typeof backfillIn.lookbackMonths === "number" && backfillIn.lookbackMonths > 0) backfill.lookbackMonths = backfillIn.lookbackMonths;
  const dashboardIn = objectAt(settings, "dashboard");
  if (typeof dashboardIn.remoteMedia === "boolean") dashboard.remoteMedia = dashboardIn.remoteMedia;

  const pluginSettings = objectAt(settings, "plugins");
  for (const source of SOURCES) {
    const next = objectAt(pluginSettings, source);
    const target = ensureObject(plugins, source);
    if (typeof next.enabled === "boolean") target.enabled = next.enabled;
    if (typeof next.overlapHours === "number" && next.overlapHours > 0) target.overlapHours = next.overlapHours;
    if (typeof next.delayMs === "number" && next.delayMs >= 0) target.delayMs = next.delayMs;
    if (typeof next.maxPages === "number" && next.maxPages >= 0) target.maxPages = next.maxPages;
    if (typeof next.httpMaxPages === "number" && next.httpMaxPages >= 0) target.httpMaxPages = next.httpMaxPages;
    if (typeof next.limit === "number" && next.limit >= 0) target.limit = next.limit;
    if (Array.isArray(next.collections)) target.collections = next.collections.filter((item) => typeof item === "string");
    if (Array.isArray(next.includeFolders)) target.includeFolders = next.includeFolders.filter((item) => typeof item === "string");
    if (Array.isArray(next.excludeFolders)) target.excludeFolders = next.excludeFolders.filter((item) => typeof item === "string");
    if (typeof next.cookieProfile === "string") target.cookieProfile = next.cookieProfile;
    if (typeof next.dbPath === "string") target.dbPath = next.dbPath;
  }
}

function backupConfig(path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${path}.backup-${stamp}`;
  if (existsSync(path)) copyFileSync(path, backup);
  return backup;
}

function pathForOpen(runtime: TraceRuntime, target: DashboardAction): string | null {
  if (target === "data") return runtime.config.root;
  if (target === "config") return runtime.config.path;
  if (target === "logs") return join(runtime.config.root, "logs");
  return null;
}

function diffJson(before: Json, after: Json, path = ""): JsonObject[] {
  if (stableComparable(before) === stableComparable(after)) return [];
  if (!isPlainObject(before) || !isPlainObject(after)) {
    return [{ path: path || "$", before, after }];
  }
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return keys.flatMap((key) => diffJson(before[key] ?? null, after[key] ?? null, path ? `${path}.${key}` : key));
}

function stableComparable(value: Json): string {
  if (!isPlainObject(value)) return JSON.stringify(value);
  const sorted: Record<string, Json> = {};
  for (const key of Object.keys(value).sort()) sorted[key] = value[key] ?? null;
  return JSON.stringify(sorted);
}

function isPlainObject(value: Json): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function openUrl(url: string): Promise<void> {
  if (process.platform === "darwin") {
    const result = await runProcess(["/usr/bin/open", url], { timeoutMs: 10_000 });
    if (result.code !== 0) throw new Error(result.stderr || result.stdout || "open failed");
  }
}

async function lockSummary(root: string): Promise<JsonObject> {
  const path = join(root, "run.lock");
  if (!existsSync(path)) return { present: false, path };
  return { present: true, path, payload: safeJson(readFileSync(path, "utf8")) };
}

function tailText(path: string, lines: number): string {
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf8").split("\n").slice(-lines).join("\n");
}

function parseDateParam(value: string | null): Date | null {
  if (!value) return null;
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(value) ? localDayWindow(value).start : new Date(value);
  return Number.isNaN(parsed.valueOf()) ? null : parsed;
}

function nextRunAt(lastRunAt: string | null, intervalSeconds: number): string | null {
  if (!lastRunAt) return null;
  const parsed = new Date(lastRunAt);
  if (Number.isNaN(parsed.valueOf())) return null;
  return new Date(parsed.getTime() + intervalSeconds * 1000).toISOString();
}

function latestRecentRun(backfill: Array<{ recent?: { lastRunAt: string | null } }>): string | null {
  let latest: string | null = null;
  for (const item of backfill) {
    const candidate = item.recent?.lastRunAt;
    if (candidate && (!latest || candidate > latest)) latest = candidate;
  }
  return latest;
}

function relativeDayLabel(date: string): string {
  const day = localDayStart(date);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((today.getTime() - day.getTime()) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff === 2) return "2 days ago";
  return formattedDayLabel(date);
}

function formattedDayLabel(date: string): string {
  const day = localDayStart(date);
  const weekday = new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(day);
  const dd = String(day.getDate()).padStart(2, "0");
  const mm = String(day.getMonth() + 1).padStart(2, "0");
  const yy = String(day.getFullYear()).slice(-2);
  return `${weekday} ${dd}/${mm}/${yy}`;
}

function localDayStart(date: string): Date {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year || 1970, (month || 1) - 1, day || 1);
}

function eventTime(record: TraceRecord): Date {
  return record.happenedAt ?? record.observedAt;
}

function excerpt(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1).trim()}...` : text;
}

function objectInput(input: unknown): JsonObject {
  return input && typeof input === "object" && !Array.isArray(input) ? (input as JsonObject) : {};
}

function objectFromJson(value: Json): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function safeJson(value: string): Json {
  try {
    return JSON.parse(value) as Json;
  } catch {
    return value;
  }
}

function objectAt(value: Json, key: string): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const child = value[key];
    if (child && typeof child === "object" && !Array.isArray(child)) return child;
  }
  return {};
}

function objectOrNull(value: Json, key: string): JsonObject | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const child = value[key];
    if (child && typeof child === "object" && !Array.isArray(child)) return child;
  }
  return null;
}

function ensureObject(value: JsonObject, key: string): JsonObject {
  const current = value[key];
  if (current && typeof current === "object" && !Array.isArray(current)) return current;
  const next: JsonObject = {};
  value[key] = next;
  return next;
}

function stringAt(value: JsonObject, key: string, fallback = ""): string {
  const child = value[key];
  return typeof child === "string" ? child : fallback;
}

function stringValue(value: JsonObject, key: string): string | null {
  const child = value[key];
  return typeof child === "string" && child.trim() ? child.trim() : null;
}

function numberAt(value: JsonObject, key: string, fallback: number): number {
  const child = value[key];
  return typeof child === "number" && Number.isFinite(child) ? child : fallback;
}

function booleanAt(value: JsonObject, key: string, fallback: boolean): boolean {
  const child = value[key];
  return typeof child === "boolean" ? child : fallback;
}

function htmlResponse(value: string): Response {
  return textResponse(value, "text/html; charset=utf-8");
}

function textResponse(value: string, contentType: string): Response {
  return new Response(value, { headers: { "content-type": contentType, "cache-control": "no-store" } });
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Nutshell Dashboard</title>
  <link rel="stylesheet" href="/assets/dashboard.css">
</head>
<body>
  <main class="shell">
    <nav class="topbar">
      <div class="mark">nutshell</div>
      <div class="tabs" role="tablist">
        <button class="tab active" data-view="timeline">Timeline</button>
        <button class="tab" data-view="sources">Sources</button>
        <button class="tab" data-view="settings">Settings</button>
      </div>
    </nav>
    <header class="hero">
      <p class="eyebrow">Local personal trace</p>
      <h1>Your trace, organized by day</h1>
      <p class="subhead">Recent notes, media, and X activity from the local Nutshell store.</p>
      <section class="command-panel" aria-label="Dashboard controls">
        <input id="search" type="search" placeholder="Filter loaded cards" aria-label="Filter visible timeline cards" title="Filters cards already loaded in the visible date range.">
        <div class="source-chips">
          <button class="chip source-icon all-icon active" data-source="all" aria-label="All sources" title="All sources">
            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="6" height="6" rx="1"></rect><rect x="14" y="4" width="6" height="6" rx="1"></rect><rect x="4" y="14" width="6" height="6" rx="1"></rect><rect x="14" y="14" width="6" height="6" rx="1"></rect></svg>
          </button>
          <button class="chip source-icon youtube-icon" data-source="youtube" aria-label="YouTube" title="YouTube">
            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="18" height="12" rx="3"></rect><path d="M10 9.5v5l5-2.5z"></path></svg>
          </button>
          <button class="chip source-icon podcast-icon" data-source="podcasts" aria-label="Podcasts" title="Podcasts">
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="10" r="2.4"></circle><path d="M8.4 10a3.6 3.6 0 0 1 7.2 0M6 10a6 6 0 0 1 12 0M10.3 14h3.4l-.8 6h-1.8z"></path></svg>
          </button>
          <button class="chip source-icon notes-icon" data-source="apple_notes" aria-label="Apple Notes" title="Apple Notes">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path class="paper" d="M6 4h12v16H6z"></path><path class="rule" d="M6 8h12M9 12h6M9 15h6"></path></svg>
          </button>
          <button class="chip source-icon x-icon" data-source="twitter" aria-label="X" title="X">X</button>
        </div>
        <div class="window-chips" aria-label="Visible time window">
          <button class="chip" data-window="1d">Previous 24h</button>
          <button class="chip active" data-window="7d">Previous 7 days</button>
          <button class="chip" data-window="30d">30 days</button>
          <button class="chip" data-window="6m">6 months</button>
          <button class="chip" data-window="custom">Custom</button>
        </div>
        <div class="custom-range" hidden>
          <input id="from-date" type="date" aria-label="Visible from date" title="Controls the visible timeline range. It does not change what gets synced.">
          <input id="to-date" type="date" aria-label="Visible to date" title="Controls the visible timeline range. It does not change what gets synced.">
        </div>
        <button id="sync-all" class="primary icon-button" aria-label="Sync now" title="Run a recent sync now.">↻</button>
      </section>
    </header>
    <section id="status" class="status-hud" aria-live="polite"></section>
    <section id="notice" class="notice" hidden></section>
    <section id="timeline-view" class="view active">
      <div id="days" class="days"></div>
    </section>
    <section id="sources-view" class="view">
      <div id="source-list" class="source-list"></div>
    </section>
    <section id="settings-view" class="view">
      <div id="settings" class="settings"></div>
    </section>
  </main>
  <script src="/assets/dashboard.js"></script>
</body>
</html>
`;

const DASHBOARD_CSS = `
:root {
  color-scheme: light;
  --paper: oklch(0.985 0.005 245);
  --ink: oklch(0.18 0.018 252);
  --muted: oklch(0.54 0.018 252);
  --line: oklch(0.9 0.008 252);
  --soft: oklch(0.965 0.008 252);
  --blue: oklch(0.61 0.15 248);
  --blue-soft: oklch(0.95 0.035 236);
  --good: oklch(0.55 0.12 154);
  --warn: oklch(0.66 0.14 80);
  --bad: oklch(0.58 0.18 27);
  --shadow: 0 18px 50px oklch(0.2 0.02 252 / 0.1);
  --rail: min(824px, calc(100vw - 32px));
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
}
button, input, textarea { font: inherit; }
button { cursor: pointer; }
.shell { width: min(1180px, calc(100vw - 40px)); margin: 0 auto 64px; }
.topbar { display: flex; align-items: center; justify-content: space-between; height: 64px; }
.mark { font-size: 20px; letter-spacing: -0.01em; }
.tabs { display: flex; gap: 6px; background: var(--soft); border: 1px solid var(--line); border-radius: 8px; padding: 4px; }
.tab, .chip, .secondary { border: 0; border-radius: 6px; background: transparent; color: var(--muted); padding: 8px 12px; }
.tab.active, .chip.active { background: oklch(0.998 0.003 245); color: var(--ink); box-shadow: 0 1px 5px oklch(0.2 0.02 252 / 0.08); }
.hero { text-align: center; padding: 70px 0 26px; }
.eyebrow { color: var(--muted); text-transform: uppercase; letter-spacing: 0.12em; font-size: 12px; }
h1 { font-family: Georgia, "Times New Roman", serif; font-weight: 500; letter-spacing: 0; font-size: 56px; line-height: 1.04; margin: 10px 0; }
.subhead { margin: 0 auto 28px; color: var(--muted); font-size: 18px; max-width: 680px; }
.command-panel {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 42px;
  grid-template-areas:
    "search sync"
    "chips windows"
    "custom custom";
  gap: 10px 14px;
  align-items: center;
  text-align: left;
  width: var(--rail);
  margin: 0 auto;
  padding: 12px;
  background: oklch(0.998 0.003 245);
  border: 1px solid var(--line);
  border-radius: 14px;
  box-shadow: var(--shadow);
}
#search {
  grid-area: search;
  width: 100%;
  min-width: 0;
  border: 1px solid transparent;
  outline: 0;
  border-radius: 7px;
  padding: 11px 12px;
  background: var(--paper);
  color: var(--ink);
  font-size: 15px;
}
#search:focus, .custom-range input:focus, .tab:focus-visible, .chip:focus-visible, .primary:focus-visible, .secondary:focus-visible {
  outline: 2px solid var(--blue);
  outline-offset: 2px;
}
.source-chips { grid-area: chips; display: flex; gap: 6px; flex-wrap: wrap; align-items: center; min-width: 0; }
.source-chips { flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; }
.source-chips::-webkit-scrollbar { display: none; }
.source-icon {
  width: 34px;
  height: 34px;
  display: inline-grid;
  place-items: center;
  padding: 0;
  font-size: 14px;
  font-weight: 650;
  border: 1px solid transparent;
  background: oklch(0.97 0.007 245);
}
.source-icon svg {
  width: 19px;
  height: 19px;
  fill: currentColor;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.all-icon { color: oklch(0.42 0.035 250); }
.youtube-icon {
  color: oklch(0.58 0.22 25);
  background: oklch(0.965 0.045 25);
}
.youtube-icon svg rect { fill: currentColor; stroke: currentColor; opacity: 1; }
.youtube-icon svg path { fill: oklch(0.985 0.004 25); stroke: oklch(0.985 0.004 25); opacity: 1; }
.podcast-icon {
  color: oklch(0.55 0.22 305);
  background: oklch(0.956 0.05 305);
}
.notes-icon {
  color: oklch(0.67 0.14 88);
  background: oklch(0.972 0.055 92);
}
.notes-icon .paper {
  fill: oklch(0.98 0.04 95);
  stroke: currentColor;
}
.notes-icon .rule {
  fill: none;
  stroke: oklch(0.34 0.025 88);
}
.x-icon {
  color: oklch(0.985 0.004 245);
  background: oklch(0.16 0.012 245);
}
.window-chips { grid-area: windows; display: flex; gap: 6px; flex-wrap: nowrap; align-items: center; justify-self: end; min-width: 0; overflow-x: auto; scrollbar-width: none; }
.window-chips::-webkit-scrollbar { display: none; }
.window-chips .chip { font-size: 13px; }
.chip { white-space: nowrap; min-height: 34px; }
.custom-range { grid-area: custom; display: flex; gap: 8px; align-items: center; justify-content: end; }
.custom-range[hidden] { display: none; }
.custom-range input { border: 1px solid var(--line); border-radius: 7px; background: var(--paper); color: var(--ink); padding: 8px 9px; min-width: 132px; }
.primary { grid-area: sync; border: 0; border-radius: 8px; background: oklch(0.12 0.01 252); color: oklch(0.98 0.004 252); padding: 12px 16px; white-space: nowrap; }
.icon-button {
  width: 42px;
  height: 42px;
  display: inline-grid;
  place-items: center;
  padding: 0;
  font-size: 19px;
  line-height: 1;
}
.status-hud {
  width: var(--rail);
  margin: 24px auto 28px;
  min-height: 36px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: oklch(0.967 0.008 238);
  color: var(--muted);
  overflow-x: auto;
  white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  line-height: 1;
  font-weight: 560;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.status-hud strong { color: var(--ink); font-weight: 680; }
.status-hud .sep { color: oklch(0.72 0.014 240); }
.stat-label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; }
.pill { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--line); border-radius: 999px; padding: 4px 9px; font-size: 12px; }
.ok { color: var(--good); }
.warning { color: var(--warn); }
.critical { color: var(--bad); }
.status-hud .ok { color: var(--good); }
.status-hud .warning { color: var(--warn); }
.status-hud .critical { color: var(--bad); }
.notice { width: var(--rail); margin: 12px auto; padding: 12px 14px; border: 1px solid var(--line); border-radius: 8px; background: var(--blue-soft); color: var(--ink); }
.view { display: none; }
.view.active { display: block; width: var(--rail); margin: 0 auto; }
.days { display: grid; gap: 34px; }
.day { border-top: 1px solid var(--line); padding-top: 22px; position: relative; }
.day-head {
  position: sticky;
  top: 8px;
  z-index: 4;
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 16px;
  min-height: 40px;
  margin-bottom: 14px;
  pointer-events: none;
}
.day-date { color: var(--muted); font-size: 13px; }
.day-date strong { display: block; color: var(--ink); font-family: Georgia, "Times New Roman", serif; font-weight: 500; font-size: 28px; line-height: 1.05; }
.day-count { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; }
.day-date, .day-count {
  pointer-events: auto;
  background: var(--paper);
}
@media (min-width: 1120px) {
  .day-head { width: 100%; }
  .day-date {
    position: absolute;
    left: -118px;
    top: 0;
    width: 102px;
    padding: 0;
    background: transparent;
    transition: transform 180ms cubic-bezier(0.22, 1, 0.36, 1);
  }
  .day-date strong { font-size: 25px; }
  .day-count {
    margin-left: auto;
    align-self: end;
    background: var(--paper);
  }
}
.source-section { margin-bottom: 28px; }
.source-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 12px; }
.source-head h2 { margin: 0; font-size: 13px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--muted); }
.bento-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  grid-auto-rows: 280px;
  grid-auto-flow: row;
  gap: 12px;
  align-items: stretch;
}
.trace-card, .thumb-card, .note-card, .tweet-card, .pod-card, .source-card {
  border: 1px solid var(--line);
  border-radius: 8px;
  background: oklch(0.998 0.003 245);
  overflow: hidden;
}
.trace-card {
  grid-column: auto;
  min-height: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  box-shadow: 0 1px 0 oklch(0.2 0.02 252 / 0.03);
}
.trace-card a { color: inherit; text-decoration-thickness: 1px; text-underline-offset: 3px; }
.trace-card.wide, .trace-card.tall, .trace-card.compact { grid-column: auto; min-height: 0; grid-row: auto; }
.trace-card .card-body { display: flex; flex-direction: column; gap: 8px; flex: 1; }
.card-kicker { display: flex; align-items: center; justify-content: space-between; gap: 10px; color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; }
.thumb { aspect-ratio: 16 / 9; background: linear-gradient(135deg, var(--blue-soft), oklch(0.92 0.02 180)); display: flex; align-items: center; justify-content: center; color: var(--muted); font-size: 12px; }
.thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.card-body { padding: 12px; }
.title { color: var(--ink); font-size: 14px; line-height: 1.35; margin: 0; }
.trace-card.wide .title { font-size: 16px; }
.meta { color: var(--muted); font-size: 12px; margin-top: 7px; }
.note-grid, .tweet-grid, .pod-list, .source-list { display: grid; gap: 10px; }
.note-card, .tweet-card, .pod-card, .source-card { padding: 14px; }
.excerpt { color: oklch(0.34 0.012 252); line-height: 1.5; max-height: 5.8em; overflow: hidden; position: relative; }
.excerpt:after { content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: 32px; background: linear-gradient(transparent, oklch(0.998 0.003 245)); }
.trace-card .excerpt { margin: 0; font-size: 13px; }
.trace-card.note { background: oklch(0.992 0.006 95); }
.trace-card.note .excerpt:after { background: linear-gradient(transparent, oklch(0.992 0.006 95)); }
.trace-card.youtube { background: oklch(0.995 0.005 252); }
.trace-card.twitter { background: oklch(0.995 0.004 245); }
.trace-card.likes { background: oklch(0.972 0.018 252); }
.trace-card.youtube-video {
  position: relative;
  grid-column: auto;
  min-height: 0;
  color: var(--ink);
  background: oklch(0.998 0.003 245);
}
.trace-card.youtube-video .timeline-media {
  position: relative;
  inset: auto;
  flex: 0 0 138px;
  min-height: 0;
  background: oklch(0.14 0.008 245);
}
.trace-card.youtube-video .timeline-media img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.trace-card.youtube-video:after {
  display: none;
}
.trace-card.youtube-video .overlay-card-body {
  position: relative;
  z-index: 1;
  margin-top: 0;
  padding: 12px;
  min-height: 0;
  overflow: hidden;
}
.trace-card.youtube-video .card-kicker,
.trace-card.youtube-video .title,
.trace-card.youtube-video .meta {
  color: inherit;
}
.trace-card.youtube-video .card-kicker { opacity: 0.78; }
.trace-card.youtube-video .title { max-width: none; font-size: 14px; line-height: 1.25; letter-spacing: -0.015em; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.trace-card.youtube-video .meta { color: var(--muted); }
.trace-card.youtube-search {
  grid-column: auto;
  padding: 14px;
  background: linear-gradient(135deg, oklch(0.982 0.012 242), oklch(0.958 0.016 238));
}
.trace-card.youtube-search .search-term {
  margin: 12px 0 8px;
  font-size: 18px;
  line-height: 1.1;
  letter-spacing: -0.03em;
}
.search-list { display: grid; gap: 6px; margin-top: 12px; }
.search-line {
  color: oklch(0.35 0.014 252);
  font-size: 13px;
  line-height: 1.3;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.trace-card.note-doc {
  grid-column: auto;
  display: grid;
  grid-template-rows: auto 1fr auto;
  background: linear-gradient(90deg, oklch(0.988 0.008 232), oklch(0.993 0.004 232));
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.trace-card.note-doc.long { grid-column: auto; }
.trace-card.note-doc header,
.trace-card.note-doc .note-body,
.trace-card.note-doc footer {
  padding: 9px 11px;
}
.trace-card.note-doc header {
  min-height: 38px;
  border-bottom: 1px solid oklch(0.72 0.11 241);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.trace-card.note-doc header a { min-width: 0; }
.trace-card.note-doc footer {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  border-top: 1px solid oklch(0.72 0.11 241);
  color: var(--muted);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.trace-card.note-doc .title { font-size: 13px; line-height: 1.2; letter-spacing: -0.015em; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.trace-card.note-doc .meta {
  color: var(--blue);
  font-size: 10px;
  line-height: 1.15;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  flex: 0 1 auto;
  min-width: 88px;
  max-width: 46%;
  margin-top: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  text-align: right;
}
.trace-card.note-doc .excerpt {
  max-height: none;
  overflow: hidden;
  margin: 0;
  color: oklch(0.255 0.025 239);
  font-size: 12.5px;
  line-height: 1.45;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
}
.trace-card.note-doc .excerpt:after { display: none; }
.trace-card.tweet-preview {
  grid-column: auto;
  display: grid;
  grid-template-rows: 132px 1fr;
  background: oklch(0.99 0.004 240);
}
.trace-card.tweet-preview .tweet-media {
  min-height: 0;
  display: grid;
  gap: 2px;
  background: var(--line);
}
.trace-card.tweet-preview .tweet-media.count-2,
.trace-card.tweet-preview .tweet-media.count-3,
.trace-card.tweet-preview .tweet-media.count-4 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.trace-card.tweet-preview .tweet-media img {
  width: 100%;
  height: 100%;
  min-height: 0;
  object-fit: cover;
  display: block;
}
.trace-card.tweet-preview.no-media { grid-template-rows: 136px 1fr; }
.trace-card.tweet-preview.official-embed { grid-template-rows: 148px 1fr; }
.tweet-visual {
  padding: 12px;
  background:
    linear-gradient(135deg, oklch(0.965 0.012 245), oklch(0.935 0.018 245));
  border-bottom: 1px solid var(--line);
  display: flex;
  align-items: center;
  gap: 10px;
}
.avatar-row { display: flex; gap: 6px; margin-bottom: 10px; }
.avatar-chip {
  width: 28px;
  height: 28px;
  border-radius: 999px;
  display: inline-grid;
  place-items: center;
  background: oklch(0.22 0.022 252);
  color: oklch(0.98 0.004 252);
  font-size: 11px;
  font-weight: 750;
}
.tweet-avatar {
  width: 44px;
  height: 44px;
  border-radius: 999px;
  object-fit: cover;
  background: var(--line);
  flex: 0 0 auto;
}
.mini-avatar {
  width: 18px;
  height: 18px;
  border-radius: 999px;
  object-fit: cover;
  vertical-align: -4px;
  margin-right: 5px;
  background: var(--line);
}
.tweet-context { color: var(--muted); font-size: 12px; line-height: 1.3; }
.tweet-embed-shell {
  min-height: 0;
  overflow: hidden;
  background: oklch(0.998 0.003 245);
  border-bottom: 1px solid var(--line);
}
.tweet-mark {
  width: 38px;
  height: 38px;
  border-radius: 999px;
  display: inline-grid;
  place-items: center;
  background: oklch(0.16 0.012 245);
  color: oklch(0.985 0.004 245);
  font-weight: 800;
  margin-bottom: 10px;
}
.trace-card.tweet-preview .tweet-body { padding: 14px; }
.tweet-author {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
  color: var(--muted);
  font-size: 12px;
}
.tweet-author strong { color: var(--ink); font-size: 13px; }
.tweet-text { margin: 0; font-size: 14px; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
.tweet-summary {
  display: grid;
  grid-template-columns: 52px 1fr;
  gap: 9px;
  margin-top: 10px;
  padding: 9px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: oklch(0.975 0.006 245);
  font-size: 12px;
  line-height: 1.3;
  min-height: 0;
}
.tweet-summary > img {
  width: 52px;
  height: 52px;
  border-radius: 5px;
  object-fit: cover;
}
.tweet-summary-label {
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font: 700 10px/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.tweet-summary-author { color: var(--ink); font-weight: 650; margin-top: 2px; }
.tweet-summary p {
  margin: 4px 0 0;
  color: oklch(0.34 0.014 252);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.tweet-unavailable {
  margin-top: 10px;
  color: var(--muted);
  font-size: 12px;
}
.tweet-unavailable a { color: var(--blue); }
.trace-card.likes-group {
  grid-column: auto;
  display: flex;
  min-height: 0;
  background: oklch(0.985 0.007 240);
}
.likes-stack {
  display: none;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  grid-template-rows: repeat(2, minmax(0, 1fr));
  gap: 2px;
  background: var(--line);
}
.likes-stack img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.likes-body { padding: 16px; }
.likes-body h2 { margin: 0 0 10px; font-size: 18px; letter-spacing: -0.03em; }
.like-row {
  display: grid;
  grid-template-columns: 84px 1fr;
  gap: 10px;
  padding: 7px 0;
  border-top: 1px solid var(--line);
  font-size: 13px;
  line-height: 1.35;
}
.like-row span:first-child {
  color: var(--muted);
  font: 700 11px/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.trace-card.podcast-listen {
  grid-column: auto;
  display: flex;
  padding: 0;
  background: oklch(0.982 0.009 255);
}
.pod-art {
  width: 100%;
  height: 132px;
  border-radius: 0;
  background: linear-gradient(135deg, oklch(0.36 0.07 250), oklch(0.77 0.12 330)), var(--soft);
  box-shadow: inset 0 0 0 1px oklch(1 0 0 / 0.24);
  display: grid;
  place-items: center;
  color: oklch(0.98 0.004 252);
  font-size: 30px;
  overflow: hidden;
}
.pod-art img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.pod-art.fallback {
  padding: 13px;
  grid-template-rows: 1fr auto;
  background:
    radial-gradient(circle at 20% 15%, oklch(0.8 0.1 320 / 0.55), transparent 34%),
    linear-gradient(135deg, oklch(0.34 0.055 250), oklch(0.57 0.085 286));
  text-align: left;
}
.pod-initials {
  justify-self: start;
  align-self: start;
  font: 700 28px/1 Georgia, "Times New Roman", serif;
  letter-spacing: -0.02em;
}
.pod-show {
  width: 100%;
  align-self: end;
  font-size: 11px;
  line-height: 1.2;
  color: oklch(0.94 0.008 250);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.podcast-body { padding: 12px; min-height: 0; overflow: hidden; }
.trace-card.podcast-listen .title { font-size: 15px; line-height: 1.2; letter-spacing: -0.025em; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.likes-list { display: grid; gap: 7px; margin-top: 2px; }
.like-line { color: oklch(0.36 0.014 252); font-size: 13px; line-height: 1.35; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.like-count { color: var(--ink); font-size: 13px; font-weight: 600; }
.pod-card { display: grid; grid-template-columns: 48px 1fr; gap: 12px; align-items: center; }
.art { width: 48px; height: 48px; border-radius: 8px; background: var(--blue-soft); display: grid; place-items: center; color: var(--blue); }
.source-list { grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); }
.source-card h3 { margin: 0 0 8px; font-size: 18px; }
.source-metrics { display: grid; gap: 5px; margin-top: 12px; color: var(--muted); font-size: 12px; }
.source-actions { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
.run-history { margin-top: 12px; border-top: 1px solid var(--line); padding-top: 10px; }
.config-summary { margin-top: 10px; color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
.settings { display: grid; grid-template-columns: minmax(320px, 0.85fr) 1fr; gap: 18px; align-items: start; }
.settings-panel { border: 1px solid var(--line); border-radius: 8px; background: oklch(0.998 0.003 245); padding: 16px; }
.field { display: grid; gap: 6px; margin: 12px 0; }
.field label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; }
.field input, .field textarea { border: 1px solid var(--line); border-radius: 8px; background: var(--paper); padding: 10px; color: var(--ink); width: 100%; }
.field textarea { min-height: 420px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.5; }
@media (max-width: 820px) {
  .shell { width: min(100vw - 24px, 1180px); }
  h1 { font-size: 42px; }
  .command-panel {
    grid-template-columns: minmax(0, 1fr) 42px;
    grid-template-areas: "search sync" "windows windows" "chips chips" "custom custom";
  }
  .window-chips { justify-self: stretch; }
  .custom-range { justify-content: stretch; }
  .custom-range input { min-width: 0; width: 100%; }
  .primary { width: 42px; margin-left: 0; }
  .settings { grid-template-columns: 1fr; }
  .day-head { align-items: start; flex-direction: column; }
  .bento-grid { grid-template-columns: 1fr; grid-auto-rows: 280px; }
  .trace-card,
  .trace-card.wide,
  .trace-card.tall,
  .trace-card.youtube-video,
  .trace-card.youtube-search,
  .trace-card.note-doc,
  .trace-card.note-doc.long,
  .trace-card.tweet-preview,
  .trace-card.likes-group,
  .trace-card.podcast-listen {
    grid-column: auto;
  }
}
@media (min-width: 821px) and (max-width: 1080px) {
  .bento-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .trace-card { grid-column: auto; }
  .trace-card.wide,
  .trace-card.tall,
  .trace-card.youtube-video,
  .trace-card.youtube-search,
  .trace-card.note-doc,
  .trace-card.note-doc.long,
  .trace-card.tweet-preview,
  .trace-card.likes-group,
  .trace-card.podcast-listen {
    grid-column: auto;
  }
}
`;

const DASHBOARD_JS = `
const state = { status: null, days: [], config: null, sources: [], runs: null, source: 'all', query: '', windowPreset: '7d', from: '', to: '' };
const $ = (sel) => document.querySelector(sel);
const fmt = (value) => value ? new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'unknown';
const esc = (value) => String(value ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

async function api(path, options = {}) {
  const res = await fetch(path, { headers: { 'content-type': 'application/json' }, ...options });
  const json = await res.json();
  if (!res.ok) throw new Error(json.message || json.error || res.statusText);
  return json;
}

async function loadAll() {
  const [status, days, config, sources, runs] = await Promise.all([
    api('/api/status'),
    api(daysPath()),
    api('/api/config'),
    api('/api/sources'),
    api('/api/runs'),
  ]);
  state.status = status;
  state.days = days.days || [];
  state.config = config;
  state.sources = sources.sources || [];
  state.runs = runs;
  render();
}

async function loadDays() {
  const days = await api(daysPath());
  state.days = days.days || [];
  renderDays();
}

function daysPath() {
  const params = new URLSearchParams();
  const window = visibleWindow();
  if (window.from) params.set('from', window.from);
  if (window.to) params.set('to', window.to);
  if (state.source !== 'all') params.set('sources', state.source);
  const query = params.toString();
  return query ? '/api/days?' + query : '/api/days';
}

function visibleWindow() {
  if (state.windowPreset === 'custom') return { from: state.from, to: state.to };
  const to = new Date();
  const from = new Date(to);
  if (state.windowPreset === '1d') from.setHours(from.getHours() - 24);
  else if (state.windowPreset === '30d') from.setDate(from.getDate() - 30);
  else if (state.windowPreset === '6m') from.setMonth(from.getMonth() - 6);
  else from.setDate(from.getDate() - 7);
  return { from: from.toISOString(), to: to.toISOString() };
}

function render() {
  renderStatus();
  renderDays();
  renderSources();
  renderSettings();
}

function renderStatus() {
  const status = state.status || {};
  const health = status.health || {};
  const app = status.app || {};
  const scheduler = status.scheduler || {};
  const disk = status.disk || {};
  $('#status').innerHTML = [
    'Health <strong class="' + esc(health.status || '') + '">' + esc(health.status || 'unknown') + '</strong>',
    'App <strong>' + esc(app.installed ? 'installed' : 'missing') + '</strong>',
    'Agent <strong>' + esc(app.agent || 'unknown') + '</strong>',
    'Access <strong>' + esc(app.fullDiskAccess || 'unknown') + '</strong>',
    'Last <strong>' + esc(shortTime(scheduler.lastRunAt)) + '</strong>',
    'Next <strong>' + esc(shortTime(scheduler.nextRunAt)) + '</strong>',
    'Lock <strong>' + esc(status.lock?.present ? 'active' : 'clear') + '</strong>',
    'Findings <strong>' + esc((health.findings || []).length) + '</strong>',
    'Store <strong>' + esc(disk.status || 'unknown') + '</strong> / ' + esc(shortPath(status.root || 'unknown')),
  ].map((item, index) => index ? '<span class="sep">/</span><span>' + item + '</span>' : '<span>' + item + '</span>').join('');
}

function shortTime(value) {
  if (!value) return 'unknown';
  return new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function shortPath(value) {
  return String(value || '').replace(/^\\/Users\\/[^/]+/, '~');
}

function renderDays() {
  const remoteMedia = state.config?.settings?.dashboard?.remoteMedia !== false;
  const needle = state.query.toLowerCase();
  const html = state.days.map((day) => {
    const sources = Object.entries(day.sources || {})
      .filter(([source]) => state.source === 'all' || source === state.source)
      .map(([source, records]) => [source, records.filter((record) => JSON.stringify(record).toLowerCase().includes(needle))])
      .filter(([, records]) => records.length);
    if (!sources.length) return '';
    const cards = sources.flatMap(([, records]) => records);
    const count = cards.reduce((sum, record) => sum + (record.type === 'twitter.likes_group' || record.type === 'youtube.searches_group' ? Number(record.count || 0) : 1), 0);
    return '<article class="day"><header class="day-head"><div class="day-date"><strong>' + esc(day.relativeLabel || day.date) + '</strong><span>' + esc(day.formattedDate || day.date) + '</span></div><div class="day-count">' + count + ' trace ' + (count === 1 ? 'item' : 'items') + '</div></header><div class="bento-grid">' + cards.map((record) => renderCard(record, remoteMedia)).join('') + '</div></article>';
  }).join('');
  $('#days').innerHTML = html || '<p class="meta">No records matched this view.</p>';
}

function sourceSection(source, records, remoteMedia) {
  const label = source === 'apple_notes' ? 'Apple Notes' : source === 'twitter' ? 'X' : source[0].toUpperCase() + source.slice(1);
  return '<section class="source-section"><div class="source-head"><h2>' + esc(label) + '</h2><span class="pill">' + records.length + ' items</span></div>' + renderRecords(source, records, remoteMedia) + '</section>';
}

function renderRecords(source, records, remoteMedia) {
  if (source === 'youtube') return '<div class="gallery">' + records.map((r) => '<article class="thumb-card"><div class="thumb">' + (remoteMedia && r.thumbnailUrl ? '<img loading="lazy" src="' + esc(r.thumbnailUrl) + '" alt="">' : 'YouTube') + '</div><div class="card-body">' + titleLink(r) + '<div class="meta">' + esc(r.subtitle || r.collection || '') + ' · ' + esc(r.timeLabel) + '</div></div></article>').join('') + '</div>';
  if (source === 'apple_notes') return '<div class="note-grid">' + records.map((r) => '<article class="note-card">' + titleLink(r) + '<div class="meta">' + esc(r.subtitle || '') + ' · ' + esc(r.timeLabel) + '</div><p class="excerpt">' + esc(r.excerpt || '') + '</p></article>').join('') + '</div>';
  if (source === 'podcasts') return '<div class="pod-list">' + records.map((r) => '<article class="pod-card"><div class="art">Pod</div><div>' + titleLink(r) + '<div class="meta">' + esc(r.subtitle || '') + ' · ' + esc(r.timeLabel) + '</div></div></article>').join('') + '</div>';
  return '<div class="tweet-grid">' + records.map((r) => '<article class="tweet-card">' + titleLink(r) + '<div class="meta">' + esc(r.collection || r.type) + ' · ' + esc(r.timeLabel) + '</div><p class="excerpt">' + esc(r.excerpt || r.bodyText || '') + '</p></article>').join('') + '</div>';
}

function renderCard(record, remoteMedia) {
  if (record.type === 'twitter.likes_group') return renderLikesCard(record);
  if (record.type === 'youtube.searches_group') return renderYoutubeSearchGroupCard(record);
  if (record.source === 'youtube' && record.type === 'youtube.searched') return renderYoutubeSearchCard(record);
  if (record.source === 'youtube') return renderYoutubeVideoCard(record, remoteMedia);
  if (record.source === 'apple_notes') return renderNoteCard(record);
  if (record.source === 'twitter') return renderTweetCard(record, remoteMedia);
  if (record.source === 'podcasts') return renderPodcastCard(record);
  return renderGenericCard(record, remoteMedia);
}

function renderLikesCard(record) {
  const items = (record.items || []).slice(0, 5);
  const images = mediaUrls(record).slice(0, 4);
  const media = images.length ? '<div class="likes-stack">' + images.map((url) => '<img loading="lazy" src="' + esc(url) + '" alt="">').join('') + '</div>' : '';
  const list = items.slice(0, 4).map((item) => {
    const display = item.display || {};
    const tweet = display.tweet || null;
    const author = tweet?.author || {};
    const avatar = author.avatarUrl ? '<img class="mini-avatar" loading="lazy" src="' + esc(author.avatarUrl) + '" alt="">' : '';
    const who = author.username ? '@' + author.username : item.subtitle || item.collection || 'X';
    return '<div class="like-row"><span>' + avatar + esc(who) + '</span><div>' + esc(item.title || item.excerpt || item.sourceId || 'Liked post') + '</div></div>';
  }).join('');
  return '<article class="trace-card likes-group">' + media + '<div class="likes-body"><div class="card-kicker"><span>X likes</span><span>' + esc(record.timeLabel || 'grouped') + '</span></div><h2>You liked ' + esc(record.count || items.length) + ' posts</h2>' + list + '</div></article>';
}

function renderYoutubeVideoCard(record, remoteMedia) {
  const images = remoteMedia ? mediaUrls(record).slice(0, 1) : [];
  const media = images.length ? '<div class="timeline-media"><img loading="lazy" src="' + esc(images[0]) + '" alt=""></div>' : '';
  return '<article class="trace-card youtube-video">' + media + '<div class="overlay-card-body"><div class="card-kicker"><span>YouTube watched</span><span>' + esc(record.timeLabel || '') + '</span></div>' + titleLink(record) + '<div class="meta">' + esc(record.subtitle || record.collection || 'YouTube') + '</div></div></article>';
}

function renderYoutubeSearchCard(record) {
  return '<article class="trace-card youtube-search"><div class="card-kicker"><span>YouTube search</span><span>' + esc(record.timeLabel || '') + '</span></div><div class="search-term">' + esc(record.title || record.excerpt || 'YouTube search') + '</div><div class="meta">' + esc(record.subtitle || 'searched') + '</div></article>';
}

function renderYoutubeSearchGroupCard(record) {
  const items = (record.items || []).slice(0, 5);
  const list = items.map((item) => '<div class="search-line">' + esc(item.title || item.excerpt || 'Search') + '</div>').join('');
  return '<article class="trace-card youtube-search"><div class="card-kicker"><span>YouTube searches</span><span>grouped</span></div><div class="search-term">You searched ' + esc(record.count || items.length) + ' times</div><div class="search-list">' + list + '</div></article>';
}

function renderNoteCard(record) {
  const long = String(record.excerpt || record.bodyText || '').length > 220 ? ' long' : '';
  return '<article class="trace-card note-doc' + long + '"><header>' + titleLink(record) + '<div class="meta">' + esc(record.subtitle || 'Apple Notes') + ' / ' + esc(record.timeLabel || '') + '</div></header><div class="note-body"><p class="excerpt">' + esc(record.excerpt || record.bodyText || '') + '</p></div><footer><span>' + esc(record.type || 'apple_note') + '</span><span>' + esc(record.collection || 'notes') + '</span></footer></article>';
}

function renderTweetCard(record, remoteMedia) {
  const display = record.display || {};
  const tweet = display.tweet || null;
  const fallback = display.fallback || {};
  const images = remoteMedia && tweet ? tweetMediaUrls(tweet).slice(0, 4) : [];
  const media = images.length ? '<div class="tweet-media count-' + esc(Math.min(images.length, 4)) + '">' + images.map((url) => '<img loading="lazy" src="' + esc(url) + '" alt="">').join('') + '</div>' : '';
  const author = tweet?.author || {};
  const avatar = remoteMedia && author.avatarUrl ? '<img class="tweet-avatar" loading="lazy" src="' + esc(author.avatarUrl) + '" alt="">' : '';
  const name = author.name || record.subtitle || 'X';
  const handle = author.username ? '@' + author.username : statusCopy(display.status);
  const quote = tweet?.quotedTweet ? renderTweetSummary('Quoted', tweet.quotedTweet, remoteMedia) : '';
  const parent = tweet?.parentTweet ? renderTweetSummary('Replying to', tweet.parentTweet, remoteMedia) : '';
  const unavailable = !tweet ? '<div class="tweet-unavailable">' + esc(statusCopy(display.status)) + (fallback.url ? ' · <a href="' + esc(fallback.url) + '" target="_blank" rel="noreferrer">Open on X</a>' : '') + '</div>' : '';
  const cls = images.length ? 'trace-card tweet-preview' : 'trace-card tweet-preview no-media';
  const text = tweet?.text || fallback.text || record.excerpt || record.bodyText || record.title || '';
  const visual = media || '<div class="tweet-visual">' + avatar + '<div><div class="tweet-mark">X</div><div class="tweet-context">' + esc(handle) + '</div></div></div>';
  return '<article class="' + cls + '">' + visual + '<div class="tweet-body"><div class="tweet-author"><strong>' + esc(name) + '</strong><span>' + esc(actionCopy(display.action || record.collection || record.type) + ' · ' + (record.timeLabel || '')) + '</span></div><p class="tweet-text">' + esc(text) + '</p>' + quote + parent + unavailable + '</div></article>';
}

function renderPodcastCard(record) {
  const images = mediaUrls(record).slice(0, 1);
  const show = record.subtitle || record.bodyText || record.collection || 'Podcast';
  const art = images.length ? '<div class="pod-art image"><img loading="lazy" src="' + esc(images[0]) + '" alt=""></div>' : '<div class="pod-art fallback"><div class="pod-initials">' + esc(initials(show)) + '</div><div class="pod-show">' + esc(show) + '</div></div>';
  return '<article class="trace-card podcast-listen">' + art + '<div class="podcast-body"><div class="card-kicker"><span>Podcast</span><span>' + esc(record.timeLabel || '') + '</span></div>' + titleLink(record) + '<div class="meta">' + esc(record.subtitle || record.collection || 'listened') + '</div></div></article>';
}

function renderTweetSummary(label, summary, remoteMedia) {
  const media = remoteMedia && summary.mediaPreviewUrl ? '<img loading="lazy" src="' + esc(summary.mediaPreviewUrl) + '" alt="">' : '';
  const avatar = remoteMedia && summary.authorAvatarUrl ? '<img class="mini-avatar" loading="lazy" src="' + esc(summary.authorAvatarUrl) + '" alt="">' : '';
  const author = summary.authorUsername ? '@' + summary.authorUsername : summary.authorName || 'X';
  return '<div class="tweet-summary">' + media + '<div><div class="tweet-summary-label">' + esc(label) + '</div><div class="tweet-summary-author">' + avatar + esc(author) + '</div><p>' + esc(summary.text || 'Tweet preview unavailable') + '</p></div></div>';
}

function tweetMediaUrls(tweet) {
  return (tweet.media || []).flatMap((item) => [item.previewUrl, item.url]).filter(Boolean);
}

function statusCopy(status) {
  if (status === 'rate_limited') return 'Enrichment paused by rate limit';
  if (status === 'temporary_failure') return 'Enrichment failed temporarily';
  if (status === 'unavailable' || status === 'permanent_failure') return 'Unavailable, private, or deleted';
  return 'Enrichment pending';
}

function actionCopy(action) {
  if (action === 'liked') return 'liked';
  if (action === 'bookmarked') return 'bookmarked';
  if (action === 'authored') return 'authored';
  return String(action || 'tweet');
}

function initials(value) {
  const words = String(value || 'Podcast').replace(/[^A-Za-z0-9 ]/g, ' ').trim().split(/\\s+/).filter(Boolean);
  return (words[0]?.[0] || 'P') + (words[1]?.[0] || words[0]?.[1] || 'D');
}

function renderGenericCard(record, remoteMedia) {
  const media = remoteMedia && record.thumbnailUrl ? '<div class="thumb"><img loading="lazy" src="' + esc(record.thumbnailUrl) + '" alt=""></div>' : '';
  const excerpt = record.excerpt || record.bodyText || '';
  const source = record.sourceLabel || sourceLabel(record.source);
  return '<article class="' + cardClass(record) + '">' + media + '<div class="card-body"><div class="card-kicker"><span>' + esc(source) + '</span><span>' + esc(record.timeLabel || '') + '</span></div>' + titleLink(record) + '<div class="meta">' + esc(record.subtitle || record.collection || record.type || '') + '</div>' + (excerpt ? '<p class="excerpt">' + esc(excerpt) + '</p>' : '') + '</div></article>';
}

function mediaUrls(record) {
  const urls = Array.isArray(record.mediaUrls) ? record.mediaUrls : [];
  if (!urls.length && record.thumbnailUrl) return [record.thumbnailUrl];
  return urls.filter(Boolean);
}

function cardClass(record) {
  const parts = ['trace-card', record.source === 'apple_notes' ? 'note' : record.source === 'twitter' ? 'twitter' : record.source === 'youtube' ? 'youtube' : record.source === 'podcasts' ? 'podcast' : ''];
  if (record.source === 'youtube' && record.thumbnailUrl) parts.push('wide');
  if (record.source === 'apple_notes') parts.push('wide');
  if (record.source === 'podcasts') parts.push('compact');
  if (record.source === 'twitter' && record.thumbnailUrl) parts.push('wide');
  if ((record.excerpt || '').length > 220 && record.source === 'apple_notes') parts.push('tall');
  return parts.filter(Boolean).join(' ');
}

function sourceLabel(source) {
  if (source === 'apple_notes') return 'Notes';
  if (source === 'twitter') return 'X';
  if (source === 'youtube') return 'YouTube';
  if (source === 'podcasts') return 'Podcasts';
  return source || 'Trace';
}

function titleLink(record) {
  const title = '<p class="title">' + esc(record.title || record.type) + '</p>';
  return record.url ? '<a href="' + esc(record.url) + '" target="_blank" rel="noreferrer">' + title + '</a>' : title;
}

function renderSources() {
  $('#source-list').innerHTML = (state.sources || []).map((item) => {
    const h = item.health || {};
    const counts = Object.entries(h.counts || {}).slice(0, 4).map(([key, value]) => '<div>' + esc(key) + ': ' + esc(value) + '</div>').join('');
    const latest = h.detail?.latestFinding ? esc(h.detail.latestFinding.message || h.detail.latestFinding.code) : 'No current issue';
    const recent = latestRun(item.manifest.id, 'recent');
    const backfill = latestRun(item.manifest.id, 'backfill');
    const lastSuccess = successfulRunTime(recent, backfill);
    return '<article class="source-card"><h3>' + esc(item.manifest.displayName) + '</h3><div class="meta">' + esc(item.manifest.id) + ' · ' + esc(h.status || 'unknown') + '</div><div class="source-metrics"><div>Last successful sync: ' + fmt(lastSuccess) + '</div><div>Last attempted sync: ' + fmt(h.recent?.lastRunAt || recent?.finished_at || recent?.started_at) + '</div><div>Recent: ' + esc(h.recentStatus || recent?.status || 'unknown') + '</div><div>Backfill coverage: ' + esc(h.status || 'unknown') + '</div><div>Auth/permission: ' + esc(item.manifest.authKind || 'unknown') + '</div><div>Latest error: ' + latest + '</div>' + counts + '</div><div class="run-history"><div class="stat-label">Recent run history</div><div class="source-metrics">' + runLine('recent', recent) + runLine('backfill', backfill) + '</div></div><div class="config-summary"><span class="stat-label">Config</span><br>' + configSummary(item.config || {}) + '</div><div class="source-actions"><button class="secondary" data-sync="' + esc(item.manifest.id) + '">Sync source</button></div></article>';
  }).join('');
}

function latestRun(source, mode) {
  const rows = mode === 'backfill' ? state.runs?.lastBackfillRuns : state.runs?.lastRuns;
  return (rows || []).find((row) => row.source === source) || null;
}

function successfulRunTime(...runs) {
  const successful = runs.filter((run) => run && run.status === 'ok' && Number(run.completed ?? 0) === 1).sort((a, b) => String(b.finished_at || b.started_at).localeCompare(String(a.finished_at || a.started_at)));
  return successful[0]?.finished_at || successful[0]?.started_at || null;
}

function runLine(label, run) {
  if (!run) return '<div>' + esc(label) + ': no run recorded</div>';
  return '<div>' + esc(label) + ': ' + esc(run.status || 'unknown') + ' · ' + fmt(run.finished_at || run.started_at) + '</div>';
}

function configSummary(config) {
  const entries = Object.entries(config || {}).filter(([, value]) => value !== '' && value !== null && value !== undefined).slice(0, 8);
  return entries.length ? entries.map(([key, value]) => esc(key) + '=' + esc(Array.isArray(value) ? value.join(',') : value)).join(' · ') : 'default settings';
}

function renderSettings() {
  const s = state.config?.settings || {};
  const plugins = s.plugins || {};
  $('#settings').innerHTML = '<section class="settings-panel"><h2>Common settings</h2>' +
    field('Sync interval seconds', 'interval', s.scheduler?.intervalSeconds || 900, 'number') +
    field('Storage root', 'storage-root', s.storage?.root || '~/Nutshell', 'text') +
    field('Backfill cutoff', 'cutoff', s.backfill?.cutoffDate || '', 'text') +
    field('Lookback months', 'lookback', s.backfill?.lookbackMonths || 6, 'number') +
    '<label><input id="remote-media" type="checkbox" ' + (s.dashboard?.remoteMedia !== false ? 'checked' : '') + '> Load remote thumbnails</label>' +
    '<h3>Sources</h3>' + ['youtube','podcasts','apple_notes','twitter'].map((source) => '<label><input class="enabled-source" data-source="' + source + '" type="checkbox" ' + (plugins[source]?.enabled !== false ? 'checked' : '') + '> ' + source + '</label>').join('<br>') +
    '<h3>YouTube</h3>' +
    field('Browser profile path/name', 'youtube-cookieProfile', plugins.youtube?.cookieProfile || '', 'text') +
    field('Overlap window hours', 'youtube-overlap', plugins.youtube?.overlapHours || 48, 'number') +
    field('Max activity pages', 'youtube-httpMaxPages', plugins.youtube?.httpMaxPages || 10, 'number') +
    '<h3>Podcasts</h3>' +
    field('Apple Podcasts DB path', 'podcasts-dbPath', plugins.podcasts?.dbPath || '', 'text') +
    field('Overlap window hours', 'podcasts-overlap', plugins.podcasts?.overlapHours || 48, 'number') +
    field('Read limit', 'podcasts-limit', plugins.podcasts?.limit || 500, 'number') +
    '<h3>Apple Notes</h3>' +
    field('Include folders', 'apple-notes-includeFolders', (plugins.apple_notes?.includeFolders || []).join(', '), 'text') +
    field('Exclude folders', 'apple-notes-excludeFolders', (plugins.apple_notes?.excludeFolders || []).join(', '), 'text') +
    '<h3>Twitter / X</h3>' +
    field('Browser profile path/name', 'twitter-cookieProfile', plugins.twitter?.cookieProfile || '', 'text') +
    field('Collections', 'twitter-collections', (plugins.twitter?.collections || []).join(', '), 'text') +
    field('Max pages per run', 'twitter-maxPages', plugins.twitter?.maxPages || 50, 'number') +
    field('Delay between pages ms', 'twitter-delayMs', plugins.twitter?.delayMs || 10000, 'number') +
    '<div class="source-actions"><button id="save-settings" class="primary">Save settings</button><button id="rebuild-projections" class="secondary">Rebuild projections</button><button id="open-data" class="secondary">Open data</button><button id="open-config" class="secondary">Open config</button><button id="open-logs" class="secondary">Open logs</button><button id="copy-diagnostics" class="secondary">Copy diagnostics</button></div></section>' +
    '<section class="settings-panel"><h2>Advanced JSONC</h2><div class="field"><label>Raw config</label><textarea id="raw-config">' + esc(state.config?.raw || '') + '</textarea></div><button id="save-raw" class="secondary">Validate and save raw</button></section>';
}

function field(label, id, value, type) {
  return '<div class="field"><label for="' + id + '">' + esc(label) + '</label><input id="' + id + '" type="' + type + '" value="' + esc(value) + '"></div>';
}

function showNotice(message) {
  const el = $('#notice');
  el.hidden = false;
  el.textContent = message;
}

document.addEventListener('click', async (event) => {
  const target = event.target;
  const tab = target.closest?.('.tab');
  if (tab) {
    document.querySelectorAll('.tab').forEach((el) => el.classList.remove('active'));
    document.querySelectorAll('.view').forEach((el) => el.classList.remove('active'));
    tab.classList.add('active');
    $('#' + tab.dataset.view + '-view').classList.add('active');
  }
  const sourceButton = target.closest?.('.source-chips .source-icon[data-source]');
  if (sourceButton) {
    const nextSource = sourceButton.dataset.source === state.source && state.source !== 'all' ? 'all' : sourceButton.dataset.source;
    state.source = nextSource || 'all';
    document.querySelectorAll('.source-chips .source-icon[data-source]').forEach((el) => {
      el.classList.toggle('active', el.dataset.source === state.source);
    });
    loadDays().catch((error) => showNotice(error.message));
  }
  const windowButton = target.closest?.('[data-window]');
  if (windowButton) {
    document.querySelectorAll('[data-window]').forEach((el) => el.classList.remove('active'));
    windowButton.classList.add('active');
    state.windowPreset = windowButton.dataset.window || '7d';
    $('.custom-range').hidden = state.windowPreset !== 'custom';
    loadDays().catch((error) => showNotice(error.message));
  }
  if (target.id === 'sync-all' || target.dataset.sync) {
    target.disabled = true;
    showNotice('Sync running...');
    try {
      const result = await api('/api/sync', { method: 'POST', body: JSON.stringify({ source: target.dataset.sync || 'all' }) });
      showNotice('Sync finished: ' + result.status);
      await loadAll();
    } catch (error) {
      showNotice(error.message);
    } finally {
      target.disabled = false;
    }
  }
  if (target.id === 'save-settings') saveSettings();
  if (target.id === 'save-raw') saveRaw();
  if (target.id === 'rebuild-projections') rebuildProjections();
  if (target.id === 'open-data') openTarget('data');
  if (target.id === 'open-config') openTarget('config');
  if (target.id === 'open-logs') openTarget('logs');
  if (target.id === 'copy-diagnostics') copyDiagnostics();
});

$('#search').addEventListener('input', (event) => {
  state.query = event.target.value || '';
  renderDays();
});

$('#from-date').addEventListener('change', (event) => {
  state.from = event.target.value || '';
  loadDays().catch((error) => showNotice(error.message));
});

$('#to-date').addEventListener('change', (event) => {
  state.to = event.target.value || '';
  loadDays().catch((error) => showNotice(error.message));
});

async function saveSettings() {
  const plugins = {};
  document.querySelectorAll('.enabled-source').forEach((input) => { plugins[input.dataset.source] = { enabled: input.checked }; });
  plugins.youtube = { ...plugins.youtube, cookieProfile: $('#youtube-cookieProfile').value, overlapHours: Number($('#youtube-overlap').value), httpMaxPages: Number($('#youtube-httpMaxPages').value) };
  plugins.podcasts = { ...plugins.podcasts, dbPath: $('#podcasts-dbPath').value, overlapHours: Number($('#podcasts-overlap').value), limit: Number($('#podcasts-limit').value) };
  plugins.apple_notes = { ...plugins.apple_notes, includeFolders: splitList($('#apple-notes-includeFolders').value), excludeFolders: splitList($('#apple-notes-excludeFolders').value) };
  plugins.twitter = { ...plugins.twitter, cookieProfile: $('#twitter-cookieProfile').value, collections: splitList($('#twitter-collections').value), maxPages: Number($('#twitter-maxPages').value), delayMs: Number($('#twitter-delayMs').value) };
  const settings = {
    scheduler: { intervalSeconds: Number($('#interval').value) },
    storage: { root: $('#storage-root').value },
    backfill: { cutoffDate: $('#cutoff').value, lookbackMonths: Number($('#lookback').value) },
    dashboard: { remoteMedia: $('#remote-media').checked },
    plugins,
  };
  const result = await api('/api/config', { method: 'POST', body: JSON.stringify({ settings }) });
  showNotice('Config saved. Changed: ' + summarizeChanges(result.changes) + '. Backup: ' + result.backup);
  await loadAll();
}

async function saveRaw() {
  const result = await api('/api/config', { method: 'POST', body: JSON.stringify({ raw: $('#raw-config').value }) });
  showNotice('Raw config saved. Backup: ' + result.backup);
  await loadAll();
}

async function openTarget(target) {
  const result = await api('/api/open', { method: 'POST', body: JSON.stringify({ target }) });
  showNotice('Opened ' + result.target);
}

async function rebuildProjections() {
  showNotice('Rebuilding projections...');
  const result = await api('/api/project', { method: 'POST', body: '{}' });
  showNotice('Projection rebuild finished: ' + (result.report?.outputs?.length || 0) + ' files.');
}

async function copyDiagnostics() {
  const diagnostics = await api('/api/diagnostics');
  await navigator.clipboard.writeText(JSON.stringify(diagnostics, null, 2));
  showNotice('Diagnostics copied.');
}

function splitList(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function summarizeChanges(changes) {
  const paths = (changes || []).map((item) => item.path).filter(Boolean);
  if (!paths.length) return 'none';
  return paths.slice(0, 8).join(', ') + (paths.length > 8 ? ', +' + (paths.length - 8) + ' more' : '');
}

loadAll().catch((error) => showNotice(error.message));
`;
