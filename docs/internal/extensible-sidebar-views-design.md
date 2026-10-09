# Extensible Sidebar Views and VS Code-Style Panels Design

## 1. Executive Summary

Fresh IDE currently features a fast, native file explorer sidebar, an accordion-style
sidebar section mechanism (`mountSidebarSection`), and a dedicated left dock (`shell::dock::column`)
housing Orchestrator and agent sessions.

This document specifies the architecture for **Extensible Sidebar Views** in Fresh:
1. **Extensible View Registry (`view_registry.ts`)**: A decoupled hub allowing core panels and third-party custom plugins to register sidebar views/tabs dynamically without modifying core shell code.
2. **VS Code-Style Activity Bar Switcher (`activity_bar.ts`)**: A high-efficiency navigation bar enabling quick switching between Explorer (`📁`), Source Control & Git Graph (`🌿`), Extensions & LSP Manager (`🧩`), and Agent Sessions (`🤖`).
3. **Agent View Safety & Non-Interference**: Strict guarantee that Orchestrator and agent sessions (`PanelSlot::Dock`) are never clobbered or displaced. The Agent icon acts as a bridge triggering Fresh's native dock toggle.
4. **Interactive Git Control & Visual Graph Panel (`git_control_panel.ts`)**:
   - Upper pane: Staged Changes & Changes (Unstaged) in Flat or Tree view with one-touch Stage (`+`), Unstage (`-`), Discard (`d`/`r`), Commit message input (`Ctrl+Enter`), and Diff inspection.
   - Lower pane: Real-time visual Git commit graph rendered with Unicode/ASCII branch lines, commit hashes, branches/tags, and commit subjects.
5. **Extensions & LSP Panel (`extensions_panel.ts`)**: Interactive dashboard to view and toggle Language Server Protocol (LSP) daemons, preview and change color themes on the fly, and inspect loaded plugins.

---

## 2. Architecture & Component Hierarchy

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           Editor Shell Frame                            │
├──────────────┬───────────────────────────────┬──────────────────────────┤
│ Left Dock    │ Activity Rail + Sidebar        │ Main Editor Splits       │
│ (Optional)   │                               │                          │
│              │ ▎▱ │ Explorer / Git / Tools    │                          │
│ Orchestrator │  ⑂ │                           │                          │
│ Agent Dock   │  ⊞ │ Active view content       │                          │
│ (Slot::Dock) │  ◉ │                           │                          │
│              │    │                           │                          │
│              │    │                           │                          │
│              │    │                           │                          │
└──────────────┴───────────────────────────────┴──────────────────────────┘
```

### 2.1 View Registry (`lib/view_registry.ts`)

The View Registry is shared through Fresh's `exportPluginApi` / `getPluginApi`
plane under `workbench-views`. Each plugin has a separate QuickJS context;
`globalThis` cannot share a registry between plugins.
- `ViewDefinition`: Describes a view's `id`, `title`, `icon`, `hotkey`, `order`, `render()`, `onEvent()`, and lifecycle hooks.
- Extensibility contract: Custom plugins import `getViewRegistry()` and call `registerView(def)`.
- Dispatches state updates whenever active view switches or data invalidates.

### 2.2 Agent View Isolation Contract

- **Constraint**: `orchestrator.ts` mounts directly to `PanelSlot::Dock` using `{ asDock: true, mode: "orchestrator-dock" }`.
- **Guarantee**: The new sidebar views mount strictly within the Sidebar Column (`mountSidebarSection` / `updateFloatingWidget`), operating completely outside `PanelSlot::Dock`.
- Clicking the `🤖 Agents` button executes `orchestrator:toggle_dock` or `agent_sessions:open`, giving users a unified VS Code Activity Bar experience without touching the host dock allocator.

---

## 3. Interactive Git Control & Visual Graph

### 3.1 Git Data Service (`lib/git_control.ts`)
- Leverages `lib/git_repo.ts` (`resolveGitRepo`, `git(editor, repo, args)`).
- Executes `git status --porcelain=v1 -u` to extract staged, unstaged, and untracked file sets.
- Executes `git log --graph --oneline --decorate -n <limit>` to extract commit graph topology and ref tags.
- Provides operations: `stageFile`, `unstageFile`, `stageAll`, `unstageAll`, `discardFile`, `commit`.

### 3.2 Visual Staging and Staged/Unstaged UI
- Header row with active branch name and Refresh `⟳` action.
- Single-line commit message input box with Commit action.
- Accordion sections:
  - **Staged Changes (`count`)**: lists files with `[-]` Unstage button.
  - **Changes / Unstaged (`count`)**: lists files with `[+]` Stage button and `[↺]` Discard button.
  - Toggle between Flat view and Folder Tree view.
  - Clicking any file opens a live diff buffer against HEAD or working tree.

### 3.3 Visual Git Graph
- Renders branch graph glyphs (`*`, `| \`, `| *`, `* |`) with colored nodes.
- Shows short hash, decoration badges (`(HEAD -> master, origin/master)`), and commit subject.

---

## 4. Extensions & LSP Dashboard

1. **LSP Servers**:
   - Checks active language servers (`rust-analyzer`, `vtsls`, `pyright`, `clangd`, `jdtls`, `gopls`).
   - Provides live toggle buttons to enable or disable language servers.
2. **Themes**:
   - Lists available themes. Clicking immediately invokes `editor.setTheme(themeName)`.
3. **Plugin Management**:
   - Inspects registered plugins and extensions.

---

## 5. Full-Height View Switching (VS Code Parity)

To prevent cramping when multiple complex panels occupy the terminal sidebar:
- **Single Active Primary View**: The Activity Bar coordinates exclusive focus:
  - In `📁 Explorer` view: auxiliary panels are unmounted, granting File Explorer 100% of available sidebar rows.
  - In `🌿 Source Control` view: File Explorer yields space, allowing Git staging lists and the 25-commit visual graph to occupy the full sidebar height (30-50 terminal rows).
  - Re-clicking the active icon toggles the content column. The rail stays visible and can reopen the selected view.
  - The Activity Bar is a persistent five-column vertical rail with monochrome glyphs and an active stripe, rather than a sidebar header.
  - Ordinary sidebar sections retain accordion behavior under Explorer. A primary Git/Extensions view occupies the content column exclusively.
  - Core layout keeps original section indices so widget input, keyboard scope, and resizing still target the correct panel.

### 5.1 Host layout controls

After `mountSidebarSection`, `floatingPanelControl` supports:

- `activity_bar`: make this section the navigation rail without a section header.
- `sidebar_view`: mark the selected section as the primary view and show the content column.
- `activity_show`: on the rail, a positive argument opens content, zero hides it, and a negative argument toggles it.

The registry activates/deactivates view owners in their original plugin contexts.
Git mounts on activation only; requesting 150 rows is no longer used to squeeze
Explorer out of view. Unknown view IDs leave the current selection intact.

Default keymap bindings are Ctrl+Shift+E/G/X/A for Explorer, Source Control,
Extensions, and Agents. Terminals must report Shift separately to distinguish
these from their Ctrl-only shortcuts. The original Ctrl+E also switches an open
primary view back to Explorer.

### 5.2 Validation

`view::shell::sidebar::tests` covers rail geometry, full-column primary content,
hidden content, and existing accordion behavior. `e2e::workbench_views` loads
the actual three plugins in separate QuickJS contexts and drives icon clicks,
hide/reopen, view exclusion, and keyboard navigation.
