// optimizer.js
//
// A local, rule-based prompt compressor. Deliberately NOT calling out to an
// LLM API to "optimize" the prompt — that would mean shipping an API key,
// a network round-trip before every send, and a black-box rewrite of the
// user's own words. This instead applies a fixed, inspectable set of rules:
// strip filler phrases, collapse whitespace, tighten common verbose
// constructions. It will never change the meaning of the prompt, only its
// padding.

const TALLY_FILLER_PHRASES = [
  /\bI would like you to\b/gi,
  /\bcould you please\b/gi,
  /\bcan you please\b/gi,
  /\bplease kindly\b/gi,
  /\bI was wondering if you could\b/gi,
  /\bI just wanted to\b/gi,
  /\bjust to be clear,?\b/gi,
  /\bas you (?:may|might) (?:already )?know,?\b/gi,
  /\bin order to\b/g,
  /\bdue to the fact that\b/gi,
  /\bat this point in time\b/gi,
  /\bfor all intents and purposes\b/gi,
  /\bit is important to note that\b/gi,
  /\bplease note that\b/gi,
  /\bkind of\b/gi,
  /\bsort of\b/gi,
  /\bbasically\b/gi,
  /\bactually\b/gi,
  /\bvery\s+/gi,
  /\breally\s+/gi,
  /\bthanks in advance[.!]?/gi,
];

const TALLY_REPLACEMENTS = [
  [/\bin order to\b/gi, "to"],
  [/\bdue to the fact that\b/gi, "because"],
  [/\bat this point in time\b/gi, "now"],
  [/\bin the event that\b/gi, "if"],
  [/\ba large number of\b/gi, "many"],
  [/\bmake use of\b/gi, "use"],
];

function tallyOptimizePrompt(text) {
  let out = text;

  // Apply concise replacements first (more useful than outright deletion)
  for (const [pattern, replacement] of TALLY_REPLACEMENTS) {
    out = out.replace(pattern, replacement);
  }
  // Strip pure filler with no informational content
  for (const pattern of TALLY_FILLER_PHRASES) {
    out = out.replace(pattern, "");
  }

  // Collapse whitespace left behind by removals
  out = out
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/ +([.,!?])/g, "$1")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();

  return out;
}
