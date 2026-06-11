import { readBrowserCookies } from "../../../browser/cookies";
import { toCookieHeader, type Cookie } from "@steipete/sweet-cookie";
import { chromeSafeStorageAccessMessage, isChromeSafeStorageAccessIssue } from "../../../browser/access-errors";
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
  authUser: number;
}

interface MyActivityDeps {
  readBrowserCookies: typeof readBrowserCookies;
  fetch: FetchLike;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type JarCookie = Cookie & { hostOnly?: boolean };

export async function collectYouTubeFromMyActivityHttp(input: {
  cutoffYmd: string;
  maxPages: number;
  cursor?: string | null;
  cookieBrowser: string;
  cookieProfile: string;
  cookieTimeoutMs: number;
  // Which signed-in Google account to use, by browser order (0 = first).
  // A browser signed into multiple Google accounts shares one cookie jar;
  // without this, My Activity bounces every request to the account chooser.
  authUser: number;
  signal: AbortSignal;
}, deps: MyActivityDeps = DEFAULT_DEPS): Promise<MyActivityHttpResult> {
  const cookieJar = await MyActivityCookieJar.fromBrowser(input, deps);
  const myActivityCookieHeader = cookieJar.headerFor(MYACTIVITY_URL);
  if (!/SAPISID|__Secure-|SID=|HSID=/.test(myActivityCookieHeader)) {
    const warnings = cookieJar.warnings.join("; ");
    const message = isChromeSafeStorageAccessIssue(warnings) ? chromeSafeStorageAccessMessage("YouTube") : "Google browser cookies were not usable for My Activity";
    throw new Error(`${message}; warnings=${warnings}`);
  }
  const session = await establishSession(cookieJar, Math.max(0, Math.trunc(input.authUser)), input.signal, deps);
  {
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
      const response = await callDisplayItems(cookieJar, session, request, pages, input.signal, deps);
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
        authUser: session.authUser,
      },
    };
  }
}

async function establishSession(cookieJar: MyActivityCookieJar, preferredAuthUser: number, signal: AbortSignal, deps: MyActivityDeps): Promise<MyActivitySession> {
  let lastError: unknown = null;
  for (const authUser of authUserCandidates(preferredAuthUser)) {
    try {
      const page = await fetchText(cookieJar, withAuthUser(MYACTIVITY_URL, authUser), null, authUser, signal, deps);
      return parseSession(page, authUser);
    } catch (error) {
      lastError = error;
      if (!isAccountSessionError(error)) throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function authUserCandidates(preferred: number): number[] {
  const candidates = [preferred, 0, 1, 2, 3, 4].filter((value) => Number.isFinite(value) && value >= 0);
  return Array.from(new Set(candidates.map((value) => Math.trunc(value))));
}

function isAccountSessionError(error: unknown): boolean {
  return String(error).includes(MYACTIVITY_SESSION_UNVERIFIABLE);
}

function withAuthUser(url: string, authUser: number): string {
  return `${url}${url.includes("?") ? "&" : "?"}authuser=${authUser}`;
}

async function fetchText(
  cookieJar: MyActivityCookieJar,
  url: string,
  formBody: string | null,
  authUser: number,
  signal: AbortSignal,
  deps: MyActivityDeps,
): Promise<string> {
  let currentUrl = url;
  let body = formBody;
  let method = formBody === null ? "GET" : "POST";
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const headers = new Headers({
      "user-agent": userAgent,
      cookie: cookieJar.headerFor(currentUrl),
      referer: MYACTIVITY_REFERER,
      "x-goog-authuser": String(authUser),
    });
    if (body === null) {
      headers.set("accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8");
      headers.set("accept-language", "en-US,en;q=0.9");
      headers.set("sec-fetch-dest", "document");
      headers.set("sec-fetch-mode", "navigate");
      headers.set("upgrade-insecure-requests", "1");
    } else {
      headers.set("origin", MYACTIVITY_ORIGIN);
      headers.set("content-type", "application/x-www-form-urlencoded;charset=UTF-8");
      headers.set("x-same-domain", "1");
    }
    const response = await deps.fetch(currentUrl, {
      method,
      headers,
      body: body ?? undefined,
      redirect: "manual",
      signal,
    });
    cookieJar.storeFromResponse(response, currentUrl);
    const location = response.headers.get("location");
    if (isRedirect(response.status) && location) {
      currentUrl = new URL(location, currentUrl).toString();
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
        method = "GET";
        body = null;
      }
      continue;
    }
    const text = await response.text();
    if (!response.ok) throw new Error(`My Activity HTTP ${response.status} at ${new URL(currentUrl).hostname}`);
    return text;
  }
  throw new Error(`Google ${MYACTIVITY_SESSION_UNVERIFIABLE}: redirect loop while opening My Activity`);
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

// Sentinel substring carried by parseSession errors that mean "Google
// interposed an identity-verification page" — classified to a dedicated
// finding so the product names the real cause instead of guessing.
export const MYACTIVITY_SESSION_UNVERIFIABLE = "could not establish a My Activity session";

function parseSession(html: string, authUser: number): MyActivitySession {
  // The authoritative signal that we reached the real My Activity app is its
  // own build label. A page can carry the generic SNlM0e token yet still be
  // Google's identity/auth shell (multi-account or device-binding checks), so
  // we key on the footprints build, not loose "Sign in" text or SNlM0e alone.
  const footprintsBuild = html.match(/boq_footprintsmyactivityuiserver_[^"&/]+/);
  if (footprintsBuild && /"SNlM0e":"[^"]+"/.test(html)) {
    const at = matchRequired(html, /"SNlM0e":"([^"]+)"/, "SNlM0e");
    const fsid = matchRequired(html, /"FdrFJe":"([^"]+)"/, "FdrFJe");
    return { at, fsid, bl: footprintsBuild[0], authUser };
  }
  if (/FootprintsMyactivitySignedoutUi/i.test(html.slice(0, 500_000))) {
    throw new Error("Google My Activity returned the signed-out shell for the configured browser profile");
  }
  if (/boq_identityfrontendauthuiserver/i.test(html)) {
    throw new Error(`Google ${MYACTIVITY_SESSION_UNVERIFIABLE}: it served an identity-verification page for this account`);
  }
  if (/accounts\.google\.com\/(?:signin|ServiceLogin)/i.test(html.slice(0, 200_000))) {
    throw new Error(`Google ${MYACTIVITY_SESSION_UNVERIFIABLE}: no account session resolved; set youtube.authUser to the right account index`);
  }
  const at = matchRequired(html, /"SNlM0e":"([^"]+)"/, "SNlM0e");
  const fsid = matchRequired(html, /"FdrFJe":"([^"]+)"/, "FdrFJe");
  const bl = matchRequired(html, /boq_footprintsmyactivityuiserver_[^"&/]+/, "boq build label");
  return { at, fsid, bl, authUser };
}

async function callDisplayItems(
  cookieJar: MyActivityCookieJar,
  session: MyActivitySession,
  request: unknown[],
  page: number,
  signal: AbortSignal,
  deps: MyActivityDeps,
): Promise<string> {
  const fReq = JSON.stringify([[["y3VFHd", JSON.stringify(request), null, "generic"]]]);
  const body = new URLSearchParams({ "f.req": fReq, at: session.at }).toString();
  const url =
    `https://myactivity.google.com/_/FootprintsMyactivityUi/data/batchexecute?rpcids=y3VFHd` +
    `&source-path=%2Fmyactivity&f.sid=${encodeURIComponent(session.fsid)}&bl=${encodeURIComponent(session.bl)}` +
    `&hl=en&authuser=${session.authUser}&soc-app=712&soc-platform=1&soc-device=1&_reqid=${7000 + page}&rt=c`;
  return fetchText(cookieJar, url, body, session.authUser, signal, deps);
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

class MyActivityCookieJar {
  private constructor(
    private readonly cookies: JarCookie[],
    readonly warnings: string[],
  ) {}

  static async fromBrowser(
    input: { cookieBrowser: string; cookieProfile: string; cookieTimeoutMs: number },
    deps: MyActivityDeps,
  ): Promise<MyActivityCookieJar> {
    const result = await deps.readBrowserCookies({
      url: "https://myactivity.google.com/",
      origins: GOOGLE_COOKIE_ORIGINS,
      browser: input.cookieBrowser,
      profile: input.cookieProfile || undefined,
      timeoutMs: input.cookieTimeoutMs,
    });
    return new MyActivityCookieJar(
      result.cookies.filter((cookie) => cookie.value).map((cookie) => normalizeCookie(cookie)),
      result.warnings,
    );
  }

  headerFor(url: string): string {
    return toCookieHeader(this.cookies.filter((cookie) => cookieApplies(cookie, url)), { dedupeByName: true, sort: "name" });
  }

  storeFromResponse(response: Response, responseUrl: string): void {
    for (const value of setCookieHeaders(response.headers)) {
      for (const cookie of parseSetCookieHeader(value, responseUrl)) this.set(cookie);
    }
  }

  private set(cookie: JarCookie): void {
    const index = this.cookies.findIndex((existing) => cookieKey(existing) === cookieKey(cookie));
    if (cookie.expires !== undefined && cookie.expires <= Math.floor(Date.now() / 1000)) {
      if (index >= 0) this.cookies.splice(index, 1);
      return;
    }
    if (index >= 0) this.cookies[index] = cookie;
    else this.cookies.push(cookie);
  }
}

function normalizeCookie(cookie: Cookie): JarCookie {
  return {
    ...cookie,
    domain: cookie.domain?.replace(/^\./, "") ?? "",
    path: cookie.path || "/",
  };
}

function cookieApplies(cookie: JarCookie, urlString: string): boolean {
  const url = new URL(urlString);
  if (cookie.secure && url.protocol !== "https:") return false;
  if (cookie.expires !== undefined && cookie.expires <= Math.floor(Date.now() / 1000)) return false;
  const domain = (cookie.domain ?? "").replace(/^\./, "").toLowerCase();
  if (!domain) return false;
  const host = url.hostname.toLowerCase();
  const domainMatches = cookie.hostOnly ? host === domain : host === domain || host.endsWith(`.${domain}`);
  return domainMatches && url.pathname.startsWith(cookie.path || "/");
}

function setCookieHeaders(headers: Headers): string[] {
  const withGetSetCookie = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof withGetSetCookie.getSetCookie === "function") return withGetSetCookie.getSetCookie();
  const combined = headers.get("set-cookie");
  return combined ? splitCombinedSetCookieHeader(combined) : [];
}

function splitCombinedSetCookieHeader(value: string): string[] {
  return value.split(/,(?=\s*[^;,=\s]+=[^;,]+)/g).map((part) => part.trim()).filter(Boolean);
}

function parseSetCookieHeader(header: string, responseUrl: string): JarCookie[] {
  return splitCombinedSetCookieHeader(header).map((value) => parseSetCookie(value, responseUrl)).filter((cookie): cookie is JarCookie => Boolean(cookie));
}

function parseSetCookie(value: string, responseUrl: string): JarCookie | null {
  const parts = value.split(";").map((part) => part.trim()).filter(Boolean);
  const [nameValue, ...attributes] = parts;
  if (!nameValue) return null;
  const equals = nameValue.indexOf("=");
  if (equals <= 0) return null;
  const url = new URL(responseUrl);
  const name = nameValue.slice(0, equals);
  const cookieValue = nameValue.slice(equals + 1);
  let domain = url.hostname.toLowerCase();
  let hostOnly = true;
  let path = defaultCookiePath(url.pathname);
  let secure = false;
  let httpOnly = false;
  let expires: number | undefined;
  let sameSite: Cookie["sameSite"] | undefined;
  for (const attribute of attributes) {
    const equalsIndex = attribute.indexOf("=");
    const key = (equalsIndex >= 0 ? attribute.slice(0, equalsIndex) : attribute).trim().toLowerCase();
    const attrValue = equalsIndex >= 0 ? attribute.slice(equalsIndex + 1).trim() : "";
    if (key === "domain" && attrValue) {
      domain = attrValue.replace(/^\./, "").toLowerCase();
      hostOnly = false;
    } else if (key === "path" && attrValue) {
      path = attrValue;
    } else if (key === "secure") {
      secure = true;
    } else if (key === "httponly") {
      httpOnly = true;
    } else if (key === "max-age") {
      const seconds = Number.parseInt(attrValue, 10);
      if (Number.isFinite(seconds)) expires = Math.floor(Date.now() / 1000) + seconds;
    } else if (key === "expires") {
      const time = Date.parse(attrValue);
      if (Number.isFinite(time)) expires = Math.floor(time / 1000);
    } else if (key === "samesite") {
      sameSite = normalizeSameSite(attrValue);
    }
  }
  const cookie: JarCookie = {
    name,
    value: cookieValue,
    domain,
    path,
    secure,
    httpOnly,
    hostOnly,
    source: { browser: "chrome" },
  };
  if (expires !== undefined) cookie.expires = expires;
  if (sameSite) cookie.sameSite = sameSite;
  return cookie;
}

function defaultCookiePath(pathname: string): string {
  if (!pathname || !pathname.startsWith("/")) return "/";
  const lastSlash = pathname.lastIndexOf("/");
  return lastSlash <= 0 ? "/" : pathname.slice(0, lastSlash);
}

function normalizeSameSite(value: string): Cookie["sameSite"] | undefined {
  if (/^strict$/i.test(value)) return "Strict";
  if (/^lax$/i.test(value)) return "Lax";
  if (/^none$/i.test(value)) return "None";
  return undefined;
}

function cookieKey(cookie: JarCookie): string {
  return `${cookie.name}|${cookie.domain ?? ""}|${cookie.path ?? "/"}|${cookie.hostOnly ? "host" : "domain"}`;
}

const DEFAULT_DEPS: MyActivityDeps = {
  readBrowserCookies,
  fetch,
};

const MYACTIVITY_URL = "https://myactivity.google.com/myactivity?product=26";
const MYACTIVITY_ORIGIN = "https://myactivity.google.com";
const MYACTIVITY_REFERER = "https://myactivity.google.com/myactivity?product=26";
const MAX_REDIRECTS = 12;
const GOOGLE_COOKIE_ORIGINS = [
  "https://myactivity.google.com/",
  "https://accounts.google.com/",
  "https://google.com/",
  "https://youtube.com/",
  "https://www.youtube.com/",
];

const userAgent =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36";
