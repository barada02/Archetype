# Archetype

**Co-marketing briefs for film and TV releases: brand partners your audience will actually accept.**

Name a film or show. Archetype measures its audience in the [Qloo](https://qloo.com) taste graph and builds a
one-page brief for the person who has to sign the partnership deals:

- **Partner shortlist**: brands by category, ranked for your target audience, each checked against the brand's own audience (it warns when a brand skews the wrong way).
- **Audience**: measured age and gender skew, genres, moods and traits, plus co-marketing angles.
- **Trailer and soundtrack**: mainstream and emerging artists whose fans overlap.
- **Screenings and timing**: venues and neighborhoods where fans cluster, and whether interest is rising or falling.
- **Plain AI vs data**: what a plain language model suggests with no data, scored in Qloo against the same audience, next to the data-backed picks.
- **Sources**: every Qloo call behind every number.
- **Ask about this brief**: a chat panel that explains any part of the brief in plain words. The server loads the brief itself and the model answers only from its data; any number in an answer that is not in the brief is flagged.
- **Guided tour**: an optional, skippable walkthrough from the landing page that fills in an example and walks through a finished sample brief.

It also works for books, games, podcasts and artists, but it is designed around film and TV releases.

## Who it is for

Partnership and marketing leads at independent studios, distributors and streamers: teams that release films
and shows without a large agency behind every campaign. Their question is always the same: *which brands should
we team up with, and will this audience accept them?* Today the answer comes from gut feel, comparable titles,
or asking a chatbot, which sounds confident but guesses who the audience is.

**Scenario.** A partnerships lead is planning the theatrical release of an indie film like *Everything Everywhere
All at Once*, aimed at 25 to 29 year olds, opening in Los Angeles.

1. They enter the title, the target age and the city, and pick the goal "Theatrical release co-marketing".
2. **Partner shortlist**: up to eight brands across fashion, food and drink, beauty, travel and more, each with a
   measured fit score, a one-line reason, and a warning if the brand's own customers skew a different way.
3. **Trailer and soundtrack**: artists whose fans overlap, including emerging ones that are cheaper to license.
4. **Screenings and timing**: the venues and neighborhoods in Los Angeles where fans cluster, for screenings and
   pop-ups, and whether interest is rising into the release window.
5. **Plain AI vs data**: the same question asked of a plain AI, with its suggestions scored against this
   audience, so the lead can show why the shortlist beats the obvious names.
6. They copy the link or print the brief and take it into partner conversations. Every number traces back to a
   Qloo call on the Sources tab.

## Why it needs Qloo

A language model can write a convincing brief, but it guesses who the audience is. In our tests a plain model
contradicted the measured demographics, could not say whether a title was trending, and suggested partners
that scored below the data-backed picks for the same audience. Here every number comes from Qloo and the language
model only edits and explains. Its output is validated: partner ids it invents are dropped, and any text containing a
number that was not in the data is replaced.

## How it works

```
Browser ──► Node server (holds keys, caches, rate-limits) ──► Qloo REST API
                         │
                         └──► Meta Muse via Meta API, Baseten as backup (editor + plain-AI comparison prompt, JSON only)
```

1. **Resolve** the title to a Qloo entity and let the user confirm it (names are ambiguous in the graph).
2. **Collect** in parallel: demographics and tags, artists (with and without a popularity cap), brands per category,
   places and neighborhoods for a city, the weekly trend.
3. **Edit**: the language model picks up to eight partners (at most two per category) from the candidates and explains each.
4. **Check**: each pick's own audience is compared with the target; the model's unaided suggestions are looked up and scored.

Brands labelled "Media Brand" by Qloo (magazines and news sites) are removed. Scores are Qloo affinity indices
from 0 to 1, and demographic values are skew indices, not percentages.

## Run it

Requires Node 22 or newer.

```bash
npm install
cp .env.example .env     # add QLOO_API_KEY, META_API_KEY and BASETEN_API_KEY
npm start                # http://localhost:3100
npm test
```

The Meta API (`muse-wonder-1.0`) is the primary model; if a call fails, the same request goes to Baseten
(`meta-models/muse-spark-open-1026`, OpenAI-compatible). Set `LLM_PRIMARY=baseten` to swap them. With only one
key, that provider is used alone. Without either key the brief still builds (fallback text, no plain AI vs data comparison). Briefs are saved under `data/briefs/`
and are shareable at `/b/<id>`. Qloo responses are cached for 24 hours under `data/cache/`.

Command line, no browser:

```bash
node --env-file=.env scripts/brief.mjs movie "Everything Everywhere All at Once" --age 25_to_29 --city "Los Angeles" --goal "Theatrical release co-marketing"
```

### Sample briefs

The landing page links to finished sample briefs so anyone can see the output in one click, with no wait and
no API calls. They live in `samples/` (committed, unlike `data/`), and `samples/index.json` sets their order; the
first one is behind the "See a sample brief" button. To refresh or add one, build it with `--out samples` and put
its id in `samples/index.json`:

```bash
node --env-file=.env scripts/brief.mjs tv_show "The Bear" --age 30_to_34 --city "Chicago" --goal "Season premiere brand tie-ins" --out samples
```

Keys are redacted from saved briefs, and a test checks that every listed sample exists and is complete.

## Limits we know about

- Qloo has no trend series for books and games, so the timing section is skipped for them.
- Neighborhood heatmaps are coarse (boroughs and districts for large cities).
- Category quality varies: some brand categories are noisy for some titles, so a minimum fit score is adjustable.
- The plain AI vs data comparison scores guesses with the same graph that ranked our picks. It shows whether a guess holds up
  in the data, not an independent contest.
- Qloo allows 10 requests per second and 50,000 per month; the server limits concurrency, caches, and caps briefs per visitor.

## Layout

```
server.mjs        HTTP server, streaming progress, saved briefs
src/pipeline.mjs  brief builder (modules, provenance)
src/editor.mjs    editor prompt and output validation
src/llm.mjs       Meta API and Baseten clients, primary with backup
src/cliche.mjs    plain-LLM comparison
src/qloo.mjs      Qloo client (cache, retry, concurrency)
public/           single-page UI, no build step
test/             unit and pipeline tests (fake Qloo and LLM)
```

## License

MIT, see `LICENSE`.
