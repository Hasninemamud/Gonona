// site-config.js
// Central place to add/adjust support for a new site.
// Selectors WILL drift as these apps ship frontend updates — this is the
// file you'll come back to fix most often.

const TALLY_SITE_CONFIGS = [
  {
    id: "chatgpt",
    hostMatch: (h) => h.includes("chatgpt.com") || h.includes("chat.openai.com"),
    messageSelector: '[data-message-author-role]',
    roleFromNode: (node) => {
      const r = node.getAttribute("data-message-author-role");
      if (r === "user" || r === "assistant" || r === "system" || r === "tool") {
        return r;
      }
      return r || "assistant";
    },
    textFromNode: (node) => node.innerText,
    tokenizerFamily: "gpt",
    inputSelector: '#prompt-textarea, div[contenteditable="true"]#prompt-textarea, div.ProseMirror[contenteditable="true"]',
    composerSelector: 'form[data-type="unified-composer"], form:has(#prompt-textarea), form:has([data-testid="composer-footer"])',
    modelSelector: '[data-testid="model-switcher-dropdown-button"], button[aria-label*="GPT" i], button[aria-label*="model" i]',
    defaultModel: "gpt-4o",
    defaultContextLimit: 128000,
  },
  {
    id: "claude",
    hostMatch: (h) => h.includes("claude.ai"),
    messageSelector: '[data-testid="user-message"], [data-testid="assistant-message"], .font-claude-message',
    roleFromNode: (node) =>
      node.matches('[data-testid="user-message"]') ? "user" : "assistant",
    textFromNode: (node) => node.innerText,
    tokenizerFamily: "gpt",
    inputSelector: '[contenteditable="true"].ProseMirror, div[contenteditable="true"]',
    composerSelector: 'fieldset:has(.ProseMirror), form:has(.ProseMirror), div[class*="composer" i]',
    modelSelector: 'button[data-testid="model-selector-dropdown"], button[aria-label*="Claude" i], [aria-label*="model" i]',
    defaultModel: "claude-sonnet",
    defaultContextLimit: 200000,
  },
  {
    id: "gemini",
    hostMatch: (h) => h.includes("gemini.google.com"),
    messageSelector: ".conversation-container .query-text, .conversation-container .model-response-text, .query-text, .model-response-text",
    roleFromNode: (node) =>
      node.matches(".query-text") || node.classList?.contains("query-text")
        ? "user"
        : "assistant",
    textFromNode: (node) => node.innerText,
    tokenizerFamily: "gpt",
    inputSelector: 'rich-textarea div[contenteditable="true"]',
    composerSelector: 'form:has(rich-textarea), .input-area-container:has(rich-textarea), .text-input-field, input-container, .input-area',
    modelSelector: '[data-test-id="bard-mode-menu-button"], button.mode-chip, button[aria-label*="Flash" i], button[aria-label*="Pro" i]',
    defaultModel: "gemini-flash",
    defaultContextLimit: 1000000,
  },
  {
    id: "glm",
    hostMatch: (h) => h.includes("chatglm.cn"),
    messageSelector: ".message-content",
    roleFromNode: (node) => (node.closest(".user-row") ? "user" : "assistant"),
    textFromNode: (node) => node.innerText,
    tokenizerFamily: "heuristic-cjk",
    inputSelector: "textarea",
    composerSelector: "form, .chat-input-area, .input-wrap",
    modelSelector: null,
    defaultModel: "glm",
    defaultContextLimit: 128000,
  },
  {
    id: "kimi",
    hostMatch: (h) => h.includes("kimi.moonshot.cn"),
    messageSelector: ".chat-content-item",
    roleFromNode: (node) => (node.closest(".chat-content-item-user") ? "user" : "assistant"),
    textFromNode: (node) => node.innerText,
    tokenizerFamily: "heuristic-cjk",
    inputSelector: "textarea",
    composerSelector: "form, .chat-input, .editor-container",
    modelSelector: null,
    defaultModel: "kimi",
    defaultContextLimit: 200000,
  },
  {
    id: "grok",
    hostMatch: (h) => h.includes("grok.com"),
    messageSelector: '.message-bubble, [data-testid="conversation-turn"], [data-message-role]',
    roleFromNode: (node) => {
      const role = node.getAttribute?.("data-message-role");
      if (role === "user") return "user";
      if (role === "assistant") return "assistant";
      return node.matches('[data-message-role="user"], .message-bubble.user')
        ? "user"
        : "assistant";
    },
    textFromNode: (node) => node.innerText,
    tokenizerFamily: "gpt",
    inputSelector: 'textarea, div[contenteditable="true"]',
    composerSelector: 'form:has(textarea), form:has([contenteditable="true"]), [class*="composer" i]:has(textarea)',
    modelSelector: 'button[aria-label*="Grok" i], button[aria-label*="model" i], [data-testid*="model" i]',
    defaultModel: "grok",
    defaultContextLimit: 128000,
  },
];

// Typical tokens per full turn (user + assistant) for msgs-left estimates.
const TALLY_MODEL_AVG_TOKENS = {
  "claude-opus": 4500,
  "claude-sonnet": 1800,
  "claude-haiku": 900,
  "gpt-4o": 1600,
  "gpt-4.1": 1600,
  "gpt-5": 2000,
  "gpt-5.4": 2000,
  "gpt-5.5": 2200,
  o1: 3200,
  o3: 3200,
  "gemini-pro": 2000,
  "gemini-flash": 1200,
  glm: 1400,
  kimi: 1600,
  grok: 1600,
  "grok-3": 1800,
  "grok-4": 2000,
  default: 1500,
};

const TALLY_MODEL_CONTEXT = {
  "claude-opus": 200000,
  "claude-sonnet": 200000,
  "claude-haiku": 200000,
  "gpt-4o": 128000,
  "gpt-4.1": 128000,
  "gpt-5": 128000,
  "gpt-5.4": 128000,
  "gpt-5.5": 256000,
  o1: 200000,
  o3: 200000,
  "gemini-pro": 1000000,
  "gemini-flash": 1000000,
  glm: 128000,
  kimi: 200000,
  grok: 128000,
  "grok-3": 128000,
  "grok-4": 256000,
};

const TALLY_MODEL_LABELS = {
  "claude-opus": "Opus",
  "claude-sonnet": "Sonnet",
  "claude-haiku": "Haiku",
  "gpt-4o": "GPT-4o",
  "gpt-4.1": "GPT-4.1",
  "gpt-5": "GPT-5",
  "gpt-5.4": "GPT-5.4",
  "gpt-5.5": "GPT-5.5",
  o1: "o1",
  o3: "o3",
  "gemini-pro": "Pro",
  "gemini-flash": "Flash",
  glm: "GLM",
  kimi: "Kimi",
  grok: "Grok",
  "grok-3": "Grok 3",
  "grok-4": "Grok 4",
};

function tallyGetSiteConfig() {
  const host = location.host;
  return TALLY_SITE_CONFIGS.find((c) => c.hostMatch(host)) || null;
}

function tallyGetContextLimit(config, modelId) {
  const stored = localStorage.getItem(`tally-limit-${config.id}`);
  const n = stored ? parseInt(stored, 10) : NaN;
  if (Number.isFinite(n) && n > 0) return n;
  if (modelId && TALLY_MODEL_CONTEXT[modelId]) return TALLY_MODEL_CONTEXT[modelId];
  return config.defaultContextLimit;
}

function tallySetContextLimit(config, value) {
  localStorage.setItem(`tally-limit-${config.id}`, String(value));
}

function tallyNormalizeModelId(raw, config) {
  if (!raw) return config.defaultModel || "default";
  const t = raw.toLowerCase().replace(/\s+/g, " ");
  if (/pin model|overview|docs|table|settings|share|export/i.test(t)) {
    return config.defaultModel || "default";
  }
  if (t.includes("opus")) return "claude-opus";
  if (t.includes("haiku")) return "claude-haiku";
  if (t.includes("sonnet")) return "claude-sonnet";
  if (t.includes("claude")) return "claude-sonnet";
  if (/\bo3\b/.test(t)) return "o3";
  if (/\bo1\b/.test(t)) return "o1";
  if (/gpt[\s-]?5\.5|gpt5\.5/.test(t)) return "gpt-5.5";
  if (/gpt[\s-]?5\.4|gpt5\.4/.test(t)) return "gpt-5.4";
  if (/gpt[\s-]?5|gpt5/.test(t)) return "gpt-5";
  if (/4\.1/.test(t)) return "gpt-4.1";
  if (/4o|gpt-4o/.test(t)) return "gpt-4o";
  if (t.includes("gpt")) return "gpt-4o";
  if (t.includes("flash")) return "gemini-flash";
  if (t.includes("pro") && (t.includes("gemini") || config.id === "gemini")) {
    return "gemini-pro";
  }
  if (t.includes("gemini")) return "gemini-pro";
  if (/grok[\s-]?4/.test(t)) return "grok-4";
  if (/grok[\s-]?3/.test(t)) return "grok-3";
  if (t.includes("grok")) return "grok";
  if (t.includes("glm") || t.includes("chatglm")) return "glm";
  if (t.includes("kimi")) return "kimi";
  return config.defaultModel || "default";
}

function tallyModelDisplayLabel(modelId, rawLabel) {
  if (TALLY_MODEL_LABELS[modelId]) return TALLY_MODEL_LABELS[modelId];
  const raw = (rawLabel || "").replace(/\s+/g, " ").trim();
  if (raw && raw.length <= 18 && !/pin model|overview/i.test(raw)) return raw;
  return modelId || "model";
}

function tallyDetectModel(config) {
  let raw = "";
  if (config.modelSelector) {
    const nodes = document.querySelectorAll(config.modelSelector);
    for (const el of nodes) {
      const text = (el.innerText || el.getAttribute("aria-label") || "").trim();
      if (!text) continue;
      if (/pin model|overview|docs|table|settings|share/i.test(text)) continue;
      // Prefer short chip labels that look like model names
      if (text.length > 80) continue;
      raw = text;
      break;
    }
  }
  // Gemini often shows "Flash" / "Pro" near the composer
  if (!raw && config.id === "gemini") {
    const chip = document.querySelector(
      'button.mode-chip, [data-test-id="bard-mode-menu-button"]'
    );
    if (chip) raw = (chip.innerText || chip.getAttribute("aria-label") || "").trim();
  }
  const id = tallyNormalizeModelId(raw, config);
  return {
    id,
    label: tallyModelDisplayLabel(id, raw),
    raw,
  };
}

function tallyAvgTokensForModel(modelId) {
  return TALLY_MODEL_AVG_TOKENS[modelId] || TALLY_MODEL_AVG_TOKENS.default;
}

function tallyFormatMsgsLeft(n) {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 0.05) return "~0";
  if (n < 10) return `~${n.toFixed(1)}`;
  if (n < 10000) return `~${Math.floor(n).toLocaleString()}`;
  // Huge context (e.g. Gemini 1M) — keep readable
  return `~${Math.floor(n / 1000).toLocaleString()}k`;
}

function tallyFindComposer(config) {
  const input = config.inputSelector
    ? document.querySelector(config.inputSelector)
    : null;

  const candidates = [];
  if (config.composerSelector) {
    document.querySelectorAll(config.composerSelector).forEach((el) => {
      candidates.push(el);
    });
  }
  if (input) {
    candidates.push(
      input.closest('form[data-type="unified-composer"]'),
      input.closest("form"),
      input.closest('[class*="composer" i]'),
      input.closest('[class*="query" i]'),
      input.closest('[class*="input" i]'),
      input.parentElement
    );
  }

  const unique = [...new Set(candidates.filter(Boolean))];
  if (!unique.length) return null;

  const vw = window.innerWidth || 1200;
  let best = null;
  let bestScore = Infinity;

  for (const el of unique) {
    if (!document.contains(el)) continue;
    if (el.matches?.("button, a, svg, input, [role='button']")) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 220 || r.height < 28) continue;
    const vh = window.innerHeight || 800;
    const nearBottomBonus = r.bottom > vh * 0.45 ? -2000 : 4000;
    const fullBleedPenalty = r.width > vw * 0.78 ? 8000 : 0;
    const heightBonus = Math.min(r.height, 200) * -2;
    const score = r.width + fullBleedPenalty + nearBottomBonus + heightBonus;
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }

  return best || unique[0];
}
