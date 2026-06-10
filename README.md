# Pi Fork

Keep your main Pi agent's context window clean while offloading noisy investigation to parallel child agents.

`pi-fork` is a context-management extension first and a parallelism extension second. It lets the current Pi agent expand its work capacity by delegating exploration, review, debugging, planning, and implementation checks to child `pi` processes that inherit the active session branch. They are not independent subagents with separate personas or unrelated context; they start from the same working conversation path, do the noisy work elsewhere, and return dense, decision-useful reports instead of raw search/read/tool noise.

## Installation

Install the extension with Pi:

```bash
pi install git:github.com/elpapi42/pi-fork
```

After installation, start or restart Pi. The extension registers the `fork` tool
for use in your Pi sessions.

## Why use it?

Large agent tasks often spend most of their context on exploration: file reads, dead ends, broad searches, command output, partial hypotheses, and validation attempts. That information matters, but most of it does not belong in the main agent's long-running context window.

Because each child starts from the active session branch, forks can operate with the same working context as the current agent: the same task history, decisions, constraints, and recent findings on that branch. That makes them useful as extensions of the agent's capacity, not detached assistants that need everything re-explained.

`pi-fork` moves that exploratory noise into child sessions and asks them to return four structured sections: `Result`, `Output`, `Evidence`, and `Learnings`. Good fork reports carry actionable conclusions, exact anchors, decisive snippets, validation meaning, ruled-out paths, affected surfaces, material assumptions, and reusable gotchas. This helps the main conversation stay focused while still benefiting from deep, branch-aware investigation.

Use forks when the cost of missing context is higher than the cost of another model call: codebase exploration, debugging, architecture tradeoffs, adversarial review, implementation validation, release/risk checks, or parallel option spikes. For trivial one-line edits, a fork is usually unnecessary.

## Usage

`pi-fork` provides one tool:

```json
{ "task": "Review the migration and report risks." }
```

The tool starts an isolated child `pi` process with a temporary JSONL snapshot of
the current active session branch. The child receives the requested task as the
final user message plus report instructions. The extension does not modify the
system prompt and does not use agent definition files.

The snapshot contains the current active branch, not the entire session tree.
Sibling, abandoned, or unrelated historical branches are not copied. This keeps
forks aligned with the current working path while avoiding unrelated branch
history.

You can optionally request an intelligence budget for a fork:

```json
{ "task": "Review this state machine for races.", "effort": "deep" }
```

Use `fast` for narrow or mechanical work, `balanced` for normal forks, and
`deep` for risky, ambiguous, architectural, security, concurrency, or
review-heavy work.

## Effort Profiles

Add optional effort profiles under `pi-fork` in `~/.pi/agent/settings.json` or
`.pi/settings.json` to map fork effort levels to child Pi model and thinking
settings:

```json
{
  "pi-fork": {
    "defaultEffort": "balanced",
    "effortProfiles": {
      "fast": {
        "provider": "openai-codex",
        "id": "gpt-5-mini",
        "thinking": "minimal"
      },
      "balanced": {
        "provider": "openai-codex",
        "id": "gpt-5.5",
        "thinking": "medium"
      },
      "deep": {
        "provider": "openai-codex",
        "id": "gpt-5.5",
        "thinking": "high"
      }
    }
  }
}
```

Each profile must be a complete `{ "provider", "id", "thinking" }` object.
Valid thinking values are `off`, `minimal`, `low`, `medium`, `high`, and
`xhigh`. Invalid or incomplete profiles are ignored.

If a fork requests an effort with a valid profile, the child Pi process is
started with `--provider`, `--model`, and `--thinking` for that profile. If the
requested or default effort has no valid profile, `pi-fork` does not inject model
or thinking flags; the child uses Pi's normal restored session/default model and
thinking behavior, and the fork result includes a warning.

If no `defaultEffort` or effort profile is configured, fork model and thinking
behavior is unchanged.

## Context Shape

For a child process, the LLM context is roughly:

```text
System:
  Normal Pi system prompt

Messages:
  Current active branch rebuilt from temporary JSONL
  User: <task>

        After completing this task, write a decision-useful report.
        ...
        ## Result
        ## Output
        ## Evidence
        ## Learnings
```

The extension does not add identity framing such as "main agent" or "parent agent".
The appended reporting instructions are written as user preferences: useful reporting,
not a short summary. Reports always use the same four headings, but each section
can grow or shrink to fit the task. The instructions favor dense actionable
substance, concrete evidence anchors, decisive snippets, validation meaning,
ruled-out paths, affected surfaces, material assumptions, and reusable learnings
that prevent repeated work.

This keeps the expensive prefix stable:

```text
normal system prompt + child session context
```

Only the final task message changes per child process.

## Recursive Forks

Add optional config under `pi-fork` in `~/.pi/agent/settings.json` or
`.pi/settings.json` to control child extension loading:

```json
{
  "pi-fork": {
    "extensions": null
  }
}
```

`extensions` is tri-state:

- `null` or omitted: load normal Pi extensions from settings and auto-discovery.
- `[]`: load no extensions in fork children.
- non-empty array: load only those extension sources in fork children.

Example:

```json
{
  "pi-fork": {
    "extensions": ["npm:pi-claude-bridge"]
  }
}
```

Local extension paths are resolved relative to the settings file directory:
`~/.pi/agent` for global settings and `.pi` for project settings.

Fork children run offline by default. Set `offline` to `false` when you want
explicit `npm:` or `git:` extension sources to use Pi's normal temporary
`--extension` package installer/cache:

```json
{
  "pi-fork": {
    "offline": false,
    "extensions": ["git:github.com/example/fork-only-extension"]
  }
}
```

The first run may need network access and can be slower while Pi installs or
clones the package under `/tmp/pi-extensions`. Later runs may reuse that cache,
though the OS or user can remove it, and unpinned git sources may refresh.

If `pi-fork` itself is listed in `pi-fork.extensions`, child processes will load
the `fork` tool too.

## Fork Environment

Add optional environment variables under `pi-fork.environment` in
`~/.pi/agent/settings.json` or `.pi/settings.json`:

```json
{
  "pi-fork": {
    "environment": {
      "MY_EXTENSION_MODE": "fork",
      "SERVICE_BASE_URL": "https://example.test"
    }
  }
}
```

Fork children still inherit the parent Pi process environment. The resolved
`environment` map is overlaid on top, so configured variables add or override
child env vars while omitted variables continue to inherit normally. Project
settings override global settings; on Windows, that override is case-insensitive.

`offline` defaults to `true`, which forces `PI_OFFLINE=1` for fork children and
prevents child package/network startup work. Set `offline` to `false` to remove
inherited or configured `PI_OFFLINE` from the child environment and allow Pi's
normal online startup behavior. The explicit `offline` setting is applied after
`pi-fork.environment`, so `pi-fork.environment.PI_OFFLINE` does not override it.

Invalid entries are ignored: non-string values, empty variable names, names
containing `=`, and keys or values containing null bytes. Empty string values are
allowed.

This does not change the parent agent environment, add per-call env config,
isolate children from inherited env, unset inherited variables, or provide secret
masking/auditing.

## Rate-Limit Recovery

Fork children rely on Pi's normal auto-retry for provider errors, including
rate limits. Pi's default retry budget (3 attempts at 2s/4s/8s backoff) is
often shorter than real rate-limit windows. Increase it in
`~/.pi/agent/settings.json` or `.pi/settings.json` so fork children wait long
enough:

```json
{
  "retry": {
    "maxRetries": 6,
    "baseDelayMs": 5000
  }
}
```

When a child Pi declares an upcoming auto-retry (`agent_end` with
`willRetry: true`), `pi-fork` keeps the child alive and waits for the retry
instead of terminating it. When the child declares no retry will happen,
`pi-fork` finishes promptly. Older Pi versions without the `willRetry` flag
fall back to a short retry-decision wait.

Terminal quota and billing errors (for example `insufficient_quota`) are
intentionally not retried by Pi and still fail the fork.

## Fork Cost Footer

By default, `pi-fork` adds an extra dimmed footer status line with fork cost:

```text
forks +$0.123
```

The fork cost comes from completed fork tool results, including forks spawned by
forks. Disable the extra footer line with:

```json
{
  "pi-fork": {
    "costFooter": false
  }
}
```

## Manual Check

From this directory:

```bash
pi -e .
```

Then ask Pi to use the `fork` tool with a task.
