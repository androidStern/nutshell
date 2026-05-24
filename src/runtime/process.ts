import { TimeoutTraceError } from "../core/errors";

export interface RunProcessResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export async function runProcess(
  argv: string[],
  options: { cwd?: string; timeoutMs?: number; signal?: AbortSignal; env?: Record<string, string | undefined> } = {},
): Promise<RunProcessResult> {
  const controller = new AbortController();
  const timeout = options.timeoutMs
    ? setTimeout(() => controller.abort(new TimeoutTraceError(`command timed out after ${options.timeoutMs}ms`)), options.timeoutMs)
    : null;
  const abortFromParent = () => controller.abort(options.signal?.reason ?? new Error("aborted"));
  options.signal?.addEventListener("abort", abortFromParent, { once: true });
  try {
    const proc = Bun.spawn(argv, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdout: "pipe",
      stderr: "pipe",
      signal: controller.signal,
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (controller.signal.aborted) {
      return { code: 124, stdout, stderr: String(controller.signal.reason ?? stderr), timedOut: true };
    }
    return { code, stdout, stderr, timedOut: false };
  } catch (error) {
    if (controller.signal.aborted) {
      return { code: 124, stdout: "", stderr: String(controller.signal.reason ?? error), timedOut: true };
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromParent);
  }
}

export async function runJson<T>(
  argv: string[],
  options: { cwd?: string; timeoutMs?: number; signal?: AbortSignal; env?: Record<string, string | undefined> } = {},
): Promise<T> {
  const result = await runProcess(argv, options);
  if (result.code !== 0) {
    throw new Error(`command failed (${result.code}): ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout) as T;
}

export async function commandExists(path: string): Promise<boolean> {
  const file = Bun.file(path);
  return file.exists();
}
