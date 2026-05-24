#!/usr/bin/env bun
import { existsSync, rmSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { TraceError, UsageError } from "./core/errors";
import { CLI_NAME, COMMAND_ENV, PRODUCT_VERSION } from "./core/product";
import { DEFAULT_SYNC_BUDGET } from "./config/defaults";
import { ensureRoot, expandHome, loadConfig, numberAt, objectAt, resolveConfigPath, resolveRoot } from "./config/config";
import { TraceRuntime } from "./runtime/trace-runtime";
import { loadBuiltinPlugins } from "./plugins/registry";
import { exitCodeForHealth } from "./health/health";
import { formatHealthText } from "./health/reporters";
import { importGoogleTakeoutYoutube } from "./imports/google-takeout-youtube";
import { generatedLaunchdPlistPath, installedLaunchdPlistPath, LAUNCHD_LABEL, writeLaunchdPlist } from "./launchd/plist";
import { formatLaunchdStatusText, inspectLaunchd } from "./launchd/status";
import { runProcess } from "./runtime/process";
import { RuntimeLock } from "./runtime/lock";
import { runPodcastsSqliteWorkerFromStdin } from "./plugins/builtin/podcasts/sqlite-worker";
import { serveDashboard } from "./dashboard/server";
import type { ProjectionRequest, SourceId, SyncMode, SyncRequest } from "./core/types";

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
  if (command === "version" || command === "--version" || command === "-v") {
    process.stdout.write(`${CLI_NAME} ${PRODUCT_VERSION}\n`);
    return 0;
  }
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(helpText());
    return 0;
  }

  if (command === "init") {
    ensureRoot(root);
    const config = loadConfig(root, configFile);
    process.stdout.write(`Config: ${config.path}\nData: ${config.root}\n`);
    return 0;
  }

  const runtime = new TraceRuntime({ root, configPath: configFile });
  try {
    if (command === "plugins") {
      const plugins = loadBuiltinPlugins().enabled(runtime.config).map((plugin) => plugin.manifest);
      print(args, plugins);
      return 0;
    }
    if (command === "sync") {
      const request = parseSync(args);
      const report = await runtime.sync(request);
      print(args, report);
      if (request.failOnPartial && report.sources.some((source) => source.status === "partial")) return 75;
      return report.status === "critical" ? 2 : report.status === "warning" ? 1 : 0;
    }
    if (command === "health") {
      const report = await runtime.health();
      if (hasFlag(args, "--json")) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        process.stdout.write(formatHealthText(report));
      }
      return exitCodeForHealth(report);
    }
    if (command === "query") {
      const flags = parseFlags(args);
      const page = await runtime.query({
        source: flags.source as SourceId | undefined,
        type: flags.type,
        since: flags.since ? new Date(flags.since) : undefined,
        until: flags.until ? new Date(flags.until) : undefined,
        limit: flags.limit ? Number(flags.limit) : 200,
      });
      print(args, page);
      return 0;
    }
    if (command === "day") {
      const date = args.shift();
      if (!date) throw new UsageError(`${CLI_NAME} day requires YYYY-MM-DD`);
      const kind: ProjectionRequest["kind"] = hasFlag(args, "--markdown") ? "daily-markdown" : "daily-json";
      const report = await runtime.project({ kind, date });
      if (hasFlag(args, "--json")) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      else process.stdout.write(`${report.outputs.join("\n")}\n`);
      return 0;
    }
    if (command === "dashboard") {
      const flags = parseFlags(args);
      const server = await serveDashboard(runtime, {
        host: typeof flags.host === "string" ? flags.host : "127.0.0.1",
        port: flags.port ? Number(flags.port) : 0,
        openBrowser: !hasFlag(args, "--no-open"),
      });
      process.stdout.write(`${server.url}\n`);
      await server.waitClosed();
      return 0;
    }
    if (command === "import") {
      const sub = args.shift();
      const flags = parseFlags(args);
      if (!flags.path) throw new UsageError(`${CLI_NAME} import requires --path`);
      const importPath = flags.path;
      const dryRun = hasFlag(args, "--dry-run");
      if (sub === "youtube") {
        const report = await withWriteLock(runtime, `${CLI_NAME} import youtube --path ${importPath}`, dryRun, () =>
          importGoogleTakeoutYoutube(runtime.config, runtime.store, importPath, dryRun),
        );
        print(args, report);
        return report.available && (report.counts.items ?? 0) > 0 ? 0 : 1;
      }
      if (sub === "twitter") {
        const report = await runtime.importProviderExport({
          source: "twitter",
          path: importPath,
          dryRun,
          budget: DEFAULT_SYNC_BUDGET,
        });
        print(args, report);
        return report.status === "critical" ? 2 : report.status === "warning" || report.status === "partial" ? 1 : 0;
      }
      throw new UsageError(`${CLI_NAME} import requires youtube or twitter`);
    }
    if (command === "enrich") {
      const source = args.shift();
      if (!source) throw new UsageError(`${CLI_NAME} enrich requires a source`);
      const flags = parseFlags(args);
      const dryRun = hasFlag(args, "--dry-run");
      const limit = flags.limit ? Number(flags.limit) : 100;
      const report = await runtime.enrich({
        source: source as SourceId,
        limit,
        dryRun,
        budget: {
          ...DEFAULT_SYNC_BUDGET,
          maxRequests: limit,
          minDelayMs: flags.delay ? Number(flags.delay) : 500,
        },
      });
      print(args, report);
      return report.status === "critical" ? 2 : report.status === "warning" || report.status === "partial" ? 1 : 0;
    }
    if (command === "launchd") {
      const sub = args.shift();
      if (sub === "install") {
        const scheduler = objectAt(runtime.config.data, "scheduler");
        const nutshellCommand = currentNutshellCommand();
        const plist = writeLaunchdPlist(runtime.config.root, runtime.config.path, nutshellCommand, numberAt(scheduler, "intervalSeconds", 900));
        const domain = `gui/${process.getuid?.() ?? 501}`;
        await runProcess(["/bin/launchctl", "bootout", domain, plist.installedPath], { timeoutMs: 10_000 }).catch(() => undefined);
        const result = await runProcess(["/bin/launchctl", "bootstrap", domain, plist.installedPath], { timeoutMs: 10_000 });
        if (result.code !== 0) throw new TraceError("launchd_install_failed", result.stderr || result.stdout, 1);
        await runProcess(["/bin/launchctl", "enable", `${domain}/${LAUNCHD_LABEL}`], { timeoutMs: 10_000 }).catch(() => undefined);
        process.stdout.write(`${plist.installedPath}\n`);
        return 0;
      }
      if (sub === "uninstall") {
        const plist = installedLaunchdPlistPath();
        const domain = `gui/${process.getuid?.() ?? 501}`;
        const result = await runProcess(["/bin/launchctl", "bootout", domain, plist], { timeoutMs: 10_000 });
        rmSync(plist, { force: true });
        rmSync(generatedLaunchdPlistPath(runtime.config.root), { force: true });
        process.stdout.write(result.stdout || result.stderr || `uninstalled ${LAUNCHD_LABEL}\n`);
        return result.code === 0 || result.code === 113 ? 0 : 1;
      }
      if (sub === "status") {
        const report = await inspectLaunchd(runtime.config.root);
        if (hasFlag(args, "--json")) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        else process.stdout.write(formatLaunchdStatusText(report));
        return report.status === "ok" ? 0 : 1;
      }
      throw new UsageError(`${CLI_NAME} launchd requires install, uninstall, or status`);
    }
    throw new UsageError(`unknown command: ${command}`);
  } finally {
    await runtime.close();
  }
}

async function withWriteLock<T>(runtime: TraceRuntime, command: string, dryRun: boolean, run: () => Promise<T>): Promise<T> {
  if (dryRun) return run();
  const runtimeCfg = objectAt(runtime.config.data, "runtime");
  const lock = new RuntimeLock(join(runtime.config.root, "run.lock"), command, runtime.logger, {
    heartbeatMs: typeof runtimeCfg.lockHeartbeatMs === "number" ? runtimeCfg.lockHeartbeatMs : 30_000,
    staleMs: typeof runtimeCfg.staleLockMs === "number" ? runtimeCfg.staleLockMs : 10 * 60_000,
  });
  await lock.acquire();
  try {
    return await run();
  } finally {
    lock.release();
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

function parseSync(args: string[]): SyncRequest {
  const sourceArg = args[0] && !args[0].startsWith("--") ? args.shift()! : "all";
  const flags = parseFlags(args);
  const mode = ((flags.mode as SyncMode | undefined) ?? "recent") as SyncMode;
  if (mode !== "recent" && mode !== "backfill") throw new UsageError(`${CLI_NAME} sync --mode must be recent or backfill`);
  return {
    source: sourceArg === "all" ? null : (sourceArg as SourceId),
    mode,
    window: flags.since || flags.until ? { start: flags.since ? new Date(flags.since) : null, end: flags.until ? new Date(flags.until) : null } : null,
    collections: collectFlags(args, "--collection"),
    budget: {
      ...DEFAULT_SYNC_BUDGET,
      maxRuntimeMs: flags.timeout ? Number(flags.timeout) * 1000 : DEFAULT_SYNC_BUDGET.maxRuntimeMs,
      maxRequests: flags["max-requests"] ? Number(flags["max-requests"]) : DEFAULT_SYNC_BUDGET.maxRequests,
    },
    dryRun: hasFlag(args, "--dry-run"),
    failOnPartial: hasFlag(args, "--fail-on-partial"),
  };
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

function currentNutshellCommand(): string[] {
  if (import.meta.dir.startsWith("/$bunfs/")) return [process.execPath];
  const explicit = process.env[COMMAND_ENV];
  if (explicit) return [resolve(expandHome(explicit))];
  const installed = findOnPath(CLI_NAME);
  if (installed) return [installed];
  throw new TraceError(
    "nutshell_not_installed",
    "Install Nutshell into your PATH before installing the background job. The daemon must run the same stable `nutshell` command you run in Terminal.",
    69,
  );
}

function findOnPath(name: string): string | null {
  const path = process.env.PATH || "";
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const candidate = resolve(expandHome(dir), name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function helpText(): string {
  return `${CLI_NAME} init
${CLI_NAME} plugins
${CLI_NAME} sync [source|all] [--mode recent|backfill] [--collection name] [--since date] [--until date] [--dry-run] [--json]
${CLI_NAME} import [youtube|twitter] --path <provider-export> [--dry-run] [--json]
${CLI_NAME} enrich twitter [--limit N] [--json]
${CLI_NAME} health [--json]
${CLI_NAME} query [--source source] [--since date] [--until date] [--type type] [--json]
${CLI_NAME} day YYYY-MM-DD [--json|--markdown]
${CLI_NAME} dashboard [--no-open] [--host 127.0.0.1] [--port 0]
${CLI_NAME} launchd install
${CLI_NAME} launchd uninstall
${CLI_NAME} launchd status [--json]
`;
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
