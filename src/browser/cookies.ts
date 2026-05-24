import { getCookies, toCookieHeader, type BrowserName, type Cookie } from "@steipete/sweet-cookie";

export interface BrowserCookieRequest {
  url: string;
  origins?: string[];
  names?: string[];
  browser?: string;
  profile?: string;
  timeoutMs?: number;
}

export interface BrowserCookieHeader {
  header: string;
  warnings: string[];
}

export interface BrowserCookieSet {
  cookies: Cookie[];
  warnings: string[];
}

export async function readBrowserCookieHeader(request: BrowserCookieRequest): Promise<BrowserCookieHeader> {
  const result = await readBrowserCookies(request);
  const header = toCookieHeader(result.cookies, { dedupeByName: true, sort: "name" });
  return { header, warnings: result.warnings };
}

export async function readBrowserCookies(request: BrowserCookieRequest): Promise<BrowserCookieSet> {
  const browsers = request.browser ? [normalizeBrowserName(request.browser)] : undefined;
  const result = await getCookies({
    url: request.url,
    origins: request.origins,
    names: request.names,
    browsers,
    chromeProfile: request.profile || undefined,
    chromiumBrowser: request.browser === "brave" || request.browser === "arc" || request.browser === "chromium" ? request.browser : undefined,
    timeoutMs: request.timeoutMs,
    mode: "merge",
  });
  return { cookies: result.cookies, warnings: result.warnings };
}

export function cookieValue(cookies: readonly Cookie[], name: string): string | null {
  const found = cookies.find((cookie) => cookie.name === name && cookie.value.length > 0);
  return found?.value ?? null;
}

function normalizeBrowserName(value: string): BrowserName {
  if (value === "edge" || value === "firefox" || value === "safari") return value;
  return "chrome";
}
