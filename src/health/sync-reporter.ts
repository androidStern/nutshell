import type { HealthFinding, SyncReport, SyncSourceReport } from "../core/types";

// Plain-text sync summary: skipped sources first (with the guidance that explains
// the skip), then one status line per source that ran, then the overall result.
export function formatSyncText(report: SyncReport): string {
  const lines: string[] = [];
  const skipped = report.sources.filter((source) => source.status === "skipped");
  const ran = report.sources.filter((source) => source.status !== "skipped");

  for (const source of skipped) {
    const finding = problemFindings(source)[0];
    lines.push(`SKIPPED ${source.source}: ${finding?.message ?? "skipped"}`);
    if (finding) lines.push(...guidanceLines(finding));
  }

  for (const source of ran) {
    lines.push(
      `${source.status.toUpperCase()} ${source.source}: records=${source.commit?.insertedRecords ?? 0} observations=${source.commit?.insertedObservations ?? 0} (${source.durationMs}ms)`,
    );
    for (const finding of problemFindings(source)) {
      lines.push(`${levelPrefix(finding.level)} ${finding.source}/${finding.code}: ${finding.message}`);
      lines.push(...guidanceLines(finding));
    }
  }

  const totalMs = report.finishedAt.getTime() - report.startedAt.getTime();
  lines.push(`SYNC ${report.status} in ${totalMs}ms`);
  return `${lines.join("\n")}\n`;
}

function problemFindings(source: SyncSourceReport): HealthFinding[] {
  return source.findings.filter((finding) => finding.level === "warning" || finding.level === "critical");
}

function guidanceLines(finding: HealthFinding): string[] {
  if (!finding.guidance) return [];
  return [`  fix:  ${finding.guidance.fix}`, `  then: ${finding.guidance.confirm}`];
}

function levelPrefix(level: HealthFinding["level"]): string {
  return level === "critical" ? "CRITICAL" : "WARN";
}
