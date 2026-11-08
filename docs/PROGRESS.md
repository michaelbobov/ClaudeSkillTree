# SkillTree progress log

**Start time:** 2026-11-07T19:48:23Z
**Time budget:** 3 hours

## Status

- Phase 1: done (2026-11-07). `npm run verify` → `VERIFY PASS build=ok unit=57/57 integration=6/6 package=skilltree-0.1.0.vsix(308KB) preview=7 screenshots`.
- Phase 2: implemented (2.1–2.11). Evidence below.
- Phase 3: implemented (3.1–3.7). Evidence below.

## Log

- **2.1 schema** `src/shared/catalog.ts` (versioned, strict validator, pinned-URL rule, install-state matching). Unit: `test/unit/catalog.test.ts`.
- **2.2 sample** `data/catalog.sample.json`: 6 real entries frozen from the live index, labeled `"source": "sample"`.
- **2.3 indexer** `src/core/githubIndex.ts` + `scripts/index-skills.ts`; `npm run index` replays a fictional fixture, `npm run index:live` → `INDEX OK live: 19 entries from 1 repositories, 1 skipped` (canvas-design over the 5 MB limit). Seed: `anthropics/skills` (verified via API).
- **2.4 workflow** `.github/workflows/index-skills.yml` (daily + manual, validate, Pages). Unit: `test/unit/workflow.test.ts`. Hosting needs a push (see Needs user).
- **2.5 fetch/cache** `src/core/catalogStore.ts` (remote → cache → bundled, https only, 10 s timeout, size cap). Unit: `test/unit/catalogStore.test.ts`.
- **2.6 marketplace UI** `webview/src/marketplace/` + `src/views/marketplacePanel.ts`, sidebar "Discover". Screenshots reviewed (dark/light/hc/narrow); fixed blue-button wall, uneven meta rows, toolbar overlap in narrow.
- **2.7 preview** full SKILL.md fetched at the pinned commit, blob-hash checked; files + warnings; links disabled.
- **2.8 installer** `src/core/installer.ts` (staging + atomic rename, per-file git blob verification, traversal/symlink/size checks, conflict → explicit replace with hidden backup, cancel, rollback). Unit: `test/unit/installer.test.ts`. Bug found by the preview harness and fixed: gzip Content-Length was compared to file size.
- **2.9 installed state** `.skilltree-source.json` provenance read by the scanner; exact id+commit matching; "Unknown" for same-named folders without provenance; inspector shows source.
- **2.10 integration** 4 marketplace tests pass (10/10 total).
- **2.11 live** `npm run e2e:live` → `E2E LIVE PASS phase2=installed` (anthropics/skills:skills/brand-guidelines @ 2c5958e).

- **3.1 hook semantics** confirmed and quoted in `docs/HOOKS_NOTES.md` (UserPromptExpansion fields verbatim; Skill `tool_input` not in the reference → parsed defensively).
- **3.2 event model** `src/shared/activity.ts` (no prompt text/args; unknown shapes tolerated). Fixtures: `test/fixtures/hooks/`.
- **3.3 recorder** `src/recorder/record-skill-event.ts` → `dist/recorder/record-skill-event.mjs`; unit test runs it like Claude Code (exit 0, empty stdout).
- **3.4 consent + install/uninstall** `src/core/hooksConfig.ts`, `src/services/activity.ts` (backup, atomic write, async hooks, byte-for-byte restore or surgical removal; invalid JSON refused).
- **3.5 UI** Activity tab, Recent Activity sidebar (welcome view when off), inspector "Last observed use". Screenshots reviewed; fixed narrow time column and single-event range.
- **3.6 integration** 2 activity tests pass (12/12 total); one asserts the real `~/.claude/settings.json` hash is unchanged.
- **3.7 live** `npm run e2e:live` runs the bundled Claude Code 2.1.319 against a sandbox with SkillTree's hooks, isolated via `CLAUDE_CONFIG_DIR`; that config has no login, so it reports `phase3=skipped` with the reason. With `SKILLTREE_E2E_REAL_CLAUDE=1` it uses the normal login and reported `phase3=recorded` (both hook events captured, 2026-11-08).

## Needs user

- **Hosted catalog:** push this repository to GitHub, enable Pages (Source: GitHub Actions), run the "Index skills" workflow, then set `skilltree.catalogUrl` to `https://<owner>.github.io/<repo>/catalog-v1.json`. Until then the extension uses the bundled snapshot (`data/catalog.json`).
- **Publishing:** set a real `publisher`, `repository` and license in package.json before publishing.
- **Run the /goal properly:** the paste on 2026-11-07 was sent as text, so no evaluator loop was active. Type `/goal ` and paste the condition after it to get unattended continuation.

## Final evidence (2026-11-07)

- `npm run index:live` → `INDEX OK live: 19 entries from 1 repositories, 1 skipped`
- `npm run verify` → `VERIFY PASS build=ok  unit=105/105  integration=12/12  package=skilltree-0.1.0.vsix(351KB)  preview=17 screenshots in out/preview`
- `npm run e2e:live` → `E2E LIVE PASS phase2=installed  phase3=skipped` (isolated Claude config has no login)
- `SKILLTREE_E2E_REAL_CLAUDE=1 npm run e2e:live` (2026-11-08, Claude Code 2.1.319, haiku) → `E2E LIVE PASS phase2=installed  phase3=recorded`: typed `/sandbox-echo` recorded a `UserPromptExpansion` event (`commandSource: "projectSettings"`), and a model-invoked skill recorded a `PreToolUse:Skill` event with `skill: "sandbox-echo"`. No prompt text in either line.

## Summary (handoff)

Built in this session (Phases 2–3 on top of Phase 1):

- **Marketplace:** GitHub indexer + daily workflow, versioned validated catalog (19 real skills from anthropics/skills pinned to `2c5958e`), remote → cache → bundled loading, Marketplace tab with provenance banner, full SKILL.md preview, and a safe installer (blob-hash verification, staging + atomic rename, no overwrite without explicit replace, hidden backup, rollback, cancel).
- **Activity:** opt-in hooks (PreToolUse `Skill` + UserPromptExpansion) installed with consent and backup, a no-output recorder, Activity tab + sidebar + inspector last-use, and exact restore on disable.
- **Proof tooling:** `npm run verify`, `npm run preview` (17 screenshots), `npm run index:live`, `npm run e2e:live`.

### How to try it

1. Run `npm run dev` (builds, then opens an **[Extension Development Host]** window on the sample project). Or, in VS Code, choose **Run SkillTree (sample project)** in Run and Debug and press ▶ (on a Mac keyboard F5 needs **fn**).
2. **Activity Bar → SkillTree.** The sidebar has three sections: *Installed*, *Discover*, *Recent Activity*.
3. **Discover → Browse skill marketplace.** Search "pdf", open **Preview** (full SKILL.md at the pinned commit, files, warnings), then **Install to Project** and confirm. The card turns *Installed*, and the skill appears under *Installed → This project* and in the Skill Tree inspector with its source commit.
4. Install the same skill again → you are asked to **Replace**; choose Cancel → nothing changes.
5. **Recent Activity → Enable Activity Tracking…** → read the consent text and choose "Enable for this project". Open `.claude/settings.local.json` to see the two hooks. Project tracking only sees Claude Code sessions whose project is that folder, so open Claude Code **inside the Extension Development Host window** (not your main window), start a new session, then type `/` + a skill name or ask Claude to use a skill. To capture sessions in any folder, choose "Enable for all projects" instead (writes `~/.claude/settings.json`). The event appears in the Activity tab. **Disable Activity Tracking** restores the file.
6. Offline check: set `skilltree.catalogUrl` to any https URL that does not resolve → Refresh shows the cached or bundled catalog with the error in the banner.

## Follow-up session (2026-11-08)

- **Launch:** `npm run dev` opens an Extension Development Host without F5 (F5 on a Mac keyboard needs fn).
- **Fixes:** Refresh could return a stale scan (a superseded rescan now waits for the newest one); the activity log watcher re-attaches once tracking creates its folder, and the view re-reads the log on window focus.
- **Live tracking proof:** `npm run e2e:vscode` → 1 passing: the real enable command (consent "this project"), two real Claude Code sessions (`/sandbox-echo` typed, then model-invoked), events picked up by the watcher with no refresh, shown in Recent Activity (`sandbox-echo (Claude · just now) | sandbox-echo (typed · just now)`), the Activity panel (2 rows) and the Skill Tree data (count 2, 1 typed, 1 by Claude, 2 sessions); disable removed settings.local.json; real ~/.claude settings unchanged.
- **Usage in the Skill Tree:** nodes show recorded count and last use ("4× · 12m"); Sort: Name / Last used / Most used; the inspector's "Recorded use" section (counts by source, last use, skills used in the same session); dashed same-session edges for the selected skill with a legend; status bar summary or an "Enable…" link. Plugin/synced skills match by full command (`anthropic-skills:pdf`) before bare name.
- **Skill Tree design:** nodes show the description with a small source icon instead of repeating "Personal"; long categories wrap into balanced columns so the whole tree fits. Note: DESIGN_SYSTEM.md asks for "one-line scope/source" under the name; the scope is now an icon + tooltip and the line shows the description.
- **Catalog:** GitHub topic search ranked by stars (forks skipped, total cap across queries), de-duplication of byte-identical SKILL.md copies. `npm run index:live -- --search --max-search 16` → 1227 entries from 15 repositories; after de-dup **1191** (36 copies dropped). `npm run validate:catalog` → `CATALOG OK … 1191 entries`.
- **Marketplace design:** one-line banner, repository filter, default order by repository, cards without repeated "Not installed"/buttons (install buttons on hover/focus; full actions in the preview), paged rendering (60 at a time).
- **Evidence:** `npm run verify` → `VERIFY PASS build=ok unit=115/115 integration=12/12 package=skilltree-0.1.0.vsix(838KB) preview=22 screenshots`.
- **Usage outside the Skill Tree (2026-11-08):** status bar item `$(pulse) <last skill> · <time>` (tooltip: last 6 recorded uses; click opens the timeline) and a badge on the SkillTree Activity Bar icon counting uses recorded while Recent Activity was not on screen. Both only while tracking is enabled. The extension now also activates `onStartupFinished` (catalog load + validation measured at 12 ms).
- **Repository stars:** optional `repositoryStats` in the catalog (validated: owner/repo keys, integer stars ≥ 0, ISO date). Filled by the indexer from the repository metadata call it already makes; `npm run index:live -- --refresh-stats` refreshes only stars (one request per repository) → `STATS OK 15/15`. Shown as "☆ 189k" next to the repository (tooltip: whole repository, not the skill, with the date), in the preview, in the repository filter, and as "Sort: repository stars".
- **Evidence:** `npm run verify` → `VERIFY PASS build=ok unit=117/117 integration=12/12 package=skilltree-0.1.0.vsix(840KB) preview=22 screenshots`; `npm run e2e:vscode` → 1 passing (`Status bar: "$(pulse) sandbox-echo · just now" · badge 2`). One earlier e2e:vscode run failed after 34 s, most likely Claude not calling the Skill tool; the test now allows one retry of the model-invoked prompt and prints Claude's output if no event arrives.

## Claude recommends skills (2026-11-08)

- **Opt-in:** Discover → "Let Claude suggest skills…" (or `SkillTree: Let Claude Suggest Skills…`). After consent it (1) registers a local MCP server `skilltree` with `claude mcp add --scope user` and (2) adds a UserPromptSubmit hook to `~/.claude/settings.json` (backup first; `Stop Claude Skill Recommendations` removes both and restores the file).
- **MCP server** (`dist/mcp/skilltree-mcp.mjs`, dependency-free stdio JSON-RPC): `search_skills` (keyword relevance, repository stars as tiebreak, local install state) and `install_skill` (writes a request to `~/.claude/skilltree/bridge/requests/`; the VS Code window that has the project open shows the normal install confirmation with Claude's reason; waits for the answer). No network service; no install without the dialog.
- **Prompt hook** (`dist/recorder/suggest-skills.mjs`): matches prompt keywords against the local catalog copy; a strong match for a skill you do not have → a non-blocking VS Code notification (Install to Project / Install Globally / Details → confirmation dialog) and a one-line note to Claude. Once per skill per session; slash commands ignored; the prompt is never stored (tested).
- **Evidence:** `npm run verify` → `VERIFY PASS build=ok unit=131/131 integration=15/15 package=skilltree-0.1.0.vsix(881KB) preview=22 screenshots`. `npm run e2e:vscode` → 3 passing with real Claude Code (haiku): (a) tracking; (b) asked to find a PDF skill, Claude called search_skills + install_skill for `anthropics/skills:pdf` with its own reason, the dialog ran, it installed; in one run Claude invoked it in the same session, in another Claude Code had not loaded it yet and Claude read SKILL.md directly, a follow-up session invoked it; (c) for "Add a nice entrance and exit animation to the modal in src/Modal.tsx" (no mention of skills) the hook matched `emilkowalski/skills:animate`, the VS Code notification and dialog ran, it installed.
- **Probe without the hook:** Claude did not consult the catalog on its own for an ordinary request; with the hook's note alone (no VS Code window) it called install_skill for `animate` in one run and ignored it in another. Hence the deterministic notification path.
- **Catalog:** +emilkowalski/skills (17), mattpocock/skills (39), vercel-labs/agent-skills (9), pbakaus/impeccable (1 canonical copy of 22 per-agent mirrors) → 1229 entries, 19 repositories. `Leonxlnx/taste-skill` skipped (more than 500 files). Limits now 500 files / 2 MB per file / 5 MB per skill. The daily workflow seeds these repos and adds topic searches (popular, by stars) plus the same searches limited to repos created in the last 30 days (new).

## Navigation and large skills (2026-11-08)

- **Navigation:** one sidebar view ("SkillTree") with fixed top rows that cannot be collapsed away: Skill Tree, Marketplace, Activity (with live counts), then the two switches (Usage tracking, Claude skill suggestions), then Installed skills and Recent activity. The Discover and Recent Activity views are gone (folded in). The status bar item is always present (skill count, or the last recorded skill while tracking is on) and opens `SkillTree: Show Menu` (all views and switches). Each editor has section tabs (Skill Tree · Marketplace · Activity) styled like VS Code panel tabs. Setting `skilltree.statusBar` hides the item.
- **Large skills:** limits are now 2,000 files / 50 MB per skill / 2 MB per file; above 200 files or 10 MB a skill is flagged "Large skill" in the catalog and in the install dialog. Files download 6 at a time, each still size- and hash-checked; a failure mid-way leaves nothing behind (unit test with 60 files). `Leonxlnx/taste-skill` indexed (1,631 files, 34.9 MB, 1,594 of them in assets/) and installed for real into a temp folder: `TASTE INSTALL OK 1631 files (+ provenance record) in 36 s`.
- **Evidence:** `npm run verify` → `VERIFY PASS build=ok unit=133/133 integration=16/16 package=skilltree-0.1.0.vsix(940KB) preview=22 screenshots`.

## Conventions pass (2026-11-08)

Checked against VS Code's UX guidelines (status bar, views, webviews): tree rows must not be used as buttons and workspace-level status bar items go on the left. The sidebar is now data only (skills by scope, recent activity), the three editors open from the view's title actions, the switches are in the view's "…" menu and the SkillTree menu, the status bar item moved to the left, and a "Get started with SkillTree" walkthrough was added. The Marketplace header shows whether Claude suggestions are on, with a link to turn them on. `npm run verify` → `VERIFY PASS build=ok unit=133/133 integration=16/16 package=skilltree-0.1.0.vsix(942KB) preview=22 screenshots`.

## Plan

Phase 5 in README.md ("Usage-driven recommendations and organization") is the next phase.

## Phase 5 started (2026-11-08)

- **Unused skills** (`src/shared/recommend.ts` → `unusedDays`): needs ≥ 7 days of tracking and no recorded use; shown as "unused" only when sorting by use (Skill Tree, list), as "N unused for 7+ days" in the Skill Tree status bar, and as a note with a Reveal link in the details panel.
- **For you** (`matchOrigins`, `recommendFromUsage`): computed in the extension host from the catalog, local skills (SKILL.md git-blob hash cached by mtime) and recorded use; the Marketplace shows a "For you" group with each reason. With the QA usage fixture on this machine's real skills: brand-guidelines, slack-gif-creator, theme-factory (anthropics/skills, "like frontend-design and docx"), animate-expo, choreograph, remove-animations (emilkowalski/skills, "like emil-design-eng and animate").
- **Evidence:** `npm run verify` → `VERIFY PASS build=ok unit=137/137 integration=16/16 package=skilltree-0.1.0.vsix(944KB) preview=24 screenshots` (new scenarios: market-foryou-dark/light).
- **Next in Phase 5:** better automatic categories, your own groups, bulk organizing, "Add from GitHub…", this-session installs.
- **Same-name detection (2026-11-08):** a catalog skill whose name matches a skill already on this machine (installed by another tool, synced from claude.ai, or by hand) is shown as "Unknown: you may already have it" instead of "Not installed", and the install dialog says Claude Code uses one skill per name (managed, then personal, then project). On this machine: 27 catalog skills, including `Leonxlnx/taste-skill` (local `design-taste-frontend`, an older 29-file copy) and `anthropics/skills` pdf/docx/skill-creator (synced). `npm run verify` → `VERIFY PASS build=ok unit=138/138 integration=16/16 package=skilltree-0.1.0.vsix(944KB) preview=24 screenshots`; `npm run e2e:vscode` → 3 passing.
