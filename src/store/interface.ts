import type {
  Checkpoint,
  CommitReport,
  CommitSyncInput,
  HealthSnapshot,
  RecordPage,
  SourceResetReport,
  StoreHealthcheckReport,
  TraceQuery,
} from "../core/types";

export interface TraceStore {
  loadCheckpoint(source: string): Promise<Checkpoint>;
  commitSync(input: CommitSyncInput): Promise<CommitReport>;
  commitHealthcheck(command: string, startedAt: Date): Promise<StoreHealthcheckReport>;
  resetSources(sources: string[]): Promise<SourceResetReport>;
  query(query: TraceQuery): Promise<RecordPage>;
  healthSnapshot(): Promise<HealthSnapshot>;
  close(): Promise<void>;
}
