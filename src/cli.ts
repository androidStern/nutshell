#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { TraceError, UsageError } from "./core/errors";
import { APP_PATH_ENV, CLI_NAME, DEFAULT_APP_PATH, PRODUCT_VERSION } from "./core/product";
import { DEFAULT_SYNC_BUDGET } from "./config/defaults";
import { expandHome, loadConfig, logPath, resolveConfigPath, resolveRoot } from "./config/config";
import { loadBuiltinPlugins } from "./plugins/registry";
import { probePluginContext } from "./setup/probe";
import { JsonlLogger } from "./runtime/logger";
import { TraceRuntime } from "./runtime/trace-runtime";
import { exitCodeForHealth } from "./health/health";
import { formatHealthText } from "./health/reporters";
import { formatSyncText } from "./health/sync-reporter";
import { runProcess } from "./runtime/process";
import { appExecutable, ensureStableAppPath, runNutshellAppCommand } from "./macos/app-status";
import { runPodcastsSqliteWorkerFromStdin } from "./plugins/builtin/podcasts/sqlite-worker";
import { serveDashboard } from "./dashboard/server";
import { SetupRuntime, exitCodeForSetup } from "./setup/setup-runtime";
import { SetupCancelledError } from "./setup/ui-clack";
import { formatResetText, ResetRuntime, type ResetMode } from "./reset/reset-runtime";
import type { HealthReport, JsonObject, SmokeReport, SourceId, SyncMode, SyncRequest } from "./core/types";

async function main(argv: string[]): Promise<number> {
  const global = parseGlobal(argv);
  const args = global.rest;
  const configFile = resolveConfigPath(global.root);
  const root = resolveRoot(global.root, configFile);
  const command = args.shift();
  if (command === "__personal_trace_podcasts_sqlite_worker") {
    await runPodcastsSqliteWorkerFromStdin();
    return 0;
  }
  // Hidden app/helper bridge: runs one plugin's real probe (plugin.check)
  // regardless of enabled state, so setup can verify a source through the
  // Nutshell.app identity before config is committed. Not a public command.
  if (command === "__probe") {
    const source = args[0] && !args[0].startsWith("--") ? args.shift()! : null;
    if (!source) throw new UsageError(`${CLI_NAME} __probe requires a plugin name`);
    const config = loadConfig(root, configFile);
    const registry = loadBuiltinPlugins();
    const plugin = registry.get(source);
    const findings = await plugin.check(probePluginContext(config, plugin, new JsonlLogger(logPath(config)), new AbortController().signal));
    process.stdout.write(`${JSON.stringify({ source, findings }, null, 2)}\n`);
    return findings.some((finding) => finding.level === "critical") ? 2 : findings.length ? 1 : 0;
  }
  if (command === "version" || command === "--version" || command === "-v") {
    process.stdout.write(`${CLI_NAME} ${PRODUCT_VERSION}\n`);
    return 0;
  }
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(helpText(args[0]));
    return 0;
  }
  if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
    process.stdout.write(helpText(command));
    return 0;
  }

  if (command === "setup") {
    const setup = new SetupRuntime({ root, configPath: configFile });
    try {
      const report = await setup.run({
        json: hasFlag(args, "--json"),
        assumeYes: hasFlag(args, "--yes"),
        backgroundAgent: !hasFlag(args, "--no-background-agent"),
        syncHandoff: !hasFlag(args, "--no-sync-handoff") && !hasFlag(args, "--no-smoke-sync"),
      });
      if (hasFlag(args, "--json")) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return exitCodeForSetup(report);
    } catch (error) {
      if (error instanceof SetupCancelledError) {
        process.stderr.write("Setup cancelled.\n");
        return 1;
      }
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return 2;
    }
  }

  let runtime: TraceRuntime | null = null;
  const getRuntime = (): TraceRuntime => {
    runtime ??= new TraceRuntime({ root, configPath: configFile });
    return runtime;
  };
  try {
    if (command === "status") {
      const appExit = await runProtectedCommandViaApp("health", args, root, configFile, 120_000);
      if (appExit !== null) return appExit;
      const report = await getRuntime().health();
      if (hasFlag(args, "--json")) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      else process.stdout.write(formatHealthText(report));
      return exitCodeForHealth(report);
    }
    if (command === "pause" || command === "resume") {
      return runSyncControl(command, args, root, configFile);
    }
    if (command === "sync") {
      const originalArgs = [...args];
      const syncControl = args[0] && !args[0].startsWith("--") && ["status", "pause", "resume"].includes(args[0]) ? args.shift()! : null;
      if (syncControl) return runSyncControl(syncControl, args, root, configFile);
      if (hasFlag(args, "--smoke")) {
        const sourceArg = positionalArgs(args)[0] ?? "all";
        const source = sourceArg === "all" ? null : resolveSource(sourceArg, builtinSourceIds());
        const appExit = await runProtectedCommandViaApp(command, originalArgs, root, configFile, 20_000);
        if (appExit !== null) return appExit;
        const report = await getRuntime().smoke(source);
        if (hasFlag(args, "--json")) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        else process.stdout.write(formatSmokeText(report));
        return report.status === "critical" ? 2 : report.status === "warning" ? 1 : 0;
      }
      const parsed = parseSync(args);
      const request: SyncRequest = parsed.source === null ? parsed : { ...parsed, source: resolveSource(parsed.source, builtinSourceIds()) };
      const appExit = await runProtectedCommandViaApp(command, originalArgs, root, configFile, request.budget.maxRuntimeMs + 180_000);
      if (appExit !== null) return appExit;
      const runtime = getRuntime();
      const report = await runtime.sync(request);
      if (hasFlag(args, "--json")) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      else process.stdout.write(formatSyncText(report));
      if (request.failOnPartial && report.sources.some((source) => source.status === "partial")) return 75;
      return report.status === "critical" ? 2 : report.status === "warning" ? 1 : 0;
    }
    if (command === "health") {
      const appExit = await runProtectedCommandViaApp(command, args, root, configFile, 120_000);
      if (appExit !== null) return appExit;
      const runtime = getRuntime();
      const report = await runtime.health();
      if (hasFlag(args, "--json")) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        process.stdout.write(formatHealthText(report));
      }
      return exitCodeForHealth(report);
    }
    if (command === "doctor") {
      const originalArgs = [...args];
      const appExit = await runProtectedCommandViaApp(command, originalArgs, root, configFile, 120_000);
      if (appExit !== null) return appExit;
      const sourceArg = args[0] && !args[0].startsWith("--") ? args.shift() : undefined;
      const source = sourceArg ? resolveSource(sourceArg, builtinSourceIds()) : undefined;
      const runtime = getRuntime();
      const report = await runtime.health(source ? { source } : {});
      if (hasFlag(args, "--json")) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      else process.stdout.write(formatHealthText(report));
      return exitCodeForHealth(report);
    }
    if (command === "dashboard") {
      const flags = parseFlags(args);
      const port = parseIntegerFlag(flags, "port", 0, { min: 0, max: 65_535 });
      const runtime = getRuntime();
      const server = await serveDashboard(runtime, {
        host: typeof flags.host === "string" ? flags.host : "127.0.0.1",
        port,
        openBrowser: !hasFlag(args, "--no-open"),
      });
      process.stdout.write(`${server.url}\n`);
      await server.waitClosed();
      return 0;
    }
    if (command === "app") {
      return await runAppCommand(args, root, configFile);
    }
    if (command === "reset") {
      const request = parseReset(args);
      const reset = new ResetRuntime({ root, configPath: configFile });
      const report = await reset.run(request);
      if (hasFlag(args, "--json")) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      else process.stdout.write(formatResetText(report));
      return report.status === "ok" ? 0 : 1;
    }
    if (command === "import") {
      const parsed = parseImport(args);
      const dryRun = hasFlag(args, "--dry-run");
      const runtime = getRuntime();
      const report = await runtime.importProviderExport({
        source: resolveSource(parsed.source, builtinSourceIds()),
        path: parsed.path,
        dryRun,
        budget: DEFAULT_SYNC_BUDGET,
      });
      print(args, report);
      return report.status === "critical" ? 2 : report.status === "warning" || report.status === "partial" ? 1 : 0;
    }
    throw new UsageError(`unknown command: ${command}`);
  } finally {
    const openedRuntime = runtime as TraceRuntime | null;
    await openedRuntime?.close();
  }
}

function parseGlobal(argv: string[]): { root?: string; rest: string[] } {
  const rest = [...argv];
  let root: string | undefined;
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === "--root") {
      root = rest[i + 1];
      rest.splice(i, 2);
      i -= 1;
    }
  }
  return { root, rest };
}

function parseImport(args: string[]): { source: SourceId; path: string } {
  const source = args[0] && !args[0].startsWith("--") ? (args.shift() as SourceId) : null;
  if (!source) throw new UsageError(`${CLI_NAME} import requires a plugin name`);
  const positional = positionalArgs(args);
  const path = positional[0];
  if (!path) throw new UsageError(`${CLI_NAME} import requires an archive path`);
  return { source, path };
}

function parseReset(args: string[]): { mode: ResetMode; sources: SourceId[]; yes: boolean; json: boolean } {
  const modeArg = args[0] && !args[0].startsWith("--") ? args.shift()! : "guided";
  const modeAliases: Record<string, ResetMode> = {
    guided: "guided",
    data: "data",
    source: "source",
    sources: "source",
    logs: "logs",
    log: "logs",
    all: "all",
  };
  const mode = modeAliases[modeArg];
  if (!mode) throw new UsageError(`${CLI_NAME} reset needs data, source, logs, or all`);
  const sources =
    mode === "source"
      ? positionalArgs(args).map((source) => resolveSource(source, builtinSourceIds()))
      : [];
  return {
    mode,
    sources,
    yes: hasFlag(args, "--yes"),
    json: hasFlag(args, "--json"),
  };
}

async function runSyncControl(action: string, args: string[], root: string, configPath: string): Promise<number> {
  const json = hasFlag(args, "--json");
  if (action === "status") {
    const runtime = new TraceRuntime({ root, configPath });
    try {
      const report = await runtime.health();
      const status = syncStatusJson(report);
      if (json) process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
      else process.stdout.write(formatSyncStatusText(report));
      return report.app.backgroundSync === "unknown" ? 2 : 0;
    } finally {
      await runtime.close();
    }
  }
  if (action !== "pause" && action !== "resume") throw new UsageError(`${CLI_NAME} sync needs status, pause, or resume`);
  const config = loadConfig(root, configPath);
  const appPath = ensureStableAppPath(config);
  if (!existsSync(appExecutable(appPath))) {
    throw new TraceError(
      "nutshell_app_not_installed",
      `Nutshell.app is not installed at ${appExecutable(appPath)}. Run ${CLI_NAME} setup after installing Nutshell.`,
      69,
    );
  }
  if (action === "pause") {
    const result = await runNutshellAppCommand(appPath, ["disable-sync"], 30_000);
    if (json) process.stdout.write(`${JSON.stringify({ status: result.code === 0 ? "ok" : "error", action, code: result.code }, null, 2)}\n`);
    else process.stdout.write(result.code === 0 ? "Automatic sync paused.\n\nRun `nutshell sync resume` to turn it back on.\n" : result.stderr || result.stdout);
    return result.code;
  }
  const enable = await runNutshellAppCommand(appPath, ["enable-sync"], 30_000);
  const register = enable.code === 0 ? await runNutshellAppCommand(appPath, ["register-agent"], 30_000) : null;
  const ok = enable.code === 0 && register?.code === 0;
  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          status: ok ? "ok" : "error",
          action,
          enable: { code: enable.code, stdout: enable.stdout, stderr: enable.stderr },
          register: register ? { code: register.code, stdout: register.stdout, stderr: register.stderr } : null,
        },
        null,
        2,
      )}\n`,
    );
  } else if (ok) {
    process.stdout.write("Automatic sync resumed.\n\nRun `nutshell sync` if you want to sync now.\n");
  } else {
    process.stderr.write([enable.stderr || enable.stdout, register?.stderr || register?.stdout].filter(Boolean).join("\n"));
  }
  return ok ? 0 : enable.code || register?.code || 1;
}

function positionalArgs(args: string[]): string[] {
  const values: string[] = [];
  const valueFlags = new Set(["--source", "--mode", "--collection", "--since", "--until", "--timeout", "--max-requests", "--host", "--port"]);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg.startsWith("--")) {
      if (valueFlags.has(arg)) i += 1;
      continue;
    }
    values.push(arg);
  }
  return values;
}

function parseSync(args: string[]): SyncRequest {
  const sourceArg = args[0] && !args[0].startsWith("--") ? args.shift()! : "all";
  const flags = parseFlags(args);
  const mode = ((flags.mode as SyncMode | undefined) ?? "recent") as SyncMode;
  if (mode !== "recent" && mode !== "backfill") throw new UsageError(`${CLI_NAME} sync --mode must be recent or backfill`);
  const timeoutSeconds = parseIntegerFlag(flags, "timeout", Math.ceil(DEFAULT_SYNC_BUDGET.maxRuntimeMs / 1000), { min: 1 });
  const maxRequests = parseNullableIntegerFlag(flags, "max-requests", DEFAULT_SYNC_BUDGET.maxRequests, { min: 1 });
  return {
    source: sourceArg === "all" ? null : (sourceArg as SourceId),
    mode,
    window: flags.since || flags.until ? { start: flags.since ? new Date(flags.since) : null, end: flags.until ? new Date(flags.until) : null } : null,
    collections: collectFlags(args, "--collection"),
    budget: {
      ...DEFAULT_SYNC_BUDGET,
      maxRuntimeMs: timeoutSeconds * 1000,
      maxRequests,
    },
    dryRun: hasFlag(args, "--dry-run"),
    failOnPartial: hasFlag(args, "--fail-on-partial"),
  };
}

function parseIntegerFlag(flags: Record<string, string>, name: string, fallback: number, options: { min?: number; max?: number } = {}): number {
  const raw = flags[name];
  if (raw === undefined) return fallback;
  return parseStrictInteger(raw, name, options);
}

function parseNullableIntegerFlag(flags: Record<string, string>, name: string, fallback: number | null, options: { min?: number; max?: number } = {}): number | null {
  const raw = flags[name];
  if (raw === undefined) return fallback;
  return parseStrictInteger(raw, name, options);
}

function parseStrictInteger(raw: string, name: string, options: { min?: number; max?: number }): number {
  const valueText = raw.trim();
  if (!/^\d+$/.test(valueText)) throw new UsageError(`${CLI_NAME} --${name} must be an integer`);
  const value = Number(valueText);
  if (!Number.isSafeInteger(value)) throw new UsageError(`${CLI_NAME} --${name} is too large`);
  if (options.min !== undefined && value < options.min) throw new UsageError(`${CLI_NAME} --${name} must be at least ${options.min}`);
  if (options.max !== undefined && value > options.max) throw new UsageError(`${CLI_NAME} --${name} must be at most ${options.max}`);
  return value;
}

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg?.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = args[i + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = "true";
    } else {
      flags[key] = next;
      i += 1;
    }
  }
  return flags;
}

function collectFlags(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === flag && args[i + 1]) values.push(args[i + 1]!);
  }
  return values;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function print(args: string[], value: unknown): void {
  if (hasFlag(args, "--json")) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  else process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function runAppCommand(args: string[], root: string, configPath: string): Promise<number> {
  const sub = args.shift() ?? "status";
  const flags = parseFlags(args);
  const appPath = appBundlePath(flags.app, root, configPath);
  const appExecutable = appCommandPath(flags.app, root, configPath);
  if (sub === "path") {
    process.stdout.write(`${appExecutable}\n`);
    return 0;
  }
  if (!existsSync(appExecutable)) {
    throw new TraceError(
      "nutshell_app_not_installed",
      `Nutshell.app is not installed at ${appExecutable}. Run \`bun run install:macos-app\` from the repo or install the macOS app bundle.`,
      69,
    );
  }
  if (sub === "setup" || sub === "onboard" || sub === "open") {
    const result = await runProcess(["/usr/bin/open", appPath], { timeoutMs: 30_000 });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    return result.code;
  }
  const allowed = new Set(["status", "register-agent", "unregister-agent", "enable-sync", "disable-sync", "open-full-disk-access", "verify", "health", "doctor", "sync", "help"]);
  if (!allowed.has(sub)) throw new UsageError(`${CLI_NAME} app requires setup, status, register-agent, unregister-agent, enable-sync, disable-sync, open-full-disk-access, verify, health, doctor, sync, or path`);
  const timeoutMs = sub === "sync" ? 10 * 60_000 : sub === "verify" || sub === "health" || sub === "doctor" ? 120_000 : 30_000;
  const result = await runNutshellAppCommand(appPath, [sub === "help" ? "help" : sub, ...args], timeoutMs);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.code;
}

async function runProtectedCommandViaApp(command: string, args: string[], root: string, configPath: string, timeoutMs: number): Promise<number | null> {
  if (!shouldUseAppHandoff(command)) return null;
  const appPath = ensureStableAppPath(loadConfig(root, configPath));
  if (!existsSync(appExecutable(appPath))) return null;
  const result = await runNutshellAppCommand(appPath, [command, ...args], timeoutMs);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.code;
}

export function shouldUseAppHandoff(
  command: string,
  env: Record<string, string | undefined> = process.env,
  argv1 = process.argv[1] ?? "",
  platform = process.platform,
): boolean {
  if (platform !== "darwin") return false;
  if (env.NUTSHELL_APP_BUNDLE_ID === "com.winterfell.nutshell") return false;
  if (env.NUTSHELL_DISABLE_APP_HANDOFF === "1") return false;
  if (!["health", "doctor", "sync"].includes(command)) return false;
  return !/(^|[/\\])src[/\\]cli\.ts$/.test(argv1);
}

function appCommandPath(rawPath: string | undefined, root: string, configPath: string): string {
  return join(appBundlePath(rawPath, root, configPath), "Contents", "MacOS", "Nutshell");
}

function appBundlePath(rawPath: string | undefined, root: string, configPath: string): string {
  if (rawPath || process.env[APP_PATH_ENV]) return resolve(expandHome(rawPath || process.env[APP_PATH_ENV] || DEFAULT_APP_PATH));
  return ensureStableAppPath(loadConfig(root, configPath));
}

// Static help only: printing help must never touch config, disk state, or the network.
function helpText(topic?: string): string {
  const normalized = topic === "health" ? "status" : topic;
  if (normalized === "pause" || normalized === "resume") return syncHelpText();
  if (normalized === "sync") return syncHelpText();
  if (normalized === "reset") return resetHelpText();
  if (normalized === "setup") return setupHelpText();
  if (normalized === "status") return statusHelpText();
  if (normalized === "doctor") return doctorHelpText();
  if (normalized === "dashboard") return dashboardHelpText();
  if (normalized === "import") return importHelpText();
  return [
    "Nutshell",
    "Sync configured sources into a local digital trace for LLM agents.",
    "",
    "Common tasks:",
    `  ${CLI_NAME} setup              Set up Nutshell or fix a broken source`,
    `  ${CLI_NAME} status             See what is working and what needs attention`,
    `  ${CLI_NAME} sync               Sync everything now`,
    `  ${CLI_NAME} sync pause         Pause automatic sync`,
    `  ${CLI_NAME} sync resume        Resume automatic sync`,
    `  ${CLI_NAME} reset              Clear local data for a fresh sync test`,
    `  ${CLI_NAME} dashboard          Open the local dashboard`,
    `  ${CLI_NAME} import             Import provider history exports`,
    "",
    "Troubleshooting:",
    `  ${CLI_NAME} doctor             Explain the current problem and how to fix it`,
    `  ${CLI_NAME} doctor youtube     Diagnose one source`,
    "",
    "More help:",
    `  ${CLI_NAME} help sync`,
    `  ${CLI_NAME} help reset`,
    `  ${CLI_NAME} help setup`,
    "",
  ].join("\n");
}

function formatSmokeText(report: SmokeReport): string {
  const lines = [`Connection check: ${report.status}`, `Store: ${report.store.status} — ${report.store.message}`];
  for (const source of report.sources) {
    lines.push(`${source.source}: ${source.status} — ${source.message}`);
  }
  return `${lines.join("\n")}\n`;
}

function syncHelpText(): string {
  return [
    "Sync",
    "",
    `  ${CLI_NAME} sync              Sync all enabled sources now`,
    `  ${CLI_NAME} sync youtube      Sync one source now`,
    `  ${CLI_NAME} sync status       Show automatic sync status, last run, and next run`,
    `  ${CLI_NAME} sync pause        Pause automatic sync`,
    `  ${CLI_NAME} sync resume       Resume automatic sync`,
    `  ${CLI_NAME} sync --json       Print machine-readable output`,
    "",
    "Fresh test:",
    `  ${CLI_NAME} reset data        Clear records and checkpoints first`,
    "",
  ].join("\n");
}

function resetHelpText(): string {
  return [
    "Reset",
    "",
    "Clear local Nutshell-owned data.",
    "",
    `  ${CLI_NAME} reset                     Guided reset`,
    `  ${CLI_NAME} reset data                Clear records, checkpoints, artifacts, and dashboard data`,
    `  ${CLI_NAME} reset source youtube      Clear one source`,
    `  ${CLI_NAME} reset source youtube x    Clear multiple sources`,
    `  ${CLI_NAME} reset logs                Clear logs`,
    `  ${CLI_NAME} reset all                 Clear all Nutshell-owned local state`,
    "",
    "Reset does not delete Chrome login, Keychain items, macOS permissions, or browser profiles.",
    "",
  ].join("\n");
}

function setupHelpText(): string {
  return [
    "Setup",
    "",
    `  ${CLI_NAME} setup`,
    "",
    "Use setup for first run and for repairs. It checks permissions, verifies selected sources,",
    "offers provider export imports when a source supports them, and can enable automatic sync.",
    "",
  ].join("\n");
}

function statusHelpText(): string {
  return [
    "Status",
    "",
    `  ${CLI_NAME} status          See what is working and what needs attention`,
    `  ${CLI_NAME} doctor          Get the fix for the current problem`,
    `  ${CLI_NAME} doctor x        Diagnose one source`,
    "",
  ].join("\n");
}

function doctorHelpText(): string {
  return [
    "Doctor",
    "",
    `  ${CLI_NAME} doctor          Explain the current problem and how to fix it`,
    `  ${CLI_NAME} doctor youtube  Diagnose YouTube`,
    `  ${CLI_NAME} doctor x        Diagnose X`,
    "",
  ].join("\n");
}

function dashboardHelpText(): string {
  return ["Dashboard", "", `  ${CLI_NAME} dashboard          Open the local dashboard`, `  ${CLI_NAME} dashboard --no-open  Print the dashboard URL without opening a browser`, ""].join("\n");
}

function importHelpText(): string {
  return [
    "Import",
    "",
    "Load official provider exports for history/backfill.",
    "",
    `  ${CLI_NAME} import youtube ~/Downloads/google-export.zip`,
    `  ${CLI_NAME} import twitter ~/Downloads/x-archive.zip`,
    "",
  ].join("\n");
}

function syncStatusJson(report: HealthReport): JsonObject {
  return {
    automaticSync: report.app.backgroundSync === "enabled" ? "enabled" : report.app.backgroundSync === "disabled" ? "paused" : "unknown",
    app: { ...report.app },
    scheduler: { ...report.scheduler },
  };
}

function formatSyncStatusText(report: HealthReport): string {
  const automatic = report.app.backgroundSync === "enabled" ? "enabled" : report.app.backgroundSync === "disabled" ? "paused" : "unknown";
  return [
    "Sync status",
    "",
    `Automatic sync: ${automatic}`,
    `Last sync: ${report.scheduler.lastRunAt ?? "not yet"}`,
    `Next sync: ${report.scheduler.nextRunAt ?? "unknown"}`,
    "",
    automatic === "paused" ? `Run \`${CLI_NAME} sync resume\` to turn automatic sync back on.` : `Run \`${CLI_NAME} sync pause\` to pause automatic sync.`,
    "",
  ].join("\n");
}

// Documented source aliases. Canonical ids come from the loaded plugin
// registry; this map is the only alias knowledge the CLI carries.
const SOURCE_ALIASES: Record<string, SourceId> = {
  x: "twitter",
  notes: "apple_notes",
  podcast: "podcasts",
};

function resolveSource(arg: string, registryIds: SourceId[]): SourceId {
  const resolved = SOURCE_ALIASES[arg] ?? arg;
  if (registryIds.includes(resolved)) return resolved;
  const valid = registryIds
    .map((id) => {
      const aliases = Object.keys(SOURCE_ALIASES).filter((alias) => SOURCE_ALIASES[alias] === id);
      return aliases.length ? `${id} (${aliases.join(", ")})` : id;
    })
    .join(", ");
  throw new UsageError(`unknown source '${arg}' — valid sources: ${valid}`);
}

function builtinSourceIds(): SourceId[] {
  return loadBuiltinPlugins()
    .list()
    .map((plugin) => plugin.manifest.id);
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      if (error instanceof TraceError) {
        process.stderr.write(`${error.message}\n`);
        process.exit(error.exitCode);
      }
      process.stderr.write(`${String(error?.stack || error)}\n`);
      process.exit(1);
    },
  );
}
