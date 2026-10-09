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

// Refresh git status and graph
export async function refreshGitData(): Promise<void> {
  try {
    statusSummary = await getGitStatus(editor);
    graphLines = await getGitGraph(editor, 25);
  } catch (err) {
    statusFeedback = "Failed to refresh git status";
  }
  if (isMounted) {
    updatePanel();
  }
}

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
            label(item.path, { style: { fg: "editor.fg" } }),
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
            label(item.path, { style: { fg: "editor.fg" } }),
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
              style: { fg: "editor.fg" }, hoverStyle: { fg: "syntax.function", underline: true } })
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
    await refreshGitData();
    return;
  }

  if (key === "git_unstage_all") {
    await unstageAll(editor);
    await refreshGitData();
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
    const details = await gitShowCommit(editor, hash);
    if (details) await editor.createVirtualBuffer({
      name: `Git: ${hash.slice(0, 7)}`,
      entries: details.split("\n").map((line) => ({ text: `${line}\n` })),
      readOnly: true,
      showLineNumbers: true,
    });
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
    await stageFile(editor, file);
    await refreshGitData();
    return;
  }

  if (key.startsWith("git_unstage:")) {
    const file = key.slice("git_unstage:".length);
    await unstageFile(editor, file);
    await refreshGitData();
    return;
  }

  if (key.startsWith("git_discard:")) {
    const file = key.slice("git_discard:".length);
    const item = statusSummary?.unstaged.find((c) => c.path === file);
    const untracked = item?.status === "untracked";
    await discardFile(editor, file, untracked);
    await refreshGitData();
    return;
  }
});

// Auto-refresh on editor buffer focus changes
editor.on("active_buffer_changed", () => {
  if (isMounted) {
    refreshGitData();
  }
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
