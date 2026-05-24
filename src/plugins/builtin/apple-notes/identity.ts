import { sha256, slugify } from "../../../core/ids";

export interface NoteMetadata {
  id: string;
  title: string;
  folderId: string;
  folderName: string;
  folderPath: string;
  createdAt: string;
  modifiedAt: string;
  shared: boolean;
  passwordProtected: boolean;
}

export interface NoteBody {
  id: string;
  html: string;
  plaintext: string;
  error: string;
}

export function noteSourceId(note: NoteMetadata): string {
  return note.id;
}

export function noteMarkdownRelativePath(note: NoteMetadata): string {
  const folder = slugify(note.folderPath || note.folderName || "notes", "notes");
  const title = slugify(note.title || "untitled", "untitled");
  return `apple_notes/markdown/${folder}/${title}--${sha256(note.id).slice(0, 8)}.md`;
}

export function noteRawHtmlRelativePath(note: NoteMetadata): string {
  return `apple_notes/raw-html/${encodeURIComponent(note.id)}.html`;
}

