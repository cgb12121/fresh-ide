# Offline Jira Backlog Panel & Local Sprint Tracker

> **Status:** IMPLEMENTED (Linear & Lazygit-Inspired Keyboard-First TUI)  
> **Audience:** Fresh core developers, plugin authors, and developers maintaining local Markdown-based backlogs.  
> **Primary Consumer:** Projects using file-backed sprints, specifically PayMeNow (`Workspace/Backlog/Sprint-*/`).

---

## 1. Context & Motivation

Modern engineering workflows frequently encounter environments where cloud-based Jira or issue trackers are either inaccessible, too heavy, or prohibited by security policies. In projects such as `PayMeNow`, agile backlogs and sprint boards are committed directly to Git as structured Markdown artifacts:
- Sprint boards: `Workspace/Backlog/Sprint-01-Core-Hardening/SPRINT-BOARD.md`
- Tickets: `Workspace/Backlog/Sprint-01-Core-Hardening/Tickets/WH-01-*.md`
- Workflow agreements: `Workspace/Backlog/WORKFLOW.md`

Earlier implementations attempted to squeeze full web-dashboard cards (with multi-row action buttons and verbose descriptions) directly into narrow terminal sidebars, causing vertical clipping and visual clutter.

This refactored architecture introduces a **professional, minimal, keyboard-first TUI** inspired by Linear, Lazygit, and modern IDE sidebars:
- **Sidebar:** Clean, compact navigation overview (1 line per issue, virtual scrolling, responsive display widths).
- **Editor Pane:** Native structured virtual buffer (`*Jira: <ID>*`) for deep ticket inspection, markdown section browsing, and contextual actions.

---

## 2. Architecture & Design

### 2.1 Component Structure

```
crates/fresh-editor/plugins/
├── lib/
│   ├── jira_local_store.ts       # Parser, data model & status synchronization engine
│   ├── view_registry.ts          # Extensible Activity Bar view registry
│   └── widgets.ts                # Declarative TUI widgets (list, row, col, dropdown, hintBar)
└── jira_offline_panel.ts         # Compact sidebar navigation & virtual buffer detail view
```

### 2.2 Design Principles

1. **Sidebar = Navigation & Compact Overview:**
   - Single-line issue items by default.
   - High information density without decorative borders or clutter.
   - Minimal semantic status glyphs (`✓`, `●`, `○`, `■`, `✕`, `·`) and priority accents (RGB `[248, 81, 73]`, `syntax.keyword`, `syntax.variable`, `editor.line_number_fg`).
   - Zero emojis as UI icons; Unicode characters with guaranteed terminal cell widths only.
   - Multi-segment progress bar displaying completed work in green (`syntax.string`), rejected work in vibrant red (`[248, 81, 73]`), and uncompleted work in grey (`editor.line_number_fg`).
   - Host-managed virtual scrolling (`list` widget) replacing artificial pagination buttons.

2. **Editor Pane = Detailed Ticket Inspection:**
   - Native Fresh virtual buffer created via `editor.createVirtualBuffer({ name: "Jira: WH-01", mode: "jira-ticket-detail", ... })`.
   - Structured metadata grid: ID, title, status, priority, story points, assignee, epic, sprint, target code file.
   - Rich section rendering: Problem statement, Decisions & Implementation, Acceptance Criteria & Evidence.
   - In-buffer contextual actions: Set / Advance status (`[s]`), Jump to code (`[c]`), Edit raw MD (`[e]`), Git branch (`[b]`), Close (`[q]`).

3. **Responsive Display Widths:**
   - Evaluated dynamically via `editor.dockCols()` across widths 24, 32, 40, and 50 columns.
   - Title truncation using `editor.stringWidth()` display cell width instead of naive byte or string lengths.
   - Scaled progress bars and compact shortcut footers that never wrap or overflow.

---

## 3. Sidebar Layout Specification

```text
 JIRA · PAYMENOW                ?  ⚙  ⟳

 Sprint 1: Core Hardening   ▾
 Webhook Core Hardening & Baseline
 ███████░░░  42/54 SP (8 rej)

 [All (19) ▾]           [Sort: Prio ▾]
 ──────────────────────────────────────
 ✓ WH-01  5pt  Isolate Poison Records in Outbox Batch Publisher
 ✓ WH-02  3pt  Non-Blocking Netty DNS Resolver Configuration
 ✓ WH-03  5pt  Offset Tracker Liveness & Memory Leak Fix
 ● WH-07  5pt  Atomic Native Upsert for Ingest Idempotency
 ○ WH-08  3pt  Strip Lazy History & Response DTO in recordAttempt
 ✕ WH-09  3pt  Deprecated Legacy XML Payload Parsing Support
 ■ WH-10  5pt  Third-party Gateway Signature Validation
```

### 3.1 Elements

1. **Header Row:**
   - Dynamic workspace title `JIRA · <PROJECT>` (e.g., `JIRA · PAYMENOW`, `JIRA · BACKLOG`) styled with `syntax.keyword` (bold).
   - Compact toolbar buttons ` ? `, ` ⚙ ` (path config), ` ⟳ ` (refresh) with tight spacing to guarantee zero horizontal clipping even at 20-col widths.
2. **Sprint Dropdown & Metrics:**
   - Dropdown selector displaying numbered sprints with short topics (`Sprint 1: Core Hardening`, `Sprint 2: Throughput`, `Sprint 3: Reliability`, `All Sprints`).
   - Clean sprint topic / subtitle (`syntax.variable`) with redundant `Sprint \d+ Board:` prefixes stripped and `wrap: true` enabled so it wraps gracefully without ellipsis truncation (`...`).
   - **Multi-segment Progress Bar:** Contiguous single-row bar dynamically partitioned into:
     - Completed points: Green blocks (`█`, `syntax.string`)
     - Rejected / Cancelled points: Red blocks (`█`, `[248, 81, 73]`)
     - Remaining / Todo / In-dev points: Grey blocks (`░`, `editor.line_number_fg`)
   - **Story Point Counter:** Compact `${doneSp}/${totalSp} SP` label alongside a highlighted red count `(${rejectedSp} rej)` when `rejectedSp > 0`.
3. **Filter & Sort Dropdown Row:**
   - Dual dropdowns on the same line: `[All (19) ▾]` (All, To Do, In Dev, Done, Blocked, Rejected) and `[Sort: Prio ▾]` (Sort: Prio, Sort: Points, Sort: ID).
   - Keyboard shortcut `o` cycles through the sort modes (`Prio` → `Points` → `ID`).
   - Keyboard shortcut `f` cycles through all status filters (`All` → `Todo` → `In Dev` → `Done` → `Blocked` → `Rejected`).
4. **Interactive 1-Line Issue Rows:**
   - Strictly single-line layout per ticket for optimal vertical density and rapid navigation.
   - Status glyph button (`✓`, `●`, `○`, `■`, `✕`, `·`): Clickable to cycle status directly.
   - Ticket ID button with criticality color accent: Clickable to preview ticket.
   - Story point pill (`5pt`, `3pt`): Styled with line number ink (`editor.line_number_fg`).
   - Ticket Title: Styled according to priority criticality using explicit RGB accents:
     - **Low / Other:** Light blue (`[110, 180, 245]`, `bold: false`).
     - **Medium:** Vàng (`[240, 195, 60]`, `bold: false`).
     - **High:** Cam (`[255, 145, 40]`, `bold: false`).
     - **Critical / Blocker:** Đỏ đậm không bold (`[185, 40, 40]`, `bold: false`).
   - **Preview Tab Reuse (Anti-Spam):** Clicking any ticket utilizes `editor.previewFileInSplit(splitId, ticket.ticketFilePath)` to open the Markdown file in Fresh's native ephemeral preview tab. Repeated clicks smoothly replace the preview content without piling up multiple editor tabs.

---

## 4. Keyboard Navigation & Interaction Architecture

### 4.1 Modes & Keybindings

Two coordinated modes provide keyboard-first agility:

#### Sidebar Mode (`jira-sidebar`)
| Key | Command | Description |
| :--- | :--- | :--- |
| `j` / `Down` | `jira_nav_down` | Move selection down |
| `k` / `Up` | `jira_nav_up` | Move selection up |
| `Enter` | `jira_open_selected` | Preview ticket in editor pane (replaces preview tab) |
| `x` | `jira_sidebar_cycle_ticket` | Quick cycle status (`READY` → `IN_PROGRESS` → `DONE` → `REJECTED` → `READY`) |
| `S` | `jira_sidebar_status_prompt` | Open interactive status prompt (1-5 or custom status) |
| `/` | `jira_search` | Search issues by ID or title substring |
| `f` | `jira_filter_cycle` | Cycle status filter (`All` → `Todo` → `In Progress` → `Done` → `Blocked` → `Rejected`) |
| `o` | `jira_sort_toggle` | Cycle sort mode (`Priority` → `Story Points` → `Ticket ID`) |
| `s` | `jira_sprint_cycle` | Cycle sprint (`Sprint 01` → `Sprint 02` → ... → `All`) |
| `r` | `jira_refresh_cmd` | Refresh backlog data from disk |
| `?` | `jira_toggle_help` | Toggle keyboard shortcuts cheatsheet |
| `Esc` | `jira_escape` | Clear active search query or close cheatsheet |

#### Ticket Detail Mode (`jira-ticket-detail`)
| Key | Command | Description |
| :--- | :--- | :--- |
| `s` | `jira_detail_status_advance` | Set ticket status via interactive prompt (1:READY, 2:IN_DEV, 3:DONE, 4:BLOCKED, 5:REJECTED, or custom text) |
| `c` | `jira_detail_open_code` | Resolve & open target code file in editor |
| `e` | `jira_detail_edit_raw` | Open raw Markdown ticket file for editing |
| `b` | `jira_detail_branch` | Create and switch to Git branch `feature/<id>` |
| `r` | `jira_refresh_cmd` | Refresh ticket and sprint data |
| `q` / `Esc` | `jira_detail_close` | Close virtual buffer detail view |

---

## 5. Non-Functional Requirements & Invariants

- **100% Offline & File-Backed:** Reads and writes directly to local Markdown repository files.
- **Zero Heavy Dependencies:** Uses existing Fresh widget primitives and theme tokens.
- **Documentation & Code Integrity:** Preserves Markdown formatting, indentation, and comments across status transitions.
- **Responsive Terminal Boundaries:** Accommodates widths 24 through 50 columns without horizontal wrapping or clipping.
