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
  hintBar,
  label,
  labeledSection,
  row,
  spacer,
  styledRow,
  text,
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
  type GitStatusSummary,
  type GitGraphLine,
  type GitFileChange,
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
    statusSummary = await getGitStatus(editor);
  } catch {
    statusFeedback = "Failed to refresh git status";
  }
  updatePanel();
}

function gitLineStyle(line: string): TextPropertyEntry["style"] {
  if (line.startsWith("+") && !line.startsWith("+++")) {
    return { fg: "ui.file_status_added_fg", bold: true };
  }
  if (line.startsWith("-") && !line.startsWith("---")) {
    return { fg: "ui.file_status_deleted_fg", bold: true };
  }
  if (line.startsWith("@@")) return { fg: "syntax.keyword", bold: true };
  if (line.startsWith("diff --git ")) return { fg: "syntax.type", bold: true };
  if (line.startsWith("commit ")) return { fg: "syntax.function", bold: true };
  if (/^(Author|Date|Commit|Merge):/.test(line)) return { fg: "syntax.keyword" };
  if (line.startsWith("index ")) return { fg: "syntax.number" };
  return { fg: "editor.fg" };
}

function gitStatSegments(line: string): StyledSegment[] | undefined {
  const bar = line.match(/^(.*\|\s*\d+\s+)(\+*)(-*)(\s*)$/);
  if (bar && (bar[2] || bar[3])) {
    return [
      { text: bar[1] },
      ...(bar[2] ? [{ text: bar[2], style: { fg: "ui.file_status_added_fg", bold: true } }] : []),
      ...(bar[3] ? [{ text: bar[3], style: { fg: "ui.file_status_deleted_fg", bold: true } }] : []),
      ...(bar[4] ? [{ text: bar[4] }] : []),
    ];
  }

  const countPattern = /\d+ insertions?\(\+\)|\d+ deletions?\(-\)/g;
  const segments: StyledSegment[] = [];
  let cursor = 0;
  for (const match of line.matchAll(countPattern)) {
    const index = match.index ?? 0;
    if (index > cursor) segments.push({ text: line.slice(cursor, index) });
    const added = match[0].includes("insert");
    segments.push({
      text: match[0],
      style: { fg: added ? "ui.file_status_added_fg" : "ui.file_status_deleted_fg", bold: true },
    });
    cursor = index + match[0].length;
  }
  if (cursor === 0) return undefined;
  if (cursor < line.length) segments.push({ text: line.slice(cursor) });
  return segments;
}

function gitPreviewEntries(content: string): TextPropertyEntry[] {
  return content.split("\n").map((line) => {
    const statSegments = gitStatSegments(line);
    return {
      text: `${line}\n`,
      style: gitLineStyle(line),
      ...(statSegments ? { segments: [...statSegments, { text: "\n" }] } : {}),
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
}

editor.on("viewport_changed", (event: { buffer_id: number; top_byte: number }) => {
  if (event.buffer_id !== commitPreviewBufferId) return;
  const end = Math.max(0, Math.min(event.top_byte, commitPreviewContent.length));
  commitPreviewTopLine = 1 + (commitPreviewContent.slice(0, end).match(/\n/g)?.length ?? 0);
});

function entriesForFile(content: string): TextPropertyEntry[] {
  return content.split("\n").map((line) => ({ text: `${line}\n` }));
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
  if (diffInfo.changedLines > 2000) {
    statusFeedback = `Diff skipped for responsiveness (>2,000 changed lines): ${path}`;
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
  statusFeedback = "";
  const oldRes = await editor.createVirtualBuffer({
    name: path,
    mode: "normal",
    entries: entriesForFile(snapshots.oldText),
    readOnly: true,
    editingDisabled: true,
    hiddenFromTabs: true,
    showLineNumbers: true,
  });
  if (request !== fileDiffRequest) {
    editor.closeBuffer(oldRes.bufferId, true);
    return;
  }
  const newRes = await editor.createVirtualBuffer({
    name: path,
    mode: "normal",
    entries: entriesForFile(snapshots.newText),
    readOnly: true,
    editingDisabled: true,
    hiddenFromTabs: true,
    showLineNumbers: true,
  });
  if (request !== fileDiffRequest) {
    editor.closeBuffer(oldRes.bufferId, true);
    editor.closeBuffer(newRes.bufferId, true);
    return;
  }

  const compositeId = await editor.createCompositeBuffer({
    name: `Git Diff: ${path}`,
    mode: "normal",
    layout: { type: "side-by-side", ratios: [0.5, 0.5], showSeparator: true },
    sources: [
      {
        bufferId: oldRes.bufferId,
        label: staged ? "HEAD" : "INDEX",
        editable: false,
        style: { gutterStyle: "diff-markers" },
      },
      {
        bufferId: newRes.bufferId,
        label: staged ? "INDEX" : "WORKING TREE",
        editable: false,
        style: { gutterStyle: "diff-markers" },
      },
    ],
    hunks,
    initialFocusHunk: hunks.length > 0 ? 0 : undefined,
  });
  if (request !== fileDiffRequest) {
    editor.closeCompositeBuffer(compositeId);
    editor.closeBuffer(oldRes.bufferId, true);
    editor.closeBuffer(newRes.bufferId, true);
    return;
  }

  const previous = fileDiffPreview;
  fileDiffPreview = { compositeId, oldBufferId: oldRes.bufferId, newBufferId: newRes.bufferId };
  if (previous) {
    editor.closeCompositeBuffer(previous.compositeId);
    editor.closeBuffer(previous.oldBufferId, true);
    editor.closeBuffer(previous.newBufferId, true);
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
    // Do not make editor RPC calls while the host is still dispatching the
    // close hook; defer source cleanup to avoid re-entrant close deadlocks.
    setTimeout(() => {
      editor.closeBuffer(closedPreview.oldBufferId, true);
      editor.closeBuffer(closedPreview.newBufferId, true);
    }, 0);
  }
  if (commitPreviewBufferId === closedId) {
    commitPreviewBufferId = null;
    commitPreviewSplitId = null;
    commitPreviewContent = "";
    commitPreviewTopLine = 1;
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
 * Builds the widget spec tree for the Git Control Panel.
 */
export function buildGitPanelSpec(): WidgetSpec {
  const children: WidgetSpec[] = [];

  // 1. Top status line: Branch & toolbar buttons
  const branchName = statusSummary
    ? `${statusSummary.branch}${statusSummary.upstream ? ` ⇄ ${statusSummary.upstream} ↑${statusSummary.ahead} ↓${statusSummary.behind}` : " · no upstream"}`
    : "no-repo";
  children.push(
    row(
      label(`\u{e702} ${branchName}`, { style: { bold: true, fg: "syntax.keyword" } }),
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

  children.push(divider({ ch: "─" }));

  // 2. Commit message input box and Commit button
  children.push(
    row(
      textArea({
        value: commitText,
        key: "git_commit_msg",
        placeholder: "Message (Ctrl+Enter)",
        fullWidth: true,
        rows: 4,
        maxRows: 6,
      })
    )
  );
  children.push(row(flexSpacer(), button("Commit", {
    key: "git_commit_btn",
    intent: "primary",
  })));

  if (statusFeedback) {
    children.push(
      label(statusFeedback, { style: { fg: "diagnostic.error_fg" } })
    );
  }

  children.push(divider({ ch: "─" }));

  // 3. Staged Changes Section
  const stagedCount = statusSummary?.staged.length ?? 0;
  const stagedHeader = `${isStagedCollapsed ? "▶" : "▼"} STAGED CHANGES (${stagedCount})`;
  if (stagedCount > 0) {
    children.push(row(button(stagedHeader, {
      key: "git_toggle_staged",
      bare: true,
      style: { bold: true, fg: "ui.file_status_added_fg" },
    })));

    if (!isStagedCollapsed) {
      for (const item of statusSummary!.staged) {
        const badge = getStatusBadgeStyle(item.status);
        children.push(
          row(
            label(badge.text, { style: badge.style }),
            button(item.path, {
              key: `git_preview_file:staged:${item.path}`,
              bare: true,
              fullWidth: true,
              style: getChangePathStyle(item.status),
              hoverStyle: { fg: "syntax.function", underline: true, bold: true },
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
    children.push(row(button(unstagedHeader, {
      key: "git_toggle_unstaged",
      bare: true,
      style: { bold: true, fg: "ui.file_status_modified_fg" },
    })));

  if (!isUnstagedCollapsed) {
      for (const item of statusSummary!.unstaged) {
        const badge = getStatusBadgeStyle(item.status);
        children.push(
          row(
            label(badge.text, { style: badge.style }),
            button(item.path, {
              key: `git_preview_file:unstaged:${item.path}`,
              bare: true,
              fullWidth: true,
              style: getChangePathStyle(item.status),
              hoverStyle: { fg: "syntax.function", underline: true, bold: true },
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

  if (stagedCount > 0 || unstagedCount > 0) children.push(divider({ ch: "─" }));

  // 5. Git Graph Section (Lower Half)
  const graphHeader = `${isGraphCollapsed ? "▶" : "▼"} GIT GRAPH`;
  children.push(
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
      children.push(
        label("  (no graph commits)", { style: { fg: "editor.line_number_fg" } })
      );
    } else {
      for (const g of graphLines) {
        children.push(
          row(
            label(g.graph, { style: { fg: "syntax.string", bold: true } }),
            spacer(1),
            label(g.hash ? g.hash.slice(0, 7) : "", { style: { fg: "syntax.number" } }),
            spacer(1),
            button(g.subject, { key: `git_commit:${g.hash}`, bare: true, fullWidth: true,
              style: { fg: "syntax.string" }, hoverStyle: { fg: "syntax.function", underline: true, bold: true } })
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
  icon: "\u{e702}",
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
