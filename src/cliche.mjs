// The cliché check: ask the plain LLM (no data) for partners and artists, then score
// its suggestions with Qloo against the same audience, next to our data-backed picks.
import { normName, round } from "./util.mjs";
import { listOf } from "./qloo.mjs";

const SYSTEM = "You are a marketing strategist. Use only your own knowledge. Answer with JSON only.";

export function clichePrompt({ entity, target }) {
  return [
    `A team is preparing the launch of the ${entity.type.replace("_", " ")} "${entity.name}"${target ? `, aimed at ${target}` : ""}.`,
    "Which 5 brands would be the best partners, and which 5 music artists best fit its audience?",
    'Return JSON: {"brands": ["name", ...], "artists": ["name", ...]}',
  ].join(" ");
}

export const matchesName = (wanted, found) => {
  const a = normName(wanted), b = normName(found);
  return Boolean(a) && Boolean(b) && (a === b || b.startsWith(a) || a.startsWith(b));
};

export function rankPool(rows) {
  const scored = rows.filter((r) => typeof r.affinity === "number").sort((a, b) => b.affinity - a.affinity);
  scored.forEach((r, i) => { r.rank = i + 1; });
  return rows;
}

async function resolveNames(call, names, type) {
  const out = [];
  for (const name of names) {
    const res = await call("cliche", "/search", { query: name, types: `urn:entity:${type}`, take: 3 });
    const hit = res.ok ? listOf(res.body).find((e) => matchesName(name, e.name)) : undefined;
    out.push({ name, id: hit?.entity_id, resolvedName: hit?.name });
  }
  return out;
}

// ours: [{id, name, affinity}] already scored by Qloo. type: "brand" | "artist".
async function compareList({ call, type, suggestions, ours, signal }) {
  const resolved = await resolveNames(call, suggestions, type);
  const ourIds = new Set(ours.map((o) => o.id));
  const poolIds = [...new Set([...ours.map((o) => o.id), ...resolved.filter((r) => r.id).map((r) => r.id)])];
  const scores = new Map();
  if (poolIds.length) {
    const res = await call("cliche", "/v2/insights", {
      "filter.type": `urn:entity:${type}`, ...signal, "filter.results.entities": poolIds, take: Math.min(50, poolIds.length + 5),
    });
    for (const e of res.ok ? listOf(res.body) : []) scores.set(e.entity_id, e.query?.affinity);
  }
  const llm = resolved.map((r) => ({
    name: r.name, qlooName: r.resolvedName, id: r.id,
    affinity: round(scores.get(r.id)), inOurPicks: ourIds.has(r.id), found: Boolean(r.id),
  }));
  const oursRows = ours.map((o) => ({ ...o, affinity: round(scores.get(o.id) ?? o.affinity) }));
  rankPool([...llm.filter((r) => r.id), ...oursRows.filter((o) => !llm.some((l) => l.id === o.id))]);
  const floor = Math.min(...oursRows.map((o) => o.affinity).filter((v) => typeof v === "number"));
  const scoredLlm = llm.filter((r) => typeof r.affinity === "number");
  const avg = (rows) => (rows.length ? round(rows.reduce((s, r) => s + r.affinity, 0) / rows.length) : undefined);
  return {
    llm, ours: oursRows,
    summary: {
      llmAverage: avg(scoredLlm), oursAverage: avg(oursRows.filter((o) => typeof o.affinity === "number")),
      llmBelowOurFloor: Number.isFinite(floor) ? scoredLlm.filter((r) => r.affinity < floor).length : 0,
      overlap: llm.filter((r) => r.inOurPicks).length, notInQloo: llm.filter((r) => !r.found).length,
      scored: scoredLlm.length,
    },
  };
}

export async function clicheCheck({ llm, call, entity, target, signal, oursBrands, oursArtists }) {
  const raw = await llm.json({ system: SYSTEM, prompt: clichePrompt({ entity, target }) });
  const take = (list) => (Array.isArray(list) ? list.map(String).slice(0, 5) : []);
  const brands = take(raw?.brands), artists = take(raw?.artists);
  const [b, a] = await Promise.all([
    compareList({ call, type: "brand", suggestions: brands, ours: oursBrands, signal }),
    compareList({ call, type: "artist", suggestions: artists, ours: oursArtists, signal }),
  ]);
  return { prompt: clichePrompt({ entity, target }), brands: b, artists: a };
}
