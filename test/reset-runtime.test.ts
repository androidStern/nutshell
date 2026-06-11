import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, storePath } from "../src/config/config";
import type { JsonObject, PluginSyncResult, SourceId } from "../src/core/types";
import { ResetRuntime } from "../src/reset/reset-runtime";
import { openStore } from "../src/store/sqlite-store";
import { FakeSetupUI } from "../src/testing/fake-setup-ui";

test("reset data clears fresh-sync state and keeps config, secrets, logs, and permissions state", async () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-reset-data-"));
  try {
    const config = loadConfig(root);
    await seedSource(config, "youtube");
    writeFileSync(join(root, "secrets.json"), "{}\n");
    writeFileSync(join(root, ".agent-sync-enabled"), "1\n");
    mkdirSync(join(root, "logs"), { recursive: true });
    writeFileSync(join(root, "logs", "nutshell.jsonl"), "{}\n");
    mkdirSync(join(root, "projections", "dashboard"), { recursive: true });
    writeFileSync(join(root, "projections", "dashboard", "status.json"), "{}\n");

    const report = await new ResetRuntime({ root, config }).run({ mode: "data", yes: true, json: false });

    expect(report.status).toBe("ok");
    expect(existsSync(storePath(config))).toBe(false);
    expect(existsSync(join(root, "artifacts"))).toBe(false);
    expect(existsSync(join(root, "projections"))).toBe(false);
    expect(existsSync(config.path)).toBe(true);
    expect(existsSync(join(root, "secrets.json"))).toBe(true);
    expect(existsSync(join(root, ".agent-sync-enabled"))).toBe(true);
    expect(existsSync(join(root, "logs", "nutshell.jsonl"))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reset source clears only selected source rows and generated projections", async () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-reset-source-"));
  try {
    const config = loadConfig(root);
    await seedSource(config, "youtube");
    await seedSource(config, "twitter");
    mkdirSync(join(root, "projections", "dashboard"), { recursive: true });
    writeFileSync(join(root, "projections", "dashboard", "status.json"), "{}\n");

    const report = await new ResetRuntime({ root, config }).run({ mode: "source", sources: ["youtube"], yes: true, json: false });

    expect(report.status).toBe("ok");
    expect(report.sources).toEqual(["youtube"]);
    expect(existsSync(join(root, "artifacts", "youtube", "artifact.txt"))).toBe(false);
    expect(existsSync(join(root, "artifacts", "twitter", "artifact.txt"))).toBe(true);
    expect(existsSync(join(root, "projections"))).toBe(false);

    const store = openStore(storePath(config));
    try {
      expect((await store.query({ source: "youtube" })).total).toBe(0);
      expect((await store.query({ source: "twitter" })).total).toBe(1);
      expect((await store.loadCheckpoint("youtube")).version).toBe(0);
      expect((await store.loadCheckpoint("twitter")).version).toBe(1);
    } finally {
      await store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reset source can clear multiple selected sources", async () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-reset-multi-source-"));
  try {
    const config = loadConfig(root);
    await seedSource(config, "youtube");
    await seedSource(config, "twitter");
    await seedSource(config, "podcasts");

    const report = await new ResetRuntime({ root, config }).run({ mode: "source", sources: ["youtube", "twitter"], yes: true, json: false });

    expect(report.status).toBe("ok");
    expect(report.sources).toEqual(["youtube", "twitter"]);
    const store = openStore(storePath(config));
    try {
      expect((await store.query({ source: "youtube" })).total).toBe(0);
      expect((await store.query({ source: "twitter" })).total).toBe(0);
      expect((await store.query({ source: "podcasts" })).total).toBe(1);
    } finally {
      await store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reset logs clears logs only", async () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-reset-logs-"));
  try {
    const config = loadConfig(root);
    await seedSource(config, "youtube");
    writeFileSync(join(root, "secrets.json"), "{}\n");
    mkdirSync(join(root, "logs"), { recursive: true });
    writeFileSync(join(root, "logs", "nutshell.jsonl"), "{}\n");

    const report = await new ResetRuntime({ root, config }).run({ mode: "logs", yes: true, json: false });

    expect(report.status).toBe("ok");
    expect(existsSync(join(root, "logs"))).toBe(false);
    expect(existsSync(storePath(config))).toBe(true);
    expect(existsSync(config.path)).toBe(true);
    expect(existsSync(join(root, "secrets.json"))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reset all clears Nutshell-owned state but keeps browser profiles", async () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-reset-all-"));
  try {
    const config = loadConfig(root);
    await seedSource(config, "youtube");
    writeFileSync(join(root, "secrets.json"), "{}\n");
    writeFileSync(join(root, ".agent-sync-enabled"), "1\n");
    mkdirSync(join(root, "logs"), { recursive: true });
    writeFileSync(join(root, "logs", "nutshell.jsonl"), "{}\n");
    mkdirSync(join(root, "browser-profiles", "chrome"), { recursive: true });
    writeFileSync(join(root, "browser-profiles", "chrome", "README"), "external auth stand-in\n");

    const report = await new ResetRuntime({ root, config }).run({ mode: "all", yes: true, json: false });

    expect(report.status).toBe("ok");
    expect(existsSync(storePath(config))).toBe(false);
    expect(existsSync(join(root, "artifacts"))).toBe(false);
    expect(existsSync(join(root, "logs"))).toBe(false);
    expect(existsSync(config.path)).toBe(false);
    expect(existsSync(join(root, "secrets.json"))).toBe(false);
    expect(existsSync(join(root, ".agent-sync-enabled"))).toBe(false);
    expect(existsSync(join(root, "browser-profiles", "chrome", "README"))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("guided reset explains deletion and requires RESET confirmation", async () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-reset-guided-"));
  try {
    const config = loadConfig(root);
    await seedSource(config, "youtube");
    const ui = new FakeSetupUI();
    ui.selectedValues = ["data"];
    ui.textValues = ["RESET"];

    const report = await new ResetRuntime({ root, config, ui }).run({ mode: "guided", yes: false, json: false });

    expect(report.status).toBe("ok");
    expect(ui.notes.join("\n")).toContain("This will delete:");
    expect(ui.notes.join("\n")).toContain("This will keep:");
    expect(existsSync(storePath(config))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function seedSource(config: ReturnType<typeof loadConfig>, source: SourceId): Promise<void> {
  const artifactPath = join(config.root, "artifacts", source, "artifact.txt");
  mkdirSync(join(config.root, "artifacts", source), { recursive: true });
  writeFileSync(artifactPath, `${source}\n`);
  const store = openStore(storePath(config));
  try {
    await store.commitSync({
      source,
      run: {
        id: `${source}_run`,
        command: `nutshell sync ${source}`,
        mode: "recent",
        startedAt: new Date("2026-06-10T12:00:00Z"),
      },
      result: result(source, artifactPath),
      expectedCheckpointVersion: 0,
    });
  } finally {
    await store.close();
  }
}

function result(source: SourceId, artifactPath: string): PluginSyncResult {
  const observedAt = new Date("2026-06-10T12:00:00Z");
  return {
    observations: [
      {
        source,
        observedAt,
        sourceRecordId: "one",
        fingerprint: `${source}-one`,
        payload: { ok: true } as JsonObject,
        artifactPaths: [artifactPath],
      },
    ],
    records: [
      {
        source,
        collection: "default",
        kind: "event",
        type: `${source}.event`,
        sourceId: "one",
        happenedAt: observedAt,
        observedAt,
        title: "One",
        url: null,
        bodyText: null,
        artifactRefs: [artifactPath],
        payload: { ok: true } as JsonObject,
      },
    ],
    nextCheckpoint: { last: "one" },
    health: [],
    metrics: {},
    completed: true,
    partial: false,
  };
}
