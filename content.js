// content.js — runs in the isolated content-script world.

(function () {
  const config = tallyGetSiteConfig();
  if (!config) return;

  // --- inject the page-context fetch hook ---
  const s = document.createElement("script");
  s.src = chrome.runtime.getURL("inject.js");
  s.onload = function () {
    this.remove();
  };
  (document.head || document.documentElement).appendChild(s);

  let exactTotal = null; // set if a provider ever reports real usage
  let seen = new WeakSet();
  let promptTokens = 0;
  let completionTokens = 0;
  let messageCount = 0;
  const sessionStart = Date.now();

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.data?.source === "tally-inject" && event.data.type === "usage") {
      exactTotal = event.data.totalTokens;
      updateStats();
    }
  });

  function scanMessages() {
    const nodes = document.querySelectorAll(config.messageSelector);
    nodes.forEach((node) => {
      if (seen.has(node)) return;
      seen.add(node);
      const role = config.roleFromNode(node);
      const text = config.textFromNode(node) || "";
      const count = tallyCountTokens(text, config.tokenizerFamily);
      if (role === "user") promptTokens += count;
      else completionTokens += count;
      messageCount += 1;
    });
    updateStats();
  }

  function formatElapsed(ms) {
    const mins = Math.floor(ms / 60000);
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    return `${hrs}h ${mins % 60}m`;
  }

  function updateStats() {
    const total = exactTotal ?? promptTokens + completionTokens;
    const limit = tallyGetContextLimit(config);
    const remaining = Math.max(0, limit - total);
    const percent = Math.min(100, Math.round((total / limit) * 100));

    // Forecast: how many more messages fit, and how long until the window
    // fills up, both based on the average pace observed SO FAR this chat.
    // Needs a little data before it's meaningful, so it stays "—" early on.
    const avgTokensPerMsg = messageCount > 0 ? total / messageCount : 0;
    let msgsLeftText = "—";
    if (avgTokensPerMsg > 0) {
      const estMsgsLeft = Math.max(0, Math.floor(remaining / avgTokensPerMsg));
      msgsLeftText = `~${estMsgsLeft.toLocaleString()}`;
    }

    const elapsedMin = (Date.now() - sessionStart) / 60000;
    let runwayText = "—";
    if (elapsedMin >= 0.5 && total > 0) {
      const tokensPerMin = total / elapsedMin;
      const etaMin = remaining / tokensPerMin;
      runwayText = formatElapsed(etaMin * 60000);
    }

    persistStats({ total, limit, remaining, percent, msgsLeftText, runwayText });
  }

  // --- share live stats with the toolbar popup ---
  // The popup runs in a totally separate context (it's not a content script
  // and has no access to this page's variables), so the only way it can
  // show live numbers is by reading something we write to chrome.storage.
  function persistStats(extra) {
    if (!chrome?.runtime?.id || !chrome?.storage?.local) return;
    try {
      chrome.storage.local.set({
        tallyLatest: {
          site: config.id,
          exact: exactTotal !== null,
          promptTokens,
          completionTokens,
          messageCount,
          ...extra,
          updatedAt: Date.now(),
        },
      });
    } catch (e) {
      // Ignore extension context invalidated errors silently
    }
  }

  // Let the popup trigger the same actions the panel buttons do
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== "tally-action") return;
    if (message.action === "copy") copyConversation();
    if (message.action === "copy-context") {
      const ok = copyContext();
      sendResponse({ ok });
    }
    if (message.action === "move-to") moveToSite(message.targetSite);
    if (message.action === "optimize") optimizeCurrentPrompt();
    if (message.action === "reset") {
      promptTokens = 0;
      completionTokens = 0;
      exactTotal = null;
      seen = new WeakSet();
      messageCount = 0;
      updateStats();
    }
  });

  // Keep the elapsed-time readout ticking even between scans
  setInterval(() => {
    updateStats();
  }, 30000);

  // --- copy user input prompts to clipboard ---
  function copyConversation() {
    const nodes = document.querySelectorAll(config.messageSelector);
    const lines = [];
    nodes.forEach((node) => {
      const role = config.roleFromNode(node);
      if (role !== "user") return;
      const text = (config.textFromNode(node) || "").trim();
      if (!text) return;
      lines.push(text);
    });

    if (lines.length === 0) {
      const el = getInputElement();
      if (el) {
        const inputVal = (readInputText(el) || "").trim();
        if (inputVal) lines.push(inputVal);
      }
    }

    const transcript = lines.join("\n\n");
    if (transcript) {
      navigator.clipboard.writeText(transcript).catch(() => {});
    }
  }

  // --- extract full conversation context ---
  function getFormattedContext() {
    const nodes = document.querySelectorAll(config.messageSelector);
    const turns = [];
    nodes.forEach((node) => {
      const role = config.roleFromNode(node);
      const text = (config.textFromNode(node) || "").trim();
      if (!text) return;
      turns.push(`${role === "user" ? "User" : "Assistant"}: ${text}`);
    });

    if (turns.length === 0) {
      const el = getInputElement();
      if (el) {
        const inputVal = (readInputText(el) || "").trim();
        if (inputVal) turns.push(`User: ${inputVal}`);
      }
    }

    if (turns.length === 0) return "";

    return `Here is the context from my previous conversation:\n\n---\n${turns.join("\n\n")}\n---\n\nPlease continue based on the conversation context above.`;
  }

  function copyContext() {
    const context = getFormattedContext();
    if (context) {
      navigator.clipboard.writeText(context).catch(() => {});
    } else {
      // Return error signal so popup can show user feedback
      return false;
    }
    return true;
  }

  function moveToSite(targetSite) {
    const context = getFormattedContext();
    if (!context) return;

    if (chrome?.storage?.local) {
      chrome.storage.local.set({
        tallyPendingTransfer: {
          targetSite,
          context,
          timestamp: Date.now(),
        },
      });
    }

    navigator.clipboard.writeText(context).catch(() => {});
  }

  function checkPendingTransfer() {
    if (!chrome?.storage?.local) return;
    chrome.storage.local.get("tallyPendingTransfer", (res) => {
      const transfer = res?.tallyPendingTransfer;
      if (!transfer || !transfer.context) return;
      if (Date.now() - transfer.timestamp > 120000) {
        chrome.storage.local.remove("tallyPendingTransfer");
        return;
      }

      if (transfer.targetSite && transfer.targetSite !== config.id) return;

      chrome.storage.local.remove("tallyPendingTransfer");

      let attempts = 0;
      const interval = setInterval(() => {
        attempts++;
        const el = getInputElement();
        if (el) {
          clearInterval(interval);
          writeInputText(el, transfer.context);
          el.focus();
        } else if (attempts >= 20) {
          clearInterval(interval);
        }
      }, 500);
    });
  }

  // --- optimize the prompt currently sitting in the input box ---
  function getInputElement() {
    if (!config.inputSelector) return null;
    return document.querySelector(config.inputSelector);
  }

  function readInputText(el) {
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") return el.value;
    return el.innerText;
  }

  function writeInputText(el, text) {
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      el.value = text;
      // Most of these frameworks (React et al.) listen for native input
      // events, not just value changes, to update their own state.
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    // Contenteditable (ChatGPT, Claude, Gemini all use this for the composer).
    // Select all existing content and replace it via execCommand so the
    // site's own rich-text framework sees it as a real edit, not a DOM
    // mutation it doesn't know about.
    el.focus();
    document.execCommand("selectAll", false);
    const ok = document.execCommand("insertText", false, text);
    if (!ok) {
      // Fallback if execCommand is unavailable/blocked
      el.textContent = text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  function optimizeCurrentPrompt() {
    const el = getInputElement();
    if (!el) return;
    const before = readInputText(el);
    if (!before.trim()) return;
    const after = tallyOptimizePrompt(before);
    writeInputText(el, after);
  }

  let scanScheduled = false;
  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    // Debounce: batch up rapid streaming mutations into one scan instead of
    // reacting synchronously to every single DOM change.
    setTimeout(() => {
      scanScheduled = false;
      scanMessages();
    }, 200);
  }

  const observer = new MutationObserver(() => {
    scheduleScan();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  scanMessages();
  checkPendingTransfer();
})();
