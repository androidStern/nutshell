export const SCHEMA_SQL = `
pragma journal_mode = wal;
pragma foreign_keys = on;

create table if not exists schema_migrations (
  version integer primary key,
  applied_at text not null
);

create table if not exists sync_runs (
  id text primary key,
  source text not null,
  command text not null,
  mode text not null,
  started_at text not null,
  finished_at text not null,
  status text not null,
  partial integer not null,
  completed integer not null,
  expected_checkpoint_version integer not null,
  next_checkpoint_version integer not null,
  metrics_json text not null,
  error_json text not null default '{}'
);

create index if not exists idx_sync_runs_source_started
  on sync_runs(source, started_at desc);

create table if not exists source_state (
  source text primary key,
  version integer not null,
  state_json text not null,
  updated_at text not null
);

create table if not exists observations (
  source text not null,
  fingerprint text not null,
  source_record_id text,
  observed_at text not null,
  first_seen_at text not null,
  last_seen_at text not null,
  seen_count integer not null,
  payload_json text not null,
  artifact_paths_json text not null,
  primary key (source, fingerprint)
);

create index if not exists idx_observations_source_seen
  on observations(source, last_seen_at desc);

create table if not exists records (
  id text primary key,
  source text not null,
  collection text,
  kind text not null,
  type text not null,
  source_id text not null,
  happened_at text,
  observed_at text not null,
  title text,
  url text,
  body_text text,
  artifact_refs_json text not null,
  payload_json text not null,
  created_at text not null,
  updated_at text not null,
  unique(source, kind, type, source_id)
);

create index if not exists idx_records_happened
  on records(happened_at desc);

create index if not exists idx_records_source_type_happened
  on records(source, type, happened_at desc);

create table if not exists artifacts (
  id text primary key,
  source text not null,
  path text not null,
  content_hash text not null,
  mime_type text,
  bytes integer not null,
  metadata_json text not null,
  created_at text not null,
  updated_at text not null,
  unique(content_hash, path)
);

create table if not exists health_findings (
  id text primary key,
  run_id text,
  level text not null,
  source text not null,
  code text not null,
  message text not null,
  detail_json text not null,
  guidance_json text,
  observed_at text not null
);

create index if not exists idx_health_findings_source_observed
  on health_findings(source, observed_at desc);
`;

