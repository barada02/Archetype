import { test } from "node:test";
import assert from "node:assert/strict";
import { normName, trendDirection, genderLean, peakAge, skewWarnings, dateWindow, mapLimit, clip } from "../src/util.mjs";
import { validateEditor, unsupportedDigits, MAX_PER_CATEGORY, MAX_PICKS } from "../src/editor.mjs";
import { buildUrl, createQloo } from "../src/qloo.mjs";
import { matchesName, rankPool } from "../src/cliche.mjs";
import { loadConfig, redactor } from "../src/config.mjs";
import { createLlm, parseJson } from "../src/llm.mjs";

test("normName ignores case, accents and punctuation", () => {
  assert.equal(normName("Beyoncé & Jay-Z"), "beyonce and jay z");
  assert.equal(normName("  The  Smiths "), "the smiths");
});

test("clip strips markup and truncates", () => {
  assert.equal(clip("a<br />b <i>c</i>", 50), "a b c");
  assert.equal(clip("x".repeat(20), 10).length, 10);
});

test("trendDirection compares first and last third", () => {
  const pts = (vals) => vals.map((v, i) => ({ date: `2026-01-${String(i + 1).padStart(2, "0")}`, population_percentile: v }));
  assert.equal(trendDirection(pts([0.5, 0.5, 0.52, 0.6, 0.7, 0.75])).direction, "rising");
  assert.equal(trendDirection(pts([0.9, 0.85, 0.8, 0.6, 0.5, 0.5])).direction, "falling");
  assert.equal(trendDirection(pts([0.5, 0.5, 0.5, 0.5, 0.5, 0.5])).direction, "steady");
  assert.equal(trendDirection(pts([0.5, 0.6])).direction, "unknown");
  // API returns newest first; order must not matter
  assert.equal(trendDirection(pts([0.5, 0.5, 0.52, 0.6, 0.7, 0.75]).reverse()).direction, "rising");
});

test("genderLean and peakAge describe indices, not percentages", () => {
  assert.equal(genderLean({ male: 0.02, female: -0.02 }).side, "balanced");
  assert.equal(genderLean({ male: 0.1, female: -0.1 }).text, "slightly male-leaning");
  assert.equal(genderLean({ male: -0.3, female: 0.3 }).text, "strongly female-leaning");
  assert.deepEqual(peakAge({ "25_to_29": 0.1, "35_to_44": 0.4, "55_and_older": -0.2 }), { band: "35_to_44", label: "35 to 44", value: 0.4 });
});

test("skewWarnings flags opposite gender skew and distant age peaks only when clear", () => {
  const audience = { gender: { value: -0.3 }, peakAge: { band: "25_to_29", value: 0.3 } };
  const w = skewWarnings(audience, { gender: { male: 0.32, female: -0.32 }, age: { "55_and_older": 0.4, "25_to_29": 0 } });
  assert.equal(w.length, 2);
  assert.deepEqual(skewWarnings({ gender: { value: -0.02 }, peakAge: { band: "25_to_29", value: 0.01 } }, { gender: { male: 0.4 }, age: { "55_and_older": 0.5 } }), []);
});

test("dateWindow ends today and spans the requested days", () => {
  assert.deepEqual(dateWindow(new Date("2026-10-25T10:00:00Z"), 10), { start: "2026-10-15", end: "2026-10-25" });
});

test("mapLimit keeps order and respects the limit", async () => {
  let active = 0, peak = 0;
  const out = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
    active++; peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return n * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12]);
  assert.ok(peak <= 2);
});

const candidates = ["a", "b", "c", "d"].map((id, i) => ({ id, name: `Brand ${id}`, category: i < 3 ? "fashion" : "travel", affinity: 0.9 - i / 100, industries: ["Retail"] }));
const ctx = { candidates, entity: { name: "Fast & Furious 6" }, audience: { peakAge: { label: "25 to 29", value: 0.3 }, gender: { text: "balanced" } } };

test("validateEditor drops ids the model invented and caps per category", () => {
  const out = validateEditor({
    headline: "A headline", audienceSummary: "Summary.", launchAngles: ["x"], caveats: [],
    partnerPicks: [{ id: "zzz", reason: "invented" }, { id: "a", reason: "ok" }, { id: "b", reason: "ok" }, { id: "c", reason: "third in category" }, { id: "d", reason: "ok" }, { id: "a", reason: "dupe" }],
  }, ctx);
  assert.deepEqual(out.picks.map((p) => p.id), ["a", "b", "d"]);
  assert.ok(out.picks.length <= MAX_PICKS && MAX_PER_CATEGORY === 2);
  assert.equal(out.source, "llm");
});

test("validateEditor replaces text containing numbers the data did not give", () => {
  const out = validateEditor({
    headline: "82% higher affinity for fans", audienceSummary: "Fine summary for Fast & Furious 6.",
    partnerPicks: [{ id: "a", reason: "Fans over-index by 82%" }],
  }, ctx);
  assert.doesNotMatch(out.headline, /82/);
  assert.match(out.audienceSummary, /Fast & Furious 6/); // digit in the title is allowed
  assert.doesNotMatch(out.picks[0].reason, /82/);
  assert.ok(!unsupportedDigits("Fast & Furious 6", "Fast & Furious 6"));
  assert.ok(unsupportedDigits("up 40%", "Fast & Furious 6"));
});

test("validateEditor falls back to ranked picks when the model gave nothing", () => {
  const out = validateEditor(undefined, ctx);
  assert.equal(out.source, "fallback");
  assert.deepEqual(out.picks.map((p) => p.id), ["a", "b", "d"]);
  assert.ok(out.picks.every((p) => p.reason.length > 0));
});

test("buildUrl comma-joins arrays and skips empty values", () => {
  const url = buildUrl("https://x.test", "/v2/insights", { a: ["1", "2"], b: "", c: undefined, d: [], e: true });
  assert.equal(url.search, "?a=1%2C2&e=true");
});

test("qloo client caches successful GETs, retries 429, and records a trace", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) return new Response("{}", { status: 429 });
    return new Response(JSON.stringify({ results: { entities: [] } }), { status: 200 });
  };
  const qloo = createQloo({ apiKey: "k", baseUrl: "https://x.test", fetchImpl });
  const trace = [];
  const first = await qloo.get("/search", { query: "a" }, { trace, module: "t" });
  const second = await qloo.get("/search", { query: "a" }, { trace, module: "t" });
  assert.ok(first.ok && second.cached);
  assert.equal(calls, 2); // one 429 then one success; the repeat came from cache
  assert.deepEqual(trace.map((t) => t.cached), [false, true]);
});

test("cliche helpers match names loosely and rank by affinity", () => {
  assert.ok(matchesName("Florence + The Machine", "Florence + the Machine"));
  assert.ok(matchesName("Aesop", "Aesop Skincare"));
  assert.ok(!matchesName("Nike", "Mike"));
  const rows = rankPool([{ affinity: 0.7 }, { affinity: 0.9 }, { found: false }]);
  assert.equal(rows[1].rank, 1);
  assert.equal(rows[0].rank, 2);
  assert.equal(rows[2].rank, undefined);
});

test("config accepts hackathon variable names and redacts secrets", () => {
  const config = loadConfig({ API_Key: "qloo-secret-key", API_Server_URL: "https://h.test/", META_API: "meta-secret-key", BASETEN_API_KEY: "baseten-secret-key" });
  assert.equal(config.qlooKey, "qloo-secret-key");
  assert.equal(config.qlooBase, "https://h.test");
  assert.equal(config.metaKey, "meta-secret-key");
  assert.equal(config.llmPrimary, "meta");
  assert.equal(redactor(config)("a qloo-secret-key b meta-secret-key c baseten-secret-key"), "a [REDACTED] b [REDACTED] c [REDACTED]");
});

test("parseJson strips fences and stray prose", () => {
  assert.deepEqual(parseJson('```json\n{"a": 1}\n```'), { a: 1 });
  assert.deepEqual(parseJson('Here you go: {"a": [2]} done'), { a: [2] });
  assert.throws(() => parseJson("no json here"));
});

test("createLlm tries the primary first and falls back to the backup", async () => {
  const calls = [];
  const fake = (name, fails) => ({ model }) => ({ name, model, async json() { calls.push(name); if (fails) throw new Error("down"); return { from: name }; } });
  const keys = { metaKey: "m", metaModel: "mm", basetenKey: "b", basetenModel: "bm" };
  const quiet = console.error; console.error = () => {};
  try {
    const llm = createLlm(keys, { meta: fake("meta", true), baseten: fake("baseten", false) });
    assert.equal(llm.model, "mm");
    assert.deepEqual(await llm.json({}), { from: "baseten" });
    assert.deepEqual(calls, ["meta", "baseten"]);
    const swapped = createLlm({ ...keys, llmPrimary: "baseten" }, { meta: fake("meta", false), baseten: fake("baseten", true) });
    assert.equal(swapped.label, "baseten:bm > meta:mm");
    assert.deepEqual(await swapped.json({}), { from: "meta" });
    const both = createLlm(keys, { meta: fake("meta", true), baseten: fake("baseten", true) });
    await assert.rejects(both.json({}), /down/);
  } finally { console.error = quiet; }
  assert.equal(createLlm({}), undefined);
  assert.equal(createLlm({ basetenKey: "b", basetenModel: "bm" }).label, "baseten:bm");
});
