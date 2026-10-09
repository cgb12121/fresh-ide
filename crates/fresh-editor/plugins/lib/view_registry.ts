/// <reference path="./fresh.d.ts" />

/**
 * Extensible Sidebar View Registry
 *
 * Central registry enabling Fresh core plugins and custom user plugins to register
 * custom sidebar views, tabs, and activity bar items dynamically.
 */

import type { WidgetSpec, WidgetEvt } from "./widgets.ts";

export interface ViewDefinition {
  /** Unique view identifier, e.g. "explorer", "git", "extensions", "database". */
  id: string;
  /** Human-readable title displayed in headers or tooltips, e.g. "Source Control". */
  title: string;
  /** Icon glyph displayed on the navigation bar, e.g. "📁", "🌿", "🧩", "🤖". */
  icon: string;
  /** Optional keyboard shortcut label, e.g. "Ctrl+Shift+G". */
  hotkey?: string;
  /** Visual order on the activity switcher bar (lower numbers appear first). */
  order: number;
  /** Special action handler when the view icon is triggered (e.g. toggling the native Agent Dock). */
  customAction?: () => void;
  /** Builds the WidgetSpec tree for rendering inside the sidebar section. */
  render?: (width: number, height: number) => WidgetSpec;
  /** Dispatches widget interaction events targeting this view. */
  onEvent?: (event: WidgetEvt) => void;
  /** Called when this view becomes active. */
  onActivate?: () => void;
  /** Called when switching away from this view. */
  onDeactivate?: () => void;
}

export type ViewRegistryListener = () => void;

export class ViewRegistry {
  private views = new Map<string, ViewDefinition>();
  private activeViewId: string = "explorer";
  private listeners: Set<ViewRegistryListener> = new Set();

  /**
   * Register a new view in the sidebar.
   * Returns an unregister function for easy cleanup.
   */
  public registerView(view: ViewDefinition): () => void {
    this.views.set(view.id, view);
    this.notify();
    return () => {
      this.unregisterView(view.id);
    };
  }

  /**
   * Unregister an existing view.
   */
  public unregisterView(id: string): void {
    const current = this.views.get(id);
    if (this.activeViewId === id) current?.onDeactivate?.();
    if (this.views.delete(id)) {
      if (this.activeViewId === id) {
        this.activeViewId = "explorer";
        this.views.get("explorer")?.onActivate?.();
      }
      this.notify();
    }
  }

  /**
   * Get a view definition by ID.
   */
  public getView(id: string): ViewDefinition | undefined {
    return this.views.get(id);
  }

  /**
   * Return all registered views sorted by order.
   */
  public getAllViews(): ViewDefinition[] {
    return Array.from(this.views.values()).sort((a, b) => a.order - b.order);
  }

  /**
   * Current active view ID.
   */
  public getActiveViewId(): string {
    return this.activeViewId;
  }

  /**
   * Switch the active sidebar view.
   */
  public setActiveView(id: string): void {
    const view = this.views.get(id);
    if (!view) return;
    if (this.activeViewId === id) {
      if (view.customAction) {
        view.customAction();
      } else {
        view.onActivate?.();
      }
      return;
    }
    const previous = this.views.get(this.activeViewId);
    previous?.onDeactivate?.();
    this.activeViewId = id;
    if (view.customAction) {
      view.customAction();
    } else {
      view.onActivate?.();
    }
    this.notify();
  }

  /**
   * Clear active view highlight (e.g. when panel is collapsed or dock closed).
   */
  public clearActiveView(): void {
    if (!this.activeViewId) return;
    const previous = this.views.get(this.activeViewId);
    previous?.onDeactivate?.();
    this.activeViewId = "";
    this.notify();
  }

  /**
   * Subscribe to registry changes (views added/removed or active view switched).
   */
  public subscribe(listener: ViewRegistryListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Guard against listener exceptions
      }
    }
  }
}

// Fresh gives each plugin its own QuickJS context. Share the registry through
// the host's API plane, which restores objects into the caller's context.
export function getViewRegistry(): ViewRegistry {
  const editor = getEditor();
  const shared = editor.getPluginApi("workbench-views") as ViewRegistry | null;
  if (shared) return shared;
  const registry = new ViewRegistry();
  editor.exportPluginApi("workbench-views", registry);
  return registry;
}
