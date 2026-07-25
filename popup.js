// popup.js — runs in the extension popup context.

function render(stats) {
  const emptyEl = document.getElementById("empty-state");
  const contentEl = document.getElementById("content-state");
  if (!emptyEl || !contentEl) return;

  const isStale = !stats || !stats.updatedAt || Date.now() - stats.updatedAt > 5 * 60 * 1000;
  emptyEl.hidden = !isStale;
  contentEl.hidden = isStale;
  if (isStale) return;

  const setText = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };

  const siteName = stats.site ? stats.site.charAt(0).toUpperCase() + stats.site.slice(1) : "Chat";
  setText("site", siteName);
  setText("percent-big", String(stats.percent ?? 0));
  setText("in-tokens", Number.isFinite(stats.promptTokens) ? stats.promptTokens.toLocaleString() : "0");
  setText("out-tokens", Number.isFinite(stats.completionTokens) ? stats.completionTokens.toLocaleString() : "0");
  setText("msgs-left", stats.msgsLeftText || "—");
  setText("runway", stats.runwayText || "—");
  const modelEl = document.getElementById("model-label");
  if (modelEl) {
    modelEl.textContent = stats.modelLabel ? stats.modelLabel : "";
    modelEl.hidden = !stats.modelLabel;
  }

  const arcEl = document.getElementById("gauge-arc");
  if (arcEl) {
    const totalLength = 219.911;
    const pct = Math.min(100, Math.max(0, stats.percent || 0));
    const effectivePct = pct === 0 ? 0.5 : pct;
    arcEl.style.strokeDashoffset = String(totalLength - (effectivePct / 100) * totalLength);
  }

  const dot = document.getElementById("dot");
  const mode = document.getElementById("mode");
  if (dot) dot.classList.toggle("exact", !!stats.exact);
  if (mode) {
    mode.classList.toggle("exact", !!stats.exact);
    mode.textContent = stats.exact ? "EXACT" : "ESTIMATED";
  }
}

function loadStats() {
  try {
    chrome.storage.local.get("tallyLatest", (result) => {
      if (chrome.runtime.lastError) return;
      render(result?.tallyLatest);
    });
  } catch {
    /* popup closing */
  }
}

function sendAction(action, extra = {}) {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab?.id) {
        resolve({ ok: false });
        return;
      }
      chrome.tabs.sendMessage(
        tab.id,
        { type: "tally-action", action, ...extra },
        (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false });
            return;
          }
          setTimeout(loadStats, 150);
          resolve(response || { ok: true });
        }
      );
    });
  });
}

async function copyText(text) {
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;left:-9999px;top:0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

function showToast(message) {
  const toast = document.getElementById("toast");
  if (!toast) return;
  toast.textContent = message;
  toast.style.display = "block";
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => {
    toast.style.display = "none";
  }, 2000);
}

const SITE_URLS = {
  claude: "https://claude.ai/new",
  gemini: "https://gemini.google.com/app",
  grok: "https://grok.com/",
  chatgpt: "https://chatgpt.com/",
};

function moveTo(targetSite) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab?.id) return;
    chrome.tabs.sendMessage(
      tab.id,
      { type: "tally-action", action: "move-to", targetSite },
      () => {
        void chrome.runtime.lastError;
        const url = SITE_URLS[targetSite];
        if (url) chrome.tabs.create({ url });
      }
    );
  });
}

document.addEventListener("DOMContentLoaded", () => {
  const copyBtn = document.getElementById("copy-btn");
  if (copyBtn) {
    copyBtn.addEventListener("click", async () => {
      const result = await sendAction("copy");
      const ok = await copyText(result?.text);
      showToast(ok ? "Copied prompts to clipboard" : "No prompts to copy");
    });
  }

  const copyContextBtn = document.getElementById("copy-context-btn");
  if (copyContextBtn) {
    copyContextBtn.addEventListener("click", async () => {
      const result = await sendAction("copy-context");
      const ok = await copyText(result?.text);
      showToast(ok ? "Copied context to clipboard" : "No context to copy");
    });
  }

  const moveClaude = document.getElementById("move-claude");
  if (moveClaude) {
    moveClaude.addEventListener("click", () => {
      moveTo("claude");
      showToast("Opening Claude with context...");
    });
  }

  const moveGemini = document.getElementById("move-gemini");
  if (moveGemini) {
    moveGemini.addEventListener("click", () => {
      moveTo("gemini");
      showToast("Opening Gemini with context...");
    });
  }

  const moveGrok = document.getElementById("move-grok");
  if (moveGrok) {
    moveGrok.addEventListener("click", () => {
      moveTo("grok");
      showToast("Opening Grok with context...");
    });
  }

  const moveChatGPT = document.getElementById("move-chatgpt");
  if (moveChatGPT) {
    moveChatGPT.addEventListener("click", () => {
      moveTo("chatgpt");
      showToast("Opening ChatGPT with context...");
    });
  }

  const resetBtn = document.getElementById("reset-btn");
  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      sendAction("reset");
      showToast("Counters reset");
    });
  }

  document.querySelectorAll(".site-link").forEach((link) => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: "https://gonona.vercel.app/" });
    });
  });

  const KEY_FIELDS = [
    ["key-openai", "openai"],
    ["key-anthropic", "anthropic"],
    ["key-gemini", "gemini"],
    ["key-xai", "xai"],
  ];

  function loadApiKeys() {
    chrome.storage.local.get("gononaApiKeys", (res) => {
      if (chrome.runtime.lastError) return;
      const keys = res?.gononaApiKeys || {};
      KEY_FIELDS.forEach(([inputId, key]) => {
        const el = document.getElementById(inputId);
        if (el && keys[key]) el.value = keys[key];
      });
    });
  }

  const keysSave = document.getElementById("keys-save");
  if (keysSave) {
    keysSave.addEventListener("click", () => {
      const gononaApiKeys = {};
      KEY_FIELDS.forEach(([inputId, key]) => {
        const el = document.getElementById(inputId);
        const val = (el?.value || "").trim();
        if (val) gononaApiKeys[key] = val;
      });
      chrome.storage.local.set({ gononaApiKeys }, () => {
        showToast("API keys saved");
      });
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.tallyLatest) return;
    render(changes.tallyLatest.newValue);
  });

  loadApiKeys();
  loadStats();
});
