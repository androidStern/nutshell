import { expect, test } from "bun:test";
import { fingerprint } from "../src/core/ids";
import { youtubeFingerprint, youtubeSourceId } from "../src/plugins/builtin/youtube/identity";
import { podcastEpisodeId, podcastListenId } from "../src/plugins/builtin/podcasts/identity";
import { parseTwitterTimestamp, tweetCreatedAt } from "../src/plugins/builtin/twitter/identity";

test("stable fingerprints ignore object key order", () => {
  expect(fingerprint({ b: 2, a: 1 })).toBe(fingerprint({ a: 1, b: 2 }));
});

test("youtube fingerprint is stable for identical activity", () => {
  const item = {
    date_key: "20260521",
    verb: "Watched",
    title: "A video",
    title_url: "https://youtube.com/watch?v=1",
    channel: "Channel",
    raw_text: "Watched A video",
  };
  expect(youtubeFingerprint(item)).toBe(youtubeFingerprint({ ...item }));
});

test("youtube event identity keeps repeated URL events distinct by activity detail", () => {
  const base = {
    date_key: "20260521",
    verb: "Watched",
    title: "A video",
    title_url: "https://youtube.com/watch?v=1",
    channel: "Channel",
  };
  expect(youtubeSourceId({ ...base, detail_text: "7:15 PM • Details" })).not.toBe(
    youtubeSourceId({ ...base, detail_text: "9:30 PM • Details" }),
  );
});

test("podcast identity prefers guid and includes listen time", () => {
  const row = { guid: "episode-guid", last_played_at: "2026-05-21T12:00:00Z" };
  expect(podcastEpisodeId(row)).toBe("guid:episode-guid");
  expect(podcastListenId(row)).toBe("guid:episode-guid:2026-05-21T12:00:00Z");
});

test("twitter timestamps reject Unix epoch placeholders", () => {
  expect(parseTwitterTimestamp("1970-01-01T00:00:00.000Z")).toBeNull();
  expect(tweetCreatedAt({ id: "1", createdAt: "1970-01-01T00:00:00.000Z" })).toBeNull();
  expect(parseTwitterTimestamp("2026-05-22T12:00:00.000Z")?.toISOString()).toBe("2026-05-22T12:00:00.000Z");
});
