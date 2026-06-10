import { Database } from "bun:sqlite";
import { SCHEMA_SQL } from "./schema.sql";

export function migrate(db: Database): void {
  db.exec(SCHEMA_SQL);
  applyMigration(db, 1, () => {
    // Baseline schema: created by SCHEMA_SQL above.
  });
  applyMigration(db, 2, () => {
    if (!tableHasColumn(db, "health_findings", "guidance_json")) {
      db.exec("alter table health_findings add column guidance_json text");
    }
  });
}

function applyMigration(db: Database, version: number, step: () => void): void {
  const applied = db.query("select version from schema_migrations where version = ?").get(version) as
    | { version: number }
    | null;
  if (applied) return;
  step();
  db.query("insert into schema_migrations(version, applied_at) values (?, ?)").run(version, new Date().toISOString());
}

function tableHasColumn(db: Database, table: string, column: string): boolean {
  const rows = db.query("select name from pragma_table_info(?)").all(table) as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}
