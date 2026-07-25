# Gonona — AI Token Counter & Context Bridge

Chrome/Edge MV3 extension that counts tokens live on ChatGPT, Claude, Gemini, GLM, Kimi, and Grok; shows a quiet meter under the chat composer; and bridges conversation context between providers.

## Install (dev mode)

1. Chrome/Edge → `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select this folder
3. Open a supported chat site — an inline meter appears under the composer; click the Gonona toolbar icon for the full popup

Marketing / setup guide: open [`index.html`](index.html) or visit [gonona.vercel.app](https://gonona.vercel.app/).

## Project structure

```
tally-extension/
├── manifest.json              # MV3 entry: permissions, hosts, content scripts, popup
├── site-config.js             # Per-site selectors, model detection, avg-token priors
├── vendor/gpt-tokenizer.bundle.js
├── tokenizer.js               # tallyCountTokens()
├── claude-tokens.js           # Claude.ai tree walk + o200k (Tally-style)
├── chatgpt-tokens.js          # ChatGPT conversation.mapping + o200k
├── optimizer.js               # Local prompt compressor (handler retained)
├── meter.js                   # Shadow-DOM under-composer meter
├── content.js                 # Scan DOM, stats, meter mount, actions, transfer
├── inject.js                  # MAIN-world fetch hook (multi-site SSE/JSON)
├── popup.html / popup.js      # Toolbar UI
├── index.html                 # Standalone setup / marketing page
├── icons/ · assets/
└── package.json
```

### Load order (content scripts)

1. **MAIN world** (`document_start`): `inject.js` — wraps `fetch` before the app caches it
2. Isolated world (`document_idle`): `site-config.js` → `gpt-tokenizer` → `tokenizer.js` → `claude-tokens.js` → `chatgpt-tokens.js` → `token-api.js` → `optimizer.js` → `meter.js` → `content.js`

### Fetch intercept (per site)

| Site | What inject captures | Meter meaning |
|------|----------------------|---------------|
| Claude | SSE `message_limit` + conversation tree | Session % (exact util) + o200k IN/OUT |
| ChatGPT | `usage` when present; `/backend-api/conversation/{id}` mapping | Context %; o200k tree if no usage |
| Gemini | `usageMetadata` in stream/JSON | Context % from Google’s own counts when present |
| Grok | OpenAI-shaped `usage` when present | Context %; else o200k DOM |
| GLM / Kimi | — | DOM heuristic only |

Priority: **inject usage → conversation tree → API key → DOM estimate**.

### Claude (same approach as Tally)

Claude.ai does **not** expose `input_tokens` in the chat SSE. Gonona mirrors Tally:

1. Live-parse SSE `message_limit` → unrounded 5h / 7d **session utilization** (meter %)
2. Intercept `/chat_conversations/…?tree=` → walk active branch → **o200k** token estimate (IN/OUT)
3. RPC `GET /api/organizations/{org}/usage` with page cookies (bootstrap until SSE fires)

Optional Anthropic API key (`count_tokens`) remains a separate exact path for pasted DOM turns.
## Runtime flow

```
supported host
    → content scripts
    → content.js: inject.js + MutationObserver + meter mount
         ├─ inject.js (fetch) → exact usage postMessage
         ├─ tokenizer → estimate per message
         └─ updateStats → chrome.storage.tallyLatest + meter UI
              → popup.js (live via storage.onChanged)
```

### Inline meter (Tally-style)

- Mounts under `composerSelector` (fallback: near input, then fixed corner).
- Shows: **%**, hairline fill, **≈ msgs left** (model-aware), short runway, exact|est.
- Gonona cream/sage styling; Shadow DOM so host CSS can't clobber it.

### Model-aware msgs-left

- Detects model label when the site exposes a switcher (`modelSelector`).
- Uses `TALLY_MODEL_AVG_TOKENS` priors (e.g. Opus ≫ Haiku), blended with observed chat average once enough turns exist.

### Popup actions

| Action | Behavior |
|--------|----------|
| Copy prompts | User messages → clipboard (via popup) |
| Copy context | Formatted transcript → clipboard |
| Move to … | `tallyPendingTransfer` + open target tab |
| Reset | Clear counters / rescan |

### Context bridge

Source stores `{ targetSite, context, timestamp }`; destination `checkPendingTransfer` pastes into the composer within 2 minutes.

## Extending to a new site

Add an object to `TALLY_SITE_CONFIGS` (`hostMatch`, selectors, `composerSelector`, optional `modelSelector` / `defaultModel`, `defaultContextLimit`), then add the origin to `manifest.json` host lists.

## Caveats

- DOM selectors drift — fix in `site-config.js`.
- Consumer ChatGPT often omits `usage` in SSE; Gonona falls back to conversation mapping + o200k.
- Claude.ai context tokens are **o200k estimates**. Session **%** from `message_limit` is exact utilization.
- Gemini web endpoints are obfuscated; we deep-scan for `usageMetadata` when Google emits it.
- Grok may omit usage → o200k DOM estimate.
- GLM / Kimi stay heuristic (no stable usage fields).
## Token count APIs (exact)

When you add keys under **API keys** in the popup, Gonona recounts the open chat via:

| Site | Endpoint |
|------|----------|
| ChatGPT | `POST https://api.openai.com/v1/responses/input_tokens` |
| Claude | `POST https://api.anthropic.com/v1/messages/count_tokens` |
| Gemini | `POST …/models/{model}:countTokens` |
| Grok | `POST https://api.x.ai/v1/tokenize-text` (sum of token ids) |

Keys stay in `chrome.storage.local` only. Without a key for that provider, Gonona keeps using local estimates / inject usage hooks.
