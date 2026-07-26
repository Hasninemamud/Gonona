// content.js — runs in the isolated content-script world.

(function () {
  const config = tallyGetSiteConfig();
  if (!config) return;

  const isClaude = config.id === "claude";
  const isChatGPT = config.id === "chatgpt";

  // Fallback inject if MAIN-world document_start script didn't load
  {
    const s = document.createElement("script");
    s.src = chrome.runtime.getURL("inject.js");
    s.onload = function () {
      this.remove();
    };
    (document.head || document.documentElement).appendChild(s);
  }

  const meter = tallyCreateMeter();

  let exactTotal = null;
  let apiSource = null;
  let promptTokens = 0;
  let completionTokens = 0;
  let messageCount = 0;
  const sessionStart = Date.now();
  let lastStats = null;
  let treeFresh = false; // Claude/ChatGPT tree owns IN/OUT until DOM is richer

  // Claude session / conversation (Tally-style)
  let sessionUtil = null; // five_hour utilization 0–100 (may be fractional)
  let sessionResetsAt = null;
  let weeklyUtil = null;
  let weeklyResetsAt = null;
  let claudeOrgId = null;
  let claudeConversationId = null;
  let pendingRpc = new Map();

  function rpc(kind, payload, timeoutMs = 15000) {
    const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        pendingRpc.delete(requestId);
        reject(new Error(`RPC timeout (${kind})`));
      }, timeoutMs);
      pendingRpc.set(requestId, { resolve, reject, t });
      window.postMessage(
        { source: "tally-content", type: "request", requestId, kind, payload },
        "*"
      );
    });
  }

  function getCookie(name) {
    const m = document.cookie.match(
      new RegExp(`(?:^|; )${name.replace(/([.$?*|{}()[\]\\/+^])/g, "\\$1")}=([^;]*)`)
    );
    if (!m) return null;
    let v = decodeURIComponent(m[1]);
    // Claude lastActiveOrg is sometimes a quoted UUID
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    return v;
  }

  /**
   * Normalize utilization to 0–100.
   * SSE message_limit: typically 0–1 fractions → asFraction true.
   * /usage API: typically 0–100 percents → asFraction false.
   * Heuristic: if asFraction omitted and value ≤ 1, treat as fraction.
   */
  function normalizeUtilization(raw, { asFraction } = {}) {
    const u = typeof raw === "string" ? parseFloat(raw) : raw;
    if (!Number.isFinite(u) || u < 0) return null;
    const fraction =
      asFraction === true || (asFraction !== false && u <= 1);
    const pct = fraction ? u * 100 : u;
    return Math.min(100, Math.max(0, pct));
  }

  function applyMessageLimit(limit) {
    if (!limit || typeof limit !== "object") return;
    // Live SSE shape often nests five_hour / seven_day, or flat fields
    const five = limit.five_hour || limit;
    const seven = limit.seven_day || null;

    const fiveUtil = normalizeUtilization(
      five.utilization ?? five.percent ?? five.utilization_percent,
      { asFraction: five.utilization != null && five.utilization <= 1 ? true : undefined }
    );
    if (fiveUtil !== null) {
      sessionUtil = fiveUtil;
      sessionResetsAt =
        five.resets_at || five.resetsAt || five.reset_time || sessionResetsAt;
    } else {
      const flat = normalizeUtilization(limit.utilization ?? limit.percent);
      if (flat !== null) {
        sessionUtil = flat;
        sessionResetsAt =
          limit.resets_at || limit.resetsAt || sessionResetsAt;
      }
    }

    if (seven) {
      const sevenUtil = normalizeUtilization(
        seven.utilization ?? seven.percent
      );
      if (sevenUtil !== null) {
        weeklyUtil = sevenUtil;
        weeklyResetsAt =
          seven.resets_at || seven.resetsAt || weeklyResetsAt;
      }
    }

    updateStats();
  }

  function applyUsagePayload(usage) {
    if (!usage || typeof usage !== "object") return;
    // /usage returns rounded five_hour / seven_day as percents (0–100)
    if (usage.five_hour) {
      const u = normalizeUtilization(usage.five_hour.utilization, {
        asFraction: false,
      });
      // Prefer live SSE if we already have it
      if (sessionUtil === null && u !== null) sessionUtil = u;
      sessionResetsAt = usage.five_hour.resets_at || sessionResetsAt;
    }
    if (usage.seven_day) {
      const u = normalizeUtilization(usage.seven_day.utilization, {
        asFraction: false,
      });
      if (weeklyUtil === null && u !== null) weeklyUtil = u;
      weeklyResetsAt = usage.seven_day.resets_at || weeklyResetsAt;
    }
    updateStats();
  }

  function applyConversation(payload) {
    if (!payload?.data) return;
    const platform = payload.platform || (isClaude ? "claude" : isChatGPT ? "chatgpt" : null);

    if (platform === "claude") {
      if (typeof tallyComputeClaudeConversationTokens !== "function") return;
      if (payload.orgId) claudeOrgId = payload.orgId;
      if (payload.conversationId) claudeConversationId = payload.conversationId;

      const metrics = tallyComputeClaudeConversationTokens(payload.data);
      applyTokenSnapshot(metrics, "claude-tree", true);
      return;
    }

    if (platform === "chatgpt") {
      if (typeof tallyComputeChatGPTConversationTokens !== "function") return;
      const metrics = tallyComputeChatGPTConversationTokens(payload.data);
      if (metrics.totalTokens <= 0) return;
      applyTokenSnapshot(metrics, "chatgpt-tree", true);
    }
  }

  /** Apply a full conversation token snapshot (tree or DOM). */
  function applyTokenSnapshot(metrics, source, isTree) {
    if (!metrics) return;
    promptTokens = metrics.promptTokens || 0;
    completionTokens = metrics.completionTokens || 0;
    messageCount = metrics.messageCount || 0;
    const total = metrics.totalTokens ?? promptTokens + completionTokens;
    if (total > 0) {
      // Don't shrink below a larger inject exact total for the same turn
      if (!(apiSource === "inject" && exactTotal !== null && exactTotal > total * 1.15)) {
        exactTotal = total;
      }
      apiSource = source;
    }
    treeFresh = !!isTree;
    updateStats();
  }

  function recountFromDom() {
    const all = Array.from(document.querySelectorAll(config.messageSelector));
    // Drop nested matches (parent+child both matching) to avoid double-count
    const nodes = all.filter(
      (n) => !all.some((o) => o !== n && n.contains(o))
    );
    let prompt = 0;
    let completion = 0;
    let count = 0;
    nodes.forEach((node) => {
      const role = config.roleFromNode(node);
      if (role === "system" || role === "tool") return;
      const text = (config.textFromNode(node) || "").trim();
      if (!text) return;
      const n = tallyCountTokens(text, config.tokenizerFamily);
      if (role === "user") prompt += n;
      else completion += n;
      count += 1;
    });
    return {
      promptTokens: prompt,
      completionTokens: completion,
      messageCount: count,
      totalTokens: prompt + completion,
    };
  }

  async function refreshClaudeUsage() {
    if (!isClaude) return;
    const orgId = claudeOrgId || getCookie("lastActiveOrg");
    if (!orgId) return;
    claudeOrgId = orgId;
    try {
      const usage = await rpc("usage", { orgId });
      applyUsagePayload(usage);
    } catch {
      /* ignore */
    }
  }

  function formatCountdown(isoOrMs) {
    if (!isoOrMs) return "—";
    const target =
      typeof isoOrMs === "number" ? isoOrMs : Date.parse(isoOrMs);
    if (!Number.isFinite(target)) return "—";
    const ms = Math.max(0, target - Date.now());
    return formatElapsed(ms);
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== "tally-inject") return;

    if (data.type === "response") {
      const pending = pendingRpc.get(data.requestId);
      if (!pending) return;
      pendingRpc.delete(data.requestId);
      clearTimeout(pending.t);
      if (data.ok) pending.resolve(data.payload);
      else pending.reject(new Error(data.error || "RPC failed"));
      return;
    }

    if (data.type === "usage") {
      const p = data.payload || data;
      const total = p.totalTokens;
      if (!Number.isFinite(total) || total <= 0) return;

      // Prefer full-conversation tree over smaller per-turn stream usage
      if (
        (apiSource === "chatgpt-tree" || apiSource === "claude-tree") &&
        exactTotal !== null &&
        total < exactTotal
      ) {
        return;
      }

      exactTotal = total;
      apiSource = "inject";

      // Gemini-style: prompt ≈ full IN; candidates ≈ last OUT — merge carefully
      if (Number.isFinite(p.inputTokens) && p.inputTokens > 0) {
        promptTokens = Math.max(promptTokens, p.inputTokens);
      }
      if (Number.isFinite(p.outputTokens) && p.outputTokens > 0) {
        // If DOM/tree completion is already larger, keep it (cumulative OUT)
        if (completionTokens <= p.outputTokens * 1.2) {
          completionTokens = Math.max(completionTokens, p.outputTokens);
        }
      }
      if (messageCount < 1) messageCount = 1;
      updateStats();
      return;
    }

    if (data.type === "message_limit") {
      applyMessageLimit(data.payload);
      return;
    }

    if (data.type === "conversation") {
      applyConversation(data.payload);
      return;
    }

    if (data.type === "generation_start") {
      // Soft hint: next stream will refresh session util
      return;
    }
  });

  function scanMessages() {
    const dom = recountFromDom();

    // Tree snapshot wins until DOM catches up (more messages / tokens)
    if (
      treeFresh &&
      (apiSource === "claude-tree" || apiSource === "chatgpt-tree") &&
      dom.messageCount <= messageCount &&
      dom.totalTokens <= promptTokens + completionTokens
    ) {
      scheduleMeterMount();
      updateStats();
      return;
    }

    if (dom.messageCount > 0 || dom.totalTokens > 0) {
      promptTokens = dom.promptTokens;
      completionTokens = dom.completionTokens;
      messageCount = dom.messageCount;
      treeFresh = false;
      if (exactTotal === null) {
        // leave exactTotal null → estimated mode uses local sum
      } else if (apiSource === "inject" && exactTotal !== null) {
        // keep inject exact total for %; IN/OUT from DOM above
      } else if (
        (apiSource === "claude-tree" || apiSource === "chatgpt-tree") &&
        dom.totalTokens > (exactTotal || 0)
      ) {
        exactTotal = dom.totalTokens;
        apiSource = "dom";
      }
    }

    scheduleMeterMount();
    updateStats();
  }

  function formatElapsed(ms) {
    const mins = Math.floor(ms / 60000);
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    return `${hrs}h ${mins % 60}m`;
  }

  function shortModelLabel(label, modelId) {
    const raw = (label || modelId || "").trim();
    if (!raw) return "";
    const cleaned = raw.replace(/\s+/g, " ");
    if (cleaned.length <= 18) return cleaned;
    return cleaned.slice(0, 16) + "…";
  }

  function updateStats() {
    const localTotal = promptTokens + completionTokens;
    const contextTotal = Math.max(exactTotal ?? 0, localTotal);
    const contextExact = exactTotal !== null;
    const model = tallyDetectModel(config);
    const limit = Math.max(1, tallyGetContextLimit(config, model.id) || 1);
    const remaining = Math.max(0, limit - contextTotal);

    const modelPrior = tallyAvgTokensForModel(model.id);
    // Avg tokens per full turn (user+assistant ≈ 2 messages)
    const turns = Math.max(1, Math.ceil(messageCount / 2));
    const observedAvg = messageCount > 0 ? localTotal / turns : 0;

    let avgTokensPerMsg = modelPrior;
    if (turns >= 3 && observedAvg > 0) {
      avgTokensPerMsg = observedAvg * 0.7 + modelPrior * 0.3;
    } else if (turns >= 1 && observedAvg > 0) {
      avgTokensPerMsg = observedAvg * 0.4 + modelPrior * 0.6;
    }
    avgTokensPerMsg = Math.max(200, avgTokensPerMsg);

    let percent;
    let isExact;
    let runwayText = "—";
    let msgsLeftText = "—";

    // Context-window msgs left (all sites)
    const contextMsgsLeft = remaining / avgTokensPerMsg;

    if (isClaude && sessionUtil !== null && Number.isFinite(sessionUtil)) {
      // sessionUtil is always stored as 0–100 after normalizeUtilization
      percent = Math.min(100, Math.max(0, Math.round(sessionUtil)));
      isExact = true;
      runwayText = formatCountdown(sessionResetsAt);

      const utilFrac = Math.min(99.9, Math.max(0, sessionUtil)) / 100;
      const remainingFrac = Math.max(0, 1 - utilFrac);
      let sessionMsgs = null;
      if (utilFrac > 0.01 && turns > 0) {
        sessionMsgs = (turns * remainingFrac) / utilFrac;
      }
      // Prefer the more conservative estimate (session vs context)
      const msgs =
        sessionMsgs !== null
          ? Math.min(sessionMsgs, contextMsgsLeft || sessionMsgs)
          : contextMsgsLeft;
      msgsLeftText = tallyFormatMsgsLeft(msgs);
    } else {
      percent = Math.min(100, Math.round((contextTotal / limit) * 100));
      isExact = contextExact;
      msgsLeftText = tallyFormatMsgsLeft(contextMsgsLeft);

      const elapsedMin = (Date.now() - sessionStart) / 60000;
      if (elapsedMin >= 0.5 && contextTotal > 0 && remaining > 0) {
        const tokensPerMin = contextTotal / elapsedMin;
        if (tokensPerMin > 0) {
          runwayText = formatElapsed((remaining / tokensPerMin) * 60000);
        }
      }
    }

    const modelLabel = model.label || shortModelLabel(model.raw, model.id);
    lastStats = {
      total: contextTotal,
      limit,
      remaining,
      percent,
      msgsLeftText,
      runwayText,
      model: model.id,
      modelLabel,
      exact: isExact,
      promptTokens,
      completionTokens,
      messageCount,
      apiSource:
        isClaude && sessionUtil !== null
          ? "claude-session"
          : exactTotal !== null
            ? apiSource || "inject"
            : apiSource,
      sessionUtil,
      weeklyUtil,
    };

    persistStats(lastStats);
    meter.update(lastStats);
  }

  function persistStats(extra) {
    if (!chrome?.runtime?.id || !chrome?.storage?.local) return;
    try {
      chrome.storage.local.set({
        tallyLatest: {
          site: config.id,
          exact: !!extra.exact,
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

  function ensureMeterMounted() {
    const composer = tallyFindComposer(config);
    meter.mountUnder(composer);
  }

  let mountScheduled = false;
  function scheduleMeterMount() {
    if (mountScheduled) return;
    mountScheduled = true;
    setTimeout(() => {
      mountScheduled = false;
      ensureMeterMounted();
    }, 320);
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== "tally-action") return;

    if (message.action === "copy") {
      sendResponse({ ok: true, text: getUserPromptsText() });
      return;
    }
    if (message.action === "copy-context") {
      const text = getFormattedContext();
      sendResponse({ ok: !!text, text });
      return;
    }
    if (message.action === "move-to") {
      moveToSite(message.targetSite);
      sendResponse({ ok: true });
      return;
    }
    if (message.action === "optimize") {
      optimizeCurrentPrompt();
      sendResponse({ ok: true });
      return;
    }
    if (message.action === "reset") {
      promptTokens = 0;
      completionTokens = 0;
      exactTotal = null;
      apiSource = null;
      treeFresh = false;
      sessionUtil = null;
      sessionResetsAt = null;
      weeklyUtil = null;
      weeklyResetsAt = null;
      messageCount = 0;
      scanMessages();
      if (isClaude) void refreshClaudeUsage();
      sendResponse({ ok: true });
    }
  });

  setInterval(() => {
    scheduleMeterMount();
    updateStats();
  }, 30000);

  function getUserPromptsText() {
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

    return lines.join("\n\n");
  }

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
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    el.focus();
    document.execCommand("selectAll", false);
    const ok = document.execCommand("insertText", false, text);
    if (!ok) {
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
    setTimeout(() => {
      scanScheduled = false;
      scanMessages();
    }, 200);
  }

  const observer = new MutationObserver((mutations) => {
    // Ignore our own meter reparenting — it was causing mount ↔ fixed jitter
    const meterId = "gonona-inline-meter";
    const relevant = mutations.some((m) => {
      const t = m.target;
      if (!t) return false;
      if (t.id === meterId || t.closest?.("#" + meterId)) {
        return false;
      }
      if (m.type === "childList") {
        const nodes = [...m.addedNodes, ...m.removedNodes];
        if (
          nodes.length &&
          nodes.every(
            (n) =>
              n.id === meterId ||
              (n.nodeType === 1 && n.closest?.("#" + meterId))
          )
        ) {
          return false;
        }
      }
      return true;
    });
    if (!relevant) return;
    scheduleScan();
    scheduleMeterMount();
  });
  const observeRoot = document.body || document.documentElement;
  if (observeRoot) {
    observer.observe(observeRoot, { childList: true, subtree: true });
  }

  scheduleMeterMount();
  scanMessages();
  checkPendingTransfer();

  if (isClaude) {
    // Bootstrap session % from /usage (cookies) until live SSE arrives
    setTimeout(() => void refreshClaudeUsage(), 800);
    setInterval(() => void refreshClaudeUsage(), 5 * 60 * 1000);
  }
})();
