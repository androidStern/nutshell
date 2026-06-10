import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config/config";
import { TraceRuntime } from "../src/runtime/trace-runtime";
import { PluginRegistry } from "../src/plugins/registry";
import { FakePlugin, fakeOkResult } from "../src/testing/fake-plugin";
import { DEFAULT_SYNC_BUDGET } from "../src/config/defaults";
import type { Checkpoint, EnrichmentRequest, JsonObject, PluginContext, PluginSyncResult, ProviderExportImportRequest, SyncRequest } from "../src/core/types";

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

test("runtime automatically enriches after a successful source sync commit", async () => {
  const root = mkdtempSync(join(tmpdir(), "trace-runtime-auto-enrich-"));
  try {
    const calls: string[] = [];
    class EnrichingPlugin extends FakePlugin {
      constructor() {
        super("fake", () => fakeOkResult("fake"));
      }

      async sync(ctx: PluginContext, request: SyncRequest, checkpoint: Checkpoint): Promise<PluginSyncResult> {
        calls.push(`sync:${checkpoint.version}:${request.budget.maxRequests ?? "none"}`);
        return {
          ...fakeOkResult("fake"),
          nextCheckpoint: { synced: true },
        };
      }

      async enrich(ctx: PluginContext, request: EnrichmentRequest, checkpoint: Checkpoint): Promise<PluginSyncResult> {
        calls.push(`enrich:${checkpoint.version}:${request.limit}:${request.budget.maxRequests ?? "none"}`);
        const page = await ctx.records.query({ source: "fake", limit: 10 });
        expect(page.total).toBe(1);
        const observedAt = new Date("2026-05-21T12:01:00Z");
        return {
          observations: [],
          records: [
            {
              source: "fake",
              collection: "enrichment",
              kind: "entity",
              type: "fake.enrichment",
              sourceId: "enriched-one",
              happenedAt: null,
              observedAt,
              title: "Enriched",
              url: null,
              bodyText: null,
              artifactRefs: [],
              payload: { enriched: true },
            },
          ],
          nextCheckpoint: { synced: true, enriched: true },
          health: [],
          metrics: { enriched: 1 },
          completed: true,
          partial: false,
        };
      }
    }

    const config = loadConfig(root);
    config.data.runtime = {
      ...(config.data.runtime as JsonObject),
      projectionAfterSync: false,
      enrichmentMaxRequests: 7,
      enrichmentMinDelayMs: 0,
    };
    const runtime = new TraceRuntime({
      root,
      config,
      registry: new PluginRegistry([new EnrichingPlugin()]),
    });

    const report = await runtime.sync({
      source: null,
      mode: "recent",
      window: null,
      collections: [],
      budget: { ...DEFAULT_SYNC_BUDGET, maxRequests: 3 },
      dryRun: false,
    });

    expect(calls).toEqual(["sync:0:3", "enrich:1:3:3"]);
    expect(report.status).toBe("ok");
    expect(report.sources[0]?.commit?.checkpointVersion).toBe(1);
    expect(report.sources[0]?.enrichment?.commit?.checkpointVersion).toBe(2);
    const page = await runtime.query({ source: "fake", limit: 10 });
    expect(page.total).toBe(2);
    const checkpoint = await runtime.store.loadCheckpoint("fake");
    expect(checkpoint.version).toBe(2);
    expect(checkpoint.state).toEqual({ synced: true, enriched: true });
    await runtime.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime preserves normal sync commit when automatic enrichment fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "trace-runtime-auto-enrich-fails-"));
  try {
    class FailingEnrichmentPlugin extends FakePlugin {
      constructor() {
        super("fake", () => fakeOkResult("fake"));
      }

      async sync(_ctx: PluginContext, _request: SyncRequest, _checkpoint: Checkpoint): Promise<PluginSyncResult> {
        return { ...fakeOkResult("fake"), nextCheckpoint: { synced: true } };
      }

      async enrich(): Promise<PluginSyncResult> {
        throw new Error("enrichment transport exploded");
      }
    }

    const config = loadConfig(root);
    config.data.runtime = {
      ...(config.data.runtime as JsonObject),
      projectionAfterSync: false,
      enrichmentMinDelayMs: 0,
    };
    const runtime = new TraceRuntime({
      root,
      config,
      registry: new PluginRegistry([new FailingEnrichmentPlugin()]),
    });

    const report = await runtime.sync({
      source: null,
      mode: "recent",
      window: null,
      collections: [],
      budget: DEFAULT_SYNC_BUDGET,
      dryRun: false,
    });

    expect(report.status).toBe("critical");
    expect(report.sources[0]?.commit?.checkpointVersion).toBe(1);
    expect(report.sources[0]?.enrichment?.status).toBe("critical");
    const enrichmentFinding = report.sources[0]?.enrichment?.findings[0];
    expect(enrichmentFinding?.code).toBe("plugin_enrichment_runtime_error");
    expect(enrichmentFinding?.source).toBe("fake");
    expect(enrichmentFinding?.guidance?.state).toBe("blocked_bug");
    expect(enrichmentFinding?.guidance?.fix?.length).toBeGreaterThan(0);
    expect(enrichmentFinding?.guidance?.confirm?.length).toBeGreaterThan(0);
    const page = await runtime.query({ source: "fake", limit: 10 });
    expect(page.total).toBe(1);
    const checkpoint = await runtime.store.loadCheckpoint("fake");
    expect(checkpoint.version).toBe(2);
    expect(checkpoint.state).toEqual({ synced: true });
    await runtime.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime does not run automatic enrichment when source sync fails before commit", async () => {
  const root = mkdtempSync(join(tmpdir(), "trace-runtime-auto-enrich-sync-fails-"));
  try {
    let enrichCalled = false;
    class FailingSyncPlugin extends FakePlugin {
      constructor() {
        super("fake", () => fakeOkResult("fake"));
      }

      async sync(): Promise<PluginSyncResult> {
        throw new Error("source sync failed before commit");
      }

      async enrich(): Promise<PluginSyncResult> {
        enrichCalled = true;
        return fakeOkResult("fake");
      }
    }

    const config = loadConfig(root);
    config.data.runtime = {
      ...(config.data.runtime as JsonObject),
      projectionAfterSync: false,
      enrichmentMinDelayMs: 0,
    };
    const runtime = new TraceRuntime({
      root,
      config,
      registry: new PluginRegistry([new FailingSyncPlugin()]),
    });

    const report = await runtime.sync({
      source: null,
      mode: "recent",
      window: null,
      collections: [],
      budget: DEFAULT_SYNC_BUDGET,
      dryRun: false,
    });

    expect(report.status).toBe("critical");
    expect(enrichCalled).toBe(false);
    expect(report.sources[0]?.enrichment).toBeUndefined();
    const page = await runtime.query({ source: "fake", limit: 10 });
    expect(page.total).toBe(0);
    await runtime.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime dry-run sync does not run automatic enrichment or mutate the store", async () => {
  const root = mkdtempSync(join(tmpdir(), "trace-runtime-auto-enrich-dry-run-"));
  try {
    let enrichCalled = false;
    class EnrichingPlugin extends FakePlugin {
      constructor() {
        super("fake", () => fakeOkResult("fake"));
      }

      async enrich(): Promise<PluginSyncResult> {
        enrichCalled = true;
        return fakeOkResult("fake");
      }
    }

    const runtime = new TraceRuntime({
      root,
      config: loadConfig(root),
      registry: new PluginRegistry([new EnrichingPlugin()]),
    });

    const report = await runtime.sync({
      source: null,
      mode: "recent",
      window: null,
      collections: [],
      budget: DEFAULT_SYNC_BUDGET,
      dryRun: true,
    });

    expect(report.status).toBe("ok");
    expect(report.sources[0]?.enrichment).toBeUndefined();
    expect(enrichCalled).toBe(false);
    const page = await runtime.query({ source: "fake", limit: 10 });
    expect(page.total).toBe(0);
    const checkpoint = await runtime.store.loadCheckpoint("fake");
    expect(checkpoint.version).toBe(0);
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

test("runtime refreshes projections after import and enrichment mutations", async () => {
  const root = mkdtempSync(join(tmpdir(), "trace-runtime-projections-"));
  try {
    class MutationPlugin extends FakePlugin {
      async importProviderExport(_ctx: PluginContext, _request: ProviderExportImportRequest, _checkpoint: Checkpoint) {
        return fakeOkResult("fake");
      }

      async enrich(_ctx: PluginContext, _request: EnrichmentRequest, _checkpoint: Checkpoint) {
        return fakeOkResult("fake");
      }
    }

    const runtime = new TraceRuntime({
      root,
      config: loadConfig(root),
      registry: new PluginRegistry([new MutationPlugin("fake", () => fakeOkResult("fake"))]),
    });

    await runtime.importProviderExport({
      source: "fake",
      path: join(root, "provider-export.zip"),
      dryRun: false,
      budget: DEFAULT_SYNC_BUDGET,
    });
    expect(existsSync(join(root, "projections", "dashboard", "status.json"))).toBe(true);

    rmSync(join(root, "projections"), { recursive: true, force: true });
    await runtime.enrich({
      source: "fake",
      limit: 1,
      dryRun: false,
      budget: DEFAULT_SYNC_BUDGET,
    });
    expect(existsSync(join(root, "projections", "dashboard", "status.json"))).toBe(true);

    await runtime.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime skips degraded plugins during scheduled all-source sync", async () => {
  const root = mkdtempSync(join(tmpdir(), "trace-runtime-degraded-"));
  try {
    const config = loadConfig(root);
    config.data.plugins = {
      fake: {
        enabled: true,
        setup: {
          status: "degraded",
          findings: [{ level: "critical", code: "fake_auth", message: "fake auth failed", observedAt: "2026-05-24T12:00:00Z", detail: {} }],
        },
      },
    };
    let syncCalled = false;
    const runtime = new TraceRuntime({
      root,
      config,
      registry: new PluginRegistry([
        new FakePlugin("fake", () => {
          syncCalled = true;
          return fakeOkResult("fake");
        }),
      ]),
    });

    const report = await runtime.sync({
      source: null,
      mode: "recent",
      window: null,
      collections: [],
      budget: DEFAULT_SYNC_BUDGET,
      dryRun: false,
    });

    expect(syncCalled).toBe(false);
    expect(report.status).toBe("warning");
    expect(report.sources[0]?.status).toBe("skipped");
    const degraded = report.sources[0]?.findings[0];
    expect(degraded?.code).toBe("plugin_setup_degraded");
    expect(degraded?.source).toBe("fake");
    expect(degraded?.guidance?.state).toBe("blocked_bug");
    expect(degraded?.guidance?.fix?.length).toBeGreaterThan(0);
    expect(degraded?.guidance?.confirm?.length).toBeGreaterThan(0);
    await runtime.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sync dry-run blocks artifact writes before filesystem mutation", async () => {
  const root = mkdtempSync(join(tmpdir(), "trace-runtime-dry-run-artifact-"));
  try {
    const runtime = new TraceRuntime({
      root,
      config: loadConfig(root),
      registry: new PluginRegistry([new ArtifactWritingPlugin("fake")]),
    });

    const report = await runtime.sync({
      source: "fake",
      mode: "recent",
      window: null,
      collections: [],
      budget: DEFAULT_SYNC_BUDGET,
      dryRun: true,
    });

    expect(report.status).toBe("critical");
    expect(JSON.stringify(report.sources[0]?.findings[0]?.detail)).toContain("dry_run_artifact_write_blocked");
    expect(existsSync(join(root, "artifacts", "fake", "dry-run.txt"))).toBe(false);
    expect(existsSync(join(root, "projections", "dashboard", "status.json"))).toBe(false);
    const page = await runtime.query({ source: "fake" });
    expect(page.total).toBe(0);
    const checkpoint = await runtime.store.loadCheckpoint("fake");
    expect(checkpoint.version).toBe(0);
    await runtime.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("provider import dry-run blocks artifact writes and leaves store untouched", async () => {
  const root = mkdtempSync(join(tmpdir(), "trace-runtime-import-dry-run-artifact-"));
  try {
    const runtime = new TraceRuntime({
      root,
      config: loadConfig(root),
      registry: new PluginRegistry([new ArtifactWritingPlugin("fake")]),
    });

    await expect(
      runtime.importProviderExport({
        source: "fake",
        path: join(root, "provider-export.zip"),
        dryRun: true,
        budget: DEFAULT_SYNC_BUDGET,
      }),
    ).rejects.toThrow("dry_run_artifact_write_blocked");

    expect(existsSync(join(root, "artifacts", "fake", "dry-run.txt"))).toBe(false);
    expect(existsSync(join(root, "projections", "dashboard", "status.json"))).toBe(false);
    const page = await runtime.query({ source: "fake" });
    expect(page.total).toBe(0);
    const checkpoint = await runtime.store.loadCheckpoint("fake");
    expect(checkpoint.version).toBe(0);
    await runtime.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

class ArtifactWritingPlugin extends FakePlugin {
  constructor(id: string) {
    super(id, () => fakeOkResult(id));
  }

  async sync(ctx: PluginContext, _request: SyncRequest, checkpoint: Checkpoint): Promise<PluginSyncResult> {
    await ctx.writeArtifact({
      source: this.manifest.id,
      relativePath: `${this.manifest.id}/dry-run.txt`,
      content: "dry-run should not write this",
      mimeType: "text/plain",
    });
    return { ...fakeOkResult(this.manifest.id), nextCheckpoint: checkpoint.state };
  }

  async importProviderExport(ctx: PluginContext, _request: ProviderExportImportRequest, checkpoint: Checkpoint): Promise<PluginSyncResult> {
    await ctx.writeArtifact({
      source: this.manifest.id,
      relativePath: `${this.manifest.id}/dry-run.txt`,
      content: "import dry-run should not write this",
      mimeType: "text/plain",
    });
    return { ...fakeOkResult(this.manifest.id), nextCheckpoint: checkpoint.state };
  }
}
