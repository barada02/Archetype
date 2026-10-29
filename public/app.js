// Archetype front end: describe -> confirm -> watch it work -> brief.
// No framework. All text is inserted with textContent (never innerHTML).
const $ = (id) => document.getElementById(id);
// Images go through our server (see /img in server.mjs) so browser blockers cannot break them.
const imgSrc = (url) => `/img?u=${encodeURIComponent(url)}`;

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on")) el[key] = value;
    else el.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat(Infinity)) if (child != null && child !== false) el.append(child.nodeType ? child : document.createTextNode(child));
  return el;
}

const TYPE_LABELS = { book: "Book", movie: "Film", tv_show: "TV show", videogame: "Game", podcast: "Podcast", artist: "Artist", brand: "Brand" };
const AGE_LABELS = { "24_and_younger": "24 and under", "25_to_29": "25 to 29", "30_to_34": "30 to 34", "35_to_44": "35 to 44", "45_to_54": "45 to 54", "55_and_older": "55 and over" };
// Independent-scale releases, matching who Archetype is for: partnership leads at smaller studios and streamers.
const EXAMPLES = [
  { q: "Everything Everywhere All at Once", type: "movie", age: "25_to_29", city: "Los Angeles", goal: "Theatrical release co-marketing" },
  { q: "Talk to Me", type: "movie", age: "24_and_younger", city: "Chicago", goal: "Screening tour and pop-ups" },
  { q: "Past Lives", type: "movie", age: "30_to_34", city: "New York", goal: "Awards-season screenings and partners" },
  { q: "The Bear", type: "tv_show", age: "30_to_34", city: "Chicago", goal: "Season premiere brand tie-ins" },
];

let config, chosenType = "movie", candidates = [], formState = null;
const chosenCats = new Set();

async function api(path, body) {
  const res = await fetch(path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
}

function show(view) {
  for (const id of ["start", "confirm", "progress", "brief"]) $("view-" + id).hidden = id !== view;
  window.scrollTo({ top: 0 });
}

function toast(text) {
  const el = h("div", { class: "toast", role: "status" }, text);
  document.body.append(el);
  setTimeout(() => el.remove(), 2200);
}

// ---------- start ----------
function setType(type) {
  chosenType = type;
  for (const chip of $("typeChips").children) chip.setAttribute("aria-checked", String(chip.dataset.type === type));
}

function fillForm(ex) {
  $("q").value = ex.q; setType(ex.type);
  $("goal").value = ex.goal ?? ""; $("city").value = ex.city ?? ""; $("age").value = ex.age ?? ""; $("gender").value = ex.gender ?? "";
}

async function onFind(event) {
  event.preventDefault();
  const query = $("q").value.trim();
  if (!query) return;
  formState = {
    goal: $("goal").value.trim(), city: $("city").value.trim(), ageBand: $("age").value, gender: $("gender").value,
    categories: [...chosenCats], minScore: Number($("minScore").value),
  };
  $("findBtn").disabled = true; $("startMsg").textContent = "Searching the taste graph…";
  try {
    ({ candidates } = await api("/api/resolve", { query, type: chosenType }));
    if (!candidates.length) { $("startMsg").textContent = `No ${TYPE_LABELS[chosenType].toLowerCase()} found for "${query}". Try another spelling or kind.`; return; }
    renderCandidates();
    show("confirm");
  } catch (e) {
    $("startMsg").textContent = e.message;
  } finally {
    $("findBtn").disabled = false;
  }
}

function renderCandidates() {
  $("candidates").replaceChildren(...candidates.map((c, i) =>
    h("label", { class: "cand" },
      h("input", { type: "radio", name: "cand", value: String(i), checked: i === 0 }),
      c.image ? h("img", { src: imgSrc(c.image), alt: "", loading: "lazy" }) : h("div", { class: "thumb" }),
      h("div", {}, h("b", {}, c.name, c.year ? ` (${c.year})` : ""), h("span", {}, c.description || "No description"),
        h("span", {}, c.popularity != null ? `Popularity ${c.popularity}` : "")))));
  $("confirmMsg").textContent = "";
}

// ---------- build with live progress ----------
async function onBuild() {
  const picked = document.querySelector('input[name="cand"]:checked');
  const entity = candidates[Number(picked?.value ?? 0)];
  show("progress");
  $("steps").replaceChildren(); $("failure").hidden = true; $("meterFill").style.width = "4%";
  $("progTitle").textContent = `Building the co-marketing brief for ${entity.name}`;
  const rows = new Map();
  const EXPECTED_STEPS = 8; // profile, sound, timing, partners, places, editor, check, plain AI
  const finished = () => [...rows.values()].filter((r) => /\b(done|error|skipped)\b/.test(r.el.className)).length;
  const started = Date.now();
  const tick = setInterval(() => ($("elapsed").textContent = `${Math.round((Date.now() - started) / 1000)} s elapsed`), 500);
  const onProgress = (e) => {
    let row = rows.get(e.id);
    if (!row) {
      row = { el: h("div", { class: "step" }, h("span", { class: "dot" }), h("span", { class: "t" }, h("span", { class: "l" }), h("span", { class: "d" })), h("span", { class: "ms" })) };
      rows.set(e.id, row); $("steps").append(row.el);
    }
    row.el.className = "step " + e.status;
    row.el.querySelector(".l").textContent = e.label ?? e.id;
    if (e.detail) row.el.querySelector(".d").textContent = e.detail;
    row.el.querySelector(".ms").textContent = e.ms ? `${(e.ms / 1000).toFixed(1)} s` : "";
    row.el.querySelector(".dot").textContent = e.status === "done" ? "✓" : e.status === "error" || e.status === "skipped" ? "!" : "";
    $("meterFill").style.width = `${Math.max(4, (finished() / Math.max(EXPECTED_STEPS, rows.size)) * 100)}%`;
  };
  try {
    const brief = await streamBrief({ entity, ...formState }, onProgress);
    history.pushState({}, "", `/b/${brief.id}`);
    renderBrief(brief);
  } catch (e) {
    $("failure").hidden = false; $("failure").textContent = `Could not build the brief: ${e.message}`;
  } finally {
    clearInterval(tick);
  }
}

async function streamBrief(input, onProgress) {
  const res = await fetch("/api/brief", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
  const reader = res.body.getReader(), decoder = new TextDecoder();
  let buffer = "", result;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
      const event = /^event: (.+)$/m.exec(block)?.[1], data = /^data: (.+)$/m.exec(block)?.[1];
      if (!event || !data) continue;
      const payload = JSON.parse(data);
      if (event === "progress") onProgress(payload);
      else if (event === "done") result = payload;
      else if (event === "failure") throw new Error(payload.error);
    }
  }
  if (!result) throw new Error("The connection ended before the brief was ready.");
  return result;
}

// ---------- brief ----------
const fmt = (n) => (typeof n === "number" ? n.toFixed(2) : "-");
const bar = (value, scale = 1) => h("div", { class: "bar" }, h("i", { style: `left:0;width:${Math.max(2, Math.min(100, (value / scale) * 100))}%` }));
function divBar(value, max = 0.8) {
  const w = Math.min(50, (Math.abs(value) / max) * 50);
  return h("div", { class: "bar div" }, h("i", { class: value >= 0 ? "pos" : "neg", style: `width:${w}%` }));
}
const chips = (items) => h("div", { class: "chips" }, (items ?? []).map((t) => h("span", { class: "chip static" }, t.name)));
const scorePill = (v, floor) => h("span", { class: "score" + (floor != null && v < floor ? " low" : "") }, fmt(v));

function renderBrief(brief) {
  const { input, audience, sound, partners, places, timing, editor, cliche } = brief;
  const e = input.entity;
  // Ordered for a partnerships lead: the shortlist first, then the evidence behind it.
  const tabs = [
    ["partners", "Partner shortlist", panelPartners(brief)],
    ["audience", "Audience", panelAudience(brief)],
    ["sound", "Trailer and soundtrack", panelSound(sound)],
    ["where", "Screenings and timing", panelWhere(brief)],
    ["cliche", "Plain AI vs data", panelCliche(brief)],
    ["sources", "Sources", panelSources(brief)],
  ];
  const select = (key) => {
    for (const [k] of tabs) {
      $("tab-" + k).setAttribute("aria-selected", String(k === key));
      $("panel-" + k).hidden = k !== key;
    }
  };
  const target = [input.ageBand && AGE_LABELS[input.ageBand], input.gender && (input.gender === "female" ? "women" : "men")].filter(Boolean).join(", ");
  $("brief").replaceChildren(
    brief.sample ? h("div", { class: "samplebar" },
      h("span", {}, h("b", {}, "Sample brief. "), `Built from live Qloo data on ${new Date(brief.createdAt).toLocaleDateString()}. Everything below is real output.`),
      h("button", { class: "small primary", onclick: goHome }, "Build your own")) : "",
    h("div", { class: "bhead", style: e.image ? `--poster:url("${imgSrc(e.image)}")` : undefined },
      e.image ? h("img", { class: "thumb", src: imgSrc(e.image), alt: "" }) : h("div", { class: "thumb" }),
      h("div", { class: "grow" },
        h("div", { class: "meta" }, [TYPE_LABELS[e.type], input.goal, target && `Target: ${target}`, input.city].filter(Boolean).map((x) => h("span", { class: "chip static" }, x))),
        h("h1", {}, e.name),
        h("div", { class: "muted small" }, `Built ${new Date(brief.createdAt).toLocaleString()} from ${brief.provenance.length} Qloo calls`)),
      h("div", { class: "actions" },
        h("button", { class: "small", onclick: () => navigator.clipboard?.writeText(location.href).then(() => toast("Link copied")) }, "Copy link"),
        h("button", { class: "small", onclick: () => window.print() }, "Print / PDF"),
        h("a", { class: "small", href: `/api/brief/${brief.id}`, download: `archetype-${brief.id}.json` }, h("button", { class: "small" }, "JSON")),
        h("button", { class: "small primary", onclick: goHome }, "New brief"))),
    h("div", { class: "headline" }, h("b", {}, editor.headline), editor.source === "fallback" ? h("span", { class: "muted small" }, "Written without the language model (fallback text).") : ""),
    guide(brief),
    bento(brief, select),
    h("div", { class: "tabs", role: "tablist" }, tabs.map(([k, label]) => h("button", { class: "tab", id: "tab-" + k, role: "tab", "aria-selected": "false", onclick: () => select(k) }, label))),
    ...tabs.map(([k, , panel]) => h("div", { class: "panel", id: "panel-" + k, role: "tabpanel", hidden: true }, panel)),
  );
  select("partners");
  show("brief");
}

const goHome = () => { history.pushState({}, "", "/"); show("start"); };

// A small ⓘ with an explanation, shown on hover or keyboard focus (and tap, which focuses it).
const hint = (text) => h("span", { class: "hint", tabindex: "0", role: "img", "aria-label": text, "data-tip": text }, "ⓘ");

// "How to read this brief": open the first time, then remembers whether the viewer closed it.
function guide({ editor, model }) {
  let open = true;
  try { open = localStorage.getItem("guideOpen") !== "0"; } catch {}
  const el = h("details", { class: "guide", open },
    h("summary", {}, "How to read this brief"),
    h("ul", {},
      h("li", {}, h("b", {}, "Start with the tiles. "), "Each one opens the tab with the evidence behind it."),
      h("li", {}, h("b", {}, "Fit scores run from 0 to 1. "), "They are Qloo affinity: how strongly this audience is drawn to a brand or artist compared with people in general. Higher is a stronger fit."),
      h("li", {}, h("b", {}, "Age and gender values are skew indices, "), "measured against the average audience. They are not percentages."),
      h("li", {}, h("b", {}, "⚠ warnings "), "mean a partner's own customers skew a different age or gender than this audience."),
      h("li", {}, h("b", {}, "Where the AI is used. "), editor.source === "fallback"
        ? "This brief was built without the language model: the text is template text and partners are simply the best-ranked by fit."
        : `Qloo measured every number. The language model${model ? ` (${model})` : ""} wrote the headline, summary, angles and partner reasons, and chose partners only from Qloo's ranked list. Any text with a number it was not given is replaced.`)));
  el.addEventListener("toggle", () => { try { localStorage.setItem("guideOpen", el.open ? "1" : "0"); } catch {} });
  return el;
}

function renderSamples(list) {
  if (!list?.length) return;
  $("samples").hidden = false; $("heroCta").hidden = false;
  $("sampleBtn").onclick = () => openSample(list[0].id);
  $("sampleCards").replaceChildren(...list.map((s) => {
    const target = [s.ageBand && AGE_LABELS[s.ageBand], s.gender && (s.gender === "female" ? "women" : "men")].filter(Boolean).join(", ");
    return h("a", { class: "sample card", href: `/b/${s.id}`, onclick: (ev) => { ev.preventDefault(); openSample(s.id); } },
      s.image ? h("img", { src: imgSrc(s.image), alt: "", loading: "lazy" }) : h("div", { class: "thumb" }),
      h("div", { class: "body" },
        h("span", { class: "kicker" }, [TYPE_LABELS[s.type], s.goal].filter(Boolean).join(" · ")),
        h("b", {}, s.name),
        h("span", { class: "muted small" }, s.headline),
        h("span", { class: "muted small" }, [target && `Target: ${target}`, s.city].filter(Boolean).join(" · ")),
        h("span", { class: "open" }, "Open sample →")));
  }));
}
function openSample(id) { history.pushState({}, "", `/b/${id}`); loadSaved(id); }

// At-a-glance tiles above the tabs. Each one opens the tab with the evidence behind it.
function bento({ audience, partners, timing, cliche }, select) {
  const tile = (tab, wide, k, v, s) => h("button", { type: "button", class: "tile" + (wide ? " wide" : ""), onclick: () => { select(tab); $("tab-" + tab).scrollIntoView({ block: "nearest", behavior: "smooth" }); } },
    h("span", { class: "k" }, k), h("span", { class: "v" }, v), h("span", { class: "s" }, s));
  const top = [...partners.picks].sort((a, b) => (b.affinity ?? 0) - (a.affinity ?? 0))[0]; // highest measured fit, not the editor's first pick
  const flagged = partners.picks.filter((p) => p.warnings?.length).length;
  const clearPeak = (audience.peakAge?.value ?? 0) >= 0.1;
  const plain = cliche?.brands.summary;
  const trend = { rising: "Rising ↗", falling: "Falling ↘", steady: "Steady →" }[timing?.direction];
  const day = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  return h("div", { class: "bento" },
    tile("partners", true, "Top partner", top ? [top.name, scorePill(top.affinity)] : "None cleared the bar", top ? `${top.categoryLabel}. ${top.reason}` : "Lower the minimum fit score and rebuild."),
    tile("audience", false, "Audience peak", clearPeak ? audience.peakAge.label : "No clear peak", audience.gender?.text ?? "Gender lean unclear"),
    tile("where", false, "Launch window", trend ?? "No trend", trend ? `Interest from ${day(timing.from)} to ${day(timing.to)}` : "Qloo has no trend series for this kind."),
    tile("cliche", true, "Plain AI vs data", plain ? `${plain.llmBelowOurFloor} of ${plain.scored} below our picks` : "Not run",
      plain ? "Brands a plain AI suggested that scored below the lowest data-backed pick for this audience." : "Needs a language-model key."),
    tile("partners", true, "Shortlist", `${partners.picks.length} partners`, flagged ? `${flagged} flagged: the brand's own customers skew differently.` : "None flagged against their own customers."));
}

function ageSentence(audience) {
  const gender = audience.gender ? `${audience.gender.text}` : "";
  if (!audience.peakAge) return gender ? `Gender: ${gender}.` : "";
  const clear = audience.peakAge.value >= 0.1;
  return `${clear ? `Peaks at ${audience.peakAge.label}` : "Age profile is flat, with no clear peak"}${gender ? `; ${gender}` : ""}.`;
}

function panelAudience({ audience, editor }) {
  const ages = Object.keys(AGE_LABELS).filter((b) => typeof audience.ageIndex[b] === "number");
  const male = audience.genderIndex.male;
  return [
    h("p", {}, editor.audienceSummary),
    editor.launchAngles.length ? h("div", {}, h("h3", {}, "Co-marketing angles"), editor.launchAngles.map((a) => h("div", { class: "callout" }, a))) : "",
    editor.caveats.length ? h("p", { class: "warnbox" }, "Watch out: ", editor.caveats.join(" ")) : "",
    h("div", { class: "cols" },
      h("div", { class: "card" },
        h("h2", {}, "Who they are ", hint("Each bar compares this audience with the average audience. Right of the centre line means over-represented, left means under-represented. These are indices, not percentages.")),
        h("p", { class: "muted small" }, "Skew index against the average audience. Right of the line over-indexes, left under-indexes. Not a percentage."),
        ages.map((b) => h("div", { class: "kv" }, AGE_LABELS[b], divBar(audience.ageIndex[b]), h("span", { class: "num" }, audience.ageIndex[b].toFixed(2)))),
        typeof male === "number" ? h("div", { class: "kv" }, h("span", { style: "white-space:nowrap" }, "Women ◂ Men ▸"), divBar(male), h("span", { class: "num" }, male.toFixed(2))) : "",
        h("p", { class: "small" }, ageSentence(audience))),
      h("div", { class: "card" },
        h("h2", {}, "What they love"),
        audience.genres.length ? [h("h3", {}, "Genres"), chips(audience.genres)] : "",
        audience.moods.length ? [h("h3", {}, "Mood"), chips(audience.moods)] : "",
        audience.traits.length ? [h("h3", {}, "Audience traits"), chips(audience.traits)] : "",
        audience.lifestyle.length ? [h("h3", {}, "Lifestyle"), chips(audience.lifestyle)] : "")),
  ];
}

function artistList(items) {
  return h("div", { class: "list" }, items.length ? items.map((a) =>
    h("div", { class: "it" }, a.image ? h("img", { class: "thumb", style: "width:36px;height:36px", src: imgSrc(a.image), alt: "", loading: "lazy" }) : "",
      h("span", { class: "n" }, a.name), h("div", { style: "width:90px" }, bar(a.affinity)), h("span", { class: "num" }, fmt(a.affinity)))) : h("span", { class: "muted" }, "None returned."));
}
const panelSound = (sound) => h("div", { class: "cols" },
  h("div", { class: "card" }, h("h2", {}, "Mainstream"), h("p", { class: "muted small" }, "Artists whose fans overlap most with this audience. Candidates for trailer sync, soundtrack and premiere playlists."), artistList(sound.mainstream)),
  h("div", { class: "card" }, h("h2", {}, "Emerging"), h("p", { class: "muted small" }, "Same audience, popularity capped. More affordable for sync deals, premieres and live appearances."), artistList(sound.emerging)));

function panelPartners({ partners, input }) {
  const groups = new Map();
  for (const p of partners.picks) groups.set(p.categoryLabel, [...(groups.get(p.categoryLabel) ?? []), p]);
  const s = partners.stats;
  const pickedIds = new Set(partners.picks.map((p) => p.id));
  const others = partners.candidates.filter((c) => !pickedIds.has(c.id));
  return [
    h("p", { class: "muted small" }, `Ranked by measured fit for ${input.ageBand || input.gender ? "the target audience" : "this audience"}. Dropped ${s.mediaBrands ?? 0} media brands and ${s.belowScore ?? 0} below the minimum fit of ${s.minScore}. Each partner's own audience is checked against this one.`, " ", hint("Fit is Qloo affinity from 0 to 1: how strongly this audience is drawn to the brand compared with people in general. Higher is a stronger fit.")),
    !partners.picks.length ? h("p", { class: "warnbox" }, "No partners cleared the minimum fit score. Lower it under Partner categories and minimum fit.") : "",
    ...[...groups].map(([label, list]) => h("div", { class: "card pcat" }, h("h2", {}, label), list.map((p) =>
      h("div", { class: "pcard" },
        p.image ? h("img", { class: "thumb", src: imgSrc(p.image), alt: "", loading: "lazy" }) : h("div", { class: "thumb" }),
        h("div", { class: "body" },
          h("div", {}, h("span", { class: "nm" }, p.name), scorePill(p.affinity)),
          h("div", {}, p.reason),
          h("div", { class: "chips", style: "margin-top:4px" }, [p.brandType, ...p.industries].filter(Boolean).map((x) => h("span", { class: "chip static" }, x))),
          p.audience ? h("div", { class: "muted small" }, `Its own audience peaks at ${p.audience.peakAge?.label ?? "unclear"}, ${p.audience.gender?.text ?? "unclear gender"}.`) : "",
          p.warnings.map((w) => h("div", { class: "warn" }, "⚠ " + w)))))),
    ),
    others.length ? h("details", {}, h("summary", {}, `Other candidates that cleared the bar (${others.length})`),
      h("div", { class: "chips", style: "margin-top:8px" }, others.map((c) => h("span", { class: "chip static", title: c.categoryLabel }, `${c.name} ${fmt(c.affinity)}`)))) : "",
  ];
}

function sparkline(series) {
  const ns = "http://www.w3.org/2000/svg", W = 600, H = 120, pad = 10;
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.setAttribute("class", "spark"); svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("role", "img"); svg.setAttribute("aria-label", "Weekly popularity percentile over time");
  const vals = series.map((p) => p.population_percentile), lo = Math.min(...vals), hi = Math.max(...vals), span = Math.max(hi - lo, 0.02);
  const pts = series.map((p, i) => `${pad + (i / Math.max(series.length - 1, 1)) * (W - 2 * pad)},${H - pad - ((p.population_percentile - lo) / span) * (H - 2 * pad)}`).join(" ");
  const line = document.createElementNS(ns, "polyline");
  line.setAttribute("points", pts); line.setAttribute("fill", "none"); line.setAttribute("stroke", "var(--accent)"); line.setAttribute("stroke-width", "3"); line.setAttribute("vector-effect", "non-scaling-stroke");
  svg.append(line);
  return svg;
}

function panelWhere({ places, timing, modules, input }) {
  const timingBlock = timing
    ? [h("p", {}, `Interest is ${timing.direction} between ${timing.from} and ${timing.to}.`, ` Popularity percentile moved ${timing.delta >= 0 ? "+" : ""}${timing.delta} from the first third of the period to the last third.`),
       sparkline(timing.series), h("p", { class: "muted small" }, "Weekly popularity percentile from Qloo. Higher means more popular than a larger share of titles. ", hint("Rising, steady or falling compares the average of the last third of the period with the first third."))]
    : h("p", { class: "muted" }, modules.timing?.reason ?? modules.timing?.error ?? "No trend data.");
  const placeBlock = places
    ? [h("div", { class: "cols" },
        h("div", { class: "card" }, h("h2", {}, `Venues fans favor in ${places.city}`), h("div", { class: "list" }, places.venues.map((v) =>
          h("div", { class: "it" }, h("span", { class: "n" }, v.name, h("div", { class: "muted small" }, v.description)), h("span", { class: "num" }, fmt(v.affinity)))))),
        h("div", { class: "card" }, h("h2", {}, "Where fans concentrate"), h("div", { class: "list" }, places.neighborhoods.length ? places.neighborhoods.map((n) =>
          h("div", { class: "it" }, h("span", { class: "n" }, n.name), h("div", { style: "width:90px" }, bar(n.affinity)), h("span", { class: "num" }, fmt(n.affinity)))) : h("span", { class: "muted" }, "No named neighborhoods returned.")),
          h("p", { class: "muted small" }, "Heatmap areas are coarse (boroughs and districts), so use them to shortlist, not to rank streets.")))]
    : h("p", { class: "muted" }, input.city ? "No place data returned." : "Add a city on the first screen to see venues and neighborhoods for screenings and pop-ups.");
  return [h("h3", {}, "Launch window"), timingBlock, h("h3", {}, "Screenings and pop-ups"), placeBlock];
}

function clicheColumn(title, subtitle, rows, floor, ours) {
  return h("div", { class: "card" }, h("h2", {}, title), h("p", { class: "muted small" }, subtitle),
    h("div", { class: "list" }, rows.map((r) => h("div", { class: "it" },
      h("span", { class: "n" }, r.name, r.found === false ? h("span", { class: "muted small" }, " (not in Qloo)") : "", r.inOurPicks ? h("span", { class: "muted small" }, " (also in our picks)") : ""),
      typeof r.affinity === "number" ? scorePill(r.affinity, ours ? undefined : floor) : h("span", { class: "muted small" }, "no score")))));
}

function panelCliche({ cliche, input, model }) {
  if (!cliche) return h("p", { class: "muted" }, "The plain AI vs data comparison needs a language-model key and was skipped.");
  const block = (label, data) => {
    const s = data.summary;
    const floor = Math.min(...data.ours.map((o) => o.affinity).filter((v) => typeof v === "number"));
    return [h("h3", {}, label),
      h("div", { class: "verdict" }, `The plain model named ${data.llm.length}; Qloo could score ${s.scored}${s.notInQloo ? ` (${s.notInQloo} not found in Qloo)` : ""}. Their average fit is ${fmt(s.llmAverage)} against ${fmt(s.oursAverage)} for the data-backed picks; ${s.llmBelowOurFloor} of ${s.scored} fall below our lowest pick. ${s.overlap ? `${s.overlap} overlap with our picks.` : "None overlap with our picks."}`),
      h("div", { class: "cols" }, clicheColumn("Plain model guessed", "No data, just its own knowledge.", data.llm, floor), clicheColumn("Archetype picks", "Chosen from measured audience fit.", data.ours, floor, true))];
  };
  return [
    h("p", { class: "muted small" }, `Same question, asked of ${model ?? "the language model"} with no data: "${cliche.prompt}" Each suggestion was then looked up in Qloo and scored against this audience. Our picks were selected from that same ranking, so read this as "does the guess hold up in the data", not as an independent contest.`, " ", hint("A plain AI was asked for partners with no data. Each name it gave was looked up in Qloo and scored for this audience. A guess below our lowest pick is one the data does not support.")),
    block("Partner brands", cliche.brands), block("Artists", cliche.artists),
  ];
}

function panelSources({ provenance, modules }) {
  return [
    h("p", { class: "muted small" }, "Every number in this brief comes from one of these calls. The language model only wrote the prose, and any text containing numbers it was not given was replaced."),
    h("div", { class: "chips" }, Object.entries(modules).map(([k, v]) => h("span", { class: "chip static" }, `${k}: ${v.status}${v.ms ? ` ${(v.ms / 1000).toFixed(1)} s` : ""}${v.reason ? ` (${v.reason})` : ""}`))),
    h("div", { class: "scroll" }, h("table", {},
      h("thead", {}, h("tr", {}, ["Module", "Endpoint", "Parameters", "Status", "ms"].map((x) => h("th", {}, x)))),
      h("tbody", {}, provenance.map((c) => h("tr", {}, h("td", {}, c.module), h("td", { class: "mono" }, c.path), h("td", { class: "mono" }, c.query),
        h("td", {}, c.status), h("td", {}, c.cached ? "cached" : c.ms)))))),
  ];
}

// ---------- init ----------
async function loadSaved(id) {
  show("progress"); $("progTitle").textContent = "Loading brief"; $("steps").replaceChildren();
  try { renderBrief(await api(`/api/brief/${id}`)); }
  catch (e) { $("failure").hidden = false; $("failure").textContent = e.message; }
}

async function init() {
  const root = document.documentElement;
  try { const saved = localStorage.getItem("theme"); if (saved) root.dataset.theme = saved; } catch {}
  $("themeBtn").onclick = () => {
    const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    root.dataset.theme = dark ? "light" : "dark";
    try { localStorage.setItem("theme", root.dataset.theme); } catch {}
  };
  $("startForm").onsubmit = onFind;
  $("ctaBtn").onclick = () => { $("startForm").scrollIntoView({ behavior: "smooth", block: "center" }); $("q").focus({ preventScroll: true }); };
  $("backBtn").onclick = () => show("start");
  $("buildBtn").onclick = onBuild;
  window.onpopstate = () => location.reload();
  try {
    config = await api("/api/config");
  } catch (e) { $("startMsg").textContent = e.message; return; }
  $("typeChips").replaceChildren(...config.types.map((t) => h("button", { type: "button", class: "chip", role: "radio", "data-type": t, "aria-checked": "false", onclick: () => setType(t) }, TYPE_LABELS[t] ?? t)));
  setType("movie");
  for (const b of config.ageBands) $("age").append(new Option(AGE_LABELS[b] ?? b, b));
  $("catChips").replaceChildren(...config.categories.map((c) => {
    chosenCats.add(c.key);
    const chip = h("button", { type: "button", class: "chip", role: "checkbox", "aria-checked": "true", onclick: () => {
      if (chosenCats.has(c.key)) chosenCats.delete(c.key); else chosenCats.add(c.key);
      chip.setAttribute("aria-checked", String(chosenCats.has(c.key)));
    } }, c.label);
    return chip;
  }));
  $("minScore").value = config.minScore; $("minScoreOut").textContent = fmt(config.minScore);
  $("minScore").oninput = () => ($("minScoreOut").textContent = fmt(Number($("minScore").value)));
  $("examples").replaceChildren(...EXAMPLES.map((ex) => h("button", { type: "button", class: "ex", onclick: () => { fillForm(ex); $("q").focus(); } }, h("span", {}, TYPE_LABELS[ex.type]), ex.q)));
  if (!config.hasQloo) $("startMsg").textContent = "QLOO_API_KEY is missing on the server.";
  else if (!config.hasLlm) $("startMsg").textContent = "META_API_KEY and BASETEN_API_KEY are missing: briefs will use fallback text and skip the plain AI vs data comparison.";
  renderSamples(config.samples);
  const saved = /^\/b\/([0-9a-f]{12})$/.exec(location.pathname);
  if (saved) loadSaved(saved[1]);
}
init();
