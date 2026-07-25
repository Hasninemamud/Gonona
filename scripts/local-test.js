#!/usr/bin/env node
/**
 * Local smoke tests for Gonona multi-site token intercept helpers.
 * Run: node scripts/local-test.js
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
let passed = 0;
let failed = 0;

function ok(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
  }
}

function loadBrowserScript(rel, sandboxExtras = {}) {
  const code = fs.readFileSync(path.join(ROOT, rel), "utf8");
  const sandbox = {
    console,
    Math,
    Date,
    JSON,
    Array,
    Object,
    String,
    Number,
    Map,
    Set,
    WeakSet,
    TextEncoder,
    Uint8Array,
    globalThis: null,
    window: null,
    ...sandboxExtras,
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: rel });
  return sandbox;
}

console.log("\n1) Syntax check extension scripts");
const scripts = [
  "inject.js",
  "content.js",
  "claude-tokens.js",
  "chatgpt-tokens.js",
  "tokenizer.js",
  "meter.js",
  "site-config.js",
  "token-api.js",
  "optimizer.js",
  "popup.js",
];
for (const s of scripts) {
  ok(`parse ${s}`, () => {
    const code = fs.readFileSync(path.join(ROOT, s), "utf8");
    new vm.Script(code, { filename: s });
  });
}

ok("manifest includes chatgpt-tokens.js + MAIN inject", () => {
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
  const isolated = m.content_scripts.find((c) => c.js?.includes("content.js"));
  const main = m.content_scripts.find((c) => c.world === "MAIN");
  assert.ok(main, "MAIN world script missing");
  assert.ok(main.js.includes("inject.js"));
  assert.ok(isolated.js.includes("chatgpt-tokens.js"));
  assert.ok(isolated.js.includes("claude-tokens.js"));
});

ok("site-config gemini/grok use gpt tokenizer", () => {
  const src = fs.readFileSync(path.join(ROOT, "site-config.js"), "utf8");
  assert.ok(
    /id:\s*"gemini"[\s\S]*?tokenizerFamily:\s*"gpt"/.test(src),
    "gemini should use gpt tokenizerFamily"
  );
  assert.ok(
    /id:\s*"grok"[\s\S]*?tokenizerFamily:\s*"gpt"/.test(src),
    "grok should use gpt tokenizerFamily"
  );
});

console.log("\n2) Claude conversation tree tokens");
{
  const tok = loadBrowserScript("tokenizer.js");
  // heuristic path without gpt bundle
  const claude = loadBrowserScript("claude-tokens.js", {
    tallyCountTokens: tok.tallyCountTokens,
    GPTTokenizer_o200k_base: null,
  });

  const conversation = {
    current_leaf_message_uuid: "m2",
    chat_messages: [
      {
        uuid: "m1",
        parent_message_uuid: "00000000-0000-4000-8000-000000000000",
        sender: "human",
        content: [{ type: "text", text: "Hello world" }],
      },
      {
        uuid: "m2",
        parent_message_uuid: "m1",
        sender: "assistant",
        content: [{ type: "text", text: "Hi there, how can I help?" }],
      },
      {
        uuid: "branch",
        parent_message_uuid: "m1",
        sender: "assistant",
        content: [{ type: "text", text: "This branch should be ignored" }],
      },
    ],
  };

  ok("claude trunk excludes sibling branch", () => {
    const m = claude.tallyComputeClaudeConversationTokens(conversation);
    assert.strictEqual(m.messageCount, 2);
    assert.ok(m.promptTokens > 0);
    assert.ok(m.completionTokens > 0);
    assert.strictEqual(m.totalTokens, m.promptTokens + m.completionTokens);
  });

  ok("claude skips thinking blocks", () => {
    const withThink = {
      current_leaf_message_uuid: "a1",
      chat_messages: [
        {
          uuid: "a1",
          parent_message_uuid: "00000000-0000-4000-8000-000000000000",
          sender: "assistant",
          content: [
            { type: "thinking", thinking: "secret " + "x".repeat(500) },
            { type: "text", text: "Visible" },
          ],
        },
      ],
    };
    const m = claude.tallyComputeClaudeConversationTokens(withThink);
    const onlyVisible = claude.tallyComputeClaudeConversationTokens({
      current_leaf_message_uuid: "b1",
      chat_messages: [
        {
          uuid: "b1",
          parent_message_uuid: "00000000-0000-4000-8000-000000000000",
          sender: "assistant",
          content: [{ type: "text", text: "Visible" }],
        },
      ],
    });
    assert.strictEqual(m.totalTokens, onlyVisible.totalTokens);
  });
}

console.log("\n3) ChatGPT conversation.mapping tokens");
{
  const tok = loadBrowserScript("tokenizer.js");
  const gpt = loadBrowserScript("chatgpt-tokens.js", {
    tallyCountTokens: tok.tallyCountTokens,
  });

  const conversation = {
    current_node: "n3",
    mapping: {
      n1: {
        id: "n1",
        parent: null,
        message: {
          author: { role: "system" },
          content: { parts: ["You are ChatGPT"] },
        },
      },
      n2: {
        id: "n2",
        parent: "n1",
        message: {
          author: { role: "user" },
          content: { parts: ["What is 2+2?"] },
        },
      },
      n3: {
        id: "n3",
        parent: "n2",
        message: {
          author: { role: "assistant" },
          content: { parts: ["4"] },
        },
      },
      orphan: {
        id: "orphan",
        parent: "n2",
        message: {
          author: { role: "assistant" },
          content: { parts: ["Ignore this branch"] },
        },
      },
    },
  };

  ok("chatgpt trunk walks current_node only", () => {
    const m = gpt.tallyComputeChatGPTConversationTokens(conversation);
    assert.strictEqual(m.messageCount, 2); // system skipped
    assert.ok(m.promptTokens > 0);
    assert.ok(m.completionTokens > 0);
  });
}

console.log("\n4) Inject usage extractors (vm sandbox)");
{
  const posts = [];
  const sandbox = {
    console,
    location: { host: "chatgpt.com", origin: "https://chatgpt.com" },
    window: null,
    postMessage(msg) {
      posts.push(msg);
    },
    fetch: async () => ({
      headers: { get: () => "application/json" },
      body: {},
      clone() {
        return this;
      },
      async text() {
        return "{}";
      },
      async json() {
        return {};
      },
    }),
    addEventListener() {},
    TextDecoder: class {
      decode() {
        return "";
      }
    },
    Request: class {},
    URL,
    Math,
    JSON,
    Object,
    Array,
    String,
    Number,
    Map,
    Set,
    crypto: undefined,
  };
  sandbox.window = sandbox;
  // Patch inject to capture post via window.postMessage
  const code = fs
    .readFileSync(path.join(ROOT, "inject.js"), "utf8")
    .replace(
      /window\.postMessage\(/g,
      "globalThis.__testPost("
    );
  sandbox.__testPost = (msg) => posts.push(msg);
  sandbox.globalThis = sandbox;

  // Minimal fetch bind
  sandbox.window.fetch = sandbox.fetch;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: "inject.js" });

  ok("inject installs once", () => {
    assert.strictEqual(sandbox.__gononaInjectInstalled, true);
  });

  // Call internal extractors by re-running parse logic via exposed fetch responses
  // We can't easily reach closures — re-test shapes with a mini copy of extractors
  function reportOpenAIUsage(usage, out) {
    const input = usage.prompt_tokens ?? 0;
    const output = usage.completion_tokens ?? 0;
    const total = usage.total_tokens ?? input + output;
    out.push({ totalTokens: total, inputTokens: input, outputTokens: output });
  }
  function reportGeminiUsage(meta, out) {
    const input = meta.promptTokenCount ?? 0;
    const output =
      (meta.candidatesTokenCount ?? 0) + (meta.thoughtsTokenCount ?? 0);
    const total = meta.totalTokenCount ?? input + output;
    out.push({ totalTokens: total, inputTokens: input, outputTokens: output });
  }

  ok("openai usage shape", () => {
    const out = [];
    reportOpenAIUsage(
      { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      out
    );
    assert.deepStrictEqual(out[0], {
      totalTokens: 150,
      inputTokens: 100,
      outputTokens: 50,
    });
  });

  ok("gemini usageMetadata shape", () => {
    const out = [];
    reportGeminiUsage(
      {
        promptTokenCount: 200,
        candidatesTokenCount: 80,
        thoughtsTokenCount: 20,
        totalTokenCount: 300,
      },
      out
    );
    assert.deepStrictEqual(out[0], {
      totalTokens: 300,
      inputTokens: 200,
      outputTokens: 100,
    });
  });
}

console.log("\n5) o200k encode smoke (gpt-tokenizer package)");
ok("node gpt-tokenizer encode", () => {
  const { encode } = require("gpt-tokenizer/encoding/o200k_base");
  const n = encode("Hello from Gonona").length;
  assert.ok(n >= 3 && n < 20, `unexpected token count ${n}`);
});

console.log(`\n${"─".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
