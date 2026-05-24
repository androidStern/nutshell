import { readBrowserCookieHeader } from "../../../browser/cookies";
import type { JsonObject } from "../../../core/types";
import type { YouTubeActivityItem } from "./identity";

export interface MyActivityHttpResult {
  items: YouTubeActivityItem[];
  scroll: JsonObject;
}

interface MyActivitySession {
  at: string;
  fsid: string;
  bl: string;
}

export async function collectYouTubeFromMyActivityHttp(input: {
  cutoffYmd: string;
  maxPages: number;
  cursor?: string | null;
  cookieBrowser: string;
  cookieProfile: string;
  cookieTimeoutMs: number;
  signal: AbortSignal;
}): Promise<MyActivityHttpResult> {
  const cookies = await readBrowserCookieHeader({
    url: "https://myactivity.google.com/",
    origins: ["https://myactivity.google.com/", "https://www.youtube.com/", "https://youtube.com/", "https://accounts.google.com/", "https://google.com/"],
    browser: input.cookieBrowser,
    profile: input.cookieProfile || undefined,
    timeoutMs: input.cookieTimeoutMs,
  });
  if (!/SAPISID|__Secure-|SID=|HSID=/.test(cookies.header)) {
    throw new Error(`Google browser cookies were not usable for My Activity; warnings=${cookies.warnings.join("; ")}`);
  }
  const cookieHeader = cookies.header;
  {
    const page = await fetchText(cookieHeader, "https://myactivity.google.com/myactivity?product=26", null, input.signal);
    const session = parseSession(page);
    const allItems: YouTubeActivityItem[] = [];
    let cursor: string | null = input.cursor ?? null;
    let nextCursor: string | null = cursor;
    let pages = 0;
    let reachedCutoff = false;
    let stoppedForCursorLoop = false;
    let stoppedForExhaustion = false;
    let oldestLoadedDateKey: string | null = null;
    let newestLoadedDateKey: string | null = null;

    while (pages < input.maxPages) {
      const request = cursor ? [youtubeProductFilter(), cursor] : [youtubeProductFilter()];
      const response = await callDisplayItems(cookieHeader, session, request, pages, input.signal);
      pages += 1;
      const parsed = parseDisplayItemsResponse(response);
      const items = parsed.rows.map(rowToItem).filter((item): item is YouTubeActivityItem => Boolean(item));
      allItems.push(...items);
      const dateKeys = items.map((item) => item.date_key).filter((value): value is string => Boolean(value)).sort();
      oldestLoadedDateKey = minDateKey(oldestLoadedDateKey, dateKeys[0] ?? null);
      newestLoadedDateKey = maxDateKey(newestLoadedDateKey, dateKeys[dateKeys.length - 1] ?? null);
      if (oldestLoadedDateKey && oldestLoadedDateKey <= input.cutoffYmd) {
        reachedCutoff = true;
        break;
      }
      if (!parsed.cursor) {
        stoppedForExhaustion = true;
        nextCursor = null;
        break;
      }
      if (parsed.cursor === cursor) {
        stoppedForCursorLoop = true;
        nextCursor = parsed.cursor;
        break;
      }
      cursor = parsed.cursor;
      nextCursor = cursor;
    }

    return {
      items: allItems.filter((item) => item.date_key && item.date_key >= input.cutoffYmd),
      scroll: {
        driver: "myactivity_http",
        pages,
        maxPages: input.maxPages,
        reachedCutoff,
        stoppedForStagnation: false,
        stoppedForCursorLoop,
        stoppedForExhaustion,
        oldestLoadedDateKey,
        newestLoadedDateKey,
        loadedCardCount: allItems.length,
        nextCursor: reachedCutoff ? null : nextCursor,
      },
    };
  }
}

async function fetchText(cookieHeader: string, url: string, formBody: string | null, signal: AbortSignal): Promise<string> {
  const headers = new Headers({
    "user-agent": userAgent,
    cookie: cookieHeader,
    origin: "https://myactivity.google.com",
    referer: "https://myactivity.google.com/myactivity?product=26",
  });
  const init: RequestInit = {
    method: formBody === null ? "GET" : "POST",
    headers,
    body: formBody ?? undefined,
    redirect: "follow",
    signal,
  };
  if (formBody !== null) {
    headers.set("content-type", "application/x-www-form-urlencoded;charset=UTF-8");
    headers.set("x-same-domain", "1");
  }
  const response = await fetch(url, init);
  const text = await response.text();
  if (!response.ok) throw new Error(`My Activity HTTP ${response.status}: ${text.slice(0, 300)}`);
  return text;
}

function parseSession(html: string): MyActivitySession {
  if (/accounts\.google\.com\/(?:signin|ServiceLogin)|Sign in/i.test(html.slice(0, 200_000))) {
    throw new Error("Google My Activity returned a signed-out page");
  }
  const at = matchRequired(html, /"SNlM0e":"([^"]+)"/, "SNlM0e");
  const fsid = matchRequired(html, /"FdrFJe":"([^"]+)"/, "FdrFJe");
  const bl = matchRequired(html, /boq_footprintsmyactivityuiserver_[^"&/]+/, "boq build label");
  return { at, fsid, bl };
}

async function callDisplayItems(
  cookieHeader: string,
  session: MyActivitySession,
  request: unknown[],
  page: number,
  signal: AbortSignal,
): Promise<string> {
  const fReq = JSON.stringify([[["y3VFHd", JSON.stringify(request), null, "generic"]]]);
  const body = new URLSearchParams({ "f.req": fReq, at: session.at }).toString();
  const url =
    `https://myactivity.google.com/_/FootprintsMyactivityUi/data/batchexecute?rpcids=y3VFHd` +
    `&source-path=%2Fmyactivity&f.sid=${encodeURIComponent(session.fsid)}&bl=${encodeURIComponent(session.bl)}` +
    `&hl=en&soc-app=712&soc-platform=1&soc-device=1&_reqid=${7000 + page}&rt=c`;
  return fetchText(cookieHeader, url, body, signal);
}

function parseDisplayItemsResponse(text: string): { rows: unknown[]; cursor: string | null } {
  const lines = text.split(/\r?\n/);
  const payloadLine = lines.find((line) => line.startsWith('[["wrb.fr","y3VFHd"'));
  if (!payloadLine) throw new Error("My Activity display-items response did not contain y3VFHd payload");
  const outer = JSON.parse(payloadLine) as unknown[];
  const payloadText = Array.isArray(outer[0]) ? outer[0][2] : null;
  if (typeof payloadText !== "string") throw new Error("My Activity display-items payload was empty");
  const payload = JSON.parse(payloadText) as unknown[];
  const rows = Array.isArray(payload[0]) ? payload[0] : [];
  const cursor = typeof payload[1] === "string" && payload[1].length ? payload[1] : null;
  return { rows, cursor };
}

function rowToItem(row: unknown): YouTubeActivityItem | null {
  if (!Array.isArray(row)) return null;
  const micros = typeof row[4] === "number" ? row[4] : null;
  const action = Array.isArray(row[9]) ? row[9] : [];
  const media = Array.isArray(row[23]) ? row[23] : [];
  const channel = Array.isArray(row[32]) && Array.isArray(row[32][0]) ? row[32][0] as unknown[] : [];
  const title = stringOrNull(action[0]);
  const verb = stringOrNull(action[2]);
  if (!title || !verb || !micros) return null;
  const happenedAt = new Date(Math.floor(micros / 1000));
  const channelName = stringOrNull(channel[1]);
  const duration = stringOrNull(media[1]);
  const product = Array.isArray(row[7]) ? stringOrNull(row[7][0]) : "YouTube";
  return {
    source: "youtube_myactivity_http",
    date_key: ymd(happenedAt),
    happened_at: happenedAt.toISOString(),
    product: product ?? "YouTube",
    verb,
    title,
    title_url: stringOrNull(action[3]),
    channel: channelName ?? undefined,
    channel_url: stringOrNull(channel[3]),
    duration: duration ?? undefined,
    thumbnail_url: stringOrNull(media[0]),
    progress_percent: typeof media[2] === "number" ? media[2] : null,
    raw_text: [product ?? "YouTube", verb, title, channelName, duration].filter(Boolean).join(" "),
  };
}

function youtubeProductFilter(): unknown[] {
  return [[], null, null, null, [[26]]];
}

function matchRequired(text: string, pattern: RegExp, label: string): string {
  const match = text.match(pattern);
  if (!match) throw new Error(`Could not find ${label} in My Activity page`);
  return match[1] ?? match[0];
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length ? value : null;
}

function minDateKey(left: string | null, right: string | null): string | null {
  if (!left) return right;
  if (!right) return left;
  return left < right ? left : right;
}

function maxDateKey(left: string | null, right: string | null): string | null {
  if (!left) return right;
  if (!right) return left;
  return left > right ? left : right;
}

function ymd(date: Date): string {
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
}

const userAgent =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36";
