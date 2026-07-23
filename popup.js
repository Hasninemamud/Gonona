// popup.js — runs in the extension popup context.

function render(stats) {
  const emptyEl = document.getElementById("empty-state");
  const contentEl = document.getElementById("content-state");

  const isStale = !stats || Date.now() - stats.updatedAt > 5 * 60 * 1000;
  emptyEl.hidden = !isStale;
  contentEl.hidden = isStale;
  if (isStale) return;

  const siteName = stats.site ? stats.site.charAt(0).toUpperCase() + stats.site.slice(1) : "Chat";
  document.getElementById("site").textContent = siteName;
  document.getElementById("percent-big").textContent = stats.percent;
  document.getElementById("limit").textContent = stats.limit ? stats.limit.toLocaleString() : "128,000";
  document.getElementById("in-tokens").textContent = stats.promptTokens ? stats.promptTokens.toLocaleString() : "0";
  document.getElementById("out-tokens").textContent = stats.completionTokens ? stats.completionTokens.toLocaleString() : "0";
  document.getElementById("msgs-left").textContent = stats.msgsLeftText || "—";
  document.getElementById("runway").textContent = stats.runwayText || "—";

  // Arc Gauge SVG path stroke-dashoffset (total length is 219.911 for r=70 semi-circle)
  const arcEl = document.getElementById("gauge-arc");
  if (arcEl) {
    const totalLength = 219.911;
    const pct = Math.min(100, Math.max(0, stats.percent || 0));
    // When pct is 0 or 1, ensure at least a tiny visible indicator start
    const effectivePct = pct === 0 ? 0.5 : pct;
    const offset = totalLength - (effectivePct / 100) * totalLength;
    arcEl.style.strokeDashoffset = offset;
  }

  const dot = document.getElementById("dot");
  const mode = document.getElementById("mode");
  if (dot) dot.classList.toggle("exact", stats.exact);
  if (mode) {
    mode.classList.toggle("exact", stats.exact);
    mode.textContent = stats.exact ? "EXACT" : "ESTIMATED";
  }
}

function loadStats() {
  chrome.storage.local.get("tallyLatest", (result) => render(result.tallyLatest));
}

function sendAction(action) {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab) { resolve(false); return; }
      chrome.tabs.sendMessage(tab.id, { type: "tally-action", action }, (response) => {
        if (chrome.runtime.lastError) { resolve(false); return; }
        setTimeout(loadStats, 150);
        resolve(true);
      });
    });
  });
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
    if (!tab) return;
    chrome.tabs.sendMessage(
      tab.id,
      { type: "tally-action", action: "move-to", targetSite },
      () => {
        const url = SITE_URLS[targetSite];
        if (url && chrome.tabs?.create) {
          chrome.tabs.create({ url });
        }
      }
    );
  });
}

document.addEventListener("DOMContentLoaded", () => {
  const copyBtn = document.getElementById("copy-btn");
  if (copyBtn) {
    copyBtn.addEventListener("click", async () => {
      const success = await sendAction("copy");
      showToast(success ? "Copied prompts to clipboard" : "No prompts to copy");
    });
  }

  const copyContextBtn = document.getElementById("copy-context-btn");
  if (copyContextBtn) {
    copyContextBtn.addEventListener("click", async () => {
      const success = await sendAction("copy-context");
      showToast(success ? "Copied context to clipboard" : "No context to copy");
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

  const optimizeBtn = document.getElementById("optimize-btn");
  if (optimizeBtn) {
    optimizeBtn.addEventListener("click", () => {
      sendAction("optimize");
      showToast("Prompt optimized");
    });
  }

  const resetBtn = document.getElementById("reset-btn");
  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      sendAction("reset");
      showToast("Counters reset");
    });
  }

  loadStats();
});
