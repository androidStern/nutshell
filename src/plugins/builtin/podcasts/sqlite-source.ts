import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import type { PodcastEpisodeRow } from "./identity";

const APPLE_EPOCH = 978_307_200;

export interface PodcastBackfillCursor {
  lastPlayedRaw: number;
  episodePk: number;
}

export interface PodcastBackfillPage {
  rows: PodcastEpisodeRow[];
  nextCursor: PodcastBackfillCursor | null;
}

export interface PodcastDatabaseProbe {
  ok: true;
  requiredTables: string[];
}

export interface PodcastFileAccessProbe {
  ok: boolean;
  code: "ok" | "permission_denied" | "timeout" | "read_failed";
  message: string;
  stderr: string;
}

export type PodcastProgress = (event: Record<string, unknown>) => void;

type RawPodcastRow = PodcastEpisodeRow & {
  last_played_raw: number | null;
  published_raw: number | null;
  podcast_image_url?: string | null;
  podcast_artwork_template_url?: string | null;
  episode_artwork_template_url?: string | null;
};

export function appleTimestampToIso(value: number | null): string | null {
  if (value === null || value === undefined) return null;
  return new Date((value + APPLE_EPOCH) * 1000).toISOString();
}

export async function readPodcastRows(dbPath: string, since: Date, limit: number, timeoutMs: number): Promise<PodcastEpisodeRow[]> {
  return runPodcastWorker({ op: "recent", dbPath, since: since.toISOString(), limit, timeoutMs }) as Promise<PodcastEpisodeRow[]>;
}

export async function readPodcastBackfillPage(
  dbPath: string,
  cursor: PodcastBackfillCursor | null,
  limit: number,
  timeoutMs: number,
): Promise<PodcastBackfillPage> {
  return runPodcastWorker({ op: "backfill", dbPath, cursor, limit, timeoutMs }) as Promise<PodcastBackfillPage>;
}

export async function probePodcastDatabase(dbPath: string, timeoutMs: number): Promise<PodcastDatabaseProbe> {
  return runPodcastWorker({ op: "probe", dbPath, timeoutMs }) as Promise<PodcastDatabaseProbe>;
}

export async function probePodcastFileAccess(dbPath: string, timeoutMs: number): Promise<PodcastFileAccessProbe> {
  if (!existsSync(dbPath)) {
    return { ok: false, code: "read_failed", message: `Missing Apple Podcasts database: ${dbPath}`, stderr: "" };
  }
  const startedAt = Date.now();
  let fd: number | null = null;
  try {
    fd = openSync(dbPath, "r");
    const buffer = Buffer.alloc(1);
    readSync(fd, buffer, 0, 1, 0);
    if (Date.now() - startedAt > timeoutMs) {
      return {
        ok: false,
        code: "timeout",
        message: "Timed out while trying to read the Apple Podcasts database",
        stderr: `probe exceeded ${timeoutMs}ms`,
      };
    }
    return { ok: true, code: "ok", message: "Apple Podcasts database is readable", stderr: "" };
  } catch (error) {
    const text = String(error instanceof Error ? error.message : error);
    if (/operation not permitted|permission denied|EACCES|EPERM/i.test(text)) {
      return {
        ok: false,
        code: "permission_denied",
        message: "Apple Podcasts database is blocked by macOS privacy permissions",
        stderr: text,
      };
    }
    return {
      ok: false,
      code: "read_failed",
      message: "Apple Podcasts database read probe failed",
      stderr: text,
    };
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export async function probePodcastDatabaseDirect(dbPath: string, timeoutMs: number, progress?: PodcastProgress): Promise<PodcastDatabaseProbe> {
  if (!existsSync(dbPath)) throw new Error(`Missing Apple Podcasts database: ${dbPath}`);
  const startedAt = Date.now();
  progress?.({ phase: "before_open", dbPath });
  const db = new Database(dbPath, { readonly: true, create: false });
  try {
    progress?.({ phase: "after_open", elapsedMs: Date.now() - startedAt });
    db.exec(`pragma busy_timeout=${Math.max(1, Math.trunc(timeoutMs))}`);
    progress?.({ phase: "after_busy_timeout", elapsedMs: Date.now() - startedAt });
    const rows = db.query("select name from sqlite_master where type = 'table' and name in ('ZMTEPISODE', 'ZMTPODCAST')").all() as Array<{ name: string }>;
    progress?.({ phase: "after_schema_query", elapsedMs: Date.now() - startedAt, rowCount: rows.length });
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Apple Podcasts SQLite probe exceeded timeout budget (${timeoutMs}ms)`);
    }
    const names = rows.map((row) => row.name).sort();
    const missing = ["ZMTEPISODE", "ZMTPODCAST"].filter((name) => !names.includes(name));
    if (missing.length) throw new Error(`Apple Podcasts SQLite schema missing required tables: ${missing.join(", ")}`);
    return { ok: true, requiredTables: names };
  } finally {
    db.close();
  }
}

export async function readPodcastRowsDirect(dbPath: string, since: Date, limit: number, timeoutMs: number, progress?: PodcastProgress): Promise<PodcastEpisodeRow[]> {
  if (!existsSync(dbPath)) throw new Error(`Missing Apple Podcasts database: ${dbPath}`);
  const cutoffApple = since.getTime() / 1000 - APPLE_EPOCH;
  const safeLimit = safeLimitFor(limit);
  const sql = `${baseSelect()}
        where e.ZLASTDATEPLAYED is not null
          and e.ZLASTDATEPLAYED >= ${Number(cutoffApple)}
        order by e.ZLASTDATEPLAYED desc, e.Z_PK desc
        limit ${safeLimit}`;
  const rows = await queryPodcastRows(dbPath, sql, timeoutMs, progress);
  return rows.map(mapPodcastRow);
}

export async function readPodcastBackfillPageDirect(
  dbPath: string,
  cursor: PodcastBackfillCursor | null,
  limit: number,
  timeoutMs: number,
  progress?: PodcastProgress,
): Promise<PodcastBackfillPage> {
  if (!existsSync(dbPath)) throw new Error(`Missing Apple Podcasts database: ${dbPath}`);
  const safeLimit = safeLimitFor(limit);
  const cursorWhere = cursor
    ? `and (
          e.ZLASTDATEPLAYED < ${Number(cursor.lastPlayedRaw)}
          or (e.ZLASTDATEPLAYED = ${Number(cursor.lastPlayedRaw)} and e.Z_PK < ${Number(cursor.episodePk)})
        )`
    : "";
  const sql = `${baseSelect()}
        where e.ZLASTDATEPLAYED is not null
          ${cursorWhere}
        order by e.ZLASTDATEPLAYED desc, e.Z_PK desc
        limit ${safeLimit}`;
  const rows = await queryPodcastRows(dbPath, sql, timeoutMs, progress);
  const last = rows.at(-1);
  return {
    rows: rows.map(mapPodcastRow),
    nextCursor:
      rows.length >= safeLimit && last?.last_played_raw !== null && last?.last_played_raw !== undefined
        ? { lastPlayedRaw: Number(last.last_played_raw), episodePk: Number(last.episode_pk) }
        : null,
  };
}

function baseSelect(): string {
  return `select
          e.Z_PK as episode_pk,
          p.ZTITLE as podcast_title,
          p.ZAUTHOR as podcast_author,
          p.ZFEEDURL as podcast_feed_url,
          p.ZIMAGEURL as podcast_image_url,
          p.ZLOGOIMAGEURL as podcast_logo_image_url,
          p.ZARTWORKTEMPLATEURL as podcast_artwork_template_url,
          p.ZARTWORKPRIMARYCOLOR as podcast_primary_color,
          e.ZTITLE as episode_title,
          e.ZAUTHOR as episode_author,
          e.ZARTWORKTEMPLATEURL as episode_artwork_template_url,
          e.ZENCLOSUREURL as audio_url,
          e.ZWEBPAGEURL as webpage_url,
          e.ZGUID as guid,
          e.ZPLAYCOUNT as play_count,
          e.ZPLAYSTATE as play_state,
          e.ZHASBEENPLAYED as has_been_played,
          e.ZPLAYHEAD as playhead_seconds,
          e.ZDURATION as duration_seconds,
          e.ZLASTDATEPLAYED as last_played_raw,
          e.ZPUBDATE as published_raw
        from ZMTEPISODE e
        join ZMTPODCAST p on e.ZPODCAST = p.Z_PK`;
}

async function queryPodcastRows(dbPath: string, sql: string, timeoutMs: number, progress?: PodcastProgress): Promise<RawPodcastRow[]> {
  const startedAt = Date.now();
  progress?.({ phase: "before_open", dbPath });
  const db = new Database(dbPath, { readonly: true, create: false });
  try {
    progress?.({ phase: "after_open", elapsedMs: Date.now() - startedAt });
    db.exec(`pragma busy_timeout=${Math.max(1, Math.trunc(timeoutMs))}`);
    progress?.({ phase: "after_busy_timeout", elapsedMs: Date.now() - startedAt });
    const rows = db.query(sql).all() as RawPodcastRow[];
    progress?.({ phase: "after_query", elapsedMs: Date.now() - startedAt, rowCount: rows.length });
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Apple Podcasts SQLite query exceeded timeout budget (${timeoutMs}ms)`);
    }
    return rows;
  } finally {
    db.close();
  }
}

function mapPodcastRow(row: RawPodcastRow): PodcastEpisodeRow {
  return {
    episode_pk: row.episode_pk,
    podcast_title: row.podcast_title,
    podcast_author: row.podcast_author,
    podcast_feed_url: row.podcast_feed_url,
    podcast_artwork_url: normalizeArtworkUrl(row.podcast_image_url ?? row.podcast_artwork_template_url ?? row.podcast_logo_image_url ?? null),
    podcast_logo_image_url: normalizeArtworkUrl(row.podcast_logo_image_url ?? null),
    podcast_primary_color: row.podcast_primary_color,
    episode_title: row.episode_title,
    episode_author: row.episode_author,
    episode_artwork_url: normalizeArtworkUrl(row.episode_artwork_template_url ?? null),
    artwork_url: normalizeArtworkUrl(row.episode_artwork_template_url ?? row.podcast_image_url ?? row.podcast_artwork_template_url ?? row.podcast_logo_image_url ?? null),
    audio_url: row.audio_url,
    webpage_url: row.webpage_url,
    guid: row.guid,
    play_count: row.play_count,
    play_state: row.play_state,
    has_been_played: row.has_been_played,
    playhead_seconds: row.playhead_seconds,
    duration_seconds: row.duration_seconds,
    last_played_at: appleTimestampToIso(row.last_played_raw),
    published_at: appleTimestampToIso(row.published_raw),
    completion_ratio: row.duration_seconds ? Number(((row.playhead_seconds || 0) / row.duration_seconds).toFixed(4)) : null,
  };
}

function normalizeArtworkUrl(value: string | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.replaceAll("{w}", "600").replaceAll("{h}", "600").replaceAll("{f}", "jpg");
}

function safeLimitFor(limit: number): number {
  return Math.max(1, Math.min(10_000, Math.trunc(limit)));
}

async function runPodcastWorker(input: Record<string, unknown>): Promise<unknown> {
  const proc = Bun.spawn(podcastWorkerCommand(), {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const timeoutMs = typeof input.timeoutMs === "number" ? Math.max(1, Math.trunc(input.timeoutMs)) : 10_000;
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    proc.stdin.write(JSON.stringify(input));
    proc.stdin.end();
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) {
      const detail = (stderr.trim() || stdout.trim()).slice(-4000);
      throw new Error(detail ? `Apple Podcasts worker exited ${code}; ${detail}` : `Apple Podcasts worker exited ${code}`);
    }
    return JSON.parse(stdout) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

function podcastWorkerCommand(): string[] {
  if (import.meta.dir.startsWith("/$bunfs/")) return [process.execPath, "__personal_trace_podcasts_sqlite_worker"];
  return [process.execPath, join(import.meta.dir, "sqlite-worker.ts")];
}
