/// <reference path="./lib/fresh.d.ts" />

/**
 * Activity Bar & View Switcher
 *
 * Provides a vertical workbench navigation rail across Explorer, Source Control,
 * Extensions, and Agent Sessions, dynamically reflecting any custom plugins.
 */

import {
  button,
  col,
  flexSpacer,
  spacer,
  type WidgetSpec,
  type WidgetEvt,
} from "./lib/widgets.ts";
import { getViewRegistry, type ViewDefinition } from "./lib/view_registry.ts";

const editor = getEditor();
const BAR_PANEL_ID = 400;

const registry = getViewRegistry();

interface OrchestratorApi {
  isDockOpen?: () => boolean;
  closeDock?: () => void;
  openDock?: () => void;
}

function getOrchestratorApi(): OrchestratorApi | null {
  try {
    return editor.getPluginApi("orchestrator") as OrchestratorApi | null;
  } catch {
    return null;
  }
}

// Register the default Explorer view
registry.registerView({
  id: "explorer",
  title: "Explorer",
  icon: "\u{f07b}", // Nerd Font md-folder (solid; f07c is the open folder, which
                   // reads as "currently open" rather than "Explorer")
  hotkey: "Ctrl+Shift+E",
  order: 10,
  onActivate: () => {
    editor.floatingPanelControl(BAR_PANEL_ID, "activity_show", 1);
    editor.executeAction("focus_file_explorer");
  },
});

// Register the Agent Sessions view (coordinates cleanly with Fresh's native Dock)
registry.registerView({
  id: "agents",
  title: "Agent Sessions",
  icon: "\u{f544}", // Nerd Font robot
  hotkey: "Ctrl+Shift+A",
  order: 40,
});

function toggleAgentDock(): void {
  const orch = getOrchestratorApi();
  if (orch?.isDockOpen?.()) {
    orch.closeDock?.();
  } else if (orch?.openDock) {
    orch.openDock();
  } else {
    try {
      editor.executeAction("orchestrator_dock_toggle");
    } catch {}
  }
  updateBar();
}

function renderViewButton(v: ViewDefinition, isActive: boolean): WidgetSpec {
  // The sidebar reserves five columns; the native button renderer supplies
  // the three-row vertical tile around this centered, one-cell glyph.
  const labelText = `  ${v.icon}  `;

  return button(labelText, {
    key: `act_view:${v.id}`,
    bare: true,
    fullWidth: true,
    intent: isActive ? "primary" : "normal",
    style: isActive
      ? { bold: true, fg: "syntax.keyword" }
      : { bold: true, fg: "editor.fg" },
    hoverStyle: { fg: "syntax.function", bold: true },
  });
}

function buildActivityBarSpec(): WidgetSpec {
  const views = registry.getAllViews();
  const activeId = registry.getActiveViewId();
  const agentActive = getOrchestratorApi()?.isDockOpen?.() ?? false;

  const topViews = views.filter((v) => v.order < 40);
  const bottomViews = views.filter((v) => v.order >= 40);

  const widgets: WidgetSpec[] = [];

  // Top section (Explorer, Source Control, Extensions...)
  for (let i = 0; i < topViews.length; i++) {
    const v = topViews[i];
    widgets.push(renderViewButton(v, v.id === activeId));
    if (i < topViews.length - 1) {
      widgets.push(spacer(1));
    }
  }

  // Flex spacer pushes the utility/agent section to the bottom, matching VS Code
  if (bottomViews.length > 0) {
    widgets.push(flexSpacer());
    for (let i = 0; i < bottomViews.length; i++) {
      const v = bottomViews[i];
      widgets.push(renderViewButton(v, v.id === "agents" ? agentActive : v.id === activeId));
      if (i < bottomViews.length - 1) {
        widgets.push(spacer(1));
      }
    }
    widgets.push(spacer(1));
  }

  widgets.push(
    button(`  \u{f013}  `, {
      key: "act_settings",
      bare: true,
      fullWidth: true,
      style: { bold: true, fg: "editor.fg" },
      hoverStyle: { fg: "syntax.function", bold: true },
    })
  );
  widgets.push(spacer(1));

  return col(...widgets);
}

function updateBar(): void {
  try {
    editor.updateFloatingWidget(BAR_PANEL_ID, buildActivityBarSpec());
  } catch {
    // Ignore if not mounted
  }
}

function mountBar(): void {
  const spec = buildActivityBarSpec();
  editor.mountSidebarSection(BAR_PANEL_ID, spec, "Activity Bar", 0, {
    closable: false,
    startBlurred: true,
    scope: "editor",
  });
  editor.floatingPanelControl(BAR_PANEL_ID, "activity_bar", 0);
}

// React to view changes
registry.subscribe(() => {
  updateBar();
});

// Event dispatcher for Activity Bar buttons
editor.on("widget_event", (event: WidgetEvt) => {
  if (event.panel_id !== BAR_PANEL_ID) {
    return;
  }

  // Only respond to click/activation events, ignoring raw focus/blur events
  if (event.event_type !== "activate" && event.event_type !== "select") {
    return;
  }

  const key = event.widget_key ?? "";
  if (key === "act_settings") {
    editor.executeAction("open_settings");
    return;
  }
  if (key.startsWith("act_view:")) {
    const viewId = key.slice("act_view:".length);
    if (viewId === "agents") {
      toggleAgentDock();
      return;
    }
    if (viewId === registry.getActiveViewId()) {
      editor.floatingPanelControl(BAR_PANEL_ID, "activity_show", -1);
    } else {
      registry.setActiveView(viewId);
      if (viewId !== "agents") {
        editor.floatingPanelControl(BAR_PANEL_ID, "activity_show", 1);
      }
    }
  }
});

// Mount on editor startup
mountBar();

// Register global keyboard shortcuts
const g = globalThis as unknown as Record<string, unknown>;

g.workbench_view_explorer = () => {
  if (registry.getActiveViewId() === "explorer") {
    editor.floatingPanelControl(BAR_PANEL_ID, "activity_show", -1);
  } else {
    registry.setActiveView("explorer");
    editor.floatingPanelControl(BAR_PANEL_ID, "activity_show", 1);
  }
};
editor.registerCommand(
  "workbench:view_explorer",
  "View: Show Explorer",
  "workbench_view_explorer",
  null
);

g.workbench_view_scm = () => {
  if (registry.getActiveViewId() === "git") {
    editor.floatingPanelControl(BAR_PANEL_ID, "activity_show", -1);
  } else {
    registry.setActiveView("git");
    editor.floatingPanelControl(BAR_PANEL_ID, "activity_show", 1);
  }
};
editor.registerCommand(
  "workbench:view_scm",
  "View: Show Source Control (Git)",
  "workbench_view_scm",
  null
);

g.workbench_view_extensions = () => {
  if (registry.getActiveViewId() === "extensions") {
    editor.floatingPanelControl(BAR_PANEL_ID, "activity_show", -1);
  } else {
    registry.setActiveView("extensions");
    editor.floatingPanelControl(BAR_PANEL_ID, "activity_show", 1);
  }
};
editor.registerCommand(
  "workbench:view_extensions",
  "View: Show Extensions",
  "workbench_view_extensions",
  null
);

g.workbench_view_agents = () => {
  toggleAgentDock();
};
editor.registerCommand(
  "workbench:view_agents",
  "View: Toggle Agent Sessions Dock",
  "workbench_view_agents",
  null
);
