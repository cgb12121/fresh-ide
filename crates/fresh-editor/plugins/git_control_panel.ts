/// <reference path="./lib/fresh.d.ts" />

/**
 * Git Control Panel (Source Control & Git Graph)
 *
 * Provides VS Code-style git staging, commit box, staged/unstaged changes lists,
 * and live visual Git commit graph.
 */

import {
  button,
  col,
  divider,
  flexSpacer,
  label,
  row,
  spacer,
  textArea,
  type WidgetSpec,
  type WidgetEvt,
  type StyledSegment,
  type TextPropertyEntry,
} from "./lib/widgets.ts";
import {
  getGitStatus,
  getGitGraph,
  stageFile,
  stageAll,
  unstageFile,
  unstageAll,
  discardFile,
  commitStaged,
  fetchRemote,
  gitShowCommit,
  getGitFileSnapshots,
  getGitFileDiffInfo,
  collapseUnchangedRanges,
  clearGitFileCaches,
  MAX_CHANGED_LINES_FOR_PATCH,
  type GitStatusSummary,
  type GitGraphLine,
} from "./lib/git_control.ts";
import { getViewRegistry } from "./lib/view_registry.ts";

const editor = getEditor();
const PANEL_ID = 401; // Stable unique ID for Git Control Section

let statusSummary: GitStatusSummary | null = null;
let graphLines: GitGraphLine[] = [];
let commitText = "";
let statusFeedback = "";
let isStagedCollapsed = false;
let isUnstagedCollapsed = false;
let isGraphCollapsed = false;
let isMounted = false;
let commitPreviewBufferId: number | null = null;
let commitPreviewSplitId: number | null = null;
let commitPreviewContent = "";
let commitPreviewTopLine = 1;
let fileDiffPreview: { compositeId: number; oldBufferId: number; newBufferId: number } | null = null;
let fileDiffRequest = 0;
const deferredDiffSourceCleanup: Array<{ oldBufferId: number; newBufferId: number }> = [];
/** Unchanged lines kept on each side of a hunk in the file review, the same
 *  shape VS Code ships as `diffEditor.hideUnchangedRegions.contextLineCount`
 *  (it defaults to 3; 5 reads better here and still bounds a 500-line file to
 *  a couple of dozen lines per side). */
const DIFF_CONTEXT_LINES = 5;
/** The two source buffers of the file review, kept across clicks. The composite
 *  is cheap to rebuild; two virtual buffers per click are not. */
let diffSourceBuffers: { oldId: number; newId: number } | null = null;
const GIT_ADDED_COLOR: [number, number, number] = [86, 211, 100];
const GIT_DELETED_COLOR: [number, number, number] = [248, 81, 73];

// Refresh git status and graph
export async function refreshGitData(): Promise<void> {
  try {
    const [status, graph] = await Promise.all([
      getGitStatus(editor),
      getGitGraph(editor, 25),
    ]);
    statusSummary = status;
    graphLines = graph;
  } catch {
    statusFeedback = "Failed to refresh git status";
  }
  if (isMounted) {
    updatePanel();
  }
}

// File staging does not change the commit graph. Avoid resolving the repo and
// spawning `git log` after every + / - click.
async function refreshGitStatusData(): Promise<void> {
  try {
    // The working tree just moved under us (staging, discard, save), so any
    // memoized blob from before this refresh is no longer the truth.
    clearGitFileCaches();
    statusSummary = await getGitStatus(editor);
  } catch {
    statusFeedback = "Failed to refresh git status";
  }
  updatePanel();
}

function gitLineStyle(line: string): TextPropertyEntry["style"] {
  if (line.startsWith("+") && !line.startsWith("+++")) {
    return { fg: GIT_ADDED_COLOR, bold: true };
  }
  if (line.startsWith("-") && !line.startsWith("---")) {
    return { fg: GIT_DELETED_COLOR, bold: true };
  }
  if (line.startsWith("@@")) return { fg: "syntax.keyword", bold: true };
  if (line.startsWith("diff --git ")) return { fg: "syntax.type", bold: true };
  if (line.startsWith("commit ")) return { fg: "syntax.function", bold: true };
  if (/^(Author|Date|Commit|Merge):/.test(line)) return { fg: "syntax.keyword" };
  if (line.startsWith("index ")) return { fg: "syntax.number" };
  return { fg: "editor.fg" };
}

function gitStatOverlays(line: string): Array<{
  start: number;
  end: number;
  style: { fg: [number, number, number]; bold: boolean };
  unit: "char";
}> {
  const overlays: Array<{
    start: number;
    end: number;
    style: { fg: [number, number, number]; bold: boolean };
    unit: "char";
  }> = [];
  const pipe = line.lastIndexOf("|");
  if (pipe >= 0) {
    const stat = line.slice(pipe + 1).match(/^(\s*)(\+\d+)\s+(-\d+|binary)\s*$/);
    if (stat) {
      const addedStart = pipe + 1 + stat[1].length;
      const removedStart = addedStart + stat[2].length + 1;
      overlays.push({
        start: Array.from(line.slice(0, addedStart)).length,
        end: Array.from(line.slice(0, addedStart + stat[2].length)).length,
        style: { fg: GIT_ADDED_COLOR, bold: true },
        unit: "char",
      });
      if (stat[3].startsWith("-")) {
        overlays.push({
          start: Array.from(line.slice(0, removedStart)).length,
          end: Array.from(line.slice(0, removedStart + stat[3].length)).length,
          style: { fg: GIT_DELETED_COLOR, bold: true },
          unit: "char",
        });
      }
      return overlays;
    }
  }

  const countPattern = /\d+ insertions?\(\+\)|\d+ deletions?\(-\)/g;
  for (const match of line.matchAll(countPattern)) {
    const index = match.index ?? 0;
    const added = match[0].includes("insert");
    overlays.push({
      start: Array.from(line.slice(0, index)).length,
      end: Array.from(line.slice(0, index + match[0].length)).length,
      style: { fg: added ? GIT_ADDED_COLOR : GIT_DELETED_COLOR, bold: true },
      unit: "char",
    });
  }
  return overlays;
}

function gitPreviewEntries(content: string): TextPropertyEntry[] {
  return content.split("\n").map((line) => {
    const statOverlays = gitStatOverlays(line);
    return {
      text: `${line}\n`,
      style: gitLineStyle(line),
      ...(statOverlays.length > 0 ? { inlineOverlays: statOverlays } : {}),
    };
  });
}

async function showCommitPreview(hash: string): Promise<void> {
  let details = await gitShowCommit(editor, hash);
  if (!details) return;
  const maxPreviewChars = 500_000;
  if (details.length > maxPreviewChars) {
    details = `${details.slice(0, maxPreviewChars)}\n[Commit preview truncated to keep the editor responsive.]\n`;
  }
  const entries = gitPreviewEntries(details);
  if (commitPreviewBufferId !== null && commitPreviewSplitId !== null) {
    if (editor.setVirtualBufferContent(commitPreviewBufferId, entries)) {
      editor.setSplitBuffer(commitPreviewSplitId, commitPreviewBufferId);
      editor.focusSplit(commitPreviewSplitId);
      editor.setLineWrap(commitPreviewBufferId, commitPreviewSplitId, true);
      editor.scrollBufferToLine(commitPreviewBufferId, commitPreviewTopLine);
      commitPreviewContent = details;
      return;
    }
  }
  const result = await editor.createVirtualBuffer({
    name: "Git Commit Preview",
    entries,
    readOnly: true,
    showLineNumbers: true,
  });
  commitPreviewBufferId = result.bufferId;
  commitPreviewSplitId = editor.getActiveSplitId();
  commitPreviewContent = details;
  commitPreviewTopLine = 1;
  editor.setLineWrap(commitPreviewBufferId, commitPreviewSplitId, true);
}

editor.on("viewport_changed", (event: { buffer_id: number; top_byte: number }) => {
  if (event.buffer_id !== commitPreviewBufferId) return;
  const end = Math.max(0, Math.min(event.top_byte, commitPreviewContent.length));
  commitPreviewTopLine = 1 + (commitPreviewContent.slice(0, end).match(/\n/g)?.length ?? 0);
});

function entriesForFile(content: string): TextPropertyEntry[] {
  return content.split("\n").map((line) => ({ text: `${line}\n` }));
}

/**
 * Fill the file review's two source buffers, reusing them across clicks.
 *
 * The composite is a layout record and is cheap to rebuild; creating two
 * virtual buffers per click is not, and each one pays full buffer ingest on
 * top. `setVirtualBufferContent` is the same call the commit preview already
 * uses to reuse its buffer; if it declines (buffer closed, or an older host)
 * we fall back to creating a fresh pair.
 */
async function loadDiffSources(
  name: string,
  oldText: string,
  newText: string,
): Promise<{ oldId: number; newId: number } | null> {
  const reused = diffSourceBuffers;
  if (
    reused &&
    editor.setVirtualBufferContent(reused.oldId, entriesForFile(oldText)) &&
    editor.setVirtualBufferContent(reused.newId, entriesForFile(newText))
  ) {
    return reused;
  }
  diffSourceBuffers = null;

  const oldRes = await editor.createVirtualBuffer({
    name,
    mode: "normal",
    entries: entriesForFile(oldText),
    readOnly: true,
    editingDisabled: true,
    hiddenFromTabs: true,
    showLineNumbers: true,
  });
  const newRes = await editor.createVirtualBuffer({
    name,
    mode: "normal",
    entries: entriesForFile(newText),
    readOnly: true,
    editingDisabled: true,
    hiddenFromTabs: true,
    showLineNumbers: true,
  });
  diffSourceBuffers = { oldId: oldRes.bufferId, newId: newRes.bufferId };
  return diffSourceBuffers;
}

async function previewChangedFile(path: string, staged: boolean): Promise<void> {
  const request = ++fileDiffRequest;
  const repoRoot = statusSummary?.repoRoot;
  if (!repoRoot) return;
  const diffInfo = await getGitFileDiffInfo(editor, repoRoot, path, staged);
  if (request !== fileDiffRequest) return;
  if (diffInfo.binary) {
    statusFeedback = `Cannot render a text diff for binary file: ${path}`;
    updatePanel();
    return;
  }
  if (diffInfo.changedLines > MAX_CHANGED_LINES_FOR_PATCH) {
    statusFeedback = `Diff skipped for responsiveness (>${MAX_CHANGED_LINES_FOR_PATCH.toLocaleString("en-US")} changed lines): ${path}`;
    updatePanel();
    return;
  }
  const snapshots = await getGitFileSnapshots(editor, repoRoot, path, staged);
  if (request !== fileDiffRequest) return;
  if (!snapshots) {
    editor.setStatus("Not inside a git repository");
    return;
  }

  if (snapshots.oldText.length + snapshots.newText.length > 2_000_000) {
    statusFeedback = `Diff skipped for responsiveness (file pair exceeds 2 MB): ${path}`;
    updatePanel();
    return;
  }
  const hunks = diffInfo.hunks.length > 0
    ? diffInfo.hunks
    : snapshots.oldText === snapshots.newText
    ? []
    : [{ oldStart: 0, oldCount: 0, newStart: 0, newCount: snapshots.newText.split("\n").length }];

  // Collapse everything the reader does not need BEFORE it becomes a buffer.
  // The panes are ordinary editor buffers, so their per-frame layout cost
  // scales with their size — this is what keeps a 500 KB file review as cheap
  // as a 200-line one.
  const collapsed = collapseUnchangedRanges(
    snapshots.oldText,
    snapshots.newText,
    hunks,
    DIFF_CONTEXT_LINES,
  );
  statusFeedback = "";
  const sources = await loadDiffSources(path, collapsed.oldText, collapsed.newText);
  if (!sources) return;
  if (request !== fileDiffRequest) return;
  const compositeId = await editor.createCompositeBuffer({
    name: `Git Diff: ${path}`,
    mode: "normal",
    layout: { type: "side-by-side", ratios: [0.5, 0.5], showSeparator: true },
    sources: [
      {
        bufferId: sources.oldId,
        label: staged ? "HEAD" : "INDEX",
        editable: false,
        style: { gutterStyle: "diff-markers" },
      },
      {
        bufferId: sources.newId,
        label: staged ? "INDEX" : "WORKING TREE",
        editable: false,
        style: { gutterStyle: "diff-markers" },
      },
    ],
    hunks: collapsed.hunks,
    initialFocusHunk: collapsed.hunks.length > 0 ? 0 : undefined,
  });
  if (request !== fileDiffRequest) {
    editor.closeCompositeBuffer(compositeId);
    return;
  }

  // Creating a composite only registers the buffer; it does not display it.
  // Attach it to the editor split just like the commit preview path does.
  const splitId = editor.getActiveSplitId();
  if (!editor.setSplitBuffer(splitId, compositeId)) {
    editor.closeCompositeBuffer(compositeId);
    statusFeedback = `Could not open diff for ${path}`;
    updatePanel();
    return;
  }
  editor.focusSplit(splitId);

  const previous = fileDiffPreview;
  fileDiffPreview = { compositeId, oldBufferId: sources.oldId, newBufferId: sources.newId };
  if (previous) {
    editor.closeCompositeBuffer(previous.compositeId);
  }
}

// Keep plugin-side handles in sync with tabs closed by the user. Composite
// source buffers are hidden from the tab bar, so closing the visible review
// tab must also release them and clear the cached IDs.
editor.on("buffer_closed", (event: { buffer_id: number }) => {
  const closedId = event.buffer_id;
  if (fileDiffPreview?.compositeId === closedId) {
    const closedPreview = fileDiffPreview;
    fileDiffPreview = null;
    diffSourceBuffers = null;
    // Do not make editor RPC calls while the host is still dispatching the
    // close hook. Fresh timers are editor-owned; QuickJS has no global
    // setTimeout/setInterval APIs.
    deferredDiffSourceCleanup.push({
      oldBufferId: closedPreview.oldBufferId,
      newBufferId: closedPreview.newBufferId,
    });
    editor.setTimeout(0, "git_cleanup_closed_diff_sources");
  }
  if (commitPreviewBufferId === closedId) {
    commitPreviewBufferId = null;
    commitPreviewSplitId = null;
    commitPreviewContent = "";
    commitPreviewTopLine = 1;
  }
  // A reused source buffer that went away must not be offered for reuse again.
  if (
    diffSourceBuffers &&
    (diffSourceBuffers.oldId === closedId || diffSourceBuffers.newId === closedId)
  ) {
    diffSourceBuffers = null;
  }
});

registerHandler("git_cleanup_closed_diff_sources", () => {
  for (const pending of deferredDiffSourceCleanup.splice(0)) {
    editor.closeBuffer(pending.oldBufferId, true);
    editor.closeBuffer(pending.newBufferId, true);
  }
});

function getStatusBadgeStyle(status: string): StyledSegment {
  switch (status) {
    case "added":
      return { text: " A ", style: { fg: "ui.file_status_added_fg", bold: true } };
    case "modified":
      return { text: " M ", style: { fg: "ui.file_status_modified_fg", bold: true } };
    case "deleted":
      return { text: " D ", style: { fg: "ui.file_status_deleted_fg", bold: true } };
    case "renamed":
      return { text: " R ", style: { fg: "ui.file_status_renamed_fg", bold: true } };
    case "untracked":
      return { text: " U ", style: { fg: "ui.file_status_untracked_fg", bold: true } };
    case "conflicted":
      return { text: " ! ", style: { fg: "ui.file_status_conflicted_fg", bold: true } };
    default:
      return { text: " · ", style: { fg: "editor.fg" } };
  }
}

function getChangePathStyle(status: string): StyledSegment["style"] {
  return getStatusBadgeStyle(status).style;
}

/**
 * Shorten a repo-relative path from the LEFT, keeping the filename intact.
 *
 * A monorepo path is mostly directory prefix nobody scans for
 * (`BE/webhook-delivery-service/src/main/java/com/paymenow/...`), and the tail
 * is the part that identifies the file. The panel is also narrow: without a
 * cap, a long path pushes the `-`/`+`/`↺` buttons past the sidebar edge, which
 * is how the actions stopped being clickable at all.
 */
function shortenPath(path: string, max = 38): string {
  if (path.length <= max) return path;
  const parts = path.split("/");
  const file = parts.pop() ?? "";
  const dir = parts.join("/");
  // Budget for the elided marker plus the separator.
  const keep = max - file.length - 2;
  if (keep <= 4) {
    return `…/${file.slice(Math.max(0, file.length - (max - 2)))}`;
  }
  return `…${dir.slice(Math.max(0, dir.length - keep))}/${file}`;
}

/**
 * Builds the widget spec tree for the Git Control Panel.
 */
/**
 * What a right press landed on: a changed file and where it sits, or a
 * commit in the graph.
 *
 * The row's buttons all name the same file in different keys, so the menu is
 * built from whichever one was pressed rather than from a second piece of
 * state kept in step with them.
 */
type ContextTarget =
  | { kind: "file"; path: string; staged: boolean }
  | { kind: "commit"; hash: string };

function contextTargetOf(key: string): ContextTarget | null {
  if (key.startsWith("git_preview_file:")) {
    const rest = key.slice("git_preview_file:".length);
    const sep = rest.indexOf(":");
    if (sep < 0) return null;
    return {
      kind: "file",
      staged: rest.slice(0, sep) === "staged",
      path: rest.slice(sep + 1),
    };
  }
  for (const prefix of ["git_open_file:", "git_stage:", "git_unstage:", "git_discard:"]) {
    if (key.startsWith(prefix)) {
      return { kind: "file", staged: false, path: key.slice(prefix.length) };
    }
  }
  if (key.startsWith("git_commit:")) {
    return { kind: "commit", hash: key.slice("git_commit:".length) };
  }
  return null;
}

/** `git_open_file:` and friends carry no side of the diff, so read it back
 *  from the status the panel already holds. */
function isStagedPath(path: string): boolean {
  return statusSummary?.staged.some((c) => c.path === path) ?? false;
}

/**
 * The menu a right press on this row opens.
 *
 * Declared on the button rather than built by the plugin: the host opens it
 * at the press's own cell, with the same geometry, ↑/↓ navigation and
 * outside-dismiss the file explorer's menu has, and the plugin is not asked
 * anything until an item is chosen. A plugin round-trip to open a menu is a
 * round-trip inside the press that asked for it — which is the one way to
 * open a menu that can end up re-entering the renderer.
 */
function contextMenuFor(target: ContextTarget): string[] {
  if (target.kind === "commit") {
    return [`Copy hash ${target.hash.slice(0, 8)}`];
  }
  const staged = target.staged || isStagedPath(target.path);
  const items = ["Open File", staged ? "Open Staged Diff" : "Open Changes"];
  if (staged) {
    items.push("Unstage Changes");
  } else {
    items.push("Stage Changes", "Discard Changes");
  }
  return items;
}

/** Run what the native menu offered. The host names the button the menu was
 *  opened from and the label chosen, so the plugin matches on both. */
async function runContextMenuChoice(key: string, label: string): Promise<void> {
  const target = contextTargetOf(key);
  if (!target) return;

  if (target.kind === "commit") {
    if (label.startsWith("Copy hash")) {
      editor.copyToClipboard(target.hash);
      statusFeedback = `Copied ${target.hash.slice(0, 8)}`;
      updatePanel();
    }
    return;
  }

  const path = target.path;
  const staged = target.staged || isStagedPath(path);
  switch (label) {
    case "Open File": {
      const repoRoot = statusSummary?.repoRoot;
      if (repoRoot && path) editor.openFile(`${repoRoot}/${path}`);
      return;
    }
    case "Open Staged Diff":
    case "Open Changes":
      await previewChangedFile(path, staged);
      return;
    case "Stage Changes":
      await stageFile(editor, path);
      break;
    case "Unstage Changes":
      await unstageFile(editor, path);
      break;
    case "Discard Changes":
      await discardFile(
        editor,
        path,
        statusSummary?.unstaged.find((c) => c.path === path)?.status === "untracked"
      );
      break;
    default:
      return;
  }
  statusFeedback = "";
  await refreshGitStatusData();
}

/** Tail-elide a commit subject. Not `shortenPath`: a subject has no
 *  separators to keep the tail of, and it wants the beginning — that is the
 *  part a commit is identified by. */
function shortenSubject(subject: string, max = 30): string {
  return subject.length <= max ? subject : `${subject.slice(0, max - 1)}…`;
}

export function buildGitPanelSpec(): WidgetSpec {
  const children: WidgetSpec[] = [];

  /** Which panel row each child starts on.
   *
   * The host reads a popup's `anchor` as `[row, col]` in panel-inner
   * coordinates, and an unanchored popup anchors to its own slot — which
   * spans the panel, so the menu pinned itself to the sidebar's left edge
   * and the neighbouring text painted over it. The spec is a flat column
   * built here, so its row count is a running total rather than a
   * measurement to be asked of the layout.
   */
  let rowCursor = 0;
  const push = (spec: WidgetSpec, rows = 1): void => {
    children.push(spec);
    rowCursor += rows;
  };

  // 1. Top status line: Branch & toolbar buttons
  const branchName = statusSummary
    ? `${statusSummary.branch}${statusSummary.upstream ? ` ⇄ ${statusSummary.upstream} ↑${statusSummary.ahead} ↓${statusSummary.behind}` : " · no upstream"}`
    : "no-repo";
  push(
    row(
      label(`\u{f126} ${branchName}`, { style: { bold: true, fg: "syntax.keyword" } }),
      flexSpacer(),
      button("⟳", {
        key: "git_refresh",
        bare: true,
        hoverStyle: { fg: "syntax.function" },
      }),
      spacer(1),
      button("Fetch", { key: "git_fetch", bare: true, hoverStyle: { fg: "syntax.function" } }),
      spacer(1),
      button("+ All", {
        key: "git_stage_all",
        bare: true,
        hoverStyle: { fg: "ui.file_status_added_fg" },
      }),
      spacer(1),
      button("- All", {
        key: "git_unstage_all",
        bare: true,
        hoverStyle: { fg: "ui.file_status_modified_fg" },
      })
    )
  );

  push(divider({ ch: "─" }));

  // 2. Commit message input box and Commit button
  push(
    row(
      textArea({
        value: commitText,
        key: "git_commit_msg",
        placeholder: "Message (Ctrl+Enter)",
        fullWidth: true,
        rows: 4,
        maxRows: 6,
      })
    ),
    4
  );
  push(row(flexSpacer(), button("Commit", {
    key: "git_commit_btn",
    intent: "primary",
  })));

  if (statusFeedback) {
    push(
      label(statusFeedback, { style: { fg: "diagnostic.error_fg" } })
    );
  }

  push(divider({ ch: "─" }));

  // 3. Staged Changes Section
  const stagedCount = statusSummary?.staged.length ?? 0;
  const stagedHeader = `${isStagedCollapsed ? "▶" : "▼"} STAGED CHANGES (${stagedCount})`;
  if (stagedCount > 0) {
    push(row(button(stagedHeader, {
      key: "git_toggle_staged",
      bare: true,
      style: { bold: true, fg: "ui.file_status_added_fg" },
    })));

    if (!isStagedCollapsed) {
      for (const item of statusSummary!.staged) {
        const badge = getStatusBadgeStyle(item.status);
        const path = shortenPath(item.path);
        // Right at the end of the name: no trailing space, because the menu
        // drops from this cell and one column of slack showed the panel's own
        // text in the gutter beside it.
        push(
          row(
            label(badge.text, { style: badge.style }),
            // Not `fullWidth`: a stretching label outgrows the sidebar and
            // pushes the action buttons off the edge, where they render but
            // cannot be hit. The spacer below already does the pushing.
            button(path, {
              key: `git_preview_file:staged:${item.path}`,
              bare: true,
              style: getChangePathStyle(item.status),
              hoverStyle: { fg: "syntax.function", underline: true, bold: true },
              contextMenu: contextMenuFor({
                kind: "file",
                staged: true,
                path: item.path,
              }),
            }),
            flexSpacer(),
            button("-", {
              key: `git_unstage:${item.path}`,
              bare: true,
              hoverStyle: { fg: "diagnostic.error_fg" },
            })
          )
        );
      }
    }
  }

  // 4. Changes (Unstaged) Section
  const unstagedCount = statusSummary?.unstaged.length ?? 0;
  const unstagedHeader = `${isUnstagedCollapsed ? "▶" : "▼"} CHANGES (${unstagedCount})`;
  if (unstagedCount > 0) {
    push(row(button(unstagedHeader, {
      key: "git_toggle_unstaged",
      bare: true,
      style: { bold: true, fg: "ui.file_status_modified_fg" },
    })));

  if (!isUnstagedCollapsed) {
      for (const item of statusSummary!.unstaged) {
        const badge = getStatusBadgeStyle(item.status);
        const path = shortenPath(item.path);
        push(
          row(
            label(badge.text, { style: badge.style }),
            button(path, {
              key: `git_preview_file:unstaged:${item.path}`,
              bare: true,
              style: getChangePathStyle(item.status),
              hoverStyle: { fg: "syntax.function", underline: true, bold: true },
              contextMenu: contextMenuFor({
                kind: "file",
                staged: false,
                path: item.path,
              }),
            }),
            flexSpacer(),
            button("+", {
              key: `git_stage:${item.path}`,
              bare: true,
              hoverStyle: { fg: "ui.file_status_added_fg" },
            }),
            spacer(1),
            button("↺", {
              key: `git_discard:${item.path}`,
              bare: true,
              hoverStyle: { fg: "diagnostic.error_fg" },
            })
          )
        );
      }
    }
  }

  if (stagedCount > 0 || unstagedCount > 0) push(divider({ ch: "─" }));

  // 5. Git Graph Section (Lower Half)
  const graphHeader = `${isGraphCollapsed ? "▶" : "▼"} GIT GRAPH`;
  push(
    row(
      button(graphHeader, {
        key: "git_toggle_graph",
        bare: true,
        style: { bold: true, fg: "syntax.type" },
      })
    )
  );

  if (!isGraphCollapsed) {
    if (graphLines.length === 0) {
      push(
        label("  (no graph commits)", { style: { fg: "editor.line_number_fg" } })
      );
    } else {
      for (const g of graphLines) {
        // The graph string is the first cell, then a space, the 7-char hash,
        // then a space — so the menu hangs off the end of the subject.
        const subject = shortenSubject(g.subject);
                push(
          row(
            label(g.graph, { style: { fg: "syntax.string", bold: true } }),
            spacer(1),
            label(g.hash ? g.hash.slice(0, 7) : "", { style: { fg: "syntax.number" } }),
            spacer(1),
            button(subject, { key: `git_commit:${g.hash}`, bare: true, fullWidth: true,
              style: { fg: "syntax.string" }, hoverStyle: { fg: "syntax.function", underline: true, bold: true },
              contextMenu: contextMenuFor({ kind: "commit", hash: g.hash }) })
          )
        );
      }
    }
  }

  return col(...children);
}

function updatePanel(): void {
  if (!isMounted) return;
  try {
    editor.updateFloatingWidget(PANEL_ID, buildGitPanelSpec());
  } catch {
    // Graceful fallback
  }
}

export function mountGitPanel(): void {
  if (isMounted) {
    editor.floatingPanelControl(PANEL_ID, "sidebar_view", 0);
    editor.floatingPanelControl(PANEL_ID, "focus", 0);
    return;
  }
  const spec = buildGitPanelSpec();
  editor.mountSidebarSection(PANEL_ID, spec, "Source Control", 0, {
    closable: false,
    startBlurred: true,
    scope: "editor",
  });
  editor.floatingPanelControl(PANEL_ID, "sidebar_view", 0);
  editor.floatingPanelControl(PANEL_ID, "focus", 0);
  isMounted = true;
  refreshGitData();
}

export function unmountGitPanel(): void {
  if (isMounted) {
    try {
      editor.unmountFloatingWidget(PANEL_ID);
    } catch {
      // Ignored
    }
    isMounted = false;
  }
}

// Widget event dispatcher
editor.on("widget_event", async (event: WidgetEvt) => {
  if (event.panel_id !== PANEL_ID) {
    return;
  }

  const key = event.widget_key ?? "";

  // Commit text input change
  if (key === "git_commit_msg" && event.event_type === "change") {
    commitText = String((event.payload as { value?: unknown })?.value ?? "");
    return;
  }

  // **A right press on a button that declared a menu.** The host opened the
  // menu itself — geometry, navigation and dismissal — and names the button
  // it was opened from plus the label chosen. It is not an `activate`, so it
  // has to be answered before the filter below.
  if (event.event_type === "plugin_menu") {
    const label = String((event.payload as { label?: unknown })?.label ?? "");
    await runContextMenuChoice(key, label);
    return;
  }

  // All remaining controls are click/activate actions
  if (event.event_type !== "activate" && event.event_type !== "select") {
    return;
  }

  // Toolbar actions
  if (key === "git_refresh") {
    statusFeedback = "Refreshing...";
    updatePanel();
    await refreshGitData();
    statusFeedback = "";
    updatePanel();
    return;
  }

  if (key === "git_fetch") {
    statusFeedback = "Fetching remote updates...";
    updatePanel();
    statusFeedback = (await fetchRemote(editor)) ?? "Remote status updated";
    await refreshGitData();
    updatePanel();
    return;
  }

  if (key === "git_stage_all") {
    await stageAll(editor);
    await refreshGitStatusData();
    return;
  }

  if (key === "git_unstage_all") {
    await unstageAll(editor);
    await refreshGitStatusData();
    return;
  }

  if (key === "git_commit_btn") {
    if (!commitText.trim()) {
      statusFeedback = "Please enter commit message";
      updatePanel();
      return;
    }
    statusFeedback = "Committing...";
    updatePanel();
    const error = await commitStaged(editor, commitText);
    if (error) {
      statusFeedback = error;
    } else {
      commitText = "";
      statusFeedback = "Committed successfully!";
      await refreshGitData();
    }
    updatePanel();
    return;
  }

  // Toggles
  if (key === "git_toggle_staged") {
    isStagedCollapsed = !isStagedCollapsed;
    updatePanel();
    return;
  }

  if (key.startsWith("git_commit:")) {
    const hash = key.slice("git_commit:".length);
    await showCommitPreview(hash);
    return;
  }

  if (key.startsWith("git_preview_file:")) {
    const selection = key.slice("git_preview_file:".length);
    const pathSeparator = selection.indexOf(":");
    const path = pathSeparator >= 0 ? selection.slice(pathSeparator + 1) : selection;
    await previewChangedFile(path, selection.startsWith("staged:"));
    return;
  }

  if (key.startsWith("git_open_file:")) {
    const path = key.slice("git_open_file:".length);
    const repoRoot = statusSummary?.repoRoot;
    if (repoRoot && path) {
      // VS Code's "Open File" from the source-control context menu: the
      // click itself stays on the diff, and an explicit button is what
      // reaches the editor.
      editor.openFile(`${repoRoot}/${path}`);
    }
    return;
  }

  if (key === "git_toggle_unstaged") {
    isUnstagedCollapsed = !isUnstagedCollapsed;
    updatePanel();
    return;
  }

  if (key === "git_toggle_graph") {
    isGraphCollapsed = !isGraphCollapsed;
    updatePanel();
    return;
  }

  // Item actions
  if (key.startsWith("git_stage:")) {
    const file = key.slice("git_stage:".length);
    statusFeedback = `Staging ${file}…`;
    updatePanel();
    const staged = await stageFile(editor, file);
    statusFeedback = staged ? "" : `Could not stage ${file}`;
    await refreshGitStatusData();
    return;
  }

  if (key.startsWith("git_unstage:")) {
    const file = key.slice("git_unstage:".length);
    statusFeedback = `Unstaging ${file}…`;
    updatePanel();
    const unstaged = await unstageFile(editor, file);
    statusFeedback = unstaged ? "" : `Could not unstage ${file}`;
    await refreshGitStatusData();
    return;
  }

  if (key.startsWith("git_discard:")) {
    const file = key.slice("git_discard:".length);
    const item = statusSummary?.unstaged.find((c) => c.path === file);
    const untracked = item?.status === "untracked";
    const discarded = await discardFile(editor, file, untracked);
    statusFeedback = discarded ? "" : `Could not discard ${file}`;
    await refreshGitStatusData();
    return;
  }
});

// Auto-refresh on editor buffer focus changes
editor.on("active_buffer_changed", () => {
  if (isMounted) {
    refreshGitStatusData();
  }
});

editor.on("active_window_changed", () => {
  if (isMounted) refreshGitData();
});

// Register into the Extensible View Registry
const registry = getViewRegistry();
registry.registerView({
  id: "git",
  title: "Source Control & Git Graph",
  icon: "\u{f126}", // Font Awesome 4 "code-fork" — the branch icon, and the oldest
                  // Nerd Font range (f000-f2ff), so it renders on far more fonts
                  // than f1d3 / f544, which showed as tofu or "?" on this box.
  hotkey: "Ctrl+Shift+G",
  order: 20,
  onActivate: () => {
    mountGitPanel();
  },
  onDeactivate: () => {
    unmountGitPanel();
  },
  render: () => buildGitPanelSpec(),
});

(globalThis as unknown as Record<string, unknown>).git_open_control_panel = () => {
  registry.setActiveView("git");
};

editor.registerCommand(
  "git:open_control_panel",
  "Source Control: Open Git Panel",
  "git_open_control_panel",
  null
);
