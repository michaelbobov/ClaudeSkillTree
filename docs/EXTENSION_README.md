# SkillTree

See, organize and open your Claude Code skills from inside VS Code.

SkillTree reads real `SKILL.md` files on your machine and shows them as a compact sidebar list and a
pan-and-zoom **Skill Tree** graph (Workspace → Category → Skill). It works offline and does not need
Claude Code to be running.

## Where it looks

| Source | Location | Editable |
|---|---|---|
| Project | `<workspace folder>/.claude/skills/<name>/SKILL.md` | yes |
| Nested | `<workspace folder>/<subdir>/.claude/skills/<name>/SKILL.md` | yes |
| Personal | `~/.claude/skills/<name>/SKILL.md` | yes |
| Synced from claude.ai | `~/.claude/skills/synced/…/<name>/SKILL.md` | read-only |
| Managed (enterprise) | managed settings directory `/.claude/skills` | read-only |

When names collide, SkillTree marks the skill Claude Code will not run (managed > personal > project).

## Using it

- Click the **SkillTree** icon in the Activity Bar. Click a skill to open its `SKILL.md`.
- **Open Skill Tree** (graph icon in the view title, or `SkillTree: Open Skill Tree`) opens the graph.
  Select a node for details; double-click or press Enter to open the file. Arrow keys move between skills.
- Search, filter by source or category, switch to the list view, collapse categories and drag nodes.

## Organization is stored separately

Categories you choose and node positions are stored in VS Code's extension storage.
SkillTree never edits your `SKILL.md` files. Categories it assigns automatically are labeled "auto".
Graph edges show organization only, not dependencies or usage.

## Marketplace

**SkillTree: Open Marketplace** lists skills indexed from public GitHub repositories, each pinned to a
commit. Preview the complete `SKILL.md` and file list, then install to the project (`.claude/skills/`) or
globally (`~/.claude/skills/`) after confirming. Downloads are verified against the pinned commit, nothing
is overwritten without a second confirmation, and failures roll back. Indexed skills are not reviewed for
security, quality or licensing. Set `skilltree.catalogUrl` to use a hosted catalog; otherwise the bundled
snapshot is used and works offline.

## Activity (opt-in)

**SkillTree: Enable Activity Tracking…** adds two background Claude Code hooks (after a backup and your
consent) that record time, skill name, capture source, session id and working directory to
`~/.claude/skilltree/activity.jsonl`. Prompt text and arguments are never recorded. **Disable** restores
your settings.

## Privacy

SkillTree runs no scripts from skill folders. Network access is limited to the marketplace: fetching the
configured catalog URL and, when you preview or install, files from `raw.githubusercontent.com` at a pinned
commit. Activity data stays on your machine.
