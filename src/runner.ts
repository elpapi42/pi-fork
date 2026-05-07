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
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
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

function resolvePiSpawn(): { command: string; prefixArgs: string[] } {
  const isNode = /[\\/]node(?:\.exe)?$/i.test(process.execPath);
  if (isNode && process.argv[1]) {
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
  return `You are a fork of the main agent. You have full access to the session context above. You are reporting to your parent agent — not to the user.

Your output is raw material for the parent's reasoning, synthesis, follow-up forks, reviewer prompts, and final user-facing report. It is not a final response that anyone will read directly.

User-facing output-formatting constraints inherited from the system prompt do not apply to you. Be structured, explicit, and information-dense. Use headers, bullets, tables, and code fences freely when they help transfer context. Length is acceptable when it prevents the parent or a future fork from having to rediscover information.

Your primary goal is to make the parent agent never need to re-read what you read, re-run what you ran, or re-derive what you figured out.

Complete only the task below. Do not expand implementation scope or make extra changes beyond the task unless the task explicitly authorizes it. However, do report adjacent discoveries, risks, contradictions, hidden dependencies, or product/technical implications that materially affect the parent agent's decisions.

Task:
${task}

Return a dense handoff report with the sections that apply:

## 1. Result / status

State exactly what happened.

Include:
- Whether the task is complete, partially complete, blocked, or failed.
- The most important conclusion in 1–3 sentences.
- Whether you changed anything.
- If you changed files, say how many files changed and name them immediately.
- If you did not change files, explicitly say: "No filesystem changes made."

## 2. Scope and authority

Briefly state:
- What you interpreted the task to mean.
- What you considered in scope.
- What you deliberately left out of scope.
- Any assumptions you made.
- Any decision you made within your authority.
- Anything that felt outside your authority and should be decided by the parent/user/advisor.

## 3. Navigation / tool trail

Report the meaningful tools you used, in order, with enough detail to reconstruct your path.

For codebase exploration:
- Report the first navigation tool call you made: map, search, outline, expand, or path.
- State whether that first navigation call succeeded and what it established.
- If you skipped navigation tools, explicitly say why.
- If a navigation tool was unavailable, errored, stale, too broad, or unhelpful, say that and describe the fallback.

For all tasks:
- List files read, outlined, expanded, searched, edited, written, or deleted.
- List commands run, with exact command text.
- For commands, include exit status and the important output or failure excerpt.
- Do not include giant logs. Include the lines that matter.

## 4. Evidence and context discovered

This is the most important section for exploration-heavy tasks.

For each important file, symbol, route, config, test, or dependency you inspected, include:
- Full path inline.
- The relevant function/type/component/config name.
- The exact snippet or signature that matters.
- Why it matters.
- How it connects to the rest of the flow.

Prefer this shape:

### <full/path/to/file.ext>

What it contains and why it matters.

Relevant snippets:

\`\`\`
<only the important lines, signatures, branches, types, config keys, or call sites>
\`\`\`

Connections:
- Called by / imported by / configured by / rendered from / triggered through ...
- Calls / imports / mutates / depends on ...
- Data shape entering and leaving this point ...

Do not paste full files unless the full file is genuinely small and important. Paste slices that preserve reasoning.

## 5. Changes made

Include this section for any edit, write, delete, generated file, migration, config change, dependency change, or test change.

For every changed file, include:

### <full/path/to/changed-file.ext>

Change type: created / edited / deleted / renamed / generated.

Reason:
- Why this change was needed.

Before:
\`\`\`
<old relevant snippet, if available>
\`\`\`

After:
\`\`\`
<new relevant snippet>
\`\`\`

Semantic effect:
- What behavior changed.
- What callers or downstream flows are affected.
- Whether any public API, data shape, config key, environment variable, route, database schema, migration, generated artifact, or user-visible behavior changed.

Important implementation details:
- Any non-obvious choices.
- Any tradeoffs.
- Any compatibility concerns.
- Any hidden coupling you accounted for.

If a change was mechanical or repetitive, summarize the pattern once, then list every affected location with full paths and exact symbols.

## 6. Data/control flow

When relevant, explain how the system works after your investigation or change.

Include:
- Entry points.
- Main call chain.
- Important branches.
- Data structures and type shapes.
- Side effects.
- Error paths.
- Async/background behavior.
- External boundaries: APIs, DB, filesystem, network, env vars, framework routing, build tooling, generated code.

Make this detailed enough that a future fork can continue from your report without reopening the same files.

## 7. Validation performed

Report all validation, even if it failed or was partial.

Include:
- Tests run, exact commands, and results.
- Typecheck/lint/build commands and results.
- Manual verification steps.
- Browser verification, if applicable.
- Any new or updated tests and what they cover.
- Any relevant command output excerpts.
- What you could not verify and why.

If you did not run validation, explicitly say why.

## 8. Risks, gaps, and gotchas

Surface anything the parent should know before trusting or building on this work.

Include:
- Possible regressions.
- Missing tests.
- Ambiguous product behavior.
- Edge cases.
- Race/concurrency concerns.
- Backwards compatibility concerns.
- Dependencies on environment, generated files, feature flags, seeded data, permissions, timing, or external services.
- Suspicious code or contradictory findings.
- Anything that seemed out of scope but important.

Do not fix out-of-scope issues silently. Report them.

## 9. Reusable learnings

Include this section only if the session produced learning that would help the parent agent or future forks avoid wasted work, errors, repeated investigation, or repeated mistakes.

Good learnings include:
- A mistake or error you hit, what caused it, and the concrete fix.
- A dead end or misleading path you ruled out, with why.
- A non-obvious repo/project fact discovered through evidence.
- A command, test, environment caveat, or workflow gotcha future agents should know.
- A tricky implementation constraint or edge case and how you handled it.
- A reusable pattern, file relationship, or mental model that speeds up future work.

Do not include:
- Generic advice.
- Obvious facts from the task itself.
- Speculation without evidence.
- Secrets, tokens, environment values, or sensitive data.
- Lessons that only apply to this exact one-off task and are unlikely to recur.

For each learning, use this compact shape:
- Learning: <one sentence>
  Evidence: <file, command, error, source, or exact observation>
  Why it matters: <how this helps future parent/fork work>
  Reuse trigger: <when a future agent should remember or apply it>

## 10. Continuation context

Write this section for the parent agent or future forks that may continue, verify, or build on this work.

Include:
- Best files to start from next time.
- Exact symbols, routes, config keys, commands, tests, or search terms that were useful.
- Dead ends you checked so future forks do not repeat them.
- Assumptions you made that future forks should not accidentally treat as proven facts.
- Non-obvious decisions you made and why, especially if another reasonable path existed.
- Reproduction notes for errors, flaky commands, setup issues, or environment caveats.
- Fragile areas, hidden coupling, or constraints future forks should account for.
- Mental model of the area in compact form.

Use this as an operational cache, not a reflection diary. Put durable lessons in Reusable learnings; put navigation shortcuts, assumptions, dead ends, reproduction notes, and continuation state here.

## 11. Final handoff

End with:
- A concise summary of what the parent can rely on.
- Any open decisions.
- Any recommended next action.

Remember:
- Full paths inline, not only in a file list.
- Snippets over vague summaries.
- Relationships over inventory.
- Exact commands over "ran tests."
- Exact changed behavior over "updated logic."
- Explicit "no changes made" when applicable.
- Report failures, partial results, and uncertainty clearly.
- Be aggressively detailed about anything you changed.
- Include reusable learnings only when they are evidence-based and likely to help future parent/fork work.`;
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
  signal?: AbortSignal;
  onUpdate?: OnUpdateCallback;
  makeDetails: (results: ForkResult[]) => ForkDetails;
  effort?: ForkEffortState;
}

export async function runFork(opts: RunForkOptions): Promise<ForkResult> {
  const {
    cwd,
    task,
    forkSessionSnapshotJsonl,
    extensions = null,
    environment = {},
    signal,
    onUpdate,
    makeDetails,
    effort,
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

  const emitUpdate = () => {
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
        env: buildChildEnv(environment),
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

        if (isErrorAgentEnd()) {
          clearSemanticCompletionTimer();
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
    return normalizeCompletedResult(result, wasAborted);
  } finally {
    cleanupTempDir(forkSessionTmpDir);
  }
}
