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
  dropdown,
  flexSpacer,
  label,
  labeledSection,
  row,
  spacer,
  textArea,
  textInput,
  type WidgetSpec,
  type WidgetEvt,
  type StyledSegment,
  type TextPropertyEntry,
} from "./lib/widgets.ts";
import {
  getGitStatus,
  getGitGraph,
  getGitBranches,
  checkoutBranch,
  createBranch,
  deleteBranch,
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
let availableBranches: string[] = [];
let currentBranchName = "";
let commitText = "";
let isCommitMsgFocused = false;
let isRefreshing = false;
let pendingRefresh = false;
let statusFeedback = "";
let isStagedCollapsed = false;
let isUnstagedCollapsed = false;
let isGraphCollapsed = false;
let isMounted = false;

// Modal dialog state for Branch operations (Large pop-up cards)
let activeBranchDialog: "none" | "create" | "delete" = "none";
let newBranchInputName = "";
let deleteBranchSelectedIdx = 0;
let deleteBranchForce = false;
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

// Refresh git status, graph, and branches with serialization/debounce
export async function refreshGitData(): Promise<void> {
  if (isRefreshing) {
    pendingRefresh = true;
    return;
  }
  isRefreshing = true;
  try {
    const [status, graph, branchInfo] = await Promise.all([
      getGitStatus(editor),
      getGitGraph(editor, 25),
      getGitBranches(editor),
    ]);
    statusSummary = status;
    graphLines = graph;
    availableBranches = branchInfo.branches;
    currentBranchName = branchInfo.current || status?.branch || "";
  } catch {
    statusFeedback = "Failed to refresh git status";
  } finally {
    isRefreshing = false;
  }

  if (pendingRefresh) {
    pendingRefresh = false;
    return refreshGitData();
  }

  if (isMounted) {
    updatePanel();
  }
}

// File staging does not change the commit graph. Avoid resolving the repo and
// spawning `git log` after every + / - click.
async function refreshGitStatusData(): Promise<void> {
  if (isRefreshing) {
    pendingRefresh = true;
    return;
  }
  isRefreshing = true;
  try {
    // The working tree just moved under us (staging, discard, save), so any
    // memoized blob from before this refresh is no longer the truth.
    clearGitFileCaches();
    const [status, branchInfo] = await Promise.all([
      getGitStatus(editor),
      getGitBranches(editor),
    ]);
    statusSummary = status;
    availableBranches = branchInfo.branches;
    currentBranchName = branchInfo.current || status?.branch || "";
  } catch {
    statusFeedback = "Failed to refresh git status";
  } finally {
    isRefreshing = false;
  }

  if (pendingRefresh) {
    pendingRefresh = false;
    return refreshGitStatusData();
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
 * What a right press landed on: a changed file and where it sits, or a
 * commit in the graph.
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

/** Run what the native menu offered. */
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

/**
 * Calculate available display width of the sidebar dynamically.
 * Default fallback is 40 columns if dockCols is unset or 0.
 */
function getSidebarWidth(): number {
  try {
    const cols = editor.dockCols();
    if (typeof cols === "number" && cols > 15) {
      return cols;
    }
  } catch {}
  return 40;
}

/**
 * Shorten a repo-relative path from the LEFT, keeping the filename intact.
 *
 * Dynamically budgets based on current sidebar width minus action buttons (+, ↺ / -)
 * and status badge, ensuring buttons are always pinned on the right and never pushed off.
 */
function shortenPath(path: string, reservedActionsWidth = 10): string {
  const sidebarCols = getSidebarWidth();
  // Budget available for path: sidebar width minus margins/badges/action buttons
  const max = Math.max(12, sidebarCols - reservedActionsWidth);
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

  // 1. Top status line: Title & toolbar buttons (no + All / - All)
  push(
    row(
      label(`\u{f126} Source Control`, { style: { bold: true, fg: "syntax.keyword" } }),
      flexSpacer(),
      button("⟳", {
        key: "git_refresh",
        bare: true,
        hoverStyle: { fg: "syntax.function" },
      }),
      spacer(1),
      button("Fetch", { key: "git_fetch", bare: true, hoverStyle: { fg: "syntax.function" } })
    )
  );

  // Branch Selection Dropdown with New (+) and Delete (🗑) actions
  if (availableBranches.length > 0) {
    let branchIdx = availableBranches.indexOf(currentBranchName);
    if (branchIdx < 0) {
      if (currentBranchName) {
        availableBranches.unshift(currentBranchName);
        branchIdx = 0;
      } else {
        branchIdx = 0;
      }
    }

    push(
      row(
        label("Branch: ", { style: { bold: true, fg: "syntax.type" } }),
        dropdown(availableBranches, {
          selectedIndex: branchIdx,
          key: "git_branch_dropdown",
        }),
        flexSpacer(),
        button(" + ", {
          key: "git_branch_new",
          bare: true,
          style: { fg: "syntax.string", bold: true },
          hoverStyle: { fg: "syntax.keyword", bold: true },
        }),
        spacer(1),
        button(" 🗑 ", {
          key: "git_branch_del",
          bare: true,
          style: { fg: "syntax.error" },
          hoverStyle: { fg: "syntax.keyword", bold: true },
        })
      )
    );

    if (statusSummary?.upstream) {
      const aheadBehind = statusSummary.ahead || statusSummary.behind
        ? ` (↑${statusSummary.ahead} ↓${statusSummary.behind})`
        : "";
      push(
        label(`  ⇄ ${statusSummary.upstream}${aheadBehind}`, {
          style: { fg: "editor.line_number_fg" },
        })
      );
    }
  } else if (statusSummary?.branch) {
    push(
      row(
        label(`\u{f126} ${statusSummary.branch}`, {
          style: { bold: true, fg: "syntax.keyword" },
        }),
        flexSpacer(),
        button(" + ", {
          key: "git_branch_new",
          bare: true,
          style: { fg: "syntax.string", bold: true },
          hoverStyle: { fg: "syntax.keyword", bold: true },
        })
      )
    );
  }

  // --- Prominent Pop-up Modal Dialogs for Branch Creation & Deletion ---
  if (activeBranchDialog === "create") {
    push(
      labeledSection({
        label: "Create New Branch",
        child: col(
          label("Enter branch name:"),
          textInput(newBranchInputName, {
            key: "dialog_branch_name_input",
            placeholder: "e.g. feature/my-branch",
            fullWidth: true,
            focused: true,
          }),
          spacer(1),
          row(
            flexSpacer(),
            button("Cancel", {
              key: "dialog_branch_cancel",
              bare: false,
            }),
            spacer(1),
            button("Create & Checkout", {
              key: "dialog_branch_create_confirm",
              intent: "primary",
            })
          )
        ),
      }),
      5
    );
  } else if (activeBranchDialog === "delete") {
    const deletableBranches = availableBranches.filter((b) => b !== currentBranchName);
    const delIdx = Math.min(deleteBranchSelectedIdx, Math.max(0, deletableBranches.length - 1));
    push(
      labeledSection({
        label: "Delete Branch",
        child: col(
          deletableBranches.length > 0
            ? col(
                label("Select branch to delete:"),
                dropdown(deletableBranches, {
                  selectedIndex: delIdx,
                  key: "dialog_del_branch_dropdown",
                }),
                spacer(1),
                row(
                  button(deleteBranchForce ? "[v] Force delete (-D)" : "[ ] Force delete (-D)", {
                    key: "dialog_del_toggle_force",
                    bare: true,
                    style: { fg: deleteBranchForce ? "syntax.error" : "editor.fg" },
                  })
                )
              )
            : label("No other local branches to delete.", { style: { fg: "editor.line_number_fg" } }),
          spacer(1),
          row(
            flexSpacer(),
            button("Cancel", {
              key: "dialog_branch_cancel",
              bare: false,
            }),
            spacer(1),
            button("Delete", {
              key: "dialog_branch_delete_confirm",
              intent: "danger",
              disabled: deletableBranches.length === 0,
            })
          )
        ),
      }),
      6
    );
  }

  push(divider({ ch: "─" }));

  // 2. Commit message input box and Commit button (follows tab width)
  push(
    row(
      textArea({
        value: commitText,
        key: "git_commit_msg",
        placeholder: "Message (Ctrl+Enter)",
        fullWidth: true,
        rows: 4,
        maxRows: 6,
        blockCaret: true,
        focused: isCommitMsgFocused,
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

  // 3. Staged Changes Section (Action buttons pinned to rightmost edge)
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
        // Reserve 8 cols for badge (3) + flexSpacer + action button (1) + safety margin (4)
        const path = shortenPath(item.path, 8);
        push(
          row(
            label(badge.text, { style: badge.style }),
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

  // 4. Changes (Unstaged) Section (Action buttons pinned to rightmost edge)
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
        // Reserve 12 cols for badge (3) + flexSpacer + actions [+] [↺] (4) + safety margins (5)
        const path = shortenPath(item.path, 12);
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

  // 5. Git Graph Section (Lower Half: dynamically fits available width)
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
        push(
          row(
            label(g.graph, { style: { fg: "syntax.string", bold: true } }),
            spacer(1),
            label(g.hash ? g.hash.slice(0, 7) : "", { style: { fg: "syntax.number" } }),
            spacer(1),
            button(g.subject, {
              key: `git_commit:${g.hash}`,
              bare: true,
              style: { fg: "syntax.string" },
              hoverStyle: { fg: "syntax.function", underline: true, bold: true },
              contextMenu: contextMenuFor({ kind: "commit", hash: g.hash }),
            })
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
  if (key === "git_commit_msg") {
    isCommitMsgFocused = true;
    if (event.event_type === "change") {
      commitText = String((event.payload as { value?: unknown })?.value ?? "");
    }
    return;
  }

  // Branch selection dropdown change (optimized with optimistic update)
  if (key === "git_branch_dropdown" && event.event_type === "change") {
    const payload = event.payload as { index?: number; value?: string } | undefined;
    const selectedIdx = payload?.index;
    if (
      typeof selectedIdx === "number" &&
      selectedIdx >= 0 &&
      selectedIdx < availableBranches.length
    ) {
      const targetBranch = availableBranches[selectedIdx];
      if (targetBranch && targetBranch !== currentBranchName) {
        statusFeedback = `Switching to branch '${targetBranch}'...`;
        currentBranchName = targetBranch; // optimistic UI update
        updatePanel();
        const res = await checkoutBranch(editor, targetBranch);
        if (res.success) {
          statusFeedback = `Switched to branch '${targetBranch}'.`;
        } else {
          statusFeedback = res.message || `Failed to checkout '${targetBranch}'`;
        }
        await refreshGitData();
      }
    }
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

  // Branch create input text change
  if (key === "dialog_branch_name_input" && event.event_type === "change") {
    newBranchInputName = String((event.payload as { value?: unknown })?.value ?? "");
    return;
  }

  // Branch delete dropdown selection change
  if (key === "dialog_del_branch_dropdown" && event.event_type === "change") {
    const payload = event.payload as { index?: number } | undefined;
    if (typeof payload?.index === "number") {
      deleteBranchSelectedIdx = payload.index;
      updatePanel();
    }
    return;
  }

  // Branch delete force toggle
  if (key === "dialog_del_toggle_force") {
    deleteBranchForce = !deleteBranchForce;
    updatePanel();
    return;
  }

  // Close / Cancel Branch dialog
  if (key === "dialog_branch_cancel") {
    activeBranchDialog = "none";
    newBranchInputName = "";
    statusFeedback = "";
    updatePanel();
    return;
  }

  // Confirm Branch Creation
  if (key === "dialog_branch_create_confirm") {
    const name = newBranchInputName.trim();
    if (!name) {
      statusFeedback = "Branch name cannot be empty";
      updatePanel();
      return;
    }
    statusFeedback = `Creating branch '${name}'...`;
    activeBranchDialog = "none";
    updatePanel();
    const res = await createBranch(editor, name, true);
    statusFeedback = res.message;
    await refreshGitData();
    return;
  }

  // Confirm Branch Deletion
  if (key === "dialog_branch_delete_confirm") {
    const deletableBranches = availableBranches.filter((b) => b !== currentBranchName);
    const targetBranch = deletableBranches[deleteBranchSelectedIdx];
    if (!targetBranch) {
      statusFeedback = "Please select a branch to delete";
      updatePanel();
      return;
    }
    statusFeedback = `Deleting branch '${targetBranch}'...`;
    activeBranchDialog = "none";
    updatePanel();
    const res = await deleteBranch(editor, targetBranch, deleteBranchForce);
    if (!res.success && !deleteBranchForce && res.message.toLowerCase().includes("not fully merged")) {
      statusFeedback = `Branch '${targetBranch}' is not fully merged. Enable [Force delete] to delete.`;
      // Re-open dialog with force option highlighted
      activeBranchDialog = "delete";
      deleteBranchForce = true;
      updatePanel();
      return;
    }
    statusFeedback = res.message;
    await refreshGitData();
    return;
  }

  // Branch create (+) button clicked -> Open large pop-up card
  if (key === "git_branch_new") {
    activeBranchDialog = "create";
    newBranchInputName = "";
    statusFeedback = "";
    updatePanel();
    return;
  }

  // Branch delete (🗑) button clicked -> Open large pop-up card with dropdown
  if (key === "git_branch_del") {
    activeBranchDialog = "delete";
    deleteBranchSelectedIdx = 0;
    deleteBranchForce = false;
    statusFeedback = "";
    updatePanel();
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
