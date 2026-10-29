// Archetype web server. Keys stay here; the browser only talks to /api.
// Usage: npm start   then open http://localhost:3100
import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, redactor } from "./src/config.mjs";
import { createQloo } from "./src/qloo.mjs";
import { createLlm } from "./src/llm.mjs";
import { buildBrief, resolveEntities, ENTITY_TYPES, PARTNER_CATEGORIES, DEFAULT_MIN_SCORE } from "./src/pipeline.mjs";
import { AGE_BANDS } from "./src/util.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(ROOT, "public");
const BRIEFS = join(ROOT, "data", "briefs");
const config = loadConfig();
const redact = redactor(config);
const qloo = createQloo({ apiKey: config.qlooKey, baseUrl: config.qlooBase, cacheDir: join(ROOT, "data", "cache") });
const llm = createLlm(config);

// Sample briefs are committed under samples/ (data/ is not), so a fresh deploy always has a
// demo to open without spending Qloo or LLM calls. samples/index.json sets the order; the first is featured.
const SAMPLES = join(ROOT, "samples");
const samples = [];
try {
  for (const id of JSON.parse(await readFile(join(SAMPLES, "index.json"), "utf8"))) {
    const b = JSON.parse(await readFile(join(SAMPLES, `${id}.json`), "utf8"));
    samples.push({ id: b.id, name: b.input.entity.name, type: b.input.entity.type, image: b.input.entity.image, goal: b.input.goal, city: b.input.city, ageBand: b.input.ageBand, gender: b.input.gender, headline: b.editor.headline });
  }
} catch (error) {
  if (error.code !== "ENOENT") console.error(`samples: ${error.message}`);
}
const sampleIds = new Set(samples.map((s) => s.id));

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
const MAX_BODY = 20_000;
const fail = (status, message) => Object.assign(new Error(message), { status });

// Per-visitor limit on brief builds, so a public demo cannot burn the Qloo quota.
const buildLog = new Map();
function allowBuild(ip) {
  const now = Date.now();
  const recent = (buildLog.get(ip) ?? []).filter((t) => now - t < 3600_000);
  if (recent.length >= config.briefsPerHour) return false;
  recent.push(now);
  buildLog.set(ip, recent);
  return true;
}
// Behind the local nginx proxy every socket is loopback; nginx appends the real
// client as the last X-Forwarded-For entry (earlier entries can be spoofed).
function clientIp(req) {
  const ip = req.socket.remoteAddress ?? "local";
  const loopback = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
  const forwarded = req.headers["x-forwarded-for"];
  if (!loopback || typeof forwarded !== "string") return ip;
  return forwarded.split(",").at(-1).trim() || ip;
}
let running = 0;

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > MAX_BODY) throw fail(413, "Body too large");
  }
  try { return raw ? JSON.parse(raw) : {}; } catch { throw fail(400, "Invalid JSON"); }
}

const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

function parseBriefInput(body) {
  const e = body.entity ?? {};
  if (!/^[0-9A-Fa-f-]{36}$/.test(str(e.id, 64))) throw fail(400, "entity.id must be a Qloo entity id");
  if (!ENTITY_TYPES.includes(e.type)) throw fail(400, `entity.type must be one of ${ENTITY_TYPES.join(", ")}`);
  const ageBand = str(body.ageBand, 20);
  if (ageBand && !AGE_BANDS.includes(ageBand)) throw fail(400, "ageBand is not valid");
  const gender = str(body.gender, 10);
  if (gender && !["male", "female"].includes(gender)) throw fail(400, "gender must be male or female");
  const categories = Array.isArray(body.categories) ? body.categories.filter((c) => c in PARTNER_CATEGORIES) : [];
  const minScore = Number(body.minScore);
  return {
    entity: { id: e.id, name: str(e.name, 160), type: e.type, description: str(e.description, 300), image: str(e.image, 300) || undefined },
    goal: str(body.goal, 200), ageBand: ageBand || undefined, gender: gender || undefined, city: str(body.city, 80) || undefined,
    categories, minScore: minScore >= 0.5 && minScore <= 0.95 ? minScore : DEFAULT_MIN_SCORE,
  };
}

const json = (res, status, value) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(redact(value));
};

async function handleBuild(req, res) {
  if (!config.qlooKey) throw fail(503, "QLOO_API_KEY is not set");
  const input = parseBriefInput(await readJson(req));
  if (!allowBuild(clientIp(req))) throw fail(429, "Too many briefs from this address. Try again later.");
  if (running >= 2) throw fail(429, "The server is busy building other briefs. Try again in a moment.");
  running++;
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${redact(data)}\n\n`);
  try {
    const brief = await buildBrief({ input, qloo, llm, emit: (e) => send("progress", e) });
    await mkdir(BRIEFS, { recursive: true });
    await writeFile(join(BRIEFS, `${brief.id}.json`), redact(brief));
    send("done", brief);
  } catch (error) {
    send("failure", { error: error.message });
  } finally {
    running--;
    res.end();
  }
}

const api = {
  "GET /api/config": async () => ({
    hasQloo: Boolean(config.qlooKey), hasLlm: Boolean(llm), model: llm?.model,
    types: ENTITY_TYPES, ageBands: AGE_BANDS, minScore: DEFAULT_MIN_SCORE,
    categories: Object.entries(PARTNER_CATEGORIES).map(([key, c]) => ({ key, label: c.label })),
    samples,
  }),
  "POST /api/resolve": async (req) => {
    const body = await readJson(req);
    const query = str(body.query, 120), type = body.type;
    if (!query) throw fail(400, "query is required");
    if (!ENTITY_TYPES.includes(type)) throw fail(400, "type is not valid");
    if (!config.qlooKey) throw fail(503, "QLOO_API_KEY is not set");
    return { candidates: await resolveEntities({ qloo, query, type }) };
  },
};

// Qloo images are served from our origin, so browser blockers and hotlink rules on
// images.qloo.com cannot break them. Only that host is fetched: this is not an open proxy.
const MAX_IMAGE = 3_000_000;
async function proxyImage(res, target) {
  let url;
  try { url = new URL(target); } catch { throw fail(400, "Bad image url"); }
  if (url.protocol !== "https:" || url.hostname !== "images.qloo.com") throw fail(400, "Image host not allowed");
  const upstream = await fetch(url, { signal: AbortSignal.timeout(15_000) }).catch(() => undefined);
  const type = upstream?.headers.get("content-type") ?? "";
  if (!upstream?.ok || !type.startsWith("image/")) throw fail(502, "Image unavailable");
  const data = Buffer.from(await upstream.arrayBuffer());
  if (data.length > MAX_IMAGE) throw fail(502, "Image too large");
  res.writeHead(200, { "content-type": type, "cache-control": "public, max-age=604800" });
  res.end(data);
}

async function serveStatic(res, file) {
  try {
    const data = await readFile(join(PUBLIC, file));
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404).end("not found");
  }
}

const server = createServer(async (req, res) => {
  const { pathname, searchParams } = new URL(req.url, "http://x");
  try {
    if (req.method === "POST" && pathname === "/api/brief") return await handleBuild(req, res);
    if (req.method === "GET" && pathname === "/img") return await proxyImage(res, searchParams.get("u") ?? "");
    const handler = api[`${req.method} ${pathname}`];
    if (handler) return json(res, 200, await handler(req));
    const saved = req.method === "GET" && pathname.match(/^\/api\/brief\/([0-9a-f]{12})$/);
    if (saved) {
      const id = saved[1];
      const isSample = sampleIds.has(id);
      try { return json(res, 200, { ...JSON.parse(await readFile(join(isSample ? SAMPLES : BRIEFS, `${id}.json`), "utf8")), ...(isSample ? { sample: true } : {}) }); }
      catch { throw fail(404, "No such brief"); }
    }
    if (req.method !== "GET") throw fail(405, "Method not allowed");
    if (pathname === "/" || /^\/b\/[0-9a-f]{12}$/.test(pathname)) return await serveStatic(res, "index.html");
    if (/^\/[\w.-]+\.(js|css|svg)$/.test(pathname)) return await serveStatic(res, pathname.slice(1));
    res.writeHead(404).end("not found");
  } catch (error) {
    if (res.headersSent) return res.end();
    json(res, error.status ?? 500, { error: error.message });
  }
});

server.listen(config.port, config.host, () => {
  console.error(`Archetype on http://${config.host}:${config.port}  qloo=${config.qlooKey ? "key set" : "NO KEY"}  llm=${llm ? llm.label : "NO KEY"}`);
});
