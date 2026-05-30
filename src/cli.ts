#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { TraceError, UsageError } from "./core/errors";
import { APP_PATH_ENV, CLI_NAME, DEFAULT_APP_PATH, PRODUCT_VERSION } from "./core/product";
import { DEFAULT_SYNC_BUDGET } from "./config/defaults";
import { expandHome, loadConfig, resolveConfigPath, resolveRoot } from "./config/config";
import { TraceRuntime } from "./runtime/trace-runtime";
import { exitCodeForHealth } from "./health/health";
import { formatHealthText } from "./health/reporters";
import { runProcess } from "./runtime/process";
import { configuredAppPath, ensureStableAppPath } from "./macos/app-status";
import { runPodcastsSqliteWorkerFromStdin } from "./plugins/builtin/podcasts/sqlite-worker";
import { serveDashboard } from "./dashboard/server";
import { SetupRuntime, exitCodeForSetup } from "./setup/setup-runtime";
import type { SourceId, SyncMode, SyncRequest } from "./core/types";

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
  if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
    process.stdout.write(helpText());
    return 0;
  }

  if (command === "setup") {
    const setup = new SetupRuntime({ root, configPath: configFile });
    const report = await setup.run({
      json: hasFlag(args, "--json"),
      assumeYes: hasFlag(args, "--yes"),
      backgroundAgent: !hasFlag(args, "--no-background-agent"),
      syncHandoff: !hasFlag(args, "--no-sync-handoff") && !hasFlag(args, "--no-smoke-sync"),
    });
    if (hasFlag(args, "--json")) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return exitCodeForSetup(report);
  }

  let runtime: TraceRuntime | null = null;
  const getRuntime = (): TraceRuntime => {
    runtime ??= new TraceRuntime({ root, configPath: configFile });
    return runtime;
  };
  try {
    if (command === "sync") {
      const request = parseSync(args);
      const runtime = getRuntime();
      const report = await runtime.sync(request);
      print(args, report);
      if (request.failOnPartial && report.sources.some((source) => source.status === "partial")) return 75;
      return report.status === "critical" ? 2 : report.status === "warning" ? 1 : 0;
    }
    if (command === "health") {
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
      const source = args[0] && !args[0].startsWith("--") ? (args.shift() as SourceId) : undefined;
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
    if (command === "import") {
      const parsed = parseImport(args);
      const dryRun = hasFlag(args, "--dry-run");
      const runtime = getRuntime();
      const report = await runtime.importProviderExport({
        source: parsed.source,
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
  const allowed = new Set(["status", "register-agent", "unregister-agent", "enable-sync", "disable-sync", "open-full-disk-access", "verify", "help"]);
  if (!allowed.has(sub)) throw new UsageError(`${CLI_NAME} app requires setup, status, register-agent, unregister-agent, enable-sync, disable-sync, open-full-disk-access, verify, or path`);
  const result = await runProcess([appExecutable, sub === "help" ? "help" : sub], { timeoutMs: sub === "verify" ? 120_000 : 30_000 });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.code;
}

function appCommandPath(rawPath: string | undefined, root: string, configPath: string): string {
  return join(appBundlePath(rawPath, root, configPath), "Contents", "MacOS", "Nutshell");
}

function appBundlePath(rawPath: string | undefined, root: string, configPath: string): string {
  if (rawPath || process.env[APP_PATH_ENV]) return resolve(expandHome(rawPath || process.env[APP_PATH_ENV] || DEFAULT_APP_PATH));
  return ensureStableAppPath(loadConfig(root, configPath));
}

function helpText(): string {
  return `${CLI_NAME} setup
${CLI_NAME} sync [all|plugin] [--json]
${CLI_NAME} health [--json]
${CLI_NAME} dashboard [--no-open] [--host 127.0.0.1] [--port 0]
${CLI_NAME} doctor [plugin] [--json]
${CLI_NAME} import <plugin> <archive-path> [--dry-run] [--json]
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
