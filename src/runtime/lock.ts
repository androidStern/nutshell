import { closeSync, existsSync, ftruncateSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { LockHeldError } from "../core/errors";
import { CLI_NAME } from "../core/product";
import { parseDate } from "../core/time";
import { runProcess } from "./process";
import type { TraceLogger } from "../core/types";

export interface LockPayload {
  pid: number;
  startedAt: string;
  heartbeatAt: string;
  command: string;
  version: 1;
}

export interface LockInspection {
  present: boolean;
  stale: boolean;
  active: boolean;
  reason: string;
  payload: LockPayload | null;
  command: string;
  heartbeatAgeMs: number | null;
}

export class RuntimeLock {
  private fd: number | null = null;
  private timer: Timer | null = null;

  constructor(
    private readonly path: string,
    private readonly command: string,
    private readonly logger: TraceLogger,
    private readonly options: { heartbeatMs: number; staleMs: number },
  ) {}

  async acquire(): Promise<void> {
    mkdirSync(dirname(this.path), { recursive: true });
    while (true) {
      try {
        this.fd = openSync(this.path, "wx");
        this.writePayload();
        this.timer = setInterval(() => this.writePayload(), this.options.heartbeatMs);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const state = await this.inspectExisting();
        if (state.stale) {
          this.logger.warn("lock: removing stale lock", {
            path: this.path,
            reason: state.reason,
            existing: state.payload ? JSON.stringify(state.payload) : "",
          });
          try {
            unlinkSync(this.path);
          } catch {
            // Retry acquire, another process may have removed it.
          }
          continue;
        }
        throw new LockHeldError(`lock held at ${this.path}; ${state.reason}`);
      }
    }
  }

  release(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }
    try {
      unlinkSync(this.path);
    } catch {
      // Already gone.
    }
  }

  private writePayload(): void {
    if (this.fd === null) return;
    const payload: LockPayload = {
      pid: process.pid,
      startedAt: this.startedAt,
      heartbeatAt: new Date().toISOString(),
      command: this.command,
      version: 1,
    };
    const text = `${JSON.stringify(payload)}\n`;
    ftruncateSync(this.fd, 0);
    writeSync(this.fd, text, 0, "utf8");
  }

  private readonly startedAt = new Date().toISOString();

  private async inspectExisting(): Promise<{ stale: boolean; reason: string; payload: LockPayload | null }> {
    const inspection = await inspectLock(this.path, this.options.staleMs);
    return { stale: inspection.stale || !inspection.present, reason: inspection.reason, payload: inspection.payload };
  }
}

export async function inspectLock(path: string, staleMs: number): Promise<LockInspection> {
  if (!existsSync(path)) {
    return { present: false, stale: false, active: false, reason: "lock absent", payload: null, command: "", heartbeatAgeMs: null };
  }
  let payload: LockPayload | null = null;
  try {
    payload = JSON.parse(readFileSync(path, "utf8")) as LockPayload;
  } catch {
    return { present: true, stale: true, active: false, reason: "lock unreadable", payload: null, command: "", heartbeatAgeMs: null };
  }
  if (!payload.pid || payload.pid <= 0) {
    return { present: true, stale: true, active: false, reason: "lock has invalid pid", payload, command: "", heartbeatAgeMs: null };
  }
  if (!pidAlive(payload.pid)) {
    return { present: true, stale: true, active: false, reason: "pid is gone", payload, command: "", heartbeatAgeMs: null };
  }
  const command = await pidCommand(payload.pid);
  if (!command) {
    return { present: true, stale: true, active: false, reason: "pid command unavailable", payload, command: "", heartbeatAgeMs: null };
  }
  const heartbeat = parseDate(payload.heartbeatAt);
  if (!heartbeat) {
    return { present: true, stale: true, active: false, reason: "heartbeat invalid", payload, command, heartbeatAgeMs: null };
  }
  const heartbeatAgeMs = Date.now() - heartbeat.getTime();
  const ownerLooksLikeNutshell = command.includes(CLI_NAME) || command.includes("src/cli.ts");
  if (heartbeatAgeMs > staleMs && !ownerLooksLikeNutshell) {
    return {
      present: true,
      stale: true,
      active: false,
      reason: `unrelated process with stale heartbeat: ${command}`,
      payload,
      command,
      heartbeatAgeMs,
    };
  }
  return { present: true, stale: false, active: true, reason: `active pid ${payload.pid}: ${command}`, payload, command, heartbeatAgeMs };
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function pidCommand(pid: number): Promise<string> {
  const result = await runProcess(["/bin/ps", "-p", String(pid), "-o", "command="], { timeoutMs: 5_000 });
  return result.code === 0 ? result.stdout.trim() : "";
}

export function readLock(path: string): LockPayload | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as LockPayload;
  } catch {
    return null;
  }
}
