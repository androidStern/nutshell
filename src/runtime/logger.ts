import { mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import type { JsonObject, TraceLogger } from "../core/types";
import { redactJson } from "../core/redaction";

export class JsonlLogger implements TraceLogger {
  constructor(private readonly path: string) {}

  event(event: string, fields: JsonObject = {}): void {
    this.write("info", event, fields);
  }

  warn(event: string, fields: JsonObject = {}): void {
    this.write("warn", event, fields);
  }

  error(event: string, fields: JsonObject = {}): void {
    this.write("error", event, fields);
  }

  private write(level: "info" | "warn" | "error", event: string, fields: JsonObject): void {
    const payload = {
      ts: new Date().toISOString(),
      level,
      event,
      ...(redactJson(fields) as JsonObject),
    };
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(payload)}\n`, "utf8");
  }
}
