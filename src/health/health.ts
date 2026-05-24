import type { HealthFinding, HealthLevel, HealthReport, SourceId } from "../core/types";

export function makeFinding(
  level: HealthLevel,
  source: SourceId | "system",
  code: string,
  message: string,
  detail: HealthFinding["detail"] = {},
): HealthFinding {
  return { level, source, code, message, detail, observedAt: new Date() };
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

