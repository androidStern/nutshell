import type { FindingGuidance, HealthFinding, HealthLevel, HealthReport, SourceId } from "../core/types";
import { redactJson, redactText } from "../core/redaction";

export function makeFinding(
  level: HealthLevel,
  source: SourceId | "system",
  code: string,
  message: string,
  detail: HealthFinding["detail"] = {},
  guidance?: FindingGuidance,
): HealthFinding {
  return {
    level,
    source,
    code,
    message: redactText(message),
    detail: redactJson(detail),
    observedAt: new Date(),
    ...(guidance ? { guidance } : {}),
  };
}

export function reportStatus(findings: HealthFinding[]): HealthReport["status"] {
  if (findings.some((item) => item.level === "critical")) return "critical";
  if (findings.some((item) => item.level === "warning")) return "warning";
  return "ok";
}

export function exitCodeForHealth(report: HealthReport): number {
  if (report.status === "critical") return 2;
  if (report.status === "warning") return 1;
  return 0;
}
