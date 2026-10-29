// Language-model wrapper. The model only writes prose and picks from candidate lists we
// give it; it is never the source of a number. Two providers serve Meta's Muse models:
// the Meta API (Responses format) and Baseten (OpenAI-compatible chat completions).
// The primary is tried first; if it fails, the backup answers the same request.
import { sleep } from "./util.mjs";

const RETRYABLE = [429, 500, 502, 503, 504];

// POSTs JSON and returns the successful Response, retrying once on rate limits and server errors.
async function request(url, apiKey, body) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    });
    if (res.ok) return res;
    const raw = await res.text();
    let message = raw.slice(0, 200);
    try { message = JSON.parse(raw).error?.message ?? message; } catch {}
    const error = Object.assign(new Error(`HTTP ${res.status}: ${message}`), { status: res.status });
    if (!RETRYABLE.includes(res.status) || attempt >= 2) throw error;
    await sleep(2000 * attempt);
  }
}
const post = async (url, apiKey, body) => (await request(url, apiKey, body)).json();

// Server-sent events from a streaming response, as { event, data } with data parsed as JSON
// ("[DONE]" is passed through as a string).
export async function* sseEvents(res) {
  const reader = res.body.getReader(), decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
    let end;
    while ((end = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end).replace(/^\r?\n\r?\n/, "");
      const event = /^event: ?(.*)$/m.exec(block)?.[1]?.trim();
      const raw = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.replace(/^data: ?/, "")).join("\n");
      if (!raw) continue;
      let data = raw;
      try { data = JSON.parse(raw); } catch {}
      yield { event, data };
    }
    if (done) return;
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
// json() answers one prompt as JSON; stream() continues a conversation in plain text (the brief
// chat), calling onDelta with each piece of text as it arrives and returning the whole answer.
export function createMeta({ apiKey, model }) {
  async function respond({ system, input, format }) {
    const body = await post("https://api.meta.ai/v1/responses", apiKey, {
      model,
      instructions: system,
      input,
      temperature: 0.4,
      max_output_tokens: 8000,
      reasoning: { effort: "minimal" },
      ...(format ? { text: { format } } : {}),
    });
    if (body.status && body.status !== "completed") throw new Error(`response ${body.status}: ${body.incomplete_details?.reason ?? body.error?.message ?? "no detail"}`);
    return (body.output ?? [])
      .filter((o) => o.type === "message")
      .flatMap((o) => o.content ?? [])
      .filter((c) => c.type === "output_text")
      .map((c) => c.text)
      .join("");
  }
  const json = async ({ system, prompt }) => parseJson(await respond({ system, input: [{ role: "user", content: prompt }], format: { type: "json_object" } }));
  async function stream({ system, messages, onDelta }) {
    const res = await request("https://api.meta.ai/v1/responses", apiKey, {
      model, instructions: system, input: messages, temperature: 0.4, max_output_tokens: 8000, reasoning: { effort: "minimal" }, stream: true,
    });
    let text = "";
    for await (const { event, data } of sseEvents(res)) {
      const type = event ?? data?.type;
      if (type === "response.output_text.delta" && data.delta) { text += data.delta; onDelta(data.delta); }
      else if (type === "response.failed" || type === "response.incomplete" || type === "error") throw new Error(`stream ${type}: ${data?.response?.error?.message ?? data?.message ?? "no detail"}`);
    }
    if (!text) throw new Error("empty response");
    return text;
  }
  return { name: "meta", model, json, stream };
}

// Baseten, OpenAI-compatible chat completions.
export function createBaseten({ apiKey, model }) {
  async function complete({ system, messages, format }) {
    const body = await post("https://inference.baseten.co/v1/chat/completions", apiKey, {
      model,
      messages: [{ role: "system", content: system }, ...messages],
      temperature: 0.4,
      max_tokens: 8000,
      ...(format ? { response_format: format } : {}),
    });
    const content = body.choices?.[0]?.message?.content;
    if (!content) throw new Error("empty response");
    return content;
  }
  const json = async ({ system, prompt }) => parseJson(await complete({ system, messages: [{ role: "user", content: prompt }], format: { type: "json_object" } }));
  async function stream({ system, messages, onDelta }) {
    const res = await request("https://inference.baseten.co/v1/chat/completions", apiKey, {
      model, messages: [{ role: "system", content: system }, ...messages], temperature: 0.4, max_tokens: 8000, stream: true,
    });
    let text = "";
    for await (const { data } of sseEvents(res)) {
      const piece = data?.choices?.[0]?.delta?.content; // reasoning_content is skipped on purpose
      if (piece) { text += piece; onDelta(piece); }
    }
    if (!text) throw new Error("empty response");
    return text;
  }
  return { name: "baseten", model, json, stream };
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

  // A stream can only fall back while nothing has been sent on: once text has reached the
  // reader, switching providers would splice two different answers together.
  async function withFallback(method, request) {
    let started = false;
    const req = method === "stream" ? { ...request, onDelta: (piece) => { started = true; request.onDelta(piece); } } : request;
    for (const [i, provider] of providers.entries()) {
      try {
        return await provider[method](req);
      } catch (error) {
        const next = providers[i + 1];
        if (!next || started) throw error;
        console.error(`${provider.name} failed (${String(error.message).slice(0, 120)}); trying ${next.name}`);
      }
    }
  }

  return {
    json: (request) => withFallback("json", request),
    stream: (request) => withFallback("stream", request),
    model: providers[0].model,
    label: providers.map((p) => `${p.name}:${p.model}`).join(" > "),
  };
}
