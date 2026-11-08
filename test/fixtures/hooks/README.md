Hook payload fixtures for SkillTree's activity parser.

- `user-prompt-expansion.json` is the example payload from https://code.claude.com/docs/en/hooks (UserPromptExpansion input), unchanged.
- `pre-tool-use-skill.json` uses the documented common fields and PreToolUse fields (`tool_name`, `tool_input`, `tool_use_id`).
  The hooks reference does not document `tool_input` for the Skill tool; `{ "skill", "args" }` follows the Skill tool's
  parameter schema. `npm run e2e:live` confirms the key names against a real Claude Code session when possible.
- The other files cover events SkillTree must ignore or tolerate.
