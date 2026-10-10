/// <reference path="./lib/fresh.d.ts" />

/**
 * Offline Jira-Compatible Backlog Panel
 *
 * Integrated TUI Kanban and Sprint tracker reading directly from
 * local Markdown backlogs (compatible with PayMeNow's Workspace/Backlog).
 */

import {
  button,
  col,
  divider,
  dropdown,
  label,
  row,
  spacer,
  wrappingRow,
  type WidgetSpec,
  type WidgetEvt,
} from "./lib/widgets.ts";
import {
  loadBacklog,
  updateTicketStatus,
  resolveTargetCodePath,
  setCustomBacklogRoot,
  getCustomBacklogRoot,
  type BacklogTicket,
  type BacklogWorkspace,
  type SprintInfo,
} from "./lib/jira_local_store.ts";
import { getViewRegistry } from "./lib/view_registry.ts";

const editor = getEditor();
const PANEL_ID = 403;

let isMounted = false;
let backlogWorkspace: BacklogWorkspace | null = null;
let activeSprintId: string = "";
let activeStatusFilter: "all" | "todo" | "in_progress" | "done" | "blocked" = "all";
let feedbackMessage: string = "";

// Pagination state to prevent viewport overflow with large backlogs
let currentPageIndex: number = 0;
let pageSize: number = 6; // 6 tickets per page fits comfortably in TUI sidebars

const STATUS_FILTER_KEYS: Array<"all" | "todo" | "in_progress" | "done" | "blocked"> = [
  "all",
  "todo",
  "in_progress",
  "done",
  "blocked",
];

export function refreshBacklogData(): void {
  try {
    backlogWorkspace = loadBacklog(editor);
    if (!backlogWorkspace || backlogWorkspace.sprints.length === 0) {
      feedbackMessage = "No backlog found. Expected Workspace/Backlog.";
    } else {
      feedbackMessage = "";
      // Default to the first sprint (e.g. Sprint-01) instead of all tickets
      if (!activeSprintId || !backlogWorkspace.sprints.some((s) => s.id === activeSprintId)) {
        activeSprintId = backlogWorkspace.sprints[0].id;
      }
    }
  } catch (err) {
    feedbackMessage = `Error reading backlog: ${String(err)}`;
  }

  if (isMounted) {
    updatePanel();
  }
}

function renderProgressBar(percent: number, width: number = 18): string {
  const filled = Math.round((percent / 100) * width);
  const empty = Math.max(0, width - filled);
  return `[${"█".repeat(filled)}${"░".repeat(empty)}] ${percent}%`;
}

function getPriorityBadge(priority: string): { text: string; fg: string } {
  const p = priority.toUpperCase();
  if (p.includes("CRIT")) return { text: "🔴 CRIT", fg: "syntax.error" };
  if (p.includes("HIGH")) return { text: "🟡 HIGH", fg: "syntax.keyword" };
  if (p.includes("MED")) return { text: "🟢 MED", fg: "syntax.string" };
  return { text: "⚪ LOW", fg: "editor.line_number_fg" };
}

function getStatusBadge(status: string): { text: string; fg: string } {
  const s = status.toUpperCase();
  if (s.includes("DONE") || s.includes("CLOSE")) {
    return { text: `✅ ${status}`, fg: "syntax.string" };
  }
  if (s.includes("IN_PROGRESS") || s.includes("IMPLEMENT")) {
    return { text: `🔄 ${status}`, fg: "syntax.keyword" };
  }
  if (s.includes("READY") || s.includes("CLAIM")) {
    return { text: `📋 ${status}`, fg: "syntax.type" };
  }
  return { text: `⏸️ ${status}`, fg: "editor.line_number_fg" };
}

/**
 * Open a Markdown file and immediately switch to Markdown Compose/Preview mode.
 */
function openMarkdownPreview(filePath: string): void {
  const ok = editor.openFile(filePath);
  if (ok) {
    try {
      editor.executeAction("markdownToggleCompose");
    } catch {}
  }
}

export function buildJiraPanelSpec(): WidgetSpec {
  if (!backlogWorkspace) {
    refreshBacklogData();
  }

  const widgets: WidgetSpec[] = [];

  // 1. Header with Title, Dynamic Path Config & Refresh
  const rootDisplay = backlogWorkspace?.rootPath
    ? backlogWorkspace.rootPath.replace(/^.*[\\/]([^\\/]+[\\/][^\\/]+)$/, "$1")
    : "Not detected";

  widgets.push(
    row(
      label("OFFLINE JIRA BACKLOG", {
        style: { bold: true, fg: "syntax.keyword" },
      }),
      button(" ⚙ Path ", {
        key: "jira_config_path",
        bare: true,
        style: { fg: "editor.line_number_fg" },
        hoverStyle: { fg: "syntax.function", bold: true },
      }),
      button(" ⟳ ", {
        key: "jira_refresh",
        bare: true,
        style: { fg: "syntax.function", bold: true },
        hoverStyle: { fg: "syntax.keyword", bold: true },
      })
    )
  );

  widgets.push(
    label(`📁 Root: ${rootDisplay}`, {
      style: { fg: "editor.line_number_fg" },
    })
  );

  if (!backlogWorkspace || backlogWorkspace.sprints.length === 0) {
    widgets.push(spacer(1));
    widgets.push(
      label("No active sprint backlog detected.", {
        style: { fg: "editor.line_number_fg" },
      })
    );
    widgets.push(
      label("Click [⚙ Path] to set your backlog directory path.", {
        style: { fg: "editor.line_number_fg" },
      })
    );
    widgets.push(spacer(1));
    widgets.push(
      button("Configure Path", {
        key: "jira_config_path",
        intent: "primary",
      })
    );
    return col(...widgets);
  }

  // 2. Sprint Dropdown Selector
  widgets.push(spacer(1));
  const sprintOptions: string[] = [];
  const sprintIds: string[] = [];

  for (const s of backlogWorkspace.sprints) {
    sprintIds.push(s.id);
    sprintOptions.push(`${s.id} (${s.tickets.length} tickets, ${s.completedSp}/${s.totalSp} SP)`);
  }
  sprintIds.push("all");
  sprintOptions.push(`All Sprints (${backlogWorkspace.allTickets.length} tickets)`);

  let currentSprintIdx = sprintIds.indexOf(activeSprintId);
  if (currentSprintIdx < 0) currentSprintIdx = 0;

  widgets.push(
    row(
      label("Sprint: ", { style: { bold: true, fg: "syntax.type" } }),
      dropdown(sprintOptions, {
        selectedIndex: currentSprintIdx,
        key: "jira_sprint_dropdown",
      })
    )
  );

  // 3. Sprint Summary & Board Open Affordance
  let curSprint: SprintInfo | null = null;
  if (activeSprintId !== "all") {
    curSprint = backlogWorkspace.sprints.find((s) => s.id === activeSprintId) || null;
  }

  widgets.push(spacer(1));
  if (curSprint) {
    widgets.push(
      row(
        label(curSprint.title, { style: { bold: true, fg: "syntax.variable" } }),
        button(" 📋 Open Board ", {
          key: `jira_open_sprint_board:${curSprint.id}`,
          bare: true,
          style: { fg: "syntax.function", bold: true },
          hoverStyle: { fg: "syntax.keyword", bold: true },
        })
      )
    );
    widgets.push(
      label(`Cycle: ${curSprint.cycle}`, {
        style: { fg: "editor.line_number_fg" },
      })
    );
    widgets.push(
      label(
        `Progress: ${renderProgressBar(curSprint.progressPercent)} (${curSprint.completedSp}/${curSprint.totalSp} SP)`,
        { style: { bold: true, fg: "syntax.string" } }
      )
    );
    if (curSprint.goal) {
      widgets.push(
        label(`Goal: ${curSprint.goal.slice(0, 105)}…`, {
          style: { fg: "editor.line_number_fg" },
          wrap: true,
        })
      );
    }
  } else {
    widgets.push(
      row(
        label("All Sprints Overview", { style: { bold: true, fg: "syntax.variable" } }),
        ...(backlogWorkspace.masterReadmePath
          ? [
              button(" 📋 Master Roadmap ", {
                key: "jira_open_master_roadmap",
                bare: true,
                style: { fg: "syntax.function", bold: true },
                hoverStyle: { fg: "syntax.keyword", bold: true },
              }),
            ]
          : [])
      )
    );
  }

  // 4. Status Filter Dropdown
  widgets.push(divider());

  let candidateTickets =
    activeSprintId === "all"
      ? backlogWorkspace.allTickets
      : curSprint
      ? curSprint.tickets
      : backlogWorkspace.allTickets;

  const totalCount = candidateTickets.length;
  const todoCount = candidateTickets.filter((t) => t.statusCategory === "todo").length;
  const inProgressCount = candidateTickets.filter((t) => t.statusCategory === "in_progress").length;
  const doneCount = candidateTickets.filter((t) => t.statusCategory === "done").length;
  const blockedCount = candidateTickets.filter((t) => t.statusCategory === "blocked").length;

  const filterOptions = [
    `All Statuses (${totalCount})`,
    `To Do / Ready (${todoCount})`,
    `In Progress (${inProgressCount})`,
    `Done (${doneCount})`,
    `Blocked / Gated (${blockedCount})`,
  ];

  const currentFilterIdx = STATUS_FILTER_KEYS.indexOf(activeStatusFilter);

  widgets.push(
    row(
      label("Filter: ", { style: { bold: true, fg: "syntax.type" } }),
      dropdown(filterOptions, {
        selectedIndex: currentFilterIdx >= 0 ? currentFilterIdx : 0,
        key: "jira_filter_dropdown",
      })
    )
  );

  let filteredTickets = candidateTickets;
  if (activeStatusFilter !== "all") {
    filteredTickets = candidateTickets.filter(
      (t) => t.statusCategory === activeStatusFilter
    );
  }

  // 5. Pagination & Ticket Count Bar
  const totalFiltered = filteredTickets.length;
  const effectivePageSize = pageSize > 0 ? pageSize : totalFiltered || 1;
  const totalPages = Math.max(1, Math.ceil(totalFiltered / effectivePageSize));

  if (currentPageIndex >= totalPages) {
    currentPageIndex = Math.max(0, totalPages - 1);
  }

  const startIdx = currentPageIndex * effectivePageSize;
  const endIdx = Math.min(startIdx + effectivePageSize, totalFiltered);
  const pagedTickets = filteredTickets.slice(startIdx, endIdx);

  widgets.push(spacer(1));
  widgets.push(
    row(
      label(`TICKETS (${totalFiltered})`, {
        style: { bold: true, fg: "syntax.keyword" },
      }),
      label(
        totalFiltered > 0
          ? ` [${startIdx + 1}-${endIdx}/${totalFiltered}]`
          : " [0/0]",
        { style: { fg: "editor.line_number_fg" } }
      ),
      ...(totalPages > 1
        ? [
            button(" ◀ ", {
              key: "jira_page_prev",
              bare: true,
              disabled: currentPageIndex === 0,
              style: { bold: true, fg: currentPageIndex === 0 ? "editor.line_number_fg" : "syntax.function" },
            }),
            label(`${currentPageIndex + 1}/${totalPages}`),
            button(" ▶ ", {
              key: "jira_page_next",
              bare: true,
              disabled: currentPageIndex >= totalPages - 1,
              style: { bold: true, fg: currentPageIndex >= totalPages - 1 ? "editor.line_number_fg" : "syntax.function" },
            }),
          ]
        : [])
    )
  );

  // Feedback notice
  if (feedbackMessage) {
    widgets.push(
      label(`ℹ ${feedbackMessage}`, {
        style: { bold: true, fg: "syntax.function" },
      })
    );
  }

  // 6. Ticket Cards
  if (pagedTickets.length === 0) {
    widgets.push(
      label("No tickets matching current filter.", {
        style: { fg: "editor.line_number_fg" },
      })
    );
  } else {
    for (const ticket of pagedTickets) {
      widgets.push(divider());
      const pBadge = getPriorityBadge(ticket.priority);
      const sBadge = getStatusBadge(ticket.status);

      // Top row: [WH-13] Priority  Status  (3 SP)
      widgets.push(
        row(
          label(`[${ticket.id}]`, {
            style: { bold: true, fg: "syntax.function" },
          }),
          label(` ${pBadge.text}`, {
            style: { bold: true, fg: pBadge.fg },
          }),
          label(` ${sBadge.text}`, {
            style: { fg: sBadge.fg },
          }),
          label(` (${ticket.storyPoints} SP)`, {
            style: { fg: "editor.line_number_fg" },
          })
        )
      );

      // Ticket Title is clickable -> Opens directly in Markdown Preview Mode!
      widgets.push(
        button(` 👁 ${ticket.title}`, {
          key: `jira_preview_ticket:${ticket.id}`,
          bare: true,
          fullWidth: true,
          style: { bold: true, fg: "editor.fg" },
          hoverStyle: { fg: "syntax.function", bold: true },
        })
      );

      // Target code file
      if (ticket.targetCodeFile) {
        widgets.push(
          label(`  🎯 Target: ${ticket.targetCodeFile}`, {
            style: { fg: "syntax.variable" },
            wrap: true,
          })
        );
      }

      // Actions row
      const actions: WidgetSpec[] = [];
      actions.push(
        button("👁 Preview", {
          key: `jira_preview_ticket:${ticket.id}`,
          bare: true,
          style: { fg: "syntax.keyword", bold: true },
          hoverStyle: { fg: "syntax.function", bold: true },
        })
      );

      actions.push(
        button("✎ Edit", {
          key: `jira_edit_ticket:${ticket.id}`,
          bare: true,
          style: { fg: "syntax.variable" },
          hoverStyle: { fg: "syntax.function", bold: true },
        })
      );

      if (ticket.targetCodeFile) {
        actions.push(
          button("🎯 Code", {
            key: `jira_open_code:${ticket.id}`,
            bare: true,
            style: { fg: "syntax.string", bold: true },
            hoverStyle: { fg: "syntax.function", bold: true },
          })
        );
      }

      // Quick status advance
      if (ticket.statusCategory === "todo") {
        actions.push(
          button("▶ Start", {
            key: `jira_set_status:${ticket.id}:IN_PROGRESS`,
            bare: true,
            style: { fg: "syntax.string", bold: true },
            hoverStyle: { fg: "syntax.keyword", bold: true },
          })
        );
      } else if (ticket.statusCategory === "in_progress") {
        actions.push(
          button("✓ Done", {
            key: `jira_set_status:${ticket.id}:DONE`,
            bare: true,
            style: { fg: "syntax.string", bold: true },
            hoverStyle: { fg: "syntax.function", bold: true },
          })
        );
      } else if (ticket.statusCategory === "done") {
        actions.push(
          button("↺ Reopen", {
            key: `jira_set_status:${ticket.id}:READY_FOR_DEV`,
            bare: true,
            style: { fg: "editor.line_number_fg" },
            hoverStyle: { fg: "syntax.keyword", bold: true },
          })
        );
      }

      actions.push(
        button("🌿 Branch", {
          key: `jira_branch:${ticket.id}`,
          bare: true,
          style: { fg: "editor.line_number_fg" },
          hoverStyle: { fg: "syntax.function", bold: true },
        })
      );

      widgets.push(wrappingRow(...actions));
    }
  }

  // 7. Footer Page Size & Navigation Controls
  if (totalPages > 1) {
    widgets.push(spacer(1));
    widgets.push(
      row(
        button("◀ Previous Page", {
          key: "jira_page_prev",
          bare: true,
          disabled: currentPageIndex === 0,
          style: { bold: true, fg: currentPageIndex === 0 ? "editor.line_number_fg" : "syntax.function" },
        }),
        label(` Page ${currentPageIndex + 1} of ${totalPages} `),
        button("Next Page ▶", {
          key: "jira_page_next",
          bare: true,
          disabled: currentPageIndex >= totalPages - 1,
          style: { bold: true, fg: currentPageIndex >= totalPages - 1 ? "editor.line_number_fg" : "syntax.function" },
        })
      )
    );
  }

  widgets.push(spacer(1));
  return col(...widgets);
}

function updatePanel(): void {
  if (!isMounted) return;
  try {
    editor.updateFloatingWidget(PANEL_ID, buildJiraPanelSpec());
  } catch {
    // Teardown fallback
  }
}

export function mountJiraPanel(): void {
  if (isMounted) {
    editor.floatingPanelControl(PANEL_ID, "sidebar_view", 0);
    editor.floatingPanelControl(PANEL_ID, "focus", 0);
    return;
  }

  refreshBacklogData();
  editor.mountSidebarSection(PANEL_ID, buildJiraPanelSpec(), "Jira Backlog", 0, {
    closable: false,
    startBlurred: true,
    scope: "editor",
  });
  editor.floatingPanelControl(PANEL_ID, "sidebar_view", 0);
  editor.floatingPanelControl(PANEL_ID, "focus", 0);
  isMounted = true;
}

export function unmountJiraPanel(): void {
  if (!isMounted) return;
  try {
    editor.unmountFloatingWidget(PANEL_ID);
  } catch {
    // Teardown fallback
  }
  isMounted = false;
}

// Widget event dispatcher
editor.on("widget_event", async (event: WidgetEvt) => {
  if (event.panel_id !== PANEL_ID) return;

  const key = event.widget_key || "";

  // Dropdown change events
  if (event.event_type === "change") {
    const payload = event.payload as { index?: number; value?: string } | undefined;
    const selectedIdx = payload?.index;

    if (key === "jira_sprint_dropdown" && typeof selectedIdx === "number" && backlogWorkspace) {
      const sprintIds: string[] = backlogWorkspace.sprints.map((s) => s.id);
      sprintIds.push("all");
      if (selectedIdx >= 0 && selectedIdx < sprintIds.length) {
        activeSprintId = sprintIds[selectedIdx];
        currentPageIndex = 0;
        feedbackMessage = `Switched to ${activeSprintId === "all" ? "All Sprints" : activeSprintId}.`;
        updatePanel();
      }
      return;
    }

    if (key === "jira_filter_dropdown" && typeof selectedIdx === "number") {
      if (selectedIdx >= 0 && selectedIdx < STATUS_FILTER_KEYS.length) {
        activeStatusFilter = STATUS_FILTER_KEYS[selectedIdx];
        currentPageIndex = 0;
        feedbackMessage = `Filter: ${activeStatusFilter.toUpperCase()}`;
        updatePanel();
      }
      return;
    }
    return;
  }

  if (event.event_type !== "activate" && event.event_type !== "select") return;

  // Header actions
  if (key === "jira_refresh") {
    refreshBacklogData();
    feedbackMessage = "Backlog refreshed.";
    updatePanel();
    return;
  }

  if (key === "jira_config_path") {
    const current = getCustomBacklogRoot() || backlogWorkspace?.rootPath || editor.getCwd();
    const chosen = await editor.prompt("Configure Backlog Path:", current);
    if (chosen !== null) {
      setCustomBacklogRoot(chosen);
      currentPageIndex = 0;
      refreshBacklogData();
      feedbackMessage = `Backlog path set to: ${chosen}`;
      updatePanel();
    }
    return;
  }

  // Open Sprint Board directly
  if (key.startsWith("jira_open_sprint_board:")) {
    const sId = key.slice("jira_open_sprint_board:".length);
    const sprint = backlogWorkspace?.sprints.find((s) => s.id === sId);
    if (sprint && sprint.boardPath) {
      openMarkdownPreview(sprint.boardPath);
      feedbackMessage = `Opened ${sId} board.`;
      updatePanel();
    }
    return;
  }

  if (key === "jira_open_master_roadmap") {
    if (backlogWorkspace?.masterReadmePath) {
      openMarkdownPreview(backlogWorkspace.masterReadmePath);
      feedbackMessage = "Opened Master Roadmap.";
      updatePanel();
    }
    return;
  }

  // Pagination navigation
  if (key === "jira_page_prev") {
    if (currentPageIndex > 0) {
      currentPageIndex--;
      updatePanel();
    }
    return;
  }

  if (key === "jira_page_next") {
    currentPageIndex++;
    updatePanel();
    return;
  }

  // Ticket Preview Mode (Markdown Compose)
  if (key.startsWith("jira_preview_ticket:")) {
    const ticketId = key.slice("jira_preview_ticket:".length);
    const ticket = backlogWorkspace?.allTickets.find((t) => t.id === ticketId);
    if (ticket && ticket.ticketFilePath) {
      openMarkdownPreview(ticket.ticketFilePath);
      feedbackMessage = `Opened ticket ${ticketId} in Preview mode.`;
      updatePanel();
    }
    return;
  }

  // Ticket Normal Edit Mode
  if (key.startsWith("jira_edit_ticket:")) {
    const ticketId = key.slice("jira_edit_ticket:".length);
    const ticket = backlogWorkspace?.allTickets.find((t) => t.id === ticketId);
    if (ticket && ticket.ticketFilePath) {
      editor.openFile(ticket.ticketFilePath);
      feedbackMessage = `Opened ticket ${ticketId} for editing.`;
      updatePanel();
    }
    return;
  }

  // Target Code Jump
  if (key.startsWith("jira_open_code:")) {
    const ticketId = key.slice("jira_open_code:".length);
    const ticket = backlogWorkspace?.allTickets.find((t) => t.id === ticketId);
    if (ticket && ticket.targetCodeFile) {
      const resolved = await resolveTargetCodePath(editor, ticket.targetCodeFile);
      if (resolved) {
        editor.openFile(resolved);
        feedbackMessage = `Opened target code: ${ticket.targetCodeFile}`;
      } else {
        feedbackMessage = `Could not locate file: ${ticket.targetCodeFile}`;
      }
      updatePanel();
    }
    return;
  }

  // Update Status
  if (key.startsWith("jira_set_status:")) {
    const parts = key.slice("jira_set_status:".length).split(":");
    const ticketId = parts[0];
    const newStatus = parts[1];
    const ticket = backlogWorkspace?.allTickets.find((t) => t.id === ticketId);
    if (ticket) {
      const ok = updateTicketStatus(editor, ticket, newStatus);
      if (ok) {
        feedbackMessage = `Ticket ${ticketId} moved to ${newStatus}.`;
        refreshBacklogData();
      } else {
        feedbackMessage = `Failed to update status for ${ticketId}.`;
      }
      updatePanel();
    }
    return;
  }

  // Create Git Branch
  if (key.startsWith("jira_branch:")) {
    const ticketId = key.slice("jira_branch:".length);
    const branchName = `feature/${ticketId.toLowerCase()}`;
    const cwd = editor.getCwd();
    try {
      const proc = editor.spawnProcess("git", ["checkout", "-b", branchName], cwd);
      await proc.result;
      feedbackMessage = `Created & switched to branch ${branchName}.`;
    } catch (e) {
      feedbackMessage = `Branch creation failed: ${String(e)}`;
    }
    updatePanel();
    return;
  }
});

// Register into the Extensible View Registry
const registry = getViewRegistry();
registry.registerView({
  id: "jira",
  title: "Offline Jira Backlog",
  icon: "\u{f0ae}", // Font Awesome 4 "tasks" glyph
  hotkey: "Ctrl+Shift+J",
  order: 35,
  onActivate: () => {
    mountJiraPanel();
  },
  onDeactivate: () => {
    unmountJiraPanel();
  },
  render: () => buildJiraPanelSpec(),
});

(globalThis as unknown as Record<string, unknown>).jira_open_panel = () => {
  registry.setActiveView("jira");
};

editor.registerCommand(
  "jira:open_panel",
  "Jira: Open Offline Backlog Panel",
  "jira_open_panel",
  null
);
