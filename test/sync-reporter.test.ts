import { expect, test } from "bun:test";
import type { SyncReport } from "../src/core/types";
import { formatSyncText } from "../src/health/sync-reporter";

const startedAt = new Date("2026-06-10T08:00:00Z");
const finishedAt = new Date("2026-06-10T08:00:02Z");

test("formatSyncText renders skipped sources first with fix/then guidance lines", () => {
  const report: SyncReport = {
    status: "warning",
    startedAt,
    finishedAt,
    sources: [
      {
        source: "youtube",
        status: "ok",
        startedAt,
        finishedAt: new Date(startedAt.getTime() + 450),
        durationMs: 450,
        commit: { runId: "run-1", source: "youtube", insertedObservations: 12, insertedRecords: 8, checkpointVersion: 3 },
        findings: [],
        metrics: {},
      },
      {
        source: "twitter",
        status: "skipped",
        startedAt,
        finishedAt: startedAt,
        durationMs: 0,
        findings: [
          {
            level: "warning",
            source: "twitter",
            code: "twitter_needs_auth",
            message: "X session expired",
            detail: {},
            observedAt: startedAt,
            guidance: {
              state: "needs_auth",
              fix: "Open x.com in Chrome and sign in, then retry.",
              confirm: "nutshell doctor twitter",
              url: "https://x.com/login",
            },
          },
        ],
        metrics: {},
      },
    ],
  };

  const lines = formatSyncText(report).trimEnd().split("\n");
  expect(lines[0]).toBe("SKIPPED twitter: X session expired");
  expect(lines[1]).toBe("  fix:  Open x.com in Chrome and sign in, then retry.");
  expect(lines[2]).toBe("  then: nutshell doctor twitter");
  expect(lines[3]).toBe("OK youtube: records=8 observations=12 (450ms)");
  expect(lines[4]).toBe("SYNC warning in 2000ms");
  expect(lines).toHaveLength(5);
});

test("formatSyncText renders per-source lines and the final status for an all-ok report", () => {
  const report: SyncReport = {
    status: "ok",
    startedAt,
    finishedAt,
    sources: [
      {
        source: "apple_notes",
        status: "ok",
        startedAt,
        finishedAt: new Date(startedAt.getTime() + 120),
        durationMs: 120,
        commit: { runId: "run-2", source: "apple_notes", insertedObservations: 4, insertedRecords: 4, checkpointVersion: 7 },
        findings: [],
        metrics: {},
      },
      {
        source: "podcasts",
        status: "ok",
        startedAt,
        finishedAt: new Date(startedAt.getTime() + 80),
        durationMs: 80,
        findings: [],
        metrics: {},
      },
    ],
  };

  const lines = formatSyncText(report).trimEnd().split("\n");
  expect(lines[0]).toBe("OK apple_notes: records=4 observations=4 (120ms)");
  expect(lines[1]).toBe("OK podcasts: records=0 observations=0 (80ms)");
  expect(lines[2]).toBe("SYNC ok in 2000ms");
  expect(lines).toHaveLength(3);
});

test("formatSyncText renders problem findings with guidance under a degraded source line", () => {
  const report: SyncReport = {
    status: "warning",
    startedAt,
    finishedAt,
    sources: [
      {
        source: "podcasts",
        status: "warning",
        startedAt,
        finishedAt: new Date(startedAt.getTime() + 200),
        durationMs: 200,
        findings: [
          {
            level: "warning",
            source: "podcasts",
            code: "podcasts_db_unreadable",
            message: "Apple Podcasts database could not be read",
            detail: {},
            observedAt: startedAt,
            guidance: {
              state: "needs_permission",
              fix: "Grant Full Disk Access to Nutshell in System Settings, then retry.",
              confirm: "nutshell doctor podcasts",
            },
          },
        ],
        metrics: {},
      },
    ],
  };

  const lines = formatSyncText(report).trimEnd().split("\n");
  expect(lines[0]).toBe("WARNING podcasts: records=0 observations=0 (200ms)");
  expect(lines[1]).toBe("WARN podcasts/podcasts_db_unreadable: Apple Podcasts database could not be read");
  expect(lines[2]).toBe("  fix:  Grant Full Disk Access to Nutshell in System Settings, then retry.");
  expect(lines[3]).toBe("  then: nutshell doctor podcasts");
  expect(lines[4]).toBe("SYNC warning in 2000ms");
});
