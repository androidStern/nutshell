import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Json, JsonObject, SourceId } from "../core/types";
import { DEFAULT_ROOT } from "../core/product";
import type { PluginSecretStore } from "./types";

interface SecretDocument {
  version: 1;
  plugins: Record<string, JsonObject>;
  updatedAt?: string;
}

type SecretChange =
  | { kind: "set"; plugin: string; key: string; value: Json }
  | { kind: "delete"; plugin: string; key: string };

const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 500;

export class FileSecretStore {
  constructor(readonly path: string = join(DEFAULT_ROOT, "secrets.json")) {}

  async draft(): Promise<SecretDraft> {
    return new SecretDraft(this, await this.load());
  }

  async load(): Promise<SecretDocument> {
    return withSecretLock(this.path, () => readSecretDocument(this.path));
  }

  async commit(changes: SecretChange[]): Promise<void> {
    if (!changes.length) return;
    await withSecretLock(this.path, () => {
      const doc = readSecretDocument(this.path);
      for (const change of changes) {
        const namespace = (doc.plugins[change.plugin] ??= {});
        if (change.kind === "set") namespace[change.key] = change.value;
        else delete namespace[change.key];
      }
      doc.updatedAt = new Date().toISOString();
      writeSecretDocument(this.path, doc);
    });
  }
}

export class SecretDraft {
  private readonly changes: SecretChange[] = [];

  constructor(private readonly store: FileSecretStore, private readonly current: SecretDocument) {}

  plugin(source: SourceId): PluginSecretStore {
    const plugin = String(source);
    return {
      get: async (key) => this.get(plugin, key),
      set: async (key, value) => {
        this.changes.push({ kind: "set", plugin, key, value });
      },
      delete: async (key) => {
        this.changes.push({ kind: "delete", plugin, key });
      },
      listKeys: async () => this.listKeys(plugin),
    };
  }

  async commit(): Promise<void> {
    await this.store.commit(this.changes);
  }

  private get(plugin: string, key: string): Json | null {
    for (let index = this.changes.length - 1; index >= 0; index -= 1) {
      const change = this.changes[index]!;
      if (change.plugin !== plugin || change.key !== key) continue;
      return change.kind === "set" ? change.value : null;
    }
    const namespace = this.current.plugins[plugin];
    const value = namespace?.[key];
    return value === undefined ? null : value;
  }

  private listKeys(plugin: string): string[] {
    const keys = new Set(Object.keys(this.current.plugins[plugin] ?? {}));
    for (const change of this.changes) {
      if (change.plugin !== plugin) continue;
      if (change.kind === "set") keys.add(change.key);
      else keys.delete(change.key);
    }
    return [...keys].sort();
  }
}

export function defaultSecretStore(root: string): FileSecretStore {
  return new FileSecretStore(join(root, "secrets.json"));
}

function readSecretDocument(path: string): SecretDocument {
  ensureSecretParent(path);
  if (!existsSync(path)) return { version: 1, plugins: {} };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<SecretDocument>;
  const plugins = parsed.plugins && typeof parsed.plugins === "object" && !Array.isArray(parsed.plugins) ? parsed.plugins : {};
  return { version: 1, plugins: plugins as Record<string, JsonObject>, updatedAt: parsed.updatedAt };
}

function writeSecretDocument(path: string, doc: SecretDocument): void {
  ensureSecretParent(path);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  closeSync(fd);
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
  try {
    Bun.spawnSync(["/bin/chmod", "600", path]);
  } catch {
    // POSIX mode enforcement is best-effort on non-POSIX hosts.
  }
}

function ensureSecretParent(path: string): void {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  try {
    Bun.spawnSync(["/bin/chmod", "700", parent]);
  } catch {
    // POSIX mode enforcement is best-effort on non-POSIX hosts.
  }
}

async function withSecretLock<T>(path: string, fn: () => T | Promise<T>): Promise<T> {
  const lockPath = `${path}.lock`;
  const started = Date.now();
  while (true) {
    try {
      ensureSecretParent(path);
      const fd = openSync(lockPath, "wx", 0o600);
      writeFileSync(fd, `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), version: 1 })}\n`);
      closeSync(fd);
      try {
        return await fn();
      } finally {
        rmSync(lockPath, { force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (isStaleLock(lockPath)) {
        rmSync(lockPath, { force: true });
        continue;
      }
      if (Date.now() - started > LOCK_WAIT_MS) throw new Error(`secret store lock is held: ${lockPath}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

function isStaleLock(path: string): boolean {
  try {
    return Date.now() - statSync(path).mtime.getTime() > LOCK_STALE_MS;
  } catch {
    return true;
  }
}
