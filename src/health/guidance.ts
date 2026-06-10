import type { FindingGuidance, HealthFinding, HealthLevel, Json, SourceId, UserState } from "../core/types";
import { redactJson, redactText } from "../core/redaction";

// One code = one user state = one fix. A failure that needs a different fix
// gets its own code, not a message variant.
// Naming contract: codes for provider rate limits end in "_rate_limited" —
// the scheduler backs off on those instead of probing them every run.
export interface FindingSpec {
  level: "warning" | "critical";
  state: UserState;
  fix: string;
  confirm: string;
  url?: string;
  sample: string;
}

export class FindingCatalog<K extends string = string> {
  constructor(
    readonly source: SourceId | "system",
    readonly specs: Record<K, FindingSpec>,
  ) {}

  make(code: K, message: string, detail: Json = {}, level?: HealthLevel): HealthFinding {
    const spec = this.spec(code);
    return {
      level: level ?? spec.level,
      source: this.source,
      code,
      message: redactText(message),
      detail: redactJson(detail),
      observedAt: new Date(),
      guidance: guidanceFromSpec(spec),
    };
  }

  spec(code: K): FindingSpec {
    const spec = this.specs[code];
    if (!spec) throw new Error(`unknown finding code for ${this.source}: ${String(code)}`);
    return spec;
  }

  has(code: string): boolean {
    return Object.hasOwn(this.specs, code);
  }

  codes(): K[] {
    return Object.keys(this.specs) as K[];
  }

  sample(code: K): HealthFinding {
    return this.make(code, this.spec(code).sample);
  }

  samples(): HealthFinding[] {
    return this.codes().map((code) => this.sample(code));
  }
}

export function guidanceFromSpec(spec: FindingSpec): FindingGuidance {
  return {
    state: spec.state,
    fix: redactText(spec.fix),
    confirm: spec.confirm,
    ...(spec.url ? { url: spec.url } : {}),
  };
}

export function guidanceFromJson(value: Json): FindingGuidance | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as { [key: string]: Json };
  const state = record.state;
  const fix = record.fix;
  const confirm = record.confirm;
  if (typeof state !== "string" || typeof fix !== "string" || typeof confirm !== "string") return undefined;
  return {
    state: state as UserState,
    fix,
    confirm,
    ...(typeof record.url === "string" ? { url: record.url } : {}),
  };
}
