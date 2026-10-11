# Git Gutter: Click-to-Diff Peek and Scrollbar Overview Ruler

> **Status:** IMPLEMENTED  
> **Audience:** Fresh core developers, plugin authors, and users working with Git-backed buffers.  
> **Primary Component:** `crates/fresh-editor/plugins/editor_enhancements/git_gutter.ts`

---

## 1. Context & Motivation

In modern code editors (such as VS Code, Cursor, and JetBrains), the Git integration provides two complementary overview surfaces:
1. **Vertical Scrollbar Overview Ruler:** Real-time color indicators along the scrollbar track displaying where additions, modifications, and deletions exist across the entire file without requiring the user to scroll.
2. **Click-to-Diff Interaction:** Clicking on a change marker in the left gutter opens a focused inline diff peek showing the exact before/after hunk with minimal, distraction-free inspection.

Previously in Fresh, while the Rust core (`ScrollbarMarkerManager`) supported scrollbar annotations, the custom enhanced git gutter plugin (`editor_enhancements/git_gutter.ts`) only decorated the left margin with line indicators and did not publish scrollbar markers. Furthermore, clicking on the gutter indicators placed the cursor but did not offer a diff inspection view.

This implementation connects both surfaces into a unified, lightweight, and keyboard-first workflow.

---

## 2. Architecture & Design

### 2.1 Component Interaction

```
[ Git CLI ] ──(git diff -U0)──> [ git_gutter.ts ]
                                      │
           ┌──────────────────────────┴──────────────────────────┐
           ▼                                                     ▼
 [ Left Gutter Indicators ]                           [ Vertical Scrollbar ]
   (▎ green/orange, ▾ red)                              (Overview Ruler Markers)
           │
     (mouse_click)
           ▼
 [ Click-to-Diff Resolver ]
           │
     (git diff -U3)
           ▼
 [ Minimal Diff Peek Modal ]
   - File Name (Crisp White) & Type Badge
   - Hunk Header (@@ ... @@) Colored by Diff State
   - Semantic Line Highlights (+ Green, - Red, Context White)
   - Zero Clutter: No footer buttons, no hint bars
   - Native Esc / Close dismiss; terminal Shift-drag or git:copy_peek_diff
```

### 2.2 Features

#### 1. Vertical Scrollbar Overview Ruler
- Automatically maps all git hunks onto the vertical scrollbar track using `editor.setScrollbarMarkers(bufferId, "git-gutter-scroll", markers)`:
  - 🟩 **Added Lines:** Green range marker (`COLORS.gutterAdded`).
  - 🟧 **Modified Lines:** Orange range marker (`COLORS.gutterModified`).
  - 🟥 **Deleted Lines:** Red point marker at the deletion seam (`COLORS.gutterDeleted`).
- Dynamic updates on file open, buffer activation, save, and revert.
- Zero extra screen columns required; rendered natively by Fresh's host-side `ScrollbarMarkerManager`.

#### 2. Click-to-Diff (Peek Modal)
- Listens to the `mouse_click` hook event.
- Evaluates whether the click landed in the left gutter (`colInSplit <= 8`) on a row containing a Git change.
- Resolves the exact hunk from `git diff -U3` with context lines.
- Mounts a centered floating modal (`mountFloatingWidget`) presenting:
  - **Header:** File name displayed in pure white (`editor.fg`), with diff badge (`[ADDED]`, `[MODIFIED]`, `[DELETED]`) and line range.
  - **Hunk Header:** `@@ -... +... @@` dynamically styled with the semantic color of the diff status (`syntax.string` for added, `diagnostic.warning_fg` for modified, `diagnostic.error_fg` for deleted).
  - **Semantic Diff Highlighting & Full Selectability:** Rendered using Fresh's native `text({ markdown: true, readOnly: true, focused: true, key: "git_diff_text" })` widget with thread-local document caching for zero-lag mouse selection:
    - `+` lines: `syntax.string` (bright green)
    - `-` lines: `diagnostic.error_fg` (bright red)
    - context lines: `editor.fg` (white)
    - Clean background: Diff code blocks omit `ui.inline_code_bg` gray boxes, rendering cleanly against the modal background.
  - **Distraction-Free Minimal Design:** No `[ Close ]` buttons or hint text bars. Dismissed cleanly via `Esc` or clicking outside.
  - **Zero-Lag Selection & Clipboard Copy:**
    - Mouse drag directly within modal selects text instantaneously with real-time visual tracking (optimizations in `shell_host.rs:move_prose_caret` avoid expensive full UI relayout and redundant anchor reveals during drag selection).
    - `Ctrl+C`: Copies selected text, or copies the entire hunk if nothing is selected.
    - `Ctrl+A`: Selects the entire diff hunk text.
    - Command palette `Git: Copy Current Peek Diff` (`git:copy_peek_diff`).
    - Terminal `Shift + mouse drag` for terminal-level selection.
- Also accessible via keyboard command: `Git: Peek Diff at Cursor` (`git:peek_diff_at_cursor`).

#### 3. VS Code-Aligned Git Explorer Color Scheme & Compact/Collapsed Folder Support
- **VS Code Palette Sync (`common.ts`):**
  - 🟩 **Staged Changes:** Pale Green (`#89D185` / `[137, 209, 133]`) for index additions, modifications, renames, and deletions.
  - 🟢 **New / Untracked:** Vibrant Green (`#56D364` / `[86, 211, 100]`).
  - 🌊 **Changes / Modified:** Sea Blue (`#58A6FF` / `[88, 166, 255]`) for active working tree modifications (both files and gutter overview markers).
  - 🔺 **Priority Precedence:** Conflicted (90) > Deleted (80) > Modified (70) > Staged (65) > Added (60) > Renamed (55) > Untracked (50). When directories contain mixed changes, modified (Sea Blue) bubbles up over staged (Pale Green) and untracked (Vibrant Green).
- **Compact & Collapsed Folder Coloring (`file_explorer.rs`, `decorations.rs`, `slots.rs`):**
  - **Compact Ancestor Chains:** Each segment in `node.chain` (`crates / fresh-editor / src`) resolves its own `ExplorerSlotContext`, dynamically painting each directory part according to its Git changes instead of falling back to default folder gray.
  - **Collapsed Folder Row Bubbling:** `CompatibilityTrailingSlotProvider` propagates `name_color_hint` from `BubbledDecoration` directly to row names, ensuring single or collapsed directories reflect Git change states even when explicit slot overrides are pending.
- **Cross-Platform Path Normalization:**
  - `getPathVariants` registers forward-slash, Windows backslash, and verbatim (`\\?\`) paths.
  - Core caches (`FileExplorerSlotOverrideCache` and `FileExplorerDecorationCache`) strip verbatim prefixes and normalize slashes during insertion and lookup, eliminating dropped decorations or status mismatches on Windows.

---

## 3. Keyboard Shortcuts & Gestures

| Trigger / Key | Action | Description |
| :--- | :--- | :--- |
| **Click on gutter marker** | `handleGutterClick` | Open Diff Peek modal for the clicked hunk |
| `Escape` / Click outside | `closeDiffPeek` | Dismiss the Diff Peek modal |
| **Mouse drag** | Native widget drag | Select arbitrary text/lines within the diff with instant response |
| `Ctrl+C` | Native copy | Copy selected text (or entire hunk if none selected) to clipboard |
| `Ctrl+A` | Select all | Select all text inside the diff peek widget |
| Command Palette | `git:copy_peek_diff` | Copy current diff hunk to clipboard |
| Command Palette | `git:peek_diff_at_cursor` | Open Diff Peek at current cursor line |
