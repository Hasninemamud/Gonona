// claude-tokens.js
// Walk Claude.ai conversation trees (chat_messages) and count tokens with
// o200k_base — same approach as Tally / Claude Counter (pauljones0).
// Context tokens are approximate; session % comes from message_limit SSE.

(function (global) {
  const ROOT_MESSAGE_ID = "00000000-0000-4000-8000-000000000000";

  function stableStringify(value) {
    const seen = new WeakSet();
    const normalize = (v) => {
      if (v === null || typeof v !== "object") return v;
      if (seen.has(v)) return "[Circular]";
      seen.add(v);
      if (Array.isArray(v)) return v.map(normalize);
      const out = {};
      for (const key of Object.keys(v).sort()) out[key] = normalize(v[key]);
      return out;
    };
    try {
      return JSON.stringify(normalize(value));
    } catch {
      return "";
    }
  }

  function countTokens(text) {
    if (!text) return 0;
    const tok = global.GPTTokenizer_o200k_base;
    if (typeof tok?.encode === "function") return tok.encode(text).length;
    if (typeof tok?.countTokens === "function") return tok.countTokens(text);
    // Fallback heuristic (chars/4) if tokenizer not loaded
    return Math.max(1, Math.ceil(text.trim().length / 4));
  }

  function buildTrunk(conversation) {
    const messages = Array.isArray(conversation?.chat_messages)
      ? conversation.chat_messages
      : [];
    const byId = new Map();
    for (const msg of messages) {
      if (msg?.uuid) byId.set(msg.uuid, msg);
    }
    const leaf = conversation?.current_leaf_message_uuid;
    if (!leaf) return [];

    const trunk = [];
    let currentId = leaf;
    while (currentId && currentId !== ROOT_MESSAGE_ID) {
      const msg = byId.get(currentId);
      if (!msg) break;
      trunk.push(msg);
      currentId = msg.parent_message_uuid;
    }
    trunk.reverse();
    return trunk;
  }

  function isCountableContentItem(item) {
    if (!item || typeof item !== "object") return false;
    if (typeof item.type !== "string") return false;
    if (item.type === "thinking" || item.type === "redacted_thinking") return false;
    if (item.type === "image" || item.type === "document") return false;
    return true;
  }

  function stringifyCountableContentItem(item) {
    if (!isCountableContentItem(item)) return "";
    if (item.type === "text" && typeof item.text === "string") return item.text;
    if (item.type === "tool_use") {
      return stableStringify({ id: item.id, name: item.name, input: item.input });
    }
    if (item.type === "tool_result") {
      return stableStringify({
        tool_use_id: item.tool_use_id,
        is_error: item.is_error,
        content: item.content,
      });
    }
    const minimal = {};
    if (typeof item.text === "string") minimal.text = item.text;
    if (typeof item.title === "string") minimal.title = item.title;
    if (typeof item.url === "string") minimal.url = item.url;
    if (typeof item.content === "string") minimal.content = item.content;
    if (Array.isArray(item.content)) minimal.content = item.content;
    if (Object.keys(minimal).length === 0) return "";
    return stableStringify(minimal);
  }

  function stringifyMessageCountables(message) {
    const parts = [];
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const item of content) {
      const s = stringifyCountableContentItem(item);
      if (s) parts.push(s);
    }
    const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
    for (const a of attachments) {
      if (typeof a?.extracted_content === "string" && a.extracted_content) {
        parts.push(a.extracted_content);
      }
    }
    return parts.join("\n");
  }

  function isUserSender(sender) {
    const s = (sender || "").toLowerCase();
    return s === "human" || s === "user";
  }

  /**
   * @returns {{ totalTokens: number, promptTokens: number, completionTokens: number, messageCount: number }}
   */
  function tallyComputeClaudeConversationTokens(conversation) {
    const trunk = buildTrunk(conversation);
    let totalTokens = 0;
    let promptTokens = 0;
    let completionTokens = 0;

    for (const msg of trunk) {
      const text = stringifyMessageCountables(msg);
      const n = countTokens(text);
      totalTokens += n;
      if (isUserSender(msg?.sender)) promptTokens += n;
      else completionTokens += n;
    }

    return {
      totalTokens,
      promptTokens,
      completionTokens,
      messageCount: trunk.length,
    };
  }

  global.tallyComputeClaudeConversationTokens = tallyComputeClaudeConversationTokens;
})(typeof globalThis !== "undefined" ? globalThis : window);
