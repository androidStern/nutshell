import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { HealthFinding, Json, JsonObject, SourceId } from "../core/types";
import { redactJson, redactText } from "../core/redaction";
import type { TraceConfig } from "../config/config";
import { objectAt } from "../config/config";
import type { ConfigDraft, PluginSetupStatus } from "./types";

export class JsonConfigDraft implements ConfigDraft {
  readonly root: string;
  readonly path: string;
  readonly data: JsonObject;

  constructor(config: TraceConfig) {
    this.root = config.root;
    this.path = config.path;
    this.data = cloneJsonObject(config.data);
  }

  pluginConfig(source: SourceId): JsonObject {
    const plugins = ensureObject(this.data, "plugins");
    const existing = plugins[source];
    if (existing && typeof existing === "object" && !Array.isArray(existing)) return existing as JsonObject;
    const created: JsonObject = {};
    plugins[source] = created;
    return created;
  }

  setPluginEnabled(source: SourceId, enabled: boolean): void {
    this.pluginConfig(source).enabled = enabled;
    if (!enabled) this.setPluginSetupStatus(source, "disabled");
  }

  setPluginSetupStatus(source: SourceId, status: PluginSetupStatus, findings: HealthFinding[] = []): void {
    const cfg = this.pluginConfig(source);
    cfg.setup = {
      status,
      updatedAt: new Date().toISOString(),
      findings: findings.map((finding) => ({
        level: finding.level,
        code: finding.code,
        message: redactText(finding.message),
        observedAt: finding.observedAt.toISOString(),
        detail: redactJson(finding.detail),
        ...(finding.guidance ? { guidance: { ...finding.guidance } } : {}),
      })) as unknown as Json,
    };
  }

  async commit(): Promise<void> {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
    renameSync(tmp, this.path);
  }
}

export function pluginSetupStatus(config: TraceConfig, source: SourceId): PluginSetupStatus | null {
  const setup = objectAt(objectAt(objectAt(config.data, "plugins"), source), "setup");
  const status = setup.status;
  return status === "ready" || status === "degraded" || status === "disabled" ? status : null;
}

export function pluginSetupUpdatedAt(config: TraceConfig, source: SourceId): Date | null {
  const setup = objectAt(objectAt(objectAt(config.data, "plugins"), source), "setup");
  if (typeof setup.updatedAt !== "string") return null;
  const parsed = new Date(setup.updatedAt);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function pluginSetupFindings(config: TraceConfig, source: SourceId): JsonObject[] {
  const setup = objectAt(objectAt(objectAt(config.data, "plugins"), source), "setup");
  return Array.isArray(setup.findings)
    ? setup.findings.filter((item): item is JsonObject => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    : [];
}

function ensureObject(parent: JsonObject, key: string): JsonObject {
  const current = parent[key];
  if (current && typeof current === "object" && !Array.isArray(current)) return current as JsonObject;
  const created: JsonObject = {};
  parent[key] = created;
  return created;
}

function cloneJsonObject(value: JsonObject): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}
