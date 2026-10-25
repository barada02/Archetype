// Archetype front end: describe -> confirm -> watch it work -> brief.
// No framework. All text is inserted with textContent (never innerHTML).
const $ = (id) => document.getElementById(id);

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
const EXAMPLES = [
  { q: "The Secret History", type: "book", age: "25_to_29", city: "New York", goal: "Series adaptation launch" },
  { q: "Elden Ring", type: "videogame", age: "25_to_29", goal: "Merch and sponsor partnerships" },
  { q: "Huberman Lab", type: "podcast", goal: "Find sponsors" },
  { q: "Dune", type: "movie", goal: "Brand collaboration" },
];

let config, chosenType = "book", candidates = [], formState = null;
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
      c.image ? h("img", { src: c.image, alt: "", loading: "lazy" }) : h("div", { class: "thumb" }),
      h("div", {}, h("b", {}, c.name, c.year ? ` (${c.year})` : ""), h("span", {}, c.description || "No description"),
        h("span", {}, c.popularity != null ? `Popularity ${c.popularity}` : "")))));
  $("confirmMsg").textContent = "";
}

// ---------- build with live progress ----------
async function onBuild() {
  const picked = document.querySelector('input[name="cand"]:checked');
  const entity = candidates[Number(picked?.value ?? 0)];
  show("progress");
  $("steps").replaceChildren(); $("failure").hidden = true;
  $("progTitle").textContent = `Building the brief for ${entity.name}`;
  const rows = new Map();
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
  const tabs = [
    ["audience", "Audience DNA", panelAudience(brief)],
    ["sound", "Sound and talent", panelSound(sound)],
    ["partners", "Partners", panelPartners(brief)],
    ["where", "Cities and timing", panelWhere(brief)],
    ["cliche", "Cliché check", panelCliche(brief)],
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
    h("div", { class: "bhead" },
      e.image ? h("img", { class: "thumb", src: e.image, alt: "" }) : h("div", { class: "thumb" }),
      h("div", { class: "grow" },
        h("h1", {}, e.name),
        h("div", { class: "muted small" }, [TYPE_LABELS[e.type], input.goal, target && `target: ${target}`, input.city].filter(Boolean).join(" · ")),
        h("div", { class: "muted small" }, `Built ${new Date(brief.createdAt).toLocaleString()} from ${brief.provenance.length} Qloo calls`)),
      h("div", { class: "actions" },
        h("button", { class: "small", onclick: () => navigator.clipboard?.writeText(location.href).then(() => toast("Link copied")) }, "Copy link"),
        h("button", { class: "small", onclick: () => window.print() }, "Print / PDF"),
        h("a", { class: "small", href: `/api/brief/${brief.id}`, download: `archetype-${brief.id}.json` }, h("button", { class: "small" }, "JSON")),
        h("button", { class: "small primary", onclick: () => { history.pushState({}, "", "/"); show("start"); } }, "New brief"))),
    h("div", { class: "headline" }, h("b", {}, editor.headline), editor.source === "fallback" ? h("span", { class: "muted small" }, "Written without Gemini (fallback text).") : ""),
    h("div", { class: "tabs", role: "tablist" }, tabs.map(([k, label]) => h("button", { class: "tab", id: "tab-" + k, role: "tab", "aria-selected": "false", onclick: () => select(k) }, label))),
    ...tabs.map(([k, , panel]) => h("div", { class: "panel", id: "panel-" + k, role: "tabpanel", hidden: true }, panel)),
  );
  select("partners");
  show("brief");
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
    editor.launchAngles.length ? h("div", {}, h("h3", {}, "Launch angles"), editor.launchAngles.map((a) => h("div", { class: "callout" }, a))) : "",
    editor.caveats.length ? h("p", { class: "warnbox" }, "Watch out: ", editor.caveats.join(" ")) : "",
    h("div", { class: "cols" },
      h("div", { class: "card" },
        h("h2", {}, "Who they are"),
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
    h("div", { class: "it" }, a.image ? h("img", { class: "thumb", style: "width:36px;height:36px", src: a.image, alt: "", loading: "lazy" }) : "",
      h("span", { class: "n" }, a.name), h("div", { style: "width:90px" }, bar(a.affinity)), h("span", { class: "num" }, fmt(a.affinity)))) : h("span", { class: "muted" }, "None returned."));
}
const panelSound = (sound) => h("div", { class: "cols" },
  h("div", { class: "card" }, h("h2", {}, "Mainstream"), h("p", { class: "muted small" }, "Artists whose fans overlap most with this audience. Good for trailers and playlists."), artistList(sound.mainstream)),
  h("div", { class: "card" }, h("h2", {}, "Emerging"), h("p", { class: "muted small" }, "Same audience, popularity capped. Affordable and fresh."), artistList(sound.emerging)));

function panelPartners({ partners, input }) {
  const groups = new Map();
  for (const p of partners.picks) groups.set(p.categoryLabel, [...(groups.get(p.categoryLabel) ?? []), p]);
  const s = partners.stats;
  const pickedIds = new Set(partners.picks.map((p) => p.id));
  const others = partners.candidates.filter((c) => !pickedIds.has(c.id));
  return [
    h("p", { class: "muted small" }, `Ranked by measured fit for ${input.ageBand || input.gender ? "the target audience" : "this audience"}. Dropped ${s.mediaBrands ?? 0} media brands and ${s.belowScore ?? 0} below the minimum fit of ${s.minScore}. Each partner's own audience is checked against this one.`),
    !partners.picks.length ? h("p", { class: "warnbox" }, "No partners cleared the minimum fit score. Lower it under Partner categories and minimum fit.") : "",
    ...[...groups].map(([label, list]) => h("div", { class: "card pcat" }, h("h2", {}, label), list.map((p) =>
      h("div", { class: "pcard" },
        p.image ? h("img", { class: "thumb", src: p.image, alt: "", loading: "lazy" }) : h("div", { class: "thumb" }),
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
       sparkline(timing.series), h("p", { class: "muted small" }, "Weekly popularity percentile from Qloo. Higher means more popular than a larger share of titles.")]
    : h("p", { class: "muted" }, modules.timing?.reason ?? modules.timing?.error ?? "No trend data.");
  const placeBlock = places
    ? [h("div", { class: "cols" },
        h("div", { class: "card" }, h("h2", {}, `Venues in ${places.city}`), h("div", { class: "list" }, places.venues.map((v) =>
          h("div", { class: "it" }, h("span", { class: "n" }, v.name, h("div", { class: "muted small" }, v.description)), h("span", { class: "num" }, fmt(v.affinity)))))),
        h("div", { class: "card" }, h("h2", {}, "Where fans concentrate"), h("div", { class: "list" }, places.neighborhoods.length ? places.neighborhoods.map((n) =>
          h("div", { class: "it" }, h("span", { class: "n" }, n.name), h("div", { style: "width:90px" }, bar(n.affinity)), h("span", { class: "num" }, fmt(n.affinity)))) : h("span", { class: "muted" }, "No named neighborhoods returned.")),
          h("p", { class: "muted small" }, "Heatmap areas are coarse (boroughs and districts), so use them to shortlist, not to rank streets.")))]
    : h("p", { class: "muted" }, input.city ? "No place data returned." : "Add a city on the first screen to see venues and neighborhoods.");
  return [h("h3", {}, "Timing"), timingBlock, h("h3", {}, "Places"), placeBlock];
}

function clicheColumn(title, subtitle, rows, floor, ours) {
  return h("div", { class: "card" }, h("h2", {}, title), h("p", { class: "muted small" }, subtitle),
    h("div", { class: "list" }, rows.map((r) => h("div", { class: "it" },
      h("span", { class: "n" }, r.name, r.found === false ? h("span", { class: "muted small" }, " (not in Qloo)") : "", r.inOurPicks ? h("span", { class: "muted small" }, " (also in our picks)") : ""),
      typeof r.affinity === "number" ? scorePill(r.affinity, ours ? undefined : floor) : h("span", { class: "muted small" }, "no score")))));
}

function panelCliche({ cliche, input, model }) {
  if (!cliche) return h("p", { class: "muted" }, "The cliché check needs a Gemini key and was skipped.");
  const block = (label, data) => {
    const s = data.summary;
    const floor = Math.min(...data.ours.map((o) => o.affinity).filter((v) => typeof v === "number"));
    return [h("h3", {}, label),
      h("div", { class: "verdict" }, `Plain Gemini named ${data.llm.length}; Qloo could score ${s.scored}${s.notInQloo ? ` (${s.notInQloo} not found in Qloo)` : ""}. Their average fit is ${fmt(s.llmAverage)} against ${fmt(s.oursAverage)} for the data-backed picks; ${s.llmBelowOurFloor} of ${s.scored} fall below our lowest pick. ${s.overlap ? `${s.overlap} overlap with our picks.` : "None overlap with our picks."}`),
      h("div", { class: "cols" }, clicheColumn("Plain Gemini guessed", "No data, just its own knowledge.", data.llm, floor), clicheColumn("Archetype picks", "Chosen from measured audience fit.", data.ours, floor, true))];
  };
  return [
    h("p", { class: "muted small" }, `Same question, asked of ${model ?? "Gemini"} with no data: "${cliche.prompt}" Each suggestion was then looked up in Qloo and scored against this audience. Our picks were selected from that same ranking, so read this as "does the guess hold up in the data", not as an independent contest.`),
    block("Partner brands", cliche.brands), block("Artists", cliche.artists),
  ];
}

function panelSources({ provenance, modules }) {
  return [
    h("p", { class: "muted small" }, "Every number in this brief comes from one of these calls. Gemini only wrote the prose, and any text containing numbers it was not given was replaced."),
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
  $("backBtn").onclick = () => show("start");
  $("buildBtn").onclick = onBuild;
  window.onpopstate = () => location.reload();
  try {
    config = await api("/api/config");
  } catch (e) { $("startMsg").textContent = e.message; return; }
  $("typeChips").replaceChildren(...config.types.map((t) => h("button", { type: "button", class: "chip", role: "radio", "data-type": t, "aria-checked": "false", onclick: () => setType(t) }, TYPE_LABELS[t] ?? t)));
  setType("book");
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
  $("examples").replaceChildren(...EXAMPLES.map((ex) => h("a", { href: "#", onclick: (ev) => { ev.preventDefault(); fillForm(ex); } }, ex.q)));
  if (!config.hasQloo) $("startMsg").textContent = "QLOO_API_KEY is missing on the server.";
  else if (!config.hasGemini) $("startMsg").textContent = "GEMINI_API_KEY is missing: briefs will use fallback text and skip the cliché check.";
  const saved = /^\/b\/([0-9a-f]{12})$/.exec(location.pathname);
  if (saved) loadSaved(saved[1]);
}
init();
