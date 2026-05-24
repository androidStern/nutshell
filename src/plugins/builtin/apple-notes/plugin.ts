import { existsSync } from "node:fs";
import { sha256 } from "../../../core/ids";
import type {
  Checkpoint,
  JsonObject,
  PluginContext,
  PluginManifest,
  PluginSyncResult,
  RawObservation,
  SyncRequest,
  TraceRecord,
} from "../../../core/types";
import { booleanAt, numberAt, stringArrayAt, stringAt } from "../../../config/config";
import { finding, type TracePlugin } from "../../interface";
import { AppleScriptNotesSource, FixtureNotesSource, type NotesSource } from "./jxa-source";
import {
  noteMarkdownRelativePath,
  noteRawHtmlRelativePath,
  noteSourceId,
  type NoteBody,
  type NoteMetadata,
} from "./identity";
import { htmlToMarkdown, markdownHash, renderNoteMarkdown } from "./markdown";

interface AppleNotesState {
  notes?: Record<
    string,
    {
      modifiedAt?: string;
      status?: string;
      missingScanCount?: number;
      markdownPath?: string;
      sourceHtmlHash?: string;
      markdownHash?: string;
    }
  >;
  lastRunAt?: string;
  backfill?: JsonObject;
  counts?: JsonObject;
}

type AppleNoteStateEntry = NonNullable<AppleNotesState["notes"]>[string];

const MIN_BODY_FETCH_MS = 1_000;
const MIN_ARTIFACT_RESERVE_MS = 1_000;
const MAX_BODY_BATCH_SIZE = 25;

export class AppleNotesPlugin implements TracePlugin {
  constructor(private readonly sourceFactory: (cfg: ReturnType<typeof config>) => NotesSource = buildSource) {}

  readonly manifest: PluginManifest = {
    id: "apple_notes",
    displayName: "Apple Notes",
    authKind: "local_os",
    collections: ["notes"],
    supportsBackfill: true,
    defaultBudget: { maxRuntimeMs: 240_000, maxRequests: null, minDelayMs: 0, stopOnRateLimit: true },
  };

  async check(ctx: PluginContext) {
    const cfg = config(ctx);
    if (cfg.source === "fixture") {
      return existsSync(cfg.fixturePath)
        ? []
        : [finding("critical", "apple_notes", "apple_notes_fixture_missing", "Apple Notes fixture is missing", { fixturePath: cfg.fixturePath })];
    }
    const osascript = Bun.which("osascript");
    return osascript ? [] : [finding("critical", "apple_notes", "osascript_missing", "osascript is not available", {})];
  }

  async sync(ctx: PluginContext, request: SyncRequest, checkpoint: Checkpoint): Promise<PluginSyncResult> {
    const cfg = config(ctx);
    const source = this.sourceFactory(cfg);
    const observedAt = ctx.now();
    const startedMs = Date.now();
    const deadlineAt = startedMs + Math.max(1, request.budget.maxRuntimeMs);
    const state = normalizeState(checkpoint.state);
    const health = [];
    const failedBodyIds: string[] = [];
    let scanGuardActive = false;
    let budgetExhausted = false;
    const notesState = { ...(state.notes ?? {}) };
    let metadata: NoteMetadata[];
    try {
      metadata = await source.scanMetadata(stepTimeoutMs(deadlineAt, cfg.osascriptTimeoutMs, 0), ctx.signal);
    } catch (error) {
      const permission = isAppleNotesPermissionError(error);
      return {
        observations: [],
        records: [],
        nextCheckpoint: checkpoint.state,
        health: [
          finding(
            "critical",
            "apple_notes",
            permission ? "apple_notes_automation_permission_required" : "apple_notes_metadata_scan_failed",
            permission ? "Apple Notes is blocked by macOS automation permissions" : "Apple Notes metadata scan failed",
            {
              error: String(error),
              requiredPermission: permission ? "Automation access to Notes" : null,
              nextAction: permission
                ? "Open System Settings > Privacy & Security > Automation and allow the installed `nutshell` app or command to control Notes. Then run `nutshell health` again."
                : "Run `nutshell sync apple_notes --mode recent --json` again and inspect the error if it repeats.",
            },
          ),
        ],
        metrics: { phase: "metadata_scan" },
        completed: false,
        partial: true,
      };
    }
    const unique = dedupeAndFilter(metadata, cfg);
    const seenIds = new Set(unique.map((item) => item.id));

    const knownNotes = Object.keys(notesState).length;
    const missingEntries = Object.entries(notesState).filter(([id, item]) => !seenIds.has(id) && item.status !== "tombstoned");
    if (knownNotes >= 20 && seenIds.size < knownNotes * 0.5) {
      scanGuardActive = true;
      health.push(
        finding("warning", "apple_notes", "apple_notes_scan_guard", "Metadata scan saw suspiciously few notes; missing detection skipped", {
          known: knownNotes,
          seen: seenIds.size,
        }),
      );
    }

    const fetchCandidates = unique
      .filter((note) => needsBody(note, notesState[note.id], false))
      .sort((left, right) => bodyFetchPriority(left, notesState[left.id]) - bodyFetchPriority(right, notesState[right.id]));
    const hasBodyBudget = remainingMs(deadlineAt, MIN_ARTIFACT_RESERVE_MS) >= MIN_BODY_FETCH_MS;
    if (!hasBodyBudget && fetchCandidates.length > 0) {
      budgetExhausted = true;
      health.push(
        finding("warning", "apple_notes", "apple_notes_runtime_budget_exhausted", "Apple Notes run budget was exhausted before body export completed", {
          pendingBodyExports: fetchCandidates.length,
        }),
      );
    }
    const bodyBatchSize = Math.max(1, Math.min(cfg.batchSize, MAX_BODY_BATCH_SIZE));
    const toFetch = hasBodyBudget ? fetchCandidates.slice(0, bodyBatchSize) : [];
    let bodyMap: Map<string, NoteBody>;
    try {
      const fetched = await fetchBodiesResilient(source, toFetch.map((note) => note.id), cfg.osascriptTimeoutMs, ctx.signal, deadlineAt);
      bodyMap = fetched.bodies;
      if (fetched.budgetExhausted) {
        budgetExhausted = true;
        health.push(
          finding("warning", "apple_notes", "apple_notes_runtime_budget_exhausted", "Apple Notes run budget was exhausted before body export completed", {
            pendingBodyExports: Math.max(0, fetchCandidates.length - bodyMap.size),
          }),
        );
      }
    } catch (error) {
      const permission = isAppleNotesPermissionError(error);
      return {
        observations: [],
        records: [],
        nextCheckpoint: checkpoint.state,
        health: [
          finding(
            "critical",
            "apple_notes",
            permission ? "apple_notes_automation_permission_required" : "apple_notes_body_fetch_failed",
            permission ? "Apple Notes is blocked by macOS automation permissions" : "Apple Notes body export failed",
            {
              error: String(error),
              requiredPermission: permission ? "Automation access to Notes" : null,
              nextAction: permission
                ? "Open System Settings > Privacy & Security > Automation and allow the installed `nutshell` app or command to control Notes. Then run `nutshell health` again."
                : "Run `nutshell sync apple_notes --mode recent --json` again and inspect the error if it repeats.",
            },
          ),
        ],
        metrics: { phase: "body_fetch", bodyFetches: toFetch.length },
        completed: false,
        partial: true,
      };
    }

    for (const note of unique) {
      const previous = notesState[note.id];
      if (previous?.missingScanCount) {
        notesState[note.id] = { ...previous, missingScanCount: 0 };
      }
      if (!note.passwordProtected && needsBody(note, previous, false) && !bodyMap.has(note.id)) {
        notesState[note.id] = pendingBodyState(note, previous);
      }
    }

    const notesToRender = unique.filter((note) => bodyMap.has(note.id) || shouldRenderMetadataOnly(note, notesState[note.id]));
    const processedRenderIds = new Set<string>();
    const observations: RawObservation[] = [];
    const records: TraceRecord[] = [];
    for (const note of notesToRender) {
      if (ctx.signal.aborted || remainingMs(deadlineAt, MIN_ARTIFACT_RESERVE_MS) <= 0) {
        budgetExhausted = true;
        break;
      }
      const previous = notesState[note.id];
      const body = bodyMap.get(note.id);
      let status = "ok";
      let markdownBody = "";
      let sourceHtmlHash = previous?.sourceHtmlHash ?? "";
      let renderedHash = previous?.markdownHash ?? "";
      let plaintextHash = "";
      const artifactRefs: string[] = [];

      if (note.passwordProtected) {
        status = previous?.sourceHtmlHash ? "stale_locked" : "metadata_only";
        markdownBody =
          status === "metadata_only"
            ? "> This Apple Note is password protected or inaccessible through automation. Metadata was synced, but body content was not exported.\n"
            : "";
      } else if (!body) {
        status = previous ? previous.status || "ok" : "pending_body_export";
      } else if (body.error) {
        status = "failed";
        failedBodyIds.push(note.id);
        health.push(finding("warning", "apple_notes", "apple_notes_body_failed", "Apple Notes body fetch failed", { id: note.id, error: body.error }));
      } else {
        const converted = htmlToMarkdown(body.html);
        markdownBody = converted.markdown;
        sourceHtmlHash = sha256(body.html);
        plaintextHash = sha256(body.plaintext);
        renderedHash = markdownHash(markdownBody);
        if (cfg.writeRawHtml) {
          const raw = await ctx.writeArtifact({
            source: "apple_notes",
            relativePath: noteRawHtmlRelativePath(note),
            content: body.html,
            mimeType: "text/html",
          });
          artifactRefs.push(raw.path);
        }
      }

      const markdownText = renderNoteMarkdown({
        note,
        bodyMarkdown: markdownBody,
        syncedAt: observedAt,
        status,
        sourceHtmlHash,
        plaintextHash,
        renderedHash,
        error: body?.error || undefined,
      });
      const markdown = await ctx.writeArtifact({
        source: "apple_notes",
        relativePath: noteMarkdownRelativePath(note),
        content: markdownText,
        mimeType: "text/markdown",
      });
      artifactRefs.push(markdown.path);
      processedRenderIds.add(note.id);

      notesState[note.id] = {
        modifiedAt: note.modifiedAt,
        status,
        missingScanCount: 0,
        markdownPath: markdown.path,
        sourceHtmlHash,
        markdownHash: renderedHash,
      };

      observations.push({
        source: "apple_notes",
        observedAt,
        sourceRecordId: noteSourceId(note),
        fingerprint: sha256(JSON.stringify({ note, status, sourceHtmlHash, renderedHash })),
        payload: { ...note, status },
        artifactPaths: artifactRefs,
      });
      records.push({
        source: "apple_notes",
        collection: "notes",
        kind: "entity",
        type: "apple_note",
        sourceId: noteSourceId(note),
        happenedAt: note.modifiedAt ? new Date(note.modifiedAt) : null,
        observedAt,
        title: note.title,
        url: null,
        bodyText: markdownBody || null,
        artifactRefs,
        payload: { ...note, status },
      });
      if (!previous) {
        records.push(eventRecord(note, "apple_note.created", note.createdAt, observedAt));
      } else if (previous.modifiedAt !== note.modifiedAt) {
        records.push(eventRecord(note, "apple_note.modified", note.modifiedAt, observedAt));
      }
    }

    for (const note of notesToRender) {
      if (!processedRenderIds.has(note.id) && bodyMap.has(note.id) && !note.passwordProtected) {
        notesState[note.id] = pendingBodyState(note, notesState[note.id]);
      }
    }

    const bodyBacklog = countBodyBacklog(unique, notesState);
    const partial = budgetExhausted || bodyBacklog > 0;
    if (budgetExhausted && !health.some((item) => item.code === "apple_notes_runtime_budget_exhausted")) {
      health.push(
        finding("warning", "apple_notes", "apple_notes_runtime_budget_exhausted", "Apple Notes run budget was exhausted before body export completed", {
          pendingBodyExports: bodyBacklog,
        }),
      );
    }
    if (!partial && !scanGuardActive) {
      for (const [id, item] of missingEntries) {
        const current = notesState[id] ?? item;
        const missingScanCount = (current.missingScanCount ?? 0) + 1;
        notesState[id] = {
          ...current,
          status: missingScanCount >= cfg.tombstoneAfterMissingScans ? "tombstoned" : current.status,
          missingScanCount,
        };
      }
    }

    for (const [id, item] of Object.entries(notesState)) {
      if (item.status === "tombstoned" && !records.some((record) => record.sourceId === id && record.type === "apple_note.tombstoned")) {
        records.push({
          source: "apple_notes",
          collection: "notes",
          kind: "event",
          type: "apple_note.tombstoned",
          sourceId: id,
          happenedAt: observedAt,
          observedAt,
          title: id,
          url: null,
          bodyText: null,
          artifactRefs: item.markdownPath ? [item.markdownPath] : [],
          payload: { id, status: "tombstoned", missingScanCount: item.missingScanCount ?? 0 },
        });
      }
    }

    const backfill = state.backfill && typeof state.backfill === "object" && !Array.isArray(state.backfill) ? state.backfill : {};
    const existingLive = backfill.live && typeof backfill.live === "object" && !Array.isArray(backfill.live) ? (backfill.live as JsonObject) : {};
    return {
      observations,
      records,
      nextCheckpoint: {
        ...state,
        notes: notesState,
        lastRunAt: observedAt.toISOString(),
        backfill: {
          ...backfill,
          live: {
            ...existingLive,
            complete: !partial && failedBodyIds.length === 0 && !scanGuardActive,
            lastFullScanAt: observedAt.toISOString(),
            bodyBacklog,
            failedBodyIds,
            scanGuardActive,
            budgetExhausted,
          },
        },
      } satisfies AppleNotesState as unknown as JsonObject,
      health,
      metrics: {
        metadataRows: metadata.length,
        uniqueNotes: unique.length,
        bodyFetches: bodyMap.size,
        bodyBatchSize,
        bodyBacklog,
        budgetExhausted,
        partial,
      },
      completed: !partial && !health.some((item) => item.level === "critical"),
      partial,
    };
  }
}

export function createAppleNotesPlugin(): TracePlugin {
  return new AppleNotesPlugin();
}

function config(ctx: PluginContext) {
  const cfg = ctx.config as JsonObject;
  return {
    source: stringAt(cfg, "source", "jxa"),
    fixturePath: stringAt(cfg, "fixturePath", ""),
    batchSize: numberAt(cfg, "batchSize", MAX_BODY_BATCH_SIZE),
    osascriptTimeoutMs: numberAt(cfg, "osascriptTimeoutMs", 90_000),
    includeFolders: stringArrayAt(cfg, "includeFolders"),
    excludeFolders: stringArrayAt(cfg, "excludeFolders"),
    includeShared: booleanAt(cfg, "includeShared", true),
    includeLockedMetadataOnly: booleanAt(cfg, "includeLockedMetadataOnly", true),
    tombstoneAfterMissingScans: numberAt(cfg, "tombstoneAfterMissingScans", 3),
    writeRawHtml: booleanAt(cfg, "writeRawHtml", true),
  };
}

function buildSource(cfg: ReturnType<typeof config>): NotesSource {
  return cfg.source === "fixture" ? new FixtureNotesSource(cfg.fixturePath) : new AppleScriptNotesSource();
}

function normalizeState(value: unknown): AppleNotesState {
  return value && typeof value === "object" ? (value as AppleNotesState) : {};
}

function dedupeAndFilter(rows: NoteMetadata[], cfg: ReturnType<typeof config>): NoteMetadata[] {
  const byId = new Map<string, NoteMetadata>();
  const includeFolders = new Set(cfg.includeFolders);
  const excludeFolders = new Set(cfg.excludeFolders);
  for (const row of rows) {
    if (!row.id) continue;
    if (!cfg.includeShared && row.shared) continue;
    if (!cfg.includeLockedMetadataOnly && row.passwordProtected) continue;
    const tokens = new Set([row.folderName, row.folderPath]);
    if (includeFolders.size && ![...tokens].some((token) => includeFolders.has(token))) continue;
    if ([...tokens].some((token) => excludeFolders.has(token))) continue;
    if (!byId.has(row.id)) byId.set(row.id, row);
  }
  return [...byId.values()];
}

function needsBody(note: NoteMetadata, previous: AppleNoteStateEntry | undefined, force: boolean): boolean {
  if (note.passwordProtected) return false;
  if (!previous) return true;
  if (force) return true;
  if (previous.status === "failed" || previous.status === "pending_body_export") return true;
  if (!previous.sourceHtmlHash) return true;
  return Boolean(note.modifiedAt && previous.modifiedAt && new Date(note.modifiedAt) > new Date(previous.modifiedAt));
}

function bodyFetchPriority(note: NoteMetadata, previous: AppleNoteStateEntry | undefined): number {
  if (!previous) return 0;
  if (previous.status === "failed") return 3;
  if (previous.status === "pending_body_export" || !previous.sourceHtmlHash) return 1;
  if (note.modifiedAt && previous.modifiedAt && new Date(note.modifiedAt) > new Date(previous.modifiedAt)) return 2;
  return 4;
}

function pendingBodyState(note: NoteMetadata, previous: AppleNoteStateEntry | undefined): AppleNoteStateEntry {
  return {
    modifiedAt: note.modifiedAt,
    status: previous?.status === "failed" ? "failed" : "pending_body_export",
    missingScanCount: 0,
    markdownPath: previous?.markdownPath,
    sourceHtmlHash: previous?.sourceHtmlHash,
    markdownHash: previous?.markdownHash,
  };
}

function shouldRenderMetadataOnly(note: NoteMetadata, previous: AppleNoteStateEntry | undefined): boolean {
  if (!note.passwordProtected) return false;
  if (!previous) return true;
  if (previous.modifiedAt !== note.modifiedAt) return true;
  if (previous.missingScanCount) return true;
  return previous.status !== "metadata_only" && previous.status !== "stale_locked";
}

function countBodyBacklog(notes: NoteMetadata[], notesState: Record<string, AppleNoteStateEntry>): number {
  return notes.filter((note) => {
    if (note.passwordProtected) return false;
    const state = notesState[note.id];
    if (!state) return true;
    return state.status === "pending_body_export" || state.status === "failed" || !state.sourceHtmlHash;
  }).length;
}

async function fetchBodiesResilient(
  source: NotesSource,
  ids: string[],
  timeoutMs: number,
  signal: AbortSignal,
  deadlineAt: number,
): Promise<{ bodies: Map<string, NoteBody>; budgetExhausted: boolean }> {
  if (!ids.length) return { bodies: new Map(), budgetExhausted: false };
  if (remainingMs(deadlineAt, MIN_ARTIFACT_RESERVE_MS) < MIN_BODY_FETCH_MS || signal.aborted) {
    return { bodies: new Map(), budgetExhausted: true };
  }
  try {
    return {
      bodies: await source.fetchBodies(ids, stepTimeoutMs(deadlineAt, timeoutMs, MIN_ARTIFACT_RESERVE_MS), signal),
      budgetExhausted: false,
    };
  } catch (error) {
    if (isAppleNotesPermissionError(error)) throw error;
    if (signal.aborted || remainingMs(deadlineAt, MIN_ARTIFACT_RESERVE_MS) < MIN_BODY_FETCH_MS) {
      return { bodies: new Map(), budgetExhausted: true };
    }
    if (ids.length <= 1) {
      return {
        bodies: new Map([[ids[0] ?? "", { id: ids[0] ?? "", html: "", plaintext: "", error: String(error) }]]),
        budgetExhausted: false,
      };
    }
    const mid = Math.floor(ids.length / 2);
    const left = await fetchBodiesResilient(source, ids.slice(0, mid), timeoutMs, signal, deadlineAt);
    if (left.budgetExhausted) return left;
    const right = await fetchBodiesResilient(source, ids.slice(mid), timeoutMs, signal, deadlineAt);
    return {
      bodies: new Map([...left.bodies, ...right.bodies]),
      budgetExhausted: right.budgetExhausted,
    };
  }
}

function remainingMs(deadlineAt: number, reserveMs: number): number {
  return Math.max(0, deadlineAt - Date.now() - reserveMs);
}

function stepTimeoutMs(deadlineAt: number, configuredTimeoutMs: number, reserveMs: number): number {
  return Math.max(1, Math.min(configuredTimeoutMs, remainingMs(deadlineAt, reserveMs) || 1));
}

function isAppleNotesPermissionError(error: unknown): boolean {
  const text = String(error);
  return /not authorized|not authorised|not allowed|not permitted|permission|automation|accessibility|privacy/i.test(text);
}

function eventRecord(note: NoteMetadata, type: string, happenedAt: string, observedAt: Date): TraceRecord {
  return {
    source: "apple_notes",
    collection: "notes",
    kind: "event",
    type,
    sourceId: `${note.id}:${type}:${happenedAt || observedAt.toISOString()}`,
    happenedAt: happenedAt ? new Date(happenedAt) : observedAt,
    observedAt,
    title: note.title,
    url: null,
    bodyText: null,
    artifactRefs: [],
    payload: note as unknown as JsonObject,
  };
}
