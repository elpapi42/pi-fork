/**
 * Shared type definitions for the pi-fork extension.
 */

import type { Message } from "@earendil-works/pi-ai";
import { getFinalAssistantText } from "./runner-events.js";

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export interface ForkToolExecution {
  toolCallId: string;
  toolName: string;
  status: "running" | "completed" | "error";
  updates: number;
  argsPreview?: string;
  displayText?: string;
  latestText?: string;
  isError?: boolean;
  activityOrder?: number;
}

export interface ForkThinkingState {
  status: "running" | "completed";
  tokens: number;
  /** Backward-compatible field for older stored fork results. New results use estimated tokens. */
  chars?: number;
  activityOrder?: number;
}

export interface ForkToolActivity extends ForkToolExecution {
  type: "tool";
  activityOrder: number;
}

export interface ForkThinkingActivity extends ForkThinkingState {
  type: "thinking";
  activityOrder: number;
}

export type ForkActivity = ForkToolActivity | ForkThinkingActivity;

export type ForkEffort = "fast" | "balanced" | "deep";
export type ForkEffortSource = "tool" | "default";
export type ForkThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface ForkEffortProfile {
  provider: string;
  id: string;
  thinking: ForkThinkingLevel;
}

export interface ForkEffortState {
  selected: ForkEffort;
  source: ForkEffortSource;
  profile?: ForkEffortProfile;
  warning?: string;
}

export interface ForkRetryHistoryEntry {
  type: "start" | "end";
  attempt?: number;
  maxAttempts?: number;
  delayMs?: number;
  errorMessage?: string;
  success?: boolean;
  finalError?: string;
}

export interface ForkRetryState {
  active?: boolean;
  pending?: boolean;
  attempt?: number;
  maxAttempts?: number;
  delayMs?: number;
  errorMessage?: string;
  finalError?: string;
  success?: boolean;
  history?: ForkRetryHistoryEntry[];
}

export interface ForkResult {
  task: string;
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  provider?: string;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  sawAgentEnd?: boolean;
  effort?: ForkEffortState;
  retry?: ForkRetryState;
  thinking?: ForkThinkingState;
  activityCount?: number;
  activities?: ForkActivity[];
  toolExecutionCount?: number;
  toolExecutions?: ForkToolExecution[];
}

export interface ForkDetails {
  results: ForkResult[];
}

export function emptyUsage(): UsageStats {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    contextTokens: 0,
    turns: 0,
  };
}

export function hasFinalAssistantOutput(
  r: Pick<ForkResult, "messages">,
): boolean {
  return getFinalAssistantText(r.messages).trim().length > 0;
}

export function hasSemanticCompletion(
  r: Pick<ForkResult, "messages" | "sawAgentEnd">,
): boolean {
  return Boolean(r.sawAgentEnd) && hasFinalAssistantOutput(r);
}

export function isResultSuccess(r: ForkResult): boolean {
  if (r.exitCode === -1) return false;
  if (r.retry?.success === false) return false;
  if (hasSemanticCompletion(r)) return true;
  return r.exitCode === 0 && r.stopReason !== "error" && r.stopReason !== "aborted";
}

export function isResultError(r: ForkResult): boolean {
  if (r.exitCode === -1) return false;
  return !isResultSuccess(r);
}

export function normalizeCompletedResult(
  result: ForkResult,
  wasAborted: boolean,
): ForkResult {
  const hasSemanticSuccess = result.retry?.success === false ? false : hasSemanticCompletion(result);

  if (wasAborted) {
    if (hasSemanticSuccess) {
      result.exitCode = 0;
      if (result.stopReason === "aborted") result.stopReason = undefined;
      if (result.errorMessage === "Fork was aborted.") {
        result.errorMessage = undefined;
      }
    } else {
      result.exitCode = 130;
      result.stopReason = "aborted";
      result.errorMessage = "Fork was aborted.";
      if (!result.stderr.trim()) result.stderr = "Fork was aborted.";
    }
    return result;
  }

  if (result.exitCode > 0) {
    if (hasSemanticSuccess) {
      result.exitCode = 0;
      if (result.stopReason === "error") result.stopReason = undefined;
      if (result.errorMessage === result.stderr.trim()) {
        result.errorMessage = undefined;
      }
    } else {
      if (!result.stopReason) result.stopReason = "error";
      if (!result.errorMessage && result.stderr.trim()) {
        result.errorMessage = result.stderr.trim();
      }
    }
  }

  return result;
}

export function getFinalOutput(messages: Message[]): string {
  return getFinalAssistantText(messages);
}
