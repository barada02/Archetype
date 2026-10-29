// The editor step: the LLM reads the measured data and picks and explains partners.
// Numbers never come from the model. Its output is validated against the candidate
// list, and any text that contains a number not in the title is replaced by a
// deterministic fallback.
import { clip, hasDigits } from "./util.mjs";

export const MAX_PICKS = 8;
export const MAX_PER_CATEGORY = 2;

export const EDITOR_SYSTEM = [
  "You are a brand-partnership strategist writing a cultural-fit brief.",
  "You are given measured audience data and a list of candidate partner brands. Use only that data.",
  "Never invent facts, numbers, statistics or percentages. Do not write any digits at all, except digits that are part of the title.",
  "Describe the data qualitatively (for example: over-indexes with, skews, fits, leans).",
  "Do not say the audience skews older or younger unless ageProfile is a clear peak. Skip candidates that look generic, off-category or wrong for the goal. Prefer partners an audience would accept as authentic.",
  "Answer with JSON only.",
].join(" ");

export function editorPrompt({ entity, goal, target, audience, candidates, sound }) {
  const data = {
    title: entity.name,
    kind: entity.type,
    goal: goal || "general launch",
    target: target || "the title's own audience",
    audience: {
      peakAge: audience.peakAge?.label,
      ageProfile: (audience.peakAge?.value ?? 0) >= 0.1 ? "clear peak" : "flat, no clear peak",
      gender: audience.gender?.text,
      genres: audience.genres.map((t) => t.name),
      moods: audience.moods.map((t) => t.name),
      traits: audience.traits.map((t) => t.name),
    },
    artistsFansAlsoLove: sound.mainstream.slice(0, 5).map((a) => a.name),
    emergingArtists: sound.emerging.slice(0, 5).map((a) => a.name),
    candidates: candidates.map((c) => ({
      id: c.id, name: c.name, category: c.category, fit: c.affinity, type: c.brandType,
      industries: c.industries, about: c.description,
    })),
  };
  return [
    "DATA:", JSON.stringify(data),
    "",
    "Return JSON with exactly this shape:",
    '{"headline": "one sentence, at most 18 words", "audienceSummary": "two sentences on who this audience is and what they accept as authentic",',
    ' "launchAngles": ["three short creative angles grounded in the data"],',
    ` "partnerPicks": [{"id": "candidate id", "reason": "at most 22 words on why this brand fits this audience"}],`,
    ' "caveats": ["zero to three honest limits or risks"]}',
    `Pick at most ${MAX_PICKS} partners and at most ${MAX_PER_CATEGORY} per category, using only candidate ids.`,
  ].join("\n");
}

// Digits are allowed only when they appear in the title itself (for example "Fast & Furious 6").
export function unsupportedDigits(text, title = "") {
  const allowed = new Set(String(title).match(/\d+/g) ?? []);
  return (String(text ?? "").match(/\d+/g) ?? []).some((d) => !allowed.has(d));
}

const cleanText = (text, title, max) => {
  const s = clip(text, max);
  return s && !unsupportedDigits(s, title) ? s : "";
};

export function fallbackReason(candidate, title) {
  const where = candidate.industries?.slice(0, 2).join(" and ") || candidate.category;
  return `Over-indexes with fans of ${title}, in ${where.toLowerCase()}.`;
}

export function fallbackPicks(candidates, limit = MAX_PICKS) {
  const perCategory = new Map();
  const picks = [];
  for (const c of [...candidates].sort((a, b) => b.affinity - a.affinity)) {
    const n = perCategory.get(c.category) ?? 0;
    if (n >= MAX_PER_CATEGORY || picks.length >= limit) continue;
    perCategory.set(c.category, n + 1);
    picks.push({ id: c.id });
  }
  return picks;
}

// Turns raw model output into a safe editor block. source says where the prose came from.
export function validateEditor(raw, { candidates, entity, audience }) {
  const title = entity.name;
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const seen = new Set();
  const perCategory = new Map();
  const picks = [];
  for (const p of Array.isArray(raw?.partnerPicks) ? raw.partnerPicks : []) {
    const c = byId.get(p?.id);
    if (!c || seen.has(c.id)) continue;
    const n = perCategory.get(c.category) ?? 0;
    if (n >= MAX_PER_CATEGORY || picks.length >= MAX_PICKS) continue;
    seen.add(c.id);
    perCategory.set(c.category, n + 1);
    picks.push({ id: c.id, reason: cleanText(p.reason, title, 200) || fallbackReason(c, title) });
  }
  const usable = picks.length > 0;
  const finalPicks = usable ? picks : fallbackPicks(candidates).map((p) => ({ id: p.id, reason: fallbackReason(byId.get(p.id), title) }));
  const lean = audience.gender?.text ? `, ${audience.gender.text}` : "";
  const angles = (Array.isArray(raw?.launchAngles) ? raw.launchAngles : []).map((a) => cleanText(a, title, 160)).filter(Boolean).slice(0, 3);
  const caveats = (Array.isArray(raw?.caveats) ? raw.caveats : []).map((a) => cleanText(a, title, 200)).filter(Boolean).slice(0, 3);
  return {
    source: raw ? "llm" : "fallback",
    headline: cleanText(raw?.headline, title, 200) || `${title}: who the audience is and which partners they would accept.`,
    audienceSummary:
      cleanText(raw?.audienceSummary, title, 420) ||
      `${(audience.peakAge?.value ?? 0) >= 0.1 ? `Audience peaks at ${audience.peakAge.label}` : "Age profile is flat"}${lean}. Partners below are ranked by measured fit.`,
    launchAngles: angles,
    caveats,
    picks: finalPicks,
  };
}
