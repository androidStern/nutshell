import type {
  Checkpoint,
  CommitReport,
  CommitSyncInput,
  HealthSnapshot,
  RecordPage,
  TraceQuery,
} from "../core/types";

export interface TraceStore {
  loadCheckpoint(source: string): Promise<Checkpoint>;
  commitSync(input: CommitSyncInput): Promise<CommitReport>;
  query(query: TraceQuery): Promise<RecordPage>;
  healthSnapshot(): Promise<HealthSnapshot>;
  close(): Promise<void>;
}

