# SkillTree — Design System: Quiet Workbench

> This is the chosen default direction for SkillTree's VS Code extension. Prior concept images are **not** the visual target. This is a sober developer tool, not a sci-fi control room.

## Visual direction

**Quiet Workbench:** an IDE-native graph explorer with the composure of VS Code, the information hierarchy of Linear, and the effortless navigation of a file explorer. The skill graph is useful infrastructure, not a hero illustration. 

**Three words:** precise, quiet, dependable.

**Never use:** neon outlines, colorful glow, animated stars, gaming skill levels/XP, magical AI avatar icons, gradient-rimmed boxes, glossy glass effects, dramatic shadows, fake session counts, fake screenshots, giant card padding, thick pill buttons, and decorative marketing flourishes inside the IDE.

The UI should look credible when surrounded by real code and work with 6 or 200 skills. The product remains entirely inside VS Code; a separate website is only for installation and promotion.

## Visual tokens

Use host theme colors first. Do **not** force dark mode. All appearance values below are references, not hardcoded overrides for VS Code theme/high contrast.

| Token | Dark reference | Purpose |
|---|---|---|
| Canvas | `#1E1E1E` | Matches default VS Code dark editor |
| Sidebar | `#252526` | Host sidebar |
| Surface | `#252526` | Node/inspector backgrounds |
| Border | `#3C3C3C` | 1px, quiet separation |
| Text | `#D4D4D4` | Primary |
| Secondary text | `#858585` | Metadata |
| Selected | `#007ACC` | Native VS Code focus blue; use `--vscode-focusBorder` where possible |
| Link/edge | `#606060` | Thin organization edges, never glowing |

Prefer CSS variables such as `--vscode-editor-background`, `--vscode-sideBar-background`, `--vscode-foreground`, `--vscode-descriptionForeground`, `--vscode-panel-border`, `--vscode-list-activeSelectionBackground`, and `--vscode-focusBorder`. For skill categories use at most a small, low-saturation color bar or subtle 4px dot. Icons: one system (VS Code Codicons preferred), 14–16px. Text: native VS Code fonts, 12–13px body, 16–18px panel heading, monospace only for paths and hashes. Radius: 4–6px; avoid round-pill surfaces for everything.

## Product layout

The native Activity Bar gets a **SkillTree** icon. It opens a compact **SkillTree** sidebar with sections:

- Installed (grouped by workspace and global), each with a true count
- Discover
- Recent activity (only if enabled)

Click **Open Graph** to open a full-sized editor tab. Use a three-zone layout: small graph toolbar top, main graph canvas center, compact inspector on right only when a skill is selected. When the editor is narrow, open inspector as a panel or drawer, not a squashed permanent column. Do not replace the source editor or intercept ordinary coding flows.

### Graph — Explore

Default organizational view: `Workspace -> Category -> Skill`. Nodes use **actual skill names** in simple outlined rectangles. Nodes have one-line name and one-line scope/source; optional tiny usage count appears only if observed and reliable. Connectors are 1px gray lines (solid = organization). The tree is left-to-right or top-down automatically; zoom/fit controls are understated, not a floating control tower. Provide list mode, keyboard navigation and search.

No shadows, no glow. On hover highlight the selected path by changing stroke to theme focus color; all other lines stay gray. Avoid painting entire nodes in category colors. Resist drawing invented dependencies: organizational links are not skill dependencies.

### Inspector — Details

Show skill name; "Installed in: Project" or "Installed globally"; absolute or relative path; short description from `SKILL.md`; buttons **Open SKILL.md**, **Copy path**, **View source** (if known); most recent observed session only if tracked. No fabricated counts, sample commits, related-skills endorsements or popularity claims.

### Discover — Marketplace

Function like an IDE extension marketplace, not an App Store landing page. Search field, category/scope filters, sorting and **dense two-column list/cards** in a full editor pane. Each entry has skill name, real GitHub author/repo, one-line explanation, preview, clear install state. Clicking opens code/markdown preview with explicit source and file list. **Install to Project** and **Install Globally** are distinct, confirmed actions. Catalog freshness, provenance and unsupported plugin installation types must be accurately labeled. No ratings, inflated download counts, invented badges, large illustrations or product thumbnails.

### Activity — Timeline

Compact rows: timestamp, project, session identifier, observed skill name, optional related commit with "inferred" label. Do not imply a commit proves the skill caused changes. Opt-in only; no activity mockup pretending to be collected data.

## Wireframe reference (not an image to clone)

```text
┌ VS Code ─────────────────────────────────────────────────────────────────┐
│ Activity │ SKILLTREE        │ Skill Tree                         search │
│ Bar      │                  ├───────────────────────────┬───────────────┤
│          │ Installed (8)    │ project                   │ SKILL DETAILS │
│ [icon]   │  This project    │   ├─ Frontend             │ react-ui      │
│          │   react-ui       │   │   ├─ react-ui          │ Project skill │
│          │   write-tests    │   │   └─ accessibility    │ From SKILL.md │
│          │  Global          │   └─ Testing              │ [Open file]   │
│          │   ...            │       └─ write-tests      │ [Source]      │
│          │                  │                           │               │
│          │ Discover         │ [Fit graph] [List view]   │               │
│          │ Activity         │                           │               │
└──────────┴──────────────────┴───────────────────────────┴───────────────┘
```

## Interaction quality bar

- Mouse and keyboard support: search, tab order, arrow navigation, open skill, fit graph, zoom.
- Native contrast and focus states; honors theme color and reduced motion.
- Empty state: "No Claude Code skills found" with the exact directories scanned and a **Rescan** action; never populate with fake content.
- Loading states and useful errors, including offline catalog with cached age.
- 200 skills should remain usable via grouping, collapse and text filtering.
- Prefer performant, typed React Flow or SVG graph layouts; use low-motion transitions <=100ms, or none.
- Keep webview assets local with restrictive Content Security Policy. Avoid remote fonts and embedded external scripts.

## MVP acceptance

1. The UI looks like a natural part of VS Code when opened next to source files; no glow or game styling.
2. Clicking a real local skill opens its actual `SKILL.md` and displays metadata.
3. The graph shows only truthful relationships; no fake analytics.
4. Marketplace entries distinguish previews from installed skills and expose their original source.
5. Light/high-contrast themes, narrow windows, keyboard input and empty state are deliberate.

**Design principle:** functional clarity is the aesthetic. A polished tool earns trust by what it reveals, not how much it animates.
