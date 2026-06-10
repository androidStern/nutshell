import type { BackfillHealthItem, HealthFinding, HealthReport } from "../core/types";
import { PRODUCT_NAME } from "../core/product";

// System prerequisites that block every protected source probe. When one of
// these is present, downstream needs_permission source findings are symptoms
// of the same root cause, so the text rendering collapses them into a single
// caused-by line instead of listing four symptoms for one cause. JSON output
// is untouched — suppression is text-rendering only.
const PREREQUISITE_CODES = new Set(["nutshell_app_missing", "nutshell_app_full_disk_access_missing"]);

export function formatHealthText(report: HealthReport): string {
  const schedule = `SCHEDULE: agent=${report.app.agent} sync=${report.app.backgroundSync} last=${report.scheduler.lastRunAt ?? "unknown"} next=${report.scheduler.nextRunAt ?? "unknown"}\n`;
  if (!report.findings.length) {
    const complete = report.backfill.filter((item) => item.status === "backfill_complete").length;
    const total = report.backfill.length;
    return total
      ? `OK ${PRODUCT_NAME} systems are healthy; backfill complete for ${complete}/${total} sources\n${schedule}`
      : `OK ${PRODUCT_NAME} systems are healthy\n${schedule}`;
  }
  const lines: string[] = [schedule.trim()];
  const prerequisites = report.findings.filter((finding) => finding.source === "system" && PREREQUISITE_CODES.has(finding.code));
  const suppressed = new Set(
    prerequisites.length
      ? report.findings.filter((finding) => finding.source !== "system" && finding.level !== "ok" && finding.guidance?.state === "needs_permission")
      : [],
  );
  for (const finding of prerequisites) lines.push(...findingLines(finding));
  if (suppressed.size) {
    lines.push(`  ↳ ${suppressed.size} source ${suppressed.size === 1 ? "check" : "checks"} blocked by the issue above — fix it first.`);
  }
  const remaining = report.findings
    .filter((finding) => !prerequisites.includes(finding) && !suppressed.has(finding))
    .sort((a, b) => severity(b.level) - severity(a.level));
  for (const finding of remaining) lines.push(...findingLines(finding));
  for (const item of report.backfill) lines.push(backfillLine(item));
  return `${lines.join("\n")}\n`;
}

function findingLines(finding: HealthFinding): string[] {
  const prefix = finding.level === "critical" ? "CRITICAL" : finding.level === "warning" ? "WARN" : "OK";
  const lines = [`${prefix} ${finding.source}/${finding.code}: ${finding.message}`];
  if (finding.level !== "ok" && finding.guidance) {
    lines.push(`  fix:  ${finding.guidance.fix}`);
    lines.push(`  then: ${finding.guidance.confirm}`);
  }
  return lines;
}

function backfillLine(item: BackfillHealthItem): string {
  if (item.status === "backfill_complete") return `BACKFILL ${item.source}: complete`;
  const nextCommand = item.bulkBackfill.nextCommand ?? item.liveBackfill.nextCommand;
  if (item.bulkBackfill.status !== "complete" && item.bulkBackfill.status !== "unsupported" && nextCommand) {
    return `BACKFILL ${item.source}: history import pending — when your export arrives: ${nextCommand}`;
  }
  const next = item.liveBackfill.nextCommand ? ` next=${item.liveBackfill.nextCommand}` : "";
  return `BACKFILL ${item.source}: ${item.status} bulk=${item.bulkBackfill.status} live=${item.liveBackfill.status}${next}`;
}

function severity(level: string): number {
  if (level === "critical") return 2;
  if (level === "warning") return 1;
  return 0;
}
