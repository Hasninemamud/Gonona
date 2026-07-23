// inject.js
// Runs in the PAGE's own JS context (not the isolated content-script world),
// so it can see and patch the page's real `window.fetch`. This is how we catch
// exact token usage the provider's own backend reports — which is real,
// server-computed data, not a client-side guess.
//
// IMPORTANT: each provider reports usage in a different shape, so this is
// intentionally host-aware rather than one generic regex. A single pattern
// that only matched OpenAI's field names was the earlier bug — it silently
// matched nothing on claude.ai, so Tally fell back to the heuristic there
// without any indication that the "exact" path just wasn't firing.
//
// Injected into the page via a <script src="..."> tag from content.js.

(function () {
  const originalFetch = window.fetch;
  const host = location.host;

  function reportUsage(totalTokens) {
    window.postMessage(
      { source: "tally-inject", type: "usage", totalTokens },
      "*"
    );
  }

  // Anthropic's Messages API streaming shape (what claude.ai's own backend
  // uses under the hood): usage arrives split across two SSE event types.
  //   event: message_start  -> message.usage.input_tokens
  //   event: message_delta  -> usage.output_tokens (cumulative, last one wins)
  function parseAnthropicSSE(body) {
    let inputTokens = 0;
    let outputTokens = 0;
    let found = false;

    // SSE frames are separated by blank lines; each frame has "event:" and
    // "data:" lines. We only care about the data lines that parse as JSON.
    const dataLines = body.split("\n").filter((l) => l.startsWith("data:"));

    for (const line of dataLines) {
      const jsonStr = line.slice(5).trim();
      if (!jsonStr || jsonStr === "[DONE]") continue;
      try {
        const parsed = JSON.parse(jsonStr);
        if (parsed?.type === "message_start" && parsed.message?.usage) {
          inputTokens = parsed.message.usage.input_tokens ?? inputTokens;
          found = true;
        }
        if (parsed?.type === "message_delta" && parsed.usage) {
          outputTokens = parsed.usage.output_tokens ?? outputTokens;
          found = true;
        }
      } catch {
        // Partial/non-JSON data line — ignore and keep scanning
      }
    }

    return found ? inputTokens + outputTokens : null;
  }

  // Generic fallback for any provider that DOES expose an OpenAI-shaped
  // {"usage":{"total_tokens":N}} field in a plain (non-streaming) JSON body.
  function parseGenericTotalTokens(body) {
    const match = body.match(
      /"usage"\s*:\s*\{[^}]*"(?:total_tokens|totalTokens)"\s*:\s*(\d+)/
    );
    return match ? Number(match[1]) : null;
  }

  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);

    try {
      const contentType = response.headers.get("content-type") || "";
      const isSSE = contentType.includes("text/event-stream");
      const isJson = contentType.includes("application/json");
      if (!response.body || (!isSSE && !isJson)) return response;

      // Clone so we never touch the body the page itself needs to consume
      response
        .clone()
        .text()
        .then((body) => {
          if (host.includes("claude.ai") && isSSE) {
            const total = parseAnthropicSSE(body);
            if (total !== null) reportUsage(total);
            return;
          }
          // ChatGPT's consumer web app generally doesn't expose usage at all
          // (that's an api.openai.com-only field) — this fallback just covers
          // any provider, now or in the future, that happens to send the
          // OpenAI-style shape.
          const total = parseGenericTotalTokens(body);
          if (total !== null) reportUsage(total);
        })
        .catch(() => {
          /* not fully readable as text (rare), or truly empty — ignore */
        });
    } catch (e) {
      /* never let our inspection break the page's own fetch */
    }

    return response;
  };
})();
