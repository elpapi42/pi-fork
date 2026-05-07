# Pi Fork

Cache-friendly fork tool for Pi.

## Installation

Install the extension with Pi:

```bash
pi install git:github.com/elpapi42/pi-fork
```

After installation, start or restart Pi. The extension registers the `fork` tool
for use in your Pi sessions.

## Usage

`pi-fork` provides one tool:

```json
{ "task": "Review the migration and report risks." }
```

The tool starts an isolated child `pi` process with a temporary JSONL snapshot of
the current active session branch. The child receives the requested task as the
final user message. The extension does not modify the system prompt and does not
use agent definition files.

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

For a forked child, the LLM context is roughly:

```text
System:
  Normal Pi system prompt

Messages:
  Current active branch rebuilt from temporary JSONL
  User: You are a fork of the main agent. You have full access to the session context above.
        Complete the task below and nothing beyond it...
        Task:
        <task>
```

This keeps the expensive prefix stable:

```text
normal system prompt + forked session context
```

Only the final task message changes per fork.

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
`PI_OFFLINE` is always forced to `"1"` for fork children and cannot be
overridden by `pi-fork.environment`.

Invalid entries are ignored: non-string values, empty variable names, names
containing `=`, and keys or values containing null bytes. Empty string values are
allowed.

This does not change the parent agent environment, add per-call env config,
isolate children from inherited env, unset inherited variables, or provide secret
masking/auditing.

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
