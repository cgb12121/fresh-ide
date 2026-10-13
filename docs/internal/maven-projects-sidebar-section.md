# Maven / Java Projects Sidebar Section

> **Status:** IMPLEMENTED  
> **Audience:** Java / Maven developers using Fresh IDE, plugin authors.  
> **Target Scenarios:** Multi-module Maven / Java projects (e.g. `PayMeNow/BE`) running Eclipse JDT.LS.

---

## 1. Context & Motivation

In large multi-module Java/Maven projects, developers frequently exclude certain modules via `java.import.exclusions` or `java.project.resourceFilters` to conserve RAM and prevent JDT.LS from building unnecessary microservices.

However, without a dedicated project inspector, developers cannot easily see:
1. Which modules are actively loaded (`[active]`) vs excluded (`[excluded]`).
2. Total configured heap allocation for the Java language server (e.g., `1GB Heap`).
3. Quick access to individual module `pom.xml` descriptors.

In VS Code, this capability is provided by the *Java Projects* and *Maven* explorer views. In Fresh, this plugin adds a dedicated, lightweight sidebar accordion section placed below the File Explorer.

---

## 2. Architecture & Design

### 2.1 Placement & Accordion Integration

The section utilizes Fresh's native sidebar section mechanism:
```ts
editor.mountSidebarSection(PANEL_ID, spec, "Maven Projects", requestedRows, {
  closable: true,
  startBlurred: true,
  scope: "editor",
});
```

- **Clean Stacking:** Stacks vertically beneath the File Explorer in the sidebar column.
- **Markdown TOC Coexistence:** When Markdown files (`.md`) are opened, `markdown_toc.ts` mounts its `Contents` section. Both sections sit stacked in the accordion column with independent draggable dividers and collapse toggles (`▶` / `▼`).
- **Zero Overhead on Non-Java Projects:** Scans only when a root/reactor `pom.xml` is present in the workspace. If no Maven descriptors exist, the section automatically remains unmounted.

---

## 3. UI Specification

```text
┌ ▼ File Explorer ───────────────────────×─┐
│  ▶ merchant-service                      │
│  ▼ webhook-delivery-service              │
│    ▶ src                                 │
│    📄 pom.xml                            │
├ ▼ Maven Projects ──────────────────────×─┤
│ ☕ 3/7 · LSP Off                       ⟳ │
│                                          │
│ ● webhook-delivery-service               │
│ ● webhook-dispatch-service               │
│ ● lib/common                             │
│ ○ merchant-service                       │
│ ○ payment-service                        │
│ ○ panoptes-service                       │
│ ○ webhook-api-service                    │
└──────────────────────────────────────────┘
```

### 3.1 Indicators & Actions
- **Active / Included Modules:** Indicated with a bright green bullet (`●`) and green text. Clickable to open that module's `pom.xml`.
- **Excluded Modules:** Indicated with a hollow muted bullet (`○`) and muted grey text. Clickable to jump to the module descriptor.
- **LSP State Awareness:** Summary line clearly reflects whether Java LSP is currently running or off (`LSP Off`), and shows configured heap allocation.
- **No Verbose Suffixes:** Clean, compact display without redundant `[active]` or `[excluded]` text tags.
- **Refresh Action:** Toolbar button ` ⟳ ` immediately rescans `pom.xml` and `.fresh/config.json`.
- **Command Palette:**
  - `Maven: Refresh Projects Panel` (`maven_refresh_projects`)
  - `Maven: Toggle Projects Panel` (`maven_toggle_projects_panel`)
