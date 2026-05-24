import type { Json, JsonObject } from "../../../core/types";
import type { EnrichedTweet, EnrichedTweetSummary, TweetEnrichmentFetcher, TweetFetchResult } from "./enrichment";

export class SyndicationTweetFetcher implements TweetEnrichmentFetcher {
  async fetch(tweetId: string, signal: AbortSignal): Promise<TweetFetchResult> {
    const url = syndicationUrl(tweetId);
    let response: Response;
    try {
      response = await fetch(url, { signal, headers: { accept: "application/json" } });
    } catch (error) {
      return { status: "temporary_failure", tweet: null, errorCode: "network_error", errorMessage: String(error) };
    }

    if (response.status === 429) {
      return { status: "rate_limited", tweet: null, errorCode: "rate_limited", errorMessage: "X syndication endpoint rate limited the request" };
    }
    if (response.status === 400 || response.status === 403 || response.status === 404) {
      return { status: "unavailable", tweet: null, errorCode: `http_${response.status}`, errorMessage: "Tweet is unavailable, private, deleted, or not embeddable" };
    }
    if (!response.ok) {
      return { status: "temporary_failure", tweet: null, errorCode: `http_${response.status}`, errorMessage: await safeResponseText(response) };
    }

    let raw: JsonObject;
    try {
      const parsed = (await response.json()) as Json;
      raw = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
      return { status: "temporary_failure", tweet: null, errorCode: "invalid_json", errorMessage: String(error) };
    }

    if (!stringAt(raw, "id_str") || !objectAt(raw, "user").name) {
      return { status: "unavailable", tweet: null, errorCode: "empty_payload", errorMessage: "X syndication returned no tweet payload" };
    }

    return { status: "enriched", tweet: normalizeSyndicationTweet(raw), errorCode: null, errorMessage: null };
  }
}

export function normalizeSyndicationTweet(raw: JsonObject): EnrichedTweet {
  const tweetId = stringAt(raw, "id_str");
  const author = objectAt(raw, "user");
  const quoted = objectAt(raw, "quoted_tweet");
  const parent = objectAt(raw, "parent");
  const quotedSummary = Object.keys(quoted).length ? summaryFromTweet(quoted) : null;
  const parentSummary = Object.keys(parent).length ? summaryFromTweet(parent) : null;
  const username = stringAt(author, "screen_name");
  return {
    tweetId,
    canonicalUrl: username ? `https://x.com/${username}/status/${tweetId}` : `https://x.com/i/web/status/${tweetId}`,
    text: htmlDecode(stringAt(raw, "text")) || null,
    createdAt: parseDate(stringAt(raw, "created_at")),
    author: {
      id: stringAt(author, "id_str") || null,
      name: htmlDecode(stringAt(author, "name")) || null,
      username: username || null,
      avatarUrl: stringAt(author, "profile_image_url_https") || null,
      verified: booleanAt(author, "verified"),
      blueVerified: booleanAt(author, "is_blue_verified"),
    },
    media: mediaFromTweet(raw),
    quotedTweetId: quotedSummary?.tweetId ?? null,
    quotedTweet: quotedSummary,
    parentTweetId: (parentSummary?.tweetId ?? stringAt(raw, "in_reply_to_status_id_str")) || null,
    parentTweet: parentSummary,
    raw,
  };
}

function summaryFromTweet(raw: JsonObject): EnrichedTweetSummary {
  const tweetId = stringAt(raw, "id_str");
  const author = objectAt(raw, "user");
  const username = stringAt(author, "screen_name");
  return {
    tweetId,
    canonicalUrl: username ? `https://x.com/${username}/status/${tweetId}` : `https://x.com/i/web/status/${tweetId}`,
    text: htmlDecode(stringAt(raw, "text")) || null,
    authorName: htmlDecode(stringAt(author, "name")) || null,
    authorUsername: username || null,
    authorAvatarUrl: stringAt(author, "profile_image_url_https") || null,
    mediaPreviewUrl: mediaFromTweet(raw)[0]?.previewUrl ?? null,
  };
}

function mediaFromTweet(raw: JsonObject): EnrichedTweet["media"] {
  const media: EnrichedTweet["media"] = arrayAt(raw, "photos").map((photo) => ({
    type: "photo" as const,
    url: stringAt(photo, "url") || null,
    previewUrl: stringAt(photo, "url") || null,
    width: numberAt(photo, "width"),
    height: numberAt(photo, "height"),
  }));
  const video = objectAt(raw, "video");
  const poster = stringAt(video, "poster");
  if (poster) {
    media.push({
      type: "video",
      url: firstVideoVariant(video),
      previewUrl: poster,
      width: null,
      height: null,
    });
  }
  return media;
}

function firstVideoVariant(video: JsonObject): string | null {
  for (const item of arrayAt(video, "variants")) {
    const url = stringAt(item, "src") || stringAt(item, "url");
    if (url) return url;
  }
  return null;
}

function syndicationUrl(tweetId: string): string {
  const url = new URL("https://cdn.syndication.twimg.com/tweet-result");
  url.searchParams.set("id", tweetId);
  url.searchParams.set("lang", "en");
  url.searchParams.set("features", syndicationFeatures());
  url.searchParams.set("token", syndicationToken(tweetId));
  return url.toString();
}

function syndicationToken(tweetId: string): string {
  return (Number(tweetId) / 1e15 * Math.PI).toString(36).replace(/(0+|\.)/g, "");
}

function syndicationFeatures(): string {
  return [
    "tfw_timeline_list:",
    "tfw_follower_count_sunset:true",
    "tfw_tweet_edit_backend:on",
    "tfw_refsrc_session:on",
    "tfw_fosnr_soft_interventions_enabled:on",
    "tfw_show_birdwatch_pivots_enabled:on",
    "tfw_show_business_verified_badge:on",
    "tfw_duplicate_scribes_to_settings:on",
    "tfw_use_profile_image_shape_enabled:on",
    "tfw_show_blue_verified_badge:on",
    "tfw_legacy_timeline_sunset:true",
    "tfw_show_gov_verified_badge:on",
    "tfw_show_business_affiliate_badge:on",
    "tfw_tweet_edit_frontend:on",
  ].join(";");
}

async function safeResponseText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 300);
  } catch {
    return response.statusText;
  }
}

function htmlDecode(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function parseDate(value: string): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date;
}

function objectAt(value: Json, key: string): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const child = value[key];
    if (child && typeof child === "object" && !Array.isArray(child)) return child;
  }
  return {};
}

function arrayAt(value: JsonObject, key: string): JsonObject[] {
  const child = value[key];
  return Array.isArray(child) ? child.filter((item): item is JsonObject => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
}

function stringAt(value: JsonObject, key: string): string {
  const child = value[key];
  return typeof child === "string" ? child : "";
}

function numberAt(value: JsonObject, key: string): number | null {
  const child = value[key];
  return typeof child === "number" && Number.isFinite(child) ? child : null;
}

function booleanAt(value: JsonObject, key: string): boolean | null {
  const child = value[key];
  return typeof child === "boolean" ? child : null;
}
