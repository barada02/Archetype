// Qloo REST client: GET only, X-Api-Key header, arrays comma-joined, a small
// concurrency limit (the API allows 10 requests per second), retry on 429, and
// a memory + disk cache so repeated demo briefs cost no quota.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sleep } from "./util.mjs";

export function buildUrl(baseUrl, path, params = {}) {
  const url = new URL(baseUrl + path);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "" || (Array.isArray(value) && !value.length)) continue;
    url.searchParams.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  return url;
}

export function createQloo({ apiKey, baseUrl, cacheDir, ttlMs = 24 * 3600 * 1000, concurrency = 3, fetchImpl = fetch, timeoutMs = 60000 }) {
  const memory = new Map();
  let active = 0;
  const waiting = [];
  const acquire = () =>
    active < concurrency ? (active++, Promise.resolve()) : new Promise((resolve) => waiting.push(resolve));
  const release = () => (waiting.length ? waiting.shift()() : active--);

  async function readCache(key) {
    const hit = memory.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value;
    if (!cacheDir) return undefined;
    try {
      const saved = JSON.parse(await readFile(join(cacheDir, `${key}.json`), "utf8"));
      if (Date.now() - saved.at < ttlMs) {
        memory.set(key, saved);
        return saved.value;
      }
    } catch {}
    return undefined;
  }

  async function writeCache(key, value) {
    const entry = { at: Date.now(), value };
    memory.set(key, entry);
    if (!cacheDir) return;
    try {
      await mkdir(cacheDir, { recursive: true });
      await writeFile(join(cacheDir, `${key}.json`), JSON.stringify(entry));
    } catch {}
  }

  async function request(url) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const started = performance.now();
      try {
        const response = await fetchImpl(url, {
          headers: { Accept: "application/json", "X-Api-Key": apiKey },
          signal: AbortSignal.timeout(timeoutMs),
        });
        const text = await response.text();
        let body;
        try { body = JSON.parse(text); } catch { body = { non_json_body: text.slice(0, 500) }; }
        const result = { ok: response.ok, status: response.status, ms: Math.round(performance.now() - started), body };
        if (response.status === 429 && attempt < 3) { await sleep(1500 * attempt); continue; }
        return result;
      } catch (error) {
        const result = { ok: false, status: 0, ms: Math.round(performance.now() - started), body: null, error: error.cause?.message ?? error.message };
        if (attempt < 3) { await sleep(800 * attempt); continue; }
        return result;
      }
    }
  }

  // trace: optional array; every call is recorded for the brief's provenance.
  async function get(path, params = {}, { trace, module } = {}) {
    const url = buildUrl(baseUrl, path, params);
    const key = createHash("sha1").update(url.pathname + url.search).digest("hex");
    const record = { module, path, params, query: url.search.slice(1) };
    const cached = await readCache(key);
    if (cached) {
      trace?.push({ ...record, status: cached.status, ms: 0, cached: true });
      return { ...cached, cached: true };
    }
    await acquire();
    let result;
    try { result = await request(url); } finally { release(); }
    if (result.ok) await writeCache(key, result);
    trace?.push({ ...record, status: result.status, ms: result.ms, cached: false, error: result.error });
    return result;
  }

  return { get };
}

// Qloo nests lists under results.<kind> (entities, tags, demographics, trending, heatmap...).
export function listOf(body) {
  const results = body?.results ?? body;
  if (Array.isArray(results)) return results;
  if (results && typeof results === "object") {
    for (const value of Object.values(results)) if (Array.isArray(value)) return value;
  }
  return [];
}

export function errorOf(result) {
  if (result.error) return result.error;
  const body = result.body ?? {};
  return body.errors?.[0]?.message ?? body.error?.message ?? body.message ?? `HTTP ${result.status}`;
}
