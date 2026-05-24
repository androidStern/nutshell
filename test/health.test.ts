import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config/config";
import type { JsonObject, PluginSyncResult, TraceRecord } from "../src/core/types";
import { PluginRegistry } from "../src/plugins/registry";
import { TraceRuntime } from "../src/runtime/trace-runtime";
import { FakePlugin } from "../src/testing/fake-plugin";
import { openStore } from "../src/store/sqlite-store";

test("health marks configured cutoff coverage complete when records reach the cutoff", async () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-health-"));
  try {
    const config = loadConfig(root);
    config.data.backfill = { cutoffDate: "2026-01-01", cutoffDates: {}, lookbackMonths: 6 };
    const store = openStore(join(root, "trace.sqlite"));
    const checkpoint = await store.loadCheckpoint("youtube");
    await store.commitSync({
      source: "youtube",
      run: { id: "youtube-backfill", command: "test", mode: "backfill", startedAt: new Date("2026-05-21T12:00:00Z") },
      result: resultWithRecords("youtube", [record("youtube.watched", "one", "watched", "2025-12-31T12:00:00Z")]),
      expectedCheckpointVersion: checkpoint.version,
    });

    const runtime = new TraceRuntime({ root, config, store, registry: new PluginRegistry([new FakePlugin("youtube", () => resultWithRecords("youtube", []))]) });
    const report = await runtime.health();
    const youtube = report.backfill.find((item) => item.source === "youtube");
    expect(youtube?.status).toBe("backfill_complete");
    expect(youtube?.targets.cutoffDate).toBe("2026-01-01");
    await runtime.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("health reports incomplete coverage without provider export or current-source records", async () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-health-"));
  try {
    const config = loadConfig(root);
    config.data.backfill = { cutoffDate: "2026-01-01", cutoffDates: {}, lookbackMonths: 6 };
    const store = openStore(join(root, "trace.sqlite"));
    const runtime = new TraceRuntime({ root, config, store, registry: new PluginRegistry([new FakePlugin("twitter", () => resultWithRecords("twitter", []))]) });
    const report = await runtime.health();
    const twitter = report.backfill.find((item) => item.source === "twitter");
    expect(twitter?.status).toBe("backfill_incomplete");
    expect(twitter?.bulkBackfill.nextCommand).toBe("nutshell import twitter --path <provider-export> --json");
    expect(report.findings.some((item) => item.source === "twitter" && item.code === "backfill_incomplete")).toBe(true);
    await runtime.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("health includes the latest source finding when a recent run is partial", async () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-health-"));
  try {
    const config = loadConfig(root);
    config.data.backfill = { cutoffDate: "2026-01-01", cutoffDates: {}, lookbackMonths: 6 };
    const store = openStore(join(root, "trace.sqlite"));
    const checkpoint = await store.loadCheckpoint("podcasts");
    await store.commitSync({
      source: "podcasts",
      run: { id: "recent-podcasts", command: "test", mode: "recent", startedAt: new Date("2026-05-21T12:00:00Z") },
      result: {
        observations: [],
        records: [],
        nextCheckpoint: {},
        health: [
          {
            level: "warning",
            source: "podcasts",
            code: "podcasts_db_timeout",
            message: "Apple Podcasts database access timed out",
            detail: { attempts: 3 },
            observedAt: new Date("2026-05-21T12:00:10Z"),
          },
        ],
        metrics: { attempts: 3 },
        completed: false,
        partial: true,
      },
      expectedCheckpointVersion: checkpoint.version,
    });

    const runtime = new TraceRuntime({ root, config, store, registry: new PluginRegistry([new FakePlugin("podcasts", () => resultWithRecords("podcasts", []))]) });
    const report = await runtime.health();
    const finding = report.findings.find((item) => item.code === "last_run_partial" && item.source === "podcasts");
    const detail = finding?.detail as JsonObject;
    const latest = detail.latestFinding as JsonObject;
    expect(latest.code).toBe("podcasts_db_timeout");
    await runtime.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("health does not present stale source findings after a newer successful run", async () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-health-"));
  try {
    const config = loadConfig(root);
    config.data.backfill = { cutoffDate: "2026-01-01", cutoffDates: {}, lookbackMonths: 6 };
    const store = openStore(join(root, "trace.sqlite"));
    let checkpoint = await store.loadCheckpoint("podcasts");
    await store.commitSync({
      source: "podcasts",
      run: { id: "failed-podcasts", command: "test", mode: "recent", startedAt: new Date("2026-05-21T12:00:00Z") },
      result: {
        observations: [],
        records: [],
        nextCheckpoint: {},
        health: [
          {
            level: "critical",
            source: "podcasts",
            code: "podcasts_full_disk_access_required",
            message: "Apple Podcasts database is blocked",
            detail: {},
            observedAt: new Date("2026-05-21T12:00:10Z"),
          },
        ],
        metrics: {},
        completed: false,
        partial: true,
      },
      expectedCheckpointVersion: checkpoint.version,
    });
    checkpoint = await store.loadCheckpoint("podcasts");
    await store.commitSync({
      source: "podcasts",
      run: { id: "ok-podcasts", command: "test", mode: "recent", startedAt: new Date("2026-05-21T12:05:00Z") },
      result: resultWithRecords("podcasts", [record("podcast.listened", "episode-1", "listened", "2025-12-31T12:00:00Z", "podcasts")]),
      expectedCheckpointVersion: checkpoint.version,
    });

    const runtime = new TraceRuntime({ root, config, store, registry: new PluginRegistry([new FakePlugin("podcasts", () => resultWithRecords("podcasts", []))]) });
    const report = await runtime.health();
    const podcasts = report.backfill.find((item) => item.source === "podcasts");
    expect(report.findings.some((item) => item.source === "podcasts" && item.code === "last_run_partial")).toBe(false);
    expect((podcasts?.detail as JsonObject).latestFinding).toBe(null);
    expect((podcasts?.liveBackfill.detail as JsonObject).latestFinding).toBe(null);
    await runtime.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("health reports stale runtime locks as critical", async () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-health-"));
  try {
    const config = loadConfig(root);
    config.data.runtime = { staleLockMs: 1 };
    writeFileSync(
      join(root, "run.lock"),
      JSON.stringify({
        pid: 99999999,
        startedAt: "2026-05-21T12:00:00Z",
        heartbeatAt: "2026-05-21T12:00:00Z",
        command: "nutshell sync all --mode recent",
        version: 1,
      }),
      "utf8",
    );
    const store = openStore(join(root, "trace.sqlite"));
    const runtime = new TraceRuntime({ root, config, store, registry: new PluginRegistry([]) });
    const report = await runtime.health();
    expect(report.findings.some((item) => item.code === "lock_stale" && item.level === "critical")).toBe(true);
    await runtime.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function resultWithRecords(source: string, records: TraceRecord[]): PluginSyncResult {
  return {
    observations: [],
    records,
    nextCheckpoint: {},
    health: [],
    metrics: {},
    completed: true,
    partial: false,
  };
}

function record(type: string, sourceId: string, collection: string, happenedAt: string, source?: string): TraceRecord {
  return {
    source: (source ?? (type.startsWith("youtube") ? "youtube" : "twitter")) as TraceRecord["source"],
    collection,
    kind: "event",
    type,
    sourceId,
    happenedAt: new Date(happenedAt),
    observedAt: new Date("2026-05-21T12:00:00Z"),
    title: sourceId,
    url: null,
    bodyText: null,
    artifactRefs: [],
    payload: {},
  };
}
