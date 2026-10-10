/// <reference path="./lib/fresh.d.ts" />

/**
 * Offline Jira-Compatible Backlog Panel
 *
 * Professional, minimal, keyboard-first TUI inspired by Linear and Lazygit.
 * Sidebar acts as a compact navigation overview, while full ticket inspection
 * and operations are hosted in a native editor virtual buffer.
 */

import {
  button,
  col,
  divider,
  dropdown,
  flexSpacer,
  hintBar,
  label,
  list,
  row,
  spacer,
  type WidgetSpec,
  type WidgetEvt,
  type HintEntry,
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
const DETAIL_MODE = "jira-ticket-detail";
const SIDEBAR_MODE = "jira-sidebar";

// ── Plugin State ─────────────────────────────────────────────────────────────

let isMounted = false;
let backlogWorkspace: BacklogWorkspace | null = null;
let activeSprintId: string = "";
let activeStatusFilter: "all" | "todo" | "in_progress" | "done" | "blocked" = "all";
let sortMode: "prio" | "points" | "id" = "prio";
let searchQuery: string = "";
let selectedTicketIndex: number = 0;
let showHelp: boolean = false;
let feedbackMessage: string = "";

const SORT_MODES: Array<"prio" | "points" | "id"> = ["prio", "points", "id"];
const SORT_OPTIONS: string[] = ["Sort: Prio", "Sort: Points", "Sort: ID"];

// Tracks currently open detail virtual buffer
let detailBufferId: number | null = null;
let activeDetailTicketId: string | null = null;

const STATUS_FILTER_KEYS: Array<"all" | "todo" | "in_progress" | "done" | "blocked"> = [
  "all",
  "todo",
  "in_progress",
  "done",
  "blocked",
];

// ── Width & Text Helpers ─────────────────────────────────────────────────────

function getSidebarWidth(): number {
  try {
    const cols = editor.dockCols();
    if (typeof cols === "number" && cols >= 16) {
      return cols;
    }
  } catch {}
  return 36;
}

function truncateToCols(text: string, maxCols: number): string {
  if (maxCols <= 0) return "";
  if (editor.stringWidth(text) <= maxCols) return text;
  let out = "";
  for (const ch of text) {
    if (editor.stringWidth(out + ch + "…") > maxCols) break;
    out += ch;
  }
  return out ? out + "…" : "";
}

function getByteLength(str: string): number {
  let s = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code <= 0x7f) s += 1;
    else if (code <= 0x7ff) s += 2;
    else if (code >= 0xd800 && code <= 0xdfff) {
      s += 4;
      i++;
    } else s += 3;
  }
  return s;
}

function renderProgressBar(percent: number, barWidth: number): string {
  const safeBarWidth = Math.max(4, barWidth);
  const filled = Math.min(safeBarWidth, Math.max(0, Math.round((percent / 100) * safeBarWidth)));
  const empty = Math.max(0, safeBarWidth - filled);
  return `${"█".repeat(filled)}${"░".repeat(empty)}`;
}

// ── Status & Priority Badging ────────────────────────────────────────────────

function getStatusGlyph(statusCategory: string): { glyph: string; fg: string } {
  switch (statusCategory) {
    case "done":
      return { glyph: "✓", fg: "syntax.string" };
    case "in_progress":
      return { glyph: "●", fg: "syntax.keyword" };
    case "todo":
      return { glyph: "○", fg: "syntax.type" };
    case "blocked":
      return { glyph: "■", fg: "syntax.error" };
    default:
      return { glyph: "·", fg: "editor.line_number_fg" };
  }
}

function getPriorityStyle(priority: string): { fg: string; bold: boolean } {
  const p = (priority || "").toUpperCase();
  if (p.includes("CRIT") || p.includes("BLOCK")) {
    return { fg: "diagnostic.error_fg", bold: true };
  }
  if (p.includes("HIGH")) {
    return { fg: "syntax.string", bold: false };
  }
  if (p.includes("MED")) {
    return { fg: "diagnostic.warning_fg", bold: false };
  }
  // Low or other: light blue / cyan
  return { fg: "syntax.variable", bold: false };
}

function getPriorityFg(priority: string): string {
  return getPriorityStyle(priority).fg;
}

function getPriorityWeight(priority: string): number {
  const p = (priority || "").toUpperCase();
  if (p.includes("CRIT") || p.includes("BLOCK")) return 4;
  if (p.includes("HIGH")) return 3;
  if (p.includes("MED")) return 2;
  return 1;
}

// ── Data Filtering & Ordering ────────────────────────────────────────────────

function getCandidateTickets(): BacklogTicket[] {
  if (!backlogWorkspace) return [];
  if (activeSprintId === "all") {
    return backlogWorkspace.allTickets;
  }
  const curSprint = backlogWorkspace.sprints.find((s) => s.id === activeSprintId);
  return curSprint ? curSprint.tickets : backlogWorkspace.allTickets;
}

function getFilteredTickets(): BacklogTicket[] {
  let list = getCandidateTickets();

  if (activeStatusFilter !== "all") {
    list = list.filter((t) => t.statusCategory === activeStatusFilter);
  }

  if (searchQuery.trim().length > 0) {
    const q = searchQuery.trim().toLowerCase();
    list = list.filter(
      (t) =>
        t.id.toLowerCase().includes(q) ||
        t.title.toLowerCase().includes(q) ||
        (t.targetCodeFile && t.targetCodeFile.toLowerCase().includes(q))
    );
  }

  if (sortMode === "prio") {
    return list.slice().sort((a, b) => {
      const diff = getPriorityWeight(b.priority) - getPriorityWeight(a.priority);
      if (diff !== 0) return diff;
      return a.id.localeCompare(b.id, undefined, { numeric: true });
    });
  } else if (sortMode === "points") {
    return list.slice().sort((a, b) => {
      const diff = (b.storyPoints || 0) - (a.storyPoints || 0);
      if (diff !== 0) return diff;
      return a.id.localeCompare(b.id, undefined, { numeric: true });
    });
  } else {
    return list.slice().sort((a, b) => {
      return a.id.localeCompare(b.id, undefined, { numeric: true });
    });
  }
}

export function refreshBacklogData(): void {
  try {
    backlogWorkspace = loadBacklog(editor);
    if (!backlogWorkspace || backlogWorkspace.sprints.length === 0) {
      feedbackMessage = "No backlog found (expected Workspace/Backlog).";
    } else {
      feedbackMessage = "";
      if (!activeSprintId || !backlogWorkspace.sprints.some((s) => s.id === activeSprintId)) {
        activeSprintId = backlogWorkspace.sprints[0].id;
      }
    }
  } catch (err) {
    feedbackMessage = `Backlog error: ${String(err)}`;
  }

  if (isMounted) {
    updatePanel();
  }
}

// ── Virtual Buffer Issue Detail Pane ─────────────────────────────────────────

function parseTicketSections(rawContent: string): {
  problem: string;
  decisions: string;
  acceptance: string;
  other: string[];
} {
  const result = {
    problem: "",
    decisions: "",
    acceptance: "",
    other: [] as string[],
  };

  if (!rawContent) return result;

  const lines = rawContent.split(/\r?\n/);
  let currentSection = "";
  const sectionBuffers: Record<string, string[]> = {
    problem: [],
    decisions: [],
    acceptance: [],
    other: [],
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("## Problem") || trimmed.startsWith("## 1. Problem") || trimmed.startsWith("## Overview")) {
      currentSection = "problem";
      continue;
    }
    if (trimmed.startsWith("## Decisions") || trimmed.startsWith("## Implementation") || trimmed.startsWith("## Solution")) {
      currentSection = "decisions";
      continue;
    }
    if (trimmed.startsWith("## Acceptance") || trimmed.startsWith("## Evidence") || trimmed.startsWith("## Criteria")) {
      currentSection = "acceptance";
      continue;
    }
    if (trimmed.startsWith("## ")) {
      currentSection = "other";
      continue;
    }

    if (currentSection && sectionBuffers[currentSection]) {
      sectionBuffers[currentSection].push(line);
    }
  }

  result.problem = sectionBuffers.problem.join("\n").trim();
  result.decisions = sectionBuffers.decisions.join("\n").trim();
  result.acceptance = sectionBuffers.acceptance.join("\n").trim();
  result.other = sectionBuffers.other;

  return result;
}

function buildTicketDetailEntries(ticket: BacklogTicket): TextPropertyEntry[] {
  const entries: TextPropertyEntry[] = [];
  const statusGlyph = getStatusGlyph(ticket.statusCategory);
  const priorityFg = getPriorityFg(ticket.priority);

  // Read ticket markdown for deep sections
  let rawContent = "";
  if (ticket.ticketFilePath) {
    try {
      rawContent = editor.readFile(ticket.ticketFilePath) || "";
    } catch {}
  }
  const sections = parseTicketSections(rawContent);

  // 1. Title Banner
  entries.push({
    text: `\n  JIRA  ·  ${ticket.id}\n`,
    style: { fg: "syntax.keyword", bold: true },
  });
  entries.push({
    text: `  ${ticket.title}\n`,
    style: { fg: "editor.fg", bold: true },
  });
  entries.push({
    text: `  ${"─".repeat(68)}\n\n`,
    style: { fg: "editor.line_number_fg" },
  });

  // 2. Metadata Grid (Aligned Key-Value pairs)
  const metaRows: Array<[string, string, string, string, string?]> = [
    ["Status", `${ticket.status} ${statusGlyph.glyph}`, "Assignee", ticket.assignee || "Unassigned", statusGlyph.fg],
    ["Priority", ticket.priority, "Story Points", `${ticket.storyPoints} SP`, priorityFg],
    ["Sprint", ticket.sprintId, "Epic", ticket.epic || "None"],
    ["Target Code", ticket.targetCodeFile || "None", "Branch", `feature/${ticket.id.toLowerCase()}`],
  ];

  for (const [k1, v1, k2, v2, v1Fg] of metaRows) {
    const col1 = `  ${k1.padEnd(13)}: ${v1.padEnd(20)}`;
    const col2 = `${k2.padEnd(13)}: ${v2}\n`;

    entries.push({
      text: `  ${k1.padEnd(13)}: `,
      style: { fg: "editor.line_number_fg" },
    });
    entries.push({
      text: v1.padEnd(20),
      style: { fg: v1Fg || "editor.fg", bold: true },
    });
    entries.push({
      text: `${k2.padEnd(13)}: `,
      style: { fg: "editor.line_number_fg" },
    });
    entries.push({
      text: `${v2}\n`,
      style: { fg: "editor.fg" },
    });
  }

  // 3. Actions Affordance Bar
  entries.push({
    text: `\n  ${"─".repeat(68)}\n`,
    style: { fg: "editor.line_number_fg" },
  });
  entries.push({
    text: "  ACTIONS: ",
    style: { fg: "syntax.keyword", bold: true },
  });
  entries.push({
    text: "[s] ",
    style: { fg: "syntax.function", bold: true },
  });
  entries.push({
    text: "Advance Status    ",
    style: { fg: "editor.fg" },
  });
  entries.push({
    text: "[c] ",
    style: { fg: "syntax.function", bold: true },
  });
  entries.push({
    text: "Open Target Code    ",
    style: { fg: "editor.fg" },
  });
  entries.push({
    text: "[e] ",
    style: { fg: "syntax.function", bold: true },
  });
  entries.push({
    text: "Edit Raw MD    ",
    style: { fg: "editor.fg" },
  });
  entries.push({
    text: "[b] ",
    style: { fg: "syntax.function", bold: true },
  });
  entries.push({
    text: "Git Branch    ",
    style: { fg: "editor.fg" },
  });
  entries.push({
    text: "[q / Esc] ",
    style: { fg: "syntax.function", bold: true },
  });
  entries.push({
    text: "Close\n",
    style: { fg: "editor.fg" },
  });
  entries.push({
    text: `  ${"─".repeat(68)}\n\n`,
    style: { fg: "editor.line_number_fg" },
  });

  // 4. Section: Problem Description
  if (sections.problem) {
    entries.push({
      text: "  Problem\n",
      style: { fg: "syntax.type", bold: true },
    });
    entries.push({
      text: `  ${"─".repeat(24)}\n`,
      style: { fg: "editor.line_number_fg" },
    });
    for (const pLine of sections.problem.split("\n")) {
      entries.push({
        text: `  ${pLine}\n`,
        style: { fg: "editor.fg" },
      });
    }
    entries.push({ text: "\n" });
  }

  // 5. Section: Decisions & Implementation
  if (sections.decisions) {
    entries.push({
      text: "  Decisions & Implementation\n",
      style: { fg: "syntax.type", bold: true },
    });
    entries.push({
      text: `  ${"─".repeat(24)}\n`,
      style: { fg: "editor.line_number_fg" },
    });
    for (const dLine of sections.decisions.split("\n")) {
      entries.push({
        text: `  ${dLine}\n`,
        style: { fg: "editor.fg" },
      });
    }
    entries.push({ text: "\n" });
  }

  // 6. Section: Acceptance & Evidence Mapping
  if (sections.acceptance) {
    entries.push({
      text: "  Acceptance Criteria & Evidence\n",
      style: { fg: "syntax.type", bold: true },
    });
    entries.push({
      text: `  ${"─".repeat(24)}\n`,
      style: { fg: "editor.line_number_fg" },
    });
    for (const aLine of sections.acceptance.split("\n")) {
      entries.push({
        text: `  ${aLine}\n`,
        style: { fg: "editor.fg" },
      });
    }
    entries.push({ text: "\n" });
  }

  // Source path reference at bottom
  entries.push({
    text: `  File: ${ticket.ticketFilePath || "Unknown"}\n\n`,
    style: { fg: "editor.line_number_fg", italic: true },
  });

  return entries;
}

function getTargetSplitId(): number {
  try {
    const active = editor.getActiveSplitId();
    if (typeof active === "number") return active;
  } catch {}
  try {
    const splits = editor.listSplits();
    if (splits && splits.length > 0) return splits[0].id;
  } catch {}
  return 0;
}

export async function openTicketDetail(ticket: BacklogTicket): Promise<void> {
  activeDetailTicketId = ticket.id;
  if (ticket.ticketFilePath) {
    try {
      const splitId = getTargetSplitId();
      const ok = editor.previewFileInSplit(splitId, ticket.ticketFilePath);
      if (ok) {
        feedbackMessage = `Previewing ${ticket.id}`;
        updatePanel();
        return;
      }
    } catch {}
    try {
      const ok = editor.openFile(ticket.ticketFilePath);
      if (ok) {
        feedbackMessage = `Opened ${ticket.id}`;
        updatePanel();
        return;
      }
    } catch {}
  }

  // Fallback virtual buffer only if ticketFilePath is missing or failed to open
  try {
    const entries = buildTicketDetailEntries(ticket);
    const res = await editor.createVirtualBuffer({
      name: `Jira: ${ticket.id}`,
      mode: DETAIL_MODE,
      readOnly: true,
      editingDisabled: true,
      showLineNumbers: false,
      entries,
    });
    if (res) {
      detailBufferId = res.bufferId;
    }
  } catch (err) {
    feedbackMessage = `Failed to open detail: ${String(err)}`;
    updatePanel();
  }
}

async function updateActiveDetailBuffer(): Promise<void> {
  if (!activeDetailTicketId || !backlogWorkspace || detailBufferId === null) return;
  const ticket = backlogWorkspace.allTickets.find((t) => t.id === activeDetailTicketId);
  if (!ticket) return;
  try {
    const entries = buildTicketDetailEntries(ticket);
    editor.setVirtualBufferContent(detailBufferId, entries as unknown as Record<string, unknown>[]);
  } catch {}
}

function getProjectName(): string {
  if (backlogWorkspace?.rootPath) {
    const normalized = backlogWorkspace.rootPath.replace(/\\/g, "/");
    const match = normalized.match(/\/([^/]+)\/(?:Workspace\/Backlog|\.backlog|backlog|docs\/backlog)$/i);
    if (match && match[1]) {
      return match[1].toUpperCase();
    }
  }
  try {
    const cwd = editor.getCwd().replace(/\\/g, "/");
    const parts = cwd.split("/").filter(Boolean);
    if (parts.length > 0) {
      const last = parts[parts.length - 1];
      if (last.toLowerCase() !== "projects") {
        return last.toUpperCase();
      }
    }
  } catch {}
  return "BACKLOG";
}

// ── Sidebar Widget Builder ───────────────────────────────────────────────────

export function buildJiraPanelSpec(): WidgetSpec {
  if (!backlogWorkspace) {
    refreshBacklogData();
  }

  const sidebarWidth = getSidebarWidth();
  const widgets: WidgetSpec[] = [];

  // 1. Dynamic Header: JIRA · <ProjectName> with subtle ? ⚙ and ⟳
  const projName = getProjectName();
  widgets.push(
    row(
      label(` JIRA · ${projName}`, {
        style: { bold: true, fg: "syntax.keyword" },
      }),
      flexSpacer(),
      button(" ? ", {
        key: "jira_toggle_help",
        bare: true,
        style: { fg: "editor.line_number_fg" },
        hoverStyle: { fg: "syntax.string", bold: true },
      }),
      spacer(1),
      button(" ⚙ ", {
        key: "jira_config_path",
        bare: true,
        style: { fg: "editor.line_number_fg" },
        hoverStyle: { fg: "syntax.function", bold: true },
      }),
      spacer(1),
      button(" ⟳ ", {
        key: "jira_refresh",
        bare: true,
        style: { fg: "editor.line_number_fg" },
        hoverStyle: { fg: "syntax.keyword", bold: true },
      })
    )
  );

  if (!backlogWorkspace || backlogWorkspace.sprints.length === 0) {
    widgets.push(spacer(1));
    widgets.push(
      label(" No backlog detected.", {
        style: { fg: "editor.line_number_fg" },
      })
    );
    widgets.push(
      label(" Expected: Workspace/Backlog", {
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

  // 2. Sprint Dropdown & Metrics Overview
  const sprintOptions: string[] = [];
  const sprintIds: string[] = [];

  for (const s of backlogWorkspace.sprints) {
    sprintIds.push(s.id);
    const match = s.id.match(/^Sprint-(\d+)/i);
    const sprintNum = match ? parseInt(match[1], 10) : "";
    let cleanName = sprintNum ? `Sprint ${sprintNum}` : s.id;
    const topicMatch = s.title.match(/Board:\s*([^&:\-]+)/i) || s.title.match(/:\s*([^&:\-]+)/i);
    if (topicMatch && topicMatch[1]) {
      const topic = topicMatch[1].replace(/Webhook\s*/i, "").trim();
      if (topic) {
        cleanName = `${cleanName}: ${topic}`;
      }
    }
    sprintOptions.push(cleanName);
  }
  sprintIds.push("all");
  sprintOptions.push("All Sprints");

  let currentSprintIdx = sprintIds.indexOf(activeSprintId);
  if (currentSprintIdx < 0) currentSprintIdx = 0;

  widgets.push(spacer(1));
  widgets.push(
    dropdown(sprintOptions, {
      selectedIndex: currentSprintIdx,
      key: "jira_sprint_dropdown",
    })
  );

  let curSprint: SprintInfo | null = null;
  if (activeSprintId !== "all") {
    curSprint = backlogWorkspace.sprints.find((s) => s.id === activeSprintId) || null;
  }

  // Sprint Subtitle / Topic (cleaned and wrapped to prevent "...")
  const rawSprintTitle = curSprint ? curSprint.title : "All Sprints Backlog";
  const cleanSprintTitle = rawSprintTitle.replace(/^#?\s*Sprint\s*\d+\s*(?:Board)?[:\-–—]\s*/i, "").trim() || rawSprintTitle;
  widgets.push(
    label(` ${cleanSprintTitle}`, {
      wrap: true,
      style: { fg: "syntax.variable" },
    })
  );

  // Progress Bar & SP Counter
  const totalSp = curSprint ? curSprint.totalSp : backlogWorkspace.allTickets.reduce((acc, t) => acc + t.storyPoints, 0);
  const doneSp = curSprint ? curSprint.completedSp : backlogWorkspace.allTickets.filter((t) => t.statusCategory === "done").reduce((acc, t) => acc + t.storyPoints, 0);
  const percent = totalSp > 0 ? Math.round((doneSp / totalSp) * 100) : 0;

  // Budget progress bar width to prevent wrapping at 24 cols
  const spText = `${doneSp} / ${totalSp} SP`;
  const barBudget = Math.max(4, Math.min(12, sidebarWidth - editor.stringWidth(spText) - 5));
  const barText = renderProgressBar(percent, barBudget);

  widgets.push(
    row(
      label(` ${barText}`, {
        style: { bold: true, fg: "syntax.string" },
      }),
      spacer(1),
      label(spText, {
        style: { fg: "editor.line_number_fg" },
      })
    )
  );

  // 3. Filter Dropdown and Sort Dropdown on the SAME row
  widgets.push(spacer(1));
  const candidateTickets = getCandidateTickets();
  const filterOptions = [
    `All (${candidateTickets.length})`,
    `To Do (${candidateTickets.filter((t) => t.statusCategory === "todo").length})`,
    `In Dev (${candidateTickets.filter((t) => t.statusCategory === "in_progress").length})`,
    `Done (${candidateTickets.filter((t) => t.statusCategory === "done").length})`,
    `Blocked (${candidateTickets.filter((t) => t.statusCategory === "blocked").length})`,
  ];

  const currentFilterIdx = STATUS_FILTER_KEYS.indexOf(activeStatusFilter);
  const currentSortIdx = Math.max(0, SORT_MODES.indexOf(sortMode));
  widgets.push(
    row(
      dropdown(filterOptions, {
        selectedIndex: currentFilterIdx >= 0 ? currentFilterIdx : 0,
        key: "jira_filter_dropdown",
      }),
      flexSpacer(),
      dropdown(SORT_OPTIONS, {
        selectedIndex: currentSortIdx,
        key: "jira_sort_dropdown",
      })
    )
  );

  widgets.push(divider());

  // Search indicator row if search is active
  const filteredTickets = getFilteredTickets();
  if (selectedTicketIndex >= filteredTickets.length) {
    selectedTicketIndex = Math.max(0, filteredTickets.length - 1);
  }

  if (searchQuery.trim().length > 0) {
    widgets.push(
      row(
        label(` /${truncateToCols(searchQuery, sidebarWidth - 10)} (${filteredTickets.length})`, {
          style: { fg: "syntax.function", italic: true },
        }),
        flexSpacer(),
        button("✕", {
          key: "jira_clear_search",
          bare: true,
          style: { fg: "editor.line_number_fg" },
        })
      )
    );
  }

  // Optional contextual help cheatsheet toggle
  if (showHelp) {
    widgets.push(divider());
    widgets.push(label(" KEYBOARD NAVIGATION", { style: { bold: true, fg: "syntax.keyword" } }));
    widgets.push(label("  ↑↓ / j/k : Navigate issues", { style: { fg: "editor.fg" } }));
    widgets.push(label("  Enter    : Open ticket", { style: { fg: "editor.fg" } }));
    widgets.push(label("  /        : Search ID/title", { style: { fg: "editor.fg" } }));
    widgets.push(label("  f        : Cycle status filter", { style: { fg: "editor.fg" } }));
    widgets.push(label("  o        : Cycle sort mode", { style: { fg: "editor.fg" } }));
    widgets.push(label("  s        : Cycle sprint", { style: { fg: "editor.fg" } }));
    widgets.push(label("  r        : Refresh backlog", { style: { fg: "editor.fg" } }));
    widgets.push(label("  Esc      : Clear search / close", { style: { fg: "editor.fg" } }));
    widgets.push(
      button("Hide Help [?]", {
        key: "jira_toggle_help",
        intent: "primary",
      })
    );
  }

  // 4. Interactive 1-Line Issue Rows
  if (filteredTickets.length === 0) {
    widgets.push(
      label("  No issues matching filter.", {
        style: { fg: "editor.line_number_fg", italic: true },
      })
    );
  } else {
    for (let i = 0; i < filteredTickets.length; i++) {
      const ticket = filteredTickets[i];
      const isSelected = i === selectedTicketIndex;
      const selBg = isSelected ? { bg: "editor.selection_bg" } : {};
      const { glyph, fg: statusFg } = getStatusGlyph(ticket.statusCategory);
      const prioStyle = getPriorityStyle(ticket.priority);

      widgets.push(
        row(
          button(` ${glyph} `, {
            key: `jira_cycle_ticket:${ticket.id}`,
            bare: true,
            style: { fg: statusFg, bold: true, ...selBg },
            hoverStyle: { fg: "syntax.string", bold: true },
          }),
          button(`${ticket.id} `, {
            key: `jira_open_ticket:${ticket.id}`,
            bare: true,
            style: { fg: prioStyle.fg, bold: true, ...selBg },
            hoverStyle: { fg: "syntax.function", bold: true },
          }),
          label(`${ticket.storyPoints}pt `, {
            style: { fg: "editor.line_number_fg", ...selBg },
          }),
          button(ticket.title, {
            key: `jira_open_ticket:${ticket.id}`,
            bare: true,
            style: {
              fg: prioStyle.fg,
              bold: prioStyle.bold || isSelected,
              ...selBg,
            },
            hoverStyle: { fg: "syntax.function", bold: true },
          })
        )
      );
    }
  }

  // Feedback banner if present
  if (feedbackMessage) {
    widgets.push(
      label(` ℹ ${truncateToCols(feedbackMessage, sidebarWidth - 4)}`, {
        style: { fg: "syntax.function", italic: true },
      })
    );
  }

  widgets.push(spacer(1));
  return col(...widgets);
}

function updatePanel(): void {
  if (!isMounted) return;
  try {
    editor.updateFloatingWidget(PANEL_ID, buildJiraPanelSpec());
  } catch {}
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
    startBlurred: false,
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
  } catch {}
  isMounted = false;
}

// ── Keyboard Actions & Handlers ──────────────────────────────────────────────

function navigateIssue(delta: number): void {
  const tickets = getFilteredTickets();
  if (tickets.length === 0) return;
  selectedTicketIndex = Math.max(0, Math.min(tickets.length - 1, selectedTicketIndex + delta));
  updatePanel();
}

async function openSelectedTicket(): Promise<void> {
  const tickets = getFilteredTickets();
  if (tickets.length === 0 || selectedTicketIndex < 0 || selectedTicketIndex >= tickets.length) return;
  const ticket = tickets[selectedTicketIndex];
  await openTicketDetail(ticket);
}

function cycleFilter(): void {
  const curIdx = STATUS_FILTER_KEYS.indexOf(activeStatusFilter);
  const nextIdx = (curIdx + 1) % STATUS_FILTER_KEYS.length;
  activeStatusFilter = STATUS_FILTER_KEYS[nextIdx];
  selectedTicketIndex = 0;
  feedbackMessage = `Filter: ${activeStatusFilter.toUpperCase()}`;
  updatePanel();
}

function cycleSprint(): void {
  if (!backlogWorkspace || backlogWorkspace.sprints.length === 0) return;
  const sprintIds = backlogWorkspace.sprints.map((s) => s.id);
  sprintIds.push("all");
  const curIdx = sprintIds.indexOf(activeSprintId);
  const nextIdx = (curIdx + 1) % sprintIds.length;
  activeSprintId = sprintIds[nextIdx];
  selectedTicketIndex = 0;
  feedbackMessage = `Sprint: ${activeSprintId === "all" ? "All" : activeSprintId}`;
  updatePanel();
}

async function searchPrompt(): Promise<void> {
  const chosen = await editor.prompt("Search Jira Issues (ID or title):", searchQuery);
  if (chosen !== null) {
    searchQuery = chosen.trim();
    selectedTicketIndex = 0;
    updatePanel();
  }
}

async function cycleTicketStatus(ticketId: string | null): Promise<void> {
  if (!ticketId || !backlogWorkspace) return;
  const ticket = backlogWorkspace.allTickets.find((t) => t.id === ticketId);
  if (!ticket) return;

  let nextStatus = "READY_FOR_DEV";
  if (ticket.statusCategory === "todo") {
    nextStatus = "IN_PROGRESS";
  } else if (ticket.statusCategory === "in_progress") {
    nextStatus = "DONE";
  } else if (ticket.statusCategory === "done") {
    nextStatus = "READY_FOR_DEV";
  } else {
    nextStatus = "READY_FOR_DEV";
  }

  const ok = updateTicketStatus(editor, ticket, nextStatus);
  if (ok) {
    feedbackMessage = `${ticket.id} → ${nextStatus}`;
    refreshBacklogData();
    await updateActiveDetailBuffer();
  } else {
    feedbackMessage = `Failed to update ${ticket.id}`;
  }
  updatePanel();
}

async function openTargetCode(ticketId: string | null): Promise<void> {
  if (!ticketId || !backlogWorkspace) return;
  const ticket = backlogWorkspace.allTickets.find((t) => t.id === ticketId);
  if (!ticket || !ticket.targetCodeFile) {
    feedbackMessage = "No target code file specified.";
    updatePanel();
    return;
  }

  const resolved = await resolveTargetCodePath(editor, ticket.targetCodeFile);
  if (resolved) {
    editor.openFile(resolved);
    feedbackMessage = `Opened ${ticket.targetCodeFile}`;
  } else {
    feedbackMessage = `File not found: ${ticket.targetCodeFile}`;
  }
  updatePanel();
}

async function createTicketBranch(ticketId: string | null): Promise<void> {
  if (!ticketId) return;
  const branchName = `feature/${ticketId.toLowerCase()}`;
  const cwd = editor.getCwd();
  try {
    const proc = editor.spawnProcess("git", ["checkout", "-b", branchName], cwd);
    await proc.result;
    feedbackMessage = `Branch created: ${branchName}`;
  } catch (err) {
    feedbackMessage = `Branch failed: ${String(err)}`;
  }
  updatePanel();
}

function openRawTicketMarkdown(ticketId: string | null): void {
  if (!ticketId || !backlogWorkspace) return;
  const ticket = backlogWorkspace.allTickets.find((t) => t.id === ticketId);
  if (ticket && ticket.ticketFilePath) {
    editor.openFile(ticket.ticketFilePath);
    feedbackMessage = `Opened ${ticket.id}.md`;
    updatePanel();
  }
}

function closeDetailBuffer(): void {
  if (detailBufferId !== null) {
    try {
      editor.closeBuffer(detailBufferId);
    } catch {}
    detailBufferId = null;
    activeDetailTicketId = null;
  }
}

// ── Register Mode Handlers ───────────────────────────────────────────────────

// Sidebar Handlers
registerHandler("jira_nav_down", () => navigateIssue(1));
registerHandler("jira_nav_up", () => navigateIssue(-1));
registerHandler("jira_open_selected", () => void openSelectedTicket());
registerHandler("jira_search", () => void searchPrompt());
registerHandler("jira_filter_cycle", () => cycleFilter());
registerHandler("jira_sprint_cycle", () => cycleSprint());
registerHandler("jira_sort_toggle", () => {
  const curIdx = SORT_MODES.indexOf(sortMode);
  const nextIdx = (curIdx + 1) % SORT_MODES.length;
  sortMode = SORT_MODES[nextIdx];
  selectedTicketIndex = 0;
  feedbackMessage = `Sort: ${SORT_OPTIONS[nextIdx]}`;
  updatePanel();
});
registerHandler("jira_refresh_cmd", () => {
  refreshBacklogData();
  feedbackMessage = "Backlog refreshed.";
  updatePanel();
});
registerHandler("jira_toggle_help", () => {
  showHelp = !showHelp;
  updatePanel();
});
registerHandler("jira_escape", () => {
  if (searchQuery) {
    searchQuery = "";
    selectedTicketIndex = 0;
    updatePanel();
  } else if (showHelp) {
    showHelp = false;
    updatePanel();
  }
});

// Detail Pane Handlers
registerHandler("jira_detail_status_advance", () => void cycleTicketStatus(activeDetailTicketId));
registerHandler("jira_detail_open_code", () => void openTargetCode(activeDetailTicketId));
registerHandler("jira_detail_edit_raw", () => openRawTicketMarkdown(activeDetailTicketId));
registerHandler("jira_detail_branch", () => void createTicketBranch(activeDetailTicketId));
registerHandler("jira_detail_close", () => closeDetailBuffer());

// Mode Definitions
editor.defineMode(
  SIDEBAR_MODE,
  [
    ["j", "jira_nav_down"],
    ["k", "jira_nav_up"],
    ["Down", "jira_nav_down"],
    ["Up", "jira_nav_up"],
    ["Return", "jira_open_selected"],
    ["/", "jira_search"],
    ["f", "jira_filter_cycle"],
    ["o", "jira_sort_toggle"],
    ["s", "jira_sprint_cycle"],
    ["r", "jira_refresh_cmd"],
    ["?", "jira_toggle_help"],
    ["Escape", "jira_escape"],
  ],
  true,
  false,
  true
);

editor.defineMode(
  DETAIL_MODE,
  [
    ["s", "jira_detail_status_advance"],
    ["c", "jira_detail_open_code"],
    ["e", "jira_detail_edit_raw"],
    ["b", "jira_detail_branch"],
    ["r", "jira_refresh_cmd"],
    ["q", "jira_detail_close"],
    ["Escape", "jira_detail_close"],
  ],
  true,
  false,
  true
);

// ── Widget Event Routing ─────────────────────────────────────────────────────

editor.on("widget_event", async (event: WidgetEvt) => {
  if (event.panel_id !== PANEL_ID) return;

  const key = event.widget_key || "";

  // Dropdown changes
  if (event.event_type === "change") {
    const payload = event.payload as { index?: number; value?: string } | undefined;
    const selectedIdx = payload?.index;

    if (key === "jira_sprint_dropdown" && typeof selectedIdx === "number" && backlogWorkspace) {
      const sprintIds: string[] = backlogWorkspace.sprints.map((s) => s.id);
      sprintIds.push("all");
      if (selectedIdx >= 0 && selectedIdx < sprintIds.length) {
        activeSprintId = sprintIds[selectedIdx];
        selectedTicketIndex = 0;
        feedbackMessage = `Sprint: ${activeSprintId === "all" ? "All" : activeSprintId}`;
        updatePanel();
      }
      return;
    }

    if (key === "jira_filter_dropdown" && typeof selectedIdx === "number") {
      if (selectedIdx >= 0 && selectedIdx < STATUS_FILTER_KEYS.length) {
        activeStatusFilter = STATUS_FILTER_KEYS[selectedIdx];
        selectedTicketIndex = 0;
        feedbackMessage = `Filter: ${activeStatusFilter.toUpperCase()}`;
        updatePanel();
      }
      return;
    }

    if (key === "jira_sort_dropdown" && typeof selectedIdx === "number") {
      if (selectedIdx >= 0 && selectedIdx < SORT_MODES.length) {
        sortMode = SORT_MODES[selectedIdx];
        selectedTicketIndex = 0;
        feedbackMessage = `Sort: ${SORT_OPTIONS[selectedIdx]}`;
        updatePanel();
      }
      return;
    }
    return;
  }

  // List item selection & activation
  if (key === "jira_issue_list") {
    const payload = event.payload as { index?: number; key?: string } | undefined;
    const idx = payload?.index;
    if (typeof idx === "number") {
      selectedTicketIndex = idx;
    }

    if (event.event_type === "activate") {
      await openSelectedTicket();
    } else {
      updatePanel();
    }
    return;
  }

  if (event.event_type !== "activate" && event.event_type !== "select") return;

  // Click on ticket row (open detail pane)
  if (key.startsWith("jira_open_ticket:")) {
    const tId = key.slice("jira_open_ticket:".length);
    const tickets = getFilteredTickets();
    const idx = tickets.findIndex((t) => t.id === tId);
    if (idx >= 0) {
      selectedTicketIndex = idx;
    }
    const ticket = backlogWorkspace?.allTickets.find((t) => t.id === tId);
    if (ticket) {
      await openTicketDetail(ticket);
    }
    updatePanel();
    return;
  }

  // Click on status glyph (cycle status directly)
  if (key.startsWith("jira_cycle_ticket:")) {
    const tId = key.slice("jira_cycle_ticket:".length);
    const tickets = getFilteredTickets();
    const idx = tickets.findIndex((t) => t.id === tId);
    if (idx >= 0) {
      selectedTicketIndex = idx;
    }
    await cycleTicketStatus(tId);
    return;
  }

  // Header and toolbar actions
  if (key === "jira_refresh") {
    refreshBacklogData();
    feedbackMessage = "Backlog refreshed.";
    updatePanel();
    return;
  }

  if (key === "jira_toggle_help") {
    showHelp = !showHelp;
    updatePanel();
    return;
  }

  if (key === "jira_clear_search") {
    searchQuery = "";
    selectedTicketIndex = 0;
    updatePanel();
    return;
  }

  if (key === "jira_toggle_sort") {
    const curIdx = SORT_MODES.indexOf(sortMode);
    const nextIdx = (curIdx + 1) % SORT_MODES.length;
    sortMode = SORT_MODES[nextIdx];
    selectedTicketIndex = 0;
    feedbackMessage = `Sort: ${SORT_OPTIONS[nextIdx]}`;
    updatePanel();
    return;
  }

  if (key === "jira_config_path") {
    const current = getCustomBacklogRoot() || backlogWorkspace?.rootPath || editor.getCwd();
    const chosen = await editor.prompt("Configure Backlog Path:", current);
    if (chosen !== null) {
      setCustomBacklogRoot(chosen);
      selectedTicketIndex = 0;
      refreshBacklogData();
      feedbackMessage = `Path: ${chosen}`;
      updatePanel();
    }
    return;
  }
});

// ── Extensible View Registry & Commands ──────────────────────────────────────

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
