// Builds a brief. Data modules run in parallel against Qloo; the LLM only edits
// and explains what came back. Every Qloo call is recorded for provenance.
import { randomBytes } from "node:crypto";
import { listOf, errorOf } from "./qloo.mjs";
import { clip, round, normName, peakAge, genderLean, trendDirection, skewWarnings, dateWindow, mapLimit } from "./util.mjs";
import { editorPrompt, validateEditor, fallbackReason, EDITOR_SYSTEM } from "./editor.mjs";
import { clicheCheck } from "./cliche.mjs";

export const ENTITY_TYPES = ["book", "movie", "tv_show", "videogame", "podcast", "artist", "brand"];

export const PARTNER_CATEGORIES = {
  fashion: { label: "Fashion and apparel", tag: "urn:tag:genre:brand:fashion" },
  food_drink: { label: "Food and drink", tag: "urn:tag:genre:brand:food_and_beverage" },
  beauty: { label: "Health and beauty", tag: "urn:tag:genre:brand:health_and_beauty" },
  travel: { label: "Travel", tag: "urn:tag:genre:brand:travel" },
  automotive: { label: "Automotive", tag: "urn:tag:genre:brand:automotive" },
  gaming: { label: "Gaming and electronics", tag: "urn:tag:genre:brand:electronics:gaming" },
};

export const DEFAULT_MIN_SCORE = 0.75;

// /v2/trending only accepts these entity types (books and games have no trend series).
export const TREND_TYPES = ["artist", "brand", "movie", "person", "podcast", "tv_show"];

const typeOf = (e) => String(e.subtype ?? e.types?.[0] ?? "").replace("urn:entity:", "");

export function entityCard(e) {
  const p = e.properties ?? {};
  return {
    id: e.entity_id ?? e.id,
    name: e.name,
    type: typeOf(e),
    description: clip(p.short_description ?? p.description, 200),
    image: p.image?.url,
    popularity: round(e.popularity),
    year: p.release_year ?? p.publication_year ?? p.release_date?.slice?.(0, 4),
  };
}

export async function resolveEntities({ qloo, query, type }) {
  const res = await qloo.get("/search", { query, types: `urn:entity:${type}`, take: 6 });
  if (!res.ok) throw new Error(errorOf(res));
  return listOf(res.body).map((e) => ({ ...entityCard(e), type }));
}

const tagList = (res, n) => (res.ok ? listOf(res.body).slice(0, n).map((t) => ({ name: t.name, affinity: round(t.query?.affinity) })) : []);

function brandCard(e, key) {
  const p = e.properties ?? {};
  return {
    id: e.entity_id,
    name: e.name,
    category: key,
    categoryLabel: PARTNER_CATEGORIES[key].label,
    affinity: round(e.query?.affinity),
    brandType: Array.isArray(p.brand_type) ? p.brand_type[0] : p.brand_type,
    industries: Array.isArray(p.industries) ? p.industries.slice(0, 3) : [],
    description: clip(p.short_description ?? p.description, 170),
    image: p.image?.url,
    site: typeof p.official_site === "string" ? p.official_site : undefined,
  };
}

const artistCard = (e) => ({ id: e.entity_id, name: e.name, affinity: round(e.query?.affinity), popularity: round(e.popularity), image: e.properties?.image?.url });

// input: { entity:{id,name,type,...}, goal, ageBand, gender, city, categories, minScore }
export async function buildBrief({ input, qloo, llm, emit = () => {}, now = new Date() }) {
  const entity = input.entity;
  const trace = [];
  const modules = {};
  const call = (module, path, params) => qloo.get(path, params, { trace, module });
  const signal = { "signal.interests.entities": entity.id };
  const demoSignal = {};
  if (input.ageBand) demoSignal["signal.demographics.age"] = input.ageBand;
  if (input.gender) demoSignal["signal.demographics.gender"] = input.gender;
  const minScore = input.minScore ?? DEFAULT_MIN_SCORE;
  const categories = (input.categories?.length ? input.categories : Object.keys(PARTNER_CATEGORIES)).filter((k) => k in PARTNER_CATEGORIES);
  const target = [input.ageBand && input.ageBand.replace(/_/g, " "), input.gender].filter(Boolean).join(", ") || undefined;

  // Runs one module; fn returns { data, detail }. Optional modules degrade instead of failing the brief.
  async function step(id, label, fn, { optional = true } = {}) {
    emit({ id, label, status: "running" });
    const started = performance.now();
    try {
      const { data, detail } = await fn();
      const ms = Math.round(performance.now() - started);
      modules[id] = { status: "done", ms };
      emit({ id, label, status: "done", ms, detail });
      return data;
    } catch (error) {
      modules[id] = { status: "error", error: error.message };
      emit({ id, label, status: "error", detail: error.message });
      if (!optional) throw error;
      return undefined;
    }
  }
  const skip = (id, label, why) => { modules[id] = { status: "skipped", reason: why }; emit({ id, label, status: "skipped", detail: why }); };

  // ---- data modules (parallel) ----
  const profileP = step("profile", "Audience skew and taste tags", async () => {
    const tags = (type) => call("profile", "/v2/insights", { "filter.type": "urn:tag", ...signal, "filter.tag.types": type, take: 8 });
    const [demo, genre, mood, trait, life] = await Promise.all([
      call("profile", "/v2/insights", { "filter.type": "urn:demographics", ...signal }),
      tags("urn:tag:genre:media"), tags("urn:tag:emotional_tone:qloo"), tags("urn:tag:audience:qloo"), tags("urn:tag:lifestyle:qloo"),
    ]);
    if (!demo.ok) throw new Error(errorOf(demo));
    const q = listOf(demo.body)[0]?.query ?? {};
    const audience = {
      ageIndex: q.age ?? {}, genderIndex: q.gender ?? {}, peakAge: peakAge(q.age), gender: genderLean(q.gender),
      genres: tagList(genre, 6), moods: tagList(mood, 5), traits: tagList(trait, 5), lifestyle: tagList(life, 5),
    };
    return { data: audience, detail: `${audience.peakAge?.label ?? "age unknown"}, ${audience.gender?.text ?? "gender unknown"}` };
  }, { optional: false });

  const soundP = step("sound", "Artists: mainstream and emerging", async () => {
    const base = { "filter.type": "urn:entity:artist", ...signal, take: 14 };
    const [main, rising] = await Promise.all([
      call("sound", "/v2/insights", base),
      call("sound", "/v2/insights", { ...base, "filter.popularity.max": 0.6 }),
    ]);
    const cards = (res) => (res.ok ? listOf(res.body).filter((a) => a.entity_id !== entity.id).slice(0, 8).map(artistCard) : []);
    const data = { mainstream: cards(main), emerging: cards(rising) };
    return { data, detail: `${data.mainstream.length} mainstream, ${data.emerging.length} emerging` };
  });

  const partnersP = step("partners", "Partner brands by category", async () => {
    const perCat = await mapLimit(categories, 3, async (key) => {
      const res = await call("partners", "/v2/insights", {
        "filter.type": "urn:entity:brand", ...signal, ...demoSignal, "filter.tags": PARTNER_CATEGORIES[key].tag, take: 10,
      });
      return { key, items: res.ok ? listOf(res.body) : [] };
    });
    const stats = { fetched: 0, mediaBrands: 0, belowScore: 0, minScore };
    const best = new Map();
    for (const { key, items } of perCat) {
      for (const e of items) {
        stats.fetched++;
        const card = brandCard(e, key);
        if (/media/i.test(card.brandType ?? "")) { stats.mediaBrands++; continue; }
        if (typeof card.affinity !== "number" || card.affinity < minScore) { stats.belowScore++; continue; }
        if (!best.has(card.id) || best.get(card.id).affinity < card.affinity) best.set(card.id, card);
      }
    }
    const candidates = [...best.values()].sort((a, b) => b.affinity - a.affinity);
    return { data: { candidates, stats }, detail: `${candidates.length} candidates kept of ${stats.fetched}` };
  });

  const placesP = input.city
    ? step("places", `Places and neighborhoods in ${input.city}`, async () => {
        const [places, hoods] = await Promise.all([
          call("places", "/v2/insights", { "filter.type": "urn:entity:place", ...signal, "filter.location.query": input.city, take: 8 }),
          call("places", "/v2/insights", { "filter.type": "urn:heatmap", ...signal, "filter.location.query": input.city, "output.heatmap.boundary": "urn:entity:locality", take: 20 }),
        ]);
        const city = normName(input.city);
        const neighborhoods = (hoods.ok ? listOf(hoods.body) : [])
          .filter((h) => h.name && normName(h.name) !== city && !/united states|contiguous|county|community board|island/i.test(h.name))
          .filter((h) => normName(h.disambiguation ?? "").includes(city))
          .slice(0, 8)
          .map((h) => ({ id: h.entity_id, name: h.name, area: h.disambiguation, affinity: round(h.query?.affinity) }));
        const venues = (places.ok ? listOf(places.body) : []).map((p) => ({ ...entityCard(p), affinity: round(p.query?.affinity) }));
        return { data: { city: input.city, venues, neighborhoods }, detail: `${venues.length} venues, ${neighborhoods.length} neighborhoods` };
      })
    : (skip("places", "Places and neighborhoods", "no city given"), Promise.resolve(undefined));

  const timingP = !TREND_TYPES.includes(entity.type)
    ? (skip("timing", "Is interest rising or falling?", "Qloo has no trend series for this type"), Promise.resolve(undefined))
    : step("timing", "Is interest rising or falling?", async () => {
    const { start, end } = dateWindow(now, 182);
    const res = await call("timing", "/v2/trending", {
      "filter.type": `urn:entity:${entity.type}`, ...signal, "filter.start_date": start, "filter.end_date": end, take: 26,
    });
    if (!res.ok) throw new Error(errorOf(res));
    const trend = trendDirection(listOf(res.body));
    if (trend.direction === "unknown") throw new Error("Qloo has no trend series for this title");
    return { data: { ...trend, start, end }, detail: `${trend.direction} (${start} to ${end})` };
  });

  const [audience, sound = { mainstream: [], emerging: [] }, partnerData = { candidates: [], stats: {} }, places, timing] =
    await Promise.all([profileP, soundP, partnersP, placesP, timingP]);

  // ---- editor: the LLM picks and explains from the candidates ----
  const editor = await step("editor", "Editor: choose and explain partners", async () => {
    let raw;
    if (llm && partnerData.candidates.length) {
      try {
        raw = await llm.json({
          system: EDITOR_SYSTEM,
          prompt: editorPrompt({ entity, goal: input.goal, target, audience, candidates: partnerData.candidates.slice(0, 30), sound }),
        });
      } catch (error) {
        emit({ id: "editor", label: "Editor", status: "running", detail: `LLM failed (${error.message.slice(0, 80)}); using ranked fallback` });
      }
    }
    const result = validateEditor(raw, { candidates: partnerData.candidates, entity, audience });
    return { data: result, detail: `${result.picks.length} partners (${result.source})` };
  }, { optional: false });

  const byId = new Map(partnerData.candidates.map((c) => [c.id, c]));
  let picks = editor.picks.map((p) => ({ ...byId.get(p.id), reason: p.reason, warnings: [] }));

  // ---- checks (parallel): partner skew and the plain-LLM comparison ----
  const checkP = step("check", "Check each partner's own audience", async () => {
    const demos = await mapLimit(picks, 3, async (pick) => {
      const res = await call("check", "/v2/insights", { "filter.type": "urn:demographics", "signal.interests.entities": pick.id });
      return res.ok ? listOf(res.body)[0]?.query : undefined;
    });
    picks.forEach((pick, i) => {
      const d = demos[i];
      if (!d) return;
      pick.audience = { peakAge: peakAge(d.age), gender: genderLean(d.gender) };
      pick.warnings = skewWarnings(audience, { age: d.age, gender: d.gender });
    });
    const flagged = picks.filter((p) => p.warnings.length).length;
    return { data: true, detail: `${flagged} of ${picks.length} flagged` };
  });

  const clicheP = llm
    ? step("cliche", "Cliché check: plain LLM vs the data", async () => {
        const ourBrands = picks.slice(0, 5).map((p) => ({ id: p.id, name: p.name, affinity: p.affinity }));
        const ourArtists = sound.mainstream.slice(0, 5).map((a) => ({ id: a.id, name: a.name, affinity: a.affinity }));
        const data = await clicheCheck({ llm, call, entity, target, signal: { ...signal, ...demoSignal }, oursBrands: ourBrands, oursArtists: ourArtists });
        const s = data.brands.summary;
        return { data, detail: `${s.scored} of ${data.brands.llm.length} LLM brands scored, ${s.llmBelowOurFloor} below our floor` };
      })
    : (skip("cliche", "Cliché check", "LLM key missing"), Promise.resolve(undefined));

  const [, cliche] = await Promise.all([checkP, clicheP]);
  picks = picks.map((p) => ({ ...p, reason: p.reason || fallbackReason(p, entity.name) }));

  return {
    id: randomBytes(6).toString("hex"),
    createdAt: now.toISOString(),
    model: llm?.model,
    input: { entity, goal: input.goal, ageBand: input.ageBand, gender: input.gender, city: input.city, categories, minScore },
    audience,
    sound,
    partners: { picks, candidates: partnerData.candidates, stats: partnerData.stats },
    places,
    timing,
    editor: { source: editor.source, headline: editor.headline, audienceSummary: editor.audienceSummary, launchAngles: editor.launchAngles, caveats: editor.caveats },
    cliche,
    provenance: trace,
    modules,
  };
}
