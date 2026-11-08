# SkillTree autopilot plan (for `/goal`)

This file drives an unattended `/goal` session. Read it, and `docs/PROGRESS.md`, at the start of every
turn. CLAUDE.md, README.md (spec + acceptance criteria) and DESIGN_SYSTEM.md (Quiet Workbench) remain
the source of truth; this file only orders the work and defines how to prove it.

## Per-turn protocol

1. Run `date -u +%FT%TZ`. On the first goal turn, write it to PROGRESS.md as **Start time**. Every turn,
   print `AUTOPILOT elapsed: <h>h<m>m of 3h` computed from that start time.
2. Read PROGRESS.md. Pick the first unchecked item in the work list below.
3. Implement it in small steps. After each meaningful change run `npm run verify:quick`
   (build + unit). Fix failures before moving on.
4. When an item touches UI, extend the preview harness (see below), run `npm run preview`, **Read the
   PNGs**, and fix anything that violates DESIGN_SYSTEM.md.
5. When a phase's items are done, run the full `npm run verify` and the phase's live check.
6. Update PROGRESS.md: tick the item, note decisions and evidence (command + result line). Tick README
   checkboxes only when the evidence exists.
7. End every turn with one status line: `AUTOPILOT: <done this turn>; next: <next item>; verify: <last VERIFY line>`.

Never stop to ask the user. If something is blocked (a permission denial, a rate limit, a missing tool),
try a reasonable alternative. If none works, log it under **Needs user** in PROGRESS.md and continue with the next item.

## Environment facts (checked 2026-11-07)

- macOS, Node 24, npm 11, VS Code 1.141 at `/Applications/Visual Studio Code.app`, Google Chrome available.
- `gh` and `claude` are **not** on PATH. Claude Code's binary ships with the VS Code extension:
  `~/.vscode/extensions/anthropic.claude-code-*/resources/native-binary/claude` (use the newest version).
  Run `<binary> --help` before relying on any flag.
- GitHub API is unauthenticated (60 requests/hour) unless `GITHUB_TOKEN` is set. `raw.githubusercontent.com`
  does not count against that limit. Handle 403/429 with backoff and clear "rate limited" messages.
- Starting local HTTP servers is denied in this environment. Use the file:// preview harness instead.
- `npm run test:integration` opens a real VS Code window, which is expected.

## Verification tools (already in the repo)

| Command | What it proves |
|---|---|
| `npm run verify:quick` | typecheck + bundles + unit tests |
| `npm run verify` | the above + integration tests in real VS Code + VSIX package + screenshots. Ends with `VERIFY PASS …` |
| `npm run preview` | screenshots of the webview with real skills (`--fixtures` for test data) in `out/preview/*.png` |

To add a screen to the preview: put its data into `window.__DATA__` in `scripts/preview/preview.mjs`,
answer its webview messages in `HANDLERS` in `scripts/preview/boot.js`, and add scenarios (dark, light,
hc, narrow) to the `scenarios` list. If Marketplace and Activity open as separate webviews, add an
`entry`/`page` query switch so the harness can render each one.

## Hard constraints

- Do not modify the real `~/.claude/settings*.json`, `~/.claude/skills/`, or anything outside this repo
  except OS temp dirs. Tests and live checks use temp sandboxes and `SKILLTREE_HOME`.
- Do not push, publish, open PRs, create repos or GitHub Pages, or enter credentials.
- Do not execute downloaded skill content, during indexing, previews, tests or installs.
- Do not invent catalog entries, repositories, ratings, download counts, licenses or badges. A seed repo
  is added only after the GitHub API confirms it exists.
- Tracking is opt-in, reversible, nonblocking, and stores no prompt text or code.
- Phase 1 tests must keep passing. Never delete or weaken a test to make it pass.

## Work list

### Phase 2: Marketplace and safe install

- [x] **2.1 Catalog schema.** `src/shared/catalog.ts`: versioned schema (`schemaVersion`, `generatedAt`,
  `source`, `entries[]` with the fields in README "Sample record", plus `files[]` (path, size, sha) and
  `kind: "skill" | "plugin-unsupported"`). Strict validator returning typed errors. Unit tests: valid,
  missing fields, wrong types, bad SHA, `sourceUrl` not pinned to `commitSha`, unknown schemaVersion.
- [x] **2.2 Sample catalog.** `data/catalog.sample.json`, labeled `"source": "sample"`. Every entry must point to a
  real repo/path/commit verified via the API, or be clearly fictional *and* only used in tests (never
  shown as real in the UI).
- [x] **2.3 Indexer.** `scripts/index-skills.ts` + `data/seed-repos.json` (start with `anthropics/skills`
  after verifying it exists, plus at most a few more verified repos) + optional search queries. For
  each repo: resolve the default-branch HEAD commit SHA, list the tree at that SHA, find `SKILL.md`
  files, fetch them raw at the SHA, parse them with `src/core/frontmatter.ts`, read the license from
  the API (or `null`), dedupe by `owner/repo:path`, enforce file-count and size limits, and log skipped
  items with reasons. Write `data/catalog.json`. `npm run index` runs on recorded fixtures (deterministic,
  used in unit tests under `test/fixtures/github/`). **`npm run index:live`** hits GitHub and prints a
  summary plus one full entry.
- [x] **2.4 Workflow.** `.github/workflows/index-skills.yml`: daily cron + `workflow_dispatch`, runs the
  indexer with `GITHUB_TOKEN`, validates, publishes `catalog.json` to GitHub Pages. Add a unit test that
  parses the YAML and checks the triggers and steps. Hosting activates only when the user pushes; record that
  under Needs user. Don't push.
- [x] **2.5 Fetch + cache.** `src/services/catalog.ts`: setting `skilltree.catalogUrl` (default empty → use
  the bundled `data/catalog.json` copied into `dist/`), fetch with a timeout, validate, cache the last good copy in
  `globalStorageUri`, and expose state `{ source: remote|cache|bundled, fetchedAt, error }`. Unit tests for
  timeout, invalid JSON, schema failure falling back to the cache, and cache age.
- [x] **2.6 Marketplace UI.** A full editor panel per DESIGN_SYSTEM "Discover": search, category and sort
  (relevance / recently updated), dense two-column list, each entry showing name, owner/repo, path,
  description, license or "License unknown", updated/indexed dates and install state (Not installed / Installed / Update
  available / Unknown). Catalog freshness and provenance are shown, plus the offline/cache banner. Plugins are labeled "not supported yet".
  Sidebar gets a "Discover" entry. Screenshots in dark, light, hc and narrow are reviewed.
- [x] **2.7 Preview.** Fetch the pinned commit's file list and `SKILL.md` (raw, at the SHA). Show the complete
  Markdown (safe renderer), the file list with sizes, and warnings for scripts, hooks, executables,
  symlinks, oversized or unsupported files. No execution.
- [x] **2.8 Installer.** `src/services/installer.ts`: explicit modal confirmation naming the scope
  (Project / Global) and listing the files; download to a temp dir; validate each path (no absolute paths, no `..`,
  no symlinks, allowed characters, per-file and total size limits, file count limit); `isContained` checks
  against the destination; collision flow (existing folder → cancel or explicit "Replace" with backup);
  cancellation; rollback on any error; write `.skilltree-source.json` (repo, path, commit, indexedAt)
  beside the skill without touching `SKILL.md`; refuse in untrusted workspaces; rescan afterwards and tell the user a new Claude
  Code session or `/reload-skills` may be needed. Unit tests in temp dirs: traversal, absolute paths,
  symlinks, oversized files, collision, rollback, cancellation.
- [x] **2.9 Installed state.** Match local skills to catalog entries by `.skilltree-source.json`
  (exact), not by name. Show "Update available" when the catalog commit differs. The Skill Tree inspector
  shows the source and commit for installed catalog skills.
- [x] **2.10 Integration tests** (exact titles):
  - `marketplace renders the catalog with provenance`
  - `installs a catalog skill into a sandbox project and shows it as installed` (local fixture source, confirmation stubbed through a test-only hook)
  - `refuses to overwrite an existing skill without confirmation`
  - `falls back to the cached catalog when offline`
- [x] **2.11 Live check.** **`npm run e2e:live`** (Phase 2 part): takes one real entry from
  `data/catalog.json`, previews it (prints files + warnings), installs it at its pinned commit into a temp
  sandbox project via the real installer code with confirmation auto-accepted, rescans with the real
  scanner, and prints that the skill is detected and matched as Installed. Then deletes the sandbox.

### Phase 3: Opt-in activity tracking

- [x] **3.1 Confirm hook semantics.** Fetch https://code.claude.com/docs/en/hooks (all pages/offsets).
  Write `docs/HOOKS_NOTES.md` with quoted, dated facts: settings file locations and precedence, `PreToolUse` input
  JSON for the `Skill` tool (field names for the skill name), `UserPromptExpansion` input for typed
  `/skill` commands, `session_id`/`cwd`/`transcript_path` fields, matcher syntax, timeouts, exit-code
  semantics, and how to stay nonblocking. Build only on what is documented.
- [x] **3.2 Event model + parser.** `src/core/activity.ts`: `{ ts, skill, project, sessionId, source:
  "PreToolUse:Skill" | "UserPromptExpansion", cwd }`. No prompt text. Unit tests on documented payload
  fixtures (`test/fixtures/hooks/*.json`), including unknown or missing fields.
- [x] **3.3 Recorder.** A small, dependency-free hook command, copied by the extension to a stable
  location it owns, that appends one JSON line to a local activity log and always exits 0 quickly.
  The extension can locate the log. Unit test: feeding fixtures to the recorder through stdin writes the
  expected lines in a temp dir.
- [x] **3.4 Consent + install/uninstall.** Command "SkillTree: Enable Activity Tracking…": explains exactly what
  is recorded and where, asks for consent and scope (user or project settings), backs up the settings file, merges
  narrowly scoped hook entries (marked so they can be identified), and verifies the JSON. "Disable" removes
  only SkillTree's entries and restores the backup when unchanged. Respect workspace trust. Tests run in temp dirs only.
- [x] **3.5 Activity UI.** Sidebar "Recent activity" (only when enabled) and an Activity timeline panel:
  compact rows (time, project, session id, skill, capture source label), grouped by session, empty and
  disabled states, no invented data. The Skill Tree inspector shows the last observed use when one exists.
  Screenshots reviewed.
- [x] **3.6 Integration tests** (exact titles):
  - `records hook event fixtures and shows them in Activity`
  - `enabling and disabling tracking edits only the sandbox settings and restores the backup`
- [x] **3.7 Live check.** Extend `npm run e2e:live`: if the Claude Code binary is found, create a temp sandbox
  project with a trivial skill and project-level hooks pointing at the recorder, run one short
  `claude -p` session that invokes the skill, and print the recorded event JSON. If no binary is found or the run is
  not permitted, print the reason and treat this step as skipped. Never use the real user settings.

### Wrap-up

- [x] **W.1** README: tick the Phase 2/3 boxes that have evidence. Document commands, settings, privacy, and
  the hosting step that needs the user. Update `docs/EXTENSION_README.md`.
- [x] **W.2** Final `npm run verify`, `npm run index:live`, `npm run e2e:live`, then Read the final screenshots, all in
  the last turn, and write the PROGRESS.md summary with F5 test steps.

Out of scope: Phase 4, landing page, Marketplace publishing.
