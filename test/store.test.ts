import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { openStore } from "../src/store/sqlite-store";
import type { JsonObject, PluginSyncResult, TraceRecord } from "../src/core/types";
import { guidanceFromJson } from "../src/health/guidance";
import { fakeOkResult } from "../src/testing/fake-plugin";

test("store commit is idempotent for records and observations", async () => {
  const root = mkdtempSync(join(tmpdir(), "trace-store-"));
  try {
    const store = openStore(join(root, "trace.sqlite"));
    const checkpoint = await store.loadCheckpoint("fake");
    await store.commitSync({
      source: "fake",
      run: { id: "run-1", command: "test", mode: "recent", startedAt: new Date("2026-05-21T12:00:00Z") },
      result: fakeOkResult("fake"),
      expectedCheckpointVersion: checkpoint.version,
    });
    const checkpoint2 = await store.loadCheckpoint("fake");
    await store.commitSync({
      source: "fake",
      run: { id: "run-2", command: "test", mode: "recent", startedAt: new Date("2026-05-21T12:01:00Z") },
      result: fakeOkResult("fake"),
      expectedCheckpointVersion: checkpoint2.version,
    });
    const page = await store.query({ source: "fake", limit: 10 });
    expect(page.total).toBe(1);
    expect((await store.loadCheckpoint("fake")).version).toBe(2);
    await store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("store query filters by sourceIds as a generic record field", async () => {
  const root = mkdtempSync(join(tmpdir(), "trace-store-sourceids-"));
  try {
    const store = openStore(join(root, "trace.sqlite"));
    await store.commitSync({
      source: "fake",
      run: { id: "run-sourceids-1", command: "test", mode: "recent", startedAt: new Date("2026-05-21T12:00:00Z") },
      result: resultWithRecords("fake", [
        record("fake", "event", "fake.event", "one"),
        record("fake", "event", "fake.event", "two"),
        record("fake", "entity", "fake.entity", "one"),
      ]),
      expectedCheckpointVersion: 0,
    });
    await store.commitSync({
      source: "other",
      run: { id: "run-sourceids-2", command: "test", mode: "recent", startedAt: new Date("2026-05-21T12:01:00Z") },
      result: resultWithRecords("other", [record("other", "event", "fake.event", "one")]),
      expectedCheckpointVersion: 0,
    });

    const byIds = await store.query({ source: "fake", type: "fake.event", sourceIds: ["one", "two"], limit: 10 });
    expect(byIds.records.map((item) => item.sourceId).sort()).toEqual(["one", "two"]);

    const byKind = await store.query({ source: "fake", kind: "entity", sourceIds: ["one"], limit: 10 });
    expect(byKind.records).toHaveLength(1);
    expect(byKind.records[0]?.type).toBe("fake.entity");

    const emptyIds = await store.query({ source: "fake", sourceIds: [], limit: 10 });
    expect(emptyIds.total).toBe(0);
    expect(emptyIds.records).toEqual([]);

    const blankIds = await store.query({ source: "fake", sourceIds: [""], limit: 10 });
    expect(blankIds.total).toBe(0);
    expect(blankIds.records).toEqual([]);

    const conflictingIds = await store.query({ source: "fake", sourceId: "one", sourceIds: ["two"], limit: 10 });
    expect(conflictingIds.total).toBe(0);
    expect(conflictingIds.records).toEqual([]);

    await store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("store persists finding guidance and surfaces it in the health snapshot", async () => {
  const root = mkdtempSync(join(tmpdir(), "trace-store-guidance-"));
  try {
    const store = openStore(join(root, "trace.sqlite"));
    await store.commitSync({
      source: "fake",
      run: { id: "run-guidance", command: "test", mode: "recent", startedAt: new Date("2026-05-21T12:00:00Z") },
      result: {
        observations: [],
        records: [],
        nextCheckpoint: {},
        health: [
          {
            level: "warning",
            source: "fake",
            code: "fake_needs_auth",
            message: "fake source needs a login",
            detail: {},
            observedAt: new Date("2026-05-21T12:00:10Z"),
            guidance: { state: "needs_auth", fix: "Sign into fake.example in Chrome, then retry.", confirm: "nutshell doctor fake" },
          },
          {
            level: "warning",
            source: "other",
            code: "other_no_guidance",
            message: "finding without guidance",
            detail: {},
            observedAt: new Date("2026-05-21T12:00:10Z"),
          },
        ],
        metrics: {},
        completed: true,
        partial: false,
      },
      expectedCheckpointVersion: 0,
    });

    const snapshot = await store.healthSnapshot();
    const withGuidance = snapshot.latestFindings.find((row) => (row as JsonObject).source === "fake") as JsonObject;
    expect(typeof withGuidance.guidance_json).toBe("string");
    const restored = guidanceFromJson(JSON.parse(String(withGuidance.guidance_json)));
    expect(restored?.state).toBe("needs_auth");
    expect(restored?.fix).toBe("Sign into fake.example in Chrome, then retry.");
    expect(restored?.confirm).toBe("nutshell doctor fake");

    const withoutGuidance = snapshot.latestFindings.find((row) => (row as JsonObject).source === "other") as JsonObject;
    expect(withoutGuidance.guidance_json).toBeNull();
    await store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("store migration adds guidance_json to databases created before the column existed", async () => {
  const root = mkdtempSync(join(tmpdir(), "trace-store-migrate-"));
  try {
    const path = join(root, "trace.sqlite");
    const legacy = new Database(path, { create: true, readwrite: true });
    legacy.exec(`
      create table schema_migrations (
        version integer primary key,
        applied_at text not null
      );
      create table health_findings (
        id text primary key,
        run_id text,
        level text not null,
        source text not null,
        code text not null,
        message text not null,
        detail_json text not null,
        observed_at text not null
      );
    `);
    legacy.query("insert into schema_migrations(version, applied_at) values (1, ?)").run("2026-05-21T12:00:00Z");
    legacy
      .query(
        `insert into health_findings (id, run_id, level, source, code, message, detail_json, observed_at)
         values ('legacy-finding', 'legacy-run', 'warning', 'legacy', 'legacy_code', 'legacy message', '{}', '2026-05-21T12:00:00Z')`,
      )
      .run();
    legacy.close();

    const store = openStore(path);
    const snapshot = await store.healthSnapshot();
    const legacyRow = snapshot.latestFindings.find((row) => (row as JsonObject).source === "legacy") as JsonObject;
    expect(legacyRow.code).toBe("legacy_code");
    expect(legacyRow.guidance_json).toBeNull();

    await store.commitSync({
      source: "fake",
      run: { id: "run-after-migrate", command: "test", mode: "recent", startedAt: new Date("2026-05-21T12:05:00Z") },
      result: {
        observations: [],
        records: [],
        nextCheckpoint: {},
        health: [
          {
            level: "warning",
            source: "fake",
            code: "fake_needs_auth",
            message: "fake source needs a login",
            detail: {},
            observedAt: new Date("2026-05-21T12:05:10Z"),
            guidance: { state: "needs_auth", fix: "Sign into fake.example in Chrome, then retry.", confirm: "nutshell doctor fake" },
          },
        ],
        metrics: {},
        completed: true,
        partial: false,
      },
      expectedCheckpointVersion: 0,
    });
    const migrated = await store.healthSnapshot();
    const newRow = migrated.latestFindings.find((row) => (row as JsonObject).source === "fake") as JsonObject;
    expect(guidanceFromJson(JSON.parse(String(newRow.guidance_json)))?.confirm).toBe("nutshell doctor fake");
    await store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function resultWithRecords(source: string, records: TraceRecord[]): PluginSyncResult {
  return {
    observations: [],
    records,
    nextCheckpoint: { ok: true },
    health: [],
    metrics: {},
    completed: true,
    partial: false,
  };
}

function record(source: string, kind: TraceRecord["kind"], type: string, sourceId: string): TraceRecord {
  const observedAt = new Date("2026-05-21T12:00:00Z");
  return {
    source,
    collection: "default",
    kind,
    type,
    sourceId,
    happenedAt: observedAt,
    observedAt,
    title: sourceId,
    url: null,
    bodyText: null,
    artifactRefs: [],
    payload: { sourceId },
  };
}
