import { expect, test } from "bun:test";
import type { Cookie } from "@steipete/sweet-cookie";
import { collectYouTubeFromMyActivityHttp } from "../src/plugins/builtin/youtube/myactivity-http";

test("youtube My Activity collector keeps Google redirect cookies in memory for the data request", async () => {
  const requests: Array<{ url: string; method: string; cookie: string }> = [];
  const result = await collectYouTubeFromMyActivityHttp(
    {
      cutoffYmd: "20260521",
      maxPages: 1,
      cursor: null,
      cookieBrowser: "chrome",
      cookieProfile: "",
      cookieTimeoutMs: 1_000,
      authUser: 0,
      signal: new AbortController().signal,
    },
    {
      readBrowserCookies: async () => ({
        cookies: [
          cookie("SID", "sid-value", "google.com"),
          cookie("SAPISID", "sapisid-value", "google.com"),
          cookie("__Secure-1PSID", "secure-psid-value", "google.com"),
          cookie("LSID", "lsid-value", "accounts.google.com"),
        ],
        warnings: [],
      }),
      fetch: async (url, init) => {
        const urlString = String(url);
        const method = init?.method ?? "GET";
        const requestCookie = String(new Headers(init?.headers).get("cookie") ?? "");
        requests.push({ url: urlString, method, cookie: requestCookie });
        if (urlString === "https://myactivity.google.com/myactivity?product=26&authuser=0&done=1") {
          expect(requestCookie).toContain("OSID=osid-value");
          expect(requestCookie).toContain("__Secure-OSID=secure-osid-value");
          return html(realMyActivityHtml());
        }
        if (urlString === "https://myactivity.google.com/myactivity?product=26&authuser=0&pli=1") {
          return redirect("https://myactivity.google.com/myactivity?product=26&authuser=0&done=1", [
            "OSID=osid-value; Domain=.google.com; Path=/; Secure; HttpOnly",
            "__Secure-OSID=secure-osid-value; Domain=.google.com; Path=/; Secure; HttpOnly",
          ]);
        }
        if (urlString === "https://myactivity.google.com/myactivity?product=26&authuser=0") {
          return redirect("https://accounts.google.com/v3/signin/identifier?continue=https%3A%2F%2Fmyactivity.google.com%2Fmyactivity%3Fproduct%3D26");
        }
        if (urlString.startsWith("https://accounts.google.com/v3/signin/identifier")) {
          expect(requestCookie).toContain("LSID=lsid-value");
          return redirect("https://myactivity.google.com/myactivity?product=26&authuser=0&pli=1", [
            "LSID=lsid-new; Domain=accounts.google.com; Path=/; Secure; HttpOnly",
          ]);
        }
        if (urlString.startsWith("https://myactivity.google.com/_/FootprintsMyactivityUi/data/batchexecute")) {
          expect(method).toBe("POST");
          expect(requestCookie).toContain("OSID=osid-value");
          expect(requestCookie).toContain("__Secure-OSID=secure-osid-value");
          return text(displayItemsResponse());
        }
        throw new Error(`unexpected URL ${urlString}`);
      },
    },
  );

  expect(result.items).toHaveLength(1);
  expect(result.items[0]?.title).toBe("Recent video");
  expect(result.scroll.authUser).toBe(0);
  expect(requests.map((request) => new URL(request.url).hostname)).toEqual([
    "myactivity.google.com",
    "accounts.google.com",
    "myactivity.google.com",
    "myactivity.google.com",
    "myactivity.google.com",
  ]);
});

test("youtube My Activity redirect failures do not expose cookie values", async () => {
  let message = "";
  try {
    await collectYouTubeFromMyActivityHttp(
      {
        cutoffYmd: "20260521",
        maxPages: 1,
        cursor: null,
        cookieBrowser: "chrome",
        cookieProfile: "",
        cookieTimeoutMs: 1_000,
        authUser: 0,
        signal: new AbortController().signal,
      },
      {
        readBrowserCookies: async () => ({
          cookies: [cookie("SID", "sid-secret", "google.com"), cookie("SAPISID", "sapisid-secret", "google.com")],
          warnings: [],
        }),
        fetch: async () =>
          redirect("https://myactivity.google.com/myactivity?product=26", [
            "OSID=osid-secret; Domain=.google.com; Path=/; Secure; HttpOnly",
          ]),
      },
    );
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toContain("redirect loop");
  expect(message).not.toMatch(/sid-secret|sapisid-secret|osid-secret/);
});

function cookie(name: string, value: string, domain: string): Cookie {
  return {
    name,
    value,
    domain,
    path: "/",
    secure: true,
    httpOnly: true,
    source: { browser: "chrome" },
  };
}

function redirect(location: string, setCookies: string[] = []): Response {
  const headers = new Headers({ location });
  for (const setCookie of setCookies) headers.append("set-cookie", setCookie);
  return new Response("", { status: 302, headers });
}

function html(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
}

function text(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/plain" } });
}

function realMyActivityHtml(): string {
  return `<html><script>{"SNlM0e":"at-token","FdrFJe":"fsid-token"}</script><script src="/_/boq_footprintsmyactivityuiserver_20260610"></script></html>`;
}

function displayItemsResponse(): string {
  const micros = Date.parse("2026-05-22T12:00:00.000Z") * 1000;
  const row: unknown[] = [];
  row[4] = micros;
  row[7] = ["YouTube"];
  row[9] = ["Recent video", null, "Watched", "https://youtube.com/watch?v=abc123"];
  row[23] = ["https://i.ytimg.com/vi/abc123/default.jpg", "3:21", 100];
  row[32] = [[null, "Example channel", null, "https://youtube.com/@example"]];
  const payload = JSON.stringify([[row], "cursor-1"]);
  return `${JSON.stringify([["wrb.fr", "y3VFHd", payload, null, null, null, "generic"]])}\n`;
}
