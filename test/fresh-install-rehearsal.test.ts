import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  auditRehearsalReport,
  classifySourceState,
  podcastSnapshotManifestPath,
  prepareFreshInstallReportPath,
  snapshotPodcastDatabase,
  verifyAuthenticatedBrowserState,
  verifyCleanState,
  verifyFinalReleaseState,
  verifyHostPreflight,
  verifyUnauthenticatedBrowserState,
  type CommandResult,
  type RehearsalReport,
} from "../src/release/fresh-install-rehearsal";
import type { HealthFinding, HealthReport, SourceId } from "../src/core/types";

test("clean-state verifier fails on reused local Nutshell state", async () => {
  const home = mkdtempSync(join(tmpdir(), "nutshell-rehearsal-clean-"));
  try {
    mkdirSync(join(home, "Nutshell"));
    writeFileSync(join(home, "nutconfig.jsonc"), "{}");
    const report = await verifyCleanState({
      paths: {
        home,
        configPath: join(home, "nutconfig.jsonc"),
        root: join(home, "Nutshell"),
        appPaths: [join(home, "Applications", "Nutshell.app")],
        launchAgentPlist: join(home, "Library", "LaunchAgents", "com.winterfell.nutshell.agent.plist"),
        homebrewCellarCandidates: [join(home, "Cellar", "nutshell")],
      },
      resetPrivacy: true,
      cookieProbe: {
        x: async () => ({ cookies: [], warnings: [] }),
        google: async () => ({ cookies: [], warnings: [] }),
      },
      runner: async (command) => cleanRunner(command),
      env: { HOME: home, PATH: "/usr/bin:/bin" },
    });

    expect(report.status).toBe("fail");
    expect(report.checks.find((check) => check.name === "Nutshell config absent")?.status).toBe("fail");
    expect(report.checks.find((check) => check.name === "Nutshell data root absent")?.status).toBe("fail");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("clean-state verifier rejects leftover browser auth cookies", async () => {
  const home = mkdtempSync(join(tmpdir(), "nutshell-rehearsal-auth-"));
  try {
    const report = await verifyCleanState({
      paths: {
        home,
        configPath: join(home, "nutconfig.jsonc"),
        root: join(home, "Nutshell"),
        appPaths: [join(home, "Applications", "Nutshell.app")],
        launchAgentPlist: join(home, "Library", "LaunchAgents", "com.winterfell.nutshell.agent.plist"),
        homebrewCellarCandidates: [join(home, "Cellar", "nutshell")],
      },
      resetPrivacy: true,
      cookieProbe: {
        x: async () => ({ cookies: ["auth_token", "ct0"], warnings: [] }),
        google: async () => ({ cookies: [], warnings: [] }),
      },
      runner: async (command) => cleanRunner(command),
      env: { HOME: home, PATH: "/usr/bin:/bin" },
    });

    expect(report.status).toBe("fail");
    expect(report.checks.find((check) => check.name === "X browser auth absent")?.status).toBe("fail");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("clean-state verifier rejects stale Nutshell launch agent plists", async () => {
  const home = mkdtempSync(join(tmpdir(), "nutshell-rehearsal-agent-"));
  try {
    const launchAgents = join(home, "Library", "LaunchAgents");
    mkdirSync(launchAgents, { recursive: true });
    writeFileSync(join(launchAgents, "com.example.old-nutshell-agent.plist"), "<plist />");
    const report = await verifyCleanState({
      paths: {
        home,
        configPath: join(home, "nutconfig.jsonc"),
        root: join(home, "Nutshell"),
        appPaths: [join(home, "Applications", "Nutshell.app")],
        launchAgentPlist: join(launchAgents, "com.winterfell.nutshell.agent.plist"),
        homebrewCellarCandidates: [join(home, "Cellar", "nutshell")],
      },
      resetPrivacy: true,
      cookieProbe: {
        x: async () => ({ cookies: [], warnings: [] }),
        google: async () => ({ cookies: [], warnings: [] }),
      },
      runner: async (command) => cleanRunner(command),
      env: { HOME: home, PATH: "/usr/bin:/bin" },
    });

    expect(report.status).toBe("fail");
    expect(report.checks.find((check) => check.name === "No stale Nutshell launch agent plists")?.status).toBe("fail");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("clean-state verifier treats missing Full Disk Access bundle as clean", async () => {
  const home = mkdtempSync(join(tmpdir(), "nutshell-rehearsal-tcc-"));
  try {
    const report = await verifyCleanState({
      paths: {
        home,
        configPath: join(home, "nutconfig.jsonc"),
        root: join(home, "Nutshell"),
        appPaths: [join(home, "Applications", "Nutshell.app")],
        launchAgentPlist: join(home, "Library", "LaunchAgents", "com.winterfell.nutshell.agent.plist"),
        homebrewCellarCandidates: [join(home, "Cellar", "nutshell")],
      },
      resetPrivacy: true,
      cookieProbe: {
        x: async () => ({ cookies: [], warnings: [] }),
        google: async () => ({ cookies: [], warnings: [] }),
      },
      runner: async (command) =>
        command[0] === "tccutil"
          ? commandResult(1, "", 'tccutil: No such bundle identifier "com.winterfell.nutshell"')
          : cleanRunner(command),
      env: { HOME: home, PATH: "/usr/bin:/bin" },
    });

    const check = report.checks.find((item) => item.name === "Full Disk Access grant reset");
    expect(check?.status).toBe("pass");
    expect(check?.detail.noExistingGrant).toBe(true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("unauthenticated verifier requires source-specific auth failures", async () => {
  const report = await verifyUnauthenticatedBrowserState({
    runner: async () => commandResult(
      2,
      JSON.stringify({
        status: "critical",
        checkedAt: "2026-05-28T00:00:00.000Z",
        findings: [
          {
            level: "critical",
            source: "youtube",
            code: "plugin_setup_degraded",
            message: "generic degraded setup",
            detail: {},
            observedAt: "2026-05-28T00:00:00.000Z",
          },
        ],
      }),
    ),
    env: { HOME: "/tmp", PATH: "/usr/bin:/bin" },
  });

  expect(report.status).toBe("fail");
  expect(report.checks.find((check) => check.name === "youtube signed-out state is explicit")?.status).toBe("fail");
  expect(report.checks.find((check) => check.name === "twitter signed-out state is explicit")?.status).toBe("fail");
});

test("authenticated verifier classifies cookies plus keychain timeout as product bug", async () => {
  const report = await verifyAuthenticatedBrowserState({
    cookieProbe: {
      google: async () => ({ cookies: ["SID"], warnings: ["Chrome Safe Storage keychain read timed out"] }),
      x: async () => ({ cookies: ["auth_token", "ct0"], warnings: [] }),
    },
    runner: async (command) => {
      const source = command.includes("youtube") ? "youtube" : "twitter";
      return commandResult(
        2,
        JSON.stringify({
          status: "critical",
          checkedAt: "2026-05-28T00:00:00.000Z",
          findings: [
            {
              level: "critical",
              source,
              code: source === "youtube" ? "youtube_auth_probe_failed" : "twitter_auth",
              message: `${source} browser session check failed`,
              detail: { error: "Chrome Safe Storage keychain read timed out" },
              observedAt: "2026-05-28T00:00:00.000Z",
            },
          ],
        }),
      );
    },
    env: { HOME: "/tmp", PATH: "/usr/bin:/bin" },
  });

  expect(report.status).toBe("fail");
  expect(report.contract.observedState).toBe("blocked_bug");
  expect(report.evidence.youtubeState).toBe("blocked_bug");
  expect(report.checks.find((check) => check.name === "Google/YouTube browser auth cookies present after login")?.detail.observedState).toBe("blocked_bug");
});

test("authenticated verifier classifies unreadable cookies plus keychain timeout as product bug", async () => {
  const report = await verifyAuthenticatedBrowserState({
    cookieProbe: {
      google: async () => ({ cookies: [], warnings: ["Failed to read macOS Keychain (Chrome Safe Storage): Timed out after 30000ms"] }),
      x: async () => ({ cookies: [], warnings: ["Failed to read macOS Keychain (Chrome Safe Storage): Timed out after 30000ms"] }),
    },
    runner: async (command) => {
      const source = command.includes("youtube") ? "youtube" : "twitter";
      return commandResult(
        2,
        JSON.stringify({
          status: "critical",
          checkedAt: "2026-05-28T00:00:00.000Z",
          findings: [
            {
              level: "critical",
              source,
              code: source === "youtube" ? "youtube_auth_probe_failed" : "twitter_auth",
              message: `${source} browser session check failed`,
              detail: { error: "Timed out after 30000ms reading Chrome Safe Storage" },
              observedAt: "2026-05-28T00:00:00.000Z",
            },
          ],
        }),
      );
    },
    env: { HOME: "/tmp", PATH: "/usr/bin:/bin" },
  });

  expect(report.status).toBe("fail");
  expect(report.contract.observedState).toBe("blocked_bug");
  expect(report.contract.blockerKind).toBe("product_bug");
  expect(report.evidence.youtubeState).toBe("blocked_bug");
  expect(report.evidence.twitterState).toBe("blocked_bug");
});

test("source-state classifier separates auth permission empty data and records", () => {
  expect(classifySourceState({ health: null, source: "youtube" })).toBe("blocked_bug");
  expect(classifySourceState({ health: healthReport("critical", [finding("youtube", "youtube_auth", "sign in required")]), source: "youtube" })).toBe("needs_auth");
  expect(classifySourceState({ health: healthReport("critical", [finding("apple_notes", "apple_notes_permission", "Not authorized to send Apple events")]), source: "apple_notes" })).toBe("needs_permission");
  expect(classifySourceState({ health: healthReport("ok", []), source: "youtube" })).toBe("ready_empty");
  expect(classifySourceState({ health: healthReport("critical", [finding("youtube", "youtube_auth_probe_failed", "Chrome Safe Storage keychain read timed out")]), source: "youtube", browserCookies: ["SID"] })).toBe("blocked_bug");
  expect(classifySourceState({ health: healthReport("critical", [finding("youtube", "youtube_auth_probe_failed", "Chrome Safe Storage keychain read timed out")]), source: "youtube", browserCookies: [] })).toBe("blocked_bug");
  expect(classifySourceState({ health: healthReport("critical", []), source: "youtube", recordCount: 1 })).toBe("ready_with_data");
});

test("podcast snapshot uses SQLite and produces a readable copy", () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-podcast-snapshot-"));
  try {
    const source = join(root, "source.sqlite");
    const destination = join(root, "seed", "MTLibrary.sqlite");
    const db = new Database(source);
    db.exec("create table sample(id integer primary key, value text)");
    db.query("insert into sample(value) values (?)").run("listened");
    db.close();

    const report = snapshotPodcastDatabase({ source, destination });

    expect(report.method).toBe("sqlite_vacuum_into");
    expect(existsSync(destination)).toBe(true);
    expect(existsSync(podcastSnapshotManifestPath(destination))).toBe(true);
    const copy = new Database(destination, { readonly: true, create: false });
    try {
      expect((copy.query("select value from sample").get() as { value: string }).value).toBe("listened");
    } finally {
      copy.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("host preflight passes when the release rehearsal inputs are present", async () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-host-preflight-pass-"));
  try {
    const xArchive = join(root, "twitter.zip");
    const youtubeExport = join(root, "google.zip");
    const podcastsSource = join(root, "source-MTLibrary.sqlite");
    const podcastsSeed = join(root, "MTLibrary.sqlite");
    writeFileSync(xArchive, "x");
    writeFileSync(youtubeExport, "youtube");
    const db = new Database(podcastsSource);
    db.exec("create table sample(id integer primary key)");
    db.close();
    snapshotPodcastDatabase({ source: podcastsSource, destination: podcastsSeed });

    const report = await verifyHostPreflight({
      xArchive,
      youtubeExport,
      podcastsSeed,
      diskPath: root,
      minFreeBytes: 1,
      platform: "darwin",
      runner: async (command) => {
        const text = command.join(" ");
        if (text.includes("command -v brew")) return commandResult(0, "/opt/homebrew/bin/brew\n");
        if (text.includes("command -v tart")) return commandResult(0, "/opt/homebrew/bin/tart\n");
        return commandResult(1);
      },
    });

    expect(report.status).toBe("pass");
    expect(report.checks.find((check) => check.name === "official Google/YouTube export is available")?.status).toBe("pass");
    expect(report.checks.find((check) => check.name === "Apple Podcasts seed passes SQLite quick_check")?.status).toBe("pass");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("host preflight fails before a rehearsal when required host inputs are missing", async () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-host-preflight-fail-"));
  try {
    const xArchive = join(root, "twitter.zip");
    const podcastsSeed = join(root, "MTLibrary.sqlite");
    writeFileSync(xArchive, "x");
    const db = new Database(podcastsSeed);
    db.exec("create table sample(id integer primary key)");
    db.close();

    const report = await verifyHostPreflight({
      xArchive,
      youtubeExport: join(root, "missing-google.zip"),
      podcastsSeed,
      diskPath: root,
      minFreeBytes: Number.MAX_SAFE_INTEGER,
      platform: "darwin",
      runner: async (command) => {
        const text = command.join(" ");
        if (text.includes("command -v brew")) return commandResult(0, "/opt/homebrew/bin/brew\n");
        return commandResult(1);
      },
    });

    expect(report.status).toBe("fail");
    expect(report.checks.find((check) => check.name === "host has enough free disk for a VM rehearsal")?.status).toBe("fail");
    expect(report.checks.find((check) => check.name === "disposable macOS VM manager is available")?.status).toBe("fail");
    expect(report.checks.find((check) => check.name === "official Google/YouTube export is available")?.status).toBe("fail");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("final verifier fails when scheduler times are unknown or a source has no records", async () => {
  const home = mkdtempSync(join(tmpdir(), "nutshell-final-rehearsal-"));
  try {
    const root = join(home, "Nutshell");
    mkdirSync(root, { recursive: true });
    const configPath = join(home, "nutconfig.jsonc");
    writeFileSync(
      configPath,
      JSON.stringify({
        storage: { root },
        app: { path: join(home, "Applications", "Nutshell.app") },
        plugins: {
          youtube: { enabled: true },
          podcasts: { enabled: true },
          apple_notes: { enabled: true },
          twitter: { enabled: true },
        },
      }),
    );
    const store = new Database(join(root, "nutshell.sqlite"));
    store.exec("create table records(source text not null, type text not null, happened_at text)");
    store.query("insert into records(source, type, happened_at) values (?, ?, ?)").run("youtube", "youtube.watched", "2026-05-28T00:00:00.000Z");
    store.close();

    const report = await verifyFinalReleaseState({
      env: { HOME: home, NUTSHELL_CONFIG: configPath, NUTSHELL_ROOT: root, PATH: "/usr/bin:/bin" },
      startDashboard: false,
      runner: async () => ({
        code: 0,
        stdout: JSON.stringify({
          status: "ok",
          findings: [],
          app: { installed: true, fullDiskAccess: "granted", backgroundSync: "enabled", agent: "enabled" },
          scheduler: { lastRunAt: null, nextRunAt: null },
        }),
        stderr: "",
        timedOut: false,
      }),
    });

    expect(report.status).toBe("fail");
    expect(report.checks.find((check) => check.name === "scheduler has known last and next sync")?.status).toBe("fail");
    expect(report.checks.find((check) => check.name === "podcasts produced canonical records")?.status).toBe("fail");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("final verifier rejects warning health even when required records exist", async () => {
  const home = mkdtempSync(join(tmpdir(), "nutshell-final-health-"));
  try {
    const { root, configPath } = writeTestConfig(home);
    const store = new Database(join(root, "nutshell.sqlite"));
    store.exec("create table records(source text not null, type text not null, happened_at text)");
    const requiredRows: Array<[string, string]> = [
      ["youtube", "youtube.watched"],
      ["podcasts", "podcast.listened"],
      ["apple_notes", "apple_note"],
      ["twitter", "twitter.authored"],
    ];
    for (const [source, type] of requiredRows) {
      store.query("insert into records(source, type, happened_at) values (?, ?, ?)").run(source, type, "2026-05-28T00:00:00.000Z");
    }
    store.close();

    const report = await verifyFinalReleaseState({
      env: { HOME: home, NUTSHELL_CONFIG: configPath, NUTSHELL_ROOT: root, PATH: "/usr/bin:/bin" },
      startDashboard: false,
      runner: async () => ({
        code: 0,
        stdout: JSON.stringify({
          status: "warning",
          findings: [{ level: "warning", source: "youtube", code: "youtube_auth", message: "auth warning", detail: {}, observedAt: "2026-05-28T00:00:00.000Z" }],
          app: { installed: true, fullDiskAccess: "granted", backgroundSync: "enabled", agent: "enabled" },
          scheduler: { lastRunAt: "2026-05-28T00:00:00.000Z", nextRunAt: "2026-05-28T00:15:00.000Z" },
        }),
        stderr: "",
        timedOut: false,
      }),
    });

    expect(report.status).toBe("fail");
    expect(report.checks.find((check) => check.name === "final health is clean and app-owned background sync is active")?.status).toBe("fail");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("aggregate report audit fails when a required phase is missing", () => {
  const report = auditRehearsalReport({ runs: requiredAggregateReports().filter((run) => run.phase !== "background-sync") });

  expect(report.status).toBe("fail");
  expect(report.checks.find((check) => check.name === "required phase passed: background-sync")?.status).toBe("fail");
});

test("aggregate report audit fails when final dashboard proof is incomplete", () => {
  const runs = requiredAggregateReports();
  const final = runs.find((run) => run.phase === "final-release-state");
  if (!final) throw new Error("test fixture missing final-release-state");
  final.checks = final.checks.filter((check) => check.name !== "dashboard shows twitter trace records");

  const report = auditRehearsalReport({ runs });

  expect(report.status).toBe("fail");
  expect(report.checks.find((check) => check.name === "required check passed: dashboard shows twitter trace records")?.status).toBe("fail");
});

test("aggregate report audit fails when provider import proof is incomplete", () => {
  const runs = requiredAggregateReports();
  const imports = runs.find((run) => run.phase === "provider-archive-imports");
  if (!imports) throw new Error("test fixture missing provider-archive-imports");
  imports.checks = imports.checks.filter((check) => check.name !== "youtube official provider archive imports");

  const report = auditRehearsalReport({ runs });

  expect(report.status).toBe("fail");
  expect(report.checks.find((check) => check.name === "required check passed: youtube official provider archive imports")?.status).toBe("fail");
});

test("aggregate report audit rejects browser login before setup", () => {
  const runs = requiredAggregateReports();
  const setupIndex = runs.findIndex((run) => run.phase === "setup-flow");
  const loginIndex = runs.findIndex((run) => run.phase === "browser-login-handoff");
  if (setupIndex === -1 || loginIndex === -1) throw new Error("test fixture missing setup or login phase");
  const [setup] = runs.splice(setupIndex, 1);
  const adjustedLoginIndex = runs.findIndex((run) => run.phase === "browser-login-handoff");
  runs.splice(adjustedLoginIndex + 1, 0, setup!);

  const report = auditRehearsalReport({ runs });

  expect(report.status).toBe("fail");
  expect(report.checks.find((check) => check.name === "required phases appear in release-flow order")?.status).toBe("fail");
});

test("aggregate report audit rejects diagnostic actions as release proof", () => {
  const runs = requiredAggregateReports();
  const final = runs.find((run) => run.phase === "final-release-state");
  if (!final) throw new Error("test fixture missing final-release-state");
  final.contract.diagnosticAction = "Manually queried the store to prove data exists.";
  final.contract.pass = false;
  final.contract.blockerKind = "diagnostic_only";

  const report = auditRehearsalReport({ runs });

  expect(report.status).toBe("fail");
  expect(report.checks.find((check) => check.name === "no phase uses blockers or diagnostic actions as release proof")?.status).toBe("fail");
});

test("aggregate report audit rejects skipped checks in a final report", () => {
  const runs = requiredAggregateReports();
  const imports = runs.find((run) => run.phase === "provider-archive-imports");
  if (!imports) throw new Error("test fixture missing provider-archive-imports");
  const youtubeImport = imports.checks.find((check) => check.name === "youtube official provider archive imports");
  if (!youtubeImport) throw new Error("test fixture missing youtube import check");
  youtubeImport.status = "skip";

  const report = auditRehearsalReport({ runs });

  expect(report.status).toBe("fail");
  expect(report.checks.find((check) => check.name === "no manual skipped or failed checks are counted in final report")?.status).toBe("fail");
});

test("aggregate report audit fails when podcast seed staging proof is incomplete", () => {
  const runs = requiredAggregateReports();
  const stage = runs.find((run) => run.phase === "stage-podcast-seed");
  if (!stage) throw new Error("test fixture missing stage-podcast-seed");
  stage.checks = stage.checks.filter((check) => check.name !== "Apple Podcasts seed has SQLite-safe snapshot provenance");

  const report = auditRehearsalReport({ runs });

  expect(report.status).toBe("fail");
  expect(report.checks.find((check) => check.name === "required check passed: Apple Podcasts seed has SQLite-safe snapshot provenance")?.status).toBe("fail");
});

test("aggregate report audit fails when release identity evidence is missing", () => {
  const runs = requiredAggregateReports();
  const start = runs.find((run) => run.phase === "start");
  if (!start) throw new Error("test fixture missing start");
  delete start.evidence.releaseId;

  const report = auditRehearsalReport({ runs });

  expect(report.status).toBe("fail");
  expect(report.checks.find((check) => check.name === "release report records the release identifier")?.status).toBe("fail");
});

test("aggregate report audit fails when final health JSON evidence is missing", () => {
  const runs = requiredAggregateReports();
  const final = runs.find((run) => run.phase === "final-release-state");
  if (!final) throw new Error("test fixture missing final-release-state");
  delete final.evidence.health;

  const report = auditRehearsalReport({ runs });

  expect(report.status).toBe("fail");
  expect(report.checks.find((check) => check.name === "final report records full health JSON")?.status).toBe("fail");
});

test("aggregate report audit fails when installed app path evidence is missing", () => {
  const runs = requiredAggregateReports();
  const final = runs.find((run) => run.phase === "final-release-state");
  if (!final) throw new Error("test fixture missing final-release-state");
  const health = final.evidence.health as { app?: { path?: string } };
  if (health.app) delete health.app.path;

  const report = auditRehearsalReport({ runs });

  expect(report.status).toBe("fail");
  expect(report.checks.find((check) => check.name === "final report records the installed app path")?.status).toBe("fail");
});

test("aggregate report audit passes only when every release rehearsal proof is present", () => {
  const report = auditRehearsalReport({ runs: requiredAggregateReports() });

  expect(report.status).toBe("pass");
  expect(report.checks.every((check) => check.status === "pass")).toBe(true);
});

test("full rehearsal runner refuses to mix a new attempt into an existing report", () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-existing-report-"));
  try {
    const reportPath = join(root, "fresh-install-report.json");
    writeFileSync(reportPath, JSON.stringify({ runs: [fakeReport("clean-state", ["clean-state"])] }));

    expect(() => prepareFreshInstallReportPath(reportPath, false)).toThrow("Fresh-install report already exists");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function cleanRunner(command: string[]): Promise<CommandResult> {
  const text = command.join(" ");
  if (text.includes("command -v nutshell")) return { code: 1, stdout: "", stderr: "", timedOut: false };
  if (command[0] === "launchctl" && command.length === 3 && /^gui\/\d+$/.test(command[2] ?? "")) {
    return { code: 0, stdout: "services = {\n}\n", stderr: "", timedOut: false };
  }
  if (command[0] === "launchctl") return { code: 113, stdout: "", stderr: "not found", timedOut: false };
  if (command[0] === "tccutil") return { code: 0, stdout: "", stderr: "", timedOut: false };
  return { code: 0, stdout: "", stderr: "", timedOut: false };
}

function commandResult(code: number, stdout = "", stderr = ""): CommandResult {
  return { code, stdout, stderr, timedOut: false };
}

function writeTestConfig(home: string): { root: string; configPath: string } {
  const root = join(home, "Nutshell");
  mkdirSync(root, { recursive: true });
  const configPath = join(home, "nutconfig.jsonc");
  writeFileSync(
    configPath,
    JSON.stringify({
      storage: { root },
      app: { path: join(home, "Applications", "Nutshell.app") },
      plugins: {
        youtube: { enabled: true },
        podcasts: { enabled: true },
        apple_notes: { enabled: true },
        twitter: { enabled: true },
      },
    }),
  );
  return { root, configPath };
}

function requiredAggregateReports(): RehearsalReport[] {
  return [
    fakeReport("start", ["start"]),
    fakeReport("local-release-checks", [
      "bun run typecheck",
      "bun test",
      "bun run lint",
      "bun run build:compile",
      "bun run certify:release",
    ]),
    fakeReport("clean-state", [
      "nutshell command absent from PATH",
      "Nutshell config absent",
      "Nutshell data root absent",
      "Nutshell.app absent at /Applications/Nutshell.app",
      "Homebrew Cellar install absent at /opt/homebrew/Cellar/nutshell",
      "Nutshell launch agent plist absent",
      "No stale Nutshell launch agent plists",
      "Nutshell launch agent unloaded",
      "Full Disk Access grant reset",
      "X browser auth absent",
      "Google/YouTube browser auth absent",
    ]),
    fakeReport("published-install", [
      "install command uses a published user-facing source",
      "published install command succeeds",
      "installed nutshell is on PATH",
      "installed version matches release",
    ]),
    fakeReport("installed-product", [
      "installed nutshell command is on PATH",
      "installed nutshell version",
      "installed nutshell help",
      "installed health command returns JSON",
      "installed app is visible to health",
    ]),
    fakeReport("pre-permission-app-state", [
      "installed app status is readable",
      "installed app does not reuse an old Full Disk Access grant",
    ]),
    fakeReport("unauthenticated-browser-state", [
      "youtube signed-out state is explicit",
      "twitter signed-out state is explicit",
    ]),
    fakeReport("setup-flow", [
      "nutshell setup completes",
      "Full Disk Access is granted to Nutshell.app",
      "background sync is enabled",
      "background agent is enabled",
      "loaded background agent target is app-owned",
      "loaded background agent target is not raw CLI",
    ]),
    fakeReport("browser-login-handoff", ["browser-login-handoff"]),
    fakeReport("authenticated-browser-state", [
      "Google/YouTube browser auth cookies present after login",
      "youtube auth state is usable",
      "X browser auth cookies present after login",
      "twitter auth state is usable",
    ]),
    fakeReport("stage-podcast-seed", [
      "Apple Podcasts seed exists",
      "Apple Podcasts seed has SQLite-safe snapshot provenance",
      "Apple Podcasts seed staged at normal plugin path",
    ]),
    fakeReport("provider-archive-imports", [
      "twitter official provider archive imports",
      "youtube official provider archive imports",
    ]),
    fakeReport("apple-notes-handoff", ["apple-notes-handoff"]),
    fakeReport("foreground-sync", [
      "foreground sync completes",
      "foreground sync proves live youtube ingestion",
      "foreground sync proves live podcasts ingestion",
      "foreground sync proves live apple_notes ingestion",
      "foreground sync proves live twitter ingestion",
    ]),
    fakeReport("background-sync", ["background-sync"]),
    fakeReport("final-release-state", [
      "final health command returns JSON",
      "final health is clean and app-owned background sync is active",
      "scheduler has known last and next sync",
      "youtube produced canonical records",
      "podcasts produced canonical records",
      "apple_notes produced canonical records",
      "twitter produced canonical records",
      "YouTube activity produced the expected record type",
      "Apple Podcasts listen produced the expected record type",
      "Apple Notes note produced the expected record type",
      "Twitter/X activity produced the expected record type",
      "dashboard page HTML loads from installed command",
      "dashboard status API serves installed product",
      "dashboard days API shows trace records",
      "dashboard shows youtube trace records",
      "dashboard shows podcasts trace records",
      "dashboard shows apple_notes trace records",
      "dashboard shows twitter trace records",
    ]),
    fakeReport("complete", ["complete"]),
  ];
}

function fakeReport(phase: string, checkNames: string[]): RehearsalReport {
  return {
    generatedAt: "2026-05-28T00:00:00.000Z",
    phase,
    status: "pass",
    contract: {
      userStory: "test fixture",
      expectedState: "ready_with_data",
      observedState: "ready_with_data",
      source: "all",
      pass: true,
      blockerKind: "none",
      diagnosticAction: null,
    },
    checks: checkNames.map((name) => ({ name, status: "pass", detail: {} })),
    evidence: evidenceForPhase(phase),
  };
}

function healthReport(status: HealthReport["status"], findings: HealthFinding[]): HealthReport {
  return {
    status,
    findings,
    checkedAt: new Date("2026-05-28T00:00:00.000Z"),
    app: { installed: true, path: "/Applications/Nutshell.app", executable: "", fullDiskAccess: "granted", backgroundSync: "enabled", agent: "enabled", dataRoot: null, raw: "" },
    scheduler: { intervalSeconds: 900, lastRunAt: null, nextRunAt: null, lastAgentEventAt: null, lastAgentMessage: null, source: "unavailable" },
    backfill: [],
  };
}

function finding(source: SourceId, code: string, message: string): HealthFinding {
  return {
    level: "critical",
    source,
    code,
    message,
    detail: {},
    observedAt: new Date("2026-05-28T00:00:00.000Z"),
  };
}

function evidenceForPhase(phase: string): RehearsalReport["evidence"] {
  if (phase === "start") {
    return {
      installCommand: "brew install androidStern/nutshell/nutshell",
      installSource: "androidStern/nutshell/nutshell",
      releaseId: "v0.1.7",
    };
  }
  if (phase === "published-install") {
    return {
      installCommand: "brew install androidStern/nutshell/nutshell",
      installSource: "androidStern/nutshell/nutshell",
      releaseId: "v0.1.7",
      installedCommandPath: "/opt/homebrew/bin/nutshell",
      installedVersion: "nutshell 0.1.7",
    };
  }
  if (phase === "setup-flow") {
    return {
      bundleId: "com.winterfell.nutshell",
      appStatus: "Full Disk Access: granted\nBackground sync: enabled\nAgent status: enabled",
      launchAgent: {
        raw: "program = /Applications/Nutshell.app/Contents/Library/LaunchServices/NutshellAgent",
      },
    };
  }
  if (phase === "final-release-state") {
    return {
      health: {
        status: "ok",
        findings: [],
        app: { installed: true, path: "/Applications/Nutshell.app", fullDiskAccess: "granted", backgroundSync: "enabled", agent: "enabled" },
        scheduler: { lastRunAt: "2026-05-28T00:00:00.000Z", nextRunAt: "2026-05-28T00:15:00.000Z" },
      },
      recordCounts: { youtube: 1, podcasts: 1, apple_notes: 1, twitter: 1 },
      logPaths: { rootLogs: "/Users/test/Nutshell/logs" },
      dashboard: { url: "http://127.0.0.1:51234/" },
    };
  }
  return {};
}
