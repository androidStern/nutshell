import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import type {
  Checkpoint,
  CommitReport,
  CommitSyncInput,
  HealthSnapshot,
  Json,
  PluginSyncResult,
  RecordPage,
  TraceQuery,
  TraceRecord,
} from "../core/types";
import { CheckpointConflictError } from "../core/errors";
import { recordKey, sha256, stableJson } from "../core/ids";
import { parseDate, toIso } from "../core/time";
import { migrate } from "./migrations";
import type { TraceStore } from "./interface";

export class SQLiteTraceStore implements TraceStore {
  private readonly db: Database;

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true, readwrite: true });
    this.db.exec("pragma busy_timeout=10000");
    migrate(this.db);
  }

  async loadCheckpoint(source: string): Promise<Checkpoint> {
    const row = this.db
      .query("select version, state_json from source_state where source = ?")
      .get(source) as { version: number; state_json: string } | null;
    if (!row) return { version: 0, state: {} };
    return { version: row.version, state: JSON.parse(row.state_json) as Json };
  }

  async commitSync(input: CommitSyncInput): Promise<CommitReport> {
    return this.db.transaction(() => this.commitSyncTx(input))();
  }

  private commitSyncTx(input: CommitSyncInput): CommitReport {
    const checkpoint = this.db
      .query("select version from source_state where source = ?")
      .get(input.source) as { version: number } | null;
    const actualVersion = checkpoint?.version ?? 0;
    if (actualVersion !== input.expectedCheckpointVersion) {
      throw new CheckpointConflictError(
        `checkpoint conflict for ${input.source}: expected ${input.expectedCheckpointVersion}, got ${actualVersion}`,
      );
    }

    const now = new Date().toISOString();
    let insertedObservations = 0;
    let insertedRecords = 0;

    for (const observation of input.result.observations) {
      const before = this.db
        .query("select seen_count from observations where source = ? and fingerprint = ?")
        .get(observation.source, observation.fingerprint) as { seen_count: number } | null;
      this.db
        .query(
          `insert into observations (
            source, fingerprint, source_record_id, observed_at, first_seen_at, last_seen_at,
            seen_count, payload_json, artifact_paths_json
          ) values (?, ?, ?, ?, ?, ?, 1, ?, ?)
          on conflict(source, fingerprint) do update set
            source_record_id = coalesce(excluded.source_record_id, observations.source_record_id),
            observed_at = excluded.observed_at,
            last_seen_at = excluded.last_seen_at,
            seen_count = observations.seen_count + 1,
            payload_json = excluded.payload_json,
            artifact_paths_json = excluded.artifact_paths_json`,
        )
        .run(
          observation.source,
          observation.fingerprint,
          observation.sourceRecordId,
          toIso(observation.observedAt),
          now,
          now,
          stableJson(observation.payload),
          JSON.stringify(observation.artifactPaths),
        );
      if (!before) insertedObservations += 1;
      this.upsertArtifactPaths(observation.source, observation.artifactPaths);
    }

    for (const record of input.result.records) {
      const id = recordKey(record.source, record.kind, record.type, record.sourceId);
      const before = this.db.query("select id from records where id = ?").get(id) as { id: string } | null;
      this.db
        .query(
          `insert into records (
            id, source, collection, kind, type, source_id, happened_at, observed_at,
            title, url, body_text, artifact_refs_json, payload_json, created_at, updated_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          on conflict(source, kind, type, source_id) do update set
            collection = excluded.collection,
            happened_at = coalesce(excluded.happened_at, records.happened_at),
            observed_at = excluded.observed_at,
            title = coalesce(excluded.title, records.title),
            url = coalesce(excluded.url, records.url),
            body_text = coalesce(excluded.body_text, records.body_text),
            artifact_refs_json = excluded.artifact_refs_json,
            payload_json = excluded.payload_json,
            updated_at = excluded.updated_at`,
        )
        .run(
          id,
          record.source,
          record.collection,
          record.kind,
          record.type,
          record.sourceId,
          toIso(record.happenedAt),
          toIso(record.observedAt),
          record.title,
          record.url,
          record.bodyText,
          JSON.stringify(record.artifactRefs),
          stableJson(record.payload),
          now,
          now,
        );
      if (!before) insertedRecords += 1;
      this.upsertArtifactPaths(record.source, record.artifactRefs);
    }

    const nextVersion = actualVersion + 1;
    this.db
      .query(
        `insert into source_state(source, version, state_json, updated_at)
         values (?, ?, ?, ?)
         on conflict(source) do update set
           version = excluded.version,
           state_json = excluded.state_json,
           updated_at = excluded.updated_at`,
      )
      .run(input.source, nextVersion, stableJson(input.result.nextCheckpoint), now);

    const status = statusForResult(input.result);
    this.db
      .query(
        `insert into sync_runs (
          id, source, command, mode, started_at, finished_at, status, partial, completed,
          expected_checkpoint_version, next_checkpoint_version, metrics_json, error_json
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.run.id,
        input.source,
        input.run.command,
        input.run.mode,
        toIso(input.run.startedAt),
        now,
        status,
        input.result.partial ? 1 : 0,
        input.result.completed ? 1 : 0,
        input.expectedCheckpointVersion,
        nextVersion,
        stableJson(input.result.metrics),
        "{}",
      );

    for (const finding of input.result.health) {
      const id = sha256(`${input.run.id}:${finding.source}:${finding.code}:${finding.observedAt.toISOString()}`);
      this.db
        .query(
          `insert or replace into health_findings (
            id, run_id, level, source, code, message, detail_json, guidance_json, observed_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.run.id,
          finding.level,
          finding.source,
          finding.code,
          finding.message,
          stableJson(finding.detail),
          finding.guidance ? JSON.stringify(finding.guidance) : null,
          toIso(finding.observedAt),
        );
    }

    return {
      runId: input.run.id,
      source: input.source,
      insertedObservations,
      insertedRecords,
      checkpointVersion: nextVersion,
    };
  }

  async query(query: TraceQuery): Promise<RecordPage> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (query.source) {
      clauses.push("source = ?");
      params.push(query.source);
    }
    if (query.kind) {
      clauses.push("kind = ?");
      params.push(query.kind);
    }
    if (query.type) {
      clauses.push("type = ?");
      params.push(query.type);
    }
    if (query.collection) {
      clauses.push("collection = ?");
      params.push(query.collection);
    }
    if (query.sourceId) {
      clauses.push("source_id = ?");
      params.push(query.sourceId);
    }
    if (query.sourceIds) {
      const ids = [...new Set(query.sourceIds.filter(Boolean))];
      if (ids.length === 0) clauses.push("1 = 0");
      else {
        clauses.push(`source_id in (${ids.map(() => "?").join(", ")})`);
        params.push(...ids);
      }
    }
    if (query.since) {
      clauses.push("coalesce(happened_at, observed_at) >= ?");
      params.push(query.since.toISOString());
    }
    if (query.until) {
      clauses.push("coalesce(happened_at, observed_at) < ?");
      params.push(query.until.toISOString());
    }
    const where = clauses.length ? `where ${clauses.join(" and ")}` : "";
    const totalRow = this.db.query(`select count(*) as count from records ${where}`).get(...(params as never[])) as { count: number };
    const limit = Math.min(Math.max(query.limit ?? 200, 1), 1000);
    const offset = Math.max(query.offset ?? 0, 0);
    const rows = this.db
      .query(
        `select * from records ${where}
         order by coalesce(happened_at, observed_at) desc, source asc, type asc
         limit ? offset ?`,
      )
      .all(...([...params, limit, offset] as never[])) as DbRecordRow[];
    return { records: rows.map(rowToRecord), total: totalRow.count, limit, offset };
  }

  async healthSnapshot(): Promise<HealthSnapshot> {
    let dbOk = true;
    let dbDetail = "ok";
    try {
      const row = this.db.query("pragma quick_check").get() as { quick_check: string } | [string] | null;
      const value = Array.isArray(row) ? row[0] : row ? Object.values(row)[0] : "no result";
      dbDetail = String(value);
      dbOk = dbDetail === "ok";
    } catch (error) {
      dbOk = false;
      dbDetail = String(error);
    }
    const lastRuns = this.db
      .query(
        `select id, source, status, started_at, finished_at, partial, completed
         from sync_runs
         where mode = 'recent'
           and id in (
             select id from sync_runs r2
             where r2.source = sync_runs.source
               and r2.mode = 'recent'
             order by started_at desc
             limit 1
           )
         order by source`,
      )
      .all() as unknown as Json[];
    const lastBackfillRuns = this.db
      .query(
        `select id, source, status, mode, started_at, finished_at, partial, completed, metrics_json
         from sync_runs
         where mode = 'backfill'
           and id in (
             select id from sync_runs r2
             where r2.source = sync_runs.source
               and r2.mode = 'backfill'
             order by started_at desc
             limit 1
           )
         order by source`,
      )
      .all() as unknown as Json[];
    const latestFindings = this.db
      .query(
        `select source, level, code, message, detail_json, guidance_json, observed_at, run_id
         from health_findings
         where id in (
           select id from health_findings h2
           where h2.source = health_findings.source
           order by observed_at desc
           limit 1
         )
         order by source`,
      )
      .all() as unknown as Json[];
    const recordCounts = this.db
      .query(
        `select source, type, count(*) as count,
                min(coalesce(happened_at, observed_at)) as oldest,
                max(coalesce(happened_at, observed_at)) as newest
         from records
         group by source, type
         order by source, type`,
      )
      .all() as unknown as Json[];
    const sourceStates = this.db
      .query("select source, version, state_json, updated_at from source_state order by source")
      .all() as unknown as Json[];
    return { dbOk, dbDetail, lastRuns, lastBackfillRuns, latestFindings, recordCounts, sourceStates, staleSources: [] };
  }

  async close(): Promise<void> {
    this.db.close();
  }

  private upsertArtifactPaths(source: string, paths: string[]): void {
    for (const path of paths) {
      const metadata = artifactMetadata(path);
      const contentHash = metadata.contentHash ?? sha256(path);
      const id = sha256(`${contentHash}:${path}`);
      this.db
        .query(
          `insert into artifacts(id, source, path, content_hash, mime_type, bytes, metadata_json, created_at, updated_at)
           values (?, ?, ?, ?, ?, ?, '{}', ?, ?)
           on conflict(content_hash, path) do update set updated_at = excluded.updated_at`,
        )
        .run(id, source, path, contentHash, metadata.mimeType, metadata.bytes, new Date().toISOString(), new Date().toISOString());
    }
  }
}

export function openStore(path: string): SQLiteTraceStore {
  return new SQLiteTraceStore(path);
}

function statusForResult(result: PluginSyncResult): string {
  if (result.health.some((item) => item.level === "critical")) return "critical";
  if (result.partial) return "partial";
  if (result.health.some((item) => item.level === "warning")) return "warning";
  return "ok";
}

function artifactMetadata(path: string): { contentHash: string | null; mimeType: string | null; bytes: number } {
  if (!existsSync(path)) return { contentHash: null, mimeType: null, bytes: 0 };
  const data = readFileSync(path);
  return {
    contentHash: sha256(data),
    mimeType: null,
    bytes: statSync(path).size,
  };
}

interface DbRecordRow {
  source: string;
  collection: string | null;
  kind: string;
  type: string;
  source_id: string;
  happened_at: string | null;
  observed_at: string;
  title: string | null;
  url: string | null;
  body_text: string | null;
  artifact_refs_json: string;
  payload_json: string;
}

function rowToRecord(row: DbRecordRow): TraceRecord {
  return {
    source: row.source,
    collection: row.collection,
    kind: row.kind as TraceRecord["kind"],
    type: row.type,
    sourceId: row.source_id,
    happenedAt: parseDate(row.happened_at),
    observedAt: parseDate(row.observed_at) ?? new Date(),
    title: row.title,
    url: row.url,
    bodyText: row.body_text,
    artifactRefs: JSON.parse(row.artifact_refs_json) as string[],
    payload: JSON.parse(row.payload_json) as Json,
  };
}
