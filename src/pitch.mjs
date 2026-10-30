// Per-brand outreach drafts. The model writes a short pitch email from one brief's
// measured data; any number it was not given is replaced by deterministic fallback
// text, the same rule as the editor step. Without a language-model key the
// fallback alone is returned, so drafts always work on saved and sample briefs.
import { clip } from "./util.mjs";
import { unsupportedNumbers } from "./chat.mjs";

export const PITCH_SYSTEM = [
  "You are a partnerships lead writing a first outreach email to a brand's partnerships team about a co-marketing deal around a film or TV release.",
  "Use only the DATA below. Never invent numbers, statistics, percentages, audience claims or facts that are not in it.",
  "You may quote the partner's fit score exactly once, as a fit score from 0 to 1. Never turn scores or skew values into percentages.",
  "Keep it short, concrete and human: why this brand fits this audience, one co-marketing idea grounded in the data, one ask for a 15-minute intro call.",
  "Answer with JSON only.",
].join(" ");

export function pitchData({ brief, pick }) {
  const { input, audience } = brief;
  const target = [input.ageBand?.replace(/_/g, " "), input.gender].filter(Boolean).join(", ") || "the title's own audience";
  return {
    release: {
      title: input.entity.name, kind: input.entity.type,
      goal: input.goal || "release co-marketing", target, city: input.city ?? "none given",
    },
    audience: {
      peakAge: audience.peakAge?.label,
      ageProfile: (audience.peakAge?.value ?? 0) >= 0.1 ? "clear peak" : "flat, no clear peak",
      gender: audience.gender?.text,
      genres: (audience.genres ?? []).map((t) => t.name),
      moods: (audience.moods ?? []).map((t) => t.name),
      traits: (audience.traits ?? []).map((t) => t.name),
    },
    partner: {
      name: pick.name, category: pick.categoryLabel, fit: pick.affinity, type: pick.brandType,
      industries: pick.industries, about: pick.description, reason: pick.reason,
      ownAudience: pick.audience && { peakAge: pick.audience.peakAge?.label, gender: pick.audience.gender?.text },
    },
  };
}

export function pitchPrompt({ brief, pick }) {
  return [
    "DATA:", JSON.stringify(pitchData({ brief, pick })),
    "",
    "Return JSON with exactly this shape:",
    '{"subject": "one line, at most 12 words", "body": "at most 180 words, plain paragraphs separated by blank lines, no placeholders like [Name]"}',
  ].join("\n");
}

export function fallbackPitch({ brief, pick }) {
  const data = pitchData({ brief, pick });
  const angle = data.audience.genres[0] ? ` Its audience leans into ${data.audience.genres.slice(0, 3).join(", ")}.` : "";
  return {
    subject: `Partnership idea: ${pick.name} x ${data.release.title}`,
    body: [
      `Hi ${pick.name} partnerships team, we're planning ${data.release.goal} for ${data.release.kind.replace("_", " ")} "${data.release.title}" and your brand came up top of our shortlist.`,
      `Fans of the title over-index on ${pick.name} with a fit score of ${pick.affinity} out of 1 in the Qloo taste graph.${angle} ${pick.reason ?? ""}`.trim(),
      "Would you be open to a 15-minute intro call next week to explore a tie-in?",
    ].join("\n\n"),
  };
}

// Turns raw model output into a safe draft. Numbers are allowed only when they
// appear in the data the model was given (the fit score, title digits); fields
// with anything else fall back to deterministic text. source says what happened.
export function validatePitch(raw, { brief, pick }) {
  const data = pitchData({ brief, pick });
  const context = JSON.stringify(data);
  const fallback = fallbackPitch({ brief, pick });
  const clean = (text, max, fallbackText) => {
    const s = clip(text, max);
    return s && !unsupportedNumbers(s, context).length ? s : fallbackText;
  };
  const subject = clean(raw?.subject, 140, fallback.subject);
  const body = clean(raw?.body, 2200, fallback.body);
  const usedFallback = subject === fallback.subject || body === fallback.body;
  return { subject, body, source: raw ? (usedFallback ? "llm+fallback" : "llm") : "fallback" };
}
