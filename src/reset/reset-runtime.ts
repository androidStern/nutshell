import { existsSync, rmSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import type { JsonObject, SourceId, TraceLogger } from "../core/types";
import { CLI_NAME, CONFIG_FILENAME } from "../core/product";
import { loadConfig, storePath, type TraceConfig } from "../config/config";
import { RuntimeLock } from "../runtime/lock";
import { openStore } from "../store/sqlite-store";
import type { PluginRegistry } from "../plugins/registry";
import { loadBuiltinPlugins } from "../plugins/registry";
import { ClackSetupUI } from "../setup/ui-clack";
import type { SetupUI } from "../setup/types";

export type ResetMode = "guided" | "data" | "source" | "logs" | "all";

export interface ResetRequest {
  mode: ResetMode;
  sources?: SourceId[];
  yes: boolean;
  json: boolean;
}

export interface ResetReport {
  status: "ok" | "cancelled";
  mode: Exclude<ResetMode, "guided">;
  sources: SourceId[];
  message: string;
  deleted: string[];
  kept: string[];
  detail: JsonObject;
}

export interface ResetRuntimeOptions {
  root: string;
  configPath?: string;
  config?: TraceConfig;
  registry?: PluginRegistry;
  ui?: SetupUI;
}

const RESET_WORD = "RESET";

export class ResetRuntime {
  readonly config: TraceConfig;
  readonly registry: PluginRegistry;
  readonly ui: SetupUI;

  constructor(options: ResetRuntimeOptions) {
    this.config = options.config ?? loadConfig(options.root, options.configPath);
    this.registry = options.registry ?? loadBuiltinPlugins();
    this.ui = options.ui ?? new ClackSetupUI();
  }

  async run(request: ResetRequest): Promise<ResetReport> {
    const resolved = await this.resolveRequest(request);
    if (!request.yes) {
      const confirmed = await this.confirm(resolved);
      if (!confirmed) return cancelledReport(resolved);
    }
    return this.withResetLock(resolved, () => this.applyReset(resolved));
  }

  private async resolveRequest(request: ResetRequest): Promise<ResolvedResetRequest> {
    if (request.mode === "guided") {
      await this.ui.intro({
        title: "Nutshell reset",
        body: "Clear local Nutshell data without touching Chrome login, Keychain, macOS permissions, or browser profiles.",
      });
      const mode = await this.ui.select<Exclude<ResetMode, "guided">>({
        title: "What do you want to reset?",
        options: [
          {
            label: "Fresh sync data",
            value: "data",
            hint: "Records, checkpoints, run history, artifacts, dashboard data.",
          },
          {
            label: "One or more sources",
            value: "source",
            hint: "Reset only selected source data.",
          },
          { label: "Logs only", value: "logs", hint: "Delete Nutshell logs." },
          {
            label: "Everything Nutshell owns",
            value: "all",
            hint: "Data, setup state, secrets, logs, generated files.",
          },
        ],
      });
      return this.resolveRequest({ ...request, mode });
    }
    if (request.mode === "source") {
      const sources = request.sources?.length ? request.sources : await this.chooseSources();
      return { mode: "source", sources };
    }
    return { mode: request.mode, sources: [] };
  }

  private async chooseSources(): Promise<SourceId[]> {
    const plugins = this.enabledOrKnownPlugins();
    return this.ui.multiselect({
      title: "Choose sources to reset",
      options: plugins.map((plugin) => ({
        label: plugin.manifest.displayName,
        value: plugin.manifest.id,
        hint: plugin.manifest.id,
      })),
      initialValues: plugins.map((plugin) => plugin.manifest.id),
    });
  }

  private enabledOrKnownPlugins() {
    const enabled = this.registry.enabled(this.config);
    return enabled.length ? enabled : this.registry.list();
  }

  private async confirm(request: ResolvedResetRequest): Promise<boolean> {
    const text = resetConfirmationText(request);
    await this.ui.note({ title: resetTitle(request), body: text });
    const typed = await this.ui.text({ title: `Type ${RESET_WORD} to continue` });
    return typed.trim() === RESET_WORD;
  }

  private async withResetLock<T>(request: ResolvedResetRequest, run: () => Promise<T>): Promise<T> {
    const lock = new RuntimeLock(join(this.config.root, "run.lock"), `${CLI_NAME} reset ${request.mode}`, noopLogger, {
      heartbeatMs: 30_000,
      staleMs: 10 * 60_000,
    });
    await lock.acquire();
    try {
      return await run();
    } finally {
      lock.release();
    }
  }

  private async applyReset(request: ResolvedResetRequest): Promise<ResetReport> {
    if (request.mode === "source") return this.resetSources(request.sources);
    if (request.mode === "logs") return this.resetLogs();
    if (request.mode === "all") return this.resetAll();
    return this.resetData();
  }

  private async resetData(): Promise<ResetReport> {
    const deleted = [
      ...removeSqliteFiles(storePath(this.config)),
      ...removeDirs([join(this.config.root, "artifacts"), join(this.config.root, "projections")]),
    ];
    return okReport("data", [], "Fresh sync data reset.", deleted, DATA_KEPT, {});
  }

  private async resetSources(sources: SourceId[]): Promise<ResetReport> {
    const store = openStore(storePath(this.config));
    try {
      const result = await store.resetSources(sources);
      const artifactFiles = removeFiles(result.artifactPaths);
      const sourceDirs = removeDirs(sources.map((source) => join(this.config.root, "artifacts", source)));
      const projections = removeDirs([join(this.config.root, "projections")]);
      return okReport(
        "source",
        sources,
        `${sourceList(sources)} data reset.`,
        [...artifactFiles, ...sourceDirs, ...projections],
        SOURCE_KEPT,
        result as unknown as JsonObject,
      );
    } finally {
      await store.close();
    }
  }

  private async resetLogs(): Promise<ResetReport> {
    const deleted = removeDirs([join(this.config.root, "logs")]);
    return okReport("logs", [], "Nutshell logs reset.", deleted, LOGS_KEPT, {});
  }

  private async resetAll(): Promise<ResetReport> {
    const deleted = [
      ...removeSqliteFiles(storePath(this.config)),
      ...removeDirs([join(this.config.root, "artifacts"), join(this.config.root, "projections"), join(this.config.root, "logs")]),
      ...removeFiles([join(this.config.root, "secrets.json"), join(this.config.root, ".agent-sync-enabled"), this.config.path]),
    ];
    return okReport("all", [], "Nutshell-owned local state reset.", deleted, ALL_KEPT, {
      preservedBrowserProfiles: existsSync(join(this.config.root, "browser-profiles")),
    });
  }
}

interface ResolvedResetRequest {
  mode: Exclude<ResetMode, "guided">;
  sources: SourceId[];
}

const DATA_KEPT = [
  "setup choices and config",
  "secrets",
  "Chrome login and Keychain items",
  "macOS permissions",
  "browser profiles",
  "automatic sync setting",
];

const SOURCE_KEPT = [
  "other sources",
  "setup choices and config",
  "secrets",
  "Chrome login and Keychain items",
  "macOS permissions",
  "browser profiles",
  "automatic sync setting",
];

const LOGS_KEPT = ["records", "checkpoints", "artifacts", "config", "secrets", "automatic sync setting"];

const ALL_KEPT = ["Chrome login and Keychain items", "macOS permissions", "browser profiles"];

function resetTitle(request: ResolvedResetRequest): string {
  if (request.mode === "source") return `Reset ${sourceList(request.sources)}?`;
  if (request.mode === "logs") return "Reset logs?";
  if (request.mode === "all") return "Reset all Nutshell-owned local state?";
  return "Reset fresh sync data?";
}

function resetConfirmationText(request: ResolvedResetRequest): string {
  const deletes =
    request.mode === "source"
      ? [`${sourceList(request.sources)} records`, `${sourceList(request.sources)} checkpoints`, `${sourceList(request.sources)} sync history`, `${sourceList(request.sources)} artifacts`, "generated dashboard and daily projections"]
      : request.mode === "logs"
        ? ["Nutshell logs"]
        : request.mode === "all"
          ? ["records and checkpoints", "source run history", "generated artifacts", "dashboard and daily projections", "logs", "secrets", CONFIG_FILENAME, "automatic sync setting"]
          : ["records", "checkpoints", "source run history", "generated artifacts", "dashboard and daily projections"];
  const kept = request.mode === "source" ? SOURCE_KEPT : request.mode === "logs" ? LOGS_KEPT : request.mode === "all" ? ALL_KEPT : DATA_KEPT;
  return [`This will delete:`, ...deletes.map((item) => `- ${item}`), "", "This will keep:", ...kept.map((item) => `- ${item}`)].join("\n");
}

function cancelledReport(request: ResolvedResetRequest): ResetReport {
  return {
    status: "cancelled",
    mode: request.mode,
    sources: request.sources,
    message: "Reset cancelled.",
    deleted: [],
    kept: [],
    detail: {},
  };
}

function okReport(
  mode: ResetReport["mode"],
  sources: SourceId[],
  message: string,
  deleted: string[],
  kept: string[],
  detail: JsonObject,
): ResetReport {
  return { status: "ok", mode, sources, message, deleted, kept, detail };
}

function removeSqliteFiles(path: string): string[] {
  return removeFiles([path, `${path}-wal`, `${path}-shm`]);
}

function removeFiles(paths: string[]): string[] {
  const deleted: string[] = [];
  for (const path of [...new Set(paths.filter(Boolean))]) {
    if (!existsSync(path)) continue;
    try {
      unlinkSync(path);
      deleted.push(path);
    } catch {
      rmSync(path, { recursive: true, force: true });
      deleted.push(path);
    }
  }
  return deleted;
}

function removeDirs(paths: string[]): string[] {
  const deleted: string[] = [];
  for (const path of [...new Set(paths.filter(Boolean))]) {
    if (!existsSync(path)) continue;
    rmSync(path, { recursive: true, force: true });
    deleted.push(path);
  }
  return deleted;
}

function sourceList(sources: SourceId[]): string {
  if (sources.length === 0) return "selected source";
  if (sources.length === 1) return sources[0]!;
  return `${sources.slice(0, -1).join(", ")} and ${sources[sources.length - 1]}`;
}

export function formatResetText(report: ResetReport): string {
  const lines = [report.message];
  if (report.deleted.length) {
    lines.push("", "Deleted:");
    lines.push(...report.deleted.map((path) => `  ${displayPath(path)}`));
  } else {
    lines.push("", "Nothing needed deleting.");
  }
  if (report.kept.length) {
    lines.push("", "Kept:");
    lines.push(...report.kept.map((item) => `  ${item}`));
  }
  if (report.mode === "data" || report.mode === "source") {
    lines.push("", "Next:", `  ${CLI_NAME} sync${report.mode === "source" && report.sources.length === 1 ? ` ${report.sources[0]}` : ""} --json`);
  }
  return `${lines.join("\n")}\n`;
}

function displayPath(path: string): string {
  const home = process.env.HOME;
  if (home && path.startsWith(`${home}/`)) return `~/${path.slice(home.length + 1)}`;
  return basename(path) === path ? path : path;
}

const noopLogger: TraceLogger = {
  event() {},
  warn() {},
  error() {},
};
