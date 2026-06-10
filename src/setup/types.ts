import type { HealthFinding, Json, JsonObject, SourceId } from "../core/types";

export interface SetupCheck {
  ok: boolean;
  message: string;
  level?: "ok" | "warning" | "critical";
  detail?: JsonObject;
}

export interface SetupSelectOption<T> {
  label: string;
  value: T;
  hint?: string;
}

export interface SetupUI {
  intro(input: { title: string; body?: string }): Promise<void>;
  note(input: { title?: string; body: string }): Promise<void>;
  confirm(input: { title: string; body?: string; initialValue?: boolean }): Promise<boolean>;
  select<T>(input: { title: string; options: Array<SetupSelectOption<T>> }): Promise<T>;
  multiselect<T>(input: { title: string; options: Array<SetupSelectOption<T>>; initialValues?: T[] }): Promise<T[]>;
  text(input: { title: string; placeholder?: string; initialValue?: string; sensitive?: boolean }): Promise<string>;
  spinner<T>(input: { title: string; run: () => Promise<T> }): Promise<T>;
  ensure(input: {
    title: string;
    body?: string;
    check: () => Promise<SetupCheck>;
    repair: () => Promise<void>;
  }): Promise<SetupCheck>;
}

export interface HostRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface MacAppStatus {
  installed: boolean;
  path: string;
  fullDiskAccess: "granted" | "missing" | "unknown";
  backgroundSync: "enabled" | "disabled" | "unknown";
  agent: "enabled" | "requiresApproval" | "notRegistered" | "notFound" | "unknown";
  raw: string;
}

export interface MacHostCapabilities {
  openPrivacyPane(pane?: string): Promise<void>;
  showNutshellPermissionWindow(): Promise<void>;
  appStatus(): Promise<MacAppStatus>;
}

export interface HostCapabilities {
  openUrl(url: string): Promise<void>;
  revealPath(path: string): Promise<void>;
  openApp(pathOrBundleId: string): Promise<void>;
  chooseFile(input: { title: string; allowedExtensions?: string[] }): Promise<string | null>;
  run(input: { command: string; args: string[]; timeoutMs?: number }): Promise<HostRunResult>;
  macos?: MacHostCapabilities;
}

export interface ConfigDraft {
  readonly root: string;
  readonly path: string;
  readonly data: JsonObject;
  pluginConfig(source: SourceId): JsonObject;
  setPluginEnabled(source: SourceId, enabled: boolean): void;
  setPluginSetupStatus(source: SourceId, status: PluginSetupStatus, findings?: HealthFinding[]): void;
  commit(): Promise<void>;
}

export interface PluginSecretStore {
  get(key: string): Promise<Json | null>;
  set(key: string, value: Json): Promise<void>;
  delete(key: string): Promise<void>;
  listKeys(): Promise<string[]>;
}

export interface PluginSetupContext {
  root: string;
  pluginId: SourceId;
  ui: SetupUI;
  config: ConfigDraft;
  secrets: PluginSecretStore;
  host: HostCapabilities;
  logger: { event(event: string, fields?: JsonObject): void; warn(event: string, fields?: JsonObject): void; error(event: string, fields?: JsonObject): void };
  signal: AbortSignal;
  now(): Date;
}

export interface PluginArchiveImportOffer {
  title: string;
  body: string;
  laterCommand: string;
  allowedExtensions?: string[];
}

export interface PluginSetupSummary {
  title: string;
  body: string;
  archiveImport?: PluginArchiveImportOffer;
}

export interface PluginSetupResult {
  findings?: HealthFinding[];
}

export interface TracePluginSetup {
  summarize(ctx: PluginSetupContext): Promise<PluginSetupSummary>;
  // Optional plugin-specific configuration steps before verification.
  run?(ctx: PluginSetupContext): Promise<PluginSetupResult>;
  // Optional custom verification. When absent, core verifies with the
  // plugin's real probe (plugin.check) through the app identity on macOS.
  verify?(ctx: PluginSetupContext): Promise<HealthFinding[]>;
}

export type PluginSetupStatus = "ready" | "degraded" | "disabled";

export interface SetupPluginReport {
  source: SourceId;
  displayName: string;
  status: PluginSetupStatus;
  findings: HealthFinding[];
  archiveImport: "imported" | "skipped" | "unavailable" | "failed";
  importCommand: string | null;
}

export interface SetupReport {
  status: "ok" | "warning" | "critical";
  startedAt: Date;
  finishedAt: Date;
  plugins: SetupPluginReport[];
  backgroundAgent: {
    attempted: boolean;
    ok: boolean;
    message: string;
    detail: JsonObject;
  };
  syncHandoff: {
    attempted: boolean;
    ok: boolean;
    message: string;
    detail: JsonObject;
  };
}

export interface SetupRequest {
  json: boolean;
  assumeYes: boolean;
  syncHandoff: boolean;
  backgroundAgent: boolean;
}
