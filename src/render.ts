/**
 * Rich TUI rendering for the fork tool.
 *
 * The runner still returns plain text content for non-interactive/JSON callers;
 * these hooks only enhance Pi's interactive tool-call widget.
 */

import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { getFinalAssistantText } from "./runner-events.js";
import { type ForkResult, isResultError, isResultSuccess } from "./types.js";

const COLLAPSED_TOOL_COUNT = 8;
const COLLAPSED_OUTPUT_LINES = 3;
const MAX_TASK_PREVIEW_CHARS = 72;
const MAX_TEXT_PREVIEW_CHARS = 280;
const MAX_ERROR_PREVIEW_CHARS = 1200;
const MAX_INLINE_ERROR_PREVIEW_CHARS = 160;

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

function taskPreview(task: unknown): string {
  if (typeof task !== "string" || !task.trim()) return "...";
  return truncate(task.replace(/\s+/g, " ").trim(), MAX_TASK_PREVIEW_CHARS);
}

function textPreview(text: string, maxChars = MAX_TEXT_PREVIEW_CHARS): string {
  return truncate(text.trim().split(/\r?\n/).slice(0, COLLAPSED_OUTPUT_LINES).join("\n"), maxChars);
}

function inlinePreview(text: string, maxChars = MAX_INLINE_ERROR_PREVIEW_CHARS): string {
  return truncate(text.replace(/\s+/g, " ").trim(), maxChars);
}

function fmtCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return String(Math.round(n));
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function fmtModelProvider(result: ForkResult): string {
  const provider = result.provider?.trim();
  let model = result.model?.trim();
  if (provider && model?.startsWith(`${provider}/`)) model = model.slice(provider.length + 1);

  const thinking = result.effort?.profile?.thinking?.trim();
  const modelProvider = provider && model
    ? `(${provider}) ${model}`
    : provider ? `(${provider})`
      : model || "";

  return modelProvider && thinking ? `${modelProvider} • ${thinking}` : modelProvider;
}

function fmtUsage(result: ForkResult): string {
  const usage = result.usage;
  if (!usage) return "";

  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`);
  if (usage.input) parts.push(`↑${fmtCount(usage.input)}`);
  if (usage.output) parts.push(`↓${fmtCount(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${fmtCount(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${fmtCount(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  const modelProvider = fmtModelProvider(result);
  if (modelProvider) parts.push(modelProvider);
  return parts.join(" ");
}

function getPrimaryResult(toolResult: any): ForkResult | undefined {
  const results = toolResult?.details?.results;
  return Array.isArray(results) && results.length > 0 ? results[0] : undefined;
}

function getFallbackText(toolResult: any): string {
  const content = toolResult?.content;
  if (!Array.isArray(content)) return "(no output)";
  const text = content.find((part) => part?.type === "text" && typeof part.text === "string");
  return text?.text || "(no output)";
}

function forkStatus(result: ForkResult): "running" | "success" | "error" {
  if (result.exitCode === -1) return "running";
  if (isResultSuccess(result)) return "success";
  if (isResultError(result)) return "error";
  return "error";
}

function forkIcon(result: ForkResult, fg: (color: any, text: string) => string): string {
  const status = forkStatus(result);
  if (status === "running") return fg("warning", "…");
  if (status === "error") return fg("error", "×");
  return fg("success", "✓");
}

function statusLabel(status: "running" | "success" | "error"): string {
  if (status === "running") return "running";
  if (status === "success") return "completed";
  return "failed";
}

function toolIcon(tool: any, fg: (color: any, text: string) => string): string {
  if (tool?.status === "running") return fg("warning", "…");
  if (tool?.status === "error" || tool?.isError) return fg("error", "×");
  return fg("success", "✓");
}

function toolLabel(tool: any): string {
  return tool?.displayText || tool?.toolName || "tool";
}

function toolErrorSuffix(tool: any, fg: (color: any, text: string) => string): string {
  if (tool?.status !== "error" && !tool?.isError) return "";
  if (typeof tool.latestText !== "string" || !tool.latestText.trim()) return "";
  return fg("error", ` — ${inlinePreview(tool.latestText)}`);
}

function totalToolExecutions(result: ForkResult): number {
  const stored = Array.isArray(result.toolExecutions) ? result.toolExecutions.length : 0;
  return typeof result.toolExecutionCount === "number" ? Math.max(result.toolExecutionCount, stored) : stored;
}

function hasUnifiedActivities(result: ForkResult): boolean {
  return Array.isArray(result.activities) && result.activities.length > 0;
}

function latestToolWithPreview(result: ForkResult): any | undefined {
  const activities = hasUnifiedActivities(result) ? result.activities! : [];
  for (let i = activities.length - 1; i >= 0; i--) {
    const activity = activities[i];
    if (activity?.type === "tool" && activity.status === "running" && activity.latestText) return activity;
  }

  const tools = Array.isArray(result.toolExecutions) ? result.toolExecutions : [];
  for (let i = tools.length - 1; i >= 0; i--) {
    const tool = tools[i];
    if (tool?.status === "running" && tool.latestText) return tool;
  }
  return undefined;
}

function estimateTokensFromChars(chars: number): number {
  return chars > 0 ? Math.ceil(chars / 4) : 0;
}

function thinkingTokens(thinking: any): number {
  if (typeof thinking?.tokens === "number") return thinking.tokens;
  if (typeof thinking?.chars === "number") return estimateTokensFromChars(thinking.chars);
  return 0;
}

function thinkingLine(thinking: any, fg: (color: any, text: string) => string): string {
  if (!thinking) return "";
  const icon = thinking.status === "running" ? fg("warning", "…") : fg("success", "✓");
  const tokens = thinkingTokens(thinking);
  const label = tokens > 0
    ? `thinking ~${fmtCount(tokens)} tokens`
    : thinking.status === "running" ? "thinking..." : "thinking";
  return `${icon} ${fg("toolOutput", label)}`;
}

function activityOrder(item: any, fallback: number): number {
  return typeof item?.activityOrder === "number" ? item.activityOrder : fallback;
}

function legacyActivities(result: ForkResult): any[] {
  const activities: any[] = [];
  if (result.thinking) activities.push({ ...result.thinking, type: "thinking" });
  const tools = Array.isArray(result.toolExecutions) ? result.toolExecutions : [];
  for (const tool of tools) activities.push({ ...tool, type: "tool" });
  activities.sort((a, b) => activityOrder(a, 0) - activityOrder(b, 0));
  return activities;
}

function storedActivities(result: ForkResult): any[] {
  return hasUnifiedActivities(result) ? result.activities! : legacyActivities(result);
}

function totalActivityCount(result: ForkResult, stored: any[]): number {
  if (typeof result.activityCount === "number") return Math.max(result.activityCount, stored.length);
  if (hasUnifiedActivities(result)) return stored.length;
  return totalToolExecutions(result) + (result.thinking ? 1 : 0);
}

function activityLine(activity: any, fg: (color: any, text: string) => string): string {
  if (activity?.type === "thinking") return thinkingLine(activity, fg);
  if (activity?.type === "tool") {
    return `${toolIcon(activity, fg)} ${fg(activity?.status === "error" ? "error" : "toolOutput", toolLabel(activity))}${toolErrorSuffix(activity, fg)}`;
  }
  return "";
}

function renderToolLines(
  result: ForkResult,
  fg: (color: any, text: string) => string,
  limit?: number,
): string {
  const activities = storedActivities(result);
  const lines: string[] = [];

  const toShow = limit ? activities.slice(-limit) : activities;
  const skipped = Math.max(0, totalActivityCount(result, activities) - toShow.length);
  if (skipped > 0) {
    lines.push(fg("muted", `... ${skipped} earlier activit${skipped === 1 ? "y" : "ies"}`));
  }

  for (const activity of toShow) {
    const line = activityLine(activity, fg);
    if (line) lines.push(line);
  }

  const previewTool = latestToolWithPreview(result);
  if (previewTool?.latestText) {
    lines.push("");
    lines.push(fg("toolOutput", textPreview(previewTool.latestText, MAX_TEXT_PREVIEW_CHARS)));
  }

  return lines.join("\n").trimEnd();
}

function errorText(result: ForkResult): string {
  const message = result.errorMessage?.trim() || result.stderr?.trim() || "";
  return message ? truncate(message, MAX_ERROR_PREVIEW_CHARS) : "";
}

function addSection(container: any, title: string, child: any, fg: (color: any, text: string) => string) {
  container.addChild(new Spacer(1));
  container.addChild(new Text(fg("muted", title), 0, 0));
  container.addChild(child);
}

export function renderForkCall(args: any, theme: any) {
  const fg = theme.fg.bind(theme);
  const effort = typeof args?.effort === "string" ? ` ${fg("muted", `[${args.effort}]`)}` : "";
  const text = `${fg("toolTitle", theme.bold("fork"))}${effort} ${fg("dim", taskPreview(args?.task))}`;
  return new Text(text, 0, 0);
}

export function renderForkResult(toolResult: any, { expanded }: { expanded: boolean }, theme: any) {
  const result = getPrimaryResult(toolResult);
  if (!result) return new Text(getFallbackText(toolResult), 0, 0);

  const fg = theme.fg.bind(theme);
  const status = forkStatus(result);
  const icon = forkIcon(result, fg);
  const finalOutput = getFinalAssistantText(result.messages);
  const usage = fmtUsage(result);
  const toolsText = renderToolLines(result, fg, expanded ? undefined : COLLAPSED_TOOL_COUNT);
  const mdTheme = getMarkdownTheme();

  if (expanded) {
    const container = new Container();
    container.addChild(new Spacer(1));
    const header = `${icon} ${fg("toolTitle", theme.bold(statusLabel(status)))}`;
    container.addChild(new Text(header, 0, 0));

    addSection(container, "─── Task ───", new Text(fg("dim", result.task || "..."), 0, 0), fg);

    if (toolsText) {
      addSection(container, "─── Activity ───", new Text(toolsText, 0, 0), fg);
    }

    if (finalOutput) {
      addSection(container, "─── Output ───", new Markdown(finalOutput.trim(), 0, 0, mdTheme), fg);
    } else if (status !== "running") {
      addSection(container, "─── Output ───", new Text(fg("muted", "(no final response)"), 0, 0), fg);
    }

    const err = status === "error" ? errorText(result) : "";
    if (err) {
      addSection(container, "─── Error ───", new Text(fg("error", err), 0, 0), fg);
    }

    if (usage) {
      container.addChild(new Spacer(1));
      container.addChild(new Text(fg("dim", usage), 0, 0));
    }

    return container;
  }

  const collapsedStatusPrefix = status === "running" ? "" : "\n";
  let text = `${collapsedStatusPrefix}${icon} ${fg("toolTitle", theme.bold(statusLabel(status)))}`;

  if (toolsText) {
    text += `\n${toolsText}`;
    if (finalOutput) text += `\n\n${fg("toolOutput", textPreview(finalOutput))}`;
  } else if (finalOutput) {
    text += `\n${fg("toolOutput", textPreview(finalOutput))}`;
  } else if (status === "running") {
    text += `\n${fg("muted", "(running...)")}`;
  } else {
    text += `\n${fg("muted", "(no final response)")}`;
  }

  if (status === "error") {
    const err = errorText(result);
    if (err) text += `\n${fg("error", textPreview(err))}`;
  }

  if (usage) text += `\n${fg("dim", usage)}`;

  const activities = storedActivities(result);
  const totalActivities = totalActivityCount(result, activities);
  if (!expanded && (totalActivities > COLLAPSED_TOOL_COUNT || finalOutput || status !== "running")) {
    text += `\n${fg("muted", "(Ctrl+O to expand)")}`;
  }

  return new Text(text, 0, 0);
}
