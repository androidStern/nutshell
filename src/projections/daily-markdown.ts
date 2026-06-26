import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ProjectionReport, ProjectionRequest, TraceRecord } from "../core/types";
import { localDateKey, localDayWindow } from "../core/time";
import type { TraceStore } from "../store/interface";

export async function renderDailyMarkdown(store: TraceStore, request: ProjectionRequest, root: string): Promise<ProjectionReport> {
  const date = request.date ?? localDateKey(new Date());
  const window = localDayWindow(date);
  const page = await store.query({ since: window.start, until: window.end, limit: 1000 });
  const lines = [`# ${date}`, ""];
  const records = [...page.records].sort((a, b) => {
    const at = a.happenedAt ?? a.observedAt;
    const bt = b.happenedAt ?? b.observedAt;
    return at.getTime() - bt.getTime();
  });
  for (const record of records) {
    lines.push(formatRecord(record));
  }
  const path = join(root, "projections", "daily-markdown", `${date}.md`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
  return { outputs: [path] };
}

function formatRecord(record: TraceRecord): string {
  const at = record.happenedAt ?? record.observedAt;
  const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const title = record.title || record.sourceId;
  const link = record.url ? ` [link](${record.url})` : "";
  const artifacts = record.artifactRefs.length ? ` artifacts: ${record.artifactRefs.map((item) => `\`${item}\``).join(", ")}` : "";
  return `- ${time} **${record.source}/${record.type}** ${title}${link}${artifacts}`;
}
