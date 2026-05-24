import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config/config";
import { TraceRuntime } from "../src/runtime/trace-runtime";
import { PluginRegistry } from "../src/plugins/registry";
import { FakePlugin, fakeOkResult } from "../src/testing/fake-plugin";
import { DEFAULT_SYNC_BUDGET } from "../src/config/defaults";

test("runtime runs fake plugin through lock, store, and projection", async () => {
  const root = mkdtempSync(join(tmpdir(), "trace-runtime-"));
  try {
    const runtime = new TraceRuntime({
      root,
      config: loadConfig(root),
      registry: new PluginRegistry([new FakePlugin("fake", () => fakeOkResult("fake"))]),
    });
    const report = await runtime.sync({
      source: null,
      mode: "recent",
      window: null,
      collections: [],
      budget: DEFAULT_SYNC_BUDGET,
      dryRun: false,
    });
    expect(report.status).toBe("ok");
    const page = await runtime.query({ source: "fake" });
    expect(page.total).toBe(1);
    await runtime.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime plugin context exposes a generic canonical record reader", async () => {
  const root = mkdtempSync(join(tmpdir(), "trace-runtime-reader-"));
  try {
    let queriedTotal = -1;
    const runtime = new TraceRuntime({
      root,
      config: loadConfig(root),
      registry: new PluginRegistry([
        new FakePlugin("fake", async (_checkpoint, ctx) => {
          queriedTotal = (await ctx.records.query({ source: "fake", sourceIds: ["one"], limit: 10 })).total;
          return fakeOkResult("fake");
        }),
      ]),
    });

    const request = {
      source: "fake",
      mode: "recent" as const,
      window: null,
      collections: [],
      budget: DEFAULT_SYNC_BUDGET,
      dryRun: false,
    };
    await runtime.sync(request);
    await runtime.sync(request);

    expect(queriedTotal).toBe(1);
    await runtime.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
