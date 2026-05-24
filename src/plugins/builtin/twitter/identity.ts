import { fingerprint } from "../../../core/ids";
import type { Json } from "../../../core/types";

export interface BirdTweet {
  id?: string | number;
  text?: string;
  createdAt?: string;
  created_at?: string;
  authorId?: string | number;
  author_id?: string | number;
  author?: {
    id?: string | number;
    rest_id?: string | number;
    username?: string;
    screen_name?: string;
    name?: string;
    displayName?: string;
  };
  media?: unknown[];
  quotedTweet?: { id?: string | number };
  quotedStatusId?: string | number;
  inReplyToStatusId?: string | number;
  replyToId?: string | number;
  likeCount?: number;
  like_count?: number;
}

const TWITTER_MIN_TIMESTAMP_MS = Date.parse("2006-03-21T00:00:00.000Z");

export function tweetId(tweet: BirdTweet): string {
  return String(tweet.id || fingerprint(tweet as Json));
}

export function tweetCreatedAt(tweet: BirdTweet): Date | null {
  return parseTwitterTimestamp(tweet.createdAt || tweet.created_at);
}

export function parseTwitterTimestamp(value: unknown): Date | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return null;
  if (parsed.getTime() < TWITTER_MIN_TIMESTAMP_MS) return null;
  return parsed;
}

export function profileId(tweet: BirdTweet): string {
  const author = tweet.author || {};
  const id = tweet.authorId || tweet.author_id || author.id || author.rest_id;
  if (id) return `user:${id}`;
  const handle = author.username || author.screen_name || "unknown";
  return `handle:${String(handle).replace(/^@/, "")}`;
}

export function authorPayload(tweet: BirdTweet) {
  const author = tweet.author || {};
  const handle = String(author.username || author.screen_name || profileId(tweet)).replace(/^@/, "");
  return {
    id: profileId(tweet),
    handle,
    displayName: String(author.name || author.displayName || handle),
    raw: author,
  };
}

export function collectionEventType(collection: string): string {
  if (collection === "bookmarks") return "twitter.bookmarked";
  if (collection === "likes") return "twitter.liked";
  if (collection === "authored") return "twitter.authored";
  return `twitter.${collection}`;
}
