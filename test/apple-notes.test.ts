import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config/config";
import type { ArtifactRef, JsonObject, PluginContext, WriteArtifactInput } from "../src/core/types";
import { parseBodyRows, parseMetadataRows, type NotesSource } from "../src/plugins/builtin/apple-notes/jxa-source";
import { AppleNotesPlugin } from "../src/plugins/builtin/apple-notes/plugin";
import { JsonlLogger } from "../src/runtime/logger";

const fieldSep = "\x1f";
const rowSep = "\x1e";

test("apple notes fixture sync emits note records and artifacts", async () => {
  const root = mkdtempSync(join(tmpdir(), "trace-notes-"));
  try {
    const fixture = join(root, "notes.json");
    writeFileSync(
      fixture,
      JSON.stringify({
        metadata: [
          {
            id: "note-1",
            title: "First Note",
            folder_path: "iCloud/Notes",
            created_at: "2026-05-20T10:00:00Z",
            modified_at: "2026-05-21T10:00:00Z",
          },
        ],
        bodies: {
          "note-1": { html: "<p>Hello <strong>world</strong></p>", plaintext: "Hello world" },
        },
      }),
    );
    const plugin = new AppleNotesPlugin();
    const config = loadConfig(root);
    const result = await plugin.sync(
      {
        root,
        config: { source: "fixture", fixturePath: fixture, batchSize: 10 },
        logger: new JsonlLogger(join(root, "logs", "trace.jsonl")),
        signal: new AbortController().signal,
        now: () => new Date("2026-05-21T12:00:00Z"),
        records: emptyRecordReader(),
        writeArtifact: async (input) => {
          const path = join(root, "artifacts", input.relativePath);
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, input.content);
          return { path, contentHash: "hash", mimeType: input.mimeType ?? null, bytes: 1 };
        },
      },
      { source: "apple_notes", mode: "recent", window: null, collections: [], budget: plugin.manifest.defaultBudget, dryRun: false },
      { version: 0, state: {} },
    );
    expect(config.root).toBe(root);
    expect(result.records.some((record) => record.type === "apple_note")).toBe(true);
    expect(result.observations.length).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apple notes automation denial returns an explicit permission finding", async () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-notes-permission-"));
  try {
    const deniedSource: NotesSource = {
      async scanMetadata() {
        throw new Error("Not authorized to send Apple events to Notes.");
      },
      async fetchBodies() {
        return new Map();
      },
    };
    const plugin = new AppleNotesPlugin(() => deniedSource);
    const result = await plugin.sync(
      {
        root,
        config: {},
        logger: new JsonlLogger(join(root, "logs", "nutshell.jsonl")),
        signal: new AbortController().signal,
        now: () => new Date("2026-05-21T12:00:00Z"),
        records: emptyRecordReader(),
        writeArtifact: async () => {
          throw new Error("permission test should not write artifacts");
        },
      },
      { source: "apple_notes", mode: "recent", window: null, collections: [], budget: plugin.manifest.defaultBudget, dryRun: false },
      { version: 0, state: {} },
    );
    expect(result.partial).toBe(true);
    expect(result.completed).toBe(false);
    expect(result.health[0]?.code).toBe("apple_notes_automation_permission_required");
    const detail = result.health[0]?.detail as JsonObject;
    expect(String(detail.nextAction)).toContain("System Settings");
    expect(String(detail.nextAction)).toContain("nutshell");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apple notes health probe fails closed on automation denial", async () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-notes-health-permission-"));
  try {
    const deniedSource: NotesSource = {
      async scanMetadata() {
        throw new Error("Not authorized to send Apple events to Notes.");
      },
      async fetchBodies() {
        return new Map();
      },
    };
    const plugin = new AppleNotesPlugin(() => deniedSource);
    const findings = await plugin.check({
      root,
      config: {},
      logger: new JsonlLogger(join(root, "logs", "nutshell.jsonl")),
      signal: new AbortController().signal,
      now: () => new Date("2026-05-21T12:00:00Z"),
      records: emptyRecordReader(),
      writeArtifact: async () => {
        throw new Error("health test should not write artifacts");
      },
    });

    expect(findings.some((item) => item.level === "critical" && item.code === "apple_notes_access_probe_failed")).toBe(true);
    expect(findings[0]?.message).toContain("automation permissions");
    expect(String((findings[0]?.detail as JsonObject).error)).toContain("Not authorized");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apple notes health probe uses lightweight app access when available", async () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-notes-health-lightweight-"));
  try {
    const source: NotesSource = {
      async probeAccess() {
        return { accountCount: 2 };
      },
      async scanMetadata() {
        throw new Error("health probe should not run a full metadata scan");
      },
      async fetchBodies() {
        throw new Error("health probe should not fetch note bodies");
      },
    };
    const plugin = new AppleNotesPlugin(() => source);
    const findings = await plugin.check(context(root));

    expect(findings).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apple notes stops body export cleanly when the run budget is exhausted", async () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-notes-deadline-"));
  try {
    let bodyFetches = 0;
    const slowSource: NotesSource = {
      async scanMetadata() {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return [
          {
            id: "note-1",
            title: "Slow Note",
            folderId: "folder-1",
            folderName: "Notes",
            folderPath: "iCloud/Notes",
            createdAt: "2026-05-20T10:00:00Z",
            modifiedAt: "2026-05-21T10:00:00Z",
            shared: false,
            passwordProtected: false,
          },
        ];
      },
      async fetchBodies() {
        bodyFetches += 1;
        return new Map();
      },
    };
    const plugin = new AppleNotesPlugin(() => slowSource);
    const result = await plugin.sync(
      {
        root,
        config: { batchSize: 10, osascriptTimeoutMs: 60_000 },
        logger: new JsonlLogger(join(root, "logs", "nutshell.jsonl")),
        signal: new AbortController().signal,
        now: () => new Date("2026-05-21T12:00:00Z"),
        records: emptyRecordReader(),
        writeArtifact: async (input) => {
          const path = join(root, "artifacts", input.relativePath);
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, input.content);
          return { path, contentHash: "hash", mimeType: input.mimeType ?? null, bytes: 1 };
        },
      },
      {
        source: "apple_notes",
        mode: "recent",
        window: null,
        collections: [],
        budget: { ...plugin.manifest.defaultBudget, maxRuntimeMs: 1 },
        dryRun: false,
      },
      { version: 0, state: {} },
    );

    expect(bodyFetches).toBe(0);
    expect(result.partial).toBe(true);
    expect(result.metrics).toMatchObject({ bodyFetches: 0, partial: true });
    expect(result.health.some((item) => item.code === "apple_notes_runtime_budget_exhausted")).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apple notes prioritizes never-exported notes before previously failed body exports", async () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-notes-priority-"));
  try {
    const fetchedIds: string[][] = [];
    const source: NotesSource = {
      async scanMetadata() {
        return [
          {
            id: "failed-note",
            title: "Failed Note",
            folderId: "folder-1",
            folderName: "Notes",
            folderPath: "iCloud/Notes",
            createdAt: "2026-05-20T10:00:00Z",
            modifiedAt: "2026-05-21T10:00:00Z",
            shared: false,
            passwordProtected: false,
          },
          {
            id: "fresh-note",
            title: "Fresh Note",
            folderId: "folder-1",
            folderName: "Notes",
            folderPath: "iCloud/Notes",
            createdAt: "2026-05-20T10:00:00Z",
            modifiedAt: "2026-05-21T10:00:00Z",
            shared: false,
            passwordProtected: false,
          },
        ];
      },
      async fetchBodies(ids) {
        fetchedIds.push([...ids]);
        return new Map(ids.map((id) => [id, { id, html: `<p>${id}</p>`, plaintext: id, error: "" }]));
      },
    };
    const plugin = new AppleNotesPlugin(() => source);
    await plugin.sync(
      {
        root,
        config: { batchSize: 1 },
        logger: new JsonlLogger(join(root, "logs", "nutshell.jsonl")),
        signal: new AbortController().signal,
        now: () => new Date("2026-05-21T12:00:00Z"),
        records: emptyRecordReader(),
        writeArtifact: async (input) => {
          const path = join(root, "artifacts", input.relativePath);
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, input.content);
          return { path, contentHash: "hash", mimeType: input.mimeType ?? null, bytes: 1 };
        },
      },
      { source: "apple_notes", mode: "recent", window: null, collections: [], budget: plugin.manifest.defaultBudget, dryRun: false },
      {
        version: 1,
        state: {
          notes: {
            "failed-note": {
              modifiedAt: "2026-05-21T10:00:00Z",
              status: "failed",
            },
          },
        },
      },
    );

    expect(fetchedIds).toEqual([["fresh-note"], ["failed-note"]]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apple notes does not rewrite unchanged note artifacts", async () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-notes-unchanged-"));
  try {
    const source: NotesSource = {
      async scanMetadata() {
        return [metadata("note-1", "Stable Note")];
      },
      async fetchBodies(ids) {
        return new Map(ids.map((id) => [id, { id, html: `<p>${id}</p>`, plaintext: id, error: "" }]));
      },
    };
    const plugin = new AppleNotesPlugin(() => source);
    let writes = 0;
    const first = await plugin.sync(
      context(root, {
        writeArtifact: async (input) => {
          writes += 1;
          const path = join(root, "artifacts", input.relativePath);
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, input.content);
          return { path, contentHash: "hash", mimeType: input.mimeType ?? null, bytes: 1 };
        },
      }),
      { source: "apple_notes", mode: "recent", window: null, collections: [], budget: plugin.manifest.defaultBudget, dryRun: false },
      { version: 0, state: {} },
    );

    expect(writes).toBeGreaterThan(0);
    const second = await plugin.sync(
      context(root, {
        writeArtifact: async () => {
          throw new Error("unchanged note should not be rewritten");
        },
      }),
      { source: "apple_notes", mode: "recent", window: null, collections: [], budget: plugin.manifest.defaultBudget, dryRun: false },
      { version: 1, state: first.nextCheckpoint },
    );

    expect(second.records).toHaveLength(0);
    expect(second.observations).toHaveLength(0);
    expect(second.partial).toBe(false);
    expect(second.metrics).toMatchObject({ bodyBacklog: 0 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apple notes drains body backlog across safe chunks within one run", async () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-notes-converge-"));
  try {
    const fetchedIds: string[][] = [];
    const source: NotesSource = {
      async scanMetadata() {
        return [metadata("note-1", "One"), metadata("note-2", "Two")];
      },
      async fetchBodies(ids) {
        fetchedIds.push([...ids]);
        return new Map(ids.map((id) => [id, { id, html: `<p>${id}</p>`, plaintext: id, error: "" }]));
      },
    };
    const plugin = new AppleNotesPlugin(() => source);
    const request = { source: "apple_notes" as const, mode: "recent" as const, window: null, collections: [], budget: plugin.manifest.defaultBudget, dryRun: false };
    const first = await plugin.sync(context(root, { config: { batchSize: 1 } }), request, { version: 0, state: {} });

    expect(fetchedIds).toEqual([["note-1"], ["note-2"]]);
    expect(first.partial).toBe(false);
    expect(first.metrics).toMatchObject({ bodyFetches: 2, bodyFetchBatches: 2, bodyBacklog: 0 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apple notes splits oversized body exports into safe chunks", async () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-notes-batch-cap-"));
  try {
    const fetchedIds: string[][] = [];
    const source: NotesSource = {
      async scanMetadata() {
        return Array.from({ length: 40 }, (_, index) => metadata(`note-${index + 1}`, `Note ${index + 1}`));
      },
      async fetchBodies(ids) {
        fetchedIds.push([...ids]);
        return new Map(ids.map((id) => [id, { id, html: `<p>${id}</p>`, plaintext: id, error: "" }]));
      },
    };
    const plugin = new AppleNotesPlugin(() => source);
    const result = await plugin.sync(
      context(root, { config: { batchSize: 200 } }),
      { source: "apple_notes", mode: "recent", window: null, collections: [], budget: plugin.manifest.defaultBudget, dryRun: false },
      { version: 0, state: {} },
    );

    expect(fetchedIds.map((ids) => ids.length)).toEqual([25, 15]);
    expect(result.metrics).toMatchObject({ bodyFetches: 40, bodyFetchBatches: 2, bodyBatchSize: 25, bodyBacklog: 0 });
    expect(result.partial).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apple notes partial runs do not tombstone missing notes", async () => {
  const root = mkdtempSync(join(tmpdir(), "nutshell-notes-no-partial-tombstone-"));
  try {
    const source: NotesSource = {
      async scanMetadata() {
        return [metadata("new-note", "New Note")];
      },
      async fetchBodies() {
        throw new Error("body fetch should not run after budget is exhausted");
      },
    };
    const plugin = new AppleNotesPlugin(() => source);
    const result = await plugin.sync(
      context(root),
      {
        source: "apple_notes",
        mode: "recent",
        window: null,
        collections: [],
        budget: { ...plugin.manifest.defaultBudget, maxRuntimeMs: 1 },
        dryRun: false,
      },
      {
        version: 1,
        state: {
          notes: {
            "old-note": {
              modifiedAt: "2026-05-19T10:00:00Z",
              status: "ok",
              missingScanCount: 2,
              sourceHtmlHash: "old-hash",
              markdownHash: "old-md",
              markdownPath: "old.md",
            },
          },
        },
      },
    );

    const notes = (result.nextCheckpoint as JsonObject).notes as JsonObject;
    const oldNote = notes["old-note"] as JsonObject;
    expect(result.partial).toBe(true);
    expect(oldNote.status).toBe("ok");
    expect(oldNote.missingScanCount).toBe(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apple notes parses bulk AppleScript metadata rows", () => {
  const rows = parseMetadataRows(
    [
      "note-1",
      "First Note",
      "folder-1",
      "Notes",
      "iCloud/Notes",
      "2026-05-20T10:00:00",
      "2026-05-21T10:00:00",
      "true",
      "false",
    ].join(fieldSep) + rowSep,
  );

  expect(rows).toEqual([
    {
      id: "note-1",
      title: "First Note",
      folder_id: "folder-1",
      folder_name: "Notes",
      folder_path: "iCloud/Notes",
      created_at: "2026-05-20T10:00:00",
      modified_at: "2026-05-21T10:00:00",
      shared: true,
      password_protected: false,
    },
  ]);
});

test("apple notes parses AppleScript body rows", () => {
  const rows = parseBodyRows(["note-1", "", "<p>Hello</p>", "Hello"].join(fieldSep) + rowSep);

  expect(rows).toEqual([
    {
      id: "note-1",
      error: "",
      html: "<p>Hello</p>",
      plaintext: "Hello",
    },
  ]);
});

function emptyRecordReader() {
  return {
    async query() {
      return { records: [], total: 0, limit: 0, offset: 0 };
    },
  };
}

function metadata(id: string, title: string) {
  return {
    id,
    title,
    folderId: "folder-1",
    folderName: "Notes",
    folderPath: "iCloud/Notes",
    createdAt: "2026-05-20T10:00:00Z",
    modifiedAt: "2026-05-21T10:00:00Z",
    shared: false,
    passwordProtected: false,
  };
}

function context(
  root: string,
  options: {
    config?: JsonObject;
    writeArtifact?: (input: WriteArtifactInput) => Promise<ArtifactRef>;
  } = {},
): PluginContext {
  return {
    root,
    config: options.config ?? {},
    logger: new JsonlLogger(join(root, "logs", "nutshell.jsonl")),
    signal: new AbortController().signal,
    now: () => new Date("2026-05-21T12:00:00Z"),
    records: emptyRecordReader(),
    writeArtifact:
      options.writeArtifact ??
      (async (input) => {
        const path = join(root, "artifacts", input.relativePath);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, input.content);
        return { path, contentHash: "hash", mimeType: input.mimeType ?? null, bytes: 1 };
      }),
  };
}
