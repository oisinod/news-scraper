/** @typedef {{ ok: true; snapshotUrl: string; via: "archive.is" | "wayback" }} ArchiveHit */
/** @typedef {{ ok: false }} ArchiveMiss */
/** @typedef {{ ok: null; reason: string }} ArchiveUnknown */

const ARCHIVE_HOST = process.env.ARCHIVE_HOST ?? "archive.is";
const TIMEOUT_MS = Number(process.env.ARCHIVE_PROBE_TIMEOUT_MS ?? 25_000);
const WAYBACK_FALLBACK = process.env.ARCHIVE_FALLBACK_WAYBACK !== "0";

const UA =
  process.env.ARCHIVE_PROBE_UA ??
  "Mozilla/5.0 (compatible; news-scraper/1.0; +https://github.com/oisinod/news-scraper)";

function parseTimemap(body) {
  const mementos = [];
  for (const line of body.split("\n")) {
    const m = line.match(/^<([^>]+)>;\s*rel="memento"/i);
    if (m) mementos.push(m[1]);
  }
  return mementos.at(-1) ?? null;
}

/** @returns {Promise<ArchiveHit | ArchiveMiss | ArchiveUnknown>} */
export async function probeArchiveIs(articleUrl) {
  const timemapUrl = `https://${ARCHIVE_HOST}/timemap/${articleUrl}`;
  try {
    const res = await fetch(timemapUrl, {
      headers: { "User-Agent": UA, Accept: "text/link-format" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "follow",
    });
    if (res.status === 404) return { ok: false };
    if (!res.ok) return { ok: null, reason: `timemap ${res.status}` };
    const last = parseTimemap(await res.text());
    if (!last) return { ok: false };
    return { ok: true, snapshotUrl: last, via: "archive.is" };
  } catch (err) {
    return { ok: null, reason: err instanceof Error ? err.message : "timemap error" };
  }
}

/** @returns {Promise<ArchiveHit | ArchiveMiss | ArchiveUnknown>} */
async function probeWayback(articleUrl) {
  try {
    const api = `https://archive.org/wayback/available?url=${encodeURIComponent(articleUrl)}`;
    const res = await fetch(api, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { ok: null, reason: `wayback ${res.status}` };
    const data = await res.json();
    const c = data?.archived_snapshots?.closest;
    if (c?.available && c.url) {
      return { ok: true, snapshotUrl: c.url, via: "wayback" };
    }
    return { ok: false };
  } catch (err) {
    return { ok: null, reason: err instanceof Error ? err.message : "wayback error" };
  }
}

/** @returns {Promise<ArchiveHit | ArchiveMiss | ArchiveUnknown>} */
export async function probeReadableArchive(articleUrl, { skipArchiveIs = false } = {}) {
  if (!skipArchiveIs) {
    const arch = await probeArchiveIs(articleUrl);
    if (arch.ok === true || arch.ok === false) return arch;
    if (!WAYBACK_FALLBACK) return arch;
    console.warn(`archive.is unreachable for ${articleUrl}: ${arch.reason}`);
  }
  return probeWayback(articleUrl);
}

/** Run async tasks with limited concurrency. */
export async function mapPool(items, limit, delayMs, fn) {
  const out = [];
  let i = 0;

  async function worker() {
    while (i < items.length) {
      const idx = i++;
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      out[idx] = await fn(items[idx], idx);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}