// CLI: build a brief without the web UI.
// Usage: node --env-file=.env scripts/brief.mjs <type> "<title>" [--age 25_to_29] [--gender female] [--city "New York"] [--goal "..."] [--out samples]
// --out picks the folder the brief is saved to (default data/briefs). Use --out samples for a committed demo brief.
import { writeFile, mkdir } from "node:fs/promises";
import { loadConfig, redactor } from "../src/config.mjs";
import { createQloo } from "../src/qloo.mjs";
import { createLlm } from "../src/llm.mjs";
import { buildBrief, resolveEntities } from "../src/pipeline.mjs";

const [type, title, ...rest] = process.argv.slice(2);
const flag = (name) => (rest.includes(`--${name}`) ? rest[rest.indexOf(`--${name}`) + 1] : undefined);
if (!type || !title) { console.error('Usage: node scripts/brief.mjs <type> "<title>" [--age 25_to_29] [--gender female] [--city "New York"] [--goal "..."]'); process.exit(2); }
const config = loadConfig();
const qloo = createQloo({ apiKey: config.qlooKey, baseUrl: config.qlooBase, cacheDir: "data/cache" });
const llm = createLlm(config);
const [entity] = await resolveEntities({ qloo, query: title, type });
console.error(`Resolved: ${entity.name} (${entity.id})`);
const brief = await buildBrief({
  input: { entity, goal: flag("goal"), ageBand: flag("age"), gender: flag("gender"), city: flag("city") },
  qloo, llm, emit: (e) => console.error(`  ${e.status.padEnd(8)} ${e.id.padEnd(9)} ${e.ms ?? ""}ms ${e.detail ?? ""}`),
});
const outDir = flag("out") ?? "data/briefs";
await mkdir(outDir, { recursive: true });
await writeFile(`${outDir}/${brief.id}.json`, redactor(config)(JSON.stringify(brief, null, 2)));
console.log(JSON.stringify({
  id: brief.id, headline: brief.editor.headline, summary: brief.editor.audienceSummary, angles: brief.editor.launchAngles, caveats: brief.editor.caveats,
  audience: { peak: brief.audience.peakAge, gender: brief.audience.gender?.text, genres: brief.audience.genres.map((t) => t.name), moods: brief.audience.moods.map((t) => t.name), traits: brief.audience.traits.map((t) => t.name) },
  mainstream: brief.sound.mainstream.map((a) => `${a.name} ${a.affinity}`), emerging: brief.sound.emerging.map((a) => `${a.name} ${a.affinity}`),
  partners: brief.partners.picks.map((p) => `${p.name} [${p.categoryLabel}] ${p.affinity} :: ${p.reason} ${p.warnings.length ? "!! " + p.warnings.join(" ") : ""}`),
  stats: brief.partners.stats, places: brief.places, timing: brief.timing && { direction: brief.timing.direction, delta: brief.timing.delta, from: brief.timing.from, to: brief.timing.to },
  cliche: brief.cliche && { brands: { llm: brief.cliche.brands.llm.map((b) => `${b.name}${b.found ? "" : " (not in Qloo)"} ${b.affinity ?? "-"}${b.inOurPicks ? " =ours" : ""}`), summary: brief.cliche.brands.summary }, artists: { llm: brief.cliche.artists.llm.map((b) => `${b.name}${b.found ? "" : " (not in Qloo)"} ${b.affinity ?? "-"}`), summary: brief.cliche.artists.summary } },
  calls: brief.provenance.length, cached: brief.provenance.filter((c) => c.cached).length, modules: brief.modules,
}, null, 1));
