import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openStore } from "../src/store/sqlite-store";
import type { PluginSyncResult, TraceRecord } from "../src/core/types";
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
