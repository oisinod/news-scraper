// Fetches public RSS feeds (ZEIT, KSTA) and writes articles.json.
// Zero dependencies; requires Node 18+ (global fetch).

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = join(ROOT, "articles.json");

const SOURCES = {
  zeit: {
    name: "DIE ZEIT",
    shortName: "ZEIT",
    logo: "assets/zeit.svg",
    home: "https://www.zeit.de/",
  },
  ksta: {
    name: "Kölner Stadt-Anzeiger",
    shortName: "KSTA",
    logo: "assets/ksta.svg",
    home: "https://www.ksta.de/",
  },
};

const FEEDS = [
  { source: "zeit", section: "News", url: "https://newsfeed.zeit.de/index" },
  { source: "zeit", section: "Politik", url: "https://newsfeed.zeit.de/politik/index" },
  { source: "zeit", section: "Wirtschaft", url: "https://newsfeed.zeit.de/wirtschaft/index" },
  { source: "zeit", section: "Gesellschaft", url: "https://newsfeed.zeit.de/gesellschaft/index" },
  { source: "zeit", section: "Digital", url: "https://newsfeed.zeit.de/digital/index" },
  { source: "zeit", section: "Entdecken", url: "https://newsfeed.zeit.de/entdecken/index" },
  { source: "zeit", section: "Sport", url: "https://newsfeed.zeit.de/sport/index" },
  { source: "ksta", section: "Panorama", url: "https://feed.ksta.de/feed/rss/panorama/index.rss" },
  { source: "ksta", section: "Politik", url: "https://feed.ksta.de/feed/rss/politik/index.rss" },
  { source: "ksta", section: "Wirtschaft", url: "https://feed.ksta.de/feed/rss/wirtschaft/index.rss" },
  { source: "ksta", section: "Sport", url: "https://feed.ksta.de/feed/rss/sport/index.rss" },
  { source: "ksta", section: "Kultur", url: "https://feed.ksta.de/feed/rss/kultur-medien/index.rss" },
  { source: "ksta", section: "Köln", url: "https://feed.ksta.de/feed/rss/koeln/koelner-innenstadt/index.rss" },
  { source: "ksta", section: "Region", url: "https://feed.ksta.de/feed/rss/region/rhein-erft/index.rss" },
];

const BYPASS_PREFIX = process.env.BYPASS_PREFIX ?? "https://archive.is/newest/";
const SAVE_PREFIX = process.env.SAVE_PREFIX ?? "https://archive.is/?run=1&url=";

const RETENTION_DAYS = 7;
const MAX_ARTICLES = 400;
const MAX_ITEMS_PER_FEED = 35;

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

function contentRestriction(item) {
  const m = item.match(
    /<category domain="https:\/\/www\.dumont\.de\/content-restriction">([^<]*)<\/category>/,
  );
  return m ? m[1].trim() : null;
}

function topicSection(item, fallback) {
  for (const m of item.matchAll(/<category(?:\s[^>]*)?>([^<]*)<\/category>/g)) {
    const full = m[0];
    if (full.includes("content-restriction") || full.includes("feedtype")) continue;
    const t = m[1].trim();
    if (t) return t;
  }
  return fallback;
}

function parseItems(xml) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]).slice(0, MAX_ITEMS_PER_FEED);
}

function cleanUrl(link) {
  const u = new URL(link);
  return u.origin + u.pathname;
}

function isZeitFree(url) {
  return /^\/(news|video)\//.test(new URL(url).pathname);
}

function withLinks(a) {
  const free =
    a.source === "ksta" ? a.access === "free" : a.source === "zeit" ? isZeitFree(a.url) : false;
  const archiveUrl = BYPASS_PREFIX + a.url;
  return {
    ...a,
    free,
    archiveUrl,
    saveUrl: SAVE_PREFIX + encodeURIComponent(a.url),
    readUrl: free ? a.url : archiveUrl,
  };
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
    const pub = tag(item, "dcterms:modified") || tag(item, "pubDate");
    const date = new Date(pub);
    const section = topicSection(item, feed.section);
    const access = feed.source === "ksta" ? contentRestriction(item) : null;

    return [
      {
        id: `${feed.source}:${url}`,
        source: feed.source,
        title,
        summary: tag(item, "description"),
        section,
        publishedAt: isNaN(date) ? null : date.toISOString(),
        url,
        access,
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
    else console.warn(`Feed "${FEEDS[i].source}/${FEEDS[i].section}" failed:`, r.reason.message);
  });

  const gotZeit = fresh.some((a) => a.source === "zeit");
  const gotKsta = fresh.some((a) => a.source === "ksta");
  if (!gotZeit && !gotKsta) throw new Error("No articles fetched from any feed");

  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const byId = new Map();
  for (const raw of [...(await loadPrevious()), ...fresh]) {
    if (raw.publishedAt && new Date(raw.publishedAt).getTime() < cutoff) continue;
    const a = { ...raw };
    delete a.free;
    delete a.archiveUrl;
    delete a.saveUrl;
    delete a.readUrl;
    byId.set(a.id, withLinks(a));
  }

  const articles = [...byId.values()]
    .sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""))
    .slice(0, MAX_ARTICLES);

  await writeFile(
    OUTPUT,
    JSON.stringify({ updatedAt: new Date().toISOString(), sources: SOURCES, articles }, null, 2) + "\n",
  );
  const counts = Object.fromEntries(
    ["zeit", "ksta"].map((s) => [s, articles.filter((a) => a.source === s).length]),
  );
  console.log(`Wrote ${articles.length} articles (ZEIT ${counts.zeit}, KSTA ${counts.ksta})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});