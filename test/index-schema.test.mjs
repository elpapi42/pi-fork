import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

function createTestableIndexModule() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fork-index-"));
  const modulePath = path.join(tmpDir, "index.testable.ts");

  fs.writeFileSync(
    path.join(tmpDir, "typebox-stub.mjs"),
    `export const Type = {
  Object(properties) {
    const required = Object.entries(properties)
      .filter(([, schema]) => !schema.__optional)
      .map(([key]) => key);
    return { type: "object", properties, required };
  },
  String(options = {}) { return { type: "string", ...options }; },
  Optional(schema) {
    const { __optional, ...rest } = schema;
    return { ...rest, __optional: true };
  },
  Unsafe(schema) { return schema; },
};
`,
  );
  fs.writeFileSync(path.join(tmpDir, "coding-agent-stub.mjs"), `export function getAgentDir() { return ""; }\n`);
  fs.writeFileSync(path.join(tmpDir, "cost-stub.mjs"), `export function aggregateInclusiveCost() { return {}; }\nexport function formatForkCostStatus() { return ""; }\n`);
  fs.writeFileSync(path.join(tmpDir, "config-stub.mjs"), `export const EFFORT_LEVELS = ["fast", "balanced", "deep"];\nexport function loadConfig() { return { extensions: null, environment: {}, costFooter: false }; }\n`);
  fs.writeFileSync(path.join(tmpDir, "render-stub.mjs"), `export function renderForkCall() {}\nexport function renderForkResult() {}\n`);
  fs.writeFileSync(path.join(tmpDir, "runner-stub.mjs"), `export async function runFork() { return { messages: [], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 } }; }\n`);
  fs.writeFileSync(path.join(tmpDir, "runner-events-stub.mjs"), `export function getResultSummaryText() { return ""; }\n`);
  fs.writeFileSync(path.join(tmpDir, "types-stub.mjs"), `export function emptyUsage() { return { inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 }; }\nexport function isResultError() { return false; }\n`);

  const sourcePath = path.join(process.cwd(), "src", "index.ts");
  const source = fs
    .readFileSync(sourcePath, "utf-8")
    .replace('from "@mariozechner/pi-coding-agent"', 'from "./coding-agent-stub.mjs"')
    .replace('from "@sinclair/typebox"', 'from "./typebox-stub.mjs"')
    .replace('from "./cost.js"', 'from "./cost-stub.mjs"')
    .replace('from "./config.js"', 'from "./config-stub.mjs"')
    .replace('from "./render.js"', 'from "./render-stub.mjs"')
    .replace('from "./runner.js"', 'from "./runner-stub.mjs"')
    .replace('from "./runner-events.js"', 'from "./runner-events-stub.mjs"')
    .replace('from "./types.js"', 'from "./types-stub.mjs"');

  fs.writeFileSync(modulePath, source);
  return {
    moduleUrl: pathToFileURL(modulePath).href,
    cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
  };
}

async function getForkParameters() {
  const { moduleUrl, cleanup } = createTestableIndexModule();
  try {
    const { default: registerExtension } = await import(`${moduleUrl}?t=${Date.now()}`);
    let registeredTool;
    registerExtension({
      on() {},
      registerTool(tool) { registeredTool = tool; },
    });
    assert.ok(registeredTool, "fork tool should be registered");
    return registeredTool.parameters;
  } finally {
    cleanup();
  }
}

function validate(schema, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return false;
  for (const key of schema.required || []) {
    if (!(key in args)) return false;
  }
  for (const [key, property] of Object.entries(schema.properties || {})) {
    if (!(key in args)) continue;
    const value = args[key];
    if (property.type === "string" && typeof value !== "string") return false;
    if (property.enum && !property.enum.includes(value)) return false;
  }
  return true;
}

test("fork effort schema uses provider-compatible string enum", async () => {
  const parameters = await getForkParameters();
  const effortSchema = parameters.properties.effort;

  assert.equal(effortSchema.type, "string");
  assert.deepEqual(effortSchema.enum, ["fast", "balanced", "deep"]);
  assert.equal("anyOf" in effortSchema, false);
  assert.deepEqual(parameters.required, ["task"]);
});

test("fork effort schema accepts omitted or plain effort and rejects quoted effort", async () => {
  const parameters = await getForkParameters();

  assert.equal(validate(parameters, { task: "inspect this" }), true);
  assert.equal(validate(parameters, { task: "inspect this", effort: "balanced" }), true);
  assert.equal(validate(parameters, { task: "inspect this", effort: "\"balanced\"" }), false);
});
