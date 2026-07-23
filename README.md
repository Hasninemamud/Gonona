# Gonona — AI Token Counter & Context Bridge

Chrome/Edge MV3 extension that counts tokens live on ChatGPT, Claude, Gemini, GLM, Kimi, and Grok; optimizes the current prompt; and bridges conversation context between providers.

## Install (dev mode)

1. Chrome/Edge → `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select this folder
3. Open a supported chat site, then click the Gonona toolbar icon for the popup panel

Optional setup page (static guide, not wired into the extension lifecycle): open `setup.html` in a browser.

## Project structure

```
tally-extension/
├── manifest.json              # MV3 entry: permissions, hosts, content scripts, popup
├── site-config.js             # Per-site selectors, tokenizer family, context limits
├── vendor/gpt-tokenizer.bundle.js  # Exact GPT tokenizer (o200k_base)
├── tokenizer.js               # tallyCountTokens() — gpt / heuristic / heuristic-cjk
├── optimizer.js               # Local rule-based prompt compressor
├── content.js                 # Orchestrator: scan DOM, persist stats, handle actions
├── inject.js                  # Page-world fetch hook → exact usage via postMessage
├── popup.html / popup.js      # Toolbar UI: stats + copy / optimize / move / reset
├── setup.html                 # Standalone setup guide (not loaded by manifest)
├── icons/                     # Extension icons
└── package.json               # gpt-tokenizer dependency (vendored into vendor/)
```

### Load order (content scripts)

Declared in `manifest.json` and injected at `document_idle` on matched hosts:

1. `site-config.js` → `TALLY_SITE_CONFIGS`, `tallyGetSiteConfig()`
2. `vendor/gpt-tokenizer.bundle.js` → `window.GPTTokenizer_o200k_base`
3. `tokenizer.js` → `tallyCountTokens()`
4. `optimizer.js` → `tallyOptimizePrompt()`
5. `content.js` → boots the page session

`inject.js` is **not** a content script. It is listed under `web_accessible_resources` and injected by `content.js` as a `<script src="...">` so it runs in the **page JS world** (where it can patch `window.fetch`).

## Runtime flow

```
┌─────────────────────────────────────────────────────────────────┐
│  Supported host (chatgpt / claude / gemini / glm / kimi / grok) │
└───────────────────────────────┬─────────────────────────────────┘
                                │
                    content scripts load (order above)
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│ content.js                                                      │
│  1. tallyGetSiteConfig() — exit if host unknown                 │
│  2. Inject inject.js into page                                  │
│  3. MutationObserver on document.body → debounced scanMessages  │
│  4. Listen for postMessage from inject (exact usage)            │
│  5. Listen for chrome.runtime messages from popup               │
│  6. Persist tallyLatest → chrome.storage.local                  │
│  7. checkPendingTransfer() — auto-paste bridged context         │
└───────────────┬─────────────────────────────┬───────────────────┘
                │                             │
                ▼                             ▼
┌───────────────────────────┐   ┌─────────────────────────────────┐
│ inject.js (page world)    │   │ tokenizer.js                    │
│ Hook window.fetch         │   │ Count each new message node:    │
│ Claude SSE → input+output │   │  gpt → exact encode if present  │
│ Else JSON usage.*Tokens   │   │  heuristic(-cjk) → chars/N      │
│ postMessage → content.js  │   │ Accumulate prompt/completion    │
└───────────────────────────┘   └─────────────────────────────────┘
                │                             │
                └─────────────┬───────────────┘
                              ▼
                 updateStats() → chrome.storage.local
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ popup.js                                                        │
│ Reads tallyLatest; shows gauge / in-out / msgs-left / runway    │
│ Buttons send { type: "tally-action", action } → content.js      │
└─────────────────────────────────────────────────────────────────┘
```

### 1. Boot

1. User opens a matched URL.
2. Content scripts run. `content.js` resolves the site via `location.host` + `hostMatch`.
3. If no config match → silent exit.
4. `inject.js` is appended to the page, then removed after load.
5. Immediate `scanMessages()` + `checkPendingTransfer()`.
6. `MutationObserver` watches the chat DOM (debounced 200ms) for new bubbles.

### 2. Token counting (estimated path)

1. `querySelectorAll(config.messageSelector)` finds message nodes.
2. Unseen nodes (tracked with `WeakSet`) are counted once.
3. `roleFromNode` / `textFromNode` extract role + text.
4. `tallyCountTokens(text, tokenizerFamily)`:
   - **gpt** (ChatGPT): `GPTTokenizer_o200k_base.encode` if vendored, else Latin heuristic
   - **heuristic**: `ceil(len / 4)` (CJK auto-detect → `/ 1.6`)
   - **heuristic-cjk** (GLM / Kimi): denser divisor always
5. Totals split into `promptTokens` (user) and `completionTokens` (assistant).
6. `updateStats()` computes `%` of context limit, msgs remaining, runway time.
7. Stats written to `chrome.storage.local.tallyLatest` for the popup.

### 3. Exact usage (provider path)

1. `inject.js` wraps `window.fetch`.
2. On SSE/JSON responses:
   - **claude.ai**: parse Anthropic SSE (`message_start` input + `message_delta` output)
   - **others**: regex for `"usage": { "total_tokens"|"totalTokens": N }`
3. Reports via `window.postMessage({ source: "tally-inject", type: "usage", totalTokens })`.
4. `content.js` sets `exactTotal` and prefers it over the DOM estimate (`exact: true` in storage).
5. Grok has no public usage API → always estimated.

### 4. Popup UI

1. Toolbar click opens `popup.html` → `popup.js`.
2. Loads `tallyLatest`; if missing or older than 5 minutes → empty state.
3. Otherwise renders site, %, limit, in/out tokens, msgs left, runway, EXACT/ESTIMATED.

### 5. Actions (popup → content)

| Action | What content.js does |
|--------|----------------------|
| `copy` | Clipboard = user prompts only (or current input if none) |
| `copy-context` | Clipboard = formatted User/Assistant transcript |
| `optimize` | Read composer → `tallyOptimizePrompt` → write back |
| `reset` | Clear counters / WeakSet / exactTotal; rescan |
| `move-to` | Save `tallyPendingTransfer` + copy context; popup opens target URL |

**Context bridge (`move-to`) end-to-end:**

1. Popup sends `move-to` with `targetSite`.
2. Content formats full transcript, stores `{ targetSite, context, timestamp }` in `chrome.storage.local`, copies to clipboard.
3. Popup opens Claude / Gemini / Grok / ChatGPT in a new tab.
4. On the destination page, `checkPendingTransfer()` (within 2 minutes, matching `config.id`) pastes into the composer and focuses it.

## Data & permissions

| Mechanism | Purpose |
|-----------|---------|
| `chrome.storage.local` | `tallyLatest` (live stats), `tallyPendingTransfer` (cross-site bridge) |
| `localStorage` (`tally-limit-{siteId}`) | Optional per-site context limit override (`tallyGetContextLimit`) |
| `storage` permission | Read/write extension storage |
| Host permissions | Inject scripts / access listed AI chat origins |

## Supported sites

| Site | Host | Tokenizer | Notes |
|------|------|-----------|--------|
| ChatGPT | chatgpt.com, chat.openai.com | gpt (exact if bundle present) | Selectors relatively stable |
| Claude | claude.ai | heuristic + SSE exact when available | Best exact path via inject |
| Gemini | gemini.google.com | heuristic | |
| GLM | chatglm.cn | heuristic-cjk | Selectors may need live DOM updates |
| Kimi | kimi.moonshot.cn | heuristic-cjk | Selectors may need live DOM updates |
| Grok | grok.com | heuristic only | No public usage API / tokenizer |

## Extending to a new site

1. Add an object to `TALLY_SITE_CONFIGS` in `site-config.js` (`hostMatch`, `messageSelector`, `roleFromNode`, `textFromNode`, `inputSelector`, `tokenizerFamily`, `defaultContextLimit`).
2. Add the origin to `manifest.json`: `host_permissions`, `content_scripts.matches`, and `web_accessible_resources.matches`.
3. Reload the extension and verify message nodes + composer input in DevTools.

## Exact GPT tokenizer (already vendored)

The repo already includes `vendor/gpt-tokenizer.bundle.js` in the content-script list. To refresh it:

```bash
npm i gpt-tokenizer
mkdir -p vendor
cp node_modules/gpt-tokenizer/dist/o200k_base.js vendor/gpt-tokenizer.bundle.js
```

Keep it **before** `tokenizer.js` in `manifest.json`.

## Caveats

- DOM selectors drift when providers ship UI updates — fix in `site-config.js`.
- `composerSelector` is defined per site but not used by the current popup-driven UI.
- Consumer ChatGPT often does not expose usage in fetch responses; GPT exact counts rely on the vendored tokenizer + DOM scan.
- Icons under `icons/` may still be placeholders.
