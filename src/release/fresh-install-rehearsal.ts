import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, statfsSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { readBrowserCookies } from "../browser/cookies";
import { loadConfig, resolveConfigPath, resolveRoot, storePath } from "../config/config";
import { CONFIG_ENV, ROOT_ENV } from "../core/product";
import type { HealthReport, JsonObject, SourceId } from "../core/types";

export type RehearsalStatus = "pass" | "fail" | "manual" | "skip";
export type RehearsalSourceState =
  | "not_configured"
  | "needs_auth"
  | "needs_permission"
  | "ready_empty"
  | "ready_with_data"
  | "blocked_bug";
export type RehearsalBlockerKind =
  | "none"
  | "auth"
  | "permission"
  | "missing_input"
  | "product_bug"
  | "release_process"
  | "diagnostic_only";

export interface RehearsalContract {
  userStory: string;
  expectedState: RehearsalSourceState | "clean_baseline" | "installed" | "handoff" | "complete";
  observedState: RehearsalSourceState | "clean_baseline" | "installed" | "handoff" | "complete";
  source: SourceId | "system" | "all" | null;
  pass: boolean;
  blockerKind: RehearsalBlockerKind;
  diagnosticAction?: string | null;
}

export interface RehearsalCheck {
  name: string;
  status: RehearsalStatus;
  detail: JsonObject;
}

export interface RehearsalReport {
  generatedAt: string;
  phase: string;
  status: "pass" | "fail";
  contract: RehearsalContract;
  checks: RehearsalCheck[];
  evidence: JsonObject;
}

interface PodcastSnapshotManifest {
  version: 1;
  kind: "nutshell-podcast-snapshot";
  method: "sqlite_vacuum_into";
  source: string;
  destination: string;
  sourceBytes: number;
  destinationBytes: number;
  createdAt: string;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type CommandRunner = (command: string[], options?: { env?: Record<string, string>; timeoutMs?: number; cwd?: string }) => Promise<CommandResult>;

export interface RehearsalPaths {
  home: string;
  configPath: string;
  root: string;
  appPaths: string[];
  launchAgentPlist: string;
  homebrewCellarCandidates: string[];
}

export interface BrowserAuthOptions {
  browser: string;
  profile: string;
  timeoutMs: number;
}

interface BrowserProbeResult {
  cookies: string[];
  warnings: string[];
}

export interface RehearsalOptions {
  paths?: Partial<RehearsalPaths>;
  browser?: Partial<BrowserAuthOptions>;
  env?: Record<string, string>;
  runner?: CommandRunner;
  resetPrivacy?: boolean;
  cookieProbe?: {
    x?: () => Promise<BrowserProbeResult>;
    google?: () => Promise<BrowserProbeResult>;
  };
}

export interface HostPreflightOptions {
  xArchive?: string | null;
  youtubeExport?: string | null;
  podcastsSeed?: string | null;
  minFreeBytes?: number;
  diskPath?: string;
  allowTestAccountFallback?: boolean;
  env?: Record<string, string>;
  runner?: CommandRunner;
  platform?: NodeJS.Platform;
}

export interface LocalProviderImportOptions {
  xArchive?: string | null;
  youtubeExport?: string | null;
  root?: string | null;
  configPath?: string | null;
  env?: Record<string, string>;
  runner?: CommandRunner;
}

export interface FinalVerificationOptions extends RehearsalOptions {
  requireSources?: SourceId[];
  startDashboard?: boolean;
  dashboardTimeoutMs?: number;
}

export interface RehearsalAggregateReport {
  updatedAt?: string;
  runs: RehearsalReport[];
}

const REQUIRED_SOURCES: SourceId[] = ["youtube", "podcasts", "apple_notes", "twitter"];
const REQUIRED_RECORD_TYPES: Array<{ source: SourceId; label: string; types: string[] }> = [
  { source: "youtube", label: "YouTube activity", types: ["youtube.watched", "youtube.searched"] },
  { source: "podcasts", label: "Apple Podcasts listen", types: ["podcast.listened"] },
  { source: "apple_notes", label: "Apple Notes note", types: ["apple_note", "apple_note.created", "apple_note.modified"] },
  { source: "twitter", label: "Twitter/X activity", types: ["twitter.authored", "twitter.bookmarked", "twitter.liked", "twitter.following"] },
];
// The old catch-all auth-probe codes (youtube_auth_probe_failed, twitter_auth)
// were split into one code per user state; the rehearsal accepts any of the
// split codes wherever it used to match the catch-all.
const YOUTUBE_AUTH_PROBE_CODES = ["youtube_signed_out", "youtube_keychain_blocked", "youtube_activity_unreadable"];
const TWITTER_AUTH_PROBE_CODES = ["twitter_signed_out", "twitter_keychain_blocked", "twitter_session_check_failed"];
const AGENT_LABEL = "com.winterfell.nutshell.agent";
const BUNDLE_ID = "com.winterfell.nutshell";
const REQUIRED_FULL_REHEARSAL_PHASES = [
  "start",
  "local-release-checks",
  "clean-state",
  "published-install",
  "installed-product",
  "pre-permission-app-state",
  "unauthenticated-browser-state",
  "setup-flow",
  "auth-present-browser-setup",
  "authenticated-browser-state",
  "stage-podcast-seed",
  "provider-archive-imports",
  "apple-notes-handoff",
  "foreground-sync",
  "background-sync",
  "final-release-state",
  "complete",
] as const;
const AUTH_PRESENT_BROWSER_SETUP_PHASES = ["browser-login-handoff", "browser-auth-seed-restore"] as const;

const REQUIRED_FINAL_CHECK_NAMES = [
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
] as const;

const REQUIRED_LOCAL_RELEASE_CHECK_NAMES = [
  "bun run typecheck",
  "bun test",
  "bun run lint",
  "bun run build:compile",
  "bun run certify:release",
] as const;

const REQUIRED_CLEAN_STATE_CHECK_NAMES = [
  "nutshell command absent from PATH",
  "Nutshell config absent",
  "Nutshell data root absent",
  "Nutshell launch agent plist absent",
  "No stale Nutshell launch agent plists",
  "Nutshell launch agent unloaded",
  "Full Disk Access grant reset",
  "X browser auth absent",
  "Google/YouTube browser auth absent",
] as const;

const REQUIRED_CLEAN_STATE_CHECK_PREFIXES = [
  "Nutshell.app absent at ",
  "Homebrew Cellar install absent at ",
] as const;

const REQUIRED_PUBLISHED_INSTALL_CHECK_NAMES = [
  "install command uses a published user-facing source",
  "published install command succeeds",
  "installed nutshell is on PATH",
  "installed version matches release",
] as const;

const REQUIRED_INSTALLED_PRODUCT_CHECK_NAMES = [
  "installed nutshell command is on PATH",
  "installed nutshell version",
  "installed nutshell help",
  "installed health command returns JSON",
  "installed app is visible to health",
] as const;

const REQUIRED_PRE_PERMISSION_CHECK_NAMES = [
  "installed app status is readable",
  "installed app does not reuse an old Full Disk Access grant",
] as const;

const REQUIRED_SETUP_CHECK_NAMES = [
  "nutshell setup completes",
  "Full Disk Access is granted to Nutshell.app",
  "background sync is enabled",
  "background agent is enabled",
  "loaded background agent target is app-owned",
  "loaded background agent target is not raw CLI",
] as const;

const REQUIRED_PROVIDER_IMPORT_CHECK_NAMES = [
  "twitter official provider archive imports",
  "youtube official provider archive imports",
] as const;

const REQUIRED_FOREGROUND_SYNC_CHECK_NAMES = [
  "foreground sync completes",
  "foreground sync proves live youtube ingestion",
  "foreground sync proves live podcasts ingestion",
  "foreground sync proves live apple_notes ingestion",
  "foreground sync proves live twitter ingestion",
] as const;

const REQUIRED_UNAUTHENTICATED_CHECK_NAMES = [
  "youtube signed-out state is explicit",
  "twitter signed-out state is explicit",
] as const;

const REQUIRED_AUTHENTICATED_CHECK_NAMES = [
  "Google/YouTube browser auth cookies present after login",
  "youtube auth state is usable",
  "X browser auth cookies present after login",
  "twitter auth state is usable",
] as const;

const REQUIRED_STAGE_PODCAST_SEED_CHECK_NAMES = [
  "Apple Podcasts seed exists",
  "Apple Podcasts seed has SQLite-safe snapshot provenance",
  "Apple Podcasts seed staged at normal plugin path",
] as const;

const REQUIRED_MANUAL_HANDOFF_CHECK_NAMES = [
  "browser-login-handoff",
  "apple-notes-handoff",
] as const;
const REQUIRED_AUTH_SEED_RESTORE_CHECK_NAMES = [
  "browser auth seed restore declared",
  "browser auth seed manifest exists",
  "Chrome profile exists after auth seed restore",
  "login keychain exists after auth seed restore",
] as const;

interface RecordStats {
  count: number;
  first: string | null;
  last: string | null;
}

interface InstalledRecordStats {
  bySource: Record<string, RecordStats>;
  byType: Record<string, RecordStats>;
  storePath: string | null;
  root: string | null;
}

export function defaultRehearsalPaths(home = homedir()): RehearsalPaths {
  return {
    home,
    configPath: join(home, "nutconfig.jsonc"),
    root: join(home, "Nutshell"),
    appPaths: ["/Applications/Nutshell.app", join(home, "Applications", "Nutshell.app")],
    launchAgentPlist: join(home, "Library", "LaunchAgents", `${AGENT_LABEL}.plist`),
    homebrewCellarCandidates: ["/opt/homebrew/Cellar/nutshell", "/usr/local/Cellar/nutshell"],
  };
}

export async function verifyCleanState(options: RehearsalOptions = {}): Promise<RehearsalReport> {
  const paths = mergePaths(options.paths);
  const runner = options.runner ?? runCommand;
  const env = normalizedEnv(options.env);
  const browser = mergeBrowser(options.browser);
  const checks: RehearsalCheck[] = [];

  checks.push(await commandMissingCheck("nutshell command absent from PATH", ["sh", "-lc", "command -v nutshell"], runner, env));
  checks.push(pathAbsentCheck("Nutshell config absent", paths.configPath));
  checks.push(pathAbsentCheck("Nutshell data root absent", paths.root));
  for (const appPath of paths.appPaths) checks.push(pathAbsentCheck(`Nutshell.app absent at ${appPath}`, appPath));
  for (const cellar of paths.homebrewCellarCandidates) checks.push(pathAbsentCheck(`Homebrew Cellar install absent at ${cellar}`, cellar));
  checks.push(pathAbsentCheck("Nutshell launch agent plist absent", paths.launchAgentPlist));
  checks.push(staleLaunchAgentPlistsAbsentCheck(dirname(paths.launchAgentPlist)));
  checks.push(await launchAgentAbsentCheck(runner, env));
  checks.push(await fullDiskAccessCleanCheck(options.resetPrivacy === true, runner, env));
  checks.push(await browserSignedOutCheck("X browser auth absent", options.cookieProbe?.x ? options.cookieProbe.x() : xCookieProbe(browser)));
  checks.push(await browserSignedOutCheck("Google/YouTube browser auth absent", options.cookieProbe?.google ? options.cookieProbe.google() : googleCookieProbe(browser)));

  return reportFor("clean-state", checks, {
    home: paths.home,
    configPath: paths.configPath,
    root: paths.root,
    browser: browser as unknown as JsonObject,
    resetPrivacy: Boolean(options.resetPrivacy),
  });
}

export async function verifyInstalledProduct(options: RehearsalOptions = {}): Promise<RehearsalReport> {
  const runner = options.runner ?? runCommand;
  const env = normalizedEnv(options.env);
  const checks: RehearsalCheck[] = [];
  const which = await runner(["sh", "-lc", "command -v nutshell"], { env, timeoutMs: 30_000 });
  checks.push(commandPresentCheck("installed nutshell command is on PATH", which));
  checks.push(await commandJsonOrTextCheck("installed nutshell version", ["nutshell", "--version"], runner, env));
  checks.push(await commandJsonOrTextCheck("installed nutshell help", ["nutshell", "help"], runner, env, ["nutshell setup", "nutshell dashboard"]));
  const health = await runJsonCommand<HealthReport>(["nutshell", "health", "--json"], runner, env, 60_000);
  checks.push(jsonCommandCheck("installed health command returns JSON", health));
  if (health.value) checks.push(appInstalledCheck(health.value));
  return reportFor("installed-product", checks, { which: which.stdout.trim(), healthExitCode: health.result.code });
}

export async function verifyUnauthenticatedBrowserState(options: RehearsalOptions = {}): Promise<RehearsalReport> {
  const runner = options.runner ?? runCommand;
  const env = normalizedEnv(options.env);
  const youtube = await runJsonCommand<HealthReport>(["nutshell", "doctor", "youtube", "--json"], runner, env, 60_000);
  const twitter = await runJsonCommand<HealthReport>(["nutshell", "doctor", "twitter", "--json"], runner, env, 60_000);
  const checks = [
    jsonCommandCheck("youtube doctor returns JSON while signed out", youtube),
    authFailureCheck("youtube signed-out state is explicit", youtube.value, YOUTUBE_AUTH_PROBE_CODES),
    jsonCommandCheck("twitter doctor returns JSON while signed out", twitter),
    authFailureCheck("twitter signed-out state is explicit", twitter.value, TWITTER_AUTH_PROBE_CODES),
  ];
  return reportFor("unauthenticated-browser-state", checks, {
    youtubeExitCode: youtube.result.code,
    twitterExitCode: twitter.result.code,
    youtubeState: classifySourceState({ health: youtube.value, source: "youtube" }),
    twitterState: classifySourceState({ health: twitter.value, source: "twitter" }),
  });
}

export async function verifyAuthenticatedBrowserState(options: RehearsalOptions = {}): Promise<RehearsalReport> {
  const runner = options.runner ?? runCommand;
  const env = normalizedEnv(options.env);
  const browser = mergeBrowser(options.browser);
  const googleCookies = await browserProbeResult(options.cookieProbe?.google ? options.cookieProbe.google() : googleCookieProbe(browser));
  const xCookies = await browserProbeResult(options.cookieProbe?.x ? options.cookieProbe.x() : xCookieProbe(browser));
  const youtube = await runJsonCommand<HealthReport>(["nutshell", "doctor", "youtube", "--json"], runner, env, 60_000);
  const twitter = await runJsonCommand<HealthReport>(["nutshell", "doctor", "twitter", "--json"], runner, env, 60_000);
  const checks = [
    browserCookiesPresentCheck("Google/YouTube browser auth cookies present after login", googleCookies),
    jsonCommandCheck("youtube doctor returns JSON after login", youtube),
    authenticatedSourceUsableCheck("youtube auth state is usable", youtube.value, googleCookies, "youtube", [...YOUTUBE_AUTH_PROBE_CODES, "plugin_setup_degraded"]),
    browserCookiesPresentCheck("X browser auth cookies present after login", xCookies),
    jsonCommandCheck("twitter doctor returns JSON after login", twitter),
    authenticatedSourceUsableCheck("twitter auth state is usable", twitter.value, xCookies, "twitter", [...TWITTER_AUTH_PROBE_CODES, "plugin_setup_degraded"]),
  ];
  return reportFor("authenticated-browser-state", checks, {
    youtubeExitCode: youtube.result.code,
    twitterExitCode: twitter.result.code,
    youtubeState: classifyBrowserAuthState(youtube.value, "youtube", googleCookies.cookies),
    twitterState: classifyBrowserAuthState(twitter.value, "twitter", xCookies.cookies),
    browserWarnings: {
      google: googleCookies.warnings,
      x: xCookies.warnings,
    },
  });
}

export async function verifyFinalReleaseState(options: FinalVerificationOptions = {}): Promise<RehearsalReport> {
  const runner = options.runner ?? runCommand;
  const env = normalizedEnv(options.env);
  const requiredSources = options.requireSources ?? REQUIRED_SOURCES;
  const health = await runJsonCommand<HealthReport>(["nutshell", "health", "--json"], runner, env, 60_000);
  const recordStats = readInstalledRecordStats(env);
  const counts = Object.fromEntries(Object.entries(recordStats.bySource).map(([source, stats]) => [source, stats.count]));
  const checks: RehearsalCheck[] = [
    jsonCommandCheck("final health command returns JSON", health),
    finalHealthCheck(health.value),
    schedulerKnownCheck(health.value),
    ...requiredSources.map((source) => sourceRecordCountCheck(source, recordStats.bySource)),
    ...REQUIRED_RECORD_TYPES.filter((item) => requiredSources.includes(item.source)).map((item) => sourceTypeRecordCheck(item, recordStats.byType)),
  ];
  const dashboard = options.startDashboard === false ? null : await verifyDashboard(runner, env, options.dashboardTimeoutMs ?? 30_000, requiredSources);
  if (dashboard) checks.push(...dashboard.checks);
  return reportFor("final-release-state", checks, {
    healthExitCode: health.result.code,
    health: (health.value ?? {}) as unknown as JsonObject,
    recordCounts: counts as unknown as JsonObject,
    recordStats: recordStats as unknown as JsonObject,
    logPaths: recordStats.root ? { rootLogs: join(recordStats.root, "logs") } : {},
    dashboard: dashboard?.evidence ?? {},
  });
}

export async function verifyHostPreflight(options: HostPreflightOptions = {}): Promise<RehearsalReport> {
  const runner = options.runner ?? runCommand;
  const env = normalizedEnv(options.env);
  const minFreeBytes = options.minFreeBytes ?? 50 * 1024 ** 3;
  const diskPath = resolve(options.diskPath ?? homedir());
  const checks: RehearsalCheck[] = [];

  checks.push((options.platform ?? process.platform) === "darwin" ? pass("host is macOS", { platform: options.platform ?? process.platform }) : fail("host is macOS", { platform: options.platform ?? process.platform }));
  checks.push(diskFreeCheck(diskPath, minFreeBytes));
  checks.push(await commandAvailableCheck("Homebrew is available for the published install path", ["sh", "-lc", "command -v brew"], runner, env));
  checks.push(await vmManagerCheck(options.allowTestAccountFallback === true, runner, env));
  checks.push(fileExistsCheck("official X archive is available", options.xArchive));
  checks.push(fileExistsCheck("official Google/YouTube export is available", options.youtubeExport));
  checks.push(fileExistsCheck("SQLite-safe Apple Podcasts seed is available", options.podcastsSeed));
  if (options.podcastsSeed) checks.push(podcastSeedReadableCheck(options.podcastsSeed));
  if (options.podcastsSeed) checks.push(podcastSeedProvenanceCheck(options.podcastsSeed));

  return reportFor("host-preflight", checks, {
    diskPath,
    minFreeBytes,
    xArchive: options.xArchive ? resolve(options.xArchive) : null,
    youtubeExport: options.youtubeExport ? resolve(options.youtubeExport) : null,
    podcastsSeed: options.podcastsSeed ? resolve(options.podcastsSeed) : null,
    allowTestAccountFallback: Boolean(options.allowTestAccountFallback),
  });
}

export async function verifyLocalProviderImports(options: LocalProviderImportOptions = {}): Promise<RehearsalReport> {
  const runner = options.runner ?? runCommand;
  const root = resolve(options.root ?? join(tmpdir(), "nutshell-import-gates", new Date().toISOString().replace(/[:.]/g, "-")));
  const configPath = resolve(options.configPath ?? resolveConfigPath(root));
  mkdirSync(root, { recursive: true });
  const env = {
    ...normalizedEnv(options.env),
    [ROOT_ENV]: root,
    [CONFIG_ENV]: configPath,
  };
  const xArchive = options.xArchive ? resolve(options.xArchive) : null;
  const youtubeExport = options.youtubeExport ? resolve(options.youtubeExport) : null;
  const checks: RehearsalCheck[] = [
    fileExistsCheck("official X archive is available for local import gate", xArchive),
    fileExistsCheck("official Google/YouTube export is available for local import gate", youtubeExport),
  ];

  if (xArchive && existsSync(xArchive)) checks.push(await localProviderImportCommandCheck("twitter", xArchive, root, runner, env));
  if (youtubeExport && existsSync(youtubeExport)) checks.push(await localProviderImportCommandCheck("youtube", youtubeExport, root, runner, env));

  const recordStats = readInstalledRecordStats(env);
  checks.push(localProviderRecordCountCheck("twitter", recordStats.bySource));
  checks.push(localProviderRecordCountCheck("youtube", recordStats.bySource));
  for (const requirement of REQUIRED_RECORD_TYPES.filter((item) => item.source === "twitter" || item.source === "youtube")) {
    checks.push(localProviderRecordTypeCheck(requirement, recordStats.byType));
  }

  return reportFor("local-provider-imports", checks, {
    root,
    configPath,
    storePath: recordStats.storePath,
    recordStats: recordStats as unknown as JsonObject,
    xArchive,
    youtubeExport,
  });
}

export function writeReport(path: string, report: RehearsalReport): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

export function appendReport(path: string, report: RehearsalReport): void {
  mkdirSync(dirname(path), { recursive: true });
  const existing = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as JsonObject : { runs: [] };
  const runs = Array.isArray(existing.runs)
    ? existing.runs
    : isRehearsalReport(existing)
      ? [existing as unknown as JsonObject]
      : [];
  runs.push(report as unknown as JsonObject);
  writeFileSync(path, `${JSON.stringify({ updatedAt: new Date().toISOString(), runs }, null, 2)}\n`, "utf8");
}

export function prepareFreshInstallReportPath(reportPath: string, forceNewReport: boolean): string | null {
  const resolved = resolve(reportPath);
  if (!existsSync(resolved)) return null;
  if (!forceNewReport) {
    throw new Error(
      [
        `Fresh-install report already exists: ${resolved}`,
        "Use a new --report path, or pass --force-new-report to archive the existing report before starting a new rehearsal attempt.",
      ].join("\n"),
    );
  }
  const archivePath = `${resolved}.previous-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  mkdirSync(dirname(archivePath), { recursive: true });
  renameSync(resolved, archivePath);
  return archivePath;
}

export function auditRehearsalReportFile(path: string): RehearsalReport {
  const resolved = resolve(path);
  if (!existsSync(resolved)) {
    return reportFor("aggregate-report-audit", [fail("fresh-install report exists", { path: resolved })], { path: resolved });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolved, "utf8"));
  } catch (error) {
    return reportFor("aggregate-report-audit", [fail("fresh-install report parses as JSON", { path: resolved, error: String(error) })], { path: resolved });
  }
  return auditRehearsalReport(parsed, resolved);
}

export function auditRehearsalReport(input: unknown, path = ""): RehearsalReport {
  const runs = aggregateRuns(input);
  const checks: RehearsalCheck[] = [];
  checks.push(
    runs.length > 0
      ? pass("fresh-install report has phase entries", { phaseCount: runs.length })
      : fail("fresh-install report has phase entries", { path }),
  );

  const phaseNames = runs.map((run) => run.phase);
  for (const phase of REQUIRED_FULL_REHEARSAL_PHASES) {
    if (phase === "auth-present-browser-setup") continue;
    const matches = runs.filter((run) => run.phase === phase);
    const passing = matches.filter((run) => run.status === "pass");
    checks.push(
      passing.length === 1 && matches.length === 1
        ? pass(`required phase passed: ${phase}`, { phase })
        : fail(`required phase passed: ${phase}`, {
            phase,
            matches: matches.length,
            passing: passing.length,
            observedPhases: phaseNames,
          }),
    );
  }
  checks.push(authPresentBrowserSetupPhaseCheck(runs));
  checks.push(phaseOrderCheck(runs));

  const failedRuns = runs.filter((run) => run.status !== "pass");
  checks.push(
    failedRuns.length === 0
      ? pass("no failed phases are present in final report", { phaseCount: runs.length })
      : fail("no failed phases are present in final report", { failedPhases: failedRuns.map((run) => run.phase) }),
  );
  checks.push(...releaseContractChecks(runs));

  const local = runs.find((run) => run.phase === "local-release-checks");
  checks.push(...requiredChecksPassed(local, REQUIRED_LOCAL_RELEASE_CHECK_NAMES));
  const clean = runs.find((run) => run.phase === "clean-state");
  checks.push(...requiredChecksPassed(clean, REQUIRED_CLEAN_STATE_CHECK_NAMES));
  checks.push(...requiredCheckPrefixesPassed(clean, REQUIRED_CLEAN_STATE_CHECK_PREFIXES));
  const published = runs.find((run) => run.phase === "published-install");
  checks.push(...requiredChecksPassed(published, REQUIRED_PUBLISHED_INSTALL_CHECK_NAMES));
  const installed = runs.find((run) => run.phase === "installed-product");
  checks.push(...requiredChecksPassed(installed, REQUIRED_INSTALLED_PRODUCT_CHECK_NAMES));
  const prePermission = runs.find((run) => run.phase === "pre-permission-app-state");
  checks.push(...requiredChecksPassed(prePermission, REQUIRED_PRE_PERMISSION_CHECK_NAMES));
  const setup = runs.find((run) => run.phase === "setup-flow");
  checks.push(...requiredChecksPassed(setup, REQUIRED_SETUP_CHECK_NAMES));
  const unauthenticated = runs.find((run) => run.phase === "unauthenticated-browser-state");
  checks.push(...requiredChecksPassed(unauthenticated, REQUIRED_UNAUTHENTICATED_CHECK_NAMES));
  const authenticated = runs.find((run) => run.phase === "authenticated-browser-state");
  checks.push(...requiredChecksPassed(authenticated, REQUIRED_AUTHENTICATED_CHECK_NAMES));
  const podcastSeed = runs.find((run) => run.phase === "stage-podcast-seed");
  checks.push(...requiredChecksPassed(podcastSeed, REQUIRED_STAGE_PODCAST_SEED_CHECK_NAMES));
  checks.push(...requiredAuthPresentBrowserSetupChecksPassed(runs));
  checks.push(...requiredChecksPassed(runs.find((run) => run.phase === "apple-notes-handoff"), [REQUIRED_MANUAL_HANDOFF_CHECK_NAMES[1]]));
  const imports = runs.find((run) => run.phase === "provider-archive-imports");
  checks.push(...requiredChecksPassed(imports, REQUIRED_PROVIDER_IMPORT_CHECK_NAMES));
  const foreground = runs.find((run) => run.phase === "foreground-sync");
  checks.push(...requiredChecksPassed(foreground, REQUIRED_FOREGROUND_SYNC_CHECK_NAMES));
  const final = runs.find((run) => run.phase === "final-release-state");
  checks.push(...requiredChecksPassed(final, REQUIRED_FINAL_CHECK_NAMES));
  checks.push(...requiredReleaseEvidencePassed(runs));

  return reportFor("aggregate-report-audit", checks, {
    path,
    phaseCount: runs.length,
    requiredPhases: [...REQUIRED_FULL_REHEARSAL_PHASES],
    authPresentBrowserSetupPhases: [...AUTH_PRESENT_BROWSER_SETUP_PHASES],
  });
}

function requiredReleaseEvidencePassed(runs: RehearsalReport[]): RehearsalCheck[] {
  const start = runs.find((run) => run.phase === "start");
  const published = runs.find((run) => run.phase === "published-install");
  const setup = runs.find((run) => run.phase === "setup-flow");
  const final = runs.find((run) => run.phase === "final-release-state");
  return [
    evidenceStringCheck(start, "release report records the public install command", "installCommand"),
    evidenceStringCheck(start, "release report records the public install source", "installSource"),
    evidenceStringCheck(start, "release report records the release identifier", "releaseId"),
    evidenceStringCheck(published, "published install records the installed command path", "installedCommandPath"),
    evidenceStringCheck(published, "published install records the installed version", "installedVersion"),
    evidenceStringCheck(setup, "setup report records the permission-bearing bundle identifier", "bundleId"),
    evidenceStringCheck(setup, "setup report records the app permission status", "appStatus"),
    evidenceNestedStringCheck(setup, "setup report records the loaded launch agent target", ["launchAgent", "raw"]),
    evidenceObjectHasKeyCheck(final, "final report records full health JSON", "health"),
    evidenceNestedStringCheck(final, "final report records the installed app path", ["health", "app", "path"]),
    evidenceNestedStringCheck(final, "final report records the Nutshell log directory", ["logPaths", "rootLogs"]),
    evidenceNestedStringCheck(final, "final report records the dashboard URL", ["dashboard", "url"]),
    evidenceObjectHasKeyCheck(final, "final report records source counts", "recordCounts"),
  ];
}

function authPresentBrowserSetupPhaseCheck(runs: RehearsalReport[]): RehearsalCheck {
  const matches = runs.filter((run) => isAuthPresentBrowserSetupPhase(run.phase));
  const passing = matches.filter((run) => run.status === "pass");
  return passing.length === 1 && matches.length === 1
    ? pass("required auth-present browser setup phase passed", { phase: passing[0]!.phase })
    : fail("required auth-present browser setup phase passed", {
        acceptedPhases: [...AUTH_PRESENT_BROWSER_SETUP_PHASES],
        matches: matches.map((run) => `${run.status}:${run.phase}`),
        passing: passing.map((run) => run.phase),
        observedPhases: runs.map((run) => run.phase),
      });
}

function releaseContractChecks(runs: RehearsalReport[]): RehearsalCheck[] {
  const checks: RehearsalCheck[] = [];
  const missingContract = runs.filter((run) => !run.contract);
  checks.push(
    missingContract.length
      ? fail("every phase records a product validation contract", { phases: missingContract.map((run) => run.phase) })
      : pass("every phase records a product validation contract", { phaseCount: runs.length }),
  );
  const contractFailures = runs
    .filter((run) => run.contract)
    .filter((run) => run.contract.pass !== true || run.contract.blockerKind !== "none" || Boolean(run.contract.diagnosticAction));
  checks.push(
    contractFailures.length
      ? fail("no phase uses blockers or diagnostic actions as release proof", {
          phases: contractFailures.map((run) => ({
            phase: run.phase,
            pass: run.contract.pass,
            blockerKind: run.contract.blockerKind,
            diagnosticAction: run.contract.diagnosticAction ?? null,
          })),
        })
      : pass("no phase uses blockers or diagnostic actions as release proof", { phaseCount: runs.length }),
  );
  const nonPassingChecks = runs.flatMap((run) => run.checks.filter((check) => check.status !== "pass").map((check) => `${run.phase}:${check.status}:${check.name}`));
  checks.push(
    nonPassingChecks.length
      ? fail("no manual skipped or failed checks are counted in final report", { checks: nonPassingChecks })
      : pass("no manual skipped or failed checks are counted in final report", { phaseCount: runs.length }),
  );
  return checks;
}

function evidenceStringCheck(report: RehearsalReport | undefined, name: string, key: string): RehearsalCheck {
  if (!report) return fail(name, { reason: "phase_missing", key });
  const value = report.evidence[key];
  return typeof value === "string" && value.trim()
    ? pass(name, { phase: report.phase, key, value })
    : fail(name, { phase: report.phase, key, value: value ?? null });
}

function evidenceNestedStringCheck(report: RehearsalReport | undefined, name: string, path: string[]): RehearsalCheck {
  if (!report) return fail(name, { reason: "phase_missing", path });
  const value = nestedValue(report.evidence, path);
  return typeof value === "string" && value.trim()
    ? pass(name, { phase: report.phase, path: path.join("."), value })
    : fail(name, { phase: report.phase, path: path.join("."), reason: value === null || value === undefined ? "missing" : "not_non_empty_string" });
}

function evidenceObjectHasKeyCheck(report: RehearsalReport | undefined, name: string, key: string): RehearsalCheck {
  if (!report) return fail(name, { reason: "phase_missing", key });
  const value = report.evidence[key];
  return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0
    ? pass(name, { phase: report.phase, key, keys: Object.keys(value) })
    : fail(name, { phase: report.phase, key, reason: value === null || value === undefined ? "missing" : "not_non_empty_object" });
}

function nestedValue(input: JsonObject, path: string[]): unknown {
  let current: unknown = input;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function snapshotPodcastDatabase(input: { source: string; destination: string; overwrite?: boolean }): JsonObject {
  const source = resolve(input.source);
  const destination = resolve(input.destination);
  if (!existsSync(source)) throw new Error(`Apple Podcasts database does not exist: ${source}`);
  if (existsSync(destination)) {
    if (!input.overwrite) throw new Error(`Snapshot destination already exists: ${destination}`);
    rmSync(destination, { force: true });
  }
  mkdirSync(dirname(destination), { recursive: true });
  const temp = `${destination}.tmp-${process.pid}-${Date.now()}`;
  if (existsSync(temp)) unlinkSync(temp);
  const db = new Database(source, { readonly: true, create: false });
  try {
    db.query("vacuum main into ?").run(temp);
  } finally {
    db.close();
  }
  renameSync(temp, destination);
  const sourceStat = statSync(source);
  const destStat = statSync(destination);
  const createdAt = new Date().toISOString();
  const manifest: PodcastSnapshotManifest = {
    version: 1,
    kind: "nutshell-podcast-snapshot",
    method: "sqlite_vacuum_into",
    source,
    destination,
    sourceBytes: sourceStat.size,
    destinationBytes: destStat.size,
    createdAt,
  };
  const manifestPath = podcastSnapshotManifestPath(destination);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { ...manifest, manifestPath };
}

export async function runCommand(command: string[], options: { env?: Record<string, string>; timeoutMs?: number; cwd?: string } = {}): Promise<CommandResult> {
  const proc = Bun.spawn(command, {
    cwd: options.cwd ?? process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...(options.env ?? {}) },
  });
  const timeoutMs = options.timeoutMs ?? 30_000;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, timeoutMs);
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  return { code, stdout, stderr, timedOut };
}

function mergePaths(paths: Partial<RehearsalPaths> | undefined): RehearsalPaths {
  return { ...defaultRehearsalPaths(), ...(paths ?? {}) };
}

function normalizedEnv(env: Record<string, string> | NodeJS.ProcessEnv | undefined): Record<string, string> {
  const input = env ?? process.env;
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string") output[key] = value;
  }
  return output;
}

function mergeBrowser(browser: Partial<BrowserAuthOptions> | undefined): BrowserAuthOptions {
  return {
    browser: browser?.browser ?? "chrome",
    profile: browser?.profile ?? "",
    timeoutMs: browser?.timeoutMs ?? 30_000,
  };
}

function pass(name: string, detail: JsonObject = {}): RehearsalCheck {
  return { name, status: "pass", detail };
}

function fail(name: string, detail: JsonObject = {}): RehearsalCheck {
  return { name, status: "fail", detail };
}

function skip(name: string, detail: JsonObject = {}): RehearsalCheck {
  return { name, status: "skip", detail };
}

function pathAbsentCheck(name: string, path: string): RehearsalCheck {
  return existsSync(path) ? fail(name, { path, reason: "path_exists" }) : pass(name, { path });
}

function fileExistsCheck(name: string, path: string | null | undefined): RehearsalCheck {
  if (!path) return fail(name, { reason: "missing_path" });
  const resolved = resolve(path);
  return existsSync(resolved) ? pass(name, { path: resolved, bytes: statSync(resolved).size }) : fail(name, { path: resolved, reason: "path_missing" });
}

function diskFreeCheck(path: string, minFreeBytes: number): RehearsalCheck {
  try {
    const stats = statfsSync(path);
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    return freeBytes >= minFreeBytes
      ? pass("host has enough free disk for a VM rehearsal", { path, freeBytes, minFreeBytes })
      : fail("host has enough free disk for a VM rehearsal", { path, freeBytes, minFreeBytes });
  } catch (error) {
    return fail("host has enough free disk for a VM rehearsal", { path, minFreeBytes, error: String(error) });
  }
}

async function commandAvailableCheck(name: string, command: string[], runner: CommandRunner, env: Record<string, string>): Promise<RehearsalCheck> {
  const result = await runner(command, { env, timeoutMs: 30_000 });
  return result.code === 0 && result.stdout.trim()
    ? pass(name, { command: command.join(" "), path: result.stdout.trim() })
    : fail(name, { command: command.join(" "), code: result.code, stdout: result.stdout.trim(), stderr: result.stderr.trim(), timedOut: result.timedOut });
}

async function vmManagerCheck(allowFallback: boolean, runner: CommandRunner, env: Record<string, string>): Promise<RehearsalCheck> {
  const tart = await runner(["sh", "-lc", "command -v tart"], { env, timeoutMs: 30_000 });
  if (tart.code === 0 && tart.stdout.trim()) return pass("disposable macOS VM manager is available", { manager: "tart", path: tart.stdout.trim() });
  const virtualBuddy = await runner(
    [
      "sh",
      "-lc",
      'if [ -d /Applications/VirtualBuddy.app ]; then printf /Applications/VirtualBuddy.app; elif [ -d "$HOME/Applications/VirtualBuddy.app" ]; then printf "$HOME/Applications/VirtualBuddy.app"; fi',
    ],
    { env, timeoutMs: 30_000 },
  );
  if (virtualBuddy.code === 0 && virtualBuddy.stdout.trim()) return pass("disposable macOS VM manager is available", { manager: "VirtualBuddy", path: virtualBuddy.stdout.trim() });
  return allowFallback
    ? skip("disposable macOS VM manager is available", { reason: "explicit_test_account_fallback_allowed" })
    : fail("disposable macOS VM manager is available", { checked: ["tart", "VirtualBuddy"], allowFallback });
}

function podcastSeedReadableCheck(path: string): RehearsalCheck {
  const resolved = resolve(path);
  if (!existsSync(resolved)) return fail("Apple Podcasts seed passes SQLite quick_check", { path: resolved, reason: "path_missing" });
  try {
    const db = new Database(resolved, { readonly: true, create: false });
    try {
      const row = db.query("pragma quick_check").get() as { quick_check?: string } | null;
      const result = row?.quick_check ?? Object.values((row ?? {}) as Record<string, unknown>)[0];
      const resultText = typeof result === "string" ? result : String(result ?? "");
      return resultText === "ok"
        ? pass("Apple Podcasts seed passes SQLite quick_check", { path: resolved, result: resultText })
        : fail("Apple Podcasts seed passes SQLite quick_check", { path: resolved, result: resultText });
    } finally {
      db.close();
    }
  } catch (error) {
    return fail("Apple Podcasts seed passes SQLite quick_check", { path: resolved, error: String(error) });
  }
}

export function podcastSeedProvenanceCheck(path: string): RehearsalCheck {
  const resolved = resolve(path);
  const manifestPath = podcastSnapshotManifestPath(resolved);
  if (!existsSync(manifestPath)) {
    return fail("Apple Podcasts seed has SQLite-safe snapshot provenance", {
      path: resolved,
      manifestPath,
      reason: "snapshot_manifest_missing",
      nextAction: "Create the seed with `bun run rehearse:snapshot-podcasts -- --out <MTLibrary.sqlite>` and copy the generated .snapshot.json file with it.",
    });
  }
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Partial<PodcastSnapshotManifest>;
    const failures: string[] = [];
    if (manifest.kind !== "nutshell-podcast-snapshot") failures.push("kind");
    if (manifest.method !== "sqlite_vacuum_into") failures.push("method");
    return failures.length
      ? fail("Apple Podcasts seed has SQLite-safe snapshot provenance", { path: resolved, manifestPath, failures, manifest: manifest as JsonObject })
      : pass("Apple Podcasts seed has SQLite-safe snapshot provenance", { path: resolved, manifestPath, method: manifest.method ?? "sqlite_vacuum_into" });
  } catch (error) {
    return fail("Apple Podcasts seed has SQLite-safe snapshot provenance", { path: resolved, manifestPath, error: String(error) });
  }
}

export function podcastSnapshotManifestPath(path: string): string {
  return `${resolve(path)}.snapshot.json`;
}

function staleLaunchAgentPlistsAbsentCheck(launchAgentsDir: string): RehearsalCheck {
  if (!existsSync(launchAgentsDir)) return pass("No stale Nutshell launch agent plists", { launchAgentsDir });
  const stale = readdirSync(launchAgentsDir).filter((entry) => entry.toLowerCase().includes("nutshell") && entry.endsWith(".plist"));
  return stale.length
    ? fail("No stale Nutshell launch agent plists", { launchAgentsDir, stale })
    : pass("No stale Nutshell launch agent plists", { launchAgentsDir });
}

async function commandMissingCheck(name: string, command: string[], runner: CommandRunner, env: Record<string, string>): Promise<RehearsalCheck> {
  const result = await runner(command, { env, timeoutMs: 30_000 });
  return result.code === 0 ? fail(name, { command: command.join(" "), stdout: result.stdout.trim() }) : pass(name, { command: command.join(" "), code: result.code });
}

function commandPresentCheck(name: string, result: CommandResult): RehearsalCheck {
  return result.code === 0 && result.stdout.trim()
    ? pass(name, { stdout: result.stdout.trim() })
    : fail(name, { code: result.code, stdout: result.stdout.trim(), stderr: result.stderr.trim(), timedOut: result.timedOut });
}

async function commandJsonOrTextCheck(
  name: string,
  command: string[],
  runner: CommandRunner,
  env: Record<string, string>,
  requiredText: string[] = [],
): Promise<RehearsalCheck> {
  const result = await runner(command, { env, timeoutMs: 30_000 });
  const missing = requiredText.filter((text) => !result.stdout.includes(text));
  if (result.code !== 0 || missing.length) {
    return fail(name, { command: command.join(" "), code: result.code, missing, stdout: result.stdout.trim(), stderr: result.stderr.trim() });
  }
  return pass(name, { command: command.join(" "), stdout: result.stdout.trim().slice(0, 500) });
}

async function launchAgentAbsentCheck(runner: CommandRunner, env: Record<string, string>): Promise<RehearsalCheck> {
  if (process.platform !== "darwin") return skip("Nutshell launch agent unloaded", { reason: "not_macos" });
  const uid = typeof process.getuid === "function" ? process.getuid() : "";
  const result = await runner(["launchctl", "print", `gui/${uid}/${AGENT_LABEL}`], { env, timeoutMs: 30_000 });
  if (result.code === 0) {
    return fail("Nutshell launch agent unloaded", { label: AGENT_LABEL, stdout: result.stdout.trim(), stderr: result.stderr.trim() });
  }
  const userDomain = await runner(["launchctl", "print", `gui/${uid}`], { env, timeoutMs: 30_000 });
  if (userDomain.code !== 0) {
    return fail("Nutshell launch agent unloaded", {
      label: AGENT_LABEL,
      code: result.code,
      userDomainCode: userDomain.code,
      stderr: userDomain.stderr.trim(),
      reason: "could_not_list_user_launchd_domain",
    });
  }
  const matches = userDomain.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.toLowerCase().includes("nutshell"));
  return matches.length
    ? fail("Nutshell launch agent unloaded", { label: AGENT_LABEL, staleLaunchdLines: matches.slice(0, 50) })
    : pass("Nutshell launch agent unloaded", { label: AGENT_LABEL, code: result.code });
}

async function fullDiskAccessCleanCheck(resetPrivacy: boolean, runner: CommandRunner, env: Record<string, string>): Promise<RehearsalCheck> {
  if (process.platform !== "darwin") return skip("Full Disk Access grant reset", { reason: "not_macos" });
  if (!resetPrivacy) {
    return fail("Full Disk Access grant reset", {
      reason: "run with --reset-privacy in the disposable test environment so the rehearsal can prove no old grant is being reused",
      bundleId: BUNDLE_ID,
    });
  }
  const result = await runner(["tccutil", "reset", "SystemPolicyAllFiles", BUNDLE_ID], { env, timeoutMs: 30_000 });
  if (result.code === 0) return pass("Full Disk Access grant reset", { bundleId: BUNDLE_ID });
  if (isMissingTccBundle(result.stderr)) {
    return pass("Full Disk Access grant reset", { bundleId: BUNDLE_ID, noExistingGrant: true, stderr: result.stderr.trim() });
  }
  return fail("Full Disk Access grant reset", { bundleId: BUNDLE_ID, code: result.code, stderr: result.stderr.trim() });
}

function isMissingTccBundle(stderr: string): boolean {
  return /No such bundle identifier/i.test(stderr);
}

async function browserSignedOutCheck(name: string, probe: Promise<{ cookies: string[]; warnings: string[] }>): Promise<RehearsalCheck> {
  try {
    const result = await probe;
    return result.cookies.length
      ? fail(name, { cookiesPresent: result.cookies, warnings: result.warnings })
      : pass(name, { warnings: result.warnings });
  } catch (error) {
    return fail(name, { error: String(error) });
  }
}

async function xCookieProbe(browser: BrowserAuthOptions): Promise<{ cookies: string[]; warnings: string[] }> {
  const result = await readBrowserCookies({
    url: "https://x.com/",
    origins: ["https://x.com", "https://twitter.com"],
    names: ["auth_token", "ct0"],
    browser: browser.browser,
    profile: browser.profile,
    timeoutMs: browser.timeoutMs,
  });
  return { cookies: result.cookies.filter((cookie) => cookie.value).map((cookie) => cookie.name), warnings: result.warnings };
}

async function googleCookieProbe(browser: BrowserAuthOptions): Promise<{ cookies: string[]; warnings: string[] }> {
  const result = await readBrowserCookies({
    url: "https://myactivity.google.com/",
    origins: ["https://myactivity.google.com", "https://accounts.google.com", "https://youtube.com", "https://www.youtube.com"],
    names: ["SID", "HSID", "SSID", "APISID", "SAPISID", "__Secure-1PSID", "__Secure-3PSID"],
    browser: browser.browser,
    profile: browser.profile,
    timeoutMs: browser.timeoutMs,
  });
  return { cookies: result.cookies.filter((cookie) => cookie.value).map((cookie) => cookie.name), warnings: result.warnings };
}

async function runJsonCommand<T>(
  command: string[],
  runner: CommandRunner,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<{ result: CommandResult; value: T | null; parseError: string | null }> {
  const result = await runner(command, { env, timeoutMs });
  try {
    return { result, value: JSON.parse(result.stdout.trim()) as T, parseError: null };
  } catch (error) {
    return { result, value: null, parseError: String(error) };
  }
}

function jsonCommandCheck(name: string, command: { result: CommandResult; value: unknown; parseError: string | null }): RehearsalCheck {
  if (!command.value) return fail(name, { code: command.result.code, parseError: command.parseError, stdout: command.result.stdout.slice(0, 500), stderr: command.result.stderr.slice(0, 500) });
  return pass(name, { code: command.result.code });
}

function appInstalledCheck(health: HealthReport): RehearsalCheck {
  return health.app?.installed
    ? pass("installed app is visible to health", health.app as unknown as JsonObject)
    : fail("installed app is visible to health", { app: (health.app ?? {}) as unknown as JsonObject });
}

function authFailureCheck(name: string, health: HealthReport | null, acceptedCodes: string[]): RehearsalCheck {
  if (!health) return fail(name, { reason: "missing_health_json" });
  const codes = health.findings.map((finding) => finding.code);
  const matched = codes.filter((code) => acceptedCodes.includes(code));
  return matched.length ? pass(name, { matched, codes, observedState: "needs_auth" }) : fail(name, { acceptedCodes, codes, observedState: classifySourceState({ health, source: "system" }) });
}

function noAuthFailureCheck(name: string, health: HealthReport | null, authCodes: string[]): RehearsalCheck {
  if (!health) return fail(name, { reason: "missing_health_json" });
  const codes = health.findings.map((finding) => finding.code);
  const matched = codes.filter((code) => authCodes.includes(code));
  return matched.length ? fail(name, { authCodes: matched, codes }) : pass(name, { codes });
}

async function browserProbeResult(probe: Promise<BrowserProbeResult>): Promise<BrowserProbeResult> {
  try {
    return await probe;
  } catch (error) {
    return { cookies: [], warnings: [String(error)] };
  }
}

function browserCookiesPresentCheck(name: string, probe: BrowserProbeResult): RehearsalCheck {
  const warningText = probe.warnings.join("\n");
  const keychainWarnings = keychainOrSafeStorageWarnings(probe.warnings);
  if (keychainWarnings.length) {
    return fail(name, { cookies: probe.cookies, warnings: probe.warnings, keychainWarnings, observedState: "blocked_bug" });
  }
  return probe.cookies.length
    ? pass(name, { cookies: probe.cookies, warnings: probe.warnings, observedState: "ready_empty" })
    : fail(name, { cookies: [], warnings: probe.warnings, warningText, observedState: "needs_auth" });
}

function authenticatedSourceUsableCheck(
  name: string,
  health: HealthReport | null,
  probe: BrowserProbeResult,
  source: SourceId,
  authCodes: string[],
): RehearsalCheck {
  if (!health) return fail(name, { reason: "missing_health_json", observedState: "blocked_bug" });
  const sourceFindings = health.findings.filter((finding) => finding.source === source);
  const sourceCodes = sourceFindings.map((finding) => finding.code);
  const systemCodes = health.findings.filter((finding) => finding.source === "system").map((finding) => finding.code);
  const authMatches = sourceCodes.filter((code) => authCodes.includes(code));
  const keychainWarnings = keychainOrSafeStorageWarnings(probe.warnings.concat(findingTexts({ ...health, findings: sourceFindings })));
  const observedState = classifyBrowserAuthState(health, source, probe.cookies);
  if (keychainWarnings.length) {
    return fail(name, { sourceCodes, systemCodes, keychainWarnings, observedState: "blocked_bug" });
  }
  if (authMatches.length) {
    return fail(name, { authCodes: authMatches, sourceCodes, systemCodes, observedState });
  }
  const criticalSourceFindings = sourceFindings.filter((finding) => finding.level === "critical");
  if (criticalSourceFindings.length) {
    return fail(name, {
      sourceCodes,
      systemCodes,
      findings: criticalSourceFindings as unknown as JsonObject[],
      observedState,
    });
  }
  return probe.cookies.length
    ? pass(name, { sourceCodes, systemCodes, observedState })
    : fail(name, { sourceCodes, systemCodes, observedState: "needs_auth" });
}

function classifyBrowserAuthState(health: HealthReport | null, source: SourceId, browserCookies: string[]): RehearsalSourceState {
  if (!health) return "blocked_bug";
  const sourceFindings = health.findings.filter((finding) => finding.source === source);
  const text = findingTexts({ ...health, findings: sourceFindings });
  if (keychainOrSafeStorageWarnings(text).length) return "blocked_bug";
  const guided = guidedCriticalState(sourceFindings, ["needs_auth", "needs_permission", "blocked_bug", "ready_empty"]);
  if (guided === "needs_auth") return browserCookies.length ? "blocked_bug" : "needs_auth";
  if (guided) return guided;
  if (sourceFindings.some((finding) => /auth|cookie|signed.?out|login/i.test(`${finding.code} ${finding.message}`))) {
    return browserCookies.length ? "blocked_bug" : "needs_auth";
  }
  if (sourceFindings.some((finding) => /permission|Full Disk Access|automation|not authorized|access/i.test(`${finding.code} ${finding.message}`))) {
    return "needs_permission";
  }
  if (sourceFindings.some((finding) => finding.level === "critical")) return "blocked_bug";
  return browserCookies.length ? "ready_empty" : "needs_auth";
}

export function classifySourceState(input: {
  health: HealthReport | null;
  source: SourceId | "system";
  browserCookies?: string[];
  recordCount?: number;
}): RehearsalSourceState {
  if ((input.recordCount ?? 0) > 0) return "ready_with_data";
  if (!input.health) return "blocked_bug";
  const sourceFindings = input.health.findings.filter((finding) => input.source === "system" ? finding.source === "system" : finding.source === input.source);
  const systemFindings = input.health.findings.filter((finding) => finding.source === "system");
  const relevant = input.source === "system" ? systemFindings : [...sourceFindings, ...systemFindings];
  const text = findingTexts({ ...input.health, findings: relevant });
  if (keychainOrSafeStorageWarnings(text).length) return "blocked_bug";
  const guided = guidedCriticalState(sourceFindings, ["needs_permission", "needs_auth", "blocked_bug", "ready_empty"]);
  if (guided === "needs_auth") return input.browserCookies?.length ? "blocked_bug" : "needs_auth";
  if (guided) return guided;
  if (sourceFindings.some((finding) => /permission|Full Disk Access|automation|not authorized|access/i.test(`${finding.code} ${finding.message}`))) {
    return "needs_permission";
  }
  if (sourceFindings.some((finding) => /auth|cookie|signed.?out|login/i.test(`${finding.code} ${finding.message}`))) {
    return input.browserCookies?.length ? "blocked_bug" : "needs_auth";
  }
  if (systemFindings.some((finding) => /permission|Full Disk Access|automation|not authorized|access/i.test(`${finding.code} ${finding.message}`))) {
    return "needs_permission";
  }
  if (input.health.status === "ok") return "ready_empty";
  return "blocked_bug";
}

function findingTexts(health: HealthReport): string[] {
  return health.findings.map((finding) => `${finding.code}\n${finding.message}\n${JSON.stringify(finding.detail)}`);
}

// New releases carry guidance.state on every problem finding; prefer it over
// the regex heuristics, which remain as the fallback for pre-guidance releases.
function guidedCriticalState(
  findings: HealthReport["findings"],
  priority: RehearsalSourceState[],
): RehearsalSourceState | null {
  const states = new Set(
    findings.filter((finding) => finding.level === "critical" && finding.guidance).map((finding) => finding.guidance!.state),
  );
  for (const state of priority) if (states.has(state)) return state;
  return null;
}

function keychainOrSafeStorageWarnings(warnings: readonly string[]): string[] {
  return warnings.filter((warning) => /keychain|safe storage|Chrome Safe Storage|decrypt|security.*find-generic-password|timeout/i.test(warning));
}

function finalHealthCheck(health: HealthReport | null): RehearsalCheck {
  if (!health) return fail("final health proves app-owned background sync", { reason: "missing_health_json" });
  const app = health.app;
  const failures: string[] = [];
  if (health.status !== "ok") failures.push(`health_${health.status}`);
  if (health.findings.length) failures.push("health_findings_present");
  if (!app?.installed) failures.push("app_not_installed");
  if (app?.fullDiskAccess !== "granted") failures.push("full_disk_access_not_granted");
  if (app?.backgroundSync !== "enabled") failures.push("background_sync_not_enabled");
  if (app?.agent !== "enabled") failures.push("agent_not_enabled");
  return failures.length
    ? fail("final health is clean and app-owned background sync is active", { failures, status: health.status, findings: health.findings as unknown as JsonObject[], app: (app ?? {}) as unknown as JsonObject })
    : pass("final health is clean and app-owned background sync is active", { status: health.status, app: app as unknown as JsonObject });
}

function schedulerKnownCheck(health: HealthReport | null): RehearsalCheck {
  if (!health) return fail("scheduler has known last and next sync", { reason: "missing_health_json" });
  const scheduler = health.scheduler;
  const failures: string[] = [];
  if (!scheduler?.lastRunAt) failures.push("last_run_unknown");
  if (!scheduler?.nextRunAt) failures.push("next_run_unknown");
  return failures.length ? fail("scheduler has known last and next sync", { failures, scheduler: scheduler as unknown as JsonObject }) : pass("scheduler has known last and next sync", scheduler as unknown as JsonObject);
}

function sourceRecordCountCheck(source: SourceId, stats: Record<string, RecordStats>): RehearsalCheck {
  const item = stats[source] ?? { count: 0, first: null, last: null };
  return item.count > 0 ? pass(`${source} produced canonical records`, { source, ...item }) : fail(`${source} produced canonical records`, { source, ...item });
}

function sourceTypeRecordCheck(requirement: { source: SourceId; label: string; types: string[] }, stats: Record<string, RecordStats>): RehearsalCheck {
  const matched = requirement.types
    .map((type) => ({ type, ...(stats[`${requirement.source}:${type}`] ?? { count: 0, first: null, last: null }) }))
    .filter((item) => item.count > 0);
  return matched.length
    ? pass(`${requirement.label} produced the expected record type`, { source: requirement.source, matched })
    : fail(`${requirement.label} produced the expected record type`, {
      source: requirement.source,
      acceptedTypes: requirement.types,
      availableTypes: Object.fromEntries(Object.entries(stats).filter(([key]) => key.startsWith(`${requirement.source}:`))) as unknown as JsonObject,
    });
}

async function localProviderImportCommandCheck(
  source: "twitter" | "youtube",
  archivePath: string,
  root: string,
  runner: CommandRunner,
  env: Record<string, string>,
): Promise<RehearsalCheck> {
  const result = await runner(["bun", "run", "src/cli.ts", "--root", root, "import", source, archivePath, "--json"], {
    env,
    timeoutMs: 30 * 60_000,
    cwd: process.cwd(),
  });
  return result.code === 0
    ? pass(`local ${source} import command succeeds`, commandResultDetail(result))
    : fail(`local ${source} import command succeeds`, commandResultDetail(result));
}

function commandResultDetail(result: CommandResult): JsonObject {
  return {
    code: result.code,
    timedOut: result.timedOut,
    stdout: result.stdout.length > 4000 ? result.stdout.slice(result.stdout.length - 4000) : result.stdout,
    stderr: result.stderr.length > 4000 ? result.stderr.slice(result.stderr.length - 4000) : result.stderr,
  };
}

function localProviderRecordCountCheck(source: "twitter" | "youtube", stats: Record<string, RecordStats>): RehearsalCheck {
  const item = stats[source] ?? { count: 0, first: null, last: null };
  return item.count > 0
    ? pass(`local ${source} import produced records`, { source, ...item })
    : fail(`local ${source} import produced records`, { source, ...item });
}

function localProviderRecordTypeCheck(requirement: { source: SourceId; label: string; types: string[] }, stats: Record<string, RecordStats>): RehearsalCheck {
  const matched = requirement.types
    .map((type) => ({ type, ...(stats[`${requirement.source}:${type}`] ?? { count: 0, first: null, last: null }) }))
    .filter((item) => item.count > 0);
  return matched.length
    ? pass(`local ${requirement.source} import produced canonical record types`, { source: requirement.source, matched })
    : fail(`local ${requirement.source} import produced canonical record types`, {
      source: requirement.source,
      acceptedTypes: requirement.types,
      availableTypes: Object.fromEntries(Object.entries(stats).filter(([key]) => key.startsWith(`${requirement.source}:`))) as unknown as JsonObject,
    });
}

function aggregateRuns(input: unknown): RehearsalReport[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];
  const rawRuns = (input as { runs?: unknown }).runs;
  if (!Array.isArray(rawRuns)) return [];
  return rawRuns.filter(isRehearsalReport);
}

function isRehearsalReport(input: unknown): input is RehearsalReport {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const item = input as { generatedAt?: unknown; phase?: unknown; status?: unknown; checks?: unknown; evidence?: unknown };
  return (
    typeof item.generatedAt === "string" &&
    typeof item.phase === "string" &&
    (item.status === "pass" || item.status === "fail") &&
    Array.isArray(item.checks) &&
    Boolean(item.evidence) &&
    typeof item.evidence === "object" &&
    !Array.isArray(item.evidence)
  );
}

function requiredChecksPassed(report: RehearsalReport | undefined, names: readonly string[]): RehearsalCheck[] {
  return names.map((name) => {
    if (!report) return fail(`required check passed: ${name}`, { reason: "phase_missing" });
    const matches = report.checks.filter((check) => check.name === name);
    const passing = matches.filter((check) => check.status === "pass");
    return passing.length === 1 && matches.length === 1
      ? pass(`required check passed: ${name}`, { phase: report.phase, check: name })
      : fail(`required check passed: ${name}`, {
          phase: report.phase,
          check: name,
          matches: matches.length,
          passing: passing.length,
          availableChecks: report.checks.map((check) => `${check.status}:${check.name}`),
        });
  });
}

function requiredAuthPresentBrowserSetupChecksPassed(runs: RehearsalReport[]): RehearsalCheck[] {
  const setup = runs.find((run) => isAuthPresentBrowserSetupPhase(run.phase));
  if (!setup) {
    return [
      fail("required check passed: auth-present browser setup", {
        reason: "phase_missing",
        acceptedPhases: [...AUTH_PRESENT_BROWSER_SETUP_PHASES],
      }),
    ];
  }
  if (setup.phase === "browser-auth-seed-restore") return requiredChecksPassed(setup, REQUIRED_AUTH_SEED_RESTORE_CHECK_NAMES);
  return requiredChecksPassed(setup, [REQUIRED_MANUAL_HANDOFF_CHECK_NAMES[0]]);
}

function isAuthPresentBrowserSetupPhase(phase: string): phase is (typeof AUTH_PRESENT_BROWSER_SETUP_PHASES)[number] {
  return AUTH_PRESENT_BROWSER_SETUP_PHASES.includes(phase as (typeof AUTH_PRESENT_BROWSER_SETUP_PHASES)[number]);
}

function requiredCheckPrefixesPassed(report: RehearsalReport | undefined, prefixes: readonly string[]): RehearsalCheck[] {
  return prefixes.map((prefix) => {
    if (!report) return fail(`required check prefix passed: ${prefix}`, { reason: "phase_missing" });
    const matches = report.checks.filter((check) => check.name.startsWith(prefix));
    const passing = matches.filter((check) => check.status === "pass");
    return passing.length > 0 && matches.length === passing.length
      ? pass(`required check prefix passed: ${prefix}`, { phase: report.phase, prefix, matches: matches.map((check) => check.name) })
      : fail(`required check prefix passed: ${prefix}`, {
          phase: report.phase,
          prefix,
          matches: matches.map((check) => `${check.status}:${check.name}`),
          availableChecks: report.checks.map((check) => `${check.status}:${check.name}`),
        });
  });
}

function phaseOrderCheck(runs: RehearsalReport[]): RehearsalCheck {
  const authPhase = runs.find((run) => isAuthPresentBrowserSetupPhase(run.phase))?.phase ?? "auth-present-browser-setup";
  const expectedPhases = REQUIRED_FULL_REHEARSAL_PHASES.map((phase) => (phase === "auth-present-browser-setup" ? authPhase : phase));
  const phaseIndexes = expectedPhases.map((phase) => runs.findIndex((run) => run.phase === phase));
  const missing = expectedPhases.filter((_, index) => phaseIndexes[index] === -1);
  const ordered = missing.length === 0 && phaseIndexes.every((index, position) => position === 0 || index > phaseIndexes[position - 1]!);
  return ordered
    ? pass("required phases appear in release-flow order", { phases: expectedPhases })
    : fail("required phases appear in release-flow order", {
        missing: [...missing],
        observedPhases: runs.map((run) => run.phase),
        expectedPhases,
      });
}

function readInstalledRecordStats(env: Record<string, string>): InstalledRecordStats {
  const configPath = env[CONFIG_ENV] ? resolve(env[CONFIG_ENV]!) : resolveConfigPath(env[ROOT_ENV]);
  const root = env[ROOT_ENV] ? resolve(env[ROOT_ENV]!) : resolveRoot(undefined, configPath);
  const config = loadConfig(root, configPath);
  const dbPath = storePath(config);
  if (!existsSync(dbPath)) return { bySource: {}, byType: {}, storePath: dbPath, root: config.root };
  const db = new Database(dbPath, { readonly: true, create: false });
  try {
    const bySourceRows = db
      .query("select source, count(*) as count, min(happened_at) as first, max(happened_at) as last from records group by source")
      .all() as Array<{ source: string; count: number; first: string | null; last: string | null }>;
    const byTypeRows = db
      .query("select source, type, count(*) as count, min(happened_at) as first, max(happened_at) as last from records group by source, type")
      .all() as Array<{ source: string; type: string; count: number; first: string | null; last: string | null }>;
    return {
      bySource: Object.fromEntries(bySourceRows.map((row) => [row.source, { count: Number(row.count), first: row.first, last: row.last }])),
      byType: Object.fromEntries(byTypeRows.map((row) => [`${row.source}:${row.type}`, { count: Number(row.count), first: row.first, last: row.last }])),
      storePath: dbPath,
      root: config.root,
    };
  } finally {
    db.close();
  }
}

async function verifyDashboard(
  runner: CommandRunner,
  env: Record<string, string>,
  timeoutMs: number,
  requiredSources: SourceId[],
): Promise<{ checks: RehearsalCheck[]; evidence: JsonObject }> {
  const port = 49_152 + Math.floor(Math.random() * 10_000);
  const url = `http://127.0.0.1:${port}/`;
  const proc = Bun.spawn(["nutshell", "dashboard", "--no-open", "--host", "127.0.0.1", "--port", String(port)], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();
  const checks: RehearsalCheck[] = [];
  try {
    const status = await waitForDashboardJson(new URL("/api/status", url).toString(), proc, timeoutMs);
    const html = await fetchText(url);
    const days = await fetchJson(new URL("/api/days", url).toString());
    const dayCount = Array.isArray(days.days) ? days.days.length : 0;
    const sourceCounts = dashboardSourceCounts(days);
    checks.push(
      html.toLowerCase().includes("nutshell")
        ? pass("dashboard page HTML loads from installed command", { url, bytes: html.length })
        : fail("dashboard page HTML loads from installed command", { url, bytes: html.length, preview: html.slice(0, 500) }),
    );
    checks.push(pass("dashboard status API serves installed product", { url, product: status.product as string, version: status.version as string }));
    checks.push(dayCount > 0 ? pass("dashboard days API shows trace records", { dayCount }) : fail("dashboard days API shows trace records", { dayCount }));
    for (const source of requiredSources) {
      const count = sourceCounts[source] ?? 0;
      checks.push(count > 0 ? pass(`dashboard shows ${source} trace records`, { source, count }) : fail(`dashboard shows ${source} trace records`, { source, count, sourceCounts }));
    }
  } catch (error) {
    checks.push(fail("dashboard serves status and trace data", { url, error: String(error) }));
  } finally {
    proc.kill("SIGTERM");
    await Promise.race([proc.exited, delay(2_000)]);
    if (!(await exited(proc))) proc.kill("SIGKILL");
  }
  return {
    checks,
    evidence: {
      url,
      stdout: (await stdoutPromise.catch(() => "")).trim().slice(0, 1000),
      stderr: (await stderrPromise.catch(() => "")).trim().slice(0, 1000),
    },
  };
}

function dashboardSourceCounts(days: JsonObject): Record<string, number> {
  const counts: Record<string, number> = {};
  const dayItems = Array.isArray(days.days) ? days.days : [];
  for (const day of dayItems) {
    if (!day || typeof day !== "object" || Array.isArray(day)) continue;
    const sources = (day as JsonObject).sources;
    if (!sources || typeof sources !== "object" || Array.isArray(sources)) continue;
    for (const [source, cards] of Object.entries(sources)) {
      if (!Array.isArray(cards)) continue;
      counts[source] = (counts[source] ?? 0) + cards.length;
    }
  }
  return counts;
}

async function waitForDashboardJson(url: string, proc: Bun.Subprocess<"ignore", "pipe", "pipe">, timeoutMs: number): Promise<JsonObject> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await exited(proc)) break;
    try {
      return await fetchJson(url);
    } catch {
      await delay(250);
    }
  }
  throw new Error(`dashboard did not answer ${url} within ${timeoutMs}ms`);
}

async function fetchJson(url: string): Promise<JsonObject> {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return (await response.json()) as JsonObject;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return await response.text();
}

async function exited(proc: Bun.Subprocess<"ignore", "pipe", "pipe">): Promise<boolean> {
  return Promise.race([proc.exited.then(() => true), delay(0).then(() => false)]);
}

export function makeRehearsalReport(phase: string, checks: RehearsalCheck[], evidence: JsonObject): RehearsalReport {
  const pass = !checks.some((check) => check.status === "fail");
  return {
    generatedAt: new Date().toISOString(),
    phase,
    status: pass ? "pass" : "fail",
    contract: contractForPhase(phase, pass, evidence),
    checks,
    evidence,
  };
}

function reportFor(phase: string, checks: RehearsalCheck[], evidence: JsonObject): RehearsalReport {
  return makeRehearsalReport(phase, checks, evidence);
}

function contractForPhase(phase: string, phasePassed: boolean, evidence: JsonObject): RehearsalContract {
  const expected = expectedContractForPhase(phase);
  const diagnosticAction = typeof evidence.diagnosticAction === "string" ? evidence.diagnosticAction : null;
  const blockerKind = phasePassed && !diagnosticAction ? "none" : blockerKindForPhase(phase, evidence, diagnosticAction);
  return {
    ...expected,
    observedState: phasePassed ? expected.expectedState : observedStateForFailedPhase(phase, evidence),
    pass: phasePassed && !diagnosticAction,
    blockerKind,
    diagnosticAction,
  };
}

function expectedContractForPhase(phase: string): Omit<RehearsalContract, "observedState" | "pass" | "blockerKind" | "diagnosticAction"> {
  switch (phase) {
    case "clean-state":
      return { userStory: "Fresh user starts without old Nutshell app, state, permissions, agents, or browser auth.", expectedState: "clean_baseline", source: "system" };
    case "host-preflight":
      return { userStory: "The host has every private input required before a strict VM rehearsal starts.", expectedState: "ready_empty", source: "system" };
    case "published-install":
    case "installed-product":
      return { userStory: "Fresh user installs the public release artifact and sees the installed app/CLI.", expectedState: "installed", source: "system" };
    case "pre-permission-app-state":
      return { userStory: "Before permission grant, the app does not reuse stale Full Disk Access.", expectedState: "needs_permission", source: "system" };
    case "unauthenticated-browser-state":
      return { userStory: "Signed-out browser-backed sources fail explicitly as missing auth.", expectedState: "needs_auth", source: "all" };
    case "browser-login-handoff":
      return { userStory: "User signs into Google and X in the VM browser profile.", expectedState: "handoff", source: "all" };
    case "browser-auth-seed-restore":
      return { userStory: "A declared private browser auth seed establishes Google and X signed-in state without repeated user login.", expectedState: "handoff", source: "all" };
    case "authenticated-browser-state":
      return { userStory: "Signed-in browser-backed sources are usable without keychain or Safe Storage failures.", expectedState: "ready_empty", source: "all" };
    case "stage-podcast-seed":
      return { userStory: "Apple Podcasts uses a declared SQLite-safe seed through the normal plugin path.", expectedState: "ready_empty", source: "podcasts" };
    case "setup-flow":
      return { userStory: "Setup grants permissions to Nutshell.app and enables app-owned background sync.", expectedState: "ready_empty", source: "system" };
    case "provider-archive-imports":
      return { userStory: "Official provider archives import through public import commands.", expectedState: "ready_with_data", source: "all" };
    case "local-provider-imports":
      return { userStory: "Official provider archives import in an isolated local root without VM UI.", expectedState: "ready_with_data", source: "all" };
    case "apple-notes-handoff":
      return { userStory: "User allows Notes automation for the installed app path.", expectedState: "handoff", source: "apple_notes" };
    case "foreground-sync":
      return { userStory: "Foreground sync produces live records for every enabled source.", expectedState: "ready_with_data", source: "all" };
    case "background-sync":
      return { userStory: "The app-owned background agent runs a scheduled sync.", expectedState: "ready_with_data", source: "all" };
    case "final-release-state":
      return { userStory: "Final health and dashboard prove all enabled sources are healthy with real trace data.", expectedState: "ready_with_data", source: "all" };
    case "complete":
      return { userStory: "The aggregate audit verifies the whole release rehearsal.", expectedState: "complete", source: "all" };
    default:
      return { userStory: "Release rehearsal phase completes without hidden local shortcuts.", expectedState: "complete", source: "system" };
  }
}

function observedStateForFailedPhase(phase: string, evidence: JsonObject): RehearsalContract["observedState"] {
  if (phase.includes("auth") || phase.includes("browser")) {
    const states = [evidence.youtubeState, evidence.twitterState].filter((value): value is RehearsalSourceState => typeof value === "string");
    if (states.includes("blocked_bug")) return "blocked_bug";
    if (states.includes("needs_auth")) return "needs_auth";
  }
  if (phase.includes("permission") || phase.includes("setup") || phase.includes("notes")) return "needs_permission";
  if (phase.includes("import") || phase.includes("preflight")) return "blocked_bug";
  return "blocked_bug";
}

function blockerKindForPhase(phase: string, evidence: JsonObject, diagnosticAction: string | null): RehearsalBlockerKind {
  if (diagnosticAction) return "diagnostic_only";
  const text = JSON.stringify(evidence);
  if (/missing|not found|export|archive|seed/i.test(text)) return "missing_input";
  if (/permission|Full Disk Access|automation|not authorized/i.test(text)) return "permission";
  if (/auth|cookie|signed.?out|login/i.test(text)) return "auth";
  if (/clean|install|release|published|Homebrew/i.test(phase + text)) return "release_process";
  return "product_bug";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
