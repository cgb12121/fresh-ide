/// <reference path="./lib/fresh.d.ts" />

/**
 * Maven / Java Projects Sidebar Section Plugin
 *
 * Displays detected Maven reactor modules, showing which modules are actively
 * loaded by Eclipse JDT.LS vs excluded via `java.import.exclusions` / `resourceFilters`.
 *
 * Sits as a collapsible accordion section in the sidebar column below the File Explorer,
 * coexisting cleanly with `markdown_toc` when Markdown documents are opened.
 */

import {
  button,
  col,
  label,
  row,
  spacer,
  type WidgetSpec,
  type WidgetEvt,
} from "./lib/widgets.ts";

const editor = getEditor();
const PANEL_ID = 405;

interface MavenModule {
  name: string;
  relPath: string;
  pomPath: string;
  isActive: boolean;
}

interface MavenWorkspaceInfo {
  rootPomPath: string;
  projectName: string;
  heapSizeStr: string;
  isLspEnabled: boolean;
  modules: MavenModule[];
}

let isMounted = false;
let workspaceInfo: MavenWorkspaceInfo | null = null;

/**
 * The goals the panel offers, in the order a build normally runs them.
 *
 * The label is both what the native menu shows and what the `plugin_menu`
 * event hands back on choice, so the dispatch below looks it up here — a
 * renamed label has to be renamed in one place only.
 */
const MAVEN_GOALS: ReadonlyArray<{ label: string; args: string[] }> = [
  { label: "Build", args: ["install"] },
  { label: "Clean Build", args: ["clean", "install"] },
  { label: "Build (skip tests)", args: ["clean", "install", "-DskipTests"] },
  { label: "Clean", args: ["clean"] },
  { label: "Compile", args: ["compile"] },
  { label: "Test", args: ["test"] },
  { label: "Package", args: ["package"] },
  { label: "Validate", args: ["validate"] },
  { label: "Dependency Tree", args: ["dependency:tree"] },
];

/** Same goal list wherever it is offered: the widget key, not the menu,
 *  is what tells a reactor-wide run from a `-pl` module run. */
function mavenMenuLabels(): string[] {
  return MAVEN_GOALS.map((g) => g.label);
}

/**
 * Safely strips JSONC comments without breaking URLs (e.g. https://) inside string literals.
 */
function stripJsonComments(str: string): string {
  let insideString = false;
  let result = "";
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (insideString) {
      result += ch;
      if (ch === "\\" && i + 1 < str.length) {
        result += str[i + 1];
        i++;
      } else if (ch === '"') {
        insideString = false;
      }
    } else {
      if (ch === '"') {
        insideString = true;
        result += ch;
      } else if (ch === "/" && i + 1 < str.length && str[i + 1] === "/") {
        // Line comment: skip until newline
        while (i < str.length && str[i] !== "\n") {
          i++;
        }
        if (i < str.length) result += "\n";
      } else if (ch === "/" && i + 1 < str.length && str[i + 1] === "*") {
        // Block comment: skip until */
        i += 2;
        while (i + 1 < str.length && !(str[i] === "*" && str[i + 1] === "/")) {
          i++;
        }
        i++; // skip /
      } else {
        result += ch;
      }
    }
  }
  return result;
}

/**
 * Locate root or parent pom.xml for the current workspace.
 */
function findRootPomPath(): string | null {
  const cwd = editor.getCwd().replace(/\\/g, "/");

  // 1. Direct pom.xml in root
  const rootPom = `${cwd}/pom.xml`;
  if (editor.fileExists(editor.localPath(rootPom))) {
    return rootPom;
  }

  // 2. Multi-module backend directory (e.g. PayMeNow/BE/pom.xml)
  const bePom = `${cwd}/BE/pom.xml`;
  if (editor.fileExists(editor.localPath(bePom))) {
    return bePom;
  }

  // 3. Lowercase be/pom.xml or server/pom.xml or backend/pom.xml
  for (const sub of ["backend", "server", "core"]) {
    const candidate = `${cwd}/${sub}/pom.xml`;
    if (editor.fileExists(editor.localPath(candidate))) {
      return candidate;
    }
  }

  return null;
}

/**
 * Read and parse Maven reactor modules & JDT.LS exclusions.
 */
function scanMavenWorkspace(): MavenWorkspaceInfo | null {
  const rootPomPath = findRootPomPath();
  if (!rootPomPath) {
    return null;
  }

  const pomContent = editor.readFile(editor.localPath(rootPomPath));
  if (!pomContent) {
    return null;
  }

  // Parse project artifactId / name
  const nameMatch = pomContent.match(/<name>(.*?)<\/name>/);
  const artifactMatch = pomContent.match(/<artifactId>(.*?)<\/artifactId>/);
  const projectName = nameMatch?.[1] || artifactMatch?.[1] || "Maven Project";

  // Parse <modules> block
  const rawModules: string[] = [];
  const modulesBlockMatch = pomContent.match(/<modules>([\s\S]*?)<\/modules>/);
  if (modulesBlockMatch) {
    const moduleMatches = modulesBlockMatch[1].matchAll(/<module>(.*?)<\/module>/g);
    for (const m of moduleMatches) {
      const mod = m[1].trim();
      if (mod.length > 0) {
        rawModules.push(mod);
      }
    }
  }

  // Read config for JDT.LS exclusions, enabled state & heap size
  let exclusions: string[] = [];
  let heapSizeStr = "1GB Heap";
  let isLspEnabled = false;

  // 1. Try reading editor.getConfig() first
  try {
    const cfg = editor.getConfig() as Record<string, unknown> | null;
    const lsp = cfg?.lsp as Record<string, unknown> | undefined;
    const rawJava = lsp?.java;
    const javaCfg = Array.isArray(rawJava) ? rawJava[0] : (rawJava as Record<string, unknown> | undefined);
    if (javaCfg) {
      if (javaCfg.enabled === true && javaCfg.auto_start !== false) {
        isLspEnabled = true;
      }
      const opts = javaCfg.initialization_options as Record<string, unknown> | undefined;
      const settings = opts?.settings as Record<string, unknown> | undefined;
      const java = settings?.java as Record<string, unknown> | undefined;
      const imp = java?.import as Record<string, unknown> | undefined;
      if (Array.isArray(imp?.exclusions)) {
        exclusions = imp.exclusions.map((e) => String(e));
      }
      if (Array.isArray(javaCfg.args)) {
        for (const arg of javaCfg.args) {
          const a = String(arg);
          if (a.startsWith("-Xmx")) {
            const val = a.slice(4).toLowerCase();
            if (val.endsWith("m")) {
              const mb = parseInt(val.slice(0, -1), 10);
              heapSizeStr = mb >= 1024 ? `${(mb / 1024).toFixed(1).replace(".0", "")}GB` : `${mb}MB`;
            } else if (val.endsWith("g")) {
              heapSizeStr = `${val.slice(0, -1)}GB`;
            }
          }
        }
      }
    }
  } catch (_e) {}

  // 2. Direct read from .fresh/config.json with safe JSONC parser
  try {
    const cwd = editor.getCwd().replace(/\\/g, "/");
    const configPath = `${cwd}/.fresh/config.json`;
    if (editor.fileExists(editor.localPath(configPath))) {
      const rawConfig = editor.readFile(editor.localPath(configPath));
      if (rawConfig) {
        const stripped = stripJsonComments(rawConfig);
        const parsed = JSON.parse(stripped);
        const rawJava = parsed?.lsp?.java;
        const javaCfg = Array.isArray(rawJava) ? rawJava[0] : rawJava;
        if (javaCfg) {
          // If enabled is false or auto_start is false, LSP is off
          isLspEnabled = javaCfg.enabled === true && javaCfg.auto_start !== false;

          const jdtExcl =
            javaCfg?.initialization_options?.settings?.java?.import?.exclusions;
          if (Array.isArray(jdtExcl)) {
            exclusions = jdtExcl.map((e) => String(e));
          }
          const args = javaCfg?.args;
          if (Array.isArray(args)) {
            for (const arg of args) {
              const argStr = String(arg);
              if (argStr.startsWith("-Xmx")) {
                const val = argStr.slice(4).toLowerCase();
                if (val.endsWith("m")) {
                  const mb = parseInt(val.slice(0, -1), 10);
                  heapSizeStr = mb >= 1024 ? `${(mb / 1024).toFixed(1).replace(".0", "")}GB` : `${mb}MB`;
                } else if (val.endsWith("g")) {
                  heapSizeStr = `${val.slice(0, -1)}GB`;
                }
              }
            }
          }
        }
      }
    }
  } catch (_e) {}

  const baseDir = editor.pathDirname(rootPomPath);
  const modules: MavenModule[] = rawModules.map((rel) => {
    const normalized = rel.replace(/\\/g, "/");
    const modName = normalized.split("/").pop() || normalized;
    const modPom = `${baseDir}/${normalized}/pom.xml`;

    // Check if module matches any exclusion pattern
    const isExcluded = exclusions.some((pattern) => {
      const cleanPat = pattern
        .replace(/\*\*/g, "")
        .replace(/\*/g, "")
        .replace(/^\/+|\/+$/g, "");
      return cleanPat.length > 0 && (normalized.includes(cleanPat) || modName === cleanPat);
    });

    return {
      name: modName,
      relPath: normalized,
      pomPath: modPom,
      isActive: !isExcluded,
    };
  });

  return {
    rootPomPath,
    projectName,
    heapSizeStr,
    isLspEnabled,
    modules,
  };
}

/**
 * Build the WidgetSpec tree for the sidebar section.
 */
function buildMavenSectionSpec(info: MavenWorkspaceInfo): WidgetSpec {
  const activeCount = info.modules.filter((m) => m.isActive).length;
  const totalCount = info.modules.length;

  const rows: WidgetSpec[] = [];

  // Summary Row: "3/7 · 1GB" hoặc "3/7 · LSP Off"
  const lspStatusTag = info.isLspEnabled ? info.heapSizeStr : "LSP Off";
  const summaryText = ` ☕ ${activeCount}/${totalCount} · ${lspStatusTag}`;

  rows.push(
    row(
      // The project row is the reactor's target: a right press anywhere on it
      // opens the goal menu, which is where the eye already is. The left press
      // only points at the menu, since a bare button has no action of its own.
      button(summaryText, {
        key: "maven_root_menu",
        bare: true,
        // Display rows, not tab stops. Focus would paint `ui.popup_selection_bg`
        // around the word, and this panel is mouse-driven — a right press opens
        // the goal menu without needing focus first. Dropping them from the Tab
        // cycle keeps the band off; `hit_node` is added for every non-disabled
        // button regardless, so clicks and the declared menu still answer.
        focusable: false,
        style: {
          fg: info.isLspEnabled ? "syntax.variable" : [160, 160, 170],
          bold: true,
        },
        hoverStyle: { fg: "syntax.function", bold: true },
        contextMenu: mavenMenuLabels(),
      }),
      button(" ⟳ ", {
        key: "maven_refresh_btn",
        bare: true,
        focusable: false,
        hoverStyle: { fg: "syntax.function", bold: true },
      })
    )
  );

  rows.push(spacer(1));

  // Module items — clean green for active, grey for excluded, NO suffix labels
  if (info.modules.length === 0) {
    rows.push(
      label("   (Single module project)", {
        style: { fg: "editor.line_number_fg", italic: true },
      })
    );
  } else {
    for (const m of info.modules) {
      const activeColor: [number, number, number] = [70, 205, 120]; // Green
      const excludedColor: [number, number, number] = [140, 140, 150]; // Grey

      const dotColor = m.isActive ? activeColor : excludedColor;
      const dotGlyph = m.isActive ? "● " : "○ ";

      rows.push(
        row(
          label(" " + dotGlyph, {
            style: { fg: dotColor, bold: m.isActive },
          }),
          button(m.name, {
            key: `maven_open_mod:${m.pomPath}`,
            bare: true,
            // Same as the project row above: a focus band around every module
            // name is not what a status list should paint.
            focusable: false,
            style: {
              fg: m.isActive ? activeColor : excludedColor,
              bold: m.isActive,
            },
            hoverStyle: { fg: "syntax.function", bold: true },
            // Scoped by the key: the same list runs with `-pl <module> -am`.
            contextMenu: mavenMenuLabels(),
          })
        )
      );
    }
  }

  return col(...rows);
}

function refreshMavenPanel(): void {
  workspaceInfo = scanMavenWorkspace();
  if (!workspaceInfo) {
    if (isMounted) {
      editor.unmountFloatingWidget(PANEL_ID);
      isMounted = false;
    }
    return;
  }

  const spec = buildMavenSectionSpec(workspaceInfo);
  const reqRows = Math.max(5, Math.min(10, workspaceInfo.modules.length + 3));

  if (!isMounted) {
    editor.mountSidebarSection(PANEL_ID, spec, "Maven Projects", reqRows, {
      closable: true,
      startBlurred: true,
      scope: "editor",
    });
    isMounted = true;
  } else {
    editor.updateFloatingWidget(PANEL_ID, spec);
  }
}

/**
 * Run a Maven goal in its own terminal split, so the build's own output is
 * the progress display rather than a spinner that hides the log.
 *
 * `mvn` is a `.cmd` shim on Windows, which no shell-less argv spawn can
 * execute, so there the whole goal line goes through `cmd /c`.
 */
async function runMavenGoal(
  info: MavenWorkspaceInfo,
  goals: string[],
  moduleRel: string | null,
): Promise<void> {
  const args = ["-f", info.rootPomPath];
  // `-pl` only means anything inside a reactor; a single-module project has
  // none, so the flag would be rejected rather than ignored.
  if (moduleRel && info.modules.length > 0) {
    args.push("-pl", moduleRel, "-am");
  }
  args.push(...goals);

  const onWindows = editor.getEnv("OS") === "Windows_NT";
  const command = onWindows ? ["cmd", "/c", "mvn", ...args] : ["mvn", ...args];
  const goalLine = goals.join(" ");
  const scope = moduleRel ? `${moduleRel}: ` : "";

  try {
    await editor.createTerminal({
      cwd: editor.pathDirname(info.rootPomPath),
      command,
      title: `mvn ${goalLine}`,
      focus: true,
    });
    editor.setStatus(`${scope}mvn ${goalLine}`);
  } catch (e) {
    editor.setStatus(
      `${scope}Maven failed to start: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/** Answer the goal the native menu reported. The widget key picks the scope:
 *  the project row runs the whole reactor, a module row adds `-pl`. */
async function runMavenMenuChoice(key: string, label: string): Promise<void> {
  const info = workspaceInfo;
  if (!info) return;

  const goal = MAVEN_GOALS.find((g) => g.label === label);
  if (!goal) return;

  let moduleRel: string | null = null;
  if (key === "maven_root_menu") {
    moduleRel = null;
  } else if (key.startsWith("maven_open_mod:")) {
    const pomPath = key.slice("maven_open_mod:".length);
    const mod = info.modules.find((m) => m.pomPath === pomPath);
    if (!mod) return;
    moduleRel = mod.relPath;
  } else {
    return;
  }

  await runMavenGoal(info, goal.args, moduleRel);
}

// ── Event Handlers ───────────────────────────────────────────────────────────

editor.on("widget_event", async (event: WidgetEvt) => {
  if (event.panel_id !== PANEL_ID) return;

  if (event.event_type === "cancel") {
    isMounted = false;
    return;
  }

  const key = event.widget_key || "";

  // A right press on a button that declared a menu: the host opened it
  // itself — geometry, navigation, dismissal — and reports only the label
  // chosen. It is not an `activate`, so it must be answered before the
  // handlers below.
  if (event.event_type === "plugin_menu") {
    const chosen = String((event.payload as { label?: unknown })?.label ?? "");
    await runMavenMenuChoice(key, chosen);
    return;
  }

  if (key === "maven_refresh_btn") {
    refreshMavenPanel();
    editor.setStatus("Maven Projects refreshed");
    return;
  }

  if (key === "maven_root_menu") {
    editor.setStatus("Right-click for Maven goals (build, clean build, test, …)");
    return;
  }

  if (key.startsWith("maven_open_mod:")) {
    const pomPath = key.slice("maven_open_mod:".length);
    if (editor.fileExists(editor.localPath(pomPath))) {
      editor.openFile(pomPath, 1, 1);
      editor.setStatus(`Opened ${pomPath}`);
    } else {
      editor.setStatus(`POM file not found: ${pomPath}`);
    }
  }
});

function on_maven_refresh_cmd(): void {
  refreshMavenPanel();
  editor.setStatus("Maven Projects panel refreshed");
}
registerHandler("maven_refresh_projects", on_maven_refresh_cmd);

editor.registerCommand(
  "Maven: Refresh Projects Panel",
  "Scan and refresh Maven modules status in sidebar",
  "maven_refresh_projects",
  null
);

function on_maven_toggle_cmd(): void {
  if (isMounted) {
    editor.unmountFloatingWidget(PANEL_ID);
    isMounted = false;
    editor.setStatus("Maven Projects panel closed");
  } else {
    refreshMavenPanel();
    editor.setStatus("Maven Projects panel opened");
  }
}
registerHandler("maven_toggle_projects_panel", on_maven_toggle_cmd);

editor.registerCommand(
  "Maven: Toggle Projects Panel",
  "Show or hide Maven Projects section in sidebar",
  "maven_toggle_projects_panel",
  null
);

// Initial check on load
refreshMavenPanel();

editor.debug("maven_projects: Plugin loaded");
