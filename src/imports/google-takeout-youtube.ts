import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import yauzl from "yauzl";
import type { TraceConfig } from "../config/config";
import { objectAt, stringAt } from "../config/config";
import { runId } from "../core/ids";
import { CLI_NAME } from "../core/product";
import { parseDate } from "../core/time";
import type { JsonObject, PluginSyncResult, RawObservation, TraceRecord } from "../core/types";
import type { TraceStore } from "../store/interface";
import { youtubeEventType, youtubeFingerprint, youtubeHappenedAt, youtubeSourceId, type YouTubeActivityItem } from "../plugins/builtin/youtube/identity";

export interface GoogleTakeoutYoutubeImportReport {
  dryRun: boolean;
  source: "youtube";
  path: string;
  available: boolean;
  counts: Record<string, number>;
  dateRange: {
    oldest: string | null;
    newest: string | null;
    oldestDateKey: string | null;
    newestDateKey: string | null;
  };
  files: string[];
  issues: string[];
  commit?: {
    runId: string;
    insertedObservations: number;
    insertedRecords: number;
    checkpointVersion: number;
  };
}

export async function importGoogleTakeoutYoutube(
  config: TraceConfig,
  store: TraceStore,
  archivePath: string,
  dryRun: boolean,
): Promise<GoogleTakeoutYoutubeImportReport> {
  const read = await readGoogleTakeoutYoutube(archivePath);
  const report: GoogleTakeoutYoutubeImportReport = {
    dryRun,
    source: "youtube",
    path: archivePath,
    available: read.available,
    counts: read.counts,
    dateRange: read.dateRange,
    files: read.files,
    issues: read.issues,
  };
  if (dryRun || !read.available || read.records.length === 0) return report;

  const checkpoint = await store.loadCheckpoint("youtube");
  const now = new Date();
  const existingState =
    checkpoint.state && typeof checkpoint.state === "object" && !Array.isArray(checkpoint.state) ? (checkpoint.state as JsonObject) : {};
  const result: PluginSyncResult = {
    observations: read.observations,
    records: read.records,
    nextCheckpoint: nextYoutubeArchiveState(config, existingState, read, archivePath, now),
    health: read.issues.map((issue) => ({
      level: "warning",
      source: "youtube",
      code: "google_takeout_import_issue",
      message: issue,
      detail: {},
      observedAt: now,
    })),
    metrics: {
      ...read.counts,
      files: read.files.length,
      oldestDateKey: read.dateRange.oldestDateKey,
      newestDateKey: read.dateRange.newestDateKey,
    },
    completed: true,
    partial: false,
  };
  const commit = await store.commitSync({
    source: "youtube",
    run: {
      id: runId("google_takeout_youtube"),
      command: `${CLI_NAME} import youtube --path ${archivePath}`,
      mode: "backfill",
      startedAt: now,
    },
    result,
    expectedCheckpointVersion: checkpoint.version,
  });
  report.commit = {
    runId: commit.runId,
    insertedObservations: commit.insertedObservations,
    insertedRecords: commit.insertedRecords,
    checkpointVersion: commit.checkpointVersion,
  };
  return report;
}

interface ReadGoogleTakeoutYoutube {
  available: boolean;
  counts: Record<string, number>;
  dateRange: GoogleTakeoutYoutubeImportReport["dateRange"];
  files: string[];
  issues: string[];
  observations: RawObservation[];
  records: TraceRecord[];
}

async function readGoogleTakeoutYoutube(archivePath: string): Promise<ReadGoogleTakeoutYoutube> {
  const output: ReadGoogleTakeoutYoutube = {
    available: Boolean(archivePath && existsSync(archivePath)),
    counts: {},
    dateRange: { oldest: null, newest: null, oldestDateKey: null, newestDateKey: null },
    files: [],
    issues: [],
    observations: [],
    records: [],
  };
  if (!output.available) {
    output.issues.push(`Google Takeout path missing: ${archivePath}`);
    return output;
  }

  const texts = await readArchiveTexts(archivePath);
  output.files = [...texts.keys()].sort();
  if (output.files.length === 0) output.issues.push("No YouTube history files were found in the Google Takeout path");

  const items: YouTubeActivityItem[] = [];
  for (const [name, text] of texts) {
    try {
      const parsed = name.toLowerCase().endsWith(".json") ? parseActivityJson(text, name) : parseActivityHtml(text, name);
      items.push(...parsed);
    } catch (error) {
      output.issues.push(`Could not parse ${name}: ${String(error)}`);
    }
  }

  const observedAt = new Date();
  const duplicateSourceIds = new Map<string, number>();
  for (const [index, base] of items.entries()) {
    const sourceId = youtubeSourceId(base);
    const duplicateIndex = duplicateSourceIds.get(sourceId) ?? 0;
    duplicateSourceIds.set(sourceId, duplicateIndex + 1);
    const item = duplicateIndex > 0 ? { ...base, import_id: `${sourceId}:takeout-duplicate:${index}` } : base;
    const happenedAt = youtubeHappenedAt(item);
    const type = youtubeEventType(item);
    output.counts[type] = (output.counts[type] ?? 0) + 1;
    output.counts.items = (output.counts.items ?? 0) + 1;
    output.observations.push({
      source: "youtube",
      observedAt,
      sourceRecordId: youtubeSourceId(item),
      fingerprint: youtubeFingerprint(item),
      payload: item as JsonObject,
      artifactPaths: [],
    });
    output.records.push({
      source: "youtube",
      collection: type.endsWith("searched") ? "searched" : "watched",
      kind: "event",
      type,
      sourceId: youtubeSourceId(item),
      happenedAt,
      observedAt,
      title: item.title || youtubeSourceId(item),
      url: item.title_url || null,
      bodyText: item.raw_text || null,
      artifactRefs: [],
      payload: item as JsonObject,
    });
    if (happenedAt) {
      const iso = happenedAt.toISOString();
      const dateKey = dateKeyFromDate(happenedAt);
      output.dateRange.oldest = output.dateRange.oldest && output.dateRange.oldest < iso ? output.dateRange.oldest : iso;
      output.dateRange.newest = output.dateRange.newest && output.dateRange.newest > iso ? output.dateRange.newest : iso;
      output.dateRange.oldestDateKey =
        output.dateRange.oldestDateKey && output.dateRange.oldestDateKey < dateKey ? output.dateRange.oldestDateKey : dateKey;
      output.dateRange.newestDateKey =
        output.dateRange.newestDateKey && output.dateRange.newestDateKey > dateKey ? output.dateRange.newestDateKey : dateKey;
    }
  }
  output.counts.files = output.files.length;
  if (items.length === 0) output.issues.push("No YouTube watch/search activity entries were parsed from the archive");
  return output;
}

async function readArchiveTexts(path: string): Promise<Map<string, string>> {
  if (statSync(path).isDirectory()) return readDirectoryTexts(path);
  if (isZipFile(path)) return readZipTexts(path);
  return readDirectActivityText(path);
}

function parseActivityJson(text: string, sourcePath: string): YouTubeActivityItem[] {
  const parsed = parsePossiblyJsArray(text);
  const rows = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && !Array.isArray(parsed) && Array.isArray((parsed as { activity?: unknown[] }).activity)
      ? (parsed as { activity: unknown[] }).activity
      : [];
  return rows
    .filter((item): item is JsonObject => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    .map((row) => activityItemFromJson(row, sourcePath))
    .filter((item): item is YouTubeActivityItem => Boolean(item));
}

function parsePossiblyJsArray(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) return JSON.parse(trimmed);
  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
  throw new Error("archive JSON was not an array or object");
}

function activityItemFromJson(row: JsonObject, sourcePath: string): YouTubeActivityItem | null {
  const titleText = stringAt(row, "title");
  const time = parseDate(row.time);
  if (!titleText || !time) return null;
  const lowerSource = sourcePath.toLowerCase();
  const controls = arrayOfStrings(row.activityControls).join(" ").toLowerCase();
  const verb = controls.includes("search") || lowerSource.includes("search-history") || /^searched\b/i.test(titleText) ? "Searched" : "Watched";
  const subtitle = firstObject(row.subtitles);
  return {
    source: "google_takeout",
    product: "YouTube",
    verb,
    title: normalizeActivityTitle(titleText, verb),
    title_url: stringAt(row, "titleUrl") || null,
    channel: stringAt(subtitle, "name") || "",
    channel_url: stringAt(subtitle, "url") || null,
    happened_at: time.toISOString(),
    date_key: dateKeyFromDate(time),
    raw_text: [titleText, stringAt(row, "description"), detailsText(row)].filter(Boolean).join("\n"),
  };
}

function parseActivityHtml(text: string, sourcePath: string): YouTubeActivityItem[] {
  const chunks = text.split(/<div[^>]+class=["'][^"']*(?:outer-cell|content-cell)[^"']*["'][^>]*>/i);
  const fallbackVerb = sourcePath.toLowerCase().includes("search-history") ? "Searched" : "Watched";
  const items: YouTubeActivityItem[] = [];
  for (const chunk of chunks) {
    const plain = htmlToText(chunk);
    if (!/\b(watched|searched)\b/i.test(plain)) continue;
    const time = parseDate(findDateText(plain));
    if (!time) continue;
    const links = [...chunk.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gis)].map((match) => ({
      url: decodeHtml(match[1] ?? ""),
      text: htmlToText(match[2] ?? ""),
    }));
    const verb = /\bsearched\b/i.test(plain) ? "Searched" : fallbackVerb;
    const firstLink = links[0];
    const secondLink = links[1];
    items.push({
      source: "google_takeout",
      product: "YouTube",
      verb,
      title: normalizeActivityTitle(firstLine(plain), verb),
      title_url: firstLink?.url || null,
      channel: secondLink?.text || "",
      channel_url: secondLink?.url || null,
      happened_at: time.toISOString(),
      date_key: dateKeyFromDate(time),
      raw_text: plain,
    });
  }
  return items;
}

function nextYoutubeArchiveState(
  config: TraceConfig,
  existingState: JsonObject,
  read: ReadGoogleTakeoutYoutube,
  archivePath: string,
  now: Date,
): JsonObject {
  const backfill = objectAt(existingState, "backfill");
  const bulk = objectAt(backfill, "bulk");
  const live = objectAt(backfill, "live");
  const cutoffDateKey = configuredCutoffDate(config, now).replaceAll("-", "");
  const archiveComplete = Boolean(read.dateRange.oldestDateKey && read.dateRange.oldestDateKey <= cutoffDateKey);
  return {
    ...existingState,
    backfill: {
      ...backfill,
      imports: {
        ...objectAt(backfill, "imports"),
        google_youtube: {
          importedAt: now.toISOString(),
          path: archivePath,
          counts: read.counts as unknown as JsonObject,
          files: read.files,
          oldest: read.dateRange.oldest,
          newest: read.dateRange.newest,
          oldestDateKey: read.dateRange.oldestDateKey,
          newestDateKey: read.dateRange.newestDateKey,
        },
      },
      bulk: {
        ...bulk,
        complete: true,
        importedAt: now.toISOString(),
        sources: {
          ...objectAt(bulk, "sources"),
          google_youtube: {
            complete: true,
            path: archivePath,
            importedAt: now.toISOString(),
            counts: read.counts as unknown as JsonObject,
            files: read.files,
            oldest: read.dateRange.oldest,
            newest: read.dateRange.newest,
            oldestDateKey: read.dateRange.oldestDateKey,
            newestDateKey: read.dateRange.newestDateKey,
          },
        },
      },
      live: {
        ...live,
        archiveImportedAt: now.toISOString(),
        archiveOldestDateKey: read.dateRange.oldestDateKey,
        archiveNewestDateKey: read.dateRange.newestDateKey,
        archiveComplete,
        complete: archiveComplete ? true : live.complete === true,
        lastPartialReason: archiveComplete ? null : live.lastPartialReason ?? "archive_does_not_reach_stop_date",
      },
    },
  };
}

function configuredCutoffDate(config: TraceConfig, now: Date): string {
  const backfill = objectAt(config.data, "backfill");
  if (typeof backfill.cutoffDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(backfill.cutoffDate)) return backfill.cutoffDate;
  const months = typeof backfill.lookbackMonths === "number" && Number.isFinite(backfill.lookbackMonths) ? backfill.lookbackMonths : 6;
  const date = new Date(now);
  date.setUTCMonth(date.getUTCMonth() - months);
  return date.toISOString().slice(0, 10);
}

function readDirectoryTexts(root: string): Map<string, string> {
  const output = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = statSync(path);
      if (stat.isDirectory()) {
        walk(path);
      } else if (isCandidateHistoryPath(path)) {
        output.set(path, readFileSync(path, "utf8"));
      }
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
        if (!isCandidateHistoryPath(entry.fileName)) {
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

function readDirectActivityText(path: string): Map<string, string> {
  const text = readFileSync(path, "utf8");
  const name = directActivityName(path, text);
  return new Map([[name, text]]);
}

function directActivityName(path: string, text: string): string {
  if (isCandidateHistoryPath(path)) return path;
  const trimmed = text.trimStart();
  const extension = trimmed.startsWith("[") || trimmed.startsWith("{") ? "json" : "html";
  const safeBase = basename(path).replace(/[^a-z0-9._-]+/gi, "-").replace(/\.(json|html?|zip)$/i, "");
  return `myactivity-youtube-${safeBase || "archive"}.${extension}`;
}

function isZipFile(path: string): boolean {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(4);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    return bytes >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && (buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07);
  } finally {
    closeSync(fd);
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

function isCandidateHistoryPath(path: string): boolean {
  const lower = path.toLowerCase();
  if (!lower.endsWith(".json") && !lower.endsWith(".html") && !lower.endsWith(".htm")) return false;
  if (!lower.includes("youtube")) return false;
  return lower.includes("myactivity") || lower.includes("my activity") || lower.includes("watch-history") || lower.includes("search-history");
}

function normalizeActivityTitle(title: string, verb: string): string {
  let output = title.trim();
  output = output.replace(/^watched\s+/i, "");
  output = output.replace(/^searched for\s+/i, "");
  output = output.replace(/^searched\s+/i, "");
  if (verb === "Searched" && output && !/^search:/i.test(output)) return `Search: ${output}`;
  return output || title.trim();
}

function detailsText(row: JsonObject): string {
  const details = row.details;
  if (!Array.isArray(details)) return "";
  return details
    .map((item) => (item && typeof item === "object" && !Array.isArray(item) ? stringAt(item as JsonObject, "name") : ""))
    .filter(Boolean)
    .join("\n");
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function firstObject(value: unknown): JsonObject {
  if (!Array.isArray(value)) return {};
  const first = value[0];
  return first && typeof first === "object" && !Array.isArray(first) ? (first as JsonObject) : {};
}

function dateKeyFromDate(date: Date): string {
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
}

function htmlToText(html: string): string {
  return decodeHtml(
    html
      .replace(/<script\b[\s\S]*?<\/script>/gi, "")
      .replace(/<style\b[\s\S]*?<\/style>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/div>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n\s+/g, "\n")
      .trim(),
  );
}

function decodeHtml(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function firstLine(text: string): string {
  return text.split("\n").map((line) => line.trim()).find(Boolean) ?? text.trim();
}

function findDateText(text: string): string {
  const iso = text.match(/\d{4}-\d{2}-\d{2}T[^\s]+/);
  if (iso) return iso[0]!;
  const month = text.match(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},\s+\d{4},?\s+[^\n]+/i);
  return month ? month[0]!.replace(/,\s+/, " ") : "";
}
