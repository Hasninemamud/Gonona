// site-config.js
// Central place to add/adjust support for a new site.
// Selectors WILL drift as these apps ship frontend updates — this is the
// file you'll come back to fix most often.

const TALLY_SITE_CONFIGS = [
  {
    id: "chatgpt",
    hostMatch: (h) => h.includes("chatgpt.com") || h.includes("chat.openai.com"),
    messageSelector: '[data-message-author-role]',
    roleFromNode: (node) => node.getAttribute("data-message-author-role"),
    textFromNode: (node) => node.innerText,
    tokenizerFamily: "gpt", // exact tokenizer available
    inputSelector: '#prompt-textarea',
    composerSelector: 'form', // placeholder — adjust after inspecting live DOM
    defaultContextLimit: 128000,
  },
  {
    id: "claude",
    hostMatch: (h) => h.includes("claude.ai"),
    messageSelector: '[data-testid="user-message"], [data-testid="assistant-message"], .font-claude-message',
    roleFromNode: (node) =>
      node.matches('[data-testid="user-message"]') ? "user" : "assistant",
    textFromNode: (node) => node.innerText,
    tokenizerFamily: "heuristic", // no public exact JS tokenizer for current Claude models
    inputSelector: '[contenteditable="true"].ProseMirror, div[contenteditable="true"]',
    composerSelector: 'div[class*="composer"]', // placeholder — adjust after inspecting live DOM
    defaultContextLimit: 200000,
  },
  {
    id: "gemini",
    hostMatch: (h) => h.includes("gemini.google.com"),
    messageSelector: ".conversation-container .query-text, .conversation-container .model-response-text",
    roleFromNode: (node) => (node.matches(".query-text") ? "user" : "assistant"),
    textFromNode: (node) => node.innerText,
    tokenizerFamily: "heuristic",
    inputSelector: 'rich-textarea div[contenteditable="true"]',
    composerSelector: 'input-container, .input-area-container', // placeholder — adjust after inspecting live DOM
    defaultContextLimit: 1000000,
  },
  {
    id: "glm",
    hostMatch: (h) => h.includes("chatglm.cn"),
    messageSelector: ".message-content", // adjust after inspecting live DOM
    roleFromNode: (node) => (node.closest(".user-row") ? "user" : "assistant"),
    textFromNode: (node) => node.innerText,
    tokenizerFamily: "heuristic-cjk", // denser heuristic for Chinese text
    inputSelector: 'textarea', // adjust after inspecting live DOM
    composerSelector: 'form', // placeholder — adjust after inspecting live DOM
    defaultContextLimit: 128000,
  },
  {
    id: "kimi",
    hostMatch: (h) => h.includes("kimi.moonshot.cn"),
    messageSelector: ".chat-content-item", // adjust after inspecting live DOM
    roleFromNode: (node) => (node.closest(".chat-content-item-user") ? "user" : "assistant"),
    textFromNode: (node) => node.innerText,
    tokenizerFamily: "heuristic-cjk",
    inputSelector: 'textarea', // adjust after inspecting live DOM
    composerSelector: 'form', // placeholder — adjust after inspecting live DOM
    defaultContextLimit: 200000,
  },
  {
    id: "grok",
    hostMatch: (h) => h.includes("grok.com"),
    messageSelector: '.message-bubble, [data-testid="conversation-turn"]', // placeholder — adjust after inspecting live DOM
    roleFromNode: (node) =>
      node.matches('[data-message-role="user"], .message-bubble.user') ? "user" : "assistant",
    textFromNode: (node) => node.innerText,
    tokenizerFamily: "heuristic", // xAI's tokenizer isn't public; Grok also doesn't expose a per-chat token API at all
    inputSelector: 'textarea', // adjust after inspecting live DOM
    composerSelector: 'form', // placeholder — adjust after inspecting live DOM
    defaultContextLimit: 128000, // conservative default (free tier); paid tiers run up to 2M — edit via the panel
  },
];

function tallyGetSiteConfig() {
  const host = location.host;
  return TALLY_SITE_CONFIGS.find((c) => c.hostMatch(host)) || null;
}

// Per-site context limit can be overridden by the user (click the "of X"
// label in the panel) since the same site often hosts multiple models with
// different context windows. Stored in localStorage, not chrome.storage,
// so it's simple and scoped per-origin automatically.
function tallyGetContextLimit(config) {
  const stored = localStorage.getItem(`tally-limit-${config.id}`);
  const n = stored ? parseInt(stored, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : config.defaultContextLimit;
}

function tallySetContextLimit(config, value) {
  localStorage.setItem(`tally-limit-${config.id}`, String(value));
}
