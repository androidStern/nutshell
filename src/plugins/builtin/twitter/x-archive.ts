import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import yauzl from "yauzl";
import { fingerprint } from "../../../core/ids";
import type { JsonObject, PluginRecordReader, PluginSyncResult, RawObservation, TraceRecord } from "../../../core/types";
import { parseTwitterTimestamp } from "./identity";
import {
  buildTweetDisplayPayload,
  enqueueUnresolvedTweetTargets,
  quoteAndReplyTargets,
  tweetTarget,
  withTweetDisplay,
  type TweetEnrichmentTarget,
  type TwitterEnrichmentState,
} from "./enrichment";

export interface XArchiveRead {
  available: boolean;
  counts: Record<string, number>;
  dateRange: {
    oldest: string | null;
    newest: string | null;
  };
  files: string[];
  issues: string[];
  observations: RawObservation[];
  records: TraceRecord[];
  enrichmentTargets: TweetEnrichmentTarget[];
}

const ARCHIVE_FILES = new Set([
  "data/tweets.js",
  "data/tweet.js",
  "data/like.js",
  "data/following.js",
  "data/bookmark.js",
  "data/bookmarks.js",
]);

const TWITTER_EPOCH_MS = 1_288_834_974_657n;

export async function importXArchiveResult(
  path: string,
  existingState: JsonObject,
  observedAt: Date,
  records: PluginRecordReader,
): Promise<PluginSyncResult> {
  const read = await readXArchive(path, observedAt);
  const state = nextXArchiveState(existingState, read, path, observedAt);
  const queued = await enqueueUnresolvedTweetTargets(records, enrichmentState(state), read.enrichmentTargets);
  return {
    observations: read.observations,
    records: read.records,
    nextCheckpoint: state,
    health: read.issues.map((issue) => ({
      level: "warning",
      source: "twitter",
      code: "x_archive_import_issue",
      message: issue,
      detail: {},
      observedAt,
    })),
    metrics: {
      ...read.counts,
      files: read.files.length,
      oldest: read.dateRange.oldest,
      newest: read.dateRange.newest,
      enrichmentQueued: queued,
      available: read.available,
      path,
    },
    completed: read.available && read.records.length > 0,
    partial: !read.available || read.records.length === 0,
  };
}

async function readXArchive(path: string, observedAt: Date): Promise<XArchiveRead> {
  const output: XArchiveRead = {
    available: Boolean(path && existsSync(path)),
    counts: {},
    dateRange: { oldest: null, newest: null },
    files: [],
    issues: [],
    observations: [],
    records: [],
    enrichmentTargets: [],
  };
  if (!output.available) {
    output.issues.push(`X archive path missing: ${path}`);
    return output;
  }

  const texts = await readArchiveTexts(path);
  output.files = [...texts.keys()].sort();
  if (output.files.length === 0) output.issues.push("No supported X archive data files were found");

  parseTweets(output, texts.get("data/tweets.js") ?? texts.get("data/tweet.js") ?? "", observedAt);
  parseLikes(output, texts.get("data/like.js") ?? "", observedAt);
  parseBookmarks(output, texts.get("data/bookmark.js") ?? texts.get("data/bookmarks.js") ?? "", observedAt);
  parseFollowing(output, texts.get("data/following.js") ?? "", observedAt);
  output.counts.items = output.observations.length;
  if (output.observations.length === 0) output.issues.push("No tweets, likes, bookmarks, or following rows were parsed from the X archive");
  return output;
}

function parseTweets(output: XArchiveRead, text: string, observedAt: Date): void {
  for (const row of parseArchiveArray(text, "tweets", output)) {
    const tweet = jsonObjectAt(row, "tweet");
    const id = stringAt(tweet, "id_str") || stringAt(tweet, "id");
    if (!id) continue;
    const happenedAt = parseTwitterTimestamp(stringAt(tweet, "created_at"));
    const fullText = stringAt(tweet, "full_text") || stringAt(tweet, "text") || null;
    output.counts.authored = (output.counts.authored ?? 0) + 1;
    observe(output, observedAt, "authored", id, tweet);
    tweetEntity(output, observedAt, id, fullText, happenedAt, tweet);
    const display = buildTweetDisplayPayload({
      action: "authored",
      tweetId: id,
      fallbackText: fullText,
      fallbackUrl: `https://x.com/i/web/status/${id}`,
      happenedAt,
    });
    output.records.push({
      source: "twitter",
      collection: "authored",
      kind: "event",
      type: "twitter.authored",
      sourceId: id,
      happenedAt,
      observedAt,
      title: fullText?.slice(0, 120) || id,
      url: `https://x.com/i/web/status/${id}`,
      bodyText: fullText,
      artifactRefs: [],
      payload: withTweetDisplay(tweet, display),
    });
    pushTarget(output, tweetTarget(id, "archive_authored", id, observedAt));
    output.enrichmentTargets.push(...quoteAndReplyTargets(tweet, id, observedAt));
    trackRange(output, happenedAt);
  }
}

function parseLikes(output: XArchiveRead, text: string, observedAt: Date): void {
  for (const row of parseArchiveArray(text, "likes", output)) {
    const like = jsonObjectAt(row, "like");
    const id = stringAt(like, "tweetId") || stringAt(like, "tweet_id");
    if (!id) continue;
    const fullText = stringAt(like, "fullText") || null;
    const happenedAt = archiveTweetDate(like, id);
    output.counts.likes = (output.counts.likes ?? 0) + 1;
    observe(output, observedAt, "likes", id, like);
    tweetEntity(output, observedAt, id, fullText, happenedAt, like);
    collectionEvent(output, "likes", "twitter.liked", "liked", id, fullText, stringAt(like, "expandedUrl") || `https://x.com/i/web/status/${id}`, happenedAt, observedAt, like);
    pushTarget(output, tweetTarget(id, "archive_like", `likes:${id}`, observedAt));
    output.enrichmentTargets.push(...quoteAndReplyTargets(like, `likes:${id}`, observedAt));
    trackRange(output, happenedAt);
  }
}

function parseBookmarks(output: XArchiveRead, text: string, observedAt: Date): void {
  for (const row of parseArchiveArray(text, "bookmarks", output)) {
    const bookmark = jsonObjectAt(row, "bookmark");
    const source = Object.keys(bookmark).length ? bookmark : row;
    const id = stringAt(source, "tweetId") || stringAt(source, "tweet_id") || stringAt(source, "id_str") || stringAt(source, "id");
    if (!id) continue;
    const fullText = stringAt(source, "fullText") || stringAt(source, "full_text") || stringAt(source, "text") || null;
    const happenedAt = archiveTweetDate(source, id);
    output.counts.bookmarks = (output.counts.bookmarks ?? 0) + 1;
    observe(output, observedAt, "bookmarks", id, source);
    tweetEntity(output, observedAt, id, fullText, happenedAt, source);
    collectionEvent(output, "bookmarks", "twitter.bookmarked", "bookmarked", id, fullText, stringAt(source, "expandedUrl") || `https://x.com/i/web/status/${id}`, happenedAt, observedAt, source);
    pushTarget(output, tweetTarget(id, "archive_bookmark", `bookmarks:${id}`, observedAt));
    output.enrichmentTargets.push(...quoteAndReplyTargets(source, `bookmarks:${id}`, observedAt));
    trackRange(output, happenedAt);
  }
}

function parseFollowing(output: XArchiveRead, text: string, observedAt: Date): void {
  for (const row of parseArchiveArray(text, "following", output)) {
    const following = jsonObjectAt(row, "following");
    const profileId = stringAt(following, "accountId") || userIdFromLink(stringAt(following, "userLink"));
    if (!profileId) continue;
    output.counts.following = (output.counts.following ?? 0) + 1;
    observe(output, observedAt, "following", profileId, following);
    output.records.push({
      source: "twitter",
      collection: "following",
      kind: "relation",
      type: "twitter.following",
      sourceId: `archive:${profileId}`,
      happenedAt: null,
      observedAt,
      title: profileId,
      url: stringAt(following, "userLink") || null,
      bodyText: null,
      artifactRefs: [],
      payload: following,
    });
  }
}

function observe(output: XArchiveRead, observedAt: Date, collection: string, sourceRecordId: string, payload: JsonObject): void {
  output.observations.push({
    source: "twitter",
    observedAt,
    sourceRecordId,
    fingerprint: fingerprint({ provider: "x_archive", collection, sourceRecordId, payload }),
    payload,
    artifactPaths: [],
  });
}

function tweetEntity(output: XArchiveRead, observedAt: Date, id: string, fullText: string | null, happenedAt: Date | null, payload: JsonObject): void {
  output.records.push({
    source: "twitter",
    collection: "tweets",
    kind: "entity",
    type: "twitter.tweet",
    sourceId: id,
    happenedAt,
    observedAt,
    title: fullText?.slice(0, 120) || id,
    url: `https://x.com/i/web/status/${id}`,
    bodyText: fullText,
    artifactRefs: [],
    payload,
  });
}

function collectionEvent(
  output: XArchiveRead,
  collection: "bookmarks" | "likes",
  type: "twitter.bookmarked" | "twitter.liked",
  action: "bookmarked" | "liked",
  id: string,
  fullText: string | null,
  url: string,
  happenedAt: Date | null,
  observedAt: Date,
  payload: JsonObject,
): void {
  const display = buildTweetDisplayPayload({
    action,
    tweetId: id,
    fallbackText: fullText,
    fallbackUrl: url,
    happenedAt,
  });
  output.records.push({
    source: "twitter",
    collection,
    kind: "event",
    type,
    sourceId: `${collection}:${id}`,
    happenedAt,
    observedAt,
    title: fullText?.slice(0, 120) || id,
    url,
    bodyText: fullText,
    artifactRefs: [],
    payload: withTweetDisplay(payload, display),
  });
}

function pushTarget(output: XArchiveRead, target: TweetEnrichmentTarget | null): void {
  if (target) output.enrichmentTargets.push(target);
}

function archiveTweetDate(payload: JsonObject, tweetId: string): Date | null {
  const nestedTweet = jsonObjectAt(payload, "tweet");
  return (
    parseTwitterTimestamp(stringAt(payload, "created_at")) ??
    parseTwitterTimestamp(stringAt(payload, "createdAt")) ??
    parseTwitterTimestamp(stringAt(payload, "tweet_created_at")) ??
    parseTwitterTimestamp(stringAt(payload, "tweetCreatedAt")) ??
    parseTwitterTimestamp(stringAt(nestedTweet, "created_at")) ??
    parseTwitterTimestamp(stringAt(nestedTweet, "createdAt")) ??
    twitterSnowflakeDate(tweetId)
  );
}

function twitterSnowflakeDate(tweetId: string): Date | null {
  if (!/^\d{12,22}$/.test(tweetId)) return null;
  try {
    const timestampMs = (BigInt(tweetId) >> 22n) + TWITTER_EPOCH_MS;
    const date = new Date(Number(timestampMs));
    return parseTwitterTimestamp(date.toISOString());
  } catch {
    return null;
  }
}

function trackRange(output: XArchiveRead, date: Date | null): void {
  if (!date) return;
  const iso = date.toISOString();
  output.dateRange.oldest = output.dateRange.oldest && output.dateRange.oldest < iso ? output.dateRange.oldest : iso;
  output.dateRange.newest = output.dateRange.newest && output.dateRange.newest > iso ? output.dateRange.newest : iso;
}

function nextXArchiveState(existingState: JsonObject, read: XArchiveRead, archivePath: string, now: Date): JsonObject {
  const backfill = jsonObjectAt(existingState, "backfill");
  const imports = jsonObjectAt(backfill, "imports");
  const enrichment = enrichmentState(existingState);
  return {
    ...existingState,
    enrichment,
    backfill: {
      ...backfill,
      imports: {
        ...imports,
        x_archive: {
          importedAt: now.toISOString(),
          path: archivePath,
          counts: read.counts as unknown as JsonObject,
          files: read.files,
          oldest: read.dateRange.oldest,
          newest: read.dateRange.newest,
        },
      },
    },
  };
}

function enrichmentState(state: JsonObject): TwitterEnrichmentState {
  const current = jsonObjectAt(state, "enrichment") as TwitterEnrichmentState;
  state.enrichment = current;
  current.queue ??= {};
  return current;
}

async function readArchiveTexts(path: string): Promise<Map<string, string>> {
  if (statSync(path).isDirectory()) return readDirectoryTexts(path);
  return readZipTexts(path);
}

function readDirectoryTexts(root: string): Map<string, string> {
  const output = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = statSync(path);
      if (stat.isDirectory()) walk(path);
      else if (ARCHIVE_FILES.has(relativeArchivePath(root, path))) output.set(relativeArchivePath(root, path), readFileSync(path, "utf8"));
    }
  };
  walk(root);
  return output;
}

async function readZipTexts(path: string): Promise<Map<string, string>> {
  const output = new Map<string, string>();
  const zipfile = await openZip(path);
  try {
    return await new Promise((resolve, reject) => {
      zipfile.on("entry", (entry: yauzl.Entry) => {
        if (!ARCHIVE_FILES.has(entry.fileName)) {
          zipfile.readEntry();
          return;
        }
        zipfile.openReadStream(entry, (error, stream) => {
          if (error || !stream) {
            reject(error ?? new Error(`Could not read ${entry.fileName}`));
            return;
          }
          const chunks: Buffer[] = [];
          stream.on("data", (chunk: Buffer) => chunks.push(chunk));
          stream.on("error", reject);
          stream.on("end", () => {
            output.set(entry.fileName, Buffer.concat(chunks).toString("utf8"));
            zipfile.readEntry();
          });
        });
      });
      zipfile.on("error", reject);
      zipfile.on("end", () => resolve(output));
      zipfile.readEntry();
    });
  } finally {
    zipfile.close();
  }
}

function openZip(path: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true }, (error, zipfile) => {
      if (error || !zipfile) reject(error ?? new Error(`Could not open ${path}`));
      else resolve(zipfile);
    });
  });
}

function relativeArchivePath(root: string, path: string): string {
  return path.slice(root.length).replace(/^\/+/, "");
}

function parseArchiveArray(text: string, label: string, output: XArchiveRead): JsonObject[] {
  if (!text) return [];
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) {
    output.issues.push(`X archive ${label} file was not a JavaScript array`);
    return [];
  }
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is JsonObject => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
  } catch (error) {
    output.issues.push(`Could not parse X archive ${label}: ${String(error)}`);
    return [];
  }
}

function jsonObjectAt(value: JsonObject, key: string): JsonObject {
  const child = value[key];
  return child && typeof child === "object" && !Array.isArray(child) ? (child as JsonObject) : {};
}

function stringAt(value: JsonObject, key: string): string {
  const child = value[key];
  return typeof child === "string" ? child : "";
}

function userIdFromLink(link: string): string {
  const match = link.match(/[?&]user_id=([^&]+)/);
  return match ? decodeURIComponent(match[1]!) : "";
}
