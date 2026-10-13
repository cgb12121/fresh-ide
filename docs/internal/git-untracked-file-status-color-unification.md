# Git Untracked File Status Color Unification

## Context & Problem Statement
In Fresh IDE, Git status badges display file changes (`A` for Added, `M` for Modified, `D` for Deleted, `R` for Renamed, `U` for Untracked, `!` for Conflicted).
Previously, untracked files (`U`) displayed without distinct color (or appeared as muted/gray uncolored text).
Specifically:
1. **Core Theme Fallback:** In `crates/fresh-editor-core/src/theme/types.rs`, `file_status_untracked_fg` fell back to `"diagnostic.hint_fg"`. In almost all themes, `hint_fg` is a dark gray or comment color (`[108, 108, 108]`, `"Gray"`, or `[84, 110, 122]`).
2. **Built-in & Shipped Themes:** `terminal.json` explicitly mapped `file_status_untracked_fg` to `"Gray"`, and themes like `gruvbox.json` and `tokyo-night.json` mapped it to muted brownish or grayish colors.
3. **Missing `-u` Flag in Git Status Queries:** In `editor_enhancements/git_explorer.ts` and `git_explorer.ts`, `git status --porcelain=v1 -z --ignored=matching` was invoked without the `-u` (`--untracked-files=all`) flag. Consequently, git collapsed untracked folders to `?? dir/`, omitting individual untracked files underneath and leaving them with no decoration or color.

In Git and VS Code conventions, untracked files are new files waiting to be staged, so they share the prominent green coloring (`#56d364` / `#73c991`) with added files.

## Architectural Decision
1. **Core Theme Fallback Update:**
   - In `crates/fresh-editor-core/src/theme/types.rs`, change the fallback for `"file_status_untracked_fg"` from `"diagnostic.hint_fg"` to `"ui.file_status_added_fg"`.
   - Any theme that does not explicitly set `file_status_untracked_fg` now automatically inherits the green color defined for `file_status_added_fg`.
2. **Built-in & User Theme Harmonization:**
   - Update `terminal.json` to use `"Green"`.
   - Update `gruvbox.json` to use green `[184, 187, 38]`.
   - Update `tokyo-night.json` to use green `[158, 206, 106]`.
   - Update user theme `terminal-dark.json` to use vibrant green `[86, 211, 100]`.
   - Update theme schema `crates/fresh-editor/plugins/schemas/theme.schema.json`.
3. **Explorer Discovery Enhancement:**
   - Add `-u` flag to git status porcelain invocations in `editor_enhancements/git_explorer.ts` and `git_explorer.ts`.
   - Map `case "?":` in `editor_enhancements/common.ts` `statusToDecoration` to `{ symbol: "U", color: COLORS.untracked, priority: PRIORITY.untracked }`.
4. **Git Control Panel:**
   - `git_control_panel.ts` continues to use `"ui.file_status_untracked_fg"`, which now cleanly resolves to vibrant green across all themes.

## Verification
- Run `cargo test -p fresh-editor-core theme` to verify that all 74 theme tests pass.
- Run `cargo check --workspace` to ensure compile-time correctness across all crates.
- Build and deploy binary to user WinGet packages directory.
