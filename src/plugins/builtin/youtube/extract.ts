import type { YouTubeActivityItem } from "./identity";

export function extractYouTubeItemsFromSimpleHtml(html: string): YouTubeActivityItem[] {
  const items: YouTubeActivityItem[] = [];
  const cardPattern = /<[^>]+data-date=["'](?<date>\d{8})["'][^>]*>(?<body>[\s\S]*?)(?=<[^>]+data-date=["']\d{8}["']|$)/gi;
  for (const match of html.matchAll(cardPattern)) {
    const groups = match.groups;
    if (!groups) continue;
    const body = stripTags(groups.body ?? "");
    const linkMatch = (groups.body ?? "").match(/href=["'](?<href>[^"']+)["'][^>]*>(?<label>[\s\S]*?)<\/a>/i);
    items.push({
      source: "youtube_myactivity",
      date_key: groups.date,
      verb: body.toLowerCase().includes("searched") ? "Searched" : "Watched",
      title: stripTags(linkMatch?.groups?.label ?? body).slice(0, 300),
      title_url: linkMatch?.groups?.href ?? null,
      raw_text: body,
    });
  }
  return items;
}

function stripTags(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

