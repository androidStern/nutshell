import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  appendReport,
  auditRehearsalReportFile,
  defaultRehearsalPaths,
  makeRehearsalReport,
  podcastSeedProvenanceCheck,
  podcastSnapshotManifestPath,
  prepareFreshInstallReportPath,
  snapshotPodcastDatabase,
  verifyAuthenticatedBrowserState,
  verifyCleanState,
  verifyFinalReleaseState,
  verifyHostPreflight,
  verifyInstalledProduct,
  verifyUnauthenticatedBrowserState,
  writeReport,
  runCommand,
  type BrowserAuthOptions,
  type HostPreflightOptions,
  type RehearsalOptions,
  type RehearsalPaths,
  type RehearsalReport,
} from "../src/release/fresh-install-rehearsal";

type Command =
  | "help"
  | "audit-report"
  | "preflight-host"
  | "record-auth-seed-restore"
  | "run"
  | "snapshot-podcasts"
  | "verify-clean"
  | "verify-installed"
  | "verify-unauthenticated"
  | "verify-authenticated"
  | "verify-final";

const firstArg = process.argv[2];
const commandRaw = !firstArg || (firstArg.startsWith("--") && firstArg !== "--help" && firstArg !== "-h") ? "help" : firstArg;
const command = commandRaw as Command | "--help" | "-h";
const args = firstArg && !firstArg.startsWith("--") ? process.argv.slice(3) : process.argv.slice(2);

try {
  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(helpText());
    process.exit(0);
  }

  if (command === "snapshot-podcasts") {
    const flags = parseFlags(args);
    const source = stringFlag(flags, "source") ?? defaultPodcastPath();
    const destination = requiredStringFlag(flags, "out");
    const report = snapshotPodcastDatabase({ source, destination, overwrite: Boolean(flags.force) });
    process.stdout.write(`${JSON.stringify({ status: "pass", report }, null, 2)}\n`);
    process.exit(0);
  }

  if (command === "run") {
    const ok = await runFullRehearsal(args);
    process.exit(ok ? 0 : 1);
  }

  if (command === "audit-report") {
    const flags = parseFlags(args);
    const reportPath = requiredStringFlag(flags, "report");
    const report = auditRehearsalReportFile(reportPath);
    if (flags.append) appendReport(resolve(reportPath), report);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exit(report.status === "pass" ? 0 : 1);
  }

  if (command === "record-auth-seed-restore") {
    const flags = parseFlags(args);
    const report = recordBrowserAuthSeedRestore({
      seed: requiredStringFlag(flags, "browser-auth-seed"),
      seedRoot: stringFlag(flags, "auth-seed-root") ?? "/Volumes/My Shared Files/share/auth-profiles",
      home: stringFlag(flags, "home") ?? defaultRehearsalPaths().home,
    });
    persistReport(args, report);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exit(report.status === "pass" ? 0 : 1);
  }

  if (command === "preflight-host") {
    const report = await verifyHostPreflight(hostPreflightOptionsFromArgs(args));
    persistReport(args, report);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exit(report.status === "pass" ? 0 : 1);
  }

  const options = optionsFromArgs(args);
  const report =
    command === "verify-clean"
      ? await verifyCleanState(options)
      : command === "verify-installed"
        ? await verifyInstalledProduct(options)
        : command === "verify-unauthenticated"
          ? await verifyUnauthenticatedBrowserState(options)
          : command === "verify-authenticated"
            ? await verifyAuthenticatedBrowserState(options)
            : command === "verify-final"
              ? await verifyFinalReleaseState({ ...options, startDashboard: !hasFlag(args, "--no-dashboard") })
              : null;

  if (!report) throw new Error(`Unknown fresh-install rehearsal command: ${command}`);
  persistReport(args, report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(report.status === "pass" ? 0 : 1);
} catch (error) {
  process.stderr.write(`${String(error instanceof Error ? error.message : error)}\n`);
  process.exit(1);
}

async function runFullRehearsal(argv: string[]): Promise<boolean> {
  const flags = parseFlags(argv);
  const options = optionsFromArgs(argv);
  const reportPath = stringFlag(flags, "report") ? resolve(requiredStringFlag(flags, "report")) : resolve("dist/rehearsal/fresh-install-report.json");
  const installCommand = stringFlag(flags, "install-command") ?? "brew install androidStern/nutshell/nutshell";
  const expectedVersion = stringFlag(flags, "expected-version");
  const releaseId = stringFlag(flags, "release-id") ?? await detectedReleaseId();
  const installSource = stringFlag(flags, "install-source") ?? installCommand;
  const xArchive = stringFlag(flags, "x-archive");
  const youtubeExport = stringFlag(flags, "youtube-export");
  const podcastsSeed = stringFlag(flags, "podcasts-seed");
  const waitBackgroundMs = numberFlag(flags, "wait-background-ms", 20 * 60 * 1000);
  const skipLocalChecks = hasFlag(argv, "--skip-local-checks");
  const nonInteractive = hasFlag(argv, "--non-interactive");
  const archivedPreviousReport = prepareFreshInstallReportPath(reportPath, Boolean(flags["force-new-report"]));

  appendReport(reportPath, phaseReport("start", true, {
    installCommand,
    installSource,
    releaseId,
    expectedVersion: expectedVersion ?? null,
    reportPath,
    archivedPreviousReport,
    xArchive: xArchive ? "[provided]" : null,
    youtubeExport: youtubeExport ? "[provided]" : null,
    podcastsSeed: podcastsSeed ? "[provided]" : null,
  }));

  const phases: Array<() => Promise<RehearsalReport>> = [];
  if (!skipLocalChecks) phases.push(() => localReleaseChecks());
  phases.push(() => verifyCleanState(options));
  phases.push(() => installPublishedProduct({ installCommand, expectedVersion, installSource, releaseId }));
  phases.push(() => verifyInstalledProduct(options));
  phases.push(() => verifyAppDoesNotAlreadyHaveFullDiskAccess());
  phases.push(() => verifyUnauthenticatedBrowserState(options));
  phases.push(() => runSetupFlow());
  phases.push(async () => {
    if (nonInteractive) return phaseReport("browser-login-handoff", false, { error: "manual browser login required in non-interactive mode" });
    await openBrowserUrl("https://myactivity.google.com/myactivity?product=26", options.browser?.browser);
    await openBrowserUrl("https://x.com/home", options.browser?.browser);
    await prompt(
      [
        "Sign into Google and X in the Chrome profile Nutshell will use.",
        "Make sure Google My Activity can show YouTube activity.",
        "Make sure X has accessible recent activity.",
      ].join("\n"),
    );
    return phaseReport("browser-login-handoff", true, { confirmedByUser: true });
  });
  phases.push(() => verifyAuthenticatedBrowserState(options));
  phases.push(() => stagePodcastSeed(podcastsSeed));
  phases.push(() => importProviderExports(xArchive, youtubeExport));
  phases.push(async () => {
    if (nonInteractive) return phaseReport("apple-notes-handoff", false, { error: "manual Apple Notes test data step required in non-interactive mode" });
    await openSystemUrl("notes://");
    await prompt("Create or expose at least one accessible Apple Note in this test environment.");
    return phaseReport("apple-notes-handoff", true, { confirmedByUser: true });
  });
  phases.push(() => foregroundSync());
  phases.push(() => waitForBackgroundSync(waitBackgroundMs));
  phases.push(() => verifyFinalReleaseState({ ...options, startDashboard: true, dashboardTimeoutMs: 60_000 }));

  for (const runPhase of phases) {
    const report = await runPhase();
    appendReport(reportPath, report);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.status !== "pass") return false;
  }

  appendReport(reportPath, phaseReport("complete", true, { reportPath }));
  const audit = auditRehearsalReportFile(reportPath);
  appendReport(reportPath, audit);
  process.stdout.write(`${JSON.stringify(audit, null, 2)}\n`);
  return audit.status === "pass";
}

function hostPreflightOptionsFromArgs(argv: string[]): HostPreflightOptions {
  const flags = parseFlags(argv);
  const minFreeGb = numberFlag(flags, "min-free-gb", 50);
  return {
    xArchive: stringFlag(flags, "x-archive"),
    youtubeExport: stringFlag(flags, "youtube-export"),
    podcastsSeed: stringFlag(flags, "podcasts-seed"),
    minFreeBytes: minFreeGb * 1024 ** 3,
    diskPath: stringFlag(flags, "disk-path") ?? undefined,
    allowTestAccountFallback: Boolean(flags["allow-test-account-fallback"]),
  };
}

function optionsFromArgs(argv: string[]): RehearsalOptions {
  const flags = parseFlags(argv);
  const home = stringFlag(flags, "home");
  const paths: Partial<RehearsalPaths> = {};
  if (home) Object.assign(paths, defaultRehearsalPaths(resolve(home)));
  if (typeof flags.config === "string") paths.configPath = resolve(flags.config);
  if (typeof flags.root === "string") paths.root = resolve(flags.root);
  if (typeof flags.app === "string") paths.appPaths = [resolve(flags.app)];
  const browser: Partial<BrowserAuthOptions> = {};
  if (typeof flags.browser === "string") browser.browser = flags.browser;
  if (typeof flags.profile === "string") browser.profile = flags.profile;
  return {
    paths,
    browser,
    resetPrivacy: Boolean(flags["reset-privacy"]),
  };
}

async function localReleaseChecks(): Promise<RehearsalReport> {
  const checks: RehearsalReport["checks"] = [];
  const isolatedHome = mkdtempSync(join(tmpdir(), "nutshell-local-release-checks-"));
  const env = {
    ...process.env,
    HOME: isolatedHome,
  } as Record<string, string>;
  try {
    for (const command of [
      ["bun", "run", "typecheck"],
      ["bun", "test"],
      ["bun", "run", "lint"],
      ["bun", "run", "build:compile"],
      ["bun", "run", "certify:release"],
    ]) {
      const result = await runCommand(command, { env, timeoutMs: 20 * 60_000 });
      checks.push(
        result.code === 0
          ? { name: command.join(" "), status: "pass", detail: { code: result.code, isolatedHome } }
          : { name: command.join(" "), status: "fail", detail: { ...commandDetail(result), isolatedHome } },
      );
      if (result.code !== 0) break;
    }
  } finally {
    rmSync(isolatedHome, { recursive: true, force: true });
  }
  return aggregateReport("local-release-checks", checks, {});
}

async function installPublishedProduct(input: { installCommand: string; expectedVersion: string | null; installSource: string; releaseId: string | null }): Promise<RehearsalReport> {
  const evidence: RehearsalReport["evidence"] = {
    installCommand: input.installCommand,
    installSource: input.installSource,
    releaseId: input.releaseId,
    expectedVersion: input.expectedVersion,
  };
  const sourceCheck = publishedInstallSourceCheck(input.installCommand, input.installSource);
  const checks: RehearsalReport["checks"] = [sourceCheck];
  if (sourceCheck.status === "fail") return aggregateReport("published-install", checks, evidence);

  const install = await runCommand(["sh", "-lc", input.installCommand], { timeoutMs: 20 * 60_000 });
  checks.push(
    install.code === 0
      ? { name: "published install command succeeds", status: "pass", detail: commandDetail(install) }
      : { name: "published install command succeeds", status: "fail", detail: commandDetail(install) },
  );
  if (install.code === 0) {
    const which = await runCommand(["sh", "-lc", "command -v nutshell"], { timeoutMs: 30_000 });
    const version = await runCommand(["nutshell", "--version"], { timeoutMs: 30_000 });
    evidence.installedCommandPath = which.stdout.trim() || null;
    evidence.installedVersion = version.stdout.trim() || null;
    checks.push(
      which.code === 0 && which.stdout.trim()
        ? { name: "installed nutshell is on PATH", status: "pass", detail: { path: which.stdout.trim() } }
        : { name: "installed nutshell is on PATH", status: "fail", detail: commandDetail(which) },
    );
    const versionOk = version.code === 0 && (!input.expectedVersion || version.stdout.includes(input.expectedVersion));
    checks.push(
      versionOk
        ? { name: "installed version matches release", status: "pass", detail: { version: version.stdout.trim(), expected: input.expectedVersion } }
        : { name: "installed version matches release", status: "fail", detail: { ...commandDetail(version), expected: input.expectedVersion } },
    );
  }
  return aggregateReport("published-install", checks, evidence);
}

async function verifyAppDoesNotAlreadyHaveFullDiskAccess(): Promise<RehearsalReport> {
  const status = await runCommand(["nutshell", "app", "status"], { timeoutMs: 30_000 });
  const fullDisk = valueAfter(status.stdout, "Full Disk Access");
  const checks: RehearsalReport["checks"] = [
    status.code === 0
      ? { name: "installed app status is readable", status: "pass", detail: { stdout: status.stdout.trim() } }
      : { name: "installed app status is readable", status: "fail", detail: commandDetail(status) },
    fullDisk !== "granted"
      ? { name: "installed app does not reuse an old Full Disk Access grant", status: "pass", detail: { fullDiskAccess: fullDisk || "unknown" } }
      : { name: "installed app does not reuse an old Full Disk Access grant", status: "fail", detail: { fullDiskAccess: fullDisk } },
  ];
  return aggregateReport("pre-permission-app-state", checks, {});
}

async function stagePodcastSeed(seed: string | null): Promise<RehearsalReport> {
  if (!seed) return phaseReport("stage-podcast-seed", false, { error: "missing --podcasts-seed" });
  const source = resolve(seed);
  const destination = defaultPodcastPathUnchecked();
  const checks: RehearsalReport["checks"] = [];
  if (!existsSync(source)) checks.push({ name: "Apple Podcasts seed exists", status: "fail", detail: { source } });
  else checks.push({ name: "Apple Podcasts seed exists", status: "pass", detail: { source, bytes: statSync(source).size } });
  checks.push(podcastSeedProvenanceCheck(source));
  if (checks.some((check) => check.status === "fail")) return aggregateReport("stage-podcast-seed", checks, { source, destination });
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  const sourceManifest = podcastSnapshotManifestPath(source);
  if (existsSync(sourceManifest)) copyFileSync(sourceManifest, podcastSnapshotManifestPath(destination));
  checks.push({
    name: "Apple Podcasts seed staged at normal plugin path",
    status: "pass",
    detail: { source, destination, bytes: statSync(destination).size, manifest: podcastSnapshotManifestPath(destination) },
  });
  return aggregateReport("stage-podcast-seed", checks, { source, destination, bytes: statSync(destination).size });
}

function recordBrowserAuthSeedRestore(input: { seed: string; seedRoot: string; home: string }): RehearsalReport {
  const seedPath = input.seed.startsWith("/") ? input.seed : join(input.seedRoot, input.seed);
  const manifestPath = join(seedPath, "manifest.json");
  const profileArchive = join(seedPath, "chrome-profile.tgz");
  const seedKeychain = join(seedPath, "login.keychain-db");
  const restoredProfile = join(input.home, "Library", "Application Support", "Google", "Chrome");
  const restoredKeychain = join(input.home, "Library", "Keychains", "login.keychain-db");
  const checks: RehearsalReport["checks"] = [
    input.seed.trim()
      ? { name: "browser auth seed restore declared", status: "pass", detail: { seed: input.seed, seedPath } }
      : { name: "browser auth seed restore declared", status: "fail", detail: { seed: input.seed } },
    existsSync(manifestPath)
      ? { name: "browser auth seed manifest exists", status: "pass", detail: { manifestPath, bytes: statSync(manifestPath).size } }
      : { name: "browser auth seed manifest exists", status: "fail", detail: { manifestPath } },
    existsSync(profileArchive)
      ? { name: "browser auth seed Chrome archive exists", status: "pass", detail: { profileArchive, bytes: statSync(profileArchive).size } }
      : { name: "browser auth seed Chrome archive exists", status: "fail", detail: { profileArchive } },
    existsSync(seedKeychain)
      ? { name: "browser auth seed login keychain exists", status: "pass", detail: { seedKeychain, bytes: statSync(seedKeychain).size } }
      : { name: "browser auth seed login keychain exists", status: "fail", detail: { seedKeychain } },
    existsSync(restoredProfile)
      ? { name: "Chrome profile exists after auth seed restore", status: "pass", detail: { restoredProfile } }
      : { name: "Chrome profile exists after auth seed restore", status: "fail", detail: { restoredProfile } },
    existsSync(restoredKeychain)
      ? { name: "login keychain exists after auth seed restore", status: "pass", detail: { restoredKeychain, bytes: statSync(restoredKeychain).size } }
      : { name: "login keychain exists after auth seed restore", status: "fail", detail: { restoredKeychain } },
  ];
  return aggregateReport("browser-auth-seed-restore", checks, {
    seed: input.seed,
    seedPath,
    manifestPath,
    profileArchive,
    seedKeychain,
    restoredProfile,
    restoredKeychain,
    fixture: "browser_auth_seed",
  });
}

async function runSetupFlow(): Promise<RehearsalReport> {
  const setup = await runInteractive(["nutshell", "setup"], 60 * 60_000);
  const checks: RehearsalReport["checks"] = [
    setup.code === 0
      ? { name: "nutshell setup completes", status: "pass", detail: commandDetail(setup) }
      : { name: "nutshell setup completes", status: "fail", detail: commandDetail(setup) },
  ];
  const evidence: RehearsalReport["evidence"] = { bundleId: "com.winterfell.nutshell" };
  if (setup.code === 0) {
    const status = await runCommand(["nutshell", "app", "status"], { timeoutMs: 30_000 });
    evidence.appStatus = status.stdout.trim();
    checks.push(appStatusCheck("Full Disk Access is granted to Nutshell.app", status, "Full Disk Access", "granted"));
    checks.push(appStatusCheck("background sync is enabled", status, "Background sync", "enabled"));
    checks.push(appStatusCheck("background agent is enabled", status, "Agent status", "enabled"));
    const agent = await appOwnedLaunchAgentChecks();
    evidence.launchAgent = agent.evidence;
    checks.push(...agent.checks);
  }
  return aggregateReport("setup-flow", checks, evidence);
}

async function appOwnedLaunchAgentChecks(): Promise<{ checks: RehearsalReport["checks"]; evidence: RehearsalReport["evidence"] }> {
  const uid = typeof process.getuid === "function" ? process.getuid() : 501;
  const label = "com.winterfell.nutshell.agent";
  const result = await runCommand(["/bin/launchctl", "print", `gui/${uid}/${label}`], { timeoutMs: 30_000 });
  const raw = `${result.stdout}\n${result.stderr}`.trim();
  const targetText = raw.toLowerCase();
  const fullAppPathTarget = targetText.includes("nutshell.app/contents/library/launchservices/nutshellagent");
  const serviceManagementTarget =
    targetText.includes("program identifier = contents/library/launchservices/nutshellagent") &&
    targetText.includes("parent bundle identifier = com.winterfell.nutshell");
  const appOwned = result.code === 0 && (fullAppPathTarget || serviceManagementTarget);
  const rawCliMarkers = [
    "/bin/zsh",
    "/bin/bash",
    " bun ",
    "/bun ",
    "src/cli.ts",
    ".local/bin/nutshell",
    "/cellar/nutshell/",
  ].filter((marker) => targetText.includes(marker));
  return {
    checks: [
      appOwned
        ? { name: "loaded background agent target is app-owned", status: "pass", detail: { label, mode: fullAppPathTarget ? "bundle_path" : "service_management_parent_bundle" } }
        : { name: "loaded background agent target is app-owned", status: "fail", detail: { label, command: commandDetail(result), raw: tail(raw, 2000) } },
      rawCliMarkers.length === 0
        ? { name: "loaded background agent target is not raw CLI", status: "pass", detail: { label } }
        : { name: "loaded background agent target is not raw CLI", status: "fail", detail: { label, rawCliMarkers, raw: tail(raw, 2000) } },
    ],
    evidence: { label, raw: tail(raw, 4000) },
  };
}

async function importProviderExports(xArchive: string | null, youtubeExport: string | null): Promise<RehearsalReport> {
  const checks: RehearsalReport["checks"] = [];
  if (!xArchive) checks.push({ name: "official X archive path provided", status: "fail", detail: { flag: "--x-archive" } });
  else checks.push(await importProvider("twitter", xArchive));
  if (!youtubeExport) checks.push({ name: "official YouTube export path provided", status: "fail", detail: { flag: "--youtube-export" } });
  else checks.push(await importProvider("youtube", youtubeExport));
  return aggregateReport("provider-archive-imports", checks, {});
}

async function importProvider(source: string, path: string): Promise<RehearsalReport["checks"][number]> {
  const resolved = resolve(path);
  if (!existsSync(resolved)) return { name: `${source} official provider archive exists`, status: "fail", detail: { path: resolved } };
  const result = await runCommand(["nutshell", "import", source, resolved, "--json"], { timeoutMs: 30 * 60_000 });
  return result.code === 0
    ? { name: `${source} official provider archive imports`, status: "pass", detail: commandDetail(result) }
    : { name: `${source} official provider archive imports`, status: "fail", detail: commandDetail(result) };
}

async function foregroundSync(): Promise<RehearsalReport> {
  const result = await runCommand(["nutshell", "sync", "all", "--json"], { timeoutMs: 30 * 60_000 });
  const parsed = parseJsonObject(result.stdout);
  const checks: RehearsalReport["checks"] = [
    result.code === 0
      ? { name: "foreground sync completes", status: "pass", detail: commandDetail(result) }
      : { name: "foreground sync completes", status: "fail", detail: commandDetail(result) },
    liveSourceSyncCheck("youtube", parsed, (source) => numberAtPath(source, ["metrics", "emitted"]) > 0),
    liveSourceSyncCheck("podcasts", parsed, (source) => numberAtPath(source, ["metrics", "emitted"]) > 0),
    liveSourceSyncCheck("apple_notes", parsed, (source) => numberAtPath(source, ["metrics", "uniqueNotes"]) > 0),
    liveSourceSyncCheck("twitter", parsed, (source) => {
      if (numberAtPath(source, ["metrics", "observations"]) > 0 || numberAtPath(source, ["metrics", "records"]) > 0) return true;
      const metrics = objectAt(source, "metrics");
      return Object.values(metrics).some((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return false;
        const item = value as Record<string, unknown>;
        return Number(item.observations ?? 0) > 0 || Number(item.records ?? 0) > 0;
      });
    }),
  ];
  return aggregateReport("foreground-sync", checks, { sourceCount: Array.isArray(parsed.sources) ? parsed.sources.length : 0 });
}

async function waitForBackgroundSync(timeoutMs: number): Promise<RehearsalReport> {
  const before = await healthJson();
  const beforeLast = schedulerValue(before, "lastRunAt");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await delay(10_000);
    const after = await healthJson();
    const afterLast = schedulerValue(after, "lastRunAt");
    const afterNext = schedulerValue(after, "nextRunAt");
    if (afterLast && afterLast !== beforeLast && afterNext) {
      return phaseReport("background-sync", true, { beforeLastRunAt: beforeLast, lastRunAt: afterLast, nextRunAt: afterNext });
    }
  }
  return phaseReport("background-sync", false, { error: `background sync did not update within ${timeoutMs}ms`, beforeLastRunAt: beforeLast });
}

function persistReport(argv: string[], report: RehearsalReport): void {
  const flags = parseFlags(argv);
  const reportPath = typeof flags.report === "string" ? resolve(flags.report) : "";
  if (!reportPath) return;
  if (flags.append) appendReport(reportPath, report);
  else writeReport(reportPath, report);
}

function aggregateReport(phase: string, checks: RehearsalReport["checks"], evidence: RehearsalReport["evidence"]): RehearsalReport {
  return makeRehearsalReport(phase, checks, evidence);
}

function phaseReport(phase: string, ok: boolean, detail: RehearsalReport["evidence"]): RehearsalReport {
  return aggregateReport(phase, [{ name: phase, status: ok ? "pass" : "fail", detail }], detail);
}

function commandDetail(result: Awaited<ReturnType<typeof runCommand>>): RehearsalReport["evidence"] {
  return {
    code: result.code,
    timedOut: result.timedOut,
    stdout: tail(result.stdout),
    stderr: tail(result.stderr),
  };
}

function publishedInstallSourceCheck(installCommand: string, installSource: string): RehearsalReport["checks"][number] {
  const text = `${installCommand}\n${installSource}`;
  const lower = text.toLowerCase();
  const forbidden = [
    "bun run",
    "src/cli.ts",
    "scripts/",
    "dist/release/homebrew",
    "file://",
    "$pwd",
    "`pwd`",
    "../",
  ].filter((marker) => lower.includes(marker));
  const localFormula = /\bbrew\s+install\b[^\n]*\.(rb|json)\b/i.test(text);
  const absoluteRepoPath = /\/users\/[^ \n]+\/documents\/codex\/|\/private\/tmp\/|\/tmp\//i.test(text);
  const publicish =
    /\bbrew\s+install\s+[^ \n]+\/[^ \n]+\/[^ \n]+/i.test(installCommand) ||
    /\bbun\s+install\s+-g\s+(@?[\w.-]+\/)?[\w.-]+/i.test(installCommand) ||
    /https:\/\/github\.com\/[^ \n]+\/[^ \n]+\/releases\/download\//i.test(text);
  const failures = [
    ...forbidden.map((marker) => `forbidden_marker:${marker}`),
    ...(localFormula ? ["local_homebrew_formula_file"] : []),
    ...(absoluteRepoPath ? ["absolute_local_path"] : []),
    ...(publicish ? [] : ["no_public_install_source_detected"]),
  ];
  return failures.length
    ? { name: "install command uses a published user-facing source", status: "fail", detail: { installCommand, installSource, failures } }
    : { name: "install command uses a published user-facing source", status: "pass", detail: { installCommand, installSource } };
}

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw.trim()) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function liveSourceSyncCheck(
  source: string,
  report: Record<string, unknown>,
  hasLiveItems: (sourceReport: Record<string, unknown>) => boolean,
): RehearsalReport["checks"][number] {
  const sourceReport = sourceReportFor(report, source);
  const name = `foreground sync proves live ${source} ingestion`;
  if (!sourceReport) return { name, status: "fail", detail: { source, reason: "missing_source_report" } };
  const status = typeof sourceReport.status === "string" ? sourceReport.status : "unknown";
  const enrichment = objectAt(sourceReport, "enrichment");
  const enrichmentStatus = typeof enrichment.status === "string" ? enrichment.status : null;
  const liveItems = hasLiveItems(sourceReport);
  const failures = [
    ...(status === "ok" ? [] : [`source_status_${status}`]),
    ...(enrichmentStatus && enrichmentStatus !== "ok" ? [`enrichment_status_${enrichmentStatus}`] : []),
    ...(liveItems ? [] : ["no_live_items_reported"]),
  ];
  return failures.length
    ? { name, status: "fail", detail: { source, failures, sourceReport: compactSourceReport(sourceReport) as RehearsalReport["evidence"] } }
    : { name, status: "pass", detail: { source, status, metrics: objectAt(sourceReport, "metrics") as RehearsalReport["evidence"] } };
}

function sourceReportFor(report: Record<string, unknown>, source: string): Record<string, unknown> | null {
  const sources = Array.isArray(report.sources) ? report.sources : [];
  for (const item of sources) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const candidate = item as Record<string, unknown>;
    if (candidate.source === source) return candidate;
  }
  return null;
}

function compactSourceReport(sourceReport: Record<string, unknown>): Record<string, unknown> {
  return {
    source: sourceReport.source ?? null,
    status: sourceReport.status ?? null,
    metrics: objectAt(sourceReport, "metrics"),
    commit: objectAt(sourceReport, "commit"),
    findings: Array.isArray(sourceReport.findings) ? sourceReport.findings.slice(0, 5) : [],
    enrichment: objectAt(sourceReport, "enrichment"),
  };
}

function objectAt(input: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = input[key];
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function numberAtPath(input: Record<string, unknown>, path: string[]): number {
  let current: unknown = input;
  for (const segment of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return 0;
    current = (current as Record<string, unknown>)[segment];
  }
  return typeof current === "number" && Number.isFinite(current) ? current : 0;
}

async function runInteractive(command: string[], timeoutMs: number): Promise<Awaited<ReturnType<typeof runCommand>>> {
  const proc = Bun.spawn(command, {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, timeoutMs);
  const code = await proc.exited;
  clearTimeout(timer);
  return { code, stdout: "", stderr: "", timedOut };
}

async function healthJson(): Promise<Record<string, unknown>> {
  const result = await runCommand(["nutshell", "health", "--json"], { timeoutMs: 120_000 });
  if (result.code > 2) throw new Error(`health failed unexpectedly: ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout.trim()) as Record<string, unknown>;
}

function schedulerValue(health: Record<string, unknown>, key: string): string | null {
  const scheduler = health.scheduler && typeof health.scheduler === "object" && !Array.isArray(health.scheduler) ? health.scheduler as Record<string, unknown> : {};
  const value = scheduler[key];
  return typeof value === "string" ? value : null;
}

function appStatusCheck(name: string, status: Awaited<ReturnType<typeof runCommand>>, label: string, expected: string): RehearsalReport["checks"][number] {
  const value = valueAfter(status.stdout, label);
  return status.code === 0 && value === expected
    ? { name, status: "pass", detail: { [label]: value } }
    : { name, status: "fail", detail: { [label]: value, command: commandDetail(status) } };
}

function valueAfter(raw: string, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = raw.match(new RegExp(`^${escaped}:\\s*(.+)$`, "im"));
  return match?.[1]?.trim() ?? "";
}

async function openSystemUrl(url: string): Promise<void> {
  if (process.platform !== "darwin") return;
  await runCommand(["/usr/bin/open", url], { timeoutMs: 30_000 });
}

async function openBrowserUrl(url: string, browserName: string | undefined): Promise<void> {
  if (process.platform !== "darwin") return;
  const normalized = (browserName || "chrome").toLowerCase();
  if (normalized === "chrome" || normalized === "google-chrome" || normalized === "google chrome") {
    await runCommand(["/usr/bin/open", "-a", "Google Chrome", url], { timeoutMs: 30_000 });
    return;
  }
  await runCommand(["/usr/bin/open", url], { timeoutMs: 30_000 });
}

async function prompt(message: string): Promise<void> {
  process.stdout.write(`\n${message}\nPress Enter to continue: `);
  await new Promise<void>((resolvePrompt) => {
    process.stdin.resume();
    process.stdin.once("data", () => {
      process.stdin.pause();
      resolvePrompt();
    });
  });
}

async function detectedReleaseId(): Promise<string | null> {
  const result = await runCommand(["git", "describe", "--tags", "--always", "--dirty"], { timeoutMs: 30_000 });
  return result.code === 0 && result.stdout.trim() ? result.stdout.trim() : null;
}

function defaultPodcastPathUnchecked(): string {
  const home = process.env.HOME ?? "";
  return join(home, "Library", "Group Containers", "243LU875E5.groups.com.apple.podcasts", "Documents", "MTLibrary.sqlite");
}

function numberFlag(flags: Record<string, string | boolean>, name: string, fallback: number): number {
  const value = flags[name];
  if (typeof value !== "string") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function tail(text: string, max = 4000): string {
  return text.length > max ? text.slice(text.length - max) : text;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function parseFlags(argv: string[]): Record<string, string | boolean> {
  const flags: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = true;
    } else {
      flags[key] = next;
      index += 1;
    }
  }
  return flags;
}

function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

function stringFlag(flags: Record<string, string | boolean>, name: string): string | null {
  const value = flags[name];
  return typeof value === "string" ? value : null;
}

function requiredStringFlag(flags: Record<string, string | boolean>, name: string): string {
  const value = stringFlag(flags, name);
  if (!value) throw new Error(`Missing required --${name}`);
  return value;
}

function defaultPodcastPath(): string {
  const home = process.env.HOME ?? "";
  const path = join(home, "Library", "Group Containers", "243LU875E5.groups.com.apple.podcasts", "Documents", "MTLibrary.sqlite");
  if (!existsSync(path)) throw new Error(`Default Apple Podcasts database not found. Pass --source explicitly. Checked: ${path}`);
  return path;
}

function helpText(): string {
  return `Fresh install release rehearsal helper.

Usage:
  bun run scripts/fresh-install-rehearsal.ts preflight-host --x-archive <zip> --youtube-export <zip> --podcasts-seed <sqlite>
  bun run scripts/fresh-install-rehearsal.ts run --x-archive <zip> --youtube-export <zip> --podcasts-seed <sqlite>
  bun run scripts/fresh-install-rehearsal.ts audit-report --report <fresh-install-report.json>
  bun run scripts/fresh-install-rehearsal.ts snapshot-podcasts --out <MTLibrary.sqlite> [--source <path>] [--force]
  bun run scripts/fresh-install-rehearsal.ts verify-clean --reset-privacy [--report <path>] [--append]
  bun run scripts/fresh-install-rehearsal.ts verify-installed [--report <path>] [--append]
  bun run scripts/fresh-install-rehearsal.ts verify-unauthenticated [--report <path>] [--append]
  bun run scripts/fresh-install-rehearsal.ts record-auth-seed-restore --browser-auth-seed <name> [--report <path>] [--append]
  bun run scripts/fresh-install-rehearsal.ts verify-authenticated [--report <path>] [--append]
  bun run scripts/fresh-install-rehearsal.ts verify-final [--report <path>] [--append] [--no-dashboard]

Common flags:
  --home <path>       Test user's home directory. Defaults to current HOME.
  --root <path>       Nutshell data root override for verification.
  --config <path>     nutconfig.jsonc override for verification.
  --browser <name>    Browser used by browser-backed plugins. Defaults to chrome.
  --profile <name>    Browser profile used by browser-backed plugins.
  --report <path>     Write this phase report.
  --append            Append this phase to an aggregate report instead of replacing it.
  --install-command   Published user install command. Defaults to Homebrew tap install.
  --install-source    Human-readable public artifact source. Defaults to install command.
  --release-id        Release tag, commit, or artifact identifier recorded in the final report.
  --expected-version  Version string the installed command must report.
  --x-archive         Official X archive zip for historical import proof.
  --youtube-export    Official Google/YouTube export for historical import proof.
  --podcasts-seed     SQLite-safe Apple Podcasts seed snapshot.
  --browser-auth-seed Declared private Chrome/keychain auth seed restored before authenticated checks.
  --auth-seed-root    Auth seed directory. Defaults to Tart shared folder auth-profiles path.
  --min-free-gb       Required free disk for host preflight. Defaults to 50.
  --disk-path         Disk path used by host preflight. Defaults to current HOME.
  --allow-test-account-fallback
                    Host preflight may skip VM-manager availability when deliberately using a clean test account fallback.
  --reset-privacy     Reset Nutshell Full Disk Access in the disposable test environment.
  --skip-local-checks Skip source-tree release checks before the install rehearsal.
  --non-interactive   Fail instead of waiting for manual login or Notes handoff.
  --force-new-report  Archive an existing --report file before starting a new run.

Run this script from a disposable macOS test environment restored to a clean baseline.
The script verifies and records the release rehearsal; it does not replace the normal
user flow through Homebrew, nutshell setup, browser login, System Settings, imports,
foreground sync, scheduled sync, and the dashboard.
`;
}
