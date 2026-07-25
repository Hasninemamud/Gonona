// meter.js — quiet under-composer token meter (Tally-style, Gonona colors).

const GONONA_METER_HOST_ID = "gonona-inline-meter";
const GONONA_METER_MAX_WIDTH = 720;

function tallyMeterResolveWidth(anchor) {
  const vw = window.innerWidth || 1200;
  let w = 0;
  if (anchor?.getBoundingClientRect) {
    w = anchor.getBoundingClientRect().width;
  }
  // Full-bleed parents (Gemini/Grok): prefer nested input / card width
  if (w > vw * 0.72) {
    const nested =
      anchor.querySelector?.(
        'textarea, [contenteditable="true"], rich-textarea, [class*="query-bar" i], [class*="input-area" i]'
      ) || null;
    const nw = nested?.getBoundingClientRect?.().width || 0;
    if (nw >= 240 && nw < w) w = nw;
  }
  if (!w || w < 200 || w > vw * 0.92) {
    w = Math.min(GONONA_METER_MAX_WIDTH, vw - 48);
  }
  return Math.round(Math.min(w, GONONA_METER_MAX_WIDTH, vw - 24));
}

function tallyMeterAnchorVisible(el) {
  if (!el || !document.contains(el)) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 160 || r.height < 16) return false;
  // Must be roughly in the lower half / composer zone (not a random mid-page node)
  const vh = window.innerHeight || 800;
  if (r.bottom < 0 || r.top > vh) return false;
  return true;
}

function tallyCreateMeter() {
  let host = document.getElementById(GONONA_METER_HOST_ID);
  if (host) return host._gononaMeter;

  host = document.createElement("div");
  host.id = GONONA_METER_HOST_ID;
  host.setAttribute("data-gonona", "meter");
  host.style.cssText =
    "display:block;box-sizing:border-box;width:100%;max-width:720px;margin:0 auto;";

  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host {
        display: block;
        width: 100%;
        max-width: inherit;
        box-sizing: border-box;
        font-family: "Avenir Next", "Segoe UI", ui-sans-serif, sans-serif;
      }
      .bar {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
        margin: 6px 0 2px;
        padding: 6px 10px;
        background: #FFF2DF;
        border: 1.5px solid #607456;
        border-radius: 10px;
        box-shadow: 2px 2px 0 #607456;
        color: #2d3a28;
        font-size: 11px;
        line-height: 1.2;
        box-sizing: border-box;
        width: 100%;
      }
      .bar.fixed {
        position: fixed;
        right: 16px;
        bottom: 16px;
        z-index: 2147483646;
        width: min(320px, calc(100vw - 32px));
        margin: 0;
        box-shadow: 2px 2px 0 #607456;
      }
      .brand {
        font-weight: 800;
        letter-spacing: -0.2px;
        color: #607456;
        flex: none;
      }
      .pct {
        font-weight: 800;
        font-variant-numeric: tabular-nums;
        flex: none;
      }
      .track {
        flex: 1 1 48px;
        min-width: 48px;
        height: 4px;
        border-radius: 999px;
        background: #e0d8c8;
        overflow: hidden;
      }
      .fill {
        height: 100%;
        width: 0%;
        background: #607456;
        border-radius: 999px;
        transition: width 0.25s ease;
      }
      .meta {
        color: #607456;
        font-weight: 600;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 100%;
      }
      .mode {
        margin-left: auto;
        font-size: 9px;
        font-weight: 700;
        letter-spacing: 0.6px;
        text-transform: uppercase;
        color: #8fa888;
        flex: none;
      }
      .mode.exact { color: #e8a849; }
    </style>
    <div class="bar" part="bar">
      <span class="brand">gonona</span>
      <span class="pct" data-pct>0%</span>
      <div class="track" aria-hidden="true"><div class="fill" data-fill></div></div>
      <span class="meta" data-meta>≈ — msgs</span>
      <span class="mode" data-mode>est</span>
    </div>
  `;

  const api = {
    host,
    mounted: false,
    fixed: false,
    _anchor: null,
    _misses: 0,
    _lastWidth: 0,

    update(stats) {
      const pct = Math.min(100, Math.max(0, stats.percent || 0));
      const pctEl = shadow.querySelector("[data-pct]");
      const fillEl = shadow.querySelector("[data-fill]");
      const metaEl = shadow.querySelector("[data-meta]");
      const modeEl = shadow.querySelector("[data-mode]");
      if (pctEl) pctEl.textContent = `${pct}%`;
      if (fillEl) fillEl.style.width = `${pct}%`;
      const msgs = stats.msgsLeftText || "—";
      // Keep model label short so the bar doesn't thrash layout
      let model = "";
      if (stats.modelLabel) {
        const m = String(stats.modelLabel).replace(/\s+/g, " ").trim();
        if (m && !/pin model|overview|table|docs/i.test(m)) {
          model = ` · ${m.length > 18 ? m.slice(0, 16) + "…" : m}`;
        }
      }
      const runway =
        stats.runwayText && stats.runwayText !== "—" ? ` · ${stats.runwayText}` : "";
      if (metaEl) metaEl.textContent = `≈ ${msgs} msgs${model}${runway}`;
      if (modeEl) {
        const mode =
          stats.apiSource === "claude-session"
            ? "session"
            : stats.exact
              ? "exact"
              : "est";
        modeEl.textContent = mode;
        modeEl.classList.toggle("exact", !!stats.exact);
      }
    },

    _applyInlineWidth(anchor) {
      const widthPx = tallyMeterResolveWidth(anchor);
      // Only rewrite style when width changed meaningfully (avoids layout jitter)
      if (Math.abs(widthPx - this._lastWidth) < 8 && !this.fixed) return;
      this._lastWidth = widthPx;
      host.style.cssText = `display:block;box-sizing:border-box;width:${widthPx}px;max-width:100%;margin:0 auto;`;
    },

    mountUnder(anchor) {
      const bar = shadow.querySelector(".bar");

      // Sticky: keep current inline mount if still healthy
      if (
        this._anchor &&
        !this.fixed &&
        tallyMeterAnchorVisible(this._anchor) &&
        host.isConnected &&
        host.previousElementSibling === this._anchor
      ) {
        this._misses = 0;
        // Same anchor (or a nested replacement we should ignore) — stay put
        if (!anchor || anchor === this._anchor || this._anchor.contains(anchor)) {
          this._applyInlineWidth(this._anchor);
          this.mounted = true;
          return;
        }
        // Prefer keeping outer form over hopping to a child footer
        if (anchor.contains?.(this._anchor)) {
          // New candidate is outer — allow upgrade once
        } else if (this._anchor.contains?.(anchor)) {
          this._applyInlineWidth(this._anchor);
          this.mounted = true;
          return;
        }
      }

      if (!anchor || !tallyMeterAnchorVisible(anchor)) {
        // Hysteresis: don't flip to fixed on a single missed frame
        this._misses += 1;
        if (this._misses < 4 && this.mounted && host.isConnected) {
          return;
        }
        bar.classList.add("fixed");
        host.style.cssText =
          "display:block;box-sizing:border-box;width:auto;max-width:none;margin:0;";
        if (host.parentElement !== document.body) {
          document.body.appendChild(host);
        }
        this.fixed = true;
        this._anchor = null;
        this._lastWidth = 0;
        this.mounted = true;
        return;
      }

      this._misses = 0;
      bar.classList.remove("fixed");
      this.fixed = false;
      this._applyInlineWidth(anchor);

      const needsMove =
        host.parentElement !== anchor.parentElement ||
        host.previousElementSibling !== anchor;
      if (needsMove) {
        anchor.insertAdjacentElement("afterend", host);
      }
      this._anchor = anchor;
      this.mounted = true;
    },
  };

  host._gononaMeter = api;
  return api;
}
