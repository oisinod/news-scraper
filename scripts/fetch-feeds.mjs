// Fetches public zeit.de RSS feeds and writes articles.json.
// Zero dependencies; requires Node 18+ (global fetch).
//
// Only metadata (title, summary, link, date, section) is stored.
// Article content is never fetched or stored.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = join(ROOT, "articles.json");

const FEEDS = [
  { name: "Alle", url: "https://newsfeed.zeit.de/index" },
  { name: "Politik", url: "https://newsfeed.zeit.de/politik/index" },
  { name: "Wirtschaft", url: "https://newsfeed.zeit.de/wirtschaft/index" },
  { name: "Gesellschaft", url: "https://newsfeed.zeit.de/gesellschaft/index" },
  { name: "Digital", url: "https://newsfeed.zeit.de/digital/index" },
  { name: "Entdecken", url: "https://newsfeed.zeit.de/entdecken/index" },
  { name: "Sport", url: "https://newsfeed.zeit.de/sport/index" },
];

// byebyepaywall.com is a launcher for third-party services and has no deep-link
// scheme of its own, so the prefix of the chosen service is prepended to the URL.
// Override via env var BYPASS_PREFIX.
const BYPASS_PREFIX = process.env.BYPASS_PREFIX ?? "https://archive.is/newest/";
// Asks the archive service to snapshot a URL that nobody has archived yet.
const SAVE_PREFIX = process.env.SAVE_PREFIX ?? "https://archive.is/?run=1&url=";

// zeit.de has no free/paywalled flag in the feed and blocks scripted page requests,
// so detect by URL: agency wire reports (/news/) and videos are always free.
const isFree = (url) => /^\/(news|video)\//.test(new URL(url).pathname);

// Derived links; recomputed on every run so config changes apply to retained items.
const withLinks = (a) => {
  const free = isFree(a.url);
  const archiveUrl = BYPASS_PREFIX + a.url;
  return {
    ...a,
    free,
    archiveUrl,
    saveUrl: SAVE_PREFIX + encodeURIComponent(a.url),
    readUrl: free ? a.url : archiveUrl, // primary link for the headline
  };
};

const RETENTION_DAYS = 7;
const MAX_ARTICLES = 300;

const decodeEntities = (s) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  if (!m) return "";
  const raw = m[1].trim();
  const cdata = raw.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  return (cdata ? cdata[1] : decodeEntities(raw)).trim();
}

function parseItems(xml) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);
}

// Strip query/hash so the bypass service gets a clean canonical URL.
function cleanUrl(link) {
  const u = new URL(link);
  return u.origin + u.pathname;
}

async function fetchFeed(feed) {
  const res = await fetch(feed.url, {
    headers: { "User-Agent": "news-scraper (+https://github.com/oisinod/news-scraper)" },
  });
  if (!res.ok) throw new Error(`${feed.url} -> HTTP ${res.status}`);
  const xml = await res.text();

  return parseItems(xml).flatMap((item) => {
    const title = tag(item, "title");
    const link = tag(item, "link");
    if (!title || !link) return [];
    const url = cleanUrl(link);
    const date = new Date(tag(item, "pubDate"));
    return [
      {
        id: url,
        title,
        summary: tag(item, "description"),
        section: tag(item, "category") || feed.name,
        publishedAt: isNaN(date) ? null : date.toISOString(),
        url,
      },
    ];
  });
}

async function loadPrevious() {
  try {
    return JSON.parse(await readFile(OUTPUT, "utf8")).articles ?? [];
  } catch {
    return [];
  }
}

async function main() {
  const results = await Promise.allSettled(FEEDS.map(fetchFeed));
  const fresh = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") fresh.push(...r.value);
    else console.warn(`Feed "${FEEDS[i].name}" failed:`, r.reason.message);
  });

  // Fail loudly if everything failed so the workflow doesn't commit an empty file.
  if (fresh.length === 0) throw new Error("No articles fetched from any feed");

  // Merge with previous run (fresh wins), drop old items, dedupe by URL.
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const byId = new Map();
  for (const a of [...(await loadPrevious()), ...fresh]) {
    if (a.publishedAt && new Date(a.publishedAt).getTime() < cutoff) continue;
    byId.set(a.id, withLinks(a));
  }

  const articles = [...byId.values()]
    .sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""))
    .slice(0, MAX_ARTICLES);

  await writeFile(
    OUTPUT,
    JSON.stringify({ updatedAt: new Date().toISOString(), articles }, null, 2) + "\n",
  );
  console.log(`Wrote ${articles.length} articles to articles.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
