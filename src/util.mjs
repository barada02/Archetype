// Small pure helpers, kept separate so they can be unit tested.

export const AGE_BANDS = ["24_and_younger", "25_to_29", "30_to_34", "35_to_44", "45_to_54", "55_and_older"];
export const AGE_LABELS = {
  "24_and_younger": "24 and under",
  "25_to_29": "25 to 29",
  "30_to_34": "30 to 34",
  "35_to_44": "35 to 44",
  "45_to_54": "45 to 54",
  "55_and_older": "55 and over",
};

export const normName = (s) =>
  String(s ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

export const stripMarkup = (html) =>
  String(html ?? "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();

export const clip = (text, max) => {
  const s = stripMarkup(text);
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
};

export const round = (n, digits = 3) => (typeof n === "number" && Number.isFinite(n) ? Number(n.toFixed(digits)) : undefined);

export const hasDigits = (s) => /\d/.test(String(s ?? ""));

export const isoDate = (date) => date.toISOString().slice(0, 10);

// Inclusive window ending today, `days` long, as YYYY-MM-DD.
export function dateWindow(now = new Date(), days = 182) {
  const end = new Date(now);
  const start = new Date(now.getTime() - days * 86400000);
  return { start: isoDate(start), end: isoDate(end) };
}

// Qloo demographic values are indices (positive = over-indexes vs average), not percentages.
export function peakAge(ageIndex = {}) {
  const entries = AGE_BANDS.filter((b) => typeof ageIndex[b] === "number").map((b) => [b, ageIndex[b]]);
  if (!entries.length) return undefined;
  const [band, value] = entries.reduce((best, cur) => (cur[1] > best[1] ? cur : best));
  return { band, label: AGE_LABELS[band], value: round(value) };
}

export function genderLean(genderIndex = {}) {
  const male = genderIndex.male, female = genderIndex.female;
  if (typeof male !== "number" && typeof female !== "number") return undefined;
  const value = typeof male === "number" ? male : -female; // positive = male
  const size = Math.abs(value);
  const side = value > 0 ? "male" : "female";
  if (size < 0.05) return { side: "balanced", strength: "balanced", value: round(value), text: "gender-balanced" };
  const strength = size < 0.2 ? "slight" : "strong";
  return { side, strength, value: round(value), text: `${strength === "slight" ? "slightly " : "strongly "}${side}-leaning` };
}

// points: [{date, population_percentile}], any order. Compares first and last third.
export function trendDirection(points = []) {
  const series = points
    .filter((p) => p?.date && typeof p.population_percentile === "number")
    .sort((a, b) => a.date.localeCompare(b.date));
  if (series.length < 6) return { direction: "unknown", series };
  const third = Math.max(2, Math.floor(series.length / 3));
  const mean = (arr) => arr.reduce((s, p) => s + p.population_percentile, 0) / arr.length;
  const delta = mean(series.slice(-third)) - mean(series.slice(0, third));
  const direction = Math.abs(delta) < 0.02 ? "steady" : delta > 0 ? "rising" : "falling";
  return { direction, delta: round(delta, 4), from: series[0].date, to: series.at(-1).date, series };
}

// Compare a brand's own audience with the target audience; return plain-language warnings.
export function skewWarnings(audience, brandDemo) {
  const warnings = [];
  const aG = audience?.gender?.value, bG = brandDemo?.gender?.male;
  if (typeof aG === "number" && typeof bG === "number" && Math.abs(aG) >= 0.15 && Math.abs(bG) >= 0.15 && Math.sign(aG) !== Math.sign(bG)) {
    warnings.push(`Brand audience skews ${bG > 0 ? "male" : "female"}, this audience skews ${aG > 0 ? "male" : "female"}.`);
  }
  // Age is compared only when both audiences have a clear peak, not a flat profile.
  const aAge = (audience?.peakAge?.value ?? 0) >= 0.1 ? audience.peakAge.band : undefined;
  const brandPeak = peakAge(brandDemo?.age), bPeak = (brandPeak?.value ?? 0) >= 0.1 ? brandPeak.band : undefined;
  if (aAge && bPeak) {
    const gap = Math.abs(AGE_BANDS.indexOf(aAge) - AGE_BANDS.indexOf(bPeak));
    if (gap >= 2) warnings.push(`Brand audience peaks at ${AGE_LABELS[bPeak]}, this audience at ${AGE_LABELS[aAge]}.`);
  }
  return warnings;
}

// Run async tasks with a concurrency limit; results keep input order.
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
