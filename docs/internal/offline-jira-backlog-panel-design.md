# Offline Jira Backlog Panel & Local Sprint Tracker

> **Status:** PROPOSED & IMPLEMENTED  
> **Audience:** Fresh core developers, plugin authors, and developers maintaining local Markdown-based backlogs.  
> **Primary Consumer:** Projects using file-backed sprints, specifically PayMeNow (`Workspace/Backlog/Sprint-*/`).

---

## 1. Context & Motivation

Modern engineering workflows frequently encounter environments where cloud-based Jira or issue trackers are either inaccessible, too heavy, or prohibited by security policies. In projects such as `PayMeNow`, agile backlogs and sprint boards are committed directly to Git as structured Markdown artifacts:
- Sprint boards: `Workspace/Backlog/Sprint-01-Core-Hardening/SPRINT-BOARD.md`
- Tickets: `Workspace/Backlog/Sprint-01-Core-Hardening/Tickets/WH-01-*.md`
- Workflow agreements: `Workspace/Backlog/WORKFLOW.md`

While this offline-first, Git-tracked issue management provides excellent versioning and diffability, interacting with it requires manual file browsing, context switching between editor panes, and hand-editing table rows and frontmatter when transitioning statuses.

This design introduces a first-class **Offline Jira Backlog Panel** directly embedded into Fresh IDE's Workbench Activity Bar.

---

## 2. Architecture & Design

### 2.1 Component Structure

```
crates/fresh-editor/plugins/
├── lib/
│   ├── jira_local_store.ts       # Parser, data model & status synchronization engine
│   └── view_registry.ts          # Extensible Activity Bar view registry
└── jira_offline_panel.ts         # Workbench sidebar panel & interactive Kanban widget tree
```

### 2.2 Extensible View Registration

The Jira panel hooks into Fresh's Activity Bar navigation rail via `ViewRegistry`:
- **ID:** `"jira"`
- **Title:** `"Offline Jira Backlog"`
- **Icon:** `\u{f0ae}` (Font Awesome 4 `tasks` glyph, broad Nerd Font compatibility)
- **Hotkey:** `Ctrl+Shift+J`
- **Order:** `35` (stationed between Extensions at 30 and Agent Sessions at 40)
- **Panel ID:** `403` (unique persistent floating/sidebar section)

### 2.3 Data Storage & Markdown Schema

The storage model is zero-database, relying entirely on existing repository files:
1. **Sprint Discovery:**
   - Scans candidate roots: `<cwd>/Workspace/Backlog`, `<cwd>/.backlog`, `<cwd>/backlog`, or explicit paths.
   - Detects all sprint directories (e.g., `Sprint-01-Core-Hardening`, `Sprint-02-Throughput-Scale`, `Sprint-03-Reliability-Observability`).
2. **Sprint Board Parser (`SPRINT-BOARD.md`):**
   - Extracts Sprint metadata: ID, Cycle, Sprint Goal, Story Point capacities.
   - Extracts Kanban Table rows: `| Ticket ID | Title | Priority | SP | Status | Target Code File |`.
3. **Ticket Detail Parser (`Tickets/*.md`):**
   - Reads frontmatter key-value pairs (`- **ID:**`, `- **Priority:**`, `- **Status:**`, `- **Assignee:**`).
   - Extracts problem statements, user stories, and acceptance criteria.
4. **Two-Way Status Synchronization:**
   - When a ticket status transitions (e.g. from `READY_FOR_DEV` to `IN_PROGRESS` or `DONE`), the store updates both:
     1. The ticket's individual Markdown file (`Tickets/WH-XX-*.md`).
     2. The sprint table row in `SPRINT-BOARD.md`.

---

## 3. User Experience & Interactions

The sidebar panel renders a compact, high-density TUI Kanban board:

1. **Dropdown Sprint Navigation:**
   - Native `dropdown` selector switching smoothly between sprints (`Sprint-01`, `Sprint-02`, `Sprint-03`, `All Sprints`) with live ticket counts and SP metrics.
   - Direct `[📋 Open Board]` affordance opening `SPRINT-BOARD.md` (or `README.md` for master roadmap).
2. **Dropdown Status Filters:**
   - Native `dropdown` selector for status buckets: `All`, `To Do / Ready`, `In Progress`, `Done`, `Blocked / Gated`.
3. **Pagination & Viewport Bounding:**
   - Sidebar-aware pagination (`[◀ Prev] Page X/Y [Next ▶]`) preventing vertical viewport clipping on large backlogs.
4. **Dynamic Configuration:**
   - `[⚙ Path]` header action triggering an asynchronous prompt to change or customize the Backlog root directory dynamically at runtime.
5. **Markdown Preview Integration:**
   - Clicking any ticket card title (`👁 WH-XX: Title`) or the `[👁 Preview]` button opens the ticket markdown file directly in Fresh's full Compose/Preview mode via `markdownToggleCompose`.
   - A companion `[✎ Edit]` button remains available for direct raw Markdown authoring.
6. **Developer Workflows:**
   - **Open Code:** Resolves and jumps directly to the target code file in the project.
   - **Cycle Status:** Promotes the ticket through the development lifecycle (`READY` → `IN_PROGRESS` → `DONE`), writing both the ticket and the sprint board.
   - **Git Branch:** Spawns a new Git branch (`feature/<ticket-id>`) aligned with ticket scope.

---

## 4. Non-Functional Requirements & Invariants

- **100% Offline:** No cloud connections, Jira REST APIs, or telemetry.
- **Fast Startup:** Directory scans and Markdown parsing are cached in memory and refreshed on demand or on file write.
- **Documentation Integrity:** File updates preserve existing markdown text, indentation, and comments.
