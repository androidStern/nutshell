import { fingerprint } from "../../../core/ids";
import type { Json } from "../../../core/types";

export interface YouTubeActivityItem {
  source?: string;
  date_key?: string;
  happened_at?: string;
  import_id?: string;
  product?: string;
  verb?: string;
  title?: string;
  title_url?: string | null;
  channel?: string;
  channel_url?: string | null;
  detail_text?: string;
  duration?: string;
  thumbnail_url?: string | null;
  progress_percent?: number | null;
  raw_text?: string;
}

export function youtubeSourceId(item: YouTubeActivityItem): string {
  if (item.import_id) return item.import_id;
  const url = item.title_url || "";
  const eventTime = item.happened_at || item.date_key || "";
  if (url) {
    return fingerprint({
      eventTime,
      verb: item.verb || "",
      url,
      detail_text: item.detail_text || "",
      raw_text: item.raw_text || "",
    } as Json);
  }
  return fingerprint({
    eventTime,
    verb: item.verb || "",
    title: item.title || "",
    channel: item.channel || "",
    raw_text: item.raw_text || "",
  } as Json);
}

export function youtubeFingerprint(item: YouTubeActivityItem): string {
  return fingerprint({
    import_id: item.import_id || "",
    date_key: item.date_key || "",
    happened_at: item.happened_at || "",
    verb: item.verb || "",
    title: item.title || "",
    title_url: item.title_url || "",
    channel: item.channel || "",
    raw_text: item.raw_text || "",
  } as Json);
}

export function youtubeEventType(item: YouTubeActivityItem): "youtube.watched" | "youtube.searched" {
  const verb = String(item.verb || item.raw_text || "").toLowerCase();
  return verb.includes("search") ? "youtube.searched" : "youtube.watched";
}

export function dateKeyToDate(value: string | undefined): Date | null {
  if (!value || !/^\d{8}$/.test(value)) return null;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  return new Date(year, month - 1, day, 12, 0, 0, 0);
}

export function youtubeHappenedAt(item: YouTubeActivityItem): Date | null {
  if (item.happened_at) {
    const parsed = new Date(item.happened_at);
    if (!Number.isNaN(parsed.valueOf())) return parsed;
  }
  return dateKeyToDate(item.date_key);
}
