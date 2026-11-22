import { mapPool } from "./archive-probe.mjs";

/** @typedef {{ ok: true; snapshotUrl: string; via: string }} ReadHit */
/** @typedef {{ ok: false }} ReadMiss */

const TIMEOUT_MS = Number(process.env.READ_PROBE_TIMEOUT_MS ?? 22_000);
const MAX_BYTES = Number(process.env.READ_PROBE_MAX_BYTES ?? 600_000);
const UA =
  process.env.ARCHIVE_PROBE_UA ??
  "Mozilla/5.0 (compatible; news-scraper/1.0; +https://github.com/oisinod/news-scraper)";

const ARCHIVE_HOST = process.env.ARCHIVE_HOST ?? "archive.is";

/** Same order as byebyepaywall.com */
const PROVIDERS = [
  { id: "archive.is", kind: "timemap" },
  { id: "smry.ai", build: (url) => `https://smry.ai/${url}` },
  { id: "removepaywall.com", build: (url) => `https://www.removepaywall.com/${url}` },
  { id: "1ft.io", build: (url) => `https://1ft.io/${url}` },
  { id: "removepaywalls.com", build: (url) => `https://removepaywalls.com/${url}` },
  { id: "archive.org", kind: "wayback" },
];

const PAYWALL_MARKERS = [
  /nur für abonnenten/i,
  /jetzt weiterlesen mit z\+/i,
  /z\+ abonnieren/i,
  /schon abonniert/i,
  /remove paywall/i,
  /get access to articles/i,
  /paywall remover/i,
];

function titleSignals(title) {
  return [...new Set(title.toLowerCase().match(/\p{L}{4,}/gu) ?? [])].slice(0, 10);
}

/** Heuristic: enough HTML and title terms present, no obvious paywall landing page. */
export function looksLikeArticle(html, title) {
  if (!html || html.length < 3500) return false;
  const sample = html.slice(0, MAX_BYTES).toLowerCase();
  if (PAYWALL_MARKERS.some((re) => re.test(sample))) return false;
  const words = titleSignals(title);
  if (!words.length) return html.length > 12_000;
  const hits = words.filter((w) => sample.includes(w));
  return hits.length >= Math.min(2, words.length);
}

async function readHtmlSample(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
    redirect: "follow",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok || !res.body) return null;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let out = "";
  while (out.length < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  try {
    await reader.cancel();
  } catch {
    /* ignore */
  }
  return out;
}

function parseTimemap(body) {
  const mementos = [];
  for (const line of body.split("\n")) {
    const m = line.match(/^<([^>]+)>;\s*rel="memento"/i);
    if (m) mementos.push(m[1]);
  }
  return mementos.at(-1) ?? null;
}

async function timemapUrl(articleUrl) {
  try {
    const res = await fetch(`https://${ARCHIVE_HOST}/timemap/${articleUrl}`, {
      headers: { "User-Agent": UA, Accept: "text/link-format" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 404) return null;
    if (!res.ok) return null;
    return parseTimemap(await res.text());
  } catch {
    return null;
  }
}

async function waybackUrl(articleUrl) {
  try {
    const api = `https://archive.org/wayback/available?url=${encodeURIComponent(articleUrl)}`;
    const res = await fetch(api, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.archived_snapshots?.closest?.available ? data.archived_snapshots.closest.url : null;
  } catch {
    return null;
  }
}

async function providerCandidates(provider, articleUrl) {
  if (provider.kind === "timemap") {
    const u = await timemapUrl(articleUrl);
    return u ? [u] : [];
  }
  if (provider.kind === "wayback") {
    const u = await waybackUrl(articleUrl);
    return u ? [u] : [];
  }
  return [provider.build(articleUrl)];
}

/** Try providers in order until HTML looks like the article (metadata only; body not stored). */
export async function probeReadableProviders(articleUrl, title) {
  for (const provider of PROVIDERS) {
    const candidates = await providerCandidates(provider, articleUrl);
    for (const candidateUrl of candidates) {
      const html = await readHtmlSample(candidateUrl);
      if (html && looksLikeArticle(html, title)) {
        return { ok: true, snapshotUrl: candidateUrl, via: provider.id };
      }
    }
  }
  return { ok: false };
}

export { mapPool };