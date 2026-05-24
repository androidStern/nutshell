import { Database } from "bun:sqlite";
import { SCHEMA_SQL } from "./schema.sql";

export function migrate(db: Database): void {
  db.exec(SCHEMA_SQL);
  const applied = db.query("select version from schema_migrations where version = 1").get() as
    | { version: number }
    | null;
  if (!applied) {
    db.query("insert into schema_migrations(version, applied_at) values (?, ?)").run(1, new Date().toISOString());
  }
}

