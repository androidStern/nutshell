import { createHash } from "node:crypto";
import type { Json, SourceId } from "./types";

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function stableJson(value: Json): string {
  return JSON.stringify(sortJson(value));
}

export function sortJson(value: Json): Json {
  if (Array.isArray(value)) return value.map((item) => sortJson(item));
  if (value && typeof value === "object") {
    const output: Record<string, Json> = {};
    for (const key of Object.keys(value).sort()) {
      output[key] = sortJson(value[key] ?? null);
    }
    return output;
  }
  return value;
}

export function fingerprint(parts: Json): string {
  return sha256(stableJson(parts));
}

export function recordKey(source: SourceId, kind: string, type: string, sourceId: string): string {
  return sha256(`${source}\u001f${kind}\u001f${type}\u001f${sourceId}`);
}

export function runId(prefix = "run"): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
}

export function slugify(value: string, fallback = "untitled"): string {
  const text = value
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 90);
  return text || fallback;
}

