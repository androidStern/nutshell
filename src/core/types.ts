export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };

export type JsonObject = { [key: string]: Json };

export type SourceId =
  | "youtube"
  | "podcasts"
  | "apple_notes"
  | "twitter"
  | (string & {});

export type RecordKind = "entity" | "event" | "artifact" | "relation";
export type SyncMode = "recent" | "backfill" | "healthcheck";
export type HealthLevel = "ok" | "warning" | "critical";
export type AuthKind = "none" | "api_key" | "oauth" | "browser_profile" | "local_os";

export interface TimeWindow {
  start: Date | null;
  end: Date | null;
}

export interface SyncBudget {
  maxRuntimeMs: number;
  maxRequests: number | null;
  minDelayMs: number;
  stopOnRateLimit: boolean;
}

export interface SyncRequest {
  source: SourceId | null;
  mode: SyncMode;
  window: TimeWindow | null;
  collections: string[];
  budget: SyncBudget;
  dryRun: boolean;
  failOnPartial?: boolean;
}

export interface ProviderExportImportRequest {
  source: SourceId;
  path: string;
  dryRun: boolean;
  budget: SyncBudget;
}

export interface EnrichmentRequest {
  source: SourceId;
  limit: number;
  dryRun: boolean;
  budget: SyncBudget;
}

export interface Checkpoint {
  version: number;
  state: Json;
}

export interface RawObservation {
  source: SourceId;
  observedAt: Date;
  sourceRecordId: string | null;
  fingerprint: string;
  payload: Json;
  artifactPaths: string[];
}

export interface TraceRecord {
  source: SourceId;
  collection: string | null;
  kind: RecordKind;
  type: string;
  sourceId: string;
  happenedAt: Date | null;
  observedAt: Date;
  title: string | null;
  url: string | null;
  bodyText: string | null;
  artifactRefs: string[];
  payload: Json;
}

// User-state taxonomy from docs/release-validation-gates.md. For operational
// blockers that are not provider states (disk full, stale lock, corrupt store),
// `blocked_bug` applies: the user's provider state should work, but Nutshell
// cannot inspect or sync it right now.
export type UserState =
  | "not_configured"
  | "needs_auth"
  | "needs_permission"
  | "ready_empty"
  | "ready_with_data"
  | "blocked_bug";

export interface FindingGuidance {
  state: UserState;
  fix: string;
  confirm: string;
  url?: string;
}

export interface HealthFinding {
  level: HealthLevel;
  source: SourceId | "system";
  code: string;
  message: string;
  detail: Json;
  observedAt: Date;
  guidance?: FindingGuidance;
}

export type BackfillHealthStatus =
  | "recent_ok"
  | "backfill_incomplete"
  | "backfill_partial"
  | "backfill_complete";

export type BackfillLaneStatus = "complete" | "partial" | "incomplete" | "unsupported";

export interface RecentHealthItem {
  status: string | null;
  lastRunAt: string | null;
  completed: boolean | null;
  partial: boolean | null;
}

export interface BackfillLaneHealth {
  status: BackfillLaneStatus;
  reason: string | null;
  nextCommand: string | null;
  counts: JsonObject;
  targets: JsonObject;
  detail: JsonObject;
}

export interface BackfillHealthItem {
  source: SourceId;
  status: BackfillHealthStatus;
  counts: JsonObject;
  targets: JsonObject;
  recentStatus: string | null;
  lastBackfillStatus: string | null;
  recent: RecentHealthItem;
  bulkBackfill: BackfillLaneHealth;
  liveBackfill: BackfillLaneHealth;
  detail: JsonObject;
}

export interface AppBackgroundStatus {
  installed: boolean;
  path: string;
  executable: string;
  fullDiskAccess: "granted" | "missing" | "unknown";
  backgroundSync: "enabled" | "disabled" | "unknown";
  agent: "enabled" | "requiresApproval" | "notRegistered" | "notFound" | "unknown";
  dataRoot: string | null;
  raw: string;
}

export interface SchedulerHealth {
  intervalSeconds: number;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastAgentEventAt: string | null;
  lastAgentMessage: string | null;
  source: "agent_log" | "last_run" | "first_run_due" | "disabled" | "unavailable";
}

export interface HealthReport {
  status: "ok" | "warning" | "critical";
  checkedAt: Date;
  findings: HealthFinding[];
  backfill: BackfillHealthItem[];
  app: AppBackgroundStatus;
  scheduler: SchedulerHealth;
}

export interface SyncRunStart {
  id: string;
  command: string;
  mode: SyncMode;
  startedAt: Date;
}

export interface CommitSyncInput {
  source: SourceId;
  run: SyncRunStart;
  result: PluginSyncResult;
  expectedCheckpointVersion: number;
}

export interface CommitReport {
  runId: string;
  source: SourceId;
  insertedObservations: number;
  insertedRecords: number;
  checkpointVersion: number;
}

export interface SyncSourceReport {
  source: SourceId;
  status: "ok" | "warning" | "critical" | "partial" | "skipped";
  startedAt: Date;
  finishedAt: Date;
  durationMs: number;
  commit?: CommitReport;
  findings: HealthFinding[];
  metrics: Json;
  enrichment?: EnrichmentSourceReport;
}

export interface EnrichmentSourceReport {
  status: "ok" | "warning" | "critical" | "partial" | "skipped";
  startedAt: Date;
  finishedAt: Date;
  durationMs: number;
  commit?: CommitReport;
  findings: HealthFinding[];
  metrics: Json;
}

export interface SyncReport {
  status: "ok" | "warning" | "critical";
  startedAt: Date;
  finishedAt: Date;
  sources: SyncSourceReport[];
}

export interface PluginSmokeResult {
  message: string;
  findings: HealthFinding[];
  metrics: Json;
}

export interface StoreHealthcheckReport {
  runId: string;
  startedAt: Date;
  finishedAt: Date;
  durationMs: number;
  metrics: JsonObject;
}

export interface SourceResetReport {
  sources: SourceId[];
  deletedRecords: number;
  deletedObservations: number;
  deletedRuns: number;
  deletedFindings: number;
  deletedCheckpoints: number;
  deletedArtifactRows: number;
  artifactPaths: string[];
}

export interface SmokeStoreReport {
  status: "ok" | "critical";
  startedAt: Date;
  finishedAt: Date;
  durationMs: number;
  message: string;
  detail: JsonObject;
}

export interface SmokeSourceReport {
  source: SourceId;
  status: "ok" | "warning" | "critical";
  startedAt: Date;
  finishedAt: Date;
  durationMs: number;
  message: string;
  findings: HealthFinding[];
  metrics: Json;
}

export interface SmokeReport {
  status: "ok" | "warning" | "critical";
  startedAt: Date;
  finishedAt: Date;
  store: SmokeStoreReport;
  sources: SmokeSourceReport[];
}

export interface ArtifactRef {
  path: string;
  contentHash: string;
  mimeType: string | null;
  bytes: number;
}

export interface WriteArtifactInput {
  source: SourceId;
  relativePath: string;
  content: string | Uint8Array;
  mimeType?: string | null;
}

export interface TraceLogger {
  event(event: string, fields?: JsonObject): void;
  warn(event: string, fields?: JsonObject): void;
  error(event: string, fields?: JsonObject): void;
}

export interface PluginRecordReader {
  query(query: TraceQuery): Promise<RecordPage>;
}

export interface PluginContext {
  root: string;
  config: Json;
  logger: TraceLogger;
  signal: AbortSignal;
  now(): Date;
  records: PluginRecordReader;
  writeArtifact(input: WriteArtifactInput): Promise<ArtifactRef>;
}

export interface PluginManifest {
  id: SourceId;
  displayName: string;
  authKind: AuthKind;
  collections: string[];
  supportsBackfill: boolean;
  defaultBudget: SyncBudget;
}

export interface PluginSyncResult {
  observations: RawObservation[];
  records: TraceRecord[];
  nextCheckpoint: Json;
  health: HealthFinding[];
  metrics: Json;
  completed: boolean;
  partial: boolean;
}

export interface TraceQuery {
  source?: SourceId;
  kind?: RecordKind;
  type?: string;
  collection?: string;
  sourceId?: string;
  sourceIds?: string[];
  since?: Date;
  until?: Date;
  limit?: number;
  offset?: number;
}

export interface RecordPage {
  records: TraceRecord[];
  total: number;
  limit: number;
  offset: number;
}

export interface HealthSnapshot {
  dbOk: boolean;
  dbDetail: string;
  lastRuns: Json[];
  lastBackfillRuns: Json[];
  latestFindings: Json[];
  recordCounts: Json[];
  sourceStates: Json[];
  staleSources: SourceId[];
}

export interface ProjectionRequest {
  kind: "daily-json" | "daily-markdown" | "dashboard" | "all";
  date?: string;
}

export interface ProjectionReport {
  outputs: string[];
}

export interface HealthScope {
  source?: SourceId;
}

export const DEFAULT_BUDGET: SyncBudget = {
  maxRuntimeMs: 5 * 60 * 1000,
  maxRequests: null,
  minDelayMs: 0,
  stopOnRateLimit: true,
};
