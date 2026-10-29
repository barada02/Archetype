// Language-model wrapper. The model only writes prose and picks from candidate lists we
// give it; it is never the source of a number. Two providers serve Meta's Muse models:
// the Meta API (Responses format) and Baseten (OpenAI-compatible chat completions).
// The primary is tried first; if it fails, the backup answers the same request.
import { sleep } from "./util.mjs";

const RETRYABLE = [429, 500, 502, 503, 504];

async function post(url, apiKey, body) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    });
    if (res.ok) return res.json();
    const raw = await res.text();
    let message = raw.slice(0, 200);
    try { message = JSON.parse(raw).error?.message ?? message; } catch {}
    const error = Object.assign(new Error(`HTTP ${res.status}: ${message}`), { status: res.status });
    if (!RETRYABLE.includes(res.status) || attempt >= 2) throw error;
    await sleep(2000 * attempt);
  }
}

// JSON mode is requested from both providers, but strip fences and stray prose anyway.
export function parseJson(text) {
  const s = String(text ?? "").trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  try {
    return JSON.parse(s);
  } catch (error) {
    const start = s.indexOf("{"), end = s.lastIndexOf("}");
    if (start < 0 || end <= start) throw error;
    return JSON.parse(s.slice(start, end + 1));
  }
}

// Meta API, Responses format. Reasoning is kept minimal: these are short editing tasks.
export function createMeta({ apiKey, model }) {
  async function json({ system, prompt }) {
    const body = await post("https://api.meta.ai/v1/responses", apiKey, {
      model,
      instructions: system,
      input: [{ role: "user", content: prompt }],
      temperature: 0.4,
      max_output_tokens: 8000,
      reasoning: { effort: "minimal" },
      text: { format: { type: "json_object" } },
    });
    if (body.status && body.status !== "completed") throw new Error(`response ${body.status}: ${body.incomplete_details?.reason ?? body.error?.message ?? "no detail"}`);
    const text = (body.output ?? [])
      .filter((o) => o.type === "message")
      .flatMap((o) => o.content ?? [])
      .filter((c) => c.type === "output_text")
      .map((c) => c.text)
      .join("");
    return parseJson(text);
  }
  return { name: "meta", model, json };
}

// Baseten, OpenAI-compatible chat completions.
export function createBaseten({ apiKey, model }) {
  async function json({ system, prompt }) {
    const body = await post("https://inference.baseten.co/v1/chat/completions", apiKey, {
      model,
      messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
      temperature: 0.4,
      max_tokens: 8000,
      response_format: { type: "json_object" },
    });
    return parseJson(body.choices?.[0]?.message?.content);
  }
  return { name: "baseten", model, json };
}

// Returns undefined when no provider has a key, so callers fall back to deterministic text.
export function createLlm(config, factories = { meta: createMeta, baseten: createBaseten }) {
  const available = {
    meta: config.metaKey && factories.meta({ apiKey: config.metaKey, model: config.metaModel }),
    baseten: config.basetenKey && factories.baseten({ apiKey: config.basetenKey, model: config.basetenModel }),
  };
  const order = config.llmPrimary === "baseten" ? ["baseten", "meta"] : ["meta", "baseten"];
  const providers = order.map((name) => available[name]).filter(Boolean);
  if (!providers.length) return undefined;

  async function json(request) {
    for (const [i, provider] of providers.entries()) {
      try {
        return await provider.json(request);
      } catch (error) {
        const next = providers[i + 1];
        if (!next) throw error;
        console.error(`${provider.name} failed (${String(error.message).slice(0, 120)}); trying ${next.name}`);
      }
    }
  }

  return { json, model: providers[0].model, label: providers.map((p) => `${p.name}:${p.model}`).join(" > ") };
}
