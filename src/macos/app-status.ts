import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { AppBackgroundStatus, JsonObject } from "../core/types";
import { APP_PATH_ENV, DEFAULT_APP_PATH } from "../core/product";
import { expandHome, objectAt, type TraceConfig } from "../config/config";
import { runProcess } from "../runtime/process";

export function configuredAppPath(config: TraceConfig, explicit?: string): string {
  const requested = explicit || process.env[APP_PATH_ENV];
  if (requested) return resolve(expandHome(requested));
  const configured = stringValue(objectAt(config.data, "app"), "path");
  const configuredPath = configured ? resolve(expandHome(configured)) : "";
  if (configuredPath && existsSync(appExecutable(configuredPath)) && !isHomebrewCellarApp(configuredPath)) return configuredPath;
  for (const candidate of appPathCandidates()) {
    if (existsSync(join(candidate, "Contents", "MacOS", "Nutshell"))) return candidate;
  }
  return configuredPath || DEFAULT_APP_PATH;
}

export async function inspectNutshellApp(config: TraceConfig, explicit?: string): Promise<AppBackgroundStatus> {
  const path = configuredAppPath(config, explicit);
  const executable = appExecutable(path);
  if (!existsSync(executable)) {
    return {
      installed: false,
      path,
      executable,
      fullDiskAccess: "unknown",
      backgroundSync: "unknown",
      agent: "unknown",
      dataRoot: null,
      raw: "",
    };
  }
  const result = await runProcess([executable, "status"], { timeoutMs: 30_000 });
  const raw = `${result.stdout}\n${result.stderr}`.trim();
  return parseNutshellAppStatus(raw, path, executable);
}

export function parseNutshellAppStatus(raw: string, path: string, executable = appExecutable(path)): AppBackgroundStatus {
  const fullDisk = valueAfter(raw, "Full Disk Access");
  const agent = valueAfter(raw, "Agent status");
  const sync = valueAfter(raw, "Background sync");
  const dataRoot = valueAfter(raw, "Data root");
  return {
    installed: true,
    path,
    executable,
    fullDiskAccess: fullDisk === "granted" ? "granted" : fullDisk === "not granted" || fullDisk === "missing" ? "missing" : "unknown",
    backgroundSync: sync === "enabled" ? "enabled" : sync === "disabled" ? "disabled" : "unknown",
    agent: normalizeAgent(agent),
    dataRoot: dataRoot || null,
    raw,
  };
}

export function appExecutable(appPath: string): string {
  return join(appPath, "Contents", "MacOS", "Nutshell");
}

export function appStatusJson(status: AppBackgroundStatus): JsonObject {
  return {
    installed: status.installed,
    path: status.path,
    executable: status.executable,
    fullDiskAccess: status.fullDiskAccess,
    backgroundSync: status.backgroundSync,
    agent: status.agent,
    dataRoot: status.dataRoot,
  };
}

function appPathCandidates(): string[] {
  const home = process.env.HOME || "";
  const executableDir = dirname(process.execPath || process.argv[1] || "");
  const scriptDir = dirname(process.argv[1] || process.execPath || "");
  return [
    DEFAULT_APP_PATH,
    home ? join(home, "Applications", "Nutshell.app") : "",
    resolve(executableDir, "..", "Nutshell.app"),
    resolve(scriptDir, "..", "Nutshell.app"),
  ].filter(Boolean);
}

function valueAfter(raw: string, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = raw.match(new RegExp(`^${escaped}:\\s*(.+)$`, "im"));
  return match?.[1]?.trim() ?? "";
}

function normalizeAgent(value: string): AppBackgroundStatus["agent"] {
  if (value === "enabled") return "enabled";
  if (value === "requiresApproval") return "requiresApproval";
  if (value === "notRegistered") return "notRegistered";
  if (value === "notFound") return "notFound";
  return "unknown";
}

function stringValue(value: JsonObject, key: string): string {
  const child = value[key];
  return typeof child === "string" ? child : "";
}

function isHomebrewCellarApp(path: string): boolean {
  return /\/Cellar\/nutshell\/[^/]+\/Nutshell\.app$/.test(path);
}
