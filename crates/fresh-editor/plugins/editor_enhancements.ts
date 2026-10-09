/// <reference path="./lib/fresh.d.ts" />
import { editor } from "./editor_enhancements/common.ts";
import { requestCustomGitExplorer } from "./editor_enhancements/git_explorer.ts";
import { requestBufferVisuals } from "./editor_enhancements/visuals.ts";

/**
 * Editor Enhancements
 *
 * A bundled plugin (split from a former single-file `init.ts`) that layers
 * custom visuals on top of Fresh:
 *
 * 1. Git Explorer customizer: Sea Blue/Green changed folders, muted gray
 *    ignored entries, white clean folders, full M/U/A/!/D/R badges. The repo
 *    walk is throttled and the decoration payload is deduped (see
 *    `editor_enhancements/git_explorer.ts`).
 * 2. Java syntax enhancer: package-prefix dimming, annotations, types,
 *    methods, variables, constants (`editor_enhancements/syntax_java.ts`).
 * 3. XML / YAML / properties enhancers.
 * 4. Enhanced git gutter (thick indicators, CRLF normalization, no false
 *    orange) in its own namespace.
 *
 * The syntax/gutter passes are debounced and coalesced through one dispatcher
 * (`editor_enhancements/visuals.ts`).
 *
 * Config: `plugins.editor_enhancements.enabled` (default enabled). The bundled
 * `git_explorer` / `git_gutter` plugins should stay disabled so this plugin is
 * the only writer of those decorations.
 */

// ---------------------------------------------------------------------------
// Event Hook Registration
// ---------------------------------------------------------------------------

editor.on("after_file_open", (args) => {
  // Opening a buffer does not change repo-wide git status, so it no longer
  // triggers a git recompute (VS Code/IntelliJ refresh VCS on watcher/save,
  // not on document open). Startup + focus + save + explorer FS mutations
  // still cover the cases that do matter.
  if (args && typeof args.buffer_id === "number") {
    requestBufferVisuals(args.buffer_id, true);
  }
});

editor.on("buffer_activated", (args) => {
  if (args && typeof args.buffer_id === "number") {
    requestBufferVisuals(args.buffer_id, true);
  }
});

editor.on("after_file_save", (args) => {
  requestCustomGitExplorer(true);
  if (args && typeof args.buffer_id === "number") {
    requestBufferVisuals(args.buffer_id, true);
  }
});

editor.on("after_file_revert", (args) => {
  requestCustomGitExplorer(true);
  if (args && typeof args.buffer_id === "number") {
    requestBufferVisuals(args.buffer_id, true);
  }
});

editor.on("lines_changed", (args) => {
  if (args && typeof args.buffer_id === "number") {
    // Viewport redraws are frequent and don't change the on-disk Git diff.
    // Keep syntax refreshes (debounced), but only refresh the Git gutter on
    // file events. `epoch` is the buffer version: an unchanged buffer skips
    // the whole-buffer rescan entirely.
    const epoch = typeof args.epoch === "number" ? args.epoch : null;
    requestBufferVisuals(args.buffer_id, false, epoch);
  }
});

editor.on("after_file_explorer_change", () => {
  requestCustomGitExplorer(false);
});

editor.on("editor_initialized", () => {
  requestCustomGitExplorer(true);
  try {
    const active = editor.getActiveBufferId();
    if (active) requestBufferVisuals(active, true);
  } catch (_e) {
    // Ignore
  }
});

editor.on("focus_gained", () => {
  requestCustomGitExplorer(false);
  try {
    const active = editor.getActiveBufferId();
    if (active) requestBufferVisuals(active, false);
  } catch (_e) {
    // Ignore
  }
});

// Initial kick-off
requestCustomGitExplorer(true);
try {
  const initialActive = editor.getActiveBufferId();
  if (initialActive) requestBufferVisuals(initialActive, true);
} catch (_e) {
  // Ignore
}
