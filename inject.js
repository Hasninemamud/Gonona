// inject.js
// MAIN-world fetch hook (document_start). Multi-site Tally-style intercept:
//   Claude  — SSE message_limit + chat_conversations?tree= + /usage RPC
//   ChatGPT — usage when present; conversation JSON for o200k recount
//   Gemini  — usageMetadata (prompt/candidates/thoughts) in SSE/JSON
//   Grok    — OpenAI-shaped usage when present
//
// Always clone responses; never break the page.

(function () {
  if (window.__gononaInjectInstalled) return;
  window.__gononaInjectInstalled = true;

  const originalFetch = window.fetch.bind(window);
  const host = location.host;
  const isClaude = host.includes("claude.ai");
  const isChatGPT =
    host.includes("chatgpt.com") || host.includes("chat.openai.com");
  const isGemini = host.includes("gemini.google.com");
  const isGrok = host.includes("grok.com");

  function post(type, payload) {
    window.postMessage({ source: "tally-inject", type, payload }, "*");
  }

  function toAbsoluteUrl(input) {
    if (typeof input === "string") {
      if (input.startsWith("/")) return `${location.origin}${input}`;
      return input;
    }
    if (input instanceof URL) return input.href;
    if (typeof Request !== "undefined" && input instanceof Request) return input.url;
    return "";
  }

  let lastUsagePost = { total: 0, at: 0 };

  function reportUsage(inputTokens, outputTokens, totalOverride) {
    const input = Math.max(0, Math.floor(inputTokens || 0));
    const output = Math.max(0, Math.floor(outputTokens || 0));
    const total =
      Number.isFinite(totalOverride) && totalOverride > 0
        ? Math.floor(totalOverride)
        : input + output;
    if (total <= 0) return;
    // Dedupe rapid duplicate parses from the same JSON/SSE envelope
    const now = Date.now();
    if (total <= lastUsagePost.total && now - lastUsagePost.at < 800) return;
    if (total === lastUsagePost.total && now - lastUsagePost.at < 400) return;
    lastUsagePost = { total, at: now };
    post("usage", {
      totalTokens: total,
      inputTokens: input,
      outputTokens: output,
    });
  }

  function reportAnthropicUsage(usage) {
    if (!usage) return;
    const input =
      (usage.input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0);
    const output = usage.output_tokens ?? 0;
    reportUsage(input, output);
  }

  function reportOpenAIUsage(usage) {
    if (!usage || typeof usage !== "object") return;
    const input = usage.prompt_tokens ?? usage.input_tokens ?? 0;
    const output = usage.completion_tokens ?? usage.output_tokens ?? 0;
    const total = usage.total_tokens;
    if (input || output || total) reportUsage(input, output, total);
  }

  function reportGeminiUsage(meta) {
    if (!meta || typeof meta !== "object") return;
    const input = meta.promptTokenCount ?? meta.prompt_token_count ?? 0;
    const candidates =
      meta.candidatesTokenCount ?? meta.candidates_token_count ?? 0;
    const thoughts = meta.thoughtsTokenCount ?? meta.thoughts_token_count ?? 0;
    const output = candidates + thoughts;
    const total = meta.totalTokenCount ?? meta.total_token_count;
    if (input || output || total) reportUsage(input, output, total);
  }

  /** Deep-scan object for known usage shapes (Gemini web is obfuscated). */
  function extractUsageFromObject(obj, depth = 0) {
    if (!obj || typeof obj !== "object" || depth > 6) return;

    if (obj.usageMetadata) reportGeminiUsage(obj.usageMetadata);
    if (obj.usage) {
      if (
        "prompt_tokens" in obj.usage ||
        "completion_tokens" in obj.usage ||
        "total_tokens" in obj.usage
      ) {
        reportOpenAIUsage(obj.usage);
      } else if (
        "input_tokens" in obj.usage ||
        "output_tokens" in obj.usage
      ) {
        reportAnthropicUsage(obj.usage);
      }
    }
    if (obj.response?.usage) reportOpenAIUsage(obj.response.usage);
    if (obj.message?.usage) reportAnthropicUsage(obj.message.usage);

    if (Array.isArray(obj)) {
      for (let i = 0; i < Math.min(obj.length, 40); i++) {
        extractUsageFromObject(obj[i], depth + 1);
      }
      return;
    }

    // Limited key walk for nested Gemini envelopes
    if (depth < 3) {
      for (const key of Object.keys(obj)) {
        if (key === "usage" || key === "usageMetadata" || key === "response") {
          continue; // already handled
        }
        const v = obj[key];
        if (v && typeof v === "object") extractUsageFromObject(v, depth + 1);
      }
    }
  }

  function parseStreamEvent(json) {
    if (!json || typeof json !== "object") return;

    // Claude.ai session/weekly limits
    if (json.type === "message_limit" && json.message_limit) {
      post("message_limit", json.message_limit);
    }

    // Anthropic Messages streaming
    if (json.type === "message_start" && json.message?.usage) {
      reportAnthropicUsage({
        ...json.message.usage,
        output_tokens: json.message.usage.output_tokens ?? 0,
      });
      window.__gononaLastInputUsage = json.message.usage;
    }
    if (json.type === "message_delta" && json.usage) {
      const base = window.__gononaLastInputUsage || {};
      reportAnthropicUsage({
        input_tokens: base.input_tokens ?? json.usage.input_tokens ?? 0,
        cache_creation_input_tokens: base.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: base.cache_read_input_tokens ?? 0,
        output_tokens: json.usage.output_tokens ?? 0,
      });
    }

    // OpenAI / Responses / Gemini anywhere in the event
    extractUsageFromObject(json);
  }

  async function readEventStream(response) {
    try {
      const cloned = response.clone();
      const reader = cloned.body?.getReader?.();
      if (!reader) {
        const body = await cloned.text();
        body.split(/\r?\n/).forEach((line) => {
          if (!line.startsWith("data:")) return;
          const raw = line.slice(5).trim();
          if (!raw || raw === "[DONE]") return;
          try {
            parseStreamEvent(JSON.parse(raw));
          } catch {
            /* ignore */
          }
        });
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r\n|\r|\n/);
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const raw = line.slice(5).trim();
          if (!raw || raw === "[DONE]") continue;
          try {
            parseStreamEvent(JSON.parse(raw));
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      /* never break the page */
    }
  }

  function getClaudeConversationMeta(url) {
    const match = url.match(
      /\/api\/organizations\/([^/]+)\/chat_conversations\/([^/?]+)/
    );
    return match ? { orgId: match[1], conversationId: match[2] } : null;
  }

  function isChatGPTConversationUrl(url) {
    if (!isChatGPT) return false;
    // GET conversation by id — not the streaming POST /conversation
    if (url.includes("/backend-api/f/conversation")) return false;
    if (url.includes("/backend-api/conversation/") && !url.includes("/conversation/init")) {
      return true;
    }
    // Some builds: /backend-api/conversation/{uuid}
    return /\/backend-api\/conversation\/[a-f0-9-]{8,}/i.test(url);
  }

  function looksLikeChatGPTConversation(data) {
    if (!data || typeof data !== "object") return false;
    if (data.mapping && typeof data.mapping === "object") return true;
    if (Array.isArray(data.messages) && data.messages.length) return true;
    return false;
  }

  async function handleClaudeConversation(meta, response) {
    try {
      const data = await response.clone().json();
      post("conversation", { platform: "claude", ...meta, data });
    } catch {
      /* ignore */
    }
  }

  async function handleChatGPTConversation(url, response) {
    try {
      const data = await response.clone().json();
      if (!looksLikeChatGPTConversation(data)) return;
      const idMatch = url.match(/\/conversation\/([a-f0-9-]+)/i);
      post("conversation", {
        platform: "chatgpt",
        conversationId: idMatch?.[1] || data.conversation_id || data.id || null,
        data,
      });
    } catch {
      /* ignore */
    }
  }

  async function handleJsonBody(url, response) {
    try {
      const body = await response.clone().text();
      let parsed = null;
      try {
        parsed = JSON.parse(body);
      } catch {
        /* ignore */
      }
      if (parsed) {
        if (parsed.usage) {
          if ("prompt_tokens" in parsed.usage || "total_tokens" in parsed.usage) {
            reportOpenAIUsage(parsed.usage);
          } else {
            reportAnthropicUsage(parsed.usage);
          }
        }
        if (parsed.type === "message" && parsed.usage) {
          reportAnthropicUsage(parsed.usage);
        }
        extractUsageFromObject(parsed);
      }
    } catch {
      /* ignore */
    }
  }

  window.fetch = async function (...args) {
    const url = toAbsoluteUrl(args[0]);
    const opts = args[1] || {};

    if (
      isClaude &&
      opts.method === "POST" &&
      (url.includes("/completion") || url.includes("/retry_completion"))
    ) {
      post("generation_start", {});
    }

    const response = await originalFetch(...args);

    try {
      const contentType = response.headers.get("content-type") || "";
      const isSSE = contentType.includes("event-stream");
      const isJson =
        contentType.includes("application/json") ||
        contentType.includes("text/plain") ||
        contentType.includes("+json");

      if (isSSE) {
        readEventStream(response);
      } else if (response.body) {
        if (isClaude && url.includes("/chat_conversations/") && url.includes("tree=")) {
          const meta = getClaudeConversationMeta(url);
          if (meta) handleClaudeConversation(meta, response);
        } else if (
          isChatGPTConversationUrl(url) &&
          (!opts.method || opts.method === "GET")
        ) {
          handleChatGPTConversation(url, response);
        } else if (isJson || isGemini || isGrok || isChatGPT) {
          // Gemini/Grok/ChatGPT may omit precise content-type; still try
          handleJsonBody(url, response);
        }
      }
    } catch {
      /* never break fetch */
    }

    return response;
  };

  // RPC from content script (Claude cookies for /usage)
  window.addEventListener("message", async (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== "tally-content") return;
    if (data.type !== "request") return;

    const { requestId, kind, payload } = data;
    const reply = (ok, result, error) => {
      window.postMessage(
        {
          source: "tally-inject",
          type: "response",
          requestId,
          ok,
          payload: result,
          error,
        },
        "*"
      );
    };

    try {
      if (kind === "hash") {
        const text = typeof payload?.text === "string" ? payload.text : "";
        if (!text || !crypto?.subtle?.digest) {
          reply(false, null, "Hash unavailable");
          return;
        }
        const buf = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(text)
        );
        const bytes = new Uint8Array(buf);
        const hash = Array.from(bytes.slice(0, 8), (b) =>
          b.toString(16).padStart(2, "0")
        ).join("");
        reply(true, { hash }, null);
        return;
      }

      if (kind === "usage") {
        const orgId = payload?.orgId;
        if (!orgId) throw new Error("Missing orgId");
        const res = await originalFetch(
          `https://claude.ai/api/organizations/${orgId}/usage`,
          { method: "GET", credentials: "include" }
        );
        if (!res.ok) throw new Error(`usage ${res.status}`);
        reply(true, await res.json(), null);
        return;
      }

      if (kind === "conversation") {
        const { orgId, conversationId } = payload || {};
        if (!orgId || !conversationId) throw new Error("Missing ids");
        const u = `https://claude.ai/api/organizations/${orgId}/chat_conversations/${conversationId}?tree=true&rendering_mode=messages&render_all_tools=true`;
        const res = await originalFetch(u, {
          method: "GET",
          credentials: "include",
        });
        if (!res.ok) throw new Error(`conversation ${res.status}`);
        const json = await res.json();
        post("conversation", {
          platform: "claude",
          orgId,
          conversationId,
          data: json,
        });
        reply(true, json, null);
        return;
      }

      throw new Error(`Unknown kind: ${kind}`);
    } catch (e) {
      reply(false, null, e?.message || String(e));
    }
  });
})();
