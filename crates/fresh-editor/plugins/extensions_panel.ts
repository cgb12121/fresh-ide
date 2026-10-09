/// <reference path="./lib/fresh.d.ts" />

/** Extensions view and access to the editor's native theme picker. */

import {
  button,
  col,
  label,
  type WidgetSpec,
  type WidgetEvt,
} from "./lib/widgets.ts";
import { getViewRegistry } from "./lib/view_registry.ts";

const editor = getEditor();
const PANEL_ID = 402;
let isMounted = false;

interface ThemeSummary {
  name?: string;
  _pack?: string;
}

interface ThemeEditorApi {
  open?: () => Promise<void>;
}

function getCustomThemeNames(): string[] {
  try {
    const themes = editor.getAllThemes() as Record<string, ThemeSummary>;
    return Object.values(themes)
      .filter((theme) => (theme?._pack ?? "").startsWith("user"))
      .map((theme) => theme.name ?? "Unnamed theme")
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

export function buildExtensionsPanelSpec(): WidgetSpec {
  const customThemes = getCustomThemeNames();
  return col(
    label("EXTENSIONS", { style: { bold: true, fg: "syntax.keyword" } }),
    label("THEME", { style: { bold: true, fg: "syntax.type" } }),
    button("◐  Choose Color Theme…", {
      key: "ext_choose_theme",
      bare: true,
      fullWidth: true,
      style: { fg: "editor.fg" },
      hoverStyle: { fg: "syntax.function", bold: true },
    }),
    label("MY THEMES", { style: { bold: true, fg: "syntax.type" } }),
    ...(customThemes.length
      ? customThemes.map((name) =>
          label(`  • ${name}`, { style: { fg: "editor.fg" } }),
        )
      : [label("  No custom themes found.", { style: { fg: "editor.line_number_fg" } })]),
    button("✎  Edit Custom Themes…", {
      key: "ext_edit_custom_themes",
      bare: true,
      fullWidth: true,
      style: { fg: "editor.fg" },
      hoverStyle: { fg: "syntax.function", bold: true },
    }),
  );
}

function updatePanel(): void {
  if (!isMounted) return;
  try {
    editor.updateFloatingWidget(PANEL_ID, buildExtensionsPanelSpec());
  } catch {
    // Graceful fallback while the panel is being unmounted.
  }
}

export function mountExtensionsPanel(): void {
  if (isMounted) {
    editor.floatingPanelControl(PANEL_ID, "sidebar_view", 0);
    editor.floatingPanelControl(PANEL_ID, "focus", 0);
    return;
  }
  editor.mountSidebarSection(PANEL_ID, buildExtensionsPanelSpec(), "Extensions", 0, {
    closable: false,
    startBlurred: true,
    scope: "editor",
  });
  editor.floatingPanelControl(PANEL_ID, "sidebar_view", 0);
  editor.floatingPanelControl(PANEL_ID, "focus", 0);
  isMounted = true;
}

export function unmountExtensionsPanel(): void {
  if (!isMounted) return;
  try {
    editor.unmountFloatingWidget(PANEL_ID);
  } catch {
    // Ignore teardown races.
  }
  isMounted = false;
}

editor.on("widget_event", (event: WidgetEvt) => {
  if (event.panel_id !== PANEL_ID ||
      (event.event_type !== "activate" && event.event_type !== "select")) return;
  if (event.widget_key === "ext_choose_theme") {
    // Native picker previews highlighted choices, commits on Enter, and
    // restores the original theme if dismissed.
    editor.executeAction("select_theme");
  } else if (event.widget_key === "ext_edit_custom_themes") {
    const themeEditor = editor.getPluginApi("theme_editor") as ThemeEditorApi | null;
    if (themeEditor?.open) void themeEditor.open();
  }
});

const registry = getViewRegistry();
registry.registerView({
  id: "extensions",
  title: "Extensions",
  icon: "\u{f12e}", // Nerd Font puzzle piece
  hotkey: "Ctrl+Shift+X",
  order: 30,
  onActivate: mountExtensionsPanel,
  onDeactivate: unmountExtensionsPanel,
  render: buildExtensionsPanelSpec,
});

(globalThis as unknown as Record<string, unknown>).extensions_open_panel = () => {
  registry.setActiveView("extensions");
};

editor.registerCommand(
  "extensions:open_panel",
  "Extensions: Open Panel",
  "extensions_open_panel",
  null
);
