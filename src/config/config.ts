import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import JSON5 from "json5";
import type { Json, JsonObject } from "../core/types";
import { CONFIG_ENV, CONFIG_FILENAME, DEFAULT_ROOT, ROOT_ENV } from "../core/product";
import { DEFAULT_CONFIG } from "./defaults";

export interface TraceConfig {
  root: string;
  path: string;
  data: JsonObject;
}

export function resolveConfigPath(explicitRoot?: string): string {
  const explicitConfig = process.env[CONFIG_ENV];
  if (explicitConfig) return resolve(expandHome(explicitConfig));
  if (explicitRoot) return join(resolve(expandHome(explicitRoot)), CONFIG_FILENAME);
  return join(homedir(), CONFIG_FILENAME);
}

export function resolveRoot(explicitRoot?: string, path = resolveConfigPath()): string {
  if (explicitRoot) return resolve(expandHome(explicitRoot));
  const envRoot = process.env[ROOT_ENV];
  if (envRoot) return resolve(expandHome(envRoot));
  const existing = readConfigIfPresent(path);
  const storage = objectAt(existing, "storage");
  const configured = typeof storage.root === "string" ? storage.root : "";
  return resolve(expandHome(configured || DEFAULT_ROOT));
}

export function configPath(root?: string): string {
  return resolveConfigPath(root);
}

export function ensureRoot(root: string): void {
  for (const path of [
    root,
    join(root, "logs"),
    join(root, "artifacts"),
    join(root, "artifacts", "raw"),
    join(root, "artifacts", "apple_notes"),
    join(root, "projections"),
    join(root, "projections", "daily-json"),
    join(root, "projections", "daily-markdown"),
    join(root, "projections", "dashboard"),
    join(root, "launchd"),
    join(root, "browser-profiles"),
  ]) {
    mkdirSync(path, { recursive: true });
  }
}

export function writeDefaultConfig(root: string, path = resolveConfigPath(root)): void {
  ensureRoot(root);
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, defaultConfigJsonc(root), "utf8");
  }
}

export function loadConfig(root: string, path = resolveConfigPath(root)): TraceConfig {
  writeDefaultConfig(root, path);
  const parsed = readConfigIfPresent(path);
  const merged = deepMerge(defaultConfigForRoot(root), parsed);
  const storage = objectAt(merged, "storage");
  const configuredRoot = typeof storage.root === "string" ? storage.root : root;
  const effectiveRoot = resolve(expandHome(configuredRoot || root));
  ensureRoot(effectiveRoot);
  return { root: effectiveRoot, path, data: merged };
}

export function updateConfig(root: string, mutate: (data: JsonObject) => void, path = resolveConfigPath(root)): TraceConfig {
  writeDefaultConfig(root, path);
  const parsed = readConfigIfPresent(path);
  mutate(parsed);
  writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  return loadConfig(root, path);
}

export function pluginConfig(config: TraceConfig, source: string): JsonObject {
  const plugins = objectAt(config.data, "plugins");
  return objectAt(plugins, source);
}

export function objectAt(value: Json, key: string): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const child = value[key];
    if (child && typeof child === "object" && !Array.isArray(child)) return child;
  }
  return {};
}

export function stringAt(value: JsonObject, key: string, fallback = ""): string {
  const child = value[key];
  return typeof child === "string" ? expandHome(child) : fallback;
}

export function numberAt(value: JsonObject, key: string, fallback: number): number {
  const child = value[key];
  return typeof child === "number" && Number.isFinite(child) ? child : fallback;
}

export function booleanAt(value: JsonObject, key: string, fallback: boolean): boolean {
  const child = value[key];
  return typeof child === "boolean" ? child : fallback;
}

export function stringArrayAt(value: JsonObject, key: string): string[] {
  const child = value[key];
  return Array.isArray(child) ? child.filter((item): item is string => typeof item === "string") : [];
}

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

export function storePath(config: TraceConfig): string {
  const store = objectAt(config.data, "store");
  const configured = typeof store.sqlitePath === "string" ? store.sqlitePath : "nutshell.sqlite";
  return isAbsolute(configured) ? configured : resolve(config.root, configured);
}

export function logPath(config: TraceConfig): string {
  return join(config.root, "logs", "nutshell.jsonl");
}

function readConfigIfPresent(path: string): JsonObject {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) return {};
  return JSON5.parse(raw) as JsonObject;
}

function defaultConfigForRoot(root: string): JsonObject {
  return deepMerge(DEFAULT_CONFIG, { storage: { root: displayRoot(root) } });
}

function defaultConfigJsonc(root: string): string {
  const data = defaultConfigForRoot(root);
  return `// Nutshell configuration.
// This file controls where data is stored, which plugins run, and how often the background sync runs.
${JSON.stringify(data, null, 2)}
`;
}

function displayRoot(root: string): string {
  const home = homedir();
  if (root === DEFAULT_ROOT) return "~/Nutshell";
  if (root === home) return "~";
  if (root.startsWith(`${home}/`)) return `~/${root.slice(home.length + 1)}`;
  return root;
}

function deepMerge(base: JsonObject, override: JsonObject): JsonObject {
  const output: JsonObject = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = output[key];
    if (isObject(current) && isObject(value)) {
      output[key] = deepMerge(current, value);
    } else {
      output[key] = value;
    }
  }
  return output;
}

function isObject(value: Json | undefined): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
