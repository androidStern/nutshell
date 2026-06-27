import type { BackfillHealthItem, HealthFinding, HealthReport } from "../core/types";
import { CLI_NAME, PRODUCT_NAME } from "../core/product";
import { parseDate } from "../core/time";

// System prerequisites that block every protected source probe. When one of
// these is present, downstream needs_permission source findings are symptoms
// of the same root cause, so the text rendering collapses them into a single
// caused-by line instead of listing four symptoms for one cause. JSON output
// is untouched — suppression is text-rendering only.
const PREREQUISITE_CODES = new Set(["nutshell_app_missing", "nutshell_app_full_disk_access_missing"]);

export interface HealthTextOptions {
  now?: Date;
  locale?: string;
  timeZone?: string;
}

export function formatHealthText(report: HealthReport, options: HealthTextOptions = {}): string {
  const schedule = formatScheduleText(report, options);
  if (!report.findings.length) {
    const complete = report.backfill.filter((item) => item.status === "backfill_complete").length;
    const total = report.backfill.length;
    return total
      ? `OK ${PRODUCT_NAME} systems are healthy; backfill complete for ${complete}/${total} sources\n${schedule}`
      : `OK ${PRODUCT_NAME} systems are healthy\n${schedule}`;
  }
  const lines: string[] = [...schedule.trimEnd().split("\n"), ""];
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

export function formatScheduleText(report: HealthReport, options: HealthTextOptions = {}): string {
  return [
    `Automatic sync: ${automaticSyncLabel(report.app.backgroundSync)}`,
    `Nutshell.app: ${report.app.installed ? "installed" : "not installed"}`,
    `Background agent: ${agentLabel(report.app.agent)}`,
    `Last sync: ${lastSyncLabel(report.scheduler.lastRunAt, options)}`,
    `Next sync: ${nextSyncLabel(report, options)}`,
    `Run \`${CLI_NAME} sync\` to sync immediately.`,
    "",
  ].join("\n");
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

function automaticSyncLabel(value: HealthReport["app"]["backgroundSync"]): string {
  if (value === "enabled") return "on";
  if (value === "disabled") return "off";
  return "unknown";
}

function agentLabel(value: HealthReport["app"]["agent"]): string {
  if (value === "enabled") return "enabled";
  if (value === "requiresApproval") return "needs approval";
  if (value === "notRegistered") return "not registered";
  if (value === "notFound") return "not found";
  return "unknown";
}

function lastSyncLabel(value: string | null, options: HealthTextOptions): string {
  if (!value) return "not run yet";
  return localTimeLabel(value, options) ?? "unknown";
}

function nextSyncLabel(report: HealthReport, options: HealthTextOptions): string {
  if (report.scheduler.nextRunAt) return localTimeLabel(report.scheduler.nextRunAt, options) ?? "unknown";
  if (!report.app.installed) return "not scheduled until Nutshell.app is installed";
  if (report.app.backgroundSync === "disabled") return "not scheduled while automatic sync is off";
  if (report.app.agent === "requiresApproval") return "not scheduled until the background agent is approved";
  if (report.app.agent !== "enabled") return "not scheduled until the background agent is enabled";
  return "unknown";
}

function localTimeLabel(value: string, options: HealthTextOptions): string | null {
  const date = parseDate(value);
  if (!date) return null;
  const now = options.now ?? new Date();
  const locale = options.locale ?? "en-US";
  const timeZoneOptions = options.timeZone ? { timeZone: options.timeZone } : {};
  const time = new Intl.DateTimeFormat(locale, {
    ...timeZoneOptions,
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
  const dateKey = localDateKey(date, locale, options.timeZone);
  const todayKey = localDateKey(now, locale, options.timeZone);
  if (dateKey === todayKey) return `today at ${time}`;
  if (dateKey === shiftDateKey(todayKey, 1)) return `tomorrow at ${time}`;
  if (dateKey === shiftDateKey(todayKey, -1)) return `yesterday at ${time}`;
  const year = dateKey.slice(0, 4) === todayKey.slice(0, 4) ? undefined : "numeric";
  const day = new Intl.DateTimeFormat(locale, {
    ...timeZoneOptions,
    month: "short",
    day: "numeric",
    year,
  }).format(date);
  return `${day} at ${time}`;
}

function localDateKey(value: Date, locale: string, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat(locale, {
    ...(timeZone ? { timeZone } : {}),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const part = (type: string): string => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function shiftDateKey(key: string, days: number): string {
  const [yearText, monthText, dayText] = key.split("-");
  const year = Number(yearText ?? "0");
  const month = Number(monthText ?? "1");
  const day = Number(dayText ?? "1");
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return [
    String(date.getUTCFullYear()).padStart(4, "0"),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}
