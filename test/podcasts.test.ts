import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginContext } from "../src/core/types";
import { PodcastsPlugin } from "../src/plugins/builtin/podcasts/plugin";

test("podcasts health check probes the local database schema", async () => {
  const root = mkdtempSync(join(tmpdir(), "trace-podcasts-"));
  try {
    const dbPath = join(root, "MTLibrary.sqlite");
    const db = new Database(dbPath, { create: true });
    db.exec("create table ZMTEPISODE (Z_PK integer primary key); create table ZMTPODCAST (Z_PK integer primary key)");
    db.close();

    const plugin = new PodcastsPlugin();
    const findings = await plugin.check(context(root, dbPath));
    expect(findings).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("podcasts health check reports schema drift", async () => {
  const root = mkdtempSync(join(tmpdir(), "trace-podcasts-"));
  try {
    const dbPath = join(root, "MTLibrary.sqlite");
    const db = new Database(dbPath, { create: true });
    db.exec("create table unrelated (id integer primary key)");
    db.close();

    const plugin = new PodcastsPlugin();
    const findings = await plugin.check(context(root, dbPath));
    expect(findings[0]?.code).toBe("podcasts_db_probe_failed");
    expect(findings[0]?.level).toBe("critical");
    expect(findings[0]?.guidance?.state).toBe("blocked_bug");
    expect(findings[0]?.guidance?.fix?.length).toBeGreaterThan(0);
    expect(findings[0]?.guidance?.confirm).toBe("nutshell doctor podcasts");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("podcasts health check reports a missing database with guidance", async () => {
  const root = mkdtempSync(join(tmpdir(), "trace-podcasts-"));
  try {
    const dbPath = join(root, "MTLibrary.sqlite");

    const plugin = new PodcastsPlugin();
    const findings = await plugin.check(context(root, dbPath));
    expect(findings[0]?.code).toBe("podcasts_db_missing");
    expect(findings[0]?.level).toBe("critical");
    expect(findings[0]?.guidance?.state).toBe("ready_empty");
    expect(findings[0]?.guidance?.fix?.length).toBeGreaterThan(0);
    expect(findings[0]?.guidance?.confirm).toBe("nutshell doctor podcasts");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("podcasts recent sync reports a missing database as podcasts_db_missing", async () => {
  const root = mkdtempSync(join(tmpdir(), "trace-podcasts-"));
  try {
    const dbPath = join(root, "MTLibrary.sqlite");

    const plugin = new PodcastsPlugin();
    const result = await plugin.sync(
      {
        ...context(root, dbPath),
        config: { dbPath, timeoutMs: 2_000, attempts: 1 },
      },
      {
        source: "podcasts",
        mode: "recent",
        window: null,
        collections: [],
        budget: plugin.manifest.defaultBudget,
        dryRun: false,
      },
      { version: 0, state: {} },
    );
    expect(result.completed).toBe(false);
    expect(result.health[0]?.code).toBe("podcasts_db_missing");
    expect(result.health[0]?.level).toBe("critical");
    expect(result.health[0]?.guidance?.state).toBe("ready_empty");
    expect(result.health[0]?.guidance?.fix?.length).toBeGreaterThan(0);
    expect(result.health[0]?.guidance?.confirm).toBe("nutshell doctor podcasts");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("podcasts health check can use an alternate database path", async () => {
  const root = mkdtempSync(join(tmpdir(), "trace-podcasts-"));
  try {
    const primary = join(root, "missing.sqlite");
    const alternate = join(root, "MTLibrary.sqlite");
    const db = new Database(alternate, { create: true });
    db.exec("create table ZMTEPISODE (Z_PK integer primary key); create table ZMTPODCAST (Z_PK integer primary key)");
    db.close();

    const plugin = new PodcastsPlugin();
    const findings = await plugin.check({
      ...context(root, primary),
      config: { dbPath: primary, alternateDbPaths: [alternate], checkTimeoutMs: 2_000 },
    });
    expect(findings).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("podcasts recent sync can read from an alternate database path", async () => {
  const root = mkdtempSync(join(tmpdir(), "trace-podcasts-"));
  try {
    const primary = join(root, "missing.sqlite");
    const alternate = join(root, "MTLibrary.sqlite");
    const db = new Database(alternate, { create: true });
    db.exec(`
      create table ZMTPODCAST (
        Z_PK integer primary key,
        ZTITLE text,
        ZAUTHOR text,
        ZFEEDURL text,
        ZIMAGEURL text,
        ZLOGOIMAGEURL text,
        ZARTWORKTEMPLATEURL text,
        ZARTWORKPRIMARYCOLOR text
      );
      create table ZMTEPISODE (
        Z_PK integer primary key,
        ZPODCAST integer,
        ZTITLE text,
        ZAUTHOR text,
        ZARTWORKTEMPLATEURL text,
        ZENCLOSUREURL text,
        ZWEBPAGEURL text,
        ZGUID text,
        ZPLAYCOUNT integer,
        ZPLAYSTATE integer,
        ZHASBEENPLAYED integer,
        ZPLAYHEAD real,
        ZDURATION real,
        ZLASTDATEPLAYED real,
        ZPUBDATE real
      );
      insert into ZMTPODCAST values (1, 'Show', 'Host', 'https://example.com/feed.xml', 'https://example.com/show.jpg', null, 'https://example.com/{w}x{h}.{f}', 'abcdef');
      insert into ZMTEPISODE values (1, 1, 'Episode', 'Host', null, 'https://example.com/audio.mp3', 'https://example.com/ep', 'guid-1', 1, 0, 1, 10, 100, 801129600, 801129000);
    `);
    db.close();

    const plugin = new PodcastsPlugin();
    const result = await plugin.sync(
      {
        ...context(root, primary),
        config: { dbPath: primary, alternateDbPaths: [alternate], timeoutMs: 2_000, attempts: 1 },
      },
      {
        source: "podcasts",
        mode: "recent",
        window: { start: new Date("2026-05-21T00:00:00Z"), end: null },
        collections: [],
        budget: plugin.manifest.defaultBudget,
        dryRun: false,
      },
      { version: 0, state: {} },
    );
    expect(result.completed).toBe(true);
    expect(result.records.some((record) => record.type === "podcast.listened")).toBe(true);
    expect(JSON.stringify(result.records)).toContain("https://example.com/show.jpg");
    expect((result.nextCheckpoint as Record<string, unknown>).lastSuccessfulDbPath).toBe(alternate);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function context(root: string, dbPath: string): PluginContext {
  return {
    root,
    config: { dbPath, checkTimeoutMs: 2_000 },
    logger: { event() {}, warn() {}, error() {} },
    signal: new AbortController().signal,
    now: () => new Date("2026-05-22T12:00:00Z"),
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
