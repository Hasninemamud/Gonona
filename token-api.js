// token-api.js — Provider token-count API clients.
// Keys live in chrome.storage.local.gononaApiKeys = { openai, anthropic, gemini, xai }
// Falls back to null when a key is missing or the request fails.

const GONONA_API_KEYS_STORAGE = "gononaApiKeys";

const GONONA_API_MODELS = {
  openai: "gpt-4o",
  anthropic: "claude-sonnet-4-20250514",
  gemini: "gemini-2.0-flash",
  xai: "grok-3",
};

function tallySiteToApiProvider(siteId) {
  switch (siteId) {
    case "chatgpt":
      return "openai";
    case "claude":
      return "anthropic";
    case "gemini":
      return "gemini";
    case "grok":
      return "xai";
    default:
      return null;
  }
}

function tallyGetApiKeys() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(GONONA_API_KEYS_STORAGE, (res) => {
        if (chrome.runtime.lastError) {
          resolve({});
          return;
        }
        resolve(res?.[GONONA_API_KEYS_STORAGE] || {});
      });
    } catch {
      resolve({});
    }
  });
}

function tallyResolveApiModel(provider, preferred) {
  if (preferred && typeof preferred === "string" && preferred.length > 2) {
    // Map coarse Gonona model ids → API model ids
    const p = preferred.toLowerCase();
    if (provider === "anthropic") {
      if (p.includes("opus")) return "claude-opus-4-20250514";
      if (p.includes("haiku")) return "claude-3-5-haiku-latest";
      if (p.includes("sonnet") || p.includes("claude")) return GONONA_API_MODELS.anthropic;
    }
    if (provider === "openai") {
      if (p.includes("o3")) return "o3";
      if (p.includes("o1")) return "o1";
      if (p.includes("gpt-5") || p.includes("gpt5")) return "gpt-5";
      return GONONA_API_MODELS.openai;
    }
    if (provider === "gemini") {
      if (p.includes("flash")) return "gemini-2.0-flash";
      return "gemini-2.0-flash";
    }
    if (provider === "xai") {
      return GONONA_API_MODELS.xai;
    }
  }
  return GONONA_API_MODELS[provider] || null;
}

/**
 * Count tokens for a list of { role, text } turns via the provider API.
 * @returns {Promise<{ total: number, source: string }|null>}
 */
async function tallyCountTokensViaApi(provider, turns, modelHint) {
  if (!provider || !turns?.length) return null;
  const keys = await tallyGetApiKeys();
  const key = keys[provider]?.trim();
  if (!key) return null;

  const model = tallyResolveApiModel(provider, modelHint);
  try {
    switch (provider) {
      case "openai":
        return await countOpenAI(key, model, turns);
      case "anthropic":
        return await countAnthropic(key, model, turns);
      case "gemini":
        return await countGemini(key, model, turns);
      case "xai":
        return await countXai(key, model, turns);
      default:
        return null;
    }
  } catch {
    return null;
  }
}

async function countOpenAI(apiKey, model, turns) {
  // POST /v1/responses/input_tokens
  // https://developers.openai.com/api/docs/guides/token-counting
  const input = turns.map((t) => ({
    role: t.role === "assistant" ? "assistant" : "user",
    content: t.text,
  }));
  const res = await fetch("https://api.openai.com/v1/responses/input_tokens", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, input }),
  });
  if (!res.ok) throw new Error(`openai ${res.status}`);
  const data = await res.json();
  const n = data.input_tokens ?? data.inputTokens;
  if (!Number.isFinite(n)) throw new Error("openai bad body");
  return { total: n, source: "openai-api" };
}

async function countAnthropic(apiKey, model, turns) {
  // POST /v1/messages/count_tokens
  const messages = turns.map((t) => ({
    role: t.role === "assistant" ? "assistant" : "user",
    content: t.text,
  }));
  // Anthropic requires alternating roles — merge consecutive same-role turns
  const merged = [];
  for (const m of messages) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) {
      last.content = `${last.content}\n\n${m.content}`;
    } else {
      merged.push({ ...m });
    }
  }
  // Must start with user
  if (merged[0]?.role === "assistant") {
    merged.unshift({ role: "user", content: "." });
  }

  const res = await fetch("https://api.anthropic.com/v1/messages/count_tokens", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, messages: merged }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}`);
  const data = await res.json();
  const n = data.input_tokens;
  if (!Number.isFinite(n)) throw new Error("anthropic bad body");
  return { total: n, source: "anthropic-api" };
}

async function countGemini(apiKey, model, turns) {
  // POST .../models/{model}:countTokens?key=
  const contents = turns.map((t) => ({
    role: t.role === "assistant" ? "model" : "user",
    parts: [{ text: t.text }],
  }));
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:countTokens?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents }),
  });
  if (!res.ok) throw new Error(`gemini ${res.status}`);
  const data = await res.json();
  const n = data.totalTokens;
  if (!Number.isFinite(n)) throw new Error("gemini bad body");
  return { total: n, source: "gemini-api" };
}

async function countXai(apiKey, model, turns) {
  // POST https://api.x.ai/v1/tokenize-text — no dedicated count endpoint
  // Count each turn and sum (keeps role boundaries closer to chat usage)
  let total = 0;
  for (const t of turns) {
    const res = await fetch("https://api.x.ai/v1/tokenize-text", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, text: t.text }),
    });
    if (!res.ok) throw new Error(`xai ${res.status}`);
    const data = await res.json();
    const ids = data.token_ids || data.tokens || [];
    total += Array.isArray(ids) ? ids.length : 0;
  }
  return { total, source: "xai-api" };
}
