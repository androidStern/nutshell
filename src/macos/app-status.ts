import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { AppBackgroundStatus, JsonObject } from "../core/types";
import { APP_PATH_ENV, DEFAULT_APP_PATH } from "../core/product";
import { expandHome, objectAt, type TraceConfig } from "../config/config";
import { runProcess, type RunProcessResult } from "../runtime/process";

interface AppCommandResult {
  code?: unknown;
  stdout?: unknown;
  stderr?: unknown;
}

export function configuredAppPath(config: TraceConfig, explicit?: string): string {
  const requested = explicit || process.env[APP_PATH_ENV];
  if (requested) return resolve(expandHome(requested));
  const configured = stringValue(objectAt(config.data, "app"), "path");
  const configuredPath = configured ? resolve(expandHome(configured)) : "";
  if (configuredPath && existsSync(appExecutable(configuredPath)) && !isHomebrewCellarApp(configuredPath)) return configuredPath;
  for (const candidate of stableAppPathCandidates()) {
    if (existsSync(join(candidate, "Contents", "MacOS", "Nutshell"))) return candidate;
  }
  for (const candidate of packageManagedAppPathCandidates()) {
    if (existsSync(join(candidate, "Contents", "MacOS", "Nutshell"))) return candidate;
  }
  return configuredPath || DEFAULT_APP_PATH;
}

export function ensureStableAppPath(config: TraceConfig, explicit?: string): string {
  const requested = explicit || process.env[APP_PATH_ENV];
  if (requested) return resolve(expandHome(requested));

  const current = configuredAppPath(config);
  const packaged = packageManagedAppPathCandidates().find((candidate) => existsSync(appExecutable(candidate)));
  if (!isHomebrewCellarApp(current)) {
    if (packaged && isStableAppPath(current) && packagedVersionDiffers(current, packaged)) {
      copyAppBundle(packaged, current);
    }
    return current;
  }

  const target = userApplicationsAppPath();
  if (existsSync(appExecutable(target)) && !packagedVersionDiffers(target, current)) return target;

  copyAppBundle(current, target);
  return target;
}

export async function inspectNutshellApp(config: TraceConfig, explicit?: string): Promise<AppBackgroundStatus> {
  const path = explicit ? configuredAppPath(config, explicit) : ensureStableAppPath(config);
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
  const result = await runNutshellAppCommand(path, ["status"], 30_000);
  const raw = `${result.stdout}\n${result.stderr}`.trim();
  return parseNutshellAppStatus(raw, path, executable);
}

export async function runNutshellAppCommand(appPath: string, args: string[], timeoutMs = 30_000): Promise<RunProcessResult> {
  const executable = appExecutable(appPath);
  if (process.platform !== "darwin" || !existsSync(join(appPath, "Contents", "Info.plist"))) {
    return runProcess([executable, ...args], { timeoutMs });
  }

  const tempDir = mkdtempSync(join(tmpdir(), "nutshell-app-command-"));
  const resultPath = join(tempDir, "result.json");
  try {
    const launched = await runProcess([
      "/usr/bin/open",
      "-W",
      "-n",
      appPath,
      "--args",
      ...args,
      "--result-file",
      resultPath,
    ], { timeoutMs });
    if (launched.code !== 0 || launched.timedOut) return launched;
    if (!existsSync(resultPath)) {
      return {
        code: 70,
        stdout: launched.stdout,
        stderr: launched.stderr || `Nutshell.app did not write command result: ${resultPath}`,
        timedOut: false,
      };
    }
    const parsed = JSON.parse(readFileSync(resultPath, "utf8")) as AppCommandResult;
    return {
      code: typeof parsed.code === "number" ? parsed.code : 70,
      stdout: typeof parsed.stdout === "string" ? parsed.stdout : "",
      stderr: typeof parsed.stderr === "string" ? parsed.stderr : "",
      timedOut: false,
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
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

function stableAppPathCandidates(): string[] {
  const home = process.env.HOME || "";
  return [
    DEFAULT_APP_PATH,
    home ? join(home, "Applications", "Nutshell.app") : "",
  ].filter(Boolean);
}

function isStableAppPath(path: string): boolean {
  const normalized = resolve(expandHome(path));
  return stableAppPathCandidates().some((candidate) => resolve(candidate) === normalized);
}

function packageManagedAppPathCandidates(): string[] {
  const executableDir = dirname(process.execPath || process.argv[1] || "");
  const scriptDir = dirname(process.argv[1] || process.execPath || "");
  return [
    resolve(executableDir, "..", "Nutshell.app"),
    resolve(scriptDir, "..", "Nutshell.app"),
  ].filter(Boolean);
}

function packagedVersionDiffers(stablePath: string, packagedPath: string): boolean {
  if (!existsSync(appExecutable(packagedPath))) return false;
  if (!existsSync(appExecutable(stablePath))) return true;
  const stableVersion = appBundleVersion(stablePath);
  const packagedVersion = appBundleVersion(packagedPath);
  return Boolean(packagedVersion && stableVersion !== packagedVersion);
}

function appBundleVersion(appPath: string): string | null {
  const infoPath = join(appPath, "Contents", "Info.plist");
  if (!existsSync(infoPath)) return null;
  const text = readFileSync(infoPath, "utf8");
  return (
    valueForPlistKey(text, "CFBundleShortVersionString") ||
    valueForPlistKey(text, "CFBundleVersion")
  );
}

function valueForPlistKey(text: string, key: string): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`<key>${escaped}</key>\\s*<string>([^<]+)</string>`));
  return match?.[1]?.trim() || null;
}

function copyAppBundle(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true, force: true });
}

function userApplicationsAppPath(): string {
  const home = process.env.HOME || "";
  return home ? join(home, "Applications", "Nutshell.app") : DEFAULT_APP_PATH;
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
