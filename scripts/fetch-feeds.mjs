// Fetches public RSS feeds (ZEIT, KSTA) and writes articles.json.
// Zero dependencies; requires Node 18+ (global fetch).

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mapPool, probeArchiveIs } from "./archive-probe.mjs";
import { probeReadableProviders } from "./read-providers.mjs";

/** Prefer archive.is; otherwise try byebyepaywall mirrors. */
async function resolvePaywallRead(article) {
  const arch = await probeArchiveIs(article.url);
  if (arch.ok === true) return arch;
  const mirrors = await probeReadableProviders(article.url, article.title);
  if (mirrors.ok === true) return mirrors;
  return { ok: false };
}

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
  // Full index scan: all KSTA+ (paid) items — only ~dozen in the whole feed.
  {
    source: "ksta",
    section: "KSTA+",
    url: "https://feed.ksta.de/feed/rss/index.rss",
    kstaPaidScan: true,
  },
];

const BYPASS_PREFIX = process.env.BYPASS_PREFIX ?? "https://archive.is/newest/";
const SAVE_PREFIX = process.env.SAVE_PREFIX ?? "https://archive.is/?run=1&url=";

const RETENTION_DAYS = Number(process.env.RETENTION_DAYS ?? 14);
const MAX_ARTICLES = 400;
const MAX_ITEMS_PER_FEED = 35;
// Drop paywalled items with no archive.is snapshot when enabled (on in CI).
const ARCHIVE_VERIFY = process.env.ARCHIVE_VERIFY === "1";
// When verify is off, optionally probe in the background to improve readUrl (slow).
const ARCHIVE_ENRICH = process.env.ARCHIVE_ENRICH === "1";
const ARCHIVE_PROBE_CONCURRENCY = Number(process.env.ARCHIVE_PROBE_CONCURRENCY ?? 3);
const ARCHIVE_PROBE_DELAY_MS = Number(process.env.ARCHIVE_PROBE_DELAY_MS ?? 800);

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

function itemImage(item) {
  const enc = item.match(/<enclosure\b[^>]*\burl="([^"]+)"[^>]*\btype="image[^"]*"/i);
  if (enc) return decodeEntities(enc[1]);
  const enc2 = item.match(/<enclosure\b[^>]*\btype="image[^"]*"[^>]*\burl="([^"]+)"/i);
  if (enc2) return decodeEntities(enc2[1]);
  const media = item.match(/<media:content\b[^>]*\burl="([^"]+)"/i);
  if (media) return decodeEntities(media[1]);
  const encoded = tag(item, "content:encoded");
  const img = encoded.match(/<img[^>]+src="([^"]+)"/i);
  if (img) return decodeEntities(img[1]);
  return null;
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

function parseItems(xml, feed) {
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);
  if (feed.kstaPaidScan) {
    return items.filter((item) => contentRestriction(item) === "paid");
  }
  return items.slice(0, MAX_ITEMS_PER_FEED);
}

function cleanUrl(link) {
  const u = new URL(link);
  return u.origin + u.pathname;
}

function isZeitFree(url) {
  return /^\/(news|video)\//.test(new URL(url).pathname);
}

function inferSource(url, hint) {
  if (hint && SOURCES[hint]) return hint;
  try {
    if (new URL(url).hostname.includes("ksta.de")) return "ksta";
  } catch {
    /* ignore */
  }
  return "zeit";
}

/** Migrate older articles.json rows (missing source / url-only id). */
function normalizeArticle(a) {
  const url = a.url;
  if (!url) return null;
  const source = inferSource(url, a.source);
  return {
    ...a,
    source,
    id: `${source}:${url}`,
  };
}

function withLinks(a) {
  const free = isFreeArticle(a);
  const archiveUrl =
    a.snapshotUrl && /^https:\/\/archive\.[a-z]+\//i.test(a.snapshotUrl)
      ? a.snapshotUrl
      : BYPASS_PREFIX + a.url;
  return {
    ...a,
    free,
    archiveUrl,
    saveUrl: SAVE_PREFIX + encodeURIComponent(a.url),
    readUrl: free ? a.url : archiveUrl,
  };
}

function isFreeArticle(a) {
  if (a.source === "ksta") return a.access === "free";
  if (a.source === "zeit") return isZeitFree(a.url);
  return false;
}

function stripDerived(a) {
  const copy = { ...a };
  delete copy.free;
  delete copy.archiveUrl;
  delete copy.saveUrl;
  delete copy.readUrl;
  delete copy.readerUrl;
  return copy;
}

function sortByTime(articles) {
  return [...articles].sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""));
}

async function applyArchiveChecks(articles) {
  const bases = articles.map((a) => stripDerived(a));
  if (!ARCHIVE_VERIFY && !ARCHIVE_ENRICH) {
    return sortByTime(bases.map((a) => withLinks(a)));
  }

  const paid = bases.filter((b) => !isFreeArticle(b));
  const results = await mapPool(
    paid,
    ARCHIVE_PROBE_CONCURRENCY,
    ARCHIVE_PROBE_DELAY_MS,
    (article) => resolvePaywallRead(article),
  );

  let verified = 0;
  let dropped = 0;
  let ri = 0;
  const out = bases
    .map((base) => {
      if (isFreeArticle(base)) return withLinks(base);
      const hit = results[ri++];
      if (hit.ok === true) {
        verified++;
        return withLinks({
          ...base,
          archived: true,
          archiveVia: hit.via,
          snapshotUrl: hit.snapshotUrl,
        });
      }
      if (ARCHIVE_VERIFY) {
        dropped++;
        return null;
      }
      return withLinks(base);
    })
    .filter(Boolean);

  if (ARCHIVE_VERIFY) {
    console.log(
      `Paywall verify: ${verified} with mirror, ${dropped} hidden (no working mirror), ${out.filter((a) => a.free).length} free`,
    );
  } else if (ARCHIVE_ENRICH) {
    console.log(`archive.is enrich: ${verified} snapshots for ${paid.length} paywalled items`);
  }
  return sortByTime(out);
}

async function fetchFeed(feed) {
  const res = await fetch(feed.url, {
    headers: { "User-Agent": "news-scraper (+https://github.com/oisinod/news-scraper)" },
  });
  if (!res.ok) throw new Error(`${feed.url} -> HTTP ${res.status}`);
  const xml = await res.text();

  return parseItems(xml, feed).flatMap((item) => {
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
        image: itemImage(item),
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
    const base = normalizeArticle(raw);
    if (!base) continue;
    if (base.publishedAt && new Date(base.publishedAt).getTime() < cutoff) continue;
    byId.set(base.id, stripDerived(base));
  }

  const merged = [...byId.values()]
    .sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""))
    .slice(0, MAX_ARTICLES);

  const articles = await applyArchiveChecks(merged);

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