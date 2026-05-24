import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config/config";
import { importGoogleTakeoutYoutube } from "../src/imports/google-takeout-youtube";
import { PluginRegistry } from "../src/plugins/registry";
import { TraceRuntime } from "../src/runtime/trace-runtime";
import { openStore } from "../src/store/sqlite-store";
import { FakePlugin, fakeOkResult } from "../src/testing/fake-plugin";

test("google takeout youtube import commits official archive evidence and can close the historical gap", async () => {
  const root = mkdtempSync(join(tmpdir(), "trace-takeout-"));
  try {
    const takeout = join(root, "Takeout", "My Activity", "YouTube");
    mkdirSync(takeout, { recursive: true });
    writeFileSync(
      join(takeout, "MyActivity.json"),
      JSON.stringify([
        {
          header: "YouTube",
          title: "Watched Old Video",
          titleUrl: "https://www.youtube.com/watch?v=old",
          subtitles: [{ name: "Old Channel", url: "https://www.youtube.com/channel/old" }],
          time: "2004-01-02T18:04:05.000Z",
          products: ["YouTube"],
          activityControls: ["YouTube watch history"],
        },
        {
          header: "YouTube",
          title: "Searched for sync architecture",
          titleUrl: "https://www.youtube.com/results?search_query=sync+architecture",
          time: "2026-05-22T03:04:05.000Z",
          products: ["YouTube"],
          activityControls: ["YouTube search history"],
        },
      ]),
      "utf8",
    );

    const config = loadConfig(root);
    config.data.backfill = { cutoffDate: "2004-01-02", cutoffDates: {}, lookbackMonths: 6 };
    const store = openStore(join(root, "trace.sqlite"));
    const report = await importGoogleTakeoutYoutube(config, store, join(root, "Takeout"), false);

    expect(report.available).toBe(true);
    expect(report.counts["youtube.watched"]).toBe(1);
    expect(report.counts["youtube.searched"]).toBe(1);
    expect(report.dateRange.oldestDateKey).toBe("20040102");
    expect(report.commit?.insertedRecords).toBe(2);

    const runtime = new TraceRuntime({ root, config, store, registry: new PluginRegistry([new FakePlugin("youtube", () => fakeOkResult("youtube"))]) });
    const health = await runtime.health();
    const youtube = health.backfill.find((item) => item.source === "youtube");
    expect(youtube?.status).toBe("backfill_complete");
    expect(youtube?.bulkBackfill.status).toBe("complete");
    await runtime.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("google takeout youtube import accepts a direct Data Portability JSON object", async () => {
  const root = mkdtempSync(join(tmpdir(), "trace-takeout-direct-"));
  try {
    const objectPath = join(root, "archive-object");
    writeFileSync(
      objectPath,
      JSON.stringify([
        {
          header: "YouTube",
          title: "Watched Direct Object Video",
          titleUrl: "https://www.youtube.com/watch?v=direct",
          time: "2003-03-04T05:06:07.000Z",
          products: ["YouTube"],
          activityControls: ["YouTube watch history"],
        },
      ]),
      "utf8",
    );

    const config = loadConfig(root);
    config.data.backfill = { cutoffDate: "2003-03-04", cutoffDates: {}, lookbackMonths: 6 };
    const store = openStore(join(root, "trace.sqlite"));
    const report = await importGoogleTakeoutYoutube(config, store, objectPath, false);

    expect(report.available).toBe(true);
    expect(report.counts["youtube.watched"]).toBe(1);
    expect(report.dateRange.oldestDateKey).toBe("20030304");
    expect(report.files[0]).toContain("myactivity-youtube");
    expect(report.commit?.insertedRecords).toBe(1);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
