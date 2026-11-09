# Claude Code hook facts used by SkillTree activity tracking

Source: https://code.claude.com/docs/en/hooks (read 2026-11-07). Quotes are verbatim; anything not
documented is marked **unverified** and handled defensively.

## Where hooks live

| Location | Scope |
|---|---|
| `~/.claude/settings.json` | All your projects |
| `.claude/settings.json` | Single project (committable) |
| `.claude/settings.local.json` | Single project, not committed |
| Managed policy settings | Organization-wide |

> "Hook entries merge across settings levels rather than replacing each other."
> "If you define the same handler in more than one settings file, it runs once."
> "Direct edits to hooks in settings files are normally picked up automatically by the file watcher."

Structure: `hooks → <EventName>[] → { matcher, hooks: [{ type: "command", command, args?, timeout?, async? }] }`.
Exec form (`command` + `args` array) is documented ("In exec form, use `${CLAUDE_PROJECT_DIR}` and the path needs no quoting").

## Events SkillTree uses

### `PreToolUse` with matcher `Skill`
- Common input: `session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name` (+ `prompt_id`, `agent_id`, `agent_type` in some cases).
- Event input: "`tool_name`, `tool_input`, and `tool_use_id` fields are event-specific."
- Matcher: "Only letters, digits, `_`, `-`, spaces, `,`, and `|`" means exact match, so `Skill` matches only the Skill tool.
- **Unverified:** the hooks reference does not document `tool_input` for `Skill`. The Skill tool's parameter
  schema in Claude Code is `{ skill: string, args?: string }`, so SkillTree reads `tool_input.skill`, falls back to
  `command`/`name`, and records `skill: null` plus the input *key names* when none is present. The live
  sandbox run (`npm run e2e:live`) records the real payload's key names to confirm.

### `UserPromptExpansion`
> "This event covers the path `PreToolUse` doesn't: a `PreToolUse` hook matching the `Skill` tool fires only when
> Claude calls the tool, but typing `/skillname` directly bypasses `PreToolUse`. `UserPromptExpansion` fires on that direct path."

> "UserPromptExpansion hooks receive `expansion_type`, `command_name`, `command_args`, `command_source`, and the
> original `prompt` string. The `expansion_type` field is `slash_command` for skill and custom commands, or `mcp_prompt` for MCP server prompts."

Matcher: "Matches on `command_name`. Leave the matcher empty to fire on every prompt-type command."

## Staying non-blocking

- Exit codes: 0 = success; **2 = blocking** ("On events that can block, Claude Code stops the action"; on
  UserPromptExpansion it blocks the expansion); any other code = non-blocking error, "The action goes ahead".
- stdout: for `UserPromptExpansion`, "Claude Code adds plain-text stdout as context that Claude can see". **The recorder prints nothing.**
- Default timeout for command hooks is 600 s, so SkillTree sets `timeout: 10`.
- `"async": true` runs a command hook in the background; "Async hooks can't block or control Claude's behavior".
  In `-p` mode Claude Code "kills any async hook still running at teardown". SkillTree's recorder appends
  one line and exits in milliseconds (measured 10–20 ms). It originally ran `async: true`; live `-p` tests showed
  short sessions sometimes ended before the event was written, so since 2026-11-08 it runs synchronously
  (timeout 5 s, always exit 0): about 15 ms per skill use, and no lost events.
- "When an event fires, its matching hooks run in parallel." The recorder uses a single `appendFile` per event.

## What SkillTree records (and does not)

Recorded per event: timestamp, skill/command name, capture source (`PreToolUse:Skill` or `UserPromptExpansion`),
`session_id`, `cwd`, `CLAUDE_PROJECT_DIR`, `command_source`, whether arguments were present (boolean), and inside a
subagent `agent_id`/`agent_type`. A `SessionEnd` line records only `session_id` and the time.
**Not recorded:** `prompt`, `command_args`, `tool_input.args`, transcript paths or contents.

## Subagents, background agents and session ends (checked 2026-11-08)

Real `claude -p` runs (haiku) in a temp project, with a probe hook that logged event names, ids and input key names only:

- A skill invoked inside a subagent fires the same `PreToolUse` (matcher `Skill`) with two extra common fields,
  `agent_id` (e.g. `a53be242a859492a6`) and `agent_type` (`general-purpose`); `session_id` is the **parent** session's.
  The docs say the same applies to in-process agent-team teammates.
- `SubagentStart` and `SubagentStop` carry `session_id`, `agent_id` and `agent_type` (SkillTree does not hook them).
- When the subagent ran in the background and reported back, `UserPromptSubmit` fired again with the same fields
  as a typed prompt; the prompt was a single `<task-notification>…</task-notification>` element. SkillTree's
  suggestion hook ignores prompts that are one such element.
- `SessionEnd` fired when the `-p` session exited, with `session_id`, `cwd`, `prompt_id`, `reason` (`"other"`),
  `scratchpad_dir` and `transcript_path`. SkillTree keeps only `session_id` and the time.

