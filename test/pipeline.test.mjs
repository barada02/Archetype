import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBrief, TREND_TYPES } from "../src/pipeline.mjs";

const brand = (id, name, affinity, brandType = "Product Brand") => ({
  entity_id: id, name, query: { affinity }, properties: { brand_type: [brandType], industries: ["Fashion & Apparel"], short_description: `${name} description`, image: { url: `https://img/${id}.jpg` } },
});

// A fake Qloo that answers by request shape and records every call.
function fakeQloo() {
  const calls = [];
  return {
    calls,
    async get(path, params, { trace, module } = {}) {
      calls.push({ path, params });
      trace?.push({ module, path, params, status: 200, ms: 1, cached: false });
      const type = params["filter.type"];
      const ok = (results) => ({ ok: true, status: 200, ms: 1, body: { results } });
      if (path === "/search") return ok({ entities: /nobody/i.test(params.query) ? [] : [{ entity_id: "NEW-ID", name: params.query }] });
      if (type === "urn:demographics") return ok({ demographics: [{ query: { age: { "25_to_29": 0.4, "55_and_older": -0.3 }, gender: { male: -0.3, female: 0.3 } } }] });
      if (type === "urn:tag") return ok({ tags: [{ name: "Reflective", query: { affinity: 0.9 } }] });
      if (type === "urn:entity:artist") return ok({ entities: [{ entity_id: "ART1", name: "Artist One", query: { affinity: 0.95 }, popularity: 0.9 }, { entity_id: "SELF", name: "Self", query: { affinity: 1 } }] });
      if (type === "urn:entity:brand" && params["filter.tags"]) {
        return ok({ entities: [brand("B-" + params["filter.tags"].split(":").pop(), "Brand " + params["filter.tags"].split(":").pop(), 0.9), brand("MEDIA", "A Magazine", 0.95, "Media Brand"), brand("LOW" + params["filter.tags"], "Weak", 0.6)] });
      }
      if (type === "urn:entity:brand") return ok({ entities: [] });
      if (type === "urn:entity:place") return ok({ entities: [{ entity_id: "P1", name: "Cafe", query: { affinity: 0.9 }, properties: {} }] });
      if (type === "urn:heatmap") return ok({ entities: [{ entity_id: "H1", name: "Brooklyn", disambiguation: "Brooklyn, New York, USA", query: { affinity: 0.9 } }, { entity_id: "H2", name: "Kings County", disambiguation: "Kings County, New York", query: { affinity: 0.9 } }] });
      if (path === "/v2/trending") return ok({ trending: Array.from({ length: 12 }, (_, i) => ({ date: `2026-0${1 + Math.floor(i / 4)}-${String(1 + (i % 4) * 7).padStart(2, "0")}`, population_percentile: 0.5 + i * 0.02 })) });
      return { ok: false, status: 404, ms: 1, body: { error: { message: "unexpected" } } };
    },
  };
}

const entity = { id: "SELF", name: "The Test Book", type: "book" };

test("buildBrief assembles every module, filters media brands, and records provenance", async () => {
  const qloo = fakeQloo();
  const events = [];
  const brief = await buildBrief({ input: { entity, city: "New York", ageBand: "25_to_29", gender: "female", goal: "Launch", categories: ["fashion", "travel"] }, qloo, gemini: undefined, emit: (e) => events.push(e) });
  assert.equal(brief.audience.peakAge.band, "25_to_29");
  assert.equal(brief.audience.gender.side, "female");
  assert.deepEqual(brief.sound.mainstream.map((a) => a.id), ["ART1"]); // the entity itself is excluded
  assert.equal(brief.partners.stats.mediaBrands, 2);
  assert.equal(brief.partners.stats.belowScore, 2);
  assert.ok(brief.partners.candidates.every((c) => !/media/i.test(c.brandType)));
  assert.equal(brief.editor.source, "fallback"); // no Gemini given
  assert.ok(brief.partners.picks.length > 0 && brief.partners.picks.every((p) => p.reason));
  assert.deepEqual(brief.places.neighborhoods.map((n) => n.name), ["Brooklyn"]); // county filtered out
  assert.equal(brief.modules.timing.status, "skipped"); // books have no trend series
  assert.equal(brief.modules.cliche.status, "skipped");
  assert.ok(brief.provenance.length >= 8 && brief.provenance.every((c) => c.module && c.path));
  assert.ok(events.some((e) => e.id === "profile" && e.status === "done"));
  assert.ok(!TREND_TYPES.includes("book") && TREND_TYPES.includes("movie"));
});

test("target demographics are sent as signals on partner calls", async () => {
  const qloo = fakeQloo();
  await buildBrief({ input: { entity, ageBand: "25_to_29", gender: "female", categories: ["fashion"] }, qloo });
  const partnerCall = qloo.calls.find((c) => c.params["filter.tags"]);
  assert.equal(partnerCall.params["signal.demographics.age"], "25_to_29");
  assert.equal(partnerCall.params["signal.demographics.gender"], "female");
});

test("Gemini output is validated: invented partners are dropped and numbers never come from the model", async () => {
  const qloo = fakeQloo();
  let prompts = 0;
  const gemini = {
    model: "fake",
    async json({ prompt }) {
      prompts++;
      if (prompt.includes("Which 5 brands")) return { brands: ["Nobody Brand"], artists: ["Artist One"] };
      return { headline: "Up 82% with fans", audienceSummary: "Nice.", launchAngles: [], partnerPicks: [{ id: "NOT-A-CANDIDATE", reason: "made up" }, { id: "B-fashion", reason: "Fits well" }] };
    },
  };
  const brief = await buildBrief({ input: { entity, categories: ["fashion"] }, qloo, gemini });
  assert.deepEqual(brief.partners.picks.map((p) => p.id), ["B-fashion"]);
  assert.doesNotMatch(brief.editor.headline, /82/);
  assert.equal(brief.editor.source, "gemini");
  assert.equal(prompts, 2); // editor + cliché
  assert.ok(brief.cliche.brands.llm[0].found === false); // unknown brand reported as not in Qloo
});

test("the profile module is required: a failing Qloo aborts the brief with the API's message", async () => {
  const qloo = { async get() { return { ok: false, status: 401, ms: 1, body: { error: { message: "bad key" } } }; } };
  await assert.rejects(buildBrief({ input: { entity } , qloo }), /bad key/);
});
