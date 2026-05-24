#!/usr/bin/env bun
import { probePodcastDatabaseDirect, readPodcastBackfillPageDirect, readPodcastRowsDirect, type PodcastBackfillCursor, type PodcastProgress } from "./sqlite-source";

interface WorkerInput {
  op: "recent" | "backfill" | "probe";
  dbPath: string;
  since?: string;
  cursor?: PodcastBackfillCursor | null;
  limit?: number;
  timeoutMs: number;
}

export async function runPodcastsSqliteWorkerFromStdin(): Promise<void> {
  const input = JSON.parse(await new Response(Bun.stdin.stream()).text()) as WorkerInput;
  const progress: PodcastProgress = (event) => {
    process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), op: input.op, ...event })}\n`);
  };
  progress({ phase: "worker_start", dbPath: input.dbPath, timeoutMs: input.timeoutMs });
  const output =
    input.op === "probe"
      ? await probePodcastDatabaseDirect(input.dbPath, input.timeoutMs, progress)
      : input.op === "recent"
        ? await readPodcastRowsDirect(input.dbPath, new Date(input.since ?? 0), input.limit ?? 500, input.timeoutMs, progress)
        : await readPodcastBackfillPageDirect(input.dbPath, input.cursor ?? null, input.limit ?? 10_000, input.timeoutMs, progress);
  progress({ phase: "worker_done" });
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

if (import.meta.main) {
  runPodcastsSqliteWorkerFromStdin().catch((error) => {
    process.stderr.write(`${String(error?.stack || error)}\n`);
    process.exit(1);
  });
}
