import type {
  Checkpoint,
  EnrichmentRequest,
  FindingGuidance,
  HealthFinding,
  PluginContext,
  PluginManifest,
  PluginSmokeResult,
  PluginSyncResult,
  ProviderExportImportRequest,
  SyncRequest,
} from "../core/types";
import { redactJson, redactText } from "../core/redaction";
import type { FindingCatalog } from "../health/guidance";
import type { TracePluginSetup } from "../setup/types";

export type {
  Checkpoint,
  EnrichmentRequest,
  HealthFinding,
  PluginContext,
  PluginManifest,
  PluginSmokeResult,
  PluginSyncResult,
  ProviderExportImportRequest,
  SyncRequest,
};
export type { TracePluginSetup };

export interface TracePlugin {
  readonly manifest: PluginManifest;
  // Catalog of every problem finding this plugin can emit, with its guidance.
  // The universal invariant test enumerates these; a problem finding whose
  // code is missing here fails CI.
  readonly findings?: FindingCatalog;
  check(ctx: PluginContext): Promise<HealthFinding[]>;
  smoke?(ctx: PluginContext): Promise<PluginSmokeResult>;
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
  guidance?: FindingGuidance,
): HealthFinding {
  return {
    level,
    source,
    code,
    message: redactText(message),
    detail: redactJson(detail),
    observedAt,
    ...(guidance ? { guidance } : {}),
  };
}
