const SECRET_PATTERNS: RegExp[] = [
  /(?i:authorization)([=:]\s*)\S+/g,
  /(?i:api[_-]?key)([=:]\s*)\S+/g,
  /(?i:auth[_-]?token)([=:]\s*)\S+/g,
  /(?i:refresh[_-]?token)([=:]\s*)\S+/g,
  /(?i:access[_-]?token)([=:]\s*)\S+/g,
  /(?i:token)([=:]\s*)\S+/g,
  /(?i:secret)([=:]\s*)\S+/g,
  /(?i:ct0)([=:]\s*)\S+/g,
  /(?i:cookie)([=:]\s*)[^\n\r]+/g,
];

export function redactText(input: string): string {
  let output = input;
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, (match, sep: string) => {
      const key = match.slice(0, Math.max(0, match.indexOf(sep)));
      return `${key}${sep}<redacted>`;
    });
  }
  output = output.replace(/https:\/\/x\.com\/[^/\s]+\/status\/\d+/g, "https://x.com/<tweet>");
  return output;
}

export function redactJson<T>(value: T): T {
  if (typeof value === "string") return redactText(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactJson(item)) as T;
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (/cookie|token|secret|api.?key|authorization|ct0/i.test(key)) {
        output[key] = "<redacted>";
      } else {
        output[key] = redactJson(item);
      }
    }
    return output as T;
  }
  return value;
}
