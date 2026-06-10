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

// Three-way gate verdict (honest-setup criterion 27; docs/release-validation-gates.md
// "Verdicts"): product_fail implicates the installed candidate, harness_fail
// implicates the gate machinery only, and fixture_stale queues the gate behind
// a fixture refresh without failing the candidate.
export type RehearsalVerdict = "pass" | "product_fail" | "harness_fail" | "fixture_stale";

export interface RehearsalReport {
  generatedAt: string;
  phase: string;
  // "blocked" is the fixture_stale status: the gate neither passed nor failed
  // the candidate — it is queued until the fixture is refreshed.
  status: "pass" | "fail" | "blocked";
  // Absent on legacy reports written before the verdict contract existed;
  // readers go through reportVerdict(), which derives a verdict from status.
  verdict?: RehearsalVerdict;
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
  // Probe an already-running dashboard at this base URL instead of spawning
  // `nutshell dashboard` (test seam, same idea as runner/cookieProbe).
  dashboardUrl?: string;
}

export interface PermissionsVerificationOptions {
  mode: "pre" | "post";
  runner?: CommandRunner;
  env?: Record<string, string>;
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
// were split into one code per user state. These lists are the auth-probe
// failure codes the signed-in gate must NOT see after login; the blocked-probe
// codes (youtube_activity_unreadable, twitter_session_check_failed) were
// dropped from them after v0.1.23 — those are blocked_bug states, and the
// signed-in gate already fails them as critical source findings.
const YOUTUBE_AUTH_PROBE_CODES = ["youtube_signed_out", "youtube_keychain_blocked"];
const TWITTER_AUTH_PROBE_CODES = ["twitter_signed_out", "twitter_keychain_blocked"];
// Signed-out gate acceptance (gates doc "Signed-Out Browser Gate"): only the
// explicit signed-out classification proves the product told a signed-out
// user to sign in. Keychain-blocked codes are deliberately excluded — a
// keychain block in the signed-out gate is a blocked probe, not a pass — and
// the blocked-probe codes the v0.1.23 gate wrongly accepted
// (twitter_session_check_failed, youtube_activity_unreadable) are out too.
const YOUTUBE_SIGNED_OUT_ACCEPTED_CODES = ["youtube_signed_out"];
const TWITTER_SIGNED_OUT_ACCEPTED_CODES = ["twitter_signed_out"];
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
const PERMISSIONS_PRE_PHASE = "permissions-pre";
const PERMISSIONS_POST_PHASE = "permissions-post";
const LIVE_SYNC_DASHBOARD_PHASE = "live-sync-dashboard";
// Phases whose fixture_stale verdict queues the release (honest-setup
// criterion 23): the full-rehearsal phases plus the standalone snapshot gates.
const REQUIRED_GATE_PHASES = new Set<string>([
  ...REQUIRED_FULL_REHEARSAL_PHASES,
  ...AUTH_PRESENT_BROWSER_SETUP_PHASES,
  PERMISSIONS_PRE_PHASE,
  PERMISSIONS_POST_PHASE,
  LIVE_SYNC_DASHBOARD_PHASE,
]);
// Cookie names that prove the auth-present fixture is still signed in
// (docs/release-validation-gates.md "Fixture preflight").
const GOOGLE_FIXTURE_AUTH_COOKIES = ["SAPISID", "__Secure-1PSID"];
const X_FIXTURE_AUTH_COOKIES = ["auth_token"];
const APP_PERMISSION_ROOT_CAUSE_CODES = ["nutshell_app_full_disk_access_missing", "nutshell_app_missing"];
// Standing warnings the live-sync gate tolerates (v0.1.24 frozen evidence).
// The split live-sync gate deliberately runs WITHOUT archive imports, so the
// coverage warnings against the configured cutoff (backfill_incomplete /
// backfill_partial, guidance.state ready_empty) are structural —
// health.status "ok" is unsatisfiable here by design. last_run_partial and
// the twitter enrichment warnings cover the enrichment backlog that drains
// asynchronously after a big first sync; app_owned_sync_not_verified clears
// on the next scheduled app-owned run. The strict status==="ok" and
// zero-findings requirement stays in verifyFinalReleaseState, where archive
// imports HAVE run.
const LIVE_SYNC_STANDING_WARNING_CODES = new Set([
  "backfill_incomplete",
  "backfill_partial",
  "last_run_partial",
  "twitter_enrichment_pending",
  "twitter_enrichment_failed",
  "app_owned_sync_not_verified",
]);
// The dashboard's /api/days defaults to the product's 7-day reader window,
// but the podcasts seed is a frozen snapshot whose newest listen can be
// arbitrarily old — querying the default window hid the seed records and
// failed the v0.1.24 gate against a healthy product. The harness explicitly
// requests a wider window through the API's `from` parameter; the product's
// default window is deliberately left untouched.
const DASHBOARD_DAYS_WINDOW_DAYS = 60;
// The staged post-permission session seeds exactly three notes
// (docs/post-permission-snapshot-session.md step 7).
const SEEDED_NOTE_COUNT = 3;

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
  return classifiedPhase("clean-state", () => verifyCleanStateChecks(options));
}

async function verifyCleanStateChecks(options: RehearsalOptions): Promise<RehearsalReport> {
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
  return classifiedPhase("installed-product", () => verifyInstalledProductChecks(options));
}

async function verifyInstalledProductChecks(options: RehearsalOptions): Promise<RehearsalReport> {
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
  return classifiedPhase("unauthenticated-browser-state", () => verifyUnauthenticatedBrowserStateChecks(options));
}

async function verifyUnauthenticatedBrowserStateChecks(options: RehearsalOptions): Promise<RehearsalReport> {
  const runner = options.runner ?? runCommand;
  const env = normalizedEnv(options.env);
  const youtube = await runJsonCommand<HealthReport>(["nutshell", "doctor", "youtube", "--json"], runner, env, 60_000);
  const twitter = await runJsonCommand<HealthReport>(["nutshell", "doctor", "twitter", "--json"], runner, env, 60_000);
  const checks = [
    jsonCommandCheck("youtube doctor returns JSON while signed out", youtube),
    signedOutStateCheck("youtube signed-out state is explicit", youtube.value, YOUTUBE_SIGNED_OUT_ACCEPTED_CODES),
    jsonCommandCheck("twitter doctor returns JSON while signed out", twitter),
    signedOutStateCheck("twitter signed-out state is explicit", twitter.value, TWITTER_SIGNED_OUT_ACCEPTED_CODES),
  ];
  return reportFor("unauthenticated-browser-state", checks, {
    youtubeExitCode: youtube.result.code,
    twitterExitCode: twitter.result.code,
    youtubeState: classifySourceState({ health: youtube.value, source: "youtube" }),
    twitterState: classifySourceState({ health: twitter.value, source: "twitter" }),
  });
}

export async function verifyAuthenticatedBrowserState(options: RehearsalOptions = {}): Promise<RehearsalReport> {
  return classifiedPhase("authenticated-browser-state", () => verifyAuthenticatedBrowserStateChecks(options));
}

async function verifyAuthenticatedBrowserStateChecks(options: RehearsalOptions): Promise<RehearsalReport> {
  const runner = options.runner ?? runCommand;
  const env = normalizedEnv(options.env);
  const browser = mergeBrowser(options.browser);
  const googleCookies = await browserProbeResult(options.cookieProbe?.google ? options.cookieProbe.google() : googleCookieProbe(browser));
  const xCookies = await browserProbeResult(options.cookieProbe?.x ? options.cookieProbe.x() : xCookieProbe(browser));
  const preflight = fixturePreflight(googleCookies, xCookies);
  if (!preflight.healthy) return fixtureStaleReport("authenticated-browser-state", preflight.check, googleCookies, xCookies);
  const youtube = await runJsonCommand<HealthReport>(["nutshell", "doctor", "youtube", "--json"], runner, env, 60_000);
  const twitter = await runJsonCommand<HealthReport>(["nutshell", "doctor", "twitter", "--json"], runner, env, 60_000);
  const checks = [
    preflight.check,
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
  return classifiedPhase("final-release-state", () => verifyFinalReleaseStateChecks(options));
}

async function verifyFinalReleaseStateChecks(options: FinalVerificationOptions): Promise<RehearsalReport> {
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
  const dashboard = options.startDashboard === false ? null : await verifyDashboard(runner, env, options.dashboardTimeoutMs ?? 30_000, requiredSources, options.dashboardUrl);
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
  return classifiedPhase("host-preflight", () => verifyHostPreflightChecks(options));
}

async function verifyHostPreflightChecks(options: HostPreflightOptions): Promise<RehearsalReport> {
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
  return classifiedPhase("local-provider-imports", () => verifyLocalProviderImportsChecks(options));
}

async function verifyLocalProviderImportsChecks(options: LocalProviderImportOptions): Promise<RehearsalReport> {
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

// Permissions gate (honest-setup criterion 25; gates doc "Permissions Gate").
// pre: runs inside a clone of the auth-present snapshot with the release
// installed and Full Disk Access never granted. macOS reality (encoded from
// the v0.1.23 VM evidence): Chrome's cookie store is NOT
// Full-Disk-Access-protected, so the youtube/twitter probes legitimately pass
// pre-grant in an auth-present VM, and a fresh VM has no Apple Podcasts
// library, so podcasts honestly reports its no-library state instead of an
// FDA finding. The pre contract is therefore per source: the Nutshell.app
// root cause leads with needs_permission; apple_notes must report a
// source-level needs_permission finding (AppleEvent -1712 consent timeouts
// classify as apple_notes_automation_permission_required) with non-empty fix
// and confirm text; podcasts must report needs_permission OR the honest
// no-library state (podcasts_db_missing / guidance.state ready_empty); and
// youtube/twitter must only be classified honestly — every finding they emit
// carries guidance, with no needs_permission requirement. post: runs
// inside a clone of the staged post-permission snapshot
// (docs/post-permission-snapshot-session.md) — doctor must be clean of
// needs_permission findings, the app status block must show Full Disk Access
// granted, and the three seeded notes must be visible through the app.
export async function verifyPermissionsState(options: PermissionsVerificationOptions): Promise<RehearsalReport> {
  const phase = options.mode === "pre" ? PERMISSIONS_PRE_PHASE : PERMISSIONS_POST_PHASE;
  return classifiedPhase(phase, () => verifyPermissionsStateChecks(phase, options));
}

async function verifyPermissionsStateChecks(phase: string, options: PermissionsVerificationOptions): Promise<RehearsalReport> {
  const runner = options.runner ?? runCommand;
  const env = normalizedEnv(options.env);
  const doctor = await runJsonCommand<HealthReport>(["nutshell", "doctor", "--json"], runner, env, 120_000);
  const findingCodes = (doctor.value?.findings ?? []).map((finding) => `${finding.source}/${finding.code}`);
  if (options.mode === "pre") {
    const checks: RehearsalCheck[] = [
      jsonCommandCheck("doctor returns JSON before permission grants", doctor),
      appPermissionRootCauseCheck(doctor.value),
      needsPermissionBeforeGrantCheck("apple_notes", doctor.value),
      podcastsPreGrantStateCheck(doctor.value),
      browserSourceHonestClassificationCheck("youtube", doctor.value),
      browserSourceHonestClassificationCheck("twitter", doctor.value),
    ];
    return reportFor(phase, checks, {
      mode: options.mode,
      doctorExitCode: doctor.result.code,
      findingCodes,
      preGrantContract: {
        apple_notes: "needs_permission",
        podcasts: "needs_permission_or_no_library",
        youtube: "honest_classification_only",
        twitter: "honest_classification_only",
      },
    });
  }
  const notesSync = await runJsonCommand<JsonObject>(["nutshell", "sync", "apple_notes", "--json"], runner, env, 10 * 60_000);
  const checks: RehearsalCheck[] = [
    jsonCommandCheck("doctor returns JSON after permission grants", doctor),
    zeroNeedsPermissionCheck(doctor.value),
    fullDiskAccessGrantedCheck(doctor.value),
    seededNotesVisibleCheck(notesSync.value),
  ];
  return reportFor(phase, checks, {
    mode: options.mode,
    doctorExitCode: doctor.result.code,
    findingCodes,
    notesSyncExitCode: notesSync.result.code,
  });
}

// Live-sync/dashboard gate (honest-setup criterion 26; gates doc "Live Sync
// And Dashboard Gate"). Runs headlessly from a clone of the post-permission
// snapshot with the same cookie fixture preflight as the signed-in gate: a
// stale fixture short-circuits with verdict fixture_stale before any product
// assertion runs.
export async function verifyLiveSyncAndDashboard(options: FinalVerificationOptions = {}): Promise<RehearsalReport> {
  return classifiedPhase(LIVE_SYNC_DASHBOARD_PHASE, () => verifyLiveSyncAndDashboardChecks(options));
}

async function verifyLiveSyncAndDashboardChecks(options: FinalVerificationOptions): Promise<RehearsalReport> {
  const runner = options.runner ?? runCommand;
  const env = normalizedEnv(options.env);
  const browser = mergeBrowser(options.browser);
  const requiredSources = options.requireSources ?? REQUIRED_SOURCES;
  const googleCookies = await browserProbeResult(options.cookieProbe?.google ? options.cookieProbe.google() : googleCookieProbe(browser));
  const xCookies = await browserProbeResult(options.cookieProbe?.x ? options.cookieProbe.x() : xCookieProbe(browser));
  const preflight = fixturePreflight(googleCookies, xCookies);
  if (!preflight.healthy) return fixtureStaleReport(LIVE_SYNC_DASHBOARD_PHASE, preflight.check, googleCookies, xCookies);

  const sync = await runJsonCommand<JsonObject>(["nutshell", "sync", "all", "--json"], runner, env, 30 * 60_000);
  const health = await runJsonCommand<HealthReport>(["nutshell", "health", "--json"], runner, env, 120_000);
  const checks: RehearsalCheck[] = [
    preflight.check,
    jsonCommandCheck("live sync command returns JSON", sync),
    liveCommitRecordsCheck("youtube", sync.value),
    liveCommitRecordsCheck("twitter", sync.value),
    podcastsSeedSyncCheck(sync.value),
    appleNotesLiveRecordsCheck(sync.value),
    jsonCommandCheck("final health command returns JSON", health),
    liveHealthCheck(health.value),
  ];
  const dashboard = options.startDashboard === false ? null : await verifyDashboard(runner, env, options.dashboardTimeoutMs ?? 30_000, requiredSources, options.dashboardUrl);
  if (dashboard) checks.push(...dashboard.checks);
  return reportFor(LIVE_SYNC_DASHBOARD_PHASE, checks, {
    syncExitCode: sync.result.code,
    healthExitCode: health.result.code,
    liveCommits: liveCommitCounts(sync.value),
    healthStatus: health.value?.status ?? null,
    browserWarnings: {
      google: googleCookies.warnings,
      x: xCookies.warnings,
    },
    dashboard: dashboard?.evidence ?? {},
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
  // A missing or unparsable report file is harness breakage (the harness wrote
  // the file), not a product failure — label it harness_fail (criterion 27).
  if (!existsSync(resolved)) {
    return reportFor("aggregate-report-audit", [fail("fresh-install report exists", { path: resolved })], { path: resolved }, "harness_fail");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolved, "utf8"));
  } catch (error) {
    return reportFor("aggregate-report-audit", [fail("fresh-install report parses as JSON", { path: resolved, error: String(error) })], { path: resolved }, "harness_fail");
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

  // Criterion 23: a required gate queued on a stale fixture must never
  // validate the release — but it is queued, not failed. The check name keeps
  // that distinct from product failure; the queue clears with a fixture
  // refresh, never with a product fix.
  const queuedRuns = runs.filter((run) => REQUIRED_GATE_PHASES.has(run.phase) && reportVerdict(run) === "fixture_stale");
  if (queuedRuns.length) {
    for (const run of queuedRuns) {
      checks.push(
        fail(`required gate queued: ${run.phase} (fixture_stale)`, {
          phase: run.phase,
          verdict: "fixture_stale",
          reason: "fixture refresh required before this gate can produce release evidence",
        }),
      );
    }
  } else {
    checks.push(pass("no required gate is queued on a stale fixture", { phaseCount: runs.length }));
  }

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

  // The audit's own verdict: when the only non-passing runs are queued
  // fixture_stale gates, the release is blocked behind a fixture refresh —
  // verdict fixture_stale, not product_fail (the candidate is not implicated).
  // Any other failing check classifies product_fail by the default rule.
  const queuedOnly = queuedRuns.length > 0 && failedRuns.every((run) => reportVerdict(run) === "fixture_stale");
  return reportFor(
    "aggregate-report-audit",
    checks,
    {
      path,
      phaseCount: runs.length,
      requiredPhases: [...REQUIRED_FULL_REHEARSAL_PHASES],
      authPresentBrowserSetupPhases: [...AUTH_PRESENT_BROWSER_SETUP_PHASES],
      queuedPhases: queuedRuns.map((run) => run.phase),
    },
    queuedOnly ? "fixture_stale" : undefined,
  );
}

// Legacy reports written before the three-way verdict contract (criterion 27)
// carry no verdict field. Derive one from status: those reports recorded "fail"
// only for failed product assertions (harness breakage crashed the run instead
// of writing a report), so fail → product_fail; "blocked" was introduced
// together with verdicts but maps to fixture_stale defensively; pass → pass.
export function reportVerdict(report: RehearsalReport): RehearsalVerdict {
  if (report.verdict) return report.verdict;
  if (report.status === "blocked") return "fixture_stale";
  return report.status === "pass" ? "pass" : "product_fail";
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

// Signed-out gate contract: an accepted signed-out code must be present, and
// every matched finding that carries guidance must classify the state as
// needs_auth. A signed-out-coded finding with blocked_bug or needs_permission
// guidance is a blocked probe wearing an auth label, not signed-out proof.
function signedOutStateCheck(name: string, health: HealthReport | null, acceptedCodes: string[]): RehearsalCheck {
  if (!health) return fail(name, { reason: "missing_health_json" });
  const codes = health.findings.map((finding) => finding.code);
  const matchedFindings = health.findings.filter((finding) => acceptedCodes.includes(finding.code));
  if (!matchedFindings.length) {
    return fail(name, { acceptedCodes, codes, observedState: classifySourceState({ health, source: "system" }) });
  }
  const misguided = matchedFindings.flatMap((finding) =>
    finding.guidance && finding.guidance.state !== "needs_auth" ? [{ code: finding.code, guidanceState: finding.guidance.state }] : [],
  );
  if (misguided.length) {
    return fail(name, { reason: "matched_guidance_not_needs_auth", misguided, codes, acceptedCodes });
  }
  return pass(name, { matched: matchedFindings.map((finding) => finding.code), codes, observedState: "needs_auth" });
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

function appPermissionRootCauseCheck(health: HealthReport | null): RehearsalCheck {
  const name = "app permission root cause is reported";
  if (!health) return fail(name, { reason: "missing_health_json" });
  const matched = health.findings.filter((finding) => APP_PERMISSION_ROOT_CAUSE_CODES.includes(finding.code)).map((finding) => finding.code);
  return matched.length
    ? pass(name, { matched })
    : fail(name, { acceptedCodes: APP_PERMISSION_ROOT_CAUSE_CODES, codes: health.findings.map((finding) => `${finding.source}/${finding.code}`) });
}

function needsPermissionBeforeGrantCheck(source: SourceId, health: HealthReport | null): RehearsalCheck {
  const name = `${source} reports needs_permission before grants`;
  if (!health) return fail(name, { source, reason: "missing_health_json" });
  const sourceFindings = health.findings.filter((finding) => finding.source === source);
  const needsPermission = sourceFindings.filter((finding) => finding.guidance?.state === "needs_permission");
  if (!needsPermission.length) {
    // A permission-gated source with no problem finding before any grant is
    // fake-ready: the product claims usability it cannot have (criterion 25).
    // This applies to apple_notes and podcasts only — browser sources go
    // through browserSourceHonestClassificationCheck instead, because their
    // probes can genuinely pass pre-grant.
    return fail(name, {
      source,
      reason: sourceFindings.length ? "no_needs_permission_finding" : "fake_ready",
      codes: sourceFindings.map((finding) => finding.code),
    });
  }
  const missingGuidance = needsPermission.filter((finding) => !finding.guidance?.fix?.trim() || !finding.guidance?.confirm?.trim());
  return missingGuidance.length
    ? fail(name, { source, reason: "missing_fix_or_confirm", codes: missingGuidance.map((finding) => finding.code) })
    : pass(name, { source, codes: needsPermission.map((finding) => finding.code) });
}

// Podcasts pre-grant contract: EITHER blocked by permission (FDA-related
// podcasts findings only appear when a protected library exists) OR honestly
// empty — a fresh VM has no Apple Podcasts library, so podcasts_db_missing
// with guidance.state ready_empty is the truthful pre-grant answer there. A
// pre-grant podcasts pass with zero findings is still fake-ready: on a fresh
// VM the probe cannot genuinely succeed, so one of the two states must show.
function podcastsPreGrantStateCheck(health: HealthReport | null): RehearsalCheck {
  const name = "podcasts reports needs_permission or an honest empty library before grants";
  if (!health) return fail(name, { source: "podcasts", reason: "missing_health_json" });
  const sourceFindings = health.findings.filter((finding) => finding.source === "podcasts");
  const needsPermission = sourceFindings.filter((finding) => finding.guidance?.state === "needs_permission");
  if (needsPermission.length) {
    const missingGuidance = needsPermission.filter((finding) => !finding.guidance?.fix?.trim() || !finding.guidance?.confirm?.trim());
    return missingGuidance.length
      ? fail(name, { source: "podcasts", reason: "missing_fix_or_confirm", codes: missingGuidance.map((finding) => finding.code) })
      : pass(name, { source: "podcasts", observedState: "needs_permission", codes: needsPermission.map((finding) => finding.code) });
  }
  const noLibrary = sourceFindings.filter((finding) => finding.code === "podcasts_db_missing" || finding.guidance?.state === "ready_empty");
  if (noLibrary.length) {
    return pass(name, { source: "podcasts", observedState: "ready_empty", codes: noLibrary.map((finding) => finding.code) });
  }
  return fail(name, {
    source: "podcasts",
    reason: sourceFindings.length ? "no_needs_permission_or_no_library_finding" : "fake_ready",
    codes: sourceFindings.map((finding) => finding.code),
  });
}

// Browser-backed sources read Chrome's cookie store, which is NOT
// Full-Disk-Access-protected on macOS — their probes legitimately pass
// pre-grant in an auth-present VM (v0.1.23 evidence), so the gate requires no
// needs_permission finding from them. What it does require is honesty: every
// finding they emit must carry guidance with non-empty fix and confirm text.
// A source-level finding with no or empty guidance is fake and fails.
function browserSourceHonestClassificationCheck(source: SourceId, health: HealthReport | null): RehearsalCheck {
  const name = `${source} pre-grant findings are honestly classified`;
  if (!health) return fail(name, { source, reason: "missing_health_json" });
  const sourceFindings = health.findings.filter((finding) => finding.source === source);
  const unguided = sourceFindings
    .filter((finding) => !finding.guidance || !finding.guidance.fix.trim() || !finding.guidance.confirm.trim())
    .map((finding) => finding.code);
  return unguided.length
    ? fail(name, { source, reason: "unguided_findings", codes: unguided })
    : pass(name, { source, codes: sourceFindings.map((finding) => finding.code) });
}

function zeroNeedsPermissionCheck(health: HealthReport | null): RehearsalCheck {
  const name = "doctor reports zero needs_permission findings after grants";
  if (!health) return fail(name, { reason: "missing_health_json" });
  const needsPermission = health.findings.filter((finding) => finding.guidance?.state === "needs_permission");
  return needsPermission.length
    ? fail(name, { codes: needsPermission.map((finding) => `${finding.source}/${finding.code}`) })
    : pass(name, { findingCount: health.findings.length });
}

function fullDiskAccessGrantedCheck(health: HealthReport | null): RehearsalCheck {
  const name = "app status shows Full Disk Access granted to Nutshell.app";
  if (!health) return fail(name, { reason: "missing_health_json" });
  const app = health.app;
  return app?.installed && app.fullDiskAccess === "granted"
    ? pass(name, { path: app.path, fullDiskAccess: app.fullDiskAccess })
    : fail(name, { app: (app ?? {}) as unknown as JsonObject });
}

// Seeded-notes proof choice (criterion 25 post mode): `nutshell sync
// apple_notes --json` over doctor. The sync report's apple_notes
// metrics.uniqueNotes is the existing harness primitive for note visibility
// (the same field the foreground-sync phase asserts on), and it proves the
// three staged notes are readable through the app identity even on a re-run
// clone where the records were already committed (commit.insertedRecords would
// be 0 there). Doctor-without-critical-findings would only prove the Notes
// automation channel works, not that the seeded notes are visible.
function seededNotesVisibleCheck(sync: JsonObject | null): RehearsalCheck {
  const name = "seeded Apple Notes are visible through the app";
  const sourceReport = syncSourceFor(sync, "apple_notes");
  if (!sourceReport) return fail(name, { reason: "missing_source_report" });
  const status = typeof sourceReport.status === "string" ? sourceReport.status : "unknown";
  const metrics = sourceReport.metrics && typeof sourceReport.metrics === "object" && !Array.isArray(sourceReport.metrics) ? (sourceReport.metrics as JsonObject) : {};
  const uniqueNotes = typeof metrics.uniqueNotes === "number" && Number.isFinite(metrics.uniqueNotes) ? metrics.uniqueNotes : 0;
  return status === "ok" && uniqueNotes >= SEEDED_NOTE_COUNT
    ? pass(name, { status, uniqueNotes, expectedAtLeast: SEEDED_NOTE_COUNT })
    : fail(name, { status, uniqueNotes, expectedAtLeast: SEEDED_NOTE_COUNT });
}

// SyncReport (src/core/types.ts) over --json: sources[] each carry status,
// metrics, and commit { insertedRecords }. The per-source commit count is the
// live-ingestion proof; store totals are deliberately not used because they
// can include archive-imported records (gates doc: imports must not stand in
// for live signed-in sync records).
function syncSourceFor(sync: JsonObject | null, source: SourceId): JsonObject | null {
  if (!sync) return null;
  const sources = Array.isArray(sync.sources) ? sync.sources : [];
  for (const item of sources) {
    if (item && typeof item === "object" && !Array.isArray(item) && (item as JsonObject).source === source) return item as JsonObject;
  }
  return null;
}

function commitInsertedRecords(sourceReport: JsonObject | null): number {
  const commit = sourceReport?.commit;
  if (!commit || typeof commit !== "object" || Array.isArray(commit)) return 0;
  const inserted = (commit as JsonObject).insertedRecords;
  return typeof inserted === "number" && Number.isFinite(inserted) ? inserted : 0;
}

function liveCommitRecordsCheck(source: SourceId, sync: JsonObject | null): RehearsalCheck {
  const name = `live sync committed ${source} records`;
  const sourceReport = syncSourceFor(sync, source);
  if (!sourceReport) return fail(name, { source, reason: "missing_source_report" });
  const status = typeof sourceReport.status === "string" ? sourceReport.status : "unknown";
  const insertedRecords = commitInsertedRecords(sourceReport);
  if (status !== "ok") return fail(name, { source, status, insertedRecords, reason: `source_status_${status}` });
  return insertedRecords > 0
    ? pass(name, { source, status, insertedRecords })
    : fail(name, { source, status, insertedRecords, reason: "no_live_records_committed" });
}

function podcastsSeedSyncCheck(sync: JsonObject | null): RehearsalCheck {
  const name = "podcasts seed syncs through the normal plugin path";
  const sourceReport = syncSourceFor(sync, "podcasts");
  if (!sourceReport) return fail(name, { reason: "missing_source_report" });
  const status = typeof sourceReport.status === "string" ? sourceReport.status : "unknown";
  return status === "ok"
    ? pass(name, { status, insertedRecords: commitInsertedRecords(sourceReport) })
    : fail(name, { status, findings: Array.isArray(sourceReport.findings) ? sourceReport.findings.slice(0, 5) : [] });
}

function appleNotesLiveRecordsCheck(sync: JsonObject | null): RehearsalCheck {
  const name = "apple_notes sync produced note records";
  const sourceReport = syncSourceFor(sync, "apple_notes");
  if (!sourceReport) return fail(name, { reason: "missing_source_report" });
  const status = typeof sourceReport.status === "string" ? sourceReport.status : "unknown";
  const insertedRecords = commitInsertedRecords(sourceReport);
  return status === "ok" && insertedRecords > 0
    ? pass(name, { status, insertedRecords })
    : fail(name, { status, insertedRecords, reason: status === "ok" ? "no_note_records_committed" : `source_status_${status}` });
}

// Live-sync gate health contract (see LIVE_SYNC_STANDING_WARNING_CODES): the
// gate runs without archive imports, so it cannot require health.status "ok".
// What it requires instead: ZERO critical findings, a green app block (Full
// Disk Access granted, background sync enabled, agent enabled), and every
// warning present drawn from the allowed standing set. Any critical, or any
// warning outside that set, fails the gate.
function liveHealthCheck(health: HealthReport | null): RehearsalCheck {
  const name = "final health has no critical findings, only standing warnings, and a green app block";
  if (!health) return fail(name, { reason: "missing_health_json" });
  const failures: string[] = [];
  const criticalFindings = health.findings.filter((finding) => finding.level === "critical").map((finding) => `${finding.source}/${finding.code}`);
  if (criticalFindings.length) failures.push("critical_findings_present");
  const nonStandingWarnings = health.findings
    .filter((finding) => finding.level !== "critical" && !LIVE_SYNC_STANDING_WARNING_CODES.has(finding.code))
    .map((finding) => `${finding.source}/${finding.code}`);
  if (nonStandingWarnings.length) failures.push("non_standing_warnings_present");
  if (health.app?.fullDiskAccess !== "granted") failures.push("full_disk_access_not_granted");
  if (health.app?.backgroundSync !== "enabled") failures.push("background_sync_not_enabled");
  if (health.app?.agent !== "enabled") failures.push("agent_not_enabled");
  if (failures.length) {
    return fail(name, {
      failures,
      criticalFindings,
      nonStandingWarnings,
      allowedStandingWarnings: [...LIVE_SYNC_STANDING_WARNING_CODES],
      status: health.status,
      app: (health.app ?? {}) as unknown as JsonObject,
    });
  }
  return pass(name, {
    status: health.status,
    standingWarnings: health.findings.map((finding) => `${finding.source}/${finding.code}`),
    fullDiskAccess: health.app.fullDiskAccess,
    backgroundSync: health.app.backgroundSync,
    agent: health.app.agent,
  });
}

function liveCommitCounts(sync: JsonObject | null): JsonObject {
  const counts: JsonObject = {};
  for (const source of REQUIRED_SOURCES) counts[source] = commitInsertedRecords(syncSourceFor(sync, source));
  return counts;
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
    (item.status === "pass" || item.status === "fail" || item.status === "blocked") &&
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
  externalUrl?: string,
): Promise<{ checks: RehearsalCheck[]; evidence: JsonObject }> {
  const daysRequestPath = dashboardDaysRequestPath();
  if (externalUrl) {
    const checks: RehearsalCheck[] = [];
    try {
      const status = await fetchJson(new URL("/api/status", externalUrl).toString());
      checks.push(...(await dashboardContentChecks(externalUrl, status, daysRequestPath, requiredSources)));
    } catch (error) {
      checks.push(fail("dashboard serves status and trace data", { url: externalUrl, error: String(error) }));
    }
    return { checks, evidence: { url: externalUrl, daysRequestPath, stdout: "", stderr: "" } };
  }
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
    checks.push(...(await dashboardContentChecks(url, status, daysRequestPath, requiredSources)));
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
      daysRequestPath,
      stdout: (await stdoutPromise.catch(() => "")).trim().slice(0, 1000),
      stderr: (await stderrPromise.catch(() => "")).trim().slice(0, 1000),
    },
  };
}

// /api/days accepts `from`/`to` date params (src/dashboard/server.ts
// dashboardDays); without them it serves the product's 7-day reader window.
// The harness asks for DASHBOARD_DAYS_WINDOW_DAYS so the frozen podcasts
// seed's records (snapshot date, not sync date) stay inside the window.
function dashboardDaysRequestPath(now = new Date()): string {
  const from = new Date(now.getTime() - DASHBOARD_DAYS_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  return `/api/days?from=${from.toISOString().slice(0, 10)}`;
}

async function dashboardContentChecks(
  url: string,
  status: JsonObject,
  daysRequestPath: string,
  requiredSources: SourceId[],
): Promise<RehearsalCheck[]> {
  const checks: RehearsalCheck[] = [];
  const html = await fetchText(url);
  const days = await fetchJson(new URL(daysRequestPath, url).toString());
  const dayCount = Array.isArray(days.days) ? days.days.length : 0;
  const sourceCounts = dashboardSourceCounts(days);
  checks.push(
    html.toLowerCase().includes("nutshell")
      ? pass("dashboard page HTML loads from installed command", { url, bytes: html.length })
      : fail("dashboard page HTML loads from installed command", { url, bytes: html.length, preview: html.slice(0, 500) }),
  );
  checks.push(pass("dashboard status API serves installed product", { url, product: status.product as string, version: status.version as string }));
  checks.push(
    dayCount > 0
      ? pass("dashboard days API shows trace records", { dayCount, daysRequestPath, windowDays: DASHBOARD_DAYS_WINDOW_DAYS })
      : fail("dashboard days API shows trace records", { dayCount, daysRequestPath, windowDays: DASHBOARD_DAYS_WINDOW_DAYS }),
  );
  for (const source of requiredSources) {
    const count = sourceCounts[source] ?? 0;
    checks.push(
      count > 0
        ? pass(`dashboard shows ${source} trace records`, { source, count, windowDays: DASHBOARD_DAYS_WINDOW_DAYS })
        : fail(`dashboard shows ${source} trace records`, { source, count, sourceCounts, daysRequestPath, windowDays: DASHBOARD_DAYS_WINDOW_DAYS }),
    );
  }
  return checks;
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

export function makeRehearsalReport(phase: string, checks: RehearsalCheck[], evidence: JsonObject, verdict?: RehearsalVerdict): RehearsalReport {
  const pass = !checks.some((check) => check.status === "fail");
  // Criterion 27 default classification: all checks pass → pass; any failed
  // check is a failed product-behavior assertion → product_fail. harness_fail
  // and fixture_stale are always passed in explicitly, because only the call
  // site knows whether the harness machinery or a fixture broke.
  const resolvedVerdict = verdict ?? (pass ? "pass" : "product_fail");
  return {
    generatedAt: new Date().toISOString(),
    phase,
    status: resolvedVerdict === "fixture_stale" ? "blocked" : pass ? "pass" : "fail",
    verdict: resolvedVerdict,
    contract: contractForPhase(phase, pass, evidence, resolvedVerdict),
    checks,
    evidence,
  };
}

function reportFor(phase: string, checks: RehearsalCheck[], evidence: JsonObject, verdict?: RehearsalVerdict): RehearsalReport {
  return makeRehearsalReport(phase, checks, evidence, verdict);
}

// Shared verdict boundary (criterion 27): every verify* gate runs inside this
// wrapper so a throw out of the harness machinery — missing tools, unreadable
// paths, subprocess spawn failures, JSON the harness itself wrote malformed —
// is recorded as harness_fail. The candidate is not implicated: fix the
// harness and rerun. Failed product checks classify product_fail through
// makeRehearsalReport; fixture preflights classify fixture_stale explicitly.
async function classifiedPhase(phase: string, run: () => Promise<RehearsalReport>): Promise<RehearsalReport> {
  try {
    return await run();
  } catch (error) {
    return makeRehearsalReport(
      phase,
      [fail("gate harness ran without errors", { error: String(error) })],
      { harnessError: String(error) },
      "harness_fail",
    );
  }
}

interface FixturePreflightResult {
  healthy: boolean;
  check: RehearsalCheck;
}

// Fixture-health preflight (criterion 23; gates doc "Fixture preflight"): runs
// before any product assertion in the signed-in gates. Zero readable cookies
// means the fixture rotted or its keychain is gone — the gate queues with
// verdict fixture_stale and never fails the candidate. Keychain/Safe Storage
// warnings WITH cookies still readable are the opposite case: the fixture is
// fine and the product's decryption path is broken, so the preflight passes
// and the product checks classify blocked_bug → product_fail.
function fixturePreflight(google: BrowserProbeResult, x: BrowserProbeResult): FixturePreflightResult {
  const reasons = [
    ...probeFixtureReasons("google", google, GOOGLE_FIXTURE_AUTH_COOKIES),
    ...probeFixtureReasons("x", x, X_FIXTURE_AUTH_COOKIES),
  ];
  const detail: JsonObject = {
    google: { cookies: google.cookies, warnings: google.warnings },
    x: { cookies: x.cookies, warnings: x.warnings },
    requiredCookies: { google: GOOGLE_FIXTURE_AUTH_COOKIES, x: X_FIXTURE_AUTH_COOKIES },
  };
  if (!reasons.length) return { healthy: true, check: pass("fixture preflight", detail) };
  return {
    healthy: false,
    check: fail("fixture preflight", {
      ...detail,
      verdict: "fixture_stale",
      reasons,
      fix: "Refresh the auth-present snapshot: run scripts/snapshot-keepalive.sh, or the manual re-login in docs/rehearsal-browser-auth-seeds.md if the keep-alive also reports stale.",
    }),
  };
}

function probeFixtureReasons(name: string, probe: BrowserProbeResult, requiredCookies: string[]): string[] {
  const keychainWarnings = keychainOrSafeStorageWarnings(probe.warnings);
  if (probe.cookies.length === 0) {
    return [keychainWarnings.length ? `${name}_no_cookies_readable_keychain_blocked` : `${name}_no_cookies_readable`];
  }
  // Cookies readable but keychain warnings present: a product decryption bug,
  // not a stale fixture — leave it to the product checks (blocked_bug).
  if (keychainWarnings.length) return [];
  return requiredCookies.some((cookie) => probe.cookies.includes(cookie)) ? [] : [`${name}_missing_auth_cookie`];
}

// A stale fixture queues the gate (criterion 23): no product assertion runs,
// the report carries verdict fixture_stale and status "blocked" — distinct
// from both pass and product failure.
function fixtureStaleReport(phase: string, preflightCheck: RehearsalCheck, google: BrowserProbeResult, x: BrowserProbeResult): RehearsalReport {
  return makeRehearsalReport(
    phase,
    [preflightCheck],
    {
      fixturePreflight: preflightCheck.detail,
      browserWarnings: { google: google.warnings, x: x.warnings },
    },
    "fixture_stale",
  );
}

function contractForPhase(phase: string, phasePassed: boolean, evidence: JsonObject, verdict: RehearsalVerdict): RehearsalContract {
  const expected = expectedContractForPhase(phase);
  const diagnosticAction = typeof evidence.diagnosticAction === "string" ? evidence.diagnosticAction : null;
  const blockerKind =
    phasePassed && !diagnosticAction
      ? "none"
      : verdict === "fixture_stale"
        ? // A stale fixture is an unusable gate input, not a product blocker.
          "missing_input"
        : blockerKindForPhase(phase, evidence, diagnosticAction);
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
    case PERMISSIONS_PRE_PHASE:
      return { userStory: "Before any grant, the Nutshell.app root cause and Notes report needs_permission with exact fix text, Podcasts reports needs_permission or an honest empty library, and browser sources are classified honestly.", expectedState: "needs_permission", source: "all" };
    case PERMISSIONS_POST_PHASE:
      return { userStory: "After the staged permission session, Nutshell.app owns the grants, probes pass, and the seeded notes are visible.", expectedState: "ready_with_data", source: "all" };
    case LIVE_SYNC_DASHBOARD_PHASE:
      return { userStory: "Live signed-in sync and the dashboard prove records for every required source from the post-permission snapshot.", expectedState: "ready_with_data", source: "all" };
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
