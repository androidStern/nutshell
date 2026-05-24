import { fingerprint } from "../../../core/ids";
import type { Json } from "../../../core/types";

export interface PodcastEpisodeRow {
  episode_pk?: number | string | null;
  podcast_title?: string | null;
  podcast_author?: string | null;
  podcast_feed_url?: string | null;
  podcast_artwork_url?: string | null;
  podcast_logo_image_url?: string | null;
  podcast_primary_color?: string | null;
  episode_title?: string | null;
  episode_author?: string | null;
  episode_artwork_url?: string | null;
  artwork_url?: string | null;
  audio_url?: string | null;
  webpage_url?: string | null;
  guid?: string | null;
  play_count?: number | null;
  play_state?: number | null;
  has_been_played?: number | null;
  playhead_seconds?: number | null;
  duration_seconds?: number | null;
  last_played_at?: string | null;
  published_at?: string | null;
  completion_ratio?: number | null;
}

export function podcastEpisodeId(row: PodcastEpisodeRow): string {
  if (row.guid) return `guid:${row.guid}`;
  if (row.audio_url) return `audio:${row.audio_url}`;
  if (row.podcast_feed_url && row.episode_title) return `feed-title:${row.podcast_feed_url}:${row.episode_title}`;
  return `local:${row.episode_pk ?? fingerprint(row as Json)}`;
}

export function podcastListenId(row: PodcastEpisodeRow): string {
  return `${podcastEpisodeId(row)}:${row.last_played_at || "unknown"}`;
}
