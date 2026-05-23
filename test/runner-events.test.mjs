import test from "node:test";
import assert from "node:assert/strict";
import {
  getFinalAssistantText,
  getForkProgressText,
  getResultSummaryText,
  processPiEvent,
  processPiJsonLine,
} from "../src/runner-events.js";

function makeResult() {
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
  };
}

test("captures final assistant output from agent_end after non-zero tool exit", () => {
  const result = makeResult();
  const message = {
    role: "assistant",
    content: [{ type: "text", text: "The command failed, and that is the finding." }],
    model: "test-model",
    stopReason: "error",
    errorMessage: "Command exited with code 1",
    provider: "openai",
    model: "gpt-5.5",
    usage: {
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
      totalTokens: 10,
      cost: { total: 0.01 },
    },
    timestamp: 1,
  };

  processPiEvent({ type: "agent_end", messages: [message] }, result);
  result.exitCode = 1;

  assert.equal(result.sawAgentEnd, true);
  assert.equal(result.provider, "openai");
  assert.equal(result.model, "gpt-5.5");
  assert.equal(result.stopReason, "error");
  assert.equal(result.errorMessage, "Command exited with code 1");
  assert.equal(result.usage.turns, 1);
  assert.equal(getFinalAssistantText(result.messages), "The command failed, and that is the finding.");
  assert.equal(getResultSummaryText(result), "The command failed, and that is the finding.");
});

test("deduplicates assistant messages repeated across event types", () => {
  const message = {
    role: "assistant",
    content: [{ type: "text", text: "Still here" }],
    timestamp: 1,
  };
  const result = makeResult();

  processPiEvent({ type: "message_end", message }, result);
  processPiEvent({ type: "turn_end", message }, result);
  processPiEvent({ type: "agent_end", messages: [message] }, result);

  assert.equal(result.messages.length, 1);
  assert.equal(result.usage.turns, 1);
});

test("captures child tool execution progress for live fork updates", () => {
  const result = makeResult();

  assert.equal(
    processPiEvent(
      {
        type: "tool_execution_start",
        toolCallId: "call_1",
        toolName: "read",
        args: { path: "src/index.ts" },
      },
      result,
    ),
    true,
  );

  assert.deepEqual(result.toolExecutions, [
    {
      toolCallId: "call_1",
      toolName: "read",
      status: "running",
      updates: 0,
      argsPreview: '{"path":"src/index.ts"}',
      displayText: "read src/index.ts",
      isError: false,
      latestText: "",
      activityOrder: 1,
    },
  ]);
  assert.equal(getForkProgressText(result), "… read src/index.ts");

  assert.equal(
    processPiEvent(
      {
        type: "tool_execution_update",
        toolCallId: "call_1",
        toolName: "read",
        args: { path: "src/index.ts" },
        partialResult: { content: [{ type: "text", text: "file contents so far" }] },
      },
      result,
    ),
    true,
  );

  assert.equal(result.toolExecutions[0].updates, 1);
  assert.equal(result.toolExecutions[0].latestText, "file contents so far");
  assert.deepEqual(result.activities, [
    {
      type: "tool",
      toolCallId: "call_1",
      toolName: "read",
      status: "running",
      updates: 1,
      argsPreview: '{"path":"src/index.ts"}',
      displayText: "read src/index.ts",
      isError: false,
      latestText: "file contents so far",
      activityOrder: 1,
    },
  ]);
  assert.equal(getForkProgressText(result), "… read src/index.ts");
});

test("captures child thinking progress as estimated tokens without storing thinking text", () => {
  const result = makeResult();

  assert.equal(
    processPiEvent(
      {
        type: "message_update",
        assistantMessageEvent: { type: "thinking_start" },
      },
      result,
    ),
    true,
  );
  assert.deepEqual(result.thinking, { status: "running", tokens: 0, activityOrder: 1 });
  assert.equal(getForkProgressText(result), "… thinking...");

  processPiEvent(
    {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "abc" },
    },
    result,
  );
  processPiEvent(
    {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "defg" },
    },
    result,
  );
  assert.deepEqual(result.thinking, { status: "running", tokens: 2, activityOrder: 1 });
  assert.equal(getForkProgressText(result), "… thinking ~2 tokens");

  processPiEvent(
    {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_end", content: "final thinking" },
    },
    result,
  );
  assert.deepEqual(result.thinking, { status: "completed", tokens: 4, activityOrder: 1 });
  assert.deepEqual(result.activities, [
    { type: "thinking", status: "completed", tokens: 4, activityOrder: 1 },
  ]);
  assert.equal(getForkProgressText(result), "✓ thinking ~4 tokens");
});

test("renders old chars-only thinking results as estimated tokens", () => {
  const result = makeResult();
  result.thinking = { status: "completed", chars: 9, activityOrder: 1 };

  assert.equal(getForkProgressText(result), "✓ thinking ~3 tokens");
});

test("renders completed zero-token thinking without ellipsis", () => {
  const result = makeResult();

  processPiEvent(
    {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_start" },
    },
    result,
  );
  assert.equal(getForkProgressText(result), "… thinking...");

  processPiEvent(
    {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_end" },
    },
    result,
  );
  assert.deepEqual(result.thinking, { status: "completed", tokens: 0, activityOrder: 1 });
  assert.deepEqual(result.activities, [
    { type: "thinking", status: "completed", tokens: 0, activityOrder: 1 },
  ]);
  assert.equal(getForkProgressText(result), "✓ thinking");
});

test("orders child thinking activity relative to tool activity", () => {
  const result = makeResult();

  processPiEvent(
    {
      type: "tool_execution_start",
      toolCallId: "call_1",
      toolName: "bash",
      args: { command: "npm test" },
    },
    result,
  );
  processPiEvent(
    {
      type: "tool_execution_end",
      toolCallId: "call_1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "pass" }] },
      isError: false,
    },
    result,
  );
  processPiEvent(
    {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_start" },
    },
    result,
  );
  processPiEvent(
    {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_end", content: "later thought" },
    },
    result,
  );
  processPiEvent(
    {
      type: "tool_execution_start",
      toolCallId: "call_2",
      toolName: "read",
      args: { path: "src/render.ts" },
    },
    result,
  );

  assert.equal(result.toolExecutions[0].activityOrder, 1);
  assert.equal(result.thinking.activityOrder, 2);
  assert.equal(result.toolExecutions[1].activityOrder, 3);
  assert.equal(
    getForkProgressText(result),
    "✓ bash $ npm test\n✓ thinking ~4 tokens\n… read src/render.ts",
  );
});

test("keeps separate thinking phases fixed in the activity timeline", () => {
  const result = makeResult();

  processPiEvent(
    {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_start" },
    },
    result,
  );
  processPiEvent(
    {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_end", content: "first thought" },
    },
    result,
  );
  processPiEvent(
    {
      type: "tool_execution_start",
      toolCallId: "call_1",
      toolName: "bash",
      args: { command: "npm test" },
    },
    result,
  );
  processPiEvent(
    {
      type: "tool_execution_end",
      toolCallId: "call_1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "pass" }] },
      isError: false,
    },
    result,
  );
  processPiEvent(
    {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_start" },
    },
    result,
  );
  processPiEvent(
    {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "later" },
    },
    result,
  );
  processPiEvent(
    {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_end", content: "second thought" },
    },
    result,
  );
  processPiEvent(
    {
      type: "tool_execution_start",
      toolCallId: "call_2",
      toolName: "read",
      args: { path: "src/render.ts" },
    },
    result,
  );

  assert.deepEqual(
    result.activities.map((activity) => ({
      type: activity.type,
      status: activity.status,
      tokens: activity.tokens,
      toolName: activity.toolName,
      activityOrder: activity.activityOrder,
    })),
    [
      { type: "thinking", status: "completed", tokens: 4, toolName: undefined, activityOrder: 1 },
      { type: "tool", status: "completed", tokens: undefined, toolName: "bash", activityOrder: 2 },
      { type: "thinking", status: "completed", tokens: 4, toolName: undefined, activityOrder: 3 },
      { type: "tool", status: "running", tokens: undefined, toolName: "read", activityOrder: 4 },
    ],
  );
  assert.equal(result.thinking.activityOrder, 3);
  assert.equal(
    getForkProgressText(result),
    "✓ thinking ~4 tokens\n✓ bash $ npm test\n✓ thinking ~4 tokens\n… read src/render.ts",
  );
});

test("strips raw thinking blocks from stored assistant messages", () => {
  const result = makeResult();
  const message = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "private chain of thought" },
      { type: "text", text: "Public answer" },
    ],
    thinking: "top-level private thinking",
    reasoning_content: "provider private reasoning",
    timestamp: 1,
  };

  processPiEvent({ type: "message_end", message }, result);
  processPiEvent({ type: "agent_end", messages: [message] }, result);

  assert.equal(result.messages.length, 1);
  assert.equal(getFinalAssistantText(result.messages), "Public answer");
  const serialized = JSON.stringify(result.messages);
  assert.doesNotMatch(serialized, /private chain of thought/);
  assert.doesNotMatch(serialized, /top-level private thinking/);
  assert.doesNotMatch(serialized, /provider private reasoning/);
  assert.deepEqual(result.messages[0].content, [{ type: "text", text: "Public answer" }]);
});

test("fork progress prefixes activity rows with the child tool name", () => {
  const result = makeResult();

  processPiEvent(
    {
      type: "tool_execution_start",
      toolCallId: "call_1",
      toolName: "bash",
      args: { command: "npm test" },
    },
    result,
  );
  processPiEvent(
    {
      type: "tool_execution_end",
      toolCallId: "call_1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "pass" }] },
      isError: false,
    },
    result,
  );
  processPiEvent(
    {
      type: "tool_execution_start",
      toolCallId: "call_2",
      toolName: "fork",
      args: { task: "inspect the renderer" },
    },
    result,
  );
  processPiEvent(
    {
      type: "tool_execution_end",
      toolCallId: "call_2",
      toolName: "fork",
      result: { content: [{ type: "text", text: "done" }] },
      isError: false,
    },
    result,
  );

  assert.equal(getForkProgressText(result), "✓ bash $ npm test\n✓ fork inspect the renderer");
});

test("fork progress renders failed tool errors inline", () => {
  const result = makeResult();

  processPiEvent(
    {
      type: "tool_execution_start",
      toolCallId: "call_1",
      toolName: "read",
      args: { path: "missing.txt" },
    },
    result,
  );
  processPiEvent(
    {
      type: "tool_execution_end",
      toolCallId: "call_1",
      toolName: "read",
      result: { content: [{ type: "text", text: "ENOENT: no such file or directory\nmore details" }] },
      isError: true,
    },
    result,
  );
  processPiEvent(
    {
      type: "tool_execution_start",
      toolCallId: "call_2",
      toolName: "grep",
      args: { pattern: "render", path: "src" },
    },
    result,
  );

  assert.equal(
    getForkProgressText(result),
    "× read missing.txt — ENOENT: no such file or directory more details\n… grep render in src",
  );
});

test("fork progress prefers final assistant output over tool progress", () => {
  const result = makeResult();

  processPiEvent(
    {
      type: "tool_execution_start",
      toolCallId: "call_1",
      toolName: "bash",
      args: { command: "npm test" },
    },
    result,
  );
  processPiEvent(
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Tests pass." }],
        timestamp: 1,
      },
    },
    result,
  );

  assert.equal(getForkProgressText(result), "Tests pass.");
});

test("bounds legacy child tool execution history but keeps all unified activities", () => {
  const result = makeResult();

  for (let i = 0; i < 60; i++) {
    processPiEvent(
      {
        type: "tool_execution_start",
        toolCallId: `call_${i}`,
        toolName: "read",
        args: { path: `src/${i}.ts` },
      },
      result,
    );
  }

  assert.equal(result.toolExecutionCount, 60);
  assert.equal(result.toolExecutions.length, 25);
  assert.equal(result.toolExecutions[0].toolCallId, "call_35");
  assert.equal(result.toolExecutions.at(-1).toolCallId, "call_59");
  assert.equal(result.activityCount, 60);
  assert.equal(result.activities.length, 60);
  assert.equal(result.activities[0].toolCallId, "call_0");
  assert.equal(result.activities.at(-1).toolCallId, "call_59");
  assert.match(getForkProgressText(result), /\.\.\. 50 earlier activities\n… read src\/50\.ts/);
});


test("captures child auto-retry start and progress", () => {
  const result = makeResult();
  result.sawAgentEnd = true;

  assert.equal(
    processPiEvent(
      {
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 2000,
        errorMessage: "WebSocket error",
      },
      result,
    ),
    true,
  );

  assert.equal(result.sawAgentEnd, false);
  assert.deepEqual(result.retry, {
    active: true,
    pending: false,
    success: undefined,
    attempt: 1,
    maxAttempts: 3,
    delayMs: 2000,
    errorMessage: "WebSocket error",
    history: [
      {
        type: "start",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 2000,
        errorMessage: "WebSocket error",
      },
    ],
  });
  assert.equal(getForkProgressText(result), "Retrying after WebSocket error (attempt 1/3, waiting 2s)");
});

test("captures child auto-retry success and failure end events", () => {
  const successResult = makeResult();
  processPiEvent({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "WebSocket error" }, successResult);
  assert.equal(processPiEvent({ type: "auto_retry_end", success: true, attempt: 1 }, successResult), true);

  assert.equal(successResult.retry.active, false);
  assert.equal(successResult.retry.success, true);
  assert.equal(successResult.retry.history.length, 2);
  assert.deepEqual(successResult.retry.history.at(-1), {
    type: "end",
    attempt: 1,
    success: true,
    finalError: undefined,
  });
  assert.equal(successResult.stopReason, undefined);
  assert.equal(successResult.errorMessage, undefined);

  const failureResult = makeResult();
  processPiEvent({ type: "auto_retry_start", attempt: 3, maxAttempts: 3, delayMs: 8000, errorMessage: "WebSocket closed 1000" }, failureResult);
  assert.equal(
    processPiEvent(
      { type: "auto_retry_end", success: false, attempt: 3, finalError: "WebSocket closed 1000" },
      failureResult,
    ),
    true,
  );

  assert.equal(failureResult.retry.active, false);
  assert.equal(failureResult.retry.success, false);
  assert.equal(failureResult.retry.finalError, "WebSocket closed 1000");
  assert.equal(failureResult.stopReason, "error");
  assert.equal(failureResult.errorMessage, "WebSocket closed 1000");
});

test("preserves exhausted retry error metadata after later non-error assistant message", () => {
  const result = makeResult();
  processPiEvent({ type: "auto_retry_start", attempt: 3, maxAttempts: 3, delayMs: 8000, errorMessage: "WebSocket error" }, result);
  processPiEvent({ type: "auto_retry_end", success: false, attempt: 3, finalError: "WebSocket error" }, result);
  processPiEvent(
    {
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "Late non-error message." }],
        timestamp: 2,
      },
    },
    result,
  );

  assert.equal(result.stopReason, "error");
  assert.equal(result.errorMessage, "WebSocket error");
  assert.equal(result.retry.success, false);
});

test("clears stale terminal error metadata after successful retry assistant message", () => {
  const result = makeResult();
  const failed = {
    role: "assistant",
    stopReason: "error",
    errorMessage: "WebSocket error",
    content: [],
    timestamp: 1,
  };
  const recovered = {
    role: "assistant",
    content: [{ type: "text", text: "Recovered after retry." }],
    timestamp: 2,
  };

  processPiEvent({ type: "message_end", message: failed }, result);
  processPiEvent({ type: "agent_end", messages: [failed] }, result);
  processPiEvent({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "WebSocket error" }, result);
  processPiEvent({ type: "message_end", message: recovered }, result);
  processPiEvent({ type: "auto_retry_end", success: true, attempt: 1 }, result);
  processPiEvent({ type: "agent_end", messages: [recovered] }, result);

  assert.equal(getFinalAssistantText(result.messages), "Recovered after retry.");
  assert.equal(result.stopReason, undefined);
  assert.equal(result.errorMessage, undefined);
  assert.equal(result.retry.history.length, 2);
});

test("invalid JSON lines are ignored", () => {
  const result = makeResult();

  assert.equal(processPiJsonLine("{ nope", result), false);
  assert.equal(result.messages.length, 0);
});

test("rolls nested fork tool-result usage into parent fork usage", () => {
  const result = makeResult();
  const nestedForkToolResult = {
    role: "toolResult",
    toolName: "fork",
    toolCallId: "nested-fork-1",
    details: {
      results: [
        {
          usage: {
            input: 100,
            output: 20,
            cacheRead: 30,
            cacheWrite: 40,
            contextTokens: 500,
            turns: 2,
            cost: 0.1234,
          },
        },
      ],
    },
  };

  assert.equal(processPiEvent({ type: "message_end", message: nestedForkToolResult }, result), true);

  assert.equal(result.usage.input, 100);
  assert.equal(result.usage.output, 20);
  assert.equal(result.usage.cacheRead, 30);
  assert.equal(result.usage.cacheWrite, 40);
  assert.equal(result.usage.contextTokens, 500);
  assert.equal(result.usage.turns, 2);
  assert.equal(result.usage.cost, 0.1234);
});

test("deduplicates nested fork usage repeated across event types", () => {
  const result = makeResult();
  const nestedForkToolResult = {
    role: "toolResult",
    toolName: "fork",
    toolCallId: "nested-fork-1",
    details: {
      results: [
        {
          usage: {
            input: 100,
            output: 20,
            turns: 2,
            cost: 0.1234,
          },
        },
      ],
    },
  };

  processPiEvent({ type: "message_end", message: nestedForkToolResult }, result);
  processPiEvent({ type: "turn_end", message: nestedForkToolResult }, result);
  processPiEvent({ type: "agent_end", messages: [nestedForkToolResult] }, result);

  assert.equal(result.usage.input, 100);
  assert.equal(result.usage.output, 20);
  assert.equal(result.usage.turns, 2);
  assert.equal(result.usage.cost, 0.1234);
});

test("captures nested fork usage from turn_end toolResults", () => {
  const result = makeResult();
  const assistant = {
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    usage: { input: 1, output: 1, cost: { total: 0.01 } },
  };
  const nestedForkToolResult = {
    role: "toolResult",
    toolName: "fork",
    toolCallId: "nested-fork-turn-end",
    details: {
      results: [
        {
          usage: {
            input: 50,
            output: 10,
            turns: 1,
            cost: 0.05,
          },
        },
      ],
    },
  };

  processPiEvent({ type: "turn_end", message: assistant, toolResults: [nestedForkToolResult] }, result);

  assert.equal(result.usage.input, 51);
  assert.equal(result.usage.output, 11);
  assert.equal(result.usage.turns, 2);
  assert.equal(result.usage.cost, 0.060000000000000005);
});
