import type { TraceConfig } from "./config";

export function validateConfig(config: TraceConfig): string[] {
  const problems: string[] = [];
  if (!config.root) problems.push("root is empty");
  if (!config.data.plugins || typeof config.data.plugins !== "object") {
    problems.push("plugins config is missing");
  }
  return problems;
}

