/**
 * Fork process runner.
 *
 * Spawns an isolated `pi` process, gives it a temporary session snapshot, and
 * streams JSON-mode results back to the parent tool call.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { buildChildEnv } from "./env.ts";
import { parseInheritedCliArgs } from "./runner-cli.js";
import { getForkProgressText, processPiJsonLine } from "./runner-events.js";
import {
  type ForkDetails,
  type ForkEffortProfile,
  type ForkEffortState,
  type ForkResult,
  emptyUsage,
  normalizeCompletedResult,
} from "./types.ts";

const isWindows = process.platform === "win32";
const SIGKILL_TIMEOUT_MS = 5000;
const AGENT_END_GRACE_MS = 250;
const RETRY_DECISION_GRACE_MS = 1000;

type OnUpdateCallback = (partial: AgentToolResult<ForkDetails>) => void;
export type ContextWindowResolver = (provider?: string, model?: string) => number | undefined;

function resolvePiSpawn(): { command: string; prefixArgs: string[] } {
  const isNode = /[\\/]node(?:\.exe)?$/i.test(process.execPath);
  const isBun = /[\\/]bun(?:\.exe)?$/i.test(process.execPath);
  if ((isNode || isBun) && process.argv[1]) {
    return { command: process.execPath, prefixArgs: [process.argv[1]] };
  }
  return { command: process.execPath, prefixArgs: [] };
}

function writeForkSessionToTempFile(
  sessionJsonl: string,
): { dir: string; filePath: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fork-"));
  const filePath = path.join(tmpDir, "fork.jsonl");
  fs.writeFileSync(filePath, sessionJsonl, { encoding: "utf-8", mode: 0o600 });
  return { dir: tmpDir, filePath };
}

function cleanupTempDir(dir: string | null): void {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

export function buildForkTaskPrompt(task: string): string {
  return `${task}

You are a fork. Complete only the bounded task above. Stay within the assigned scope. Do not expand into adjacent or broader work. Report blockers and out-of-scope findings instead of acting on them.

After completing the task, write a dense, decision-useful report. The report must preserve enough context to understand what happened, trust the conclusions, and continue the work without repeating your investigation.

Do not return only a completion statement or high-level summary. Include the concrete information that makes your work useful after your session ends.

Use exactly these two required headings:

## Output

Give the complete, useful substance of the task. This section is free-form. Use paragraphs, bullets, numbered steps, tables, and fenced snippets in the combination that best fits the work.

Start with the outcome and completion state when they matter: complete, partial, blocked, or failed. State what changed, what you found, and what remains unresolved.

When the assigned task could modify files or external state, identify the changed files or external actions. If nothing changed, state \`No changes made\`.

Adapt the content to the assigned task. Include the relevant details needed to understand, trust, or continue the work:

- For exploration, include entry points, important files or symbols, relationships, control flow, and surprising behavior.
- For implementation, include changed files, changed behavior, affected callers or surfaces, compatibility impact, what remains untouched, and validation results.
- For debugging, include the root cause, reproduction condition, trace, ruled-out causes, fix point, and remaining uncertainty.
- For review or validation, include the verdict, findings by severity, checked surface, unaffected surfaces when relevant, and blind spots.
- For planning or specification, include the proposed steps, requirements, acceptance criteria, non-goals, tradeoffs, and sequencing constraints.
- For research or documentation, include the answer, sources, version or API constraints, and implications for the assigned task.
- For decisions or option analysis, include the recommendation, strongest reasoning, tradeoffs, deciding assumptions, and unresolved questions.

Include blockers, material assumptions, risks, validation gaps, and out-of-scope findings when they affect trust or interpretation. Distinguish direct evidence from interpretation.

Ground each important conclusion with precise pointers to its source. Put each pointer close to the claim it supports. Useful pointers include:

- file paths with line ranges;
- file paths with symbols, functions, classes, routes, or headings;
- URLs with page headings, anchors, or relevant sections;
- commands with decisive results;
- test names with pass or failure results;
- configuration keys and effective values;
- exact errors, logs, or response fields;
- artifact names and relevant sections.

Pointers are critical. Make them precise enough to reopen the exact source without repeating broad exploration.

Include source snippets when the exact code, text, configuration, error, or response helps verify a conclusion or continue the work. Snippets are critical when paraphrase would hide important structure or force the source to be reopened immediately.

For each snippet:

- identify the source before the snippet;
- include the smallest decisive excerpt;
- explain why the snippet matters;
- remove unrelated imports, boilerplate, generated content, and surrounding noise.

Include as many snippets as the task needs. Do not add snippets that only prove that you inspected a source.

When reporting validation, state what the check proves. Also state what it does not prove when that limit affects trust. Include failed checks and exact errors when they change the conclusion.

Report ruled-out paths when they prevent repeated investigation. Identify what you checked, what you ruled out, and why that result matters.

Do not include:

- a full task restatement;
- tool-by-tool narration;
- full search or command history;
- exhaustive inventories that do not affect the assigned task;
- repeated evidence;
- unsupported confidence claims;
- generic advice;
- details that only prove effort.

## Learnings

Record reusable knowledge discovered during the task. This section is not a second summary of \`Output\`. It preserves information that can prevent repeated work or improve future reasoning.

Include lessons such as:

- a plausible path that failed and why;
- a corrected assumption;
- a stale or misleading document, comment, or name;
- a command or tool gotcha and its recovery;
- hidden coupling or side effects;
- a source-of-truth discovery;
- a validation limitation;
- a reusable project rule or mental model;
- something similar work should search, test, avoid, or try first.

For each learning, include:

- the compact lesson;
- a precise evidence pointer or exact observation;
- the condition where the lesson becomes useful.

Use this shape when it helps:

- Learning: <reusable lesson>
  Evidence: <path, line range, symbol, command, error, URL, or exact observation>
  Reuse when: <future trigger>

Include all material learnings, but do not invent lessons to fill the section. If the task produced no reusable learning, write:

No reusable learnings found.

Right-size both sections independently. A small, mechanical task with few findings should produce a short report. A complex task with many actions, findings, decisions, risks, or evidence should produce a longer report.

There is no fixed length limit. Include all information needed to understand, evaluate, verify, or continue the assigned work. Do not remove useful context only to make the report brief. Do not add detail that does not improve understanding, trust, verification, or reuse.

Always use exactly these two required headings: \`Output\` and \`Learnings\`.`;
}


const inheritedCliArgs = parseInheritedCliArgs(process.argv);

export function buildPiArgs(
  task: string,
  forkSessionPath: string,
  extensions: string[] | null,
  effortProfile?: ForkEffortProfile,
  inherited = inheritedCliArgs,
): string[] {
  const args: string[] = [
    "--mode",
    "json",
    ...inherited.alwaysProxy,
    "-p",
    "--session",
    forkSessionPath,
  ];

  if (extensions !== null) {
    args.push("--no-extensions");
  }

  if (inherited.fallbackModel) {
    args.push("--model", inherited.fallbackModel);
  }

  if (inherited.fallbackThinking) {
    args.push("--thinking", inherited.fallbackThinking);
  }

  if (effortProfile) {
    args.push("--provider", effortProfile.provider);
    args.push("--model", effortProfile.id);
    args.push("--thinking", effortProfile.thinking);
  }

  if (inherited.fallbackTools !== undefined) {
    args.push("--tools", inherited.fallbackTools);
  } else if (inherited.fallbackNoTools) {
    args.push("--no-tools");
  }

  if (extensions !== null) {
    for (const extension of extensions) {
      args.push("--extension", extension);
    }
  }

  args.push(buildForkTaskPrompt(task));
  return args;
}

export interface RunForkOptions {
  cwd: string;
  task: string;
  forkSessionSnapshotJsonl: string;
  extensions?: string[] | null;
  environment?: Record<string, string>;
  offline?: boolean;
  signal?: AbortSignal;
  onUpdate?: OnUpdateCallback;
  makeDetails: (results: ForkResult[]) => ForkDetails;
  effort?: ForkEffortState;
  resolveContextWindow?: ContextWindowResolver;
}

export async function runFork(opts: RunForkOptions): Promise<ForkResult> {
  const {
    cwd,
    task,
    forkSessionSnapshotJsonl,
    extensions = null,
    environment = {},
    offline = true,
    signal,
    onUpdate,
    makeDetails,
    effort,
    resolveContextWindow,
  } = opts;

  if (!forkSessionSnapshotJsonl.trim()) {
    const failedResult: ForkResult = {
      task,
      exitCode: 1,
      messages: [],
      stderr: "Cannot fork: missing parent session snapshot context.",
      usage: emptyUsage(),
      stopReason: "error",
      errorMessage: "Cannot fork: missing parent session snapshot context.",
    };
    if (effort) failedResult.effort = effort;
    return failedResult;
  }

  const result: ForkResult = {
    task,
    exitCode: -1,
    messages: [],
    stderr: "",
    usage: emptyUsage(),
  };
  if (effort) result.effort = effort;

  const enrichContextWindow = () => {
    if (result.usage.contextWindow || !resolveContextWindow) return;
    const contextWindow = resolveContextWindow(result.provider, result.model);
    if (typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0) {
      result.usage.contextWindow = contextWindow;
    }
  };

  const emitUpdate = () => {
    enrichContextWindow();
    onUpdate?.({
      content: [
        {
          type: "text",
          text: getForkProgressText(result),
        },
      ],
      details: makeDetails([result]),
    });
  };

  let forkSessionTmpDir: string | null = null;
  let forkSessionTmpPath: string | null = null;
  const tmp = writeForkSessionToTempFile(forkSessionSnapshotJsonl);
  forkSessionTmpDir = tmp.dir;
  forkSessionTmpPath = tmp.filePath;

  try {
    const piArgs = buildPiArgs(task, forkSessionTmpPath, extensions, effort?.profile);
    let wasAborted = false;

    const exitCode = await new Promise<number>((resolve) => {
      const { command, prefixArgs } = resolvePiSpawn();
      const proc = spawn(command, [...prefixArgs, ...piArgs], {
        cwd,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        env: buildChildEnv(environment, process.env, process.platform, offline),
      });

      proc.stdin.on("error", () => {
        /* ignore broken pipe on fast exits */
      });
      proc.stdin.end();

      let buffer = "";
      let didClose = false;
      let settled = false;
      let abortHandler: (() => void) | undefined;
      let semanticCompletionTimer: NodeJS.Timeout | undefined;
      let retryDecisionTimer: NodeJS.Timeout | undefined;

      const clearSemanticCompletionTimer = () => {
        if (semanticCompletionTimer) {
          clearTimeout(semanticCompletionTimer);
          semanticCompletionTimer = undefined;
        }
      };

      const clearRetryDecisionTimer = () => {
        if (retryDecisionTimer) {
          clearTimeout(retryDecisionTimer);
          retryDecisionTimer = undefined;
        }
        if (result.retry?.pending) result.retry.pending = false;
      };

      const clearCompletionTimers = () => {
        clearSemanticCompletionTimer();
        clearRetryDecisionTimer();
      };

      const terminateChild = () => {
        if (isWindows) {
          if (proc.pid !== undefined) {
            const killer = spawn("taskkill", ["/T", "/F", "/PID", String(proc.pid)], {
              stdio: "ignore",
            });
            killer.unref();
          }
          return;
        }

        proc.kill("SIGTERM");
        const sigkillTimer = setTimeout(() => {
          if (!didClose) proc.kill("SIGKILL");
        }, SIGKILL_TIMEOUT_MS);
        sigkillTimer.unref();
      };

      const finish = (code: number) => {
        if (settled) return;
        settled = true;
        clearCompletionTimers();
        if (signal && abortHandler) {
          signal.removeEventListener("abort", abortHandler);
        }
        resolve(code);
      };

      const finishSemantically = () => {
        if (didClose || settled) return;
        if (buffer.trim()) {
          flushBufferedLines(buffer);
          buffer = "";
        }
        proc.stdout.removeListener("data", onStdoutData);
        proc.stderr.removeListener("data", onStderrData);
        finish(0);
        terminateChild();
      };

      const scheduleSemanticCompletion = (delayMs: number) => {
        clearSemanticCompletionTimer();
        semanticCompletionTimer = setTimeout(() => {
          if (didClose || settled) return;
          finishSemantically();
        }, delayMs);
        semanticCompletionTimer.unref();
      };

      const isErrorAgentEnd = () => result.stopReason === "error" || result.stopReason === "aborted";

      const maybeFinishFromAgentEnd = () => {
        if (didClose || settled) return;

        if (result.retry?.active) {
          clearSemanticCompletionTimer();
          clearRetryDecisionTimer();
          return;
        }

        if (result.retry?.success === false) {
          clearRetryDecisionTimer();
          scheduleSemanticCompletion(AGENT_END_GRACE_MS);
          return;
        }

        if (!result.sawAgentEnd) return;

        if (result.willRetry === true) {
          // Child Pi declared it will auto-retry; wait for retry events
          // (or process exit) instead of finishing and killing the child.
          clearSemanticCompletionTimer();
          clearRetryDecisionTimer();
          return;
        }

        if (isErrorAgentEnd()) {
          clearSemanticCompletionTimer();
          if (result.willRetry === false) {
            // Child Pi declared no retry will happen; finish promptly
            // instead of waiting the retry-decision window.
            clearRetryDecisionTimer();
            scheduleSemanticCompletion(AGENT_END_GRACE_MS);
            return;
          }
          if (!retryDecisionTimer) {
            if (!result.retry || typeof result.retry !== "object") result.retry = {};
            result.retry.pending = true;
            retryDecisionTimer = setTimeout(() => {
              retryDecisionTimer = undefined;
              if (result.retry?.pending) result.retry.pending = false;
              if (didClose || settled || result.retry?.active) return;
              scheduleSemanticCompletion(0);
            }, RETRY_DECISION_GRACE_MS);
            retryDecisionTimer.unref();
          }
          return;
        }

        clearRetryDecisionTimer();
        scheduleSemanticCompletion(AGENT_END_GRACE_MS);
      };

      const flushLine = (line: string) => {
        if (processPiJsonLine(line, result)) emitUpdate();
        maybeFinishFromAgentEnd();
      };

      const flushBufferedLines = (text: string) => {
        for (const line of text.split(/\r?\n/)) {
          if (line.trim()) flushLine(line);
        }
      };

      const onStdoutData = (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";
        for (const line of lines) flushLine(line);
      };

      const onStderrData = (chunk: Buffer) => {
        result.stderr += chunk.toString();
      };

      proc.stdout.on("data", onStdoutData);
      proc.stderr.on("data", onStderrData);

      proc.on("close", (code) => {
        didClose = true;
        if (buffer.trim()) flushBufferedLines(buffer);
        finish(code ?? 0);
      });

      proc.on("error", (err) => {
        if (!result.stderr.trim()) result.stderr = err.message;
        finish(1);
      });

      if (signal) {
        abortHandler = () => {
          if (didClose || settled) return;
          wasAborted = true;
          terminateChild();
        };
        if (signal.aborted) abortHandler();
        else signal.addEventListener("abort", abortHandler, { once: true });
      }
    });

    result.exitCode = exitCode;
    enrichContextWindow();
    return normalizeCompletedResult(result, wasAborted);
  } finally {
    cleanupTempDir(forkSessionTmpDir);
  }
}
