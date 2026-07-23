// tokenizer.js
//
// Three tiers, cheapest to most accurate:
//  1. heuristic       — chars/4, tuned for Latin-script text
//  2. heuristic-cjk   — chars/1.6, tuned for CJK text (much denser per-char)
//  3. gpt (exact)     — delegates to window.GPTTokenizer_o200k_base if present
//
// For exact GPT counts: `npm i gpt-tokenizer`, then copy the package's
// pre-built browser bundle straight into vendor/ (no bundler step needed —
// it's already a self-registering UMD build):
//   cp node_modules/gpt-tokenizer/dist/o200k_base.js vendor/gpt-tokenizer.bundle.js
// Add "vendor/gpt-tokenizer.bundle.js" to manifest.json's content_scripts.js
// array BEFORE this file, and it will expose the global used below.
// Without that copy step, GPT falls back to the heuristic automatically.

function tallyIsCJK(str) {
  return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/.test(str);
}

function tallyHeuristicCount(text, dense = false) {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  const divisor = dense || tallyIsCJK(trimmed) ? 1.6 : 4;
  return Math.max(1, Math.ceil(trimmed.length / divisor));
}

function tallyCountTokens(text, tokenizerFamily) {
  if (!text) return 0;

  switch (tokenizerFamily) {
    case "gpt": {
      // Exact path, only active if you've vendored gpt-tokenizer (see note above)
      if (typeof window.GPTTokenizer_o200k_base?.encode === "function") {
        return window.GPTTokenizer_o200k_base.encode(text).length;
      }
      return tallyHeuristicCount(text, false);
    }
    case "heuristic-cjk":
      return tallyHeuristicCount(text, true);
    case "heuristic":
    default:
      return tallyHeuristicCount(text, false);
  }
}
