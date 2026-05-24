import type { NoteMetadata } from "./identity";
import { sha256 } from "../../../core/ids";

export interface MarkdownRenderInput {
  note: NoteMetadata;
  bodyMarkdown: string;
  syncedAt: Date;
  status: string;
  sourceHtmlHash: string;
  plaintextHash: string;
  renderedHash: string;
  error?: string;
}

export function htmlToMarkdown(html: string): { markdown: string; hasPossibleAttachments: boolean } {
  const hasPossibleAttachments = /<img\b|cid:|file:|data:/i.test(html);
  let text = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|h\d|li)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => {
      const cleanLabel = stripTags(label).trim() || href;
      return `[${cleanLabel}](${href})`;
    });
  text = stripTags(text)
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { markdown: text ? `${text}\n` : "", hasPossibleAttachments };
}

export function renderNoteMarkdown(input: MarkdownRenderInput): string {
  const fields: Record<string, string | boolean> = {
    source: "apple_notes",
    apple_notes_id: input.note.id,
    title: input.note.title,
    created_at: input.note.createdAt,
    modified_at: input.note.modifiedAt,
    folder_id: input.note.folderId,
    folder: input.note.folderName,
    folder_path: input.note.folderPath,
    shared: input.note.shared,
    password_protected: input.note.passwordProtected,
    source_html_sha256: input.sourceHtmlHash,
    source_plaintext_sha256: input.plaintextHash,
    rendered_markdown_sha256: input.renderedHash,
    sync_status: input.status,
    synced_at: input.syncedAt.toISOString(),
  };
  if (input.error) fields.error = input.error;
  const frontmatter = Object.entries(fields)
    .map(([key, value]) => `${key}: ${quoteYaml(value)}`)
    .join("\n");
  return `---\n${frontmatter}\n---\n\n${input.bodyMarkdown.trim()}\n`;
}

export function markdownHash(markdownBody: string): string {
  return sha256(markdownBody.trim() ? `${markdownBody.trim()}\n` : "");
}

function quoteYaml(value: string | boolean): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  return JSON.stringify(value);
}

function stripTags(value: string): string {
  return value.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ");
}

