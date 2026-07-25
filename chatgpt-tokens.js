// chatgpt-tokens.js
// Walk ChatGPT conversation.mapping from current_node → root and count with o200k.

(function (global) {
  function extractPartsText(content) {
    if (!content) return "";
    if (typeof content === "string") return content;
    const parts = content.parts;
    if (!Array.isArray(parts)) {
      if (typeof content.text === "string") return content.text;
      return "";
    }
    const chunks = [];
    for (const part of parts) {
      if (typeof part === "string") chunks.push(part);
      else if (part && typeof part.text === "string") chunks.push(part.text);
      else if (part && typeof part === "object") {
        // multimodal: skip images; keep captions if any
        if (typeof part.content === "string") chunks.push(part.content);
      }
    }
    return chunks.join("\n");
  }

  function buildTrunk(conversation) {
    const mapping = conversation?.mapping;
    if (!mapping || typeof mapping !== "object") {
      // Flat messages fallback
      if (Array.isArray(conversation?.messages)) {
        return conversation.messages;
      }
      return [];
    }

    const leaf =
      conversation.current_node ||
      conversation.currentNode ||
      Object.keys(mapping).find((id) => {
        const n = mapping[id];
        return n && (!n.children || n.children.length === 0);
      });

    if (!leaf || !mapping[leaf]) return [];

    const trunk = [];
    let id = leaf;
    const seen = new Set();
    while (id && mapping[id] && !seen.has(id)) {
      seen.add(id);
      trunk.push(mapping[id]);
      id = mapping[id].parent;
    }
    trunk.reverse();
    return trunk;
  }

  function roleOf(node) {
    const role =
      node?.message?.author?.role ||
      node?.author?.role ||
      node?.role ||
      "";
    const r = String(role).toLowerCase();
    if (r === "user" || r === "human") return "user";
    if (r === "assistant" || r === "tool" || r === "system") return r === "system" ? "system" : "assistant";
    return "assistant";
  }

  function textOf(node) {
    if (node?.message?.content) return extractPartsText(node.message.content);
    if (node?.content) return extractPartsText(node.content);
    if (typeof node?.text === "string") return node.text;
    return "";
  }

  /**
   * @returns {{ totalTokens: number, promptTokens: number, completionTokens: number, messageCount: number }}
   */
  function tallyComputeChatGPTConversationTokens(conversation) {
    const trunk = buildTrunk(conversation);
    let promptTokens = 0;
    let completionTokens = 0;
    let messageCount = 0;

    for (const node of trunk) {
      const role = roleOf(node);
      if (role === "system") continue;
      const text = textOf(node);
      if (!text.trim()) continue;
      const n =
        typeof global.tallyCountTokens === "function"
          ? global.tallyCountTokens(text, "gpt")
          : Math.max(1, Math.ceil(text.trim().length / 4));
      if (role === "user") promptTokens += n;
      else completionTokens += n;
      messageCount += 1;
    }

    return {
      totalTokens: promptTokens + completionTokens,
      promptTokens,
      completionTokens,
      messageCount,
    };
  }

  global.tallyComputeChatGPTConversationTokens = tallyComputeChatGPTConversationTokens;
})(typeof globalThis !== "undefined" ? globalThis : window);
