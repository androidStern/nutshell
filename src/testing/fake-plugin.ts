import type {
  Checkpoint,
  JsonObject,
  PluginContext,
  PluginManifest,
  PluginSyncResult,
  SyncRequest,
} from "../core/types";
import type { TracePlugin } from "../plugins/interface";

export class FakePlugin implements TracePlugin {
  readonly manifest: PluginManifest;

  constructor(
    id: string,
    private readonly resultFactory: (checkpoint: Checkpoint, ctx: PluginContext) => PluginSyncResult | Promise<PluginSyncResult>,
  ) {
    this.manifest = {
      id,
      displayName: id,
      authKind: "none",
      collections: ["default"],
      supportsBackfill: true,
      defaultBudget: { maxRuntimeMs: 10_000, maxRequests: null, minDelayMs: 0, stopOnRateLimit: true },
    };
  }

  async check() {
    return [];
  }

  async sync(ctx: PluginContext, _request: SyncRequest, checkpoint: Checkpoint): Promise<PluginSyncResult> {
    return this.resultFactory(checkpoint, ctx);
  }
}

export function fakeOkResult(source: string): PluginSyncResult {
  const observedAt = new Date("2026-05-21T12:00:00Z");
  return {
    observations: [
      {
        source,
        observedAt,
        sourceRecordId: "one",
        fingerprint: "fingerprint-one",
        payload: { ok: true } as JsonObject,
        artifactPaths: [],
      },
    ],
    records: [
      {
        source,
        collection: "default",
        kind: "event",
        type: "fake.event",
        sourceId: "one",
        happenedAt: observedAt,
        observedAt,
        title: "One",
        url: null,
        bodyText: null,
        artifactRefs: [],
        payload: { ok: true } as JsonObject,
      },
    ],
    nextCheckpoint: { last: "one" },
    health: [],
    metrics: { count: 1 },
    completed: true,
    partial: false,
  };
}
