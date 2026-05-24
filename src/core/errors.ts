export class TraceError extends Error {
  readonly code: string;
  readonly exitCode: number;

  constructor(code: string, message: string, exitCode = 1) {
    super(message);
    this.name = "TraceError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

export class UsageError extends TraceError {
  constructor(message: string) {
    super("usage", message, 64);
    this.name = "UsageError";
  }
}

export class LockHeldError extends TraceError {
  constructor(message: string) {
    super("lock_held", message, 75);
    this.name = "LockHeldError";
  }
}

export class UnavailableError extends TraceError {
  constructor(message: string) {
    super("unavailable", message, 69);
    this.name = "UnavailableError";
  }
}

export class TimeoutTraceError extends TraceError {
  constructor(message: string) {
    super("timeout", message, 124);
    this.name = "TimeoutTraceError";
  }
}

export class CheckpointConflictError extends TraceError {
  constructor(message: string) {
    super("checkpoint_conflict", message, 75);
    this.name = "CheckpointConflictError";
  }
}

