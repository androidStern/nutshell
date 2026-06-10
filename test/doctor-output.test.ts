import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackfillHealthItem, HealthFinding, HealthReport, SourceId } from "../src/core/types";
import { formatHealthText } from "../src/health/reporters";
import { SYSTEM_FINDINGS } from "../src/health/system-findings";

setDefaultTimeout(15_000);

// Goal criteria 12, 13, 16: doctor/health text leads with the root cause and
// collapses caused-by symptoms, source aliases resolve on the real binary, and
// the backfill standing line carries the exact import command.

test("a missing-FDA root cause leads and collapses downstream permission findings into one line", () => {
  const fda = SYSTEM_FINDINGS.make("nutshell_app_full_disk_access_missing", "Nutshell.app does not have Full Disk Access");
  const podcasts = permissionFinding("podcasts", "podcasts_db_unreadable", "Apple Podcasts database could not be read");
  const notes = permissionFinding("apple_notes", "apple_notes_permission", "Notes automation is not allowed");

  const text = formatHealthText(healthReport([podcasts, fda, notes]));
  const lines = text.trimEnd().split("\n");

  expect(lines[0]).toStartWith("SCHEDULE:");
  expect(lines[1]).toBe(`CRITICAL system/nutshell_app_full_disk_access_missing: ${fda.message}`);
  expect(lines[2]).toBe(`  fix:  ${fda.guidance!.fix}`);
  expect(lines[3]).toBe(`  then: ${fda.guidance!.confirm}`);
  expect(lines[4]).toBe("  ↳ 2 source checks blocked by the issue above — fix it first.");
  expect(lines).toHaveLength(5);
  expect(text.match(/blocked by the issue above/g)).toHaveLength(1);
  expect(text).not.toContain("podcasts_db_unreadable");
  expect(text).not.toContain("apple_notes_permission");
});

test("a single blocked source check renders the singular caused-by line", () => {
  const fda = SYSTEM_FINDINGS.make("nutshell_app_full_disk_access_missing", "Nutshell.app does not have Full Disk Access");
  const podcasts = permissionFinding("podcasts", "podcasts_db_unreadable", "Apple Podcasts database could not be read");

  const text = formatHealthText(healthReport([fda, podcasts]));

  expect(text).toContain("  ↳ 1 source check blocked by the issue above — fix it first.");
});

test("without a prerequisite root cause, permission findings render normally with fix/then lines", () => {
  const podcasts = permissionFinding("podcasts", "podcasts_db_unreadable", "Apple Podcasts database could not be read");
  const notes = permissionFinding("apple_notes", "apple_notes_permission", "Notes automation is not allowed");

  const text = formatHealthText(healthReport([podcasts, notes]));

  expect(text).toContain("WARN podcasts/podcasts_db_unreadable: Apple Podcasts database could not be read");
  expect(text).toContain(`  fix:  ${podcasts.guidance!.fix}`);
  expect(text).toContain(`  then: ${podcasts.guidance!.confirm}`);
  expect(text).toContain("WARN apple_notes/apple_notes_permission: Notes automation is not allowed");
  expect(text).toContain(`  fix:  ${notes.guidance!.fix}`);
  expect(text).toContain(`  then: ${notes.guidance!.confirm}`);
  expect(text).not.toContain("blocked by the issue above");
});

test("pending backfill renders the standing line with the exact import command", () => {
  const finding = permissionFinding("twitter", "twitter_example", "example problem");
  const text = formatHealthText(healthReport([finding], [backfillItem({ status: "backfill_incomplete" })]));

  expect(text).toContain("BACKFILL twitter: history import pending — when your export arrives: nutshell import twitter ~/Downloads/x-archive.zip");
});

test("completed backfill renders the complete line", () => {
  const finding = permissionFinding("twitter", "twitter_example", "example problem");
  const text = formatHealthText(
    healthReport([finding], [backfillItem({ status: "backfill_complete", bulkStatus: "complete", nextCommand: null })]),
  );

  expect(text).toContain("BACKFILL twitter: complete");
});

test("doctor resolves the x alias to twitter on the real binary", async () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-doctor-alias-"));
  try {
    // Disable every plugin so the run stays hermetic: alias resolution is what
    // is under test, not the plugins' live probes.
    writeFileSync(
      join(root, "nutconfig.jsonc"),
      `${JSON.stringify({ plugins: { youtube: { enabled: false }, podcasts: { enabled: false }, apple_notes: { enabled: false }, twitter: { enabled: false } } }, null, 2)}\n`,
    );
    const result = await runCli(["--root", root, "doctor", "x", "--json"]);
    expect(result.stderr).not.toContain("unknown source");
    expect(result.stderr).not.toContain("unknown command");
    expect([0, 1, 2]).toContain(result.exitCode);
    const report = JSON.parse(result.stdout) as { findings: unknown[] };
    expect(Array.isArray(report.findings)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("doctor with an unknown source exits nonzero and lists valid sources", async () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-doctor-unknown-"));
  try {
    const result = await runCli(["--root", root, "doctor", "nope"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("unknown source 'nope'");
    expect(result.stderr).toContain("valid sources: youtube, podcasts (podcast), apple_notes (notes), twitter (x)");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function permissionFinding(source: SourceId, code: string, message: string): HealthFinding {
  return {
    level: "warning",
    source,
    code,
    message,
    detail: {},
    observedAt: new Date("2026-06-10T08:00:00Z"),
    guidance: {
      state: "needs_permission",
      fix: `Grant the missing permission for ${source} in System Settings, then retry.`,
      confirm: `nutshell doctor ${source}`,
    },
  };
}

function healthReport(findings: HealthFinding[], backfill: BackfillHealthItem[] = []): HealthReport {
  return {
    status: findings.some((finding) => finding.level === "critical") ? "critical" : "warning",
    checkedAt: new Date("2026-06-10T08:00:00Z"),
    findings,
    backfill,
    app: {
      installed: true,
      path: "/Applications/Nutshell.app",
      executable: "/Applications/Nutshell.app/Contents/MacOS/Nutshell",
      fullDiskAccess: "granted",
      backgroundSync: "enabled",
      agent: "enabled",
      dataRoot: null,
      raw: "",
    },
    scheduler: {
      intervalSeconds: 900,
      lastRunAt: null,
      nextRunAt: null,
      lastAgentEventAt: null,
      lastAgentMessage: null,
      source: "unavailable",
    },
  };
}

function backfillItem(input: {
  status: BackfillHealthItem["status"];
  bulkStatus?: BackfillHealthItem["bulkBackfill"]["status"];
  nextCommand?: string | null;
}): BackfillHealthItem {
  return {
    source: "twitter",
    status: input.status,
    counts: {},
    targets: {},
    recentStatus: null,
    lastBackfillStatus: null,
    recent: { status: null, lastRunAt: null, completed: null, partial: null },
    bulkBackfill: {
      status: input.bulkStatus ?? "incomplete",
      reason: null,
      nextCommand: input.nextCommand === undefined ? "nutshell import twitter ~/Downloads/x-archive.zip" : input.nextCommand,
      counts: {},
      targets: {},
      detail: {},
    },
    liveBackfill: { status: "unsupported", reason: null, nextCommand: null, counts: {}, targets: {}, detail: {} },
    detail: {},
  };
}

async function runCli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  // Same subprocess pattern as test/cli-surface.test.ts, plus a hermetic env:
  // no app handoff, no real Nutshell.app, no inherited config overrides.
  const env: Record<string, string | undefined> = {
    ...process.env,
    NUTSHELL_DISABLE_APP_HANDOFF: "1",
    NUTSHELL_APP_PATH: join(tmpdir(), "nutshell-doctor-output-missing", "Nutshell.app"),
  };
  delete env.NUTSHELL_CONFIG;
  delete env.NUTSHELL_ROOT;
  const proc = Bun.spawn([process.execPath, "src/cli.ts", ...args], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { exitCode, stdout, stderr };
}
