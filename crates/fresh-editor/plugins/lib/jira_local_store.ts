/// <reference path="./fresh.d.ts" />

/**
 * Local Jira-Compatible Backlog Store
 *
 * Scans, parses, and synchronizes sprint boards and ticket markdown files
 * directly against local git repositories (e.g. PayMeNow/Workspace/Backlog).
 */

export interface BacklogTicket {
  id: string;
  title: string;
  priority: string;
  storyPoints: number;
  status: string;
  statusCategory: "todo" | "in_progress" | "done" | "blocked" | "rejected" | "other";
  targetCodeFile: string;
  ticketFilePath: string;
  sprintId: string;
  sprintDir: string;
  boardPath: string;
  assignee: string;
  epic?: string;
  dependsOn?: string;
}

export interface SprintInfo {
  id: string;
  title: string;
  cycle: string;
  goal: string;
  capacity: string;
  dirPath: string;
  boardPath: string;
  tickets: BacklogTicket[];
  totalSp: number;
  completedSp: number;
  inProgressSp: number;
  todoSp: number;
  rejectedSp: number;
  progressPercent: number;
}

export interface BacklogWorkspace {
  rootPath: string;
  masterReadmePath: string | null;
  sprints: SprintInfo[];
  allTickets: BacklogTicket[];
}

let userConfiguredPath: string | null = null;

export function setCustomBacklogRoot(path: string | null): void {
  userConfiguredPath = path && path.trim().length > 0 ? path.trim() : null;
}

export function getCustomBacklogRoot(): string | null {
  return userConfiguredPath;
}

export function categorizeStatus(status: string): "todo" | "in_progress" | "done" | "blocked" | "rejected" | "other" {
  const upper = (status || "").toUpperCase();
  if (
    upper.includes("REJECT") ||
    upper.includes("CANCEL") ||
    upper.includes("WONTFIX") ||
    upper.includes("WON'T FIX") ||
    upper.includes("WONT_FIX") ||
    upper.includes("DROPPED") ||
    upper.includes("INVALID") ||
    upper.includes("DISCARD") ||
    upper.includes("ABANDON")
  ) {
    return "rejected";
  }
  if (
    upper.includes("DONE") ||
    upper.includes("CLOSE") ||
    upper.includes("RESOLVED") ||
    upper.includes("COMPLET")
  ) {
    return "done";
  }
  if (
    upper.includes("IN_PROGRESS") ||
    upper.includes("IN-PROGRESS") ||
    upper.includes("IN_DEV") ||
    upper.includes("IMPLEMENT") ||
    upper.includes("TRACE") ||
    upper.includes("DECIDE") ||
    upper.includes("ACTIVE") ||
    upper.includes("REVIEW") ||
    upper.includes("TEST")
  ) {
    return "in_progress";
  }
  if (
    upper.includes("READY") ||
    upper.includes("TODO") ||
    upper.includes("TO_DO") ||
    upper.includes("CLAIM") ||
    upper.includes("BACKLOG") ||
    upper.includes("PLAN") ||
    upper.includes("OPEN")
  ) {
    return "todo";
  }
  if (
    upper.includes("BLOCK") ||
    upper.includes("GATED") ||
    upper.includes("HOLD") ||
    upper.includes("WAIT") ||
    upper.includes("DUPLICATE")
  ) {
    return "blocked";
  }
  return "other";
}

export function cleanMarkdownCell(cell: string): string {
  return cell
    .replace(/[`*]/g, "")
    .replace(/[✅🔴🟡🟢📋⚖️⏸️❌🚫✖✕]/g, "")
    .trim();
}

/**
 * Detects the root directory containing the backlog.
 */
export function detectBacklogRoot(editor: EditorAPI): string | null {
  if (userConfiguredPath) {
    try {
      const entries = editor.readDir(userConfiguredPath);
      if (entries && entries.length > 0) return userConfiguredPath;
    } catch {}
  }

  const cwd = editor.getCwd();
  const candidates = [
    editor.pathJoin(cwd, "Workspace", "Backlog"),
    editor.pathJoin(cwd, "PayMeNow", "Workspace", "Backlog"),
    editor.pathJoin(cwd, ".backlog"),
    editor.pathJoin(cwd, "backlog"),
    editor.pathJoin(cwd, "docs", "backlog"),
    // Standard user path fallback
    "C:/Users/buith_ejh62q2/PROJECTS/PayMeNow/Workspace/Backlog",
  ];

  for (const candidate of candidates) {
    try {
      const entries = editor.readDir(candidate);
      if (entries && entries.length > 0) {
        return candidate;
      }
    } catch {
      // Continue to next candidate
    }
  }
  return null;
}

/**
 * Parses individual ticket Markdown frontmatter and metadata.
 */
export function parseTicketDetails(
  editor: EditorAPI,
  ticketPath: string
): Partial<BacklogTicket> {
  try {
    const content = editor.readFile(ticketPath);
    if (!content) return {};

    const details: Partial<BacklogTicket> = {
      ticketFilePath: ticketPath,
    };

    const lines = content.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("- **ID:**")) {
        details.id = cleanMarkdownCell(trimmed.replace("- **ID:**", ""));
      } else if (trimmed.startsWith("- **Epic:**")) {
        details.epic = cleanMarkdownCell(trimmed.replace("- **Epic:**", ""));
      } else if (trimmed.startsWith("- **Priority:**")) {
        details.priority = cleanMarkdownCell(trimmed.replace("- **Priority:**", ""));
      } else if (trimmed.startsWith("- **Story Points:**")) {
        const spStr = cleanMarkdownCell(trimmed.replace("- **Story Points:**", ""));
        const match = spStr.match(/\b(\d+)\b/);
        const spNum = match ? parseInt(match[1], 10) : parseInt(spStr.replace(/\D/g, ""), 10);
        if (!isNaN(spNum)) details.storyPoints = spNum;
      } else if (trimmed.startsWith("- **Status:**")) {
        details.status = cleanMarkdownCell(trimmed.replace("- **Status:**", ""));
      } else if (trimmed.startsWith("- **Assignee:**")) {
        details.assignee = cleanMarkdownCell(trimmed.replace("- **Assignee:**", ""));
      } else if (trimmed.startsWith("- **Depends on:**")) {
        details.dependsOn = cleanMarkdownCell(trimmed.replace("- **Depends on:**", ""));
      }
    }

    return details;
  } catch {
    return {};
  }
}

/**
 * Helper to locate the exact ticket file within a sprint's Tickets directory.
 */
function findTicketFile(
  editor: EditorAPI,
  sprintDir: string,
  ticketId: string,
  relPath?: string
): string {
  if (relPath) {
    const directPath = editor.pathJoin(sprintDir, relPath.replace(/\//g, "\\"));
    try {
      if (editor.readFile(directPath) !== null) {
        return directPath;
      }
    } catch {}
  }

  const ticketsDir = editor.pathJoin(sprintDir, "Tickets");
  try {
    const files = editor.readDir(ticketsDir);
    const prefix = `${ticketId}-`;
    for (const f of files) {
      if (f.is_file && f.name.endsWith(".md")) {
        if (f.name.startsWith(prefix) || f.name === `${ticketId}.md`) {
          return editor.pathJoin(ticketsDir, f.name);
        }
      }
    }
  } catch {}

  return editor.pathJoin(sprintDir, "Tickets", `${ticketId}.md`);
}

/**
 * Parses SPRINT-BOARD.md and all tickets within a sprint directory.
 */
export function parseSprint(
  editor: EditorAPI,
  sprintDir: string,
  dirName: string
): SprintInfo | null {
  const boardPath = editor.pathJoin(sprintDir, "SPRINT-BOARD.md");
  let boardContent = "";
  try {
    boardContent = editor.readFile(boardPath) || "";
  } catch {
    boardContent = "";
  }

  let sprintId = dirName;
  let sprintTitle = dirName;
  let cycle = "Active Cycle";
  let goal = "Sprint execution and backlog delivery";
  let capacity = "";

  const ticketsMap = new Map<string, BacklogTicket>();

  if (boardContent) {
    const lines = boardContent.split(/\r?\n/);
    let inKanbanTable = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.startsWith("# ")) {
        sprintTitle = line.replace("# ", "").trim();
      } else if (line.startsWith("- **Sprint ID:**")) {
        sprintId = cleanMarkdownCell(line.replace("- **Sprint ID:**", ""));
      } else if (line.startsWith("- **Cycle:**")) {
        cycle = cleanMarkdownCell(line.replace("- **Cycle:**", ""));
      } else if (line.startsWith("- **Sprint Goal:**")) {
        goal = cleanMarkdownCell(line.replace("- **Sprint Goal:**", ""));
      } else if (line.startsWith("- **Capacity & Story Points:**")) {
        capacity = cleanMarkdownCell(line.replace("- **Capacity & Story Points:**", ""));
      } else if (line.startsWith("## 2. Kanban Board") || line.includes("Kanban Board")) {
        inKanbanTable = true;
      } else if (inKanbanTable && line.startsWith("## ")) {
        inKanbanTable = false;
      } else if (inKanbanTable && line.startsWith("|") && !line.includes(":---")) {
        const parts = line
          .split("|")
          .map((s) => s.trim())
          .filter((_, idx, arr) => idx > 0 && idx < arr.length - 1);

        // Header: | Ticket ID | Title | Priority | SP | Status | Target Code File |
        if (parts.length >= 5 && !parts[0].toLowerCase().includes("ticket id")) {
          const rawIdCol = parts[0];
          // Match [`WH-01`](Tickets/WH-01.md) or `WH-01`
          const idMatch = rawIdCol.match(/\[`?([A-Za-z0-9_-]+)`?\](?:\(([^)]+)\))?/);
          const ticketId = idMatch ? idMatch[1] : cleanMarkdownCell(rawIdCol);
          const relFilePath = idMatch && idMatch[2] ? idMatch[2] : "";

          const title = cleanMarkdownCell(parts[1]);
          const priority = cleanMarkdownCell(parts[2]);
          const spStr = cleanMarkdownCell(parts[3]);
          const storyPoints = parseInt(spStr.replace(/\D/g, ""), 10) || 0;
          const status = cleanMarkdownCell(parts[4]);
          const targetCodeFile = parts[5] ? cleanMarkdownCell(parts[5]) : "";

          const ticketFilePath = findTicketFile(editor, sprintDir, ticketId, relFilePath);

          const ticket: BacklogTicket = {
            id: ticketId,
            title,
            priority: priority || "MEDIUM",
            storyPoints,
            status: status || "READY_FOR_DEV",
            statusCategory: categorizeStatus(status || "READY_FOR_DEV"),
            targetCodeFile,
            ticketFilePath,
            sprintId,
            sprintDir,
            boardPath,
            assignee: "Unassigned",
          };
          ticketsMap.set(ticketId, ticket);
        }
      }
    }
  }

  // Scan Tickets/ folder to enrich ticket details or add tickets not in the table
  const ticketsDir = editor.pathJoin(sprintDir, "Tickets");
  try {
    const ticketFiles = editor.readDir(ticketsDir);
    for (const tf of ticketFiles) {
      if (tf.is_file && tf.name.endsWith(".md")) {
        const absPath = editor.pathJoin(ticketsDir, tf.name);
        const details = parseTicketDetails(editor, absPath);
        const ticketId = details.id || tf.name.split("-")[0];

        const existing = ticketsMap.get(ticketId);
        if (existing) {
          existing.ticketFilePath = absPath;
          if (details.assignee) existing.assignee = details.assignee;
          if (details.epic) existing.epic = details.epic;
          if (details.dependsOn) existing.dependsOn = details.dependsOn;
        } else if (details.id) {
          const statusLower = (details.status || "").toLowerCase();
          const isExcluded =
            statusLower.includes("không thuộc") ||
            statusLower.includes("unscheduled");
          if (!isExcluded) {
            const newTicket: BacklogTicket = {
              id: details.id,
              title: tf.name.replace(".md", "").replace(/^[A-Za-z0-9_-]+-/, ""),
              priority: details.priority || "MEDIUM",
              storyPoints: details.storyPoints || 1,
              status: details.status || "READY_FOR_DEV",
              statusCategory: categorizeStatus(details.status || "READY_FOR_DEV"),
              targetCodeFile: "",
              ticketFilePath: absPath,
              sprintId,
              sprintDir,
              boardPath,
              assignee: details.assignee || "Unassigned",
              epic: details.epic,
              dependsOn: details.dependsOn,
            };
            ticketsMap.set(details.id, newTicket);
          }
        }
      }
    }
  } catch {
    // Ticket directory may not exist
  }

  const tickets = Array.from(ticketsMap.values());
  let totalSp = 0;
  let completedSp = 0;
  let inProgressSp = 0;
  let todoSp = 0;
  let rejectedSp = 0;

  for (const t of tickets) {
    totalSp += t.storyPoints;
    if (t.statusCategory === "done") {
      completedSp += t.storyPoints;
    } else if (t.statusCategory === "in_progress") {
      inProgressSp += t.storyPoints;
    } else if (t.statusCategory === "rejected") {
      rejectedSp += t.storyPoints;
    } else {
      todoSp += t.storyPoints;
    }
  }

  const progressPercent = totalSp > 0 ? Math.round((completedSp / totalSp) * 100) : 0;

  return {
    id: sprintId,
    title: sprintTitle,
    cycle,
    goal,
    capacity,
    dirPath: sprintDir,
    boardPath,
    tickets,
    totalSp,
    completedSp,
    inProgressSp,
    todoSp,
    rejectedSp,
    progressPercent,
  };
}

/**
 * Loads the entire backlog across all discovered sprints.
 */
export function loadBacklog(editor: EditorAPI): BacklogWorkspace | null {
  const root = detectBacklogRoot(editor);
  if (!root) return null;

  const sprints: SprintInfo[] = [];
  try {
    const entries = editor.readDir(root);
    for (const entry of entries) {
      if (entry.is_dir && (entry.name.startsWith("Sprint-") || entry.name.toLowerCase().includes("sprint"))) {
        const sprintDir = editor.pathJoin(root, entry.name);
        const sprint = parseSprint(editor, sprintDir, entry.name);
        if (sprint) {
          sprints.push(sprint);
        }
      }
    }
  } catch {
    return null;
  }

  // Sort sprints by id
  sprints.sort((a, b) => a.id.localeCompare(b.id));

  const allTickets: BacklogTicket[] = [];
  for (const s of sprints) {
    allTickets.push(...s.tickets);
  }

  const masterReadme = editor.pathJoin(root, "README.md");
  let hasMasterReadme = false;
  try {
    hasMasterReadme = editor.readFile(masterReadme) !== null;
  } catch {}

  return {
    rootPath: root,
    masterReadmePath: hasMasterReadme ? masterReadme : null,
    sprints,
    allTickets,
  };
}

/**
 * Updates a ticket status in both its Markdown file and the SPRINT-BOARD.md table.
 */
export function updateTicketStatus(
  editor: EditorAPI,
  ticket: BacklogTicket,
  newStatus: string
): boolean {
  try {
    // 1. Update ticket markdown file
    if (ticket.ticketFilePath) {
      const ticketContent = editor.readFile(ticket.ticketFilePath);
      if (ticketContent) {
        const updated = ticketContent.replace(
          /- \*\*Status:\*\* .*/g,
          `- **Status:** \`${newStatus}\``
        );
        editor.writeFile(ticket.ticketFilePath, updated);
      }
    }

    // 2. Update SPRINT-BOARD.md
    if (ticket.boardPath) {
      const boardContent = editor.readFile(ticket.boardPath);
      if (boardContent) {
        const upper = newStatus.toUpperCase();
        const statusGlyph =
          upper.includes("DONE") || upper.includes("CLOSE") || upper.includes("RESOLV")
            ? "✅ "
            : upper.includes("IN_PROGRESS") || upper.includes("IN-PROGRESS") || upper.includes("DEV")
            ? "🔄 "
            : upper.includes("READY") || upper.includes("TODO")
            ? "📋 "
            : upper.includes("REJECT") || upper.includes("CANCEL") || upper.includes("WONTFIX") || upper.includes("INVALID")
            ? "❌ "
            : upper.includes("BLOCK")
            ? "🚫 "
            : "";

        const lines = boardContent.split(/\r?\n/);
        const newLines = lines.map((line) => {
          if (line.includes(`\`${ticket.id}\``) || line.includes(`[${ticket.id}]`)) {
            const parts = line.split("|");
            // | Ticket ID | Title | Priority | SP | Status | Target Code File |
            if (parts.length >= 6) {
              parts[5] = ` ${statusGlyph}\`${newStatus}\` `;
              return parts.join("|");
            }
          }
          return line;
        });
        editor.writeFile(ticket.boardPath, newLines.join("\n"));
      }
    }

    ticket.status = newStatus;
    ticket.statusCategory = categorizeStatus(newStatus);
    return true;
  } catch {
    return false;
  }
}

/**
 * Searches the project workspace to resolve a target code file name to an absolute path.
 */
export async function resolveTargetCodePath(
  editor: EditorAPI,
  targetName: string
): Promise<string | null> {
  if (!targetName) return null;

  // Clean target name if it has parenthetical comments e.g. "KafkaConfig.java (both services)"
  const cleanName = targetName.replace(/\([^)]*\)/g, "").trim();
  const cwd = editor.getCwd();

  // Try direct path first
  const directPath = editor.pathJoin(cwd, cleanName);
  try {
    if (editor.readFile(directPath) !== null) {
      return directPath;
    }
  } catch {}

  // Try git ls-files to locate by filename
  try {
    const handle = editor.spawnProcess("git", ["ls-files", `*${cleanName}*`], cwd);
    const result = await handle.result;
    if (result && result.stdout) {
      const firstMatch = result.stdout.split(/\r?\n/)[0]?.trim();
      if (firstMatch) {
        return editor.pathJoin(cwd, firstMatch);
      }
    }
  } catch {}

  return null;
}
