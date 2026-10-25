// Gemini wrapper. The model only writes prose and picks from candidate lists we
// give it; it is never the source of a number.
import { GoogleGenAI } from "@google/genai";
import { sleep } from "./util.mjs";

export function createGemini({ apiKey, model }) {
  const ai = new GoogleGenAI({ apiKey });

  async function generate(request) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await ai.models.generateContent(request);
      } catch (error) {
        const retryable = [429, 500, 503].includes(error.status) || /RESOURCE_EXHAUSTED|UNAVAILABLE/.test(error.message ?? "");
        if (!retryable || attempt >= 4) throw error;
        await sleep(2000 * attempt);
      }
    }
  }

  // Returns parsed JSON. The schema is described in the prompt and the mime type is forced.
  // Thinking is switched off: these are short editing tasks and thinking tripled the latency.
  async function json({ system, prompt }) {
    const request = (thinkingConfig) => ({
      model,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: { systemInstruction: system, responseMimeType: "application/json", temperature: 0.4, ...(thinkingConfig ? { thinkingConfig } : {}) },
    });
    let response;
    try {
      response = await generate(request({ thinkingBudget: 0 }));
    } catch (error) {
      if (!/thinking/i.test(error.message ?? "")) throw error;
      response = await generate(request()); // this model does not accept a thinking budget
    }
    const text = (response.text ?? "").trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
    return JSON.parse(text);
  }

  return { json, model };
}
