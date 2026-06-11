import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { HealthFinding, HealthReport, SyncReport, UserState } from "../src/core/types";
import { CLI_NAME } from "../src/core/product";
import type { FindingCatalog } from "../src/health/guidance";
import { guidanceFromJson } from "../src/health/guidance";
import { SYSTEM_FINDINGS } from "../src/health/system-findings";
import { SETUP_FINDINGS } from "../src/setup/setup-findings";
import { formatHealthText } from "../src/health/reporters";
import { formatSyncText } from "../src/health/sync-reporter";
import { JsonConfigDraft, pluginSetupFindings } from "../src/setup/config-draft";
import { formatSetupSummaryText } from "../src/setup/setup-runtime";
import type { SetupReport } from "../src/setup/types";
import { loadBuiltinPlugins } from "../src/plugins/registry";

// Universal invariant (goal criteria 10 + 11): every problem finding the
// product can emit carries taxonomy state, a concrete fix, and a confirm
// command — and every surface that renders a problem finding shows them.

const USER_STATES: UserState[] = ["not_configured", "needs_auth", "needs_permission", "ready_empty", "ready_with_data", "blocked_bug"];
const SRC_ROOT = join(import.meta.dir, "..", "src");

interface CatalogEntry {
  name: string;
  catalog: FindingCatalog;
}

function allCatalogs(): CatalogEntry[] {
  const entries: CatalogEntry[] = [
    { name: "system", catalog: SYSTEM_FINDINGS },
    { name: "setup", catalog: SETUP_FINDINGS },
  ];
  for (const plugin of loadBuiltinPlugins().list()) {
    expect(plugin.findings, `${plugin.manifest.id} must expose a finding catalog`).toBeDefined();
    entries.push({ name: plugin.manifest.id, catalog: plugin.findings! });
  }
  return entries;
}

function allSamples(): HealthFinding[] {
  return allCatalogs().flatMap((entry) => entry.catalog.samples());
}

function healthReportWith(finding: HealthFinding): HealthReport {
  return {
    status: finding.level === "critical" ? "critical" : "warning",
    checkedAt: new Date(),
    findings: [finding],
    backfill: [],
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

function syncReportWith(finding: HealthFinding): SyncReport {
  const started = new Date("2026-06-10T00:00:00Z");
  const finished = new Date("2026-06-10T00:00:05Z");
  return {
    status: finding.level === "critical" ? "critical" : "warning",
    startedAt: started,
    finishedAt: finished,
    sources: [
      {
        source: finding.source === "system" ? "youtube" : finding.source,
        status: "skipped",
        startedAt: started,
        finishedAt: finished,
        durationMs: 5000,
        findings: [finding],
        metrics: {},
      },
    ],
  };
}

describe("finding catalogs", () => {
  test("every spec carries a valid state, a concrete fix, and a runnable confirm command", () => {
    for (const { name, catalog } of allCatalogs()) {
      const codes = catalog.codes();
      expect(codes.length, `${name} catalog must not be empty`).toBeGreaterThan(0);
      for (const code of codes) {
        const spec = catalog.spec(code);
        const where = `${name}/${code}`;
        expect(USER_STATES, where).toContain(spec.state);
        expect(["warning", "critical"], where).toContain(spec.level);
        expect(spec.fix.trim().length, `${where} fix must name a concrete action`).toBeGreaterThanOrEqual(20);
        expect(spec.fix.toLowerCase(), where).not.toContain("see docs");
        expect(spec.fix.toLowerCase(), where).not.toContain("refer to the documentation");
        expect(spec.confirm.startsWith(CLI_NAME), `${where} confirm must be a runnable ${CLI_NAME} command, got: ${spec.confirm}`).toBe(true);
        expect(spec.sample.trim().length, `${where} sample message required`).toBeGreaterThan(0);
        if (spec.url) {
          const allowed = spec.url.startsWith("https://") || spec.url.startsWith("x-apple.systempreferences:");
          expect(allowed, `${where} url must be https or a macOS System Settings deep link`).toBe(true);
        }
      }
    }
  });

  test("codes are unique across all catalogs", () => {
    const seen = new Map<string, string>();
    for (const { name, catalog } of allCatalogs()) {
      for (const code of catalog.codes()) {
        const existing = seen.get(code);
        // plugin_setup_degraded-style specs may intentionally exist in exactly
        // one catalog; duplicates across catalogs would let fix text diverge.
        expect(existing, `code ${code} defined in both ${existing} and ${name}`).toBeUndefined();
        seen.set(code, name);
      }
    }
  });

  test("make() attaches guidance derived from the spec", () => {
    for (const { catalog } of allCatalogs()) {
      for (const code of catalog.codes()) {
        const finding = catalog.make(code, "example message", { extra: 1 });
        expect(finding.guidance?.state).toBe(catalog.spec(code).state);
        expect(finding.guidance?.fix).toBe(catalog.spec(code).fix);
        expect(finding.guidance?.confirm).toBe(catalog.spec(code).confirm);
      }
    }
  });
});

describe("every surface renders fix and confirm for every emittable problem finding", () => {
  test("health/doctor text", () => {
    for (const finding of allSamples()) {
      const text = formatHealthText(healthReportWith(finding));
      expect(text, `health text for ${finding.code}`).toContain(finding.guidance!.fix);
      expect(text, `health text for ${finding.code}`).toContain(finding.guidance!.confirm);
    }
  });

  test("sync text", () => {
    for (const finding of allSamples()) {
      const text = formatSyncText(syncReportWith(finding));
      expect(text, `sync text for ${finding.code}`).toContain(finding.guidance!.fix);
      expect(text, `sync text for ${finding.code}`).toContain(finding.guidance!.confirm);
    }
  });

  test("setup summary", () => {
    for (const finding of allSamples()) {
      const report: SetupReport = {
        status: "warning",
        startedAt: new Date(),
        finishedAt: new Date(),
        plugins: [
          {
            source: finding.source === "system" ? "youtube" : finding.source,
            displayName: "Example Source",
            status: "degraded",
            findings: [finding],
            archiveImport: "unavailable",
            importCommand: null,
          },
        ],
        backgroundAgent: { attempted: false, ok: true, message: "skipped", detail: {} },
        syncHandoff: { attempted: false, ok: true, message: "skipped", detail: {} },
      };
      const text = formatSetupSummaryText(report);
      expect(text, `setup summary for ${finding.code}`).toContain(finding.guidance!.fix);
      expect(text, `setup summary for ${finding.code}`).toContain(finding.guidance!.confirm);
    }
  });

  test("dashboard payload preserves guidance through JSON serialization", () => {
    for (const finding of allSamples()) {
      const roundTripped = JSON.parse(JSON.stringify(finding)) as { guidance?: { state?: string; fix?: string; confirm?: string } };
      expect(roundTripped.guidance?.fix, finding.code).toBe(finding.guidance!.fix);
      expect(roundTripped.guidance?.confirm, finding.code).toBe(finding.guidance!.confirm);
    }
  });

  test("dashboard frontend renders guidance fix and confirm", () => {
    const serverSource = readFileSync(join(SRC_ROOT, "dashboard", "server.ts"), "utf8");
    expect(serverSource).toContain("guidance.fix");
    expect(serverSource).toContain("guidance.confirm");
  });

  test("setup config persistence round-trips guidance", () => {
    for (const finding of allSamples()) {
      const draft = new JsonConfigDraft({ root: "/tmp/x", path: "/tmp/x/nutconfig.jsonc", data: {} });
      draft.setPluginSetupStatus("youtube", "degraded", [finding]);
      const stored = pluginSetupFindings({ root: draft.root, path: draft.path, data: draft.data }, "youtube");
      expect(stored.length, finding.code).toBe(1);
      const restored = guidanceFromJson(stored[0]!.guidance ?? null);
      expect(restored?.fix, finding.code).toBe(finding.guidance!.fix);
      expect(restored?.confirm, finding.code).toBe(finding.guidance!.confirm);
      expect(restored?.state, finding.code).toBe(finding.guidance!.state);
    }
  });
});

describe("finding construction is catalog-only", () => {
  // Raw finding()/makeFinding() construction outside these reviewed modules
  // bypasses guidance and the invariant above — new problem findings must be
  // registered in a catalog instead.
  const ALLOWED = new Set([
    "health/health.ts",
    "health/guidance.ts",
    "health/system-findings.ts",
    "setup/setup-findings.ts",
    "plugins/interface.ts",
  ]);

  test("no raw finding construction outside catalog modules", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC_ROOT)) {
      const rel = relative(SRC_ROOT, file).replaceAll("\\", "/");
      if (ALLOWED.has(rel)) continue;
      if (rel.startsWith("testing/")) continue;
      if (rel.endsWith("/findings.ts")) continue;
      const text = readFileSync(file, "utf8");
      if (/\b(makeFinding|finding)\(/.test(text)) offenders.push(rel);
    }
    expect(offenders, `register these findings in a catalog instead of raw construction: ${offenders.join(", ")}`).toEqual([]);
  });
});

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) files.push(...walk(path));
    else if (path.endsWith(".ts")) files.push(path);
  }
  return files;
}
