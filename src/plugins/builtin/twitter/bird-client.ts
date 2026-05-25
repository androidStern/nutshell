import { TwitterClient, type TweetData, type TwitterCookies, type TwitterUser } from "@steipete/bird";
import { cookieValue, readBrowserCookies } from "../../../browser/cookies";
import { looksLikeAuthFailure, looksLikeRateLimit } from "./rate-limit";

export interface BirdClientConfig {
  accountUserId: string;
  accountHandle: string;
  cookieBrowser: string;
  cookieProfile: string;
  cookieTimeoutMs: number;
  timeoutMs: number;
}

export interface BirdPage {
  tweets: TweetData[];
  nextCursor: string | null;
}

export interface BirdFollowingPage {
  users: TwitterUser[];
  nextCursor: string | null;
}

const DEFAULT_HTTP_TIMEOUT_MS = 30_000;
const MAX_HTTP_TIMEOUT_MS = 30_000;
const OPERATION_GRACE_MS = 5_000;

export class BirdClient {
  private clientPromise: Promise<TwitterClient> | null = null;
  private currentUserPromise: Promise<{ id: string; username: string; name: string }> | null = null;
  private authoredUserIdPromise: Promise<string> | null = null;
  private activeSignal: AbortSignal | null = null;

  constructor(private readonly cfg: BirdClientConfig) {}

  async check(signal: AbortSignal): Promise<{ ok: boolean; text: string; rateLimited: boolean; authFailed: boolean }> {
    try {
      const user = await this.call("X current user check", signal, async () => {
        const client = await this.client();
        return await client.getCurrentUser();
      });
      if (!user.success || !user.user) {
        const text = user.error ?? "Could not determine current X user";
        return { ok: false, text, rateLimited: looksLikeRateLimit(text), authFailed: looksLikeAuthFailure(text) };
      }
      return { ok: true, text: `authenticated as ${user.user.username}`, rateLimited: false, authFailed: false };
    } catch (error) {
      const text = String(error);
      return { ok: false, text, rateLimited: looksLikeRateLimit(text), authFailed: looksLikeAuthFailure(text) };
    }
  }

  async page(collection: string, cursor: string | null, _pageSize: number, signal: AbortSignal): Promise<BirdPage> {
    const result = await this.call(`X ${collection} page`, signal, async () => {
      const client = await this.client();
      return collection === "authored"
        ? await client.getUserTweetsPaged(await this.authoredUserId(), 20, { maxPages: 1, cursor: cursor ?? undefined, pageDelayMs: 0 })
        : collection === "bookmarks"
          ? await client.getAllBookmarks({ maxPages: 1, cursor: cursor ?? undefined })
          : collection === "likes"
            ? await client.getAllLikes({ maxPages: 1, cursor: cursor ?? undefined })
            : { success: false as const, error: `Unsupported Twitter collection: ${collection}` };
    });
    if (!result.success) throw new Error(result.error || `Twitter ${collection} request failed`);
    return { tweets: result.tweets, nextCursor: result.nextCursor ?? null };
  }

  async following(maxPages: number, pageSize: number, signal: AbortSignal): Promise<BirdFollowingPage> {
    const client = await this.client();
    const current = await this.call("X current user", signal, () => this.currentUser());
    const users: TwitterUser[] = [];
    const seenIds = new Set<string>();
    const effectivePageSize = Math.min(pageSize, 50);
    let nextCursor: string | null = null;
    for (let page = 0; page < maxPages; page += 1) {
      signal.throwIfAborted();
      const result = await this.call("X following page", signal, () => client.getFollowing(current.id, pageSize, nextCursor ?? undefined));
      if (!result.success) throw new Error(result.error || "Twitter following request failed");
      let added = 0;
      for (const user of result.users ?? []) {
        if (seenIds.has(user.id)) continue;
        seenIds.add(user.id);
        users.push(user);
        added += 1;
      }
      if (!result.nextCursor || result.nextCursor === nextCursor || added === 0 || added < effectivePageSize) return { users, nextCursor: null };
      nextCursor = result.nextCursor;
    }
    return { users, nextCursor };
  }

  private async client(): Promise<TwitterClient> {
    this.clientPromise ??= this.buildClient();
    return this.clientPromise;
  }

  private async buildClient(): Promise<TwitterClient> {
    const cookies = await readBrowserCookies({
      url: "https://x.com/",
      origins: ["https://x.com/", "https://twitter.com/"],
      names: ["auth_token", "ct0"],
      browser: this.cfg.cookieBrowser,
      profile: this.cfg.cookieProfile || undefined,
      timeoutMs: this.cfg.cookieTimeoutMs,
    });
    const authToken = cookieValue(cookies.cookies, "auth_token");
    const ct0 = cookieValue(cookies.cookies, "ct0");
    if (!authToken || !ct0) {
      throw new Error(`X auth cookies missing; warnings=${cookies.warnings.join("; ")}`);
    }
    const twitterCookies: TwitterCookies = {
      authToken,
      ct0,
      cookieHeader: `auth_token=${authToken}; ct0=${ct0}`,
      source: `${this.cfg.cookieBrowser}${this.cfg.cookieProfile ? `:${this.cfg.cookieProfile}` : ""}`,
    };
    const client = new TwitterClient({ cookies: twitterCookies, timeoutMs: this.httpTimeoutMs() });
    this.installFetchGuard(client);
    this.installCurrentUserCache(client);
    return client;
  }

  private async call<T>(label: string, signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort(abortReason(signal));
    signal.addEventListener("abort", abort, { once: true });
    const timeoutMs = this.operationTimeoutMs();
    const timeout = setTimeout(() => controller.abort(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    const previousSignal = this.activeSignal;
    this.activeSignal = controller.signal;
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_, reject) => {
          const rejectOnAbort = () => reject(abortReason(controller.signal));
          if (controller.signal.aborted) rejectOnAbort();
          else controller.signal.addEventListener("abort", rejectOnAbort, { once: true });
        }),
      ]);
    } finally {
      this.activeSignal = previousSignal;
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
    }
  }

  private installFetchGuard(client: TwitterClient): void {
    const guarded = client as unknown as {
      fetchWithTimeout?: (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>;
    };
    if (typeof guarded.fetchWithTimeout !== "function") {
      throw new Error("@steipete/bird fetchWithTimeout API changed; refusing to run without request timeout guard");
    }
    guarded.fetchWithTimeout = async (url, init) => {
      const activeSignal = this.activeSignal;
      activeSignal?.throwIfAborted();
      const controller = new AbortController();
      const abort = () => controller.abort(activeSignal ? abortReason(activeSignal) : new Error("aborted"));
      activeSignal?.addEventListener("abort", abort, { once: true });
      const timeoutMs = this.httpTimeoutMs();
      const timeout = setTimeout(() => controller.abort(new Error(`X HTTP request timed out after ${timeoutMs}ms`)), timeoutMs);
      try {
        return await fetch(url, { ...init, signal: controller.signal });
      } catch (error) {
        if (controller.signal.aborted) throw abortReason(controller.signal);
        throw error;
      } finally {
        clearTimeout(timeout);
        activeSignal?.removeEventListener("abort", abort);
      }
    };
  }

  private httpTimeoutMs(): number {
    const configured = Number.isFinite(this.cfg.timeoutMs) && this.cfg.timeoutMs > 0 ? Math.trunc(this.cfg.timeoutMs) : DEFAULT_HTTP_TIMEOUT_MS;
    return Math.max(1_000, Math.min(configured, MAX_HTTP_TIMEOUT_MS));
  }

  private operationTimeoutMs(): number {
    const configured = Number.isFinite(this.cfg.timeoutMs) && this.cfg.timeoutMs > 0 ? Math.trunc(this.cfg.timeoutMs) : DEFAULT_HTTP_TIMEOUT_MS + OPERATION_GRACE_MS;
    return Math.max(1_000, Math.min(configured, this.httpTimeoutMs() + OPERATION_GRACE_MS));
  }

  private installCurrentUserCache(client: TwitterClient): void {
    type CurrentUserResult = Awaited<ReturnType<TwitterClient["getCurrentUser"]>>;
    if (typeof client.getCurrentUser !== "function") {
      throw new Error("@steipete/bird getCurrentUser API changed; refusing to run without current-user auth check");
    }
    const original = client.getCurrentUser.bind(client);
    let cached: CurrentUserResult | null = null;
    client.getCurrentUser = async () => {
      if (cached) return cached;
      const result = await original();
      if (result.success && result.user) {
        cached = result;
        return result;
      }
      return result;
    };
  }

  private async currentUser(): Promise<{ id: string; username: string; name: string }> {
    this.currentUserPromise ??= (async () => {
      const user = await (await this.client()).getCurrentUser();
      if (!user.success || !user.user) throw new Error(user.error || "Could not determine current X user");
      return user.user;
    })();
    return this.currentUserPromise;
  }

  private async authoredUserId(): Promise<string> {
    this.authoredUserIdPromise ??= (async () => {
      const handle = this.cfg.accountHandle.replace(/^@/, "");
      if (!handle) return (await this.currentUser()).id;
      const lookup = await (await this.client()).getUserIdByUsername(handle);
      if (!lookup.success || !lookup.userId) throw new Error(lookup.error || `Could not resolve X handle ${handle}`);
      return lookup.userId;
    })();
    return this.authoredUserIdPromise;
  }
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  if (signal.reason) return new Error(String(signal.reason));
  return new Error("aborted");
}
