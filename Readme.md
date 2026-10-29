# Archetype

**A cultural-fit brief for anything you are about to launch.**

Name a book, game, film, TV show, podcast or artist. Archetype measures its audience in the
[Qloo](https://qloo.com) taste graph and builds a one-page brief:

- **Audience DNA**: measured age and gender skew, genres, moods and traits.
- **Sound and talent**: mainstream and emerging artists whose fans overlap.
- **Partners**: brands by category, ranked for your target audience, each checked against the brand's own audience (it warns when a brand skews the wrong way).
- **Cities and timing**: venues and neighborhoods where fans cluster, and whether interest is rising or falling.
- **Cliché check**: what a plain language model suggests with no data, scored in Qloo against the same audience, next to the data-backed picks.
- **Sources**: every Qloo call behind every number.

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
                         └──► Meta Muse via Meta API, Baseten as backup (editor + cliché-check prompt, JSON only)
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
key, that provider is used alone. Without either key the brief still builds (fallback text, no cliché check). Briefs are saved under `data/briefs/`
and are shareable at `/b/<id>`. Qloo responses are cached for 24 hours under `data/cache/`.

Command line, no browser:

```bash
node --env-file=.env scripts/brief.mjs book "The Secret History" --age 25_to_29 --city "New York"
```

## Limits we know about

- Qloo has no trend series for books and games, so the timing section is skipped for them.
- Neighborhood heatmaps are coarse (boroughs and districts for large cities).
- Category quality varies: some brand categories are noisy for some titles, so a minimum fit score is adjustable.
- The cliché check scores guesses with the same graph that ranked our picks. It shows whether a guess holds up
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
