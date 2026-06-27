import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ProjectionReport } from "../core/types";
import type { TraceStore } from "../store/interface";

export async function renderDashboardData(store: TraceStore, root: string): Promise<ProjectionReport> {
  const health = await store.healthSnapshot();
  const payload = {
    generatedAt: new Date().toISOString(),
    health,
  };
  const path = join(root, "projections", "dashboard", "status.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return { outputs: [path] };
}
