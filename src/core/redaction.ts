import type { Json, JsonObject } from "./types";

const SECRET_KEY_PATTERN = /cookie|ct0|token|api[_-]?key|authorization|oauth|refresh[_-]?token|access[_-]?token|client[_-]?secret|secret/i;

export function redactJson(value: Json): Json {
  if (Array.isArray(value)) return value.map((item) => redactJson(item));
  if (!value || typeof value !== "object") return redactScalar(value);
  const output: JsonObject = {};
  for (const [key, child] of Object.entries(value)) {
    output[key] = SECRET_KEY_PATTERN.test(key) ? "<redacted>" : redactJson(child);
  }
  return output;
}

function redactScalar(value: Json): Json {
  if (typeof value !== "string") return value;
  return redactText(value);
}

export function redactText(value: string): string {
  if (/auth_token=|ct0=|Bearer\s+|AIza|sk-[A-Za-z0-9]|refresh_token|access_token|secret[-_a-z0-9]*token/i.test(value)) return "<redacted>";
  return value;
}
