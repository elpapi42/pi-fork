/**
 * Helpers for parsing Pi JSON mode events and summarizing fork results.
 */

const MAX_TOOL_PREVIEW_CHARS = 1200;
const MAX_TOOL_ARGS_PREVIEW_CHARS = 300;
const MAX_INLINE_ERROR_PREVIEW_CHARS = 160;
const MAX_STORED_TOOL_EXECUTIONS = 25;

function getSeenMessageSignatures(result) {
  if (!Object.prototype.hasOwnProperty.call(result, "__seenMessageSignatures")) {
    Object.defineProperty(result, "__seenMessageSignatures", {
      value: new Set(),
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  return result.__seenMessageSignatures;
}

function getSeenForkToolResultSignatures(result) {
  if (!Object.prototype.hasOwnProperty.call(result, "__seenForkToolResultSignatures")) {
    Object.defineProperty(result, "__seenForkToolResultSignatures", {
      value: new Set(),
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  return result.__seenForkToolResultSignatures;
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`)
    .join(",")}}`;
}

function truncateMiddle(text, maxChars) {
  if (typeof text !== "string" || text.length <= maxChars) return text;
  const keep = Math.max(0, maxChars - 15);
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${text.slice(0, head)}\n… truncated …\n${text.slice(text.length - tail)}`;
}

function truncateTail(text, maxChars) {
  if (typeof text !== "string" || text.length <= maxChars) return text;
  return `… truncated …\n${text.slice(text.length - maxChars)}`;
}

function truncateInline(text, maxChars) {
  if (typeof text !== "string") return "";
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxChars) return singleLine;
  return `${singleLine.slice(0, Math.max(0, maxChars - 1))}…`;
}

function formatCount(n) {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function stringifyPreview(value, maxChars) {
  if (value === undefined) return "";
  if (typeof value === "string") return truncateMiddle(value, maxChars);

  try {
    return truncateMiddle(JSON.stringify(value), maxChars);
  } catch {
    return "";
  }
}

function shortPath(value) {
  if (typeof value !== "string" || !value) return "...";
  return value.replace(/^\/home\/[^/]+/, "~");
}

function formatToolCallPreview(toolName, args) {
  if (!args || typeof args !== "object") return toolName || "tool";

  switch (toolName) {
    case "bash": {
      const command = typeof args.command === "string" ? args.command : "...";
      return `bash $ ${truncateInline(command, 80)}`;
    }
    case "read": {
      const filePath = shortPath(args.path || args.file_path);
      const offset = args.offset;
      const limit = args.limit;
      const range = offset !== undefined || limit !== undefined ? `:${offset ?? 1}${limit !== undefined ? `-${(offset ?? 1) + limit - 1}` : ""}` : "";
      return `read ${filePath}${range}`;
    }
    case "write":
      return `write ${shortPath(args.path || args.file_path)}`;
    case "edit":
      return `edit ${shortPath(args.path || args.file_path)}`;
    case "ls":
      return `ls ${shortPath(args.path || ".")}`;
    case "find":
      return `find ${truncateInline(stringifyPreview(args.pattern || "*", 60), 60)} in ${shortPath(args.path || ".")}`;
    case "grep":
      return `grep ${truncateInline(stringifyPreview(args.pattern || "", 60), 60)} in ${shortPath(args.path || ".")}`;
    case "fork": {
      const task = typeof args.task === "string" ? args.task : stringifyPreview(args, 80);
      return `fork ${truncateInline(task, 80)}`;
    }
    default: {
      const argsPreview = truncateInline(stringifyPreview(args, 70), 70);
      return argsPreview ? `${toolName} ${argsPreview}` : toolName || "tool";
    }
  }
}

function extractTextFromContent(content) {
  if (!Array.isArray(content)) return "";

  const parts = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text" && typeof part.text === "string") {
      parts.push(part.text);
    } else if (part.type === "image") {
      parts.push("[image]");
    }
  }

  return parts.join("\n").trim();
}

function extractResultText(toolResult) {
  if (!toolResult || typeof toolResult !== "object") return "";

  const contentText = extractTextFromContent(toolResult.content);
  if (contentText) return truncateTail(contentText, MAX_TOOL_PREVIEW_CHARS);

  if (typeof toolResult.text === "string") {
    return truncateTail(toolResult.text.trim(), MAX_TOOL_PREVIEW_CHARS);
  }

  if (typeof toolResult.message === "string") {
    return truncateTail(toolResult.message.trim(), MAX_TOOL_PREVIEW_CHARS);
  }

  return "";
}

function updateAssistantMetadata(result, message) {
  if (!message || message.role !== "assistant") return;
  if (!result.provider && message.provider) result.provider = message.provider;
  if (!result.model && message.model) result.model = message.model;

  const isAssistantError = message.stopReason === "error" || message.stopReason === "aborted" || Boolean(message.errorMessage);
  if (message.stopReason) {
    if (!(result.retry?.success === false && !isAssistantError)) {
      result.stopReason = message.stopReason;
    }
  } else if (!isAssistantError && result.retry?.history?.length && result.retry?.success !== false) {
    delete result.stopReason;
  }

  if (message.errorMessage) {
    result.errorMessage = message.errorMessage;
  } else if (!isAssistantError && result.retry?.history?.length && result.retry?.success !== false) {
    delete result.errorMessage;
  }
}

function sanitizeAssistantMessage(message) {
  const sanitized = { ...message };
  delete sanitized.thinking;
  delete sanitized.reasoning;
  delete sanitized.reasoning_content;

  if (Array.isArray(message.content)) {
    sanitized.content = message.content
      .filter((part) => part?.type !== "thinking")
      .map((part) => {
        if (!part || typeof part !== "object") return part;
        const cleanPart = { ...part };
        delete cleanPart.thinking;
        delete cleanPart.reasoning;
        delete cleanPart.reasoning_content;
        return cleanPart;
      });
  }

  return sanitized;
}

function addAssistantMessage(result, message) {
  if (!message || message.role !== "assistant") return false;

  const sanitizedMessage = sanitizeAssistantMessage(message);
  updateAssistantMetadata(result, sanitizedMessage);

  const signature = stableStringify(sanitizedMessage);
  const seen = getSeenMessageSignatures(result);
  if (seen.has(signature)) return false;
  seen.add(signature);

  result.messages.push(sanitizedMessage);

  result.usage.turns++;
  const usage = message.usage;
  if (usage) {
    result.usage.input += usage.input || 0;
    result.usage.output += usage.output || 0;
    result.usage.cacheRead += usage.cacheRead || 0;
    result.usage.cacheWrite += usage.cacheWrite || 0;
    result.usage.cost += usage.cost?.total || 0;
    result.usage.contextTokens = usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite || 0;
  }

  return true;
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function addNestedForkUsage(result, message) {
  if (!message || message.role !== "toolResult" || message.toolName !== "fork") return false;

  const results = message.details?.results;
  if (!Array.isArray(results)) return false;

  const signature = typeof message.toolCallId === "string" && message.toolCallId
    ? `toolCallId:${message.toolCallId}`
    : stableStringify({ toolName: message.toolName, details: message.details });
  const seen = getSeenForkToolResultSignatures(result);
  if (seen.has(signature)) return false;

  let changed = false;
  for (const forkResult of results) {
    const usage = forkResult?.usage;
    if (!usage || typeof usage !== "object") continue;

    const input = finiteNumber(usage.input);
    const output = finiteNumber(usage.output);
    const cacheRead = finiteNumber(usage.cacheRead);
    const cacheWrite = finiteNumber(usage.cacheWrite);
    const cost = typeof usage.cost === "object" && usage.cost !== null
      ? finiteNumber(usage.cost.total)
      : finiteNumber(usage.cost);
    const turns = finiteNumber(usage.turns);
    const contextTokens = finiteNumber(usage.contextTokens) || finiteNumber(usage.totalTokens);

    if (!(input || output || cacheRead || cacheWrite || cost || turns || contextTokens)) continue;

    result.usage.input += input;
    result.usage.output += output;
    result.usage.cacheRead += cacheRead;
    result.usage.cacheWrite += cacheWrite;
    result.usage.cost += cost;
    result.usage.turns += turns;
    result.usage.contextTokens = Math.max(result.usage.contextTokens || 0, contextTokens);
    changed = true;
  }

  if (changed) seen.add(signature);
  return changed;
}

function addMessageUsage(result, message) {
  return addAssistantMessage(result, message) || addNestedForkUsage(result, message);
}

function addMessagesUsage(result, messages) {
  if (!Array.isArray(messages)) return false;
  let changed = false;
  for (const message of messages) {
    if (addMessageUsage(result, message)) changed = true;
  }
  return changed;
}

function ensureRetryState(result) {
  if (!result.retry || typeof result.retry !== "object") result.retry = {};
  if (!Array.isArray(result.retry.history)) result.retry.history = [];
  return result.retry;
}

function processAutoRetryStart(event, result) {
  const retry = ensureRetryState(result);
  retry.active = true;
  retry.pending = false;
  retry.success = undefined;

  if (typeof event.attempt === "number") retry.attempt = event.attempt;
  if (typeof event.maxAttempts === "number") retry.maxAttempts = event.maxAttempts;
  if (typeof event.delayMs === "number") retry.delayMs = event.delayMs;
  if (typeof event.errorMessage === "string") retry.errorMessage = event.errorMessage;
  delete retry.finalError;

  retry.history.push({
    type: "start",
    attempt: retry.attempt,
    maxAttempts: retry.maxAttempts,
    delayMs: retry.delayMs,
    errorMessage: retry.errorMessage,
  });

  result.sawAgentEnd = false;
  return true;
}

function processAutoRetryEnd(event, result) {
  const retry = ensureRetryState(result);
  retry.active = false;
  retry.pending = false;
  retry.success = Boolean(event.success);

  if (typeof event.attempt === "number") retry.attempt = event.attempt;
  if (typeof event.finalError === "string") retry.finalError = event.finalError;

  retry.history.push({
    type: "end",
    attempt: retry.attempt,
    success: retry.success,
    finalError: retry.finalError,
  });

  if (!retry.success) {
    result.stopReason = "error";
    if (retry.finalError) result.errorMessage = retry.finalError;
  }

  return true;
}

function maxActivityOrder(result) {
  const orders = [];
  if (typeof result?.thinking?.activityOrder === "number") orders.push(result.thinking.activityOrder);
  if (Array.isArray(result?.activities)) {
    for (const activity of result.activities) {
      if (typeof activity?.activityOrder === "number") orders.push(activity.activityOrder);
    }
  }
  if (Array.isArray(result?.toolExecutions)) {
    for (const tool of result.toolExecutions) {
      if (typeof tool?.activityOrder === "number") orders.push(tool.activityOrder);
    }
  }
  return orders.length > 0 ? Math.max(...orders) : 0;
}

function nextActivityOrder(result) {
  if (!Object.prototype.hasOwnProperty.call(result, "__activityOrder")) {
    Object.defineProperty(result, "__activityOrder", {
      value: maxActivityOrder(result),
      enumerable: false,
      configurable: false,
      writable: true,
    });
  }
  result.__activityOrder += 1;
  return result.__activityOrder;
}

function ensureActivities(result) {
  if (!Array.isArray(result.activities)) result.activities = [];
  return result.activities;
}

function addActivity(result, activity) {
  const activities = ensureActivities(result);
  const totalBefore = typeof result.activityCount === "number"
    ? result.activityCount
    : activities.length;
  result.activityCount = totalBefore + 1;
  activities.push(activity);
  return activity;
}

function findToolActivity(result, toolCallId) {
  if (!toolCallId || !Array.isArray(result.activities)) return undefined;
  return result.activities.find((activity) => activity?.type === "tool" && activity.toolCallId === toolCallId);
}

function syncToolActivity(result, tool) {
  if (!tool || typeof tool !== "object") return undefined;
  let activity = findToolActivity(result, tool.toolCallId);
  if (!activity) {
    activity = { type: "tool", ...tool, activityOrder: tool.activityOrder || nextActivityOrder(result) };
    addActivity(result, activity);
  } else {
    Object.assign(activity, tool, { type: "tool" });
  }
  return activity;
}

function latestActivity(result) {
  const activities = Array.isArray(result.activities) ? result.activities : [];
  return activities[activities.length - 1];
}

function latestRunningThinkingActivity(result) {
  const activities = Array.isArray(result.activities) ? result.activities : [];
  for (let i = activities.length - 1; i >= 0; i--) {
    const activity = activities[i];
    if (activity?.type === "thinking" && activity.status === "running") return activity;
  }
  return undefined;
}

function estimateTokensFromChars(chars) {
  const safeChars = typeof chars === "number" && Number.isFinite(chars) && chars > 0 ? chars : 0;
  return safeChars > 0 ? Math.ceil(safeChars / 4) : 0;
}

function getThinkingChars(activity) {
  if (typeof activity?._thinkingChars === "number") return activity._thinkingChars;
  if (typeof activity?.chars === "number") return activity.chars;
  if (typeof activity?.tokens === "number") return activity.tokens * 4;
  return 0;
}

function setThinkingChars(activity, chars) {
  Object.defineProperty(activity, "_thinkingChars", {
    value: Math.max(0, chars),
    writable: true,
    configurable: true,
    enumerable: false,
  });
  activity.tokens = estimateTokensFromChars(chars);
  delete activity.chars;
}

function getThinkingTokens(thinking) {
  if (typeof thinking?.tokens === "number") return thinking.tokens;
  if (typeof thinking?.chars === "number") return estimateTokensFromChars(thinking.chars);
  return 0;
}

function createThinkingActivity(result) {
  const activity = addActivity(result, {
    type: "thinking",
    status: "running",
    tokens: 0,
    activityOrder: nextActivityOrder(result),
  });
  setThinkingChars(activity, 0);
  return activity;
}

function ensureLatestThinkingActivity(result) {
  return latestRunningThinkingActivity(result) || createThinkingActivity(result);
}

function syncThinkingState(result, activity) {
  result.thinking = {
    status: activity.status,
    tokens: getThinkingTokens(activity),
    activityOrder: activity.activityOrder,
  };
  return result.thinking;
}

function ensureToolExecutions(result) {
  if (!Array.isArray(result.toolExecutions)) result.toolExecutions = [];
  return result.toolExecutions;
}

function findToolExecution(result, event) {
  const toolExecutions = ensureToolExecutions(result);
  const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;

  let tool = toolCallId
    ? toolExecutions.find((entry) => entry.toolCallId === toolCallId)
    : undefined;

  if (!tool) {
    const totalBefore = typeof result.toolExecutionCount === "number"
      ? result.toolExecutionCount
      : toolExecutions.length;
    result.toolExecutionCount = totalBefore + 1;
    tool = {
      toolCallId: toolCallId || `unknown-${result.toolExecutionCount}`,
      toolName: typeof event.toolName === "string" ? event.toolName : "tool",
      status: "running",
      updates: 0,
      activityOrder: nextActivityOrder(result),
    };
    toolExecutions.push(tool);
    while (toolExecutions.length > MAX_STORED_TOOL_EXECUTIONS) {
      toolExecutions.shift();
    }
  }

  if (typeof event.toolName === "string") tool.toolName = event.toolName;
  if (Object.prototype.hasOwnProperty.call(event, "args")) {
    tool.argsPreview = stringifyPreview(event.args, MAX_TOOL_ARGS_PREVIEW_CHARS);
    tool.displayText = formatToolCallPreview(tool.toolName, event.args);
  }

  if (!tool.displayText) tool.displayText = tool.toolName;

  return tool;
}

function processToolExecutionEvent(event, result) {
  const tool = findToolExecution(result, event);

  switch (event.type) {
    case "tool_execution_start":
      tool.status = "running";
      tool.isError = false;
      tool.latestText = "";
      syncToolActivity(result, tool);
      return true;

    case "tool_execution_update": {
      tool.status = "running";
      tool.isError = false;
      tool.updates = (tool.updates || 0) + 1;
      const latestText = extractResultText(event.partialResult);
      if (latestText) tool.latestText = latestText;
      syncToolActivity(result, tool);
      return true;
    }

    case "tool_execution_end": {
      tool.status = event.isError ? "error" : "completed";
      tool.isError = Boolean(event.isError);
      const latestText = extractResultText(event.result);
      if (latestText) tool.latestText = latestText;
      syncToolActivity(result, tool);
      return true;
    }

    default:
      return false;
  }
}

function processMessageUpdateEvent(event, result) {
  const assistantEvent = event.assistantMessageEvent;
  if (!assistantEvent || typeof assistantEvent !== "object") return false;

  switch (assistantEvent.type) {
    case "thinking_start": {
      const currentLatest = latestActivity(result);
      const activity = currentLatest?.type === "thinking" && currentLatest.status === "running"
        ? currentLatest
        : createThinkingActivity(result);
      activity.status = "running";
      syncThinkingState(result, activity);
      return true;
    }

    case "thinking_delta": {
      const activity = ensureLatestThinkingActivity(result);
      activity.status = "running";
      if (typeof assistantEvent.delta === "string") {
        setThinkingChars(activity, getThinkingChars(activity) + assistantEvent.delta.length);
      }
      syncThinkingState(result, activity);
      return true;
    }

    case "thinking_end": {
      const activity = ensureLatestThinkingActivity(result);
      activity.status = "completed";
      if (typeof assistantEvent.content === "string") {
        setThinkingChars(activity, assistantEvent.content.length);
      }
      syncThinkingState(result, activity);
      return true;
    }

    default:
      return false;
  }
}

export function processPiEvent(event, result) {
  if (!event || typeof event !== "object") return false;

  switch (event.type) {
    case "message_update":
      return processMessageUpdateEvent(event, result);

    case "message_end":
      return addMessageUsage(result, event.message);

    case "turn_end": {
      let changed = false;
      if (addMessageUsage(result, event.message)) changed = true;
      if (addMessagesUsage(result, event.toolResults)) changed = true;
      return changed;
    }

    case "agent_end":
      result.sawAgentEnd = true;
      return addMessagesUsage(result, event.messages);

    case "auto_retry_start":
      return processAutoRetryStart(event, result);

    case "auto_retry_end":
      return processAutoRetryEnd(event, result);

    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_execution_end":
      return processToolExecutionEvent(event, result);

    default:
      return false;
  }
}

export function processPiJsonLine(line, result) {
  if (!line.trim()) return false;

  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return false;
  }

  return processPiEvent(event, result);
}

export function getFinalAssistantText(messages) {
  if (!Array.isArray(messages)) return "";

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }

    for (const part of message.content) {
      if (part?.type === "text" && typeof part.text === "string" && part.text.length > 0) {
        return part.text;
      }
    }
  }

  return "";
}

function getLatestRelevantToolExecution(result) {
  const activities = Array.isArray(result?.activities) ? result.activities : [];
  for (let i = activities.length - 1; i >= 0; i--) {
    const activity = activities[i];
    if (activity?.type === "tool" && activity.status === "running") return activity;
  }
  for (let i = activities.length - 1; i >= 0; i--) {
    const activity = activities[i];
    if (activity?.type === "tool") return activity;
  }

  const toolExecutions = Array.isArray(result?.toolExecutions) ? result.toolExecutions : [];
  for (let i = toolExecutions.length - 1; i >= 0; i--) {
    if (toolExecutions[i]?.status === "running") return toolExecutions[i];
  }

  return toolExecutions[toolExecutions.length - 1];
}

function formatToolStatusIcon(tool) {
  if (tool?.status === "running") return "…";
  if (tool?.status === "error") return "×";
  return "✓";
}

function formatToolErrorSuffix(tool) {
  if (tool?.status !== "error" && !tool?.isError) return "";
  if (typeof tool.latestText !== "string" || !tool.latestText.trim()) return "";
  return ` — ${truncateInline(tool.latestText, MAX_INLINE_ERROR_PREVIEW_CHARS)}`;
}

function formatThinkingActivityProgress(thinking) {
  if (!thinking || typeof thinking !== "object") return "";
  const icon = thinking.status === "running" ? "…" : "✓";
  const tokens = getThinkingTokens(thinking);
  const label = tokens > 0
    ? `thinking ~${formatCount(tokens)} tokens`
    : thinking.status === "running" ? "thinking..." : "thinking";
  return `${icon} ${label}`;
}

function getActivityOrder(item, fallback) {
  return typeof item?.activityOrder === "number" ? item.activityOrder : fallback;
}

function formatActivityProgress(activity) {
  if (activity?.type === "thinking") return formatThinkingActivityProgress(activity);
  if (activity?.type === "tool") {
    return `${formatToolStatusIcon(activity)} ${activity.displayText || activity.toolName || "tool"}${formatToolErrorSuffix(activity)}`;
  }
  return "";
}

function legacyActivities(result) {
  const activities = [];
  if (result?.thinking) activities.push({ ...result.thinking, type: "thinking" });
  const toolExecutions = Array.isArray(result?.toolExecutions) ? result.toolExecutions : [];
  for (const tool of toolExecutions) activities.push({ ...tool, type: "tool" });
  activities.sort((a, b) => getActivityOrder(a, 0) - getActivityOrder(b, 0));
  return activities;
}

function getStoredActivities(result) {
  const activities = Array.isArray(result?.activities) && result.activities.length > 0
    ? result.activities
    : legacyActivities(result);
  return activities.filter((activity) => activity && typeof activity === "object");
}

function totalActivities(result, storedActivities) {
  if (typeof result?.activityCount === "number") {
    return Math.max(result.activityCount, storedActivities.length);
  }
  if (Array.isArray(result?.activities) && result.activities.length > 0) return storedActivities.length;
  const totalTools = typeof result?.toolExecutionCount === "number"
    ? Math.max(result.toolExecutionCount, Array.isArray(result?.toolExecutions) ? result.toolExecutions.length : 0)
    : Array.isArray(result?.toolExecutions) ? result.toolExecutions.length : 0;
  return totalTools + (result?.thinking ? 1 : 0);
}

function formatRetryProgress(retry) {
  if (!retry || typeof retry !== "object" || !retry.active) return "";

  const attempt = typeof retry.attempt === "number" ? retry.attempt : undefined;
  const maxAttempts = typeof retry.maxAttempts === "number" ? retry.maxAttempts : undefined;
  const attemptText = attempt && maxAttempts
    ? `attempt ${attempt}/${maxAttempts}`
    : attempt ? `attempt ${attempt}` : "retrying";
  const delayText = typeof retry.delayMs === "number" && retry.delayMs > 0
    ? `, waiting ${Math.round(retry.delayMs / 1000)}s`
    : "";
  const errorText = typeof retry.errorMessage === "string" && retry.errorMessage.trim()
    ? ` after ${truncateInline(retry.errorMessage.trim(), MAX_INLINE_ERROR_PREVIEW_CHARS)}`
    : "";

  return `Retrying${errorText} (${attemptText}${delayText})`;
}

function formatToolProgress(result) {
  const storedActivities = getStoredActivities(result);
  const lines = [];

  const toShow = storedActivities.slice(-10);
  const skipped = Math.max(0, totalActivities(result, storedActivities) - toShow.length);
  if (skipped > 0) lines.push(`... ${skipped} earlier activit${skipped === 1 ? "y" : "ies"}`);

  for (const activity of toShow) {
    const line = formatActivityProgress(activity);
    if (line) lines.push(line);
  }

  return lines.join("\n").trim();
}

export function getForkProgressText(result) {
  const retryProgress = formatRetryProgress(result?.retry);
  if (retryProgress) return retryProgress;

  const finalText = getFinalAssistantText(result?.messages);
  if (finalText) return finalText;

  const toolProgress = formatToolProgress(result);
  if (toolProgress) return toolProgress;

  if (typeof result?.errorMessage === "string" && result.errorMessage.trim()) {
    return result.errorMessage.trim();
  }

  return "(running...)";
}

export function getResultSummaryText(result) {
  const finalText = getFinalAssistantText(result?.messages);
  if (finalText) return finalText;

  if (typeof result?.errorMessage === "string" && result.errorMessage.trim()) {
    return result.errorMessage.trim();
  }

  const isError =
    (typeof result?.exitCode === "number" && result.exitCode > 0) ||
    result?.stopReason === "error" ||
    result?.stopReason === "aborted";

  if (isError && typeof result?.stderr === "string" && result.stderr.trim()) {
    return result.stderr.trim();
  }

  return "(no output)";
}
