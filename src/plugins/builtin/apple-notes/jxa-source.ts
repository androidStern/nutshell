import { readFileSync } from "node:fs";
import { runProcess } from "../../../runtime/process";
import type { NoteBody, NoteMetadata } from "./identity";

const FIELD_SEP = "\x1f";
const ROW_SEP = "\x1e";

export interface NotesSource {
  scanMetadata(timeoutMs: number, signal: AbortSignal): Promise<NoteMetadata[]>;
  fetchBodies(ids: string[], timeoutMs: number, signal: AbortSignal): Promise<Map<string, NoteBody>>;
}

export class FixtureNotesSource implements NotesSource {
  private readonly payload: { metadata?: unknown[]; bodies?: Record<string, unknown> };

  constructor(path: string) {
    this.payload = JSON.parse(readFileSync(path, "utf8")) as { metadata?: unknown[]; bodies?: Record<string, unknown> };
  }

  async scanMetadata(): Promise<NoteMetadata[]> {
    return (this.payload.metadata ?? []).map((item) => normalizeMetadata(item));
  }

  async fetchBodies(ids: string[]): Promise<Map<string, NoteBody>> {
    const map = new Map<string, NoteBody>();
    const bodies = this.payload.bodies ?? {};
    for (const id of ids) {
      const body = bodies[id];
      if (typeof body === "string") {
        map.set(id, { id, html: body, plaintext: "", error: "" });
      } else if (body && typeof body === "object") {
        const obj = body as Record<string, unknown>;
        map.set(id, {
          id,
          html: String(obj.html ?? ""),
          plaintext: String(obj.plaintext ?? ""),
          error: String(obj.error ?? ""),
        });
      } else {
        map.set(id, { id, html: "", plaintext: "", error: "body missing from fixture" });
      }
    }
    return map;
  }
}

export class AppleScriptNotesSource implements NotesSource {
  async scanMetadata(timeoutMs: number, signal: AbortSignal): Promise<NoteMetadata[]> {
    const result = await runProcess(["osascript", "-e", metadataScript], { timeoutMs, signal });
    if (result.code !== 0) {
      throw new Error(`command failed (${result.code}): ${result.stderr || result.stdout}`);
    }
    return parseMetadataRows(result.stdout).map((item) => normalizeMetadata(item));
  }

  async fetchBodies(ids: string[], timeoutMs: number, signal: AbortSignal): Promise<Map<string, NoteBody>> {
    if (!ids.length) return new Map();
    const result = await runProcess(["osascript", "-e", bodyScript(ids)], { timeoutMs, signal });
    if (result.code !== 0) {
      throw new Error(`command failed (${result.code}): ${result.stderr || result.stdout}`);
    }
    const rows = parseBodyRows(result.stdout);
    const map = new Map<string, NoteBody>();
    for (const row of rows) {
      const item = row as Record<string, unknown>;
      const id = String(item.id ?? "");
      if (!id) continue;
      map.set(id, {
        id,
        html: String(item.html ?? ""),
        plaintext: String(item.plaintext ?? ""),
        error: String(item.error ?? ""),
      });
    }
    for (const id of ids) {
      if (!map.has(id)) map.set(id, { id, html: "", plaintext: "", error: "note body not returned by Notes.app" });
    }
    return map;
  }
}

export function parseMetadataRows(output: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const rawRow of output.split(ROW_SEP)) {
    if (!rawRow.trim()) continue;
    const fields = rawRow.split(FIELD_SEP);
    if (fields.length < 9) continue;
    rows.push({
      id: fields[0] ?? "",
      title: fields[1] || "Untitled",
      folder_id: fields[2] ?? "",
      folder_name: fields[3] || "Notes",
      folder_path: fields[4] || fields[3] || "Notes",
      created_at: fields[5] ?? "",
      modified_at: fields[6] ?? "",
      shared: (fields[7] ?? "").toLowerCase() === "true",
      password_protected: (fields[8] ?? "").toLowerCase() === "true",
    });
  }
  return rows;
}

export function parseBodyRows(output: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const rawRow of output.split(ROW_SEP)) {
    if (!rawRow) continue;
    const first = rawRow.indexOf(FIELD_SEP);
    const second = first >= 0 ? rawRow.indexOf(FIELD_SEP, first + FIELD_SEP.length) : -1;
    const third = second >= 0 ? rawRow.indexOf(FIELD_SEP, second + FIELD_SEP.length) : -1;
    if (first < 0 || second < 0 || third < 0) continue;
    rows.push({
      id: rawRow.slice(0, first),
      error: rawRow.slice(first + FIELD_SEP.length, second),
      html: rawRow.slice(second + FIELD_SEP.length, third),
      plaintext: rawRow.slice(third + FIELD_SEP.length),
    });
  }
  return rows;
}

function normalizeMetadata(item: unknown): NoteMetadata {
  const row = item as Record<string, unknown>;
  return {
    id: String(row.id ?? row.apple_notes_id ?? ""),
    title: String(row.title ?? row.name ?? "Untitled"),
    folderId: String(row.folder_id ?? row.folderId ?? ""),
    folderName: String(row.folder_name ?? row.folderName ?? "Notes"),
    folderPath: String(row.folder_path ?? row.folderPath ?? row.folder_name ?? "Notes"),
    createdAt: String(row.created_at ?? row.createdAt ?? ""),
    modifiedAt: String(row.modified_at ?? row.modifiedAt ?? ""),
    shared: Boolean(row.shared ?? false),
    passwordProtected: Boolean(row.password_protected ?? row.passwordProtected ?? false),
  };
}

const metadataScript = `
on two(n)
\tif n < 10 then return "0" & n
\treturn n as text
end two

on isoDate(d)
\ttry
\t\tset y to year of d as integer
\t\tset m to month of d as integer
\t\tset dy to day of d as integer
\t\tset s to time of d
\t\tset h to s div 3600
\t\tset mi to (s mod 3600) div 60
\t\tset se to s mod 60
\t\treturn (y as text) & "-" & my two(m) & "-" & my two(dy) & "T" & my two(h) & ":" & my two(mi) & ":" & my two(se)
\ton error
\t\treturn ""
\tend try
end isoDate

on replaceText(sourceText, findText, replaceText)
\tset oldDelimiters to AppleScript's text item delimiters
\tset AppleScript's text item delimiters to findText
\tset textItems to text items of sourceText
\tset AppleScript's text item delimiters to replaceText
\tset joinedText to textItems as text
\tset AppleScript's text item delimiters to oldDelimiters
\treturn joinedText
end replaceText

on cleanText(valueText)
\ttry
\t\tset t to valueText as text
\ton error
\t\tset t to ""
\tend try
\tset t to my replaceText(t, ASCII character 31, " ")
\tset t to my replaceText(t, ASCII character 30, " ")
\tset t to my replaceText(t, return, " ")
\tset t to my replaceText(t, linefeed, " ")
\treturn t
end cleanText

set fieldSep to ASCII character 31
set rowSep to ASCII character 30
set outputRows to ""

tell application "Notes"
\trepeat with accountItem in accounts
\t\tset accountName to name of accountItem as text
\t\trepeat with folderItem in folders of accountItem
\t\t\tset folderName to name of folderItem as text
\t\t\tset folderID to id of folderItem as text
\t\t\tset folderPath to accountName & "/" & folderName
\t\t\tset noteIDs to id of every note of folderItem
\t\t\tset noteNames to name of every note of folderItem
\t\t\tset createdDates to creation date of every note of folderItem
\t\t\tset modifiedDates to modification date of every note of folderItem
\t\t\tset sharedFlags to shared of every note of folderItem
\t\t\tset lockedFlags to password protected of every note of folderItem
\t\t\tset noteCount to count of noteIDs
\t\t\trepeat with i from 1 to noteCount
\t\t\t\tset outputRows to outputRows & my cleanText(item i of noteIDs) & fieldSep
\t\t\t\tset outputRows to outputRows & my cleanText(item i of noteNames) & fieldSep
\t\t\t\tset outputRows to outputRows & my cleanText(folderID) & fieldSep
\t\t\t\tset outputRows to outputRows & my cleanText(folderName) & fieldSep
\t\t\t\tset outputRows to outputRows & my cleanText(folderPath) & fieldSep
\t\t\t\tset outputRows to outputRows & my isoDate(item i of createdDates) & fieldSep
\t\t\t\tset outputRows to outputRows & my isoDate(item i of modifiedDates) & fieldSep
\t\t\t\tset outputRows to outputRows & ((item i of sharedFlags) as text) & fieldSep
\t\t\t\tset outputRows to outputRows & ((item i of lockedFlags) as text) & rowSep
\t\t\tend repeat
\t\tend repeat
\tend repeat
end tell

return outputRows
`;

function bodyScript(ids: string[]): string {
  return `
set fieldSep to ASCII character 31
set rowSep to ASCII character 30
set targetIDs to ${appleScriptList(ids)}
set outputRows to ""

tell application "Notes"
\trepeat with targetID in targetIDs
\t\tset noteID to targetID as text
\t\ttry
\t\t\tset noteItem to first note whose id is noteID
\t\t\tset htmlBody to body of noteItem as text
\t\t\tset plainBody to plaintext of noteItem as text
\t\t\tset outputRows to outputRows & noteID & fieldSep & "" & fieldSep & htmlBody & fieldSep & plainBody & rowSep
\t\ton error errorMessage
\t\t\tset outputRows to outputRows & noteID & fieldSep & errorMessage & fieldSep & "" & fieldSep & "" & rowSep
\t\tend try
\tend repeat
end tell

return outputRows
`;
}

function appleScriptList(values: string[]): string {
  return `{${values.map(appleScriptString).join(", ")}}`;
}

function appleScriptString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
