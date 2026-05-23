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
    `export function getMarkdownTheme() { return {}; }\n`,
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
