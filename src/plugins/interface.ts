import type {
  Checkpoint,
  EnrichmentRequest,
  HealthFinding,
  PluginContext,
  PluginManifest,
  PluginSyncResult,
  ProviderExportImportRequest,
  SyncRequest,
} from "../core/types";
import { redactJson, redactText } from "../core/redaction";
import type { TracePluginSetup } from "../setup/types";

export type {
  Checkpoint,
  EnrichmentRequest,
  HealthFinding,
  PluginContext,
  PluginManifest,
  PluginSyncResult,
  ProviderExportImportRequest,
  SyncRequest,
};
export type { TracePluginSetup };

export interface TracePlugin {
  readonly manifest: PluginManifest;
  check(ctx: PluginContext): Promise<HealthFinding[]>;
  sync(ctx: PluginContext, request: SyncRequest, checkpoint: Checkpoint): Promise<PluginSyncResult>;
  setup?: TracePluginSetup;
  importProviderExport?(ctx: PluginContext, request: ProviderExportImportRequest, checkpoint: Checkpoint): Promise<PluginSyncResult>;
  enrich?(ctx: PluginContext, request: EnrichmentRequest, checkpoint: Checkpoint): Promise<PluginSyncResult>;
}

export function finding(
  level: HealthFinding["level"],
  source: HealthFinding["source"],
  code: string,
  message: string,
  detail: HealthFinding["detail"] = {},
  observedAt = new Date(),
): HealthFinding {
  return { level, source, code, message: redactText(message), detail: redactJson(detail), observedAt };
}
