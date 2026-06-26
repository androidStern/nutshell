import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ProjectionReport, ProjectionRequest } from "../core/types";
import { localDateKey, localDayWindow } from "../core/time";
import type { TraceStore } from "../store/interface";

export async function renderDailyJson(store: TraceStore, request: ProjectionRequest, root: string): Promise<ProjectionReport> {
  const date = request.date ?? localDateKey(new Date());
  const window = localDayWindow(date);
  const page = await store.query({ since: window.start, until: window.end, limit: 1000 });
  const payload = {
    schemaVersion: 1,
    date,
    generatedAt: new Date().toISOString(),
    count: page.records.length,
    records: page.records,
    bySource: groupBy(page.records, (record) => record.source),
  };
  const path = join(root, "projections", "daily-json", `${date}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return { outputs: [path] };
}

function groupBy<T>(items: T[], keyFn: (item: T) => string): Record<string, T[]> {
  const output: Record<string, T[]> = {};
  for (const item of items) {
    const key = keyFn(item);
    (output[key] ??= []).push(item);
  }
  return output;
}
