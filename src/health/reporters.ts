import type { HealthReport } from "../core/types";
import { PRODUCT_NAME } from "../core/product";

export function formatHealthText(report: HealthReport): string {
  if (!report.findings.length) {
    const complete = report.backfill.filter((item) => item.status === "backfill_complete").length;
    const total = report.backfill.length;
    return total ? `OK ${PRODUCT_NAME} systems are healthy; backfill complete for ${complete}/${total} sources\n` : `OK ${PRODUCT_NAME} systems are healthy\n`;
  }
  const lines: string[] = [];
  for (const finding of report.findings.sort((a, b) => severity(b.level) - severity(a.level))) {
    const prefix = finding.level === "critical" ? "CRITICAL" : finding.level === "warning" ? "WARN" : "OK";
    lines.push(`${prefix} ${finding.source}/${finding.code}: ${finding.message}`);
  }
  for (const item of report.backfill) {
    const next = item.liveBackfill.nextCommand ? ` next=${item.liveBackfill.nextCommand}` : "";
    lines.push(
      `BACKFILL ${item.source}: ${item.status} bulk=${item.bulkBackfill.status} live=${item.liveBackfill.status}${next}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function severity(level: string): number {
  if (level === "critical") return 2;
  if (level === "warning") return 1;
  return 0;
}
