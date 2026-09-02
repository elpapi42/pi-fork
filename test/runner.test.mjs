import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildChildEnv } from "../src/env.ts";
import { buildForkTaskPrompt, buildPiArgs, runFork } from "../src/runner.ts";
import { isResultError, isResultSuccess, normalizeCompletedResult } from "../src/types.ts";

function envObject(entries) {
  const env = {};
  for (const [key, value] of entries) {
    Object.defineProperty(env, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return env;
}


function makeDetails(results) {
  return { results };
}

async function runWithFakePi(events, { trailingDelayMs = 0, exitCode = 0, effort, offline, resolveContextWindow, onUpdate, signal } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fork-test-"));
  const fakePi = path.join(tmpDir, "fake-pi.mjs");
  fs.writeFileSync(
    fakePi,
    `import { setTimeout as sleep } from "node:timers/promises";
const events = ${JSON.stringify(events)};
for (const event of events) {
  if (event.delayMs) await sleep(event.delayMs);
  process.stdout.write(JSON.stringify(event.value) + "\\n");
}
await sleep(${trailingDelayMs});
if (${exitCode} !== 0) process.exit(${exitCode});
`,
  );

  const originalArgv1 = process.argv[1];
  process.argv[1] = fakePi;
  try {
    return await runFork({
      cwd: process.cwd(),
      task: "retry test",
      forkSessionSnapshotJsonl: '{"type":"session","id":"test-session"}\n',
      extensions: [],
      makeDetails,
      effort,
      offline,
      resolveContextWindow,
      onUpdate,
      signal,
    });
  } finally {
    process.argv[1] = originalArgv1;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function assistantError(overrides = {}) {
  return {
    role: "assistant",
    stopReason: "error",
    errorMessage: "WebSocket error",
    content: [],
    timestamp: 1,
    ...overrides,
  };
}

function assistantSuccess(text = "Recovered after retry.") {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: 2,
  };
}

function makeResult(overrides = {}) {
  return {
    task: "repro",
    exitCode: -1,
    messages: [],
    stderr: "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    },
    ...overrides,
  };
}

test("normalizeCompletedResult treats agent_end with final assistant output as success", () => {
  const result = makeResult({
    exitCode: 1,
    stopReason: "error",
    errorMessage: "Command exited with code 1",
    stderr: "Command exited with code 1",
    sawAgentEnd: true,
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "No matches found; exit code 1 was expected." }],
        timestamp: 1,
      },
    ],
  });

  normalizeCompletedResult(result, false);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stopReason, undefined);
  assert.equal(result.errorMessage, undefined);
  assert.equal(isResultSuccess(result), true);
  assert.equal(isResultError(result), false);
});

test("normalizeCompletedResult keeps aborts as errors without semantic completion", () => {
  const result = makeResult({
    exitCode: 130,
    stderr: "",
  });

  normalizeCompletedResult(result, true);

  assert.equal(result.exitCode, 130);
  assert.equal(result.stopReason, "aborted");
  assert.equal(result.errorMessage, "Fork was aborted.");
  assert.equal(result.stderr, "Fork was aborted.");
  assert.equal(isResultSuccess(result), false);
  assert.equal(isResultError(result), true);
});

test("buildChildEnv overlays configured values onto inherited env", () => {
  const parentEnv = {
    INHERITED: "parent",
    OVERRIDE: "parent",
  };

  assert.deepEqual(
    buildChildEnv({ OVERRIDE: "configured", EMPTY: "" }, parentEnv, "linux"),
    {
      INHERITED: "parent",
      OVERRIDE: "configured",
      EMPTY: "",
      PI_OFFLINE: "1",
    },
  );
  assert.deepEqual(parentEnv, {
    INHERITED: "parent",
    OVERRIDE: "parent",
  });
});

test("buildChildEnv preserves PI_OFFLINE invariant after configured env", () => {
  assert.deepEqual(
    buildChildEnv(
      {
        PI_OFFLINE: "0",
        OTHER: "configured",
      },
      {
        PI_OFFLINE: "parent",
      },
      "linux",
    ),
    {
      PI_OFFLINE: "1",
      OTHER: "configured",
    },
  );
});

test("buildChildEnv removes PI_OFFLINE when offline is false", () => {
  assert.deepEqual(
    buildChildEnv(
      {
        PI_OFFLINE: "1",
        OTHER: "configured",
      },
      {
        PI_OFFLINE: "parent",
        KEEP: "parent",
      },
      "linux",
      false,
    ),
    {
      KEEP: "parent",
      OTHER: "configured",
    },
  );
});

test("buildChildEnv removes PI_OFFLINE case-insensitively on Windows when offline is false", () => {
  assert.deepEqual(
    buildChildEnv(
      {
        pi_offline: "1",
        OTHER: "configured",
      },
      {
        Pi_Offline: "parent-offline",
        KEEP: "parent",
      },
      "win32",
      false,
    ),
    {
      KEEP: "parent",
      OTHER: "configured",
    },
  );
});

test("buildChildEnv applies Windows overrides case-insensitively", () => {
  assert.deepEqual(
    buildChildEnv(
      {
        path: "configured-path",
        pi_offline: "0",
      },
      {
        PATH: "parent-path",
        Pi_Offline: "parent-offline",
        KEEP: "parent",
      },
      "win32",
    ),
    {
      path: "configured-path",
      KEEP: "parent",
      PI_OFFLINE: "1",
    },
  );
});

test("buildChildEnv preserves __proto__ as an own env variable", () => {
  const childEnv = buildChildEnv(
    envObject([["__proto__", "configured-proto"]]),
    envObject([
      ["__proto__", "parent-proto"],
      ["KEEP", "parent"],
    ]),
    "win32",
  );

  assert.deepEqual(
    childEnv,
    envObject([
      ["KEEP", "parent"],
      ["__proto__", "configured-proto"],
      ["PI_OFFLINE", "1"],
    ]),
  );
  assert.equal(Object.getOwnPropertyDescriptor(childEnv, "__proto__")?.value, "configured-proto");
});

test("runFork passes offline false to child env", { timeout: 2500 }, async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fork-env-test-"));
  const fakePi = path.join(tmpDir, "fake-pi.mjs");
  fs.writeFileSync(
    fakePi,
    `const text = process.env.PI_OFFLINE ?? "unset";
const message = { role: "assistant", content: [{ type: "text", text }], timestamp: 1 };
process.stdout.write(JSON.stringify({ type: "message_end", message }) + "\\n");
process.stdout.write(JSON.stringify({ type: "agent_end", messages: [message] }) + "\\n");
`,
  );

  const originalArgv1 = process.argv[1];
  const previousOffline = process.env.PI_OFFLINE;
  process.argv[1] = fakePi;
  process.env.PI_OFFLINE = "1";
  try {
    const result = await runFork({
      cwd: process.cwd(),
      task: "env test",
      forkSessionSnapshotJsonl: '{"type":"session","id":"test-session"}\n',
      extensions: [],
      makeDetails,
      offline: false,
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.messages.at(-1)?.content?.[0]?.text, "unset");
  } finally {
    process.argv[1] = originalArgv1;
    if (previousOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previousOffline;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("runFork waits for delayed child auto-retry before semantic completion", { timeout: 3000 }, async () => {
  const failed = assistantError();
  const recovered = assistantSuccess();

  const startedAt = Date.now();
  const result = await runWithFakePi(
    [
      { value: { type: "message_end", message: failed } },
      { value: { type: "agent_end", messages: [failed] } },
      { delayMs: 350, value: { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "WebSocket error" } },
      { delayMs: 50, value: { type: "message_end", message: recovered } },
      { value: { type: "auto_retry_end", success: true, attempt: 1 } },
      { value: { type: "agent_end", messages: [recovered] } },
    ],
    { trailingDelayMs: 2000 },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.stopReason, undefined);
  assert.equal(result.errorMessage, undefined);
  assert.equal(result.retry?.success, true);
  assert.equal(result.retry?.history?.length, 2);
  assert.equal(result.messages.at(-1)?.content?.[0]?.text, "Recovered after retry.");
  assert.equal(isResultSuccess(result), true);
  assert.ok(Date.now() - startedAt >= 600, "runner should wait for final retry result, not first agent_end");
});

test("runFork surfaces exhausted child retry without waiting for process exit", { timeout: 3000 }, async () => {
  const failed = assistantError({
    content: [{ type: "text", text: "Partial response before retry exhaustion." }],
  });

  const startedAt = Date.now();
  const result = await runWithFakePi(
    [
      { value: { type: "message_end", message: failed } },
      { value: { type: "agent_end", messages: [failed] } },
      { delayMs: 350, value: { type: "auto_retry_start", attempt: 3, maxAttempts: 3, delayMs: 8000, errorMessage: "WebSocket error" } },
      { delayMs: 50, value: { type: "auto_retry_end", success: false, attempt: 3, finalError: "WebSocket error" } },
    ],
    { trailingDelayMs: 2000 },
  );

  assert.equal(result.stopReason, "error");
  assert.equal(result.errorMessage, "WebSocket error");
  assert.equal(result.retry?.success, false);
  assert.equal(isResultSuccess(result), false);
  assert.equal(isResultError(result), true);
  assert.ok(Date.now() - startedAt < 1500, "runner should not wait for fake child process exit after retry exhaustion");
});

test("runFork preserves exhausted retry failure when failed attempt has text and child exits non-zero", { timeout: 3000 }, async () => {
  const failed = assistantError({
    content: [{ type: "text", text: "Partial failed retry response." }],
  });

  const result = await runWithFakePi(
    [
      { value: { type: "message_end", message: failed } },
      { value: { type: "agent_end", messages: [failed] } },
      { value: { type: "auto_retry_start", attempt: 3, maxAttempts: 3, delayMs: 8000, errorMessage: "WebSocket error" } },
      { value: { type: "auto_retry_end", success: false, attempt: 3, finalError: "WebSocket error" } },
    ],
    { exitCode: 1 },
  );

  assert.equal(result.exitCode, 1);
  assert.equal(result.stopReason, "error");
  assert.equal(result.errorMessage, "WebSocket error");
  assert.equal(result.retry?.success, false);
  assert.equal(isResultSuccess(result), false);
  assert.equal(isResultError(result), true);
});

test("runFork waits past the retry-decision window when agent_end declares willRetry", { timeout: 5000 }, async () => {
  const failed = assistantError();
  const recovered = assistantSuccess();

  const startedAt = Date.now();
  const result = await runWithFakePi(
    [
      { value: { type: "message_end", message: failed } },
      { value: { type: "agent_end", messages: [failed], willRetry: true } },
      { delayMs: 1400, value: { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 5000, errorMessage: "429 rate limit" } },
      { delayMs: 50, value: { type: "message_end", message: recovered } },
      { value: { type: "auto_retry_end", success: true, attempt: 1 } },
      { value: { type: "agent_end", messages: [recovered], willRetry: false } },
    ],
    { trailingDelayMs: 2000 },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.retry?.success, true);
  assert.equal(result.messages.at(-1)?.content?.[0]?.text, "Recovered after retry.");
  assert.equal(isResultSuccess(result), true);
  assert.ok(
    Date.now() - startedAt >= 1450,
    "runner should wait for declared retry past the 1s retry-decision window",
  );
});

test("runFork surfaces retry exhaustion after willRetry without a second agent_end", { timeout: 3000 }, async () => {
  const failed = assistantError();

  const startedAt = Date.now();
  const result = await runWithFakePi(
    [
      { value: { type: "message_end", message: failed } },
      { value: { type: "agent_end", messages: [failed], willRetry: true } },
      { delayMs: 200, value: { type: "auto_retry_start", attempt: 3, maxAttempts: 3, delayMs: 8000, errorMessage: "429 rate limit" } },
      { delayMs: 50, value: { type: "auto_retry_end", success: false, attempt: 3, finalError: "429 rate limit" } },
    ],
    { trailingDelayMs: 2000 },
  );

  assert.equal(result.stopReason, "error");
  assert.equal(result.errorMessage, "429 rate limit");
  assert.equal(result.retry?.success, false);
  assert.equal(result.willRetry, undefined);
  assert.equal(isResultError(result), true);
  assert.ok(Date.now() - startedAt < 1500, "runner should fail promptly after retry exhaustion");
});

test("runFork aborts cleanly while waiting on a declared retry", { timeout: 3000 }, async () => {
  const failed = assistantError();
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 400);

  const result = await runWithFakePi(
    [
      { value: { type: "message_end", message: failed } },
      { value: { type: "agent_end", messages: [failed], willRetry: true } },
    ],
    { trailingDelayMs: 5000, signal: controller.signal },
  );

  assert.equal(result.exitCode, 130);
  assert.equal(result.stopReason, "aborted");
  assert.equal(result.errorMessage, "Fork was aborted.");
  assert.equal(result.willRetry, undefined);
  assert.equal(isResultError(result), true);
});

test("runFork finishes error agent_end promptly when willRetry is false", { timeout: 2500 }, async () => {
  const explainedError = assistantError({
    content: [{ type: "text", text: "Rate limit was the finding." }],
  });

  const startedAt = Date.now();
  const result = await runWithFakePi(
    [
      { value: { type: "message_end", message: explainedError } },
      { value: { type: "agent_end", messages: [explainedError], willRetry: false } },
    ],
    { trailingDelayMs: 2000 },
  );

  assert.equal(result.messages.at(-1)?.content?.[0]?.text, "Rate limit was the finding.");
  assert.equal(isResultSuccess(result), true);
  assert.ok(
    Date.now() - startedAt < 900,
    "runner should not wait the retry-decision window when the child declared no retry",
  );
});

test("runFork keeps fast semantic completion for successful non-retry agent_end", { timeout: 2500 }, async () => {
  const result = await runWithFakePi(
    [
      { value: { type: "message_end", message: assistantSuccess("Done quickly.") } },
      { value: { type: "agent_end", messages: [assistantSuccess("Done quickly.")] } },
    ],
    { trailingDelayMs: 2000 },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.messages.at(-1)?.content?.[0]?.text, "Done quickly.");
  assert.equal(isResultSuccess(result), true);
});

test("runFork enriches contextWindow from child provider and model metadata", { timeout: 2500 }, async () => {
  const message = assistantSuccess("Done with usage.");
  message.provider = "openai-codex";
  message.model = "openai-codex/gpt-5.5";
  message.usage = {
    input: 100,
    output: 20,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 98464,
    cost: { total: 0.01 },
  };

  const resolverCalls = [];
  const updates = [];
  const result = await runWithFakePi(
    [
      { value: { type: "message_end", message } },
      { value: { type: "agent_end", messages: [message] } },
    ],
    {
      trailingDelayMs: 2000,
      resolveContextWindow(provider, model) {
        resolverCalls.push([provider, model]);
        return 272000;
      },
      onUpdate(update) {
        updates.push(update);
      },
    },
  );

  assert.equal(result.usage.contextTokens, 98464);
  assert.equal(result.usage.contextWindow, 272000);
  assert.deepEqual(resolverCalls.at(0), ["openai-codex", "openai-codex/gpt-5.5"]);
  assert.equal(updates.some((update) => update.details?.results?.[0]?.usage?.contextWindow === 272000), true);
});

test("runFork omits contextWindow when child model cannot be resolved", { timeout: 2500 }, async () => {
  const message = assistantSuccess("Done with unknown model.");
  message.provider = "unknown-provider";
  message.model = "unknown-model";
  message.usage = {
    input: 100,
    output: 20,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 120,
    cost: { total: 0.01 },
  };

  const result = await runWithFakePi(
    [
      { value: { type: "message_end", message } },
      { value: { type: "agent_end", messages: [message] } },
    ],
    {
      trailingDelayMs: 2000,
      resolveContextWindow() {
        return undefined;
      },
    },
  );

  assert.equal(result.usage.contextTokens, 120);
  assert.equal(result.usage.contextWindow, undefined);
});

test("runFork preserves semantic success for error stop reason with final output and no retry", { timeout: 3500 }, async () => {
  const explainedError = assistantError({
    content: [{ type: "text", text: "The command failed, which is the expected finding." }],
    errorMessage: "Command exited with code 1",
  });

  const startedAt = Date.now();
  const result = await runWithFakePi(
    [
      { value: { type: "message_end", message: explainedError } },
      { value: { type: "agent_end", messages: [explainedError] } },
    ],
    { trailingDelayMs: 2000 },
  );

  assert.equal(result.messages.at(-1)?.content?.[0]?.text, "The command failed, which is the expected finding.");
  assert.equal(isResultSuccess(result), true);
  assert.equal(isResultError(result), false);
  assert.ok(Date.now() - startedAt >= 900, "runner should allow a retry-decision window before semantic success");
  assert.ok(Date.now() - startedAt < 1800, "runner should not wait for process exit when no retry arrives");
});

test("buildForkTaskPrompt starts with the raw task text and fork identity", () => {
  const task = "Review the prompt framing.";
  const prompt = buildForkTaskPrompt(task);
  const identity = "You are a fork. Complete only the bounded task above. Stay within the assigned scope. Do not expand into adjacent or broader work. Report blockers and out-of-scope findings instead of acting on them.";

  assert.equal(prompt.startsWith(`${task}\n\n${identity}`), true);
  assert.ok(prompt.indexOf(identity) < prompt.indexOf("## Output"));
});

test("buildForkTaskPrompt uses the two-section evidence-backed report contract", () => {
  const prompt = buildForkTaskPrompt("Review the prompt framing.");

  for (const heading of ["## Output", "## Learnings"]) {
    assert.equal(prompt.includes(heading), true, `missing ${heading}`);
  }

  for (const heading of ["## Result", "## Evidence"]) {
    assert.equal(prompt.includes(heading), false, `kept removed heading ${heading}`);
  }

  assert.equal(prompt.includes("This section is free-form."), true);
  assert.equal(prompt.includes("When the assigned task could modify files or external state, identify the changed files or external actions. If nothing changed, state `No changes made`."), true);
  assert.equal(prompt.includes("- For implementation, include changed files, changed behavior, affected callers or surfaces, compatibility impact, what remains untouched, and validation results."), true);
  assert.equal(prompt.includes("Ground each important conclusion with precise pointers to its source."), true);
  assert.equal(prompt.includes("Include source snippets when the exact code, text, configuration, error, or response helps verify a conclusion or continue the work."), true);
  assert.equal(prompt.includes("Include as many snippets as the task needs."), true);
  assert.equal(prompt.includes("When reporting validation, state what the check proves. Also state what it does not prove when that limit affects trust."), true);
  assert.equal(prompt.includes("No reusable learnings found."), true);
  assert.equal(prompt.includes("Right-size both sections independently."), true);
  assert.equal(prompt.includes("There is no fixed length limit."), true);
  assert.equal(prompt.includes("Always use exactly these two required headings: `Output` and `Learnings`."), true);
});

test("buildPiArgs appends generated fork task prompt as final child argument", () => {
  const task = "Review final prompt argument.";
  const args = buildPiArgs(
    task,
    "/tmp/fork.jsonl",
    null,
    undefined,
    { alwaysProxy: [], extensionArgs: [] },
  );

  assert.equal(args.at(-1), buildForkTaskPrompt(task));
});

test("buildPiArgs appends effort profile model flags", () => {
  const args = buildPiArgs(
    "inspect",
    "/tmp/fork.jsonl",
    null,
    { provider: "openai-codex", id: "gpt-deep", thinking: "high" },
    { alwaysProxy: [], extensionArgs: [] },
  );

  assert.deepEqual(
    args.slice(args.indexOf("--provider"), args.indexOf("--provider") + 6),
    ["--provider", "openai-codex", "--model", "gpt-deep", "--thinking", "high"],
  );
});

test("buildPiArgs omits effort model flags when no profile is present", () => {
  const args = buildPiArgs(
    "inspect",
    "/tmp/fork.jsonl",
    null,
    undefined,
    { alwaysProxy: [], extensionArgs: [] },
  );

  assert.equal(args.includes("--provider"), false);
  assert.equal(args.includes("--model"), false);
  assert.equal(args.includes("--thinking"), false);
});

test("buildPiArgs orders effort profile after inherited fallback model and thinking", () => {
  const args = buildPiArgs(
    "inspect",
    "/tmp/fork.jsonl",
    null,
    { provider: "profile-provider", id: "profile-model", thinking: "xhigh" },
    {
      alwaysProxy: ["--provider", "parent-provider"],
      extensionArgs: [],
      fallbackModel: "parent-model",
      fallbackThinking: "low",
      fallbackTools: "read,bash",
      fallbackNoTools: false,
    },
  );

  const parentModelIndex = args.indexOf("parent-model");
  const profileModelIndex = args.indexOf("profile-model");
  const parentThinkingIndex = args.indexOf("low");
  const profileThinkingIndex = args.indexOf("xhigh");
  assert.ok(parentModelIndex !== -1);
  assert.ok(profileModelIndex !== -1);
  assert.ok(parentThinkingIndex !== -1);
  assert.ok(profileThinkingIndex !== -1);
  assert.ok(profileModelIndex > parentModelIndex);
  assert.ok(profileThinkingIndex > parentThinkingIndex);
});

test("runFork includes compact effort metadata in details", { timeout: 2500 }, async () => {
  const effort = {
    selected: "deep",
    source: "tool",
    profile: { provider: "openai-codex", id: "gpt-deep", thinking: "high" },
  };
  const result = await runWithFakePi(
    [
      { value: { type: "message_end", message: assistantSuccess("Done with deep effort.") } },
      { value: { type: "agent_end", messages: [assistantSuccess("Done with deep effort.")] } },
    ],
    { trailingDelayMs: 2000, effort },
  );

  assert.deepEqual(result.effort, effort);
});

test("runFork preserves unresolved effort warning metadata without changing child behavior", { timeout: 2500 }, async () => {
  const effort = {
    selected: "deep",
    source: "tool",
    warning: 'Requested effort "deep" has no configured profile; using child Pi defaults.',
  };
  const result = await runWithFakePi(
    [
      { value: { type: "message_end", message: assistantSuccess("Done with defaults.") } },
      { value: { type: "agent_end", messages: [assistantSuccess("Done with defaults.")] } },
    ],
    { trailingDelayMs: 2000, effort },
  );

  assert.deepEqual(result.effort, effort);
  assert.equal(result.errorMessage, undefined);
  assert.equal(isResultSuccess(result), true);
});
