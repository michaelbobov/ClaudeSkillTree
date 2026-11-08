# SkillTree — Visual Skill Manager for Claude Code

> **Project status:** Phases 1–3 (local skill tree, marketplace with safe install, opt-in activity tracking) are implemented; see [Development](#development). The hosted catalog goes live once the repository is pushed and GitHub Pages is enabled. Phase 4 items are still requirements, not claims that they are implemented.

SkillTree is a **VS Code extension**, not a web app, that makes Claude Code skills easier to discover, organize, install, and understand. Think of a skill tree from a game, but for AI-assisted development: see skills you have, how they relate to your workflow, which ones Claude has invoked, and what work was happening when they were used.

A separate landing page can eventually link to the published VS Code extension, but **the product lives inside the editor**. Build for desktop VS Code first; consider compatible VS Code forks later. **Do not promise Xcode support in the MVP.**

## The product in one sentence

**Explore and manage Claude skills visually, install community skills from GitHub, and see which skills were used during real development sessions.**

## Target users

Developers and designers using Claude Code in VS Code who want to manage skills without hunting through GitHub repositories and Markdown files.

## Product principles

- **IDE-native:** All core interactions happen within VS Code, not an external dashboard.
- **Real data first:** Read actual local skills and real catalog entries. Use demo data only when clearly labeled as demo.
- **Visual but practical:** The graph should be engaging without hiding essential actions, search, keyboard access, or textual details.
- **Traceable, not magical:** Show verified skill invocations separately from inferred relationships to files and commits.
- **Private by default:** Keep local session metadata local. Do not upload conversation transcripts or project code.
- **Safe installation:** Treat public GitHub content as untrusted. Review before installing; never execute it during discovery.

## Core experiences

### 1. My Skills — interactive skill tree

Open SkillTree from its VS Code Activity Bar icon. A compact sidebar lists installed skills and a command opens the **full Skill Tree** in an editor tab.

The full tree is a pan-and-zoom node graph with these concepts:

- Root: active workspace/project (with an option to view global skills).
- Categories: Design, Frontend, Backend, Testing, Debugging, Automation, Documentation, Other.
- Skill nodes: installed skills with name, short description, scope (project/global), source, and last-used indicator.
- Edges: organizational connections **chosen by the user** or suggestions. They are not proof of usage.
- Node click: detail drawer with skill Markdown preview, source URL, folder location, open-file action, usage history, and uninstall (where permitted).
- Search, category filters, installed/uninstalled filter, fit-to-view, expand/collapse, and keyboard-accessible list alternative.
- Let users reorder/categorize skills; persist UI organization separately from `SKILL.md` so their skill instructions are not modified accidentally.

A future **Activity mode** overlays co-usage relationships from actual Claude sessions, separately labeled from the manually organized skill tree.

### 2. Discover — visual skill marketplace

A **Marketplace** tab displays cards instead of plain GitHub search results. Each card includes:

- Name, description, author, category, GitHub repository and exact skill directory.
- Source link, license when determinable, repository last update, and index timestamp.
- Installation state: Not installed / Installed / Update available / Unknown.
- Buttons: **Preview**, **View on GitHub**, **Install to Project**, **Install Globally**.
- Search, categories, sort by relevance / recently updated, and filters.

The **Preview** dialog must show the complete `SKILL.md` and a list of supporting files to be installed; warn about scripts, hooks, or unexpected executable content. Do **not** execute skill scripts when browsing or installing.

### 3. Activity — skill usage history

Keep usage attached to **sessions/tasks first**; do not force every skill into a Git commit.

Example:

```text
Project: Portfolio
  Session: Build responsive navigation
    Skills invoked: frontend-design, accessibility
    Related files: src/Nav.tsx, src/styles.css (inferred or observed)
    Commit: a84f2c1 (optional Git association)
```

Use Claude Code's current documented hook events, with user opt-in:

- `PreToolUse` matcher for `Skill` to observe Claude-initiated skill tool calls.
- `UserPromptExpansion` to observe directly typed `/skill-name` invocations that bypass `PreToolUse`.
- Other events only if helpful and documented at implementation time.

A usage record should include a timestamp, skill ID/name, project/workspace, session ID, invocation source, and optional verified context. **Do not store full prompt contents by default.** Treat attribution to file edits or commits as a separate, optional phase with confidence labels; never claim a commit was "created by" a skill based merely on timing.

## Skill discovery and local scopes

Support local Claude Code skills using documented paths:

- Project: `<workspace>/.claude/skills/<skill-name>/SKILL.md`
- Personal/global: `~/.claude/skills/<skill-name>/SKILL.md`

Parse YAML frontmatter safely (e.g. `name`, `description`, compatibility metadata where present). Preserve raw Markdown. Handle missing frontmatter, duplicate names, nested skill directories where feasible, unreadable files, and invalid YAML without crashing.

**Do not edit or delete cloud-synced or managed skills.** Distinguish project and personal installs from plugin-managed, synced, bundled, or read-only sources. For MVP, only install/remove standard project or personal filesystem skills.

## Automatic GitHub marketplace catalog

**Build a lightweight catalog pipeline; don't perform global GitHub searches from each user's extension.**

1. Maintain a small **seed list** of trusted/curated public GitHub skill repositories and GitHub repository-search queries for broader discovery.
2. Run an indexing script on a scheduled **GitHub Actions workflow** (e.g. once daily), also triggerable manually.
3. For discovered candidate repositories, inspect repository trees for `SKILL.md` files, fetch and parse their metadata, and validate that a skill directory exists.
4. Normalize and deduplicate records using `owner/repo + directory path` (and track commit SHA or reference).
5. Skip invalid/inaccessible/oversized paths; handle API limits, pagination, and transient errors. Log skipped reasons.
6. Publish a versioned static `catalog.json` artifact (e.g., a GitHub Pages-hosted URL). **No custom production database or API server is required for the MVP.**
7. The VS Code extension fetches this JSON with a timeout, validates the schema, caches the last successful copy locally, and offers a clear offline/error state.

Sample record (**schema can evolve**):

```json
{
  "id": "owner/repo:path/to/skill",
  "name": "Example Skill",
  "description": "Short explanation of when this skill helps",
  "category": "Frontend",
  "owner": "owner",
  "repo": "repo",
  "path": "path/to/skill",
  "sourceUrl": "https://github.com/owner/repo/tree/COMMIT_SHA/path/to/skill",
  "commitSha": "COMMIT_SHA",
  "license": "MIT",
  "updatedAt": "2026-11-07T00:00:00Z",
  "indexedAt": "2026-11-07T00:00:00Z"
}
```

**Important:** A repository being indexed does not mean its skill is secure, reviewed, high quality, or correctly licensed. Label provenance accurately. Don't invent install counts, ratings, verification badges, or reviews.

## Installing a skill from GitHub

For a chosen catalog entry:

1. Fetch the **specific pinned commit** (not an unbounded moving default branch) and identify the selected skill directory.
2. Show an installation preview: exact files, metadata, source, license if known, and any executable scripts or hooks.
3. Ask the user to choose **Project** or **Global** install scope and confirm.
4. Validate the download: file limits, supported paths, blocked path traversal, symlink handling, and no writes outside the chosen destination.
5. Copy the skill folder, including necessary supporting files, into `.claude/skills/<name>/` or `~/.claude/skills/<name>/`.
6. Never overwrite an existing skill without an explicit conflict/update flow; support cancel and safe rollback on error.
7. Refresh My Skills immediately and display installed source/version information.

Users should be informed that a new Claude Code session may be necessary for the installed skill to appear. Never automatically run a downloaded script or inject a marketplace skill into Claude prompts.

For MVP, support **standard `SKILL.md`-based skills** only. Full Claude Code plugins (agents, MCP servers, hooks, extra dependencies) are a different install mechanism and should be marked "not supported yet" rather than silently copied as if they were plain skills.

## Visual direction — **Quiet Workbench** (selected)

SkillTree should look like a credible IDE tool, not a cinematic AI dashboard. A restrained VS Code-native visual system: 1px borders, compact graph nodes, muted connectors, native fonts, simple small category markers, and a functional details inspector. Follow [`DESIGN_SYSTEM.md`](./DESIGN_SYSTEM.md) as the visual source of truth.

- **No:** gradient glows, neon borders, gaming UI, large pill cards, decorative particles, fabricated usage metrics, or AI-generated-looking visual flourishes.
- **Yes:** readable graph, accurate status, dark/light theme support, crisp typography, keyboard navigation, quick previews, clear installation states and real data.
- **Graph is a tool:** show organizational structure by default; only show recorded co-usage with explicit Activity labeling.
- **Webview stays in the IDE:** full editor tab for tree and marketplace, Activity Bar and compact native sidebar for navigation.

## Proposed stack

| Layer | Technology |
|---|---|
| IDE integration | VS Code Extension API + TypeScript |
| Interactive interface | React + Vite bundled into VS Code webviews |
| Graph | `@xyflow/react` (React Flow), if compatible with webview packaging |
| Styling | CSS with VS Code theme variables (optional Tailwind if bundled locally) |
| Local skills | Node filesystem APIs in the extension host, with workspace-scoped operations |
| Frontmatter | `gray-matter` or equivalent YAML parser |
| Marketplace catalog | GitHub Actions + GitHub API + static versioned JSON |
| Local state | VS Code `globalState` / `workspaceState` and `globalStorageUri` as appropriate |
| Activity | Claude Code hooks with explicit consent; minimal structured local records |
| Tests | TypeScript unit tests plus VS Code extension integration tests |

No iframe of a hosted website: webview assets should be locally bundled. Communicate via typed webview ↔ extension-host messages. Use a Content Security Policy, nonces, and safe Markdown rendering.

## Suggested repository structure

```text
skilltree/
├── README.md
├── CLAUDE.md
├── package.json                 # VS Code extension manifest and scripts
├── src/
│   ├── extension.ts             # Extension activation / commands
│   ├── services/
│   │   ├── localSkills.ts       # Scan local skill directories
│   │   ├── catalog.ts           # Fetch/cache/validate catalog
│   │   ├── installer.ts         # Safe, user-confirmed install
│   │   └── activity.ts          # Opt-in usage tracking (later)
│   ├── views/                   # View and webview providers
│   └── types/
├── webview/
│   ├── src/
│   │   ├── App.tsx
│   │   ├── components/
│   │   ├── pages/               # Tree, Marketplace, Activity
│   │   └── vscodeBridge.ts
│   └── index.html
├── scripts/
│   └── index-skills.ts          # GitHub catalog indexer
├── data/
│   ├── seed-repos.json
│   └── catalog.sample.json
├── .github/workflows/
│   └── index-skills.yml
├── test/
└── .vscode/
    └── launch.json
```

Structure is a proposal; prioritize functional integration over rigid folder naming.

## Build phases and acceptance criteria

### Phase 1 — Real extension and local skill tree (FIRST)

- [x] VS Code extension scaffolds, compiles, and launches with **F5** in an Extension Development Host.
- [x] Activity Bar icon, "SkillTree: Open Skill Tree" command, compact local skills sidebar, and full interactive graph.
- [x] Scan real project and personal `SKILL.md` files; show empty state when none exist.
- [x] Search/filter, skill details, open actual `SKILL.md`, and persist category/position preferences.
- [x] Test data scanning and parsing, including missing/malformed metadata.
- [x] README has exact commands to run/test/package extension.

**Done when:** A local skill added to `.claude/skills/example/SKILL.md` appears in SkillTree after refresh, and clicking it opens its real file.

### Phase 2 — Functional marketplace and install flow

- [x] Build a small sample catalog to make UI/test development deterministic.
- [x] Add GitHub indexing script + scheduled Actions workflow + hosted catalog JSON. *(The workflow publishes `catalog-v1.json` to GitHub Pages; hosting activates when the repository is pushed. Until then the extension uses the bundled snapshot.)*
- [x] Marketplace supports search/categories/details, reliable fetch/cache/offline state.
- [x] Preview a real GitHub skill; install with user confirmation to project/global scope.
- [x] Handle collision/update cases and unsafe paths; test installation into temporary directories.

**Done when:** A real catalog entry can be previewed, installed to a sandbox project, detected locally, and shown as installed in the UI without manual copying.

### Phase 3 — Real skill usage tracking

- [x] Ask users to opt into local Claude activity tracking.
- [x] Install/uninstall nonblocking, narrowly scoped hook configuration with backup/restore and clear consent.
- [x] Capture both Claude-invoked `Skill` tool events and direct `/skill-name` expansion events when available.
- [x] Timeline groups events by project/session/skill; supports unknown/missing metadata gracefully.
- [x] Add test fixtures for hook events; never store complete chats by default. *(A live `claude -p` check is in `npm run e2e:live`; by default it runs Claude Code with an isolated config and is skipped when that has no login. `SKILLTREE_E2E_REAL_CLAUDE=1 npm run e2e:live` uses your login; run on 2026-11-08 it recorded both a `UserPromptExpansion` and a `PreToolUse:Skill` event.)*

**Done when:** Invoking a known skill in a test Claude session produces a local event that appears in Activity, labeled with its capture source.

### Phase 4 — Discovery, recommendations and navigation (done)

- [x] Catalog grows on its own: seed repositories plus GitHub topic searches for popular (by stars) and new (created in the last 30 days) repositories; identical copies and per-agent mirrors are de-duplicated. *(1,230 skills from 20 repositories in the bundled snapshot.)*
- [x] Real repository stars from the GitHub API, labeled as whole-repository stars with a date; sort by stars.
- [x] Large skills install (up to 2,000 files / 50 MB) with a "Large skill" warning and parallel, hash-checked downloads. *(taste-skill: 1,631 files in 36 s.)*
- [x] Usage visible without opening anything: status bar item (skill count, or the last recorded skill) and an Activity Bar badge; counts, last use, "Last used / Most used" sorting and dashed same-session edges in the Skill Tree.
- [x] Claude suggests skills (opt-in): an MCP server lets Claude search the catalog and ask to install; a prompt hook suggests matching skills in a VS Code notification. Every install is confirmed by the user. *(Live: `npm run e2e:vscode`.)*
- [x] Navigation that follows VS Code's UX guidelines: one data-only sidebar view with title actions, a status bar item on the left that opens the SkillTree menu, section tabs inside the editors, and a Get Started walkthrough.

### Phase 5 — Usage-driven recommendations and organization (next)

Use the opt-in usage data SkillTree records, and make organizing many skills easy. Nothing here is inferred from a skill merely being installed.

- [x] **Unused skills:** after at least 7 days of tracking, installed skills with no recorded use are marked "unused" in the Skill Tree and list when sorting by use, counted in the Skill Tree status bar, and explained in the details panel with a Reveal link to remove the folder yourself (SkillTree never deletes skills). *(A "keep, don't flag again" choice is not built yet.)*
- [x] **For you:** the Marketplace suggests catalog skills from what you actually use: other skills from the repositories your used skills come from (favouring the categories you use from them), then the best-starred skills in the category you use most. Every suggestion shows its reason; installs still go through the confirmation dialog. Local skills are tied to catalog entries by SkillTree's install record, an identical SKILL.md, or a name only one catalog skill has.
- [ ] **Better automatic categories:** fewer skills in "Other" (about half of the catalog today), using the skill's repository and folder as well as its name and description; still labeled "auto" until you choose.
- [ ] **Your own groups:** collections you name yourself (for example "client work" or "writing"), alongside the built-in categories, stored outside SKILL.md.
- [ ] **Organize in bulk:** select several skills in the Skill Tree or list view and move them to a category or group at once; drag a skill onto another category in the graph.
- [ ] **Add any GitHub repository:** "Add from GitHub…" in the Marketplace indexes a repository on demand (no backend; three GitHub API calls) and lists its skills.
- [ ] **This-session installs:** install a skill only for the current Claude Code session and remove it when the session ends.
- [ ] **Hosted catalog live:** push the repository and enable GitHub Pages so the daily index reaches everyone (needs the repository owner).

### Phase 6 — Later (optional)

- [ ] Associate nearby Git changes/commits to sessions with clearly labeled inference.
- [ ] Support additional editors and Claude plugin installation.
- [ ] Build standalone marketing site and polished screenshots.

## Development

Prerequisites: Node.js 20+ (developed on 24), npm, desktop VS Code 1.95+, and optionally Claude Code for testing activity capture.

```bash
npm install
npm run dev                # build, then open an Extension Development Host on the sample project (no F5 needed)
npm run build              # typecheck + bundle extension, recorder hook and webview; copies data/catalog.json to dist/
npm test                   # unit tests (vitest)
npm run test:integration   # launches a real VS Code with the extension and sandboxed fixtures (mocha)
npm run package            # builds and writes skilltree-<version>.vsix
npm run verify             # all of the above + screenshots; ends with "VERIFY PASS …" or "VERIFY FAIL at <step>"
npm run verify:quick       # build + unit tests only
npm run preview            # screenshots of every webview (dark, light, high contrast, narrow) in out/preview/
npm run index              # rebuild a catalog from recorded test fixtures (offline, deterministic)
npm run index:live         # index GitHub (seed: data/seed-repos.json) into data/catalog.json; GITHUB_TOKEN optional
npm run validate:catalog   # schema-check data/catalog.json
npm run e2e:live           # network: preview + install a real catalog entry into a temp sandbox; sandboxed Claude Code hook check
npm run e2e:vscode         # real VS Code + real Claude Code (your login, haiku): enable tracking, use a skill, see it in Recent Activity / Activity / Skill Tree, disable
```

**Run it:** `npm run dev`, or open this folder in VS Code and press **F5** (**fn+F5** on a Mac keyboard). Two launch configurations are provided:

- **Run SkillTree** opens an Extension Development Host with your own skills (`~/.claude/skills`, synced claude.ai skills, and the project skills of whatever folder you open).
- **Run SkillTree (sample project)** also opens `test/fixtures/workspace`, which contains `.claude/skills/example/SKILL.md`.

Both run `npm run build` first. In the host window click the **SkillTree** icon in the Activity Bar, then the graph icon in the view title (or run **SkillTree: Open Skill Tree**).

**Install the VSIX:** `npm run package`, then in VS Code run **Extensions: Install from VSIX…** and pick `skilltree-0.1.0.vsix` (or `code --install-extension ./skilltree-0.1.0.vsix` if the `code` CLI is on your PATH).

### What Phase 1 does

- **Discovery** (offline, read-only): `<folder>/.claude/skills/*/SKILL.md` (project), `<folder>/**/.claude/skills/*/SKILL.md` (nested, shown with the `/subdir:name` command Claude Code uses), `~/.claude/skills/*/SKILL.md` (personal), `~/.claude/skills/synced/<bucket>/*/SKILL.md` (claude.ai synced, read-only), and the enterprise managed directory (read-only). Dot folders such as `.trash` and `.staging` are ignored. Files and folders are re-scanned automatically when they change.
- **Parsing** follows the Claude Code skills docs: frontmatter must start on line 1, `name` defaults to the folder name, a missing `description` falls back to the first body line, and unknown fields are kept for display. Invalid YAML, unterminated frontmatter, oversized files (>1 MB), broken symlinks, and names Claude Code refuses are reported as issues instead of crashing the scan.
- **Collisions:** skills sharing a name are linked; a project skill shadowed by a personal (or managed) one is marked, matching Claude Code's precedence (managed > personal > project). The same `SKILL.md` reached through a symlink is listed once.
- **Sidebar:** skills grouped by source with true counts; click opens `SKILL.md`; context menu offers Show in Skill Tree, Reveal, Set Category, Copy Path.
- **Skill Tree editor:** Workspace → Category → Skill graph with solid 1px organization edges and a legend, hover/selection path highlight, collapse/expand categories, drag to rearrange (dragging a category moves its column), zoom/fit/reset layout, search, source and category filters, a keyboard-navigable list view, and an inspector (scope, path, command, description, frontmatter, files with scripts flagged, issues, a Markdown preview with raw HTML escaped).
- **Organization metadata** (categories, positions, collapsed state) is stored in VS Code extension storage, never in `SKILL.md`. Categories that SkillTree guesses from keywords are labeled as automatic until you choose one.
- **Safety:** the webview has a nonce-based CSP, no network or filesystem access, and validated message types; links from skill Markdown open only if they are http(s)/mailto or stay inside the skill folder. *Create Project Skill* refuses to overwrite and is disabled in untrusted workspaces.

### What Phase 2 does (Marketplace)

- **Catalog pipeline:** `scripts/index-skills.ts` reads seed repositories (and, in CI, repository search), resolves each default branch to a **commit SHA**, lists the tree at that commit, parses every `SKILL.md`, records file sizes and git blob hashes, flags scripts/executables/symlinks/hooks/pre-approved tools, and skips oversized or unsafe paths with a logged reason. Output is a versioned, schema-validated `catalog.json` (`src/shared/catalog.ts`). `.github/workflows/index-skills.yml` runs it daily and publishes to GitHub Pages.
- **Loading:** setting `skilltree.catalogUrl` (HTTPS) → last good cached copy → the snapshot bundled with the extension. The banner always says which one you are looking at, when it was indexed, and why a fetch failed.
- **Marketplace tab** (Discover → Browse, or **SkillTree: Open Marketplace**): search, category, install-state and sort filters; dense cards with repository, path, license (or "License unknown"), update date and install state (Not installed / Installed / Update available / Unknown). No ratings or download counts exist, so none are shown.
- **Preview:** the full `SKILL.md` fetched at the pinned commit and checked against its git blob hash, the complete file list, and warnings. Links in previews are disabled.
- **Install:** explicit modal confirmation (scope, destination, files, warnings) → download to a hidden staging folder → every file verified against the pinned commit's blob hash → one atomic rename. Never overwrites: an existing folder needs a second, explicit "Replace" and is moved to a hidden backup. Cancel and any error roll back. Symlinks/submodules are never installed and executable bits are dropped. Provenance is written to `.skilltree-source.json` next to the skill (not into `SKILL.md`), which is how SkillTree knows a skill is "Installed" or has an update.

### What Phase 3 does (opt-in activity)

- **SkillTree: Enable Activity Tracking…** explains exactly what is recorded and asks you to choose user settings (`~/.claude/settings.json`) or this project (`.claude/settings.local.json`). It backs up the file, then adds two background (`async`) hooks: `PreToolUse` with matcher `Skill` and `UserPromptExpansion` (typed `/commands`). Semantics are documented in [`docs/HOOKS_NOTES.md`](docs/HOOKS_NOTES.md).
- The hook runs a dependency-free recorder (`~/.claude/skilltree/record-skill-event.mjs`) that appends **time, skill name, capture source, session id and working directory** to `~/.claude/skilltree/activity.jsonl`, prints nothing and always exits 0. Prompt text, arguments and transcripts are never stored.
- **Disable** restores the original settings file byte-for-byte if nothing else changed it, otherwise removes only SkillTree's two handlers. The log stays until you delete it from the Activity tab.
- **Activity tab** and **Recent Activity** sidebar: events grouped by session and project, labeled "Claude invoked (Skill tool)" or "Typed /command", with unknown fields shown as unknown. The Skill Tree inspector shows the last observed use. Listing an event is not a claim that the skill caused any change.

Before publishing publicly, create a VS Code Marketplace publisher ID and set `publisher` in `package.json` (currently the placeholder `skilltree-local`), add a `repository` URL and a license. Publishing and obtaining credentials require the developer's own account/approval.

## Landing page (after extension works)

A small website can show screenshots and an **Install in VS Code** button that links to:

```text
vscode:extension/<publisher-id>.skilltree
```

Also link directly to the Marketplace listing as a browser-compatible fallback. The button opens the user's editor install flow; it cannot silently install software. Until the extension is published, use a `.vsix` file for testing.

## Out of scope for first release

- Building an AI model or autonomous agent.
- A browser-based marketplace as the main product.
- A full Xcode extension.
- Cloud accounts, payment systems, analytics collection, or mandatory sign-in.
- Executing arbitrary GitHub scripts.
- Claiming exact causal attribution from skill to commit.
- Automatically installing unreviewed skills without user consent.

## Reference documentation

- VS Code first extension: https://code.visualstudio.com/api/get-started/your-first-extension
- VS Code Webview API: https://code.visualstudio.com/api/extension-guides/webview
- VS Code Tree View API: https://code.visualstudio.com/api/extension-guides/tree-view
- VS Code publishing: https://code.visualstudio.com/api/working-with-extensions/publishing-extension
- Claude Code skills: https://code.claude.com/docs/en/skills
- Claude Code hooks: https://code.claude.com/docs/en/hooks
- GitHub REST search API: https://docs.github.com/en/rest/search

---

**Development directive:** Start Phase 1 immediately. Implement real code and test it before making promotional screenshots or a landing page.
