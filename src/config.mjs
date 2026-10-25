// Reads settings from the environment. Qloo names accept the variants used in
// the hackathon kit (API_Key, API_Server_URL) as well as QLOO_*.
export function loadConfig(env = process.env) {
  const pick = (...names) => names.map((n) => env[n]).find((v) => v && String(v).trim())?.trim() ?? "";
  return {
    qlooKey: pick("QLOO_API_KEY", "API_Key"),
    qlooBase: (pick("QLOO_BASE_URL", "API_Server_URL", "Server_URL") || "https://hackathon.api.qloo.com").replace(/\/+$/, ""),
    geminiKey: pick("GEMINI_API_KEY"),
    geminiModel: pick("GEMINI_MODEL") || "gemini-flash-latest",
    port: Number(pick("PORT") || 3100),
    host: pick("HOST") || "127.0.0.1",
    briefsPerHour: Number(pick("BRIEFS_PER_HOUR") || 12),
  };
}

// Never let a key reach a response, log or saved file.
export function redactor(config) {
  const secrets = [config.qlooKey, config.geminiKey].filter((s) => s && s.length >= 8);
  return (value) => {
    let text = typeof value === "string" ? value : JSON.stringify(value);
    for (const secret of secrets) text = text.split(secret).join("[REDACTED]");
    return text;
  };
}
