import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

async function importTestableRenderModule() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fork-render-"));
  const modulePath = path.join(tmpDir, "render.testable.ts");

  fs.writeFileSync(
    path.join(tmpDir, "coding-agent-stub.mjs"),
    `export function getMarkdownTheme() { return {}; }\n` +
      "export function keyHint(action, label) { return `${action} ${label}`; }\n",
  );
  fs.writeFileSync(
    path.join(tmpDir, "tui-stub.mjs"),
    `export class Text { constructor(text, x, y) { this.text = text; this.x = x; this.y = y; } }\n` +
      `export class Markdown { constructor(text, x, y, theme) { this.text = text; this.x = x; this.y = y; this.theme = theme; } }\n` +
      `export class Spacer { constructor(size) { this.size = size; } }\n` +
      `export class Container { constructor() { this.children = []; } addChild(child) { this.children.push(child); } }\n`,
  );
  fs.writeFileSync(
    path.join(tmpDir, "runner-events-stub.mjs"),
    `export function getFinalAssistantText(messages) {\n` +
      `  const message = Array.isArray(messages) ? messages.at(-1) : undefined;\n` +
      `  const part = message?.content?.find?.((p) => p?.type === "text");\n` +
      `  return part?.text || "";\n` +
      `}\n`,
  );
  fs.writeFileSync(
    path.join(tmpDir, "types-stub.mjs"),
    `export function isResultSuccess(result) { return result?.exitCode === 0; }\n` +
      `export function isResultError(result) { return result?.exitCode !== -1 && result?.exitCode !== 0; }\n`,
  );

  const source = fs
    .readFileSync(path.join(process.cwd(), "src", "render.ts"), "utf-8")
    .replace('from "@earendil-works/pi-coding-agent"', 'from "./coding-agent-stub.mjs"')
    .replace('from "@earendil-works/pi-tui"', 'from "./tui-stub.mjs"')
    .replace('from "./runner-events.js"', 'from "./runner-events-stub.mjs"')
    .replace('from "./types.js"', 'from "./types-stub.mjs"');

  fs.writeFileSync(modulePath, source);
  const mod = await import(`${pathToFileURL(modulePath).href}?t=${Date.now()}`);
  return { mod, cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }) };
}

function makeTheme() {
  return {
    fg(_color, text) { return text; },
    bold(text) { return text; },
  };
}

function makeToolResult(overrides = {}) {
  return {
    content: [],
    details: {
      results: [{
        task: "inspect",
        exitCode: 0,
        messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
        stderr: "",
        usage: {
          turns: 1,
          input: 1200,
          output: 340,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0.0123,
          contextTokens: 0,
        },
        provider: "openai-codex",
        model: "openai-codex/gpt-5.5",
        effort: {
          selected: "deep",
          source: "tool",
          profile: { provider: "openai-codex", id: "gpt-5.5", thinking: "high" },
        },
        ...overrides,
      }],
    },
  };
}

function collectText(node) {
  if (!node || typeof node !== "object") return "";
  if (typeof node.text === "string") return node.text;
  if (Array.isArray(node.children)) return node.children.map(collectText).filter(Boolean).join("\n");
  return "";
}

test("renderForkResult uses Pi keyHint for collapsed expansion hint", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "src", "render.ts"), "utf-8");

  assert.match(source, /keyHint\("app\.tools\.expand", "to expand"\)/);
  assert.doesNotMatch(source, /Ctrl\+O to expand/);
});

test("renderForkResult renders provider, model, and thinking level in usage metadata", async () => {
  const { mod, cleanup } = await importTestableRenderModule();
  try {
    const rendered = mod.renderForkResult(makeToolResult(), { expanded: false }, makeTheme());
    const text = collectText(rendered);

    assert.match(text, /\(openai-codex\) gpt-5\.5 • high/);
    assert.doesNotMatch(text, /openai-codex\/gpt-5\.5/);
    assert.doesNotMatch(text, /effort deep/);
  } finally {
    cleanup();
  }
});

test("renderForkResult omits separate effort section in expanded view", async () => {
  const { mod, cleanup } = await importTestableRenderModule();
  try {
    const rendered = mod.renderForkResult(makeToolResult(), { expanded: true }, makeTheme());
    const text = collectText(rendered);

    assert.match(text, /\(openai-codex\) gpt-5\.5 • high/);
    assert.doesNotMatch(text, /─── Effort ───/);
    assert.doesNotMatch(text, /effort deep/);
  } finally {
    cleanup();
  }
});

test("renderForkResult renders context fill before model metadata when available", async () => {
  const { mod, cleanup } = await importTestableRenderModule();
  try {
    const rendered = mod.renderForkResult(makeToolResult({
      usage: {
        turns: 12,
        input: 192000,
        output: 7900,
        cacheRead: 2000000,
        cacheWrite: 0,
        cost: 2.1756,
        contextTokens: 98464,
        contextWindow: 272000,
      },
    }), { expanded: false }, makeTheme());
    const text = collectText(rendered);

    assert.match(text, /12 turns ↑192k ↓7\.9k R2\.0M \$2\.1756 36\.2%\/272k \(openai-codex\) gpt-5\.5 • high/);
  } finally {
    cleanup();
  }
});

test("renderForkResult omits context fill when context data is incomplete", async () => {
  const { mod, cleanup } = await importTestableRenderModule();
  try {
    const rendered = mod.renderForkResult(makeToolResult({
      usage: {
        turns: 1,
        input: 1200,
        output: 340,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0.0123,
        contextTokens: 98464,
      },
    }), { expanded: false }, makeTheme());
    const text = collectText(rendered);

    assert.match(text, /1 turn ↑1\.2k ↓340 \$0\.0123 \(openai-codex\) gpt-5\.5 • high/);
    assert.doesNotMatch(text, /%\/272k/);
  } finally {
    cleanup();
  }
});

test("renderForkResult shows all stored activities only when expanded", async () => {
  const { mod, cleanup } = await importTestableRenderModule();
  try {
    const activities = Array.from({ length: 12 }, (_, i) => ({
      type: "tool",
      toolCallId: `call_${i}`,
      toolName: "read",
      status: "completed",
      displayText: `read src/${i}.ts`,
      updates: 1,
      activityOrder: i + 1,
    }));
    const toolResult = makeToolResult({ messages: [], activities, activityCount: activities.length });
    const collapsed = collectText(mod.renderForkResult(toolResult, { expanded: false }, makeTheme()));
    const expanded = collectText(mod.renderForkResult(toolResult, { expanded: true }, makeTheme()));

    assert.doesNotMatch(collapsed, /read src\/0\.ts/);
    assert.match(collapsed, /\.\.\. 4 earlier activities/);
    assert.match(collapsed, /read src\/4\.ts/);
    assert.match(collapsed, /read src\/11\.ts/);
    assert.match(expanded, /read src\/0\.ts/);
    assert.doesNotMatch(expanded, /earlier activities/);
  } finally {
    cleanup();
  }
});

test("renderForkResult adds response token activity after existing activity", async () => {
  const { mod, cleanup } = await importTestableRenderModule();
  try {
    const toolResult = makeToolResult({
      messages: [{ role: "assistant", content: [{ type: "text", text: "abcdefghijkl" }] }],
      activities: [
        { type: "thinking", status: "completed", tokens: 2, activityOrder: 1 },
        { type: "tool", toolName: "bash", status: "completed", displayText: "bash $ npm test", updates: 1, activityOrder: 2 },
      ],
    });
    const collapsed = collectText(mod.renderForkResult(toolResult, { expanded: false }, makeTheme()));
    const expanded = collectText(mod.renderForkResult(toolResult, { expanded: true }, makeTheme()));

    assert.match(collapsed, /thinking ~2 tokens\n✓ bash \$ npm test\n✓ response ~3 tokens\n\n1 turn/);
    assert.doesNotMatch(collapsed, /abcdefghijkl/);
    assert.match(expanded, /thinking ~2 tokens\n✓ bash \$ npm test\n✓ response ~3 tokens/);
    assert.match(expanded, /abcdefghijkl/);
  } finally {
    cleanup();
  }
});

test("renderForkResult omits response activity while running or without final output", async () => {
  const { mod, cleanup } = await importTestableRenderModule();
  try {
    const running = collectText(mod.renderForkResult(makeToolResult({
      exitCode: -1,
      messages: [{ role: "assistant", content: [{ type: "text", text: "abcdefghijkl" }] }],
    }), { expanded: false }, makeTheme()));
    const empty = collectText(mod.renderForkResult(makeToolResult({
      messages: [],
    }), { expanded: false }, makeTheme()));

    assert.doesNotMatch(running, /response ~/);
    assert.doesNotMatch(running, /\n\n1 turn/);
    assert.match(running, /\(running\.\.\.\)\n1 turn/);
    assert.doesNotMatch(empty, /response ~/);
  } finally {
    cleanup();
  }
});
