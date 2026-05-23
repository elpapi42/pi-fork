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
  return `${task}

After completing this task, write a compact report.

I want useful reporting, not completeness. Help me understand what happened, trust the result, and preserve any lessons that would prevent repeated work later.

Use this structure:

## Result

Say what happened in 1–5 bullets.

Pick only relevant details:
- Status: complete / partial / blocked / failed.
- Outcome: answer, recommendation, root cause, plan, or changed behavior.
- Changes: files changed, or "no changes made".
- Confidence: high / medium / low, only if useful.
- Caveat: important uncertainty, blocker, or unvalidated assumption.
- Material assumption: only if it would change the outcome or recommendation.

Examples:
- Complete. No changes made. Found where the behavior is implemented.
- Partial. Identified the likely root cause, but did not implement a fix.
- Blocked. Could not validate because the local service would not start.
- Complete. Changed the implementation and updated the relevant tests.

Keep out:
- Long background.
- Full task restatement.
- Generic process narration.

## Output

Give the useful substance of the task. Adapt this section to the work.

For exploration, include:
- Entry points.
- Important files/symbols.
- Key flow or relationship.
- Surprising behavior.

For debate or option analysis, include:
- Recommendation.
- Strongest arguments.
- Tradeoffs.
- Deciding assumptions.

For implementation, include:
- Changed files.
- Behavior changed.
- Affected callers/surfaces.
- Blast radius: what changes, what remains untouched, and compatibility notes.

For planning/spec work, include:
- Plan steps.
- Requirements.
- Acceptance criteria.
- Non-goals.
- Sequencing constraints.

For debugging, include:
- Root cause.
- Repro condition.
- Trace.
- Ruled-out causes.
- Fix point.

For review/validation, include:
- Verdict.
- Issues by severity.
- Checked surface.
- Affected or unaffected surfaces when that changes review scope.
- Important blind spots.

For research/docs, include:
- Answer.
- Source constraint.
- Version/API caveat.
- Implication for this project.

Keep out:
- Full inventories.
- Every observation.
- Tool-by-tool narration.
- Anything that does not change a decision.

## Evidence

Include only anchors needed to trust, verify, or continue the work. For each important conclusion, include concrete grounding: path + symbol, command + result, test name, doc/source, config key, error message, or short snippet.

Prefer anchors over long explanation. If a conclusion is interpretation rather than direct evidence, say so.

Good evidence:
- Exact paths.
- Symbols/functions/classes.
- Commands and results.
- Test names.
- Config keys or defaults.
- Source-of-truth notes.
- Short decisive snippets.
- Doc/source references.
- Error messages that explain a failure.

Use snippets when raw code/text would let me decide, verify, or continue without reopening the file immediately.

Good snippet targets:
- Decisive branches or conditions.
- Function signatures.
- Type/schema/API contracts.
- Config defaults.
- Prompt wording.
- Call sites.
- Test assertions.
- Error messages.
- Small data/control-flow handoffs.
- Surprising coupling or behavior.

Snippet rules:
- Prefer 3–12 lines.
- Include path + symbol before the snippet.
- Explain why it matters in one sentence.
- Trim unrelated lines aggressively.
- Use 1–3 snippets for normal tasks.
- Use more only for debugging, architecture, security/data risk, or complex flow.

For decisions that depend on code shape, include a tiny evidence packet:
- Source of truth: <path and symbol>
- Decisive anchor: <test, call site, config key, error, or short snippet>
- Why it matters: <one sentence>

For validation, include what the check proves and what it does not prove when that matters.

Include ruled-out anchors when they prevent repeated rediscovery:
- Checked path/symbol.
- What was ruled out.
- Why it matters.

Keep out:
- Full command logs.
- Full read/search history.
- Long snippets unless necessary.
- Snippets that only prove a file was inspected.
- Full files, boilerplate, imports, generated code, or long blocks unless exact text is the point.
- Repeating the same fact without adding trust.

## Learnings

Include only reusable lessons that would prevent repeated work. Material assumptions, ruled-out paths, and gotchas belong here only when they are reusable beyond this task.

A learning is worth including if it changes what someone later would:
- Search.
- Trust.
- Test.
- Avoid.
- Try first.
- Consider risky.

Good learning types:
- Dead end that looked plausible.
- Failed attempt and why it failed.
- Wrong assumption corrected.
- Stale or misleading doc/comment/name.
- Command/tool gotcha and recovery.
- Hidden coupling or side effect.
- Source-of-truth discovery.
- Project mental model worth reusing.

For each learning, use this compact shape:
- Learning: <one compact lesson>
  Evidence: <path, command, error, source, or exact observation>
  Reuse when: <future trigger>

Keep out:
- Generic advice.
- "I read X."
- Obvious facts from the task.
- Lessons unlikely to recur.

Assembly rules:
- Use only these four headings: Result, Output, Evidence, Learnings.
- Omit empty sections except Result.
- Prefer compact bullets.
- Do not include all examples; choose only relevant details.
- Do not narrate every tool call.
- Snippets are optional and should be short.
- If no files changed, say "No changes made" once.
- If validation was not run and that matters, mention it in Result or Evidence.
- If there are risks or open questions, mention them in Result or Output; do not create a separate section.
- Report what changes future decisions, trust, or behavior.`;
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
