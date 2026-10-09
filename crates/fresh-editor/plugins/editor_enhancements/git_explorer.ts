import {
  editor,
  GIT_NAMESPACE,
  COLORS,
  PRIORITY,
  statusToDecoration,
  normalizePath,
  compareByPath,
  getPathVariants,
  payloadSignature,
} from "./common.ts";
import type { Decoration, RGB } from "./common.ts";

// ---------------------------------------------------------------------------
// Git Explorer Refresh Logic
// ---------------------------------------------------------------------------

editor.defineConfigBoolean("deepIgnoredEntries", {
  default: false,
  description:
    "Also gray every entry INSIDE gitignored directories (needs a full repo walk: ~1300 readDir calls per refresh)",
});

/** `true` restores walking the whole repo to style the *contents* of ignored
 *  directories. Off by default: `git status --ignored` already reports an
 *  ignored directory collapsed to one entry, so that walk existed only to add
 *  ~2200 muted slots (a 457KB payload) for entries whose status never
 *  changes. */
function deepIgnoredEntries(): boolean {
  const cfg = (editor.getPluginConfig() ?? {}) as { deepIgnoredEntries?: boolean };
  return cfg.deepIgnoredEntries === true;
}

// Perf: the refresh is throttled to at most GIT_EXPLORER_MIN_INTERVAL_MS and the
// payload is deduped, so a repo whose git status has not changed costs one
// git spawn and zero editor-thread work.

/** Highest frequency the repo walk is allowed to run at. */
export const GIT_EXPLORER_MIN_INTERVAL_MS = 1500;

let refreshInFlight = false;
let refreshPending = false;
let explorerTimer: number | null = null;
let lastExplorerRun = 0;

/** Signature of the last explorer payload shipped to the editor.
 *
 * `setFileExplorerSlots` / `setFileExplorerDecorations` replace a whole
 * namespace and rebuild its cache ON THE EDITOR THREAD (~200ms for a repo
 * this size). The refresh runs on several hooks — focus, save, explorer FS
 * changes — and when none of them changed the result, re-sending the
 * identical list is pure cost. This is the plugin-side analog of VS Code's
 * `FileDecorationProvider` firing `onDidChangeFileDecorations` only when a
 * decoration actually changed. */
let lastExplorerPayloadSig: string | null = null;

/** Run the repo walk now if it is due, otherwise schedule it for the earliest
 *  allowed time. Never more often than `GIT_EXPLORER_MIN_INTERVAL_MS`. */
export function requestCustomGitExplorer(force = false) {
  const since = Date.now() - lastExplorerRun;
  if (force && since >= GIT_EXPLORER_MIN_INTERVAL_MS) {
    void refreshCustomGitExplorer();
    return;
  }
  if (explorerTimer !== null) return;
  const delay = Math.max(0, GIT_EXPLORER_MIN_INTERVAL_MS - since);
  explorerTimer = editor.setTimeout(delay, "freshExplorerFlush");
}

function freshExplorerFlush() {
  explorerTimer = null;
  void refreshCustomGitExplorer();
}
registerHandler("freshExplorerFlush", freshExplorerFlush);

export async function refreshCustomGitExplorer() {
  if (refreshInFlight) {
    refreshPending = true;
    return;
  }
  refreshInFlight = true;
  lastExplorerRun = Date.now();
  try {
    const cwd = editor.getCwd();
    const rootRes = await editor.spawnProcess("git", ["rev-parse", "--show-toplevel"], cwd);
    if (rootRes.exit_code !== 0 || !rootRes.stdout.trim()) {
      editor.clearFileExplorerDecorations(GIT_NAMESPACE);
      editor.clearFileExplorerSlots(GIT_NAMESPACE);
      // Forget the cache so a later re-entry always re-applies.
      lastExplorerPayloadSig = null;
      return;
    }

    const repoRoot = normalizePath(rootRes.stdout.trim());
    const repoRootLower = repoRoot.toLowerCase();

    // Query git status with porcelain v1, null terminator, and ignored entries.
    // `--ignored=matching` instead of the default `--ignored=traditional`:
    // both report an ignored directory collapsed to one `!! dir/` entry, but
    // `matching` does not enumerate the files underneath it — measured on this
    // repo, 78ms vs 632ms (git 2.45).
    const statusRes = await editor.spawnProcess(
      "git",
      ["status", "--porcelain=v1", "-z", "--ignored=matching"],
      repoRoot
    );
    if (statusRes.exit_code !== 0) {
      return;
    }

    const output = statusRes.stdout;
    const entries = output.split("\0").filter((e) => e.length > 0);
    const decorations: { path: string; symbol: string; color: RGB; priority: number }[] = [];
    const changedFileSlots: Record<string, unknown>[] = [];
    const dirStatusMap = new Map<string, { path: string; color: RGB; priority: number }>();
    const gitIgnoredDirPrefixes: string[] = [];
    const gitIgnoredExactPaths = new Set<string>();
    const ignoredDirs: string[] = [];
    const ignoredFiles: string[] = [];

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry.length < 3) continue;

      // Handle ignored entries: "!! path/to/ignored/"
      if (entry.startsWith("!! ")) {
        const rawRel = entry.slice(3).trim();
        const isDir = rawRel.endsWith("/");
        const relPath = normalizePath(rawRel);
        const absPath = normalizePath(editor.pathJoin(repoRoot, relPath));
        const absLower = absPath.toLowerCase();

        gitIgnoredExactPaths.add(absLower);
        if (isDir) {
          gitIgnoredDirPrefixes.push(absLower);
          ignoredDirs.push(absPath);
        } else {
          ignoredFiles.push(absPath);
        }
        continue;
      }

      const x = entry[0];
      const y = entry[1];
      let relPath = entry.slice(3).trim();

      // Renamed or copied paths have two null-separated records
      if ((x === "R" || x === "C") && i + 1 < entries.length) {
        i += 1;
        relPath = entries[i].trim();
      }

      let dec: Decoration | null = null;
      if (x === "?" && y === "?") {
        dec = { symbol: "U", color: COLORS.untracked, priority: PRIORITY.untracked };
      } else if (x !== " " && x !== "?") {
        dec = statusToDecoration(x, true);
      } else if (y !== " ") {
        dec = statusToDecoration(y, false);
      }

      if (!dec) continue;

      relPath = normalizePath(relPath);
      const absPath = normalizePath(editor.pathJoin(repoRoot, relPath));
      decorations.push({ path: absPath, ...dec });

      changedFileSlots.push({
        path: absPath,
        nameColor: dec.color,
        priority: dec.priority,
      });

      // Propagate changes up to parent directories (at all depths)
      let parent = normalizePath(editor.pathDirname(absPath));
      while (parent && parent !== absPath && parent.length >= repoRoot.length) {
        const parentLower = parent.toLowerCase();
        const existing = dirStatusMap.get(parentLower);
        if (!existing || dec.priority > existing.priority) {
          dirStatusMap.set(parentLower, { path: parent, color: dec.color, priority: dec.priority });
        }
        if (parentLower === repoRootLower) break;
        const next = normalizePath(editor.pathDirname(parent));
        if (next === parent) break;
        parent = next;
      }
    }

    function isPathDirectlyIgnored(pLower: string): boolean {
      if (gitIgnoredExactPaths.has(pLower)) return true;
      for (const prefix of gitIgnoredDirPrefixes) {
        if (pLower === prefix || pLower.startsWith(prefix + "/")) {
          return true;
        }
      }
      return false;
    }

    const MASSIVE_TREE_DIRS = new Set([
      "node_modules", ".git", "dist", ".next", ".gradle", "target", "bin"
    ]);

    function walk(
      current: string,
      currentDepth: number,
      isParentIgnored: boolean
    ) {
      if (currentDepth > 20) return;

      try {
        const entries = editor.readDir(current);
        for (const e of entries) {
          if (e.name === ".git") continue;

          const subPath = normalizePath(editor.pathJoin(current, e.name));
          const subLower = subPath.toLowerCase();

          if (e.is_dir) {
            if (MASSIVE_TREE_DIRS.has(e.name)) {
              // Massive directories (target, node_modules) are hidden by custom_ignore_patterns — skip traversing inside
              ignoredDirs.push(subPath);
              continue;
            }

            const isIgnored = isParentIgnored || isPathDirectlyIgnored(subLower);

            if (isIgnored) {
              ignoredDirs.push(subPath);
              walk(subPath, currentDepth + 1, true);
            } else {
              walk(subPath, currentDepth + 1, false);
            }
          } else {
            if (isParentIgnored || isPathDirectlyIgnored(subLower)) {
              ignoredFiles.push(subPath);
            }
          }
        }
      } catch (_err) {
        // Ignore read errors
      }
    }

    if (deepIgnoredEntries()) {
      walk(repoRoot, 0, false);
    }

    const allSlots: Record<string, unknown>[] = [];
    const seenSlots = new Set<string>();

    function addSlot(
      rawPath: string,
      nameColor: unknown,
      priority: number,
      suppressTrailing = true
    ) {
      for (const p of getPathVariants(rawPath)) {
        const key = p.toLowerCase();
        if (seenSlots.has(key)) continue;
        seenSlots.add(key);
        allSlots.push({
          path: p,
          nameColor,
          suppressTrailing,
          priority,
        });
      }
    }

    // 1. Folders with Git changes: Sea Blue / Green (all ancestors at all depths)
    // Priority 150 ensures modified folders ALWAYS win over clean folders
    for (const item of dirStatusMap.values()) {
      addSlot(item.path, item.color, 150, true);
    }

    // 2. Files with Git changes (badges + colored names): Priority 120
    for (const slot of changedFileSlots) {
      addSlot(slot.path as string, slot.nameColor, 120, false);
    }

    // 3. Gitignored folders: Muted gray ([84, 110, 122]) - Priority 80
    for (const p of ignoredDirs) {
      addSlot(p, COLORS.ignored, 80, true);
    }

    // 4. Gitignored files: Muted gray ([84, 110, 122]) - Priority 80
    for (const p of ignoredFiles) {
      addSlot(p, COLORS.ignored, 80, false);
    }

    // Multi-variant file decorations for badges (M, U, A, !, D, etc.)
    const allDecorations: Record<string, unknown>[] = [];
    for (const dec of decorations) {
      for (const p of getPathVariants(dec.path)) {
        allDecorations.push({
          path: p,
          symbol: dec.symbol,
          color: dec.color,
          priority: dec.priority,
        });
      }
    }

    // Apply only when the payload actually changed. Sorting first makes the
    // signature independent of `readDir` / git enumeration order (otherwise a
    // stable repo could still hash differently and defeat the guard).
    allSlots.sort(compareByPath);
    allDecorations.sort(compareByPath);
    const payloadSig = payloadSignature(allSlots, allDecorations);
    if (payloadSig === lastExplorerPayloadSig) {
      return;
    }
    lastExplorerPayloadSig = payloadSig;

    editor.setFileExplorerDecorations(GIT_NAMESPACE, allDecorations);
    editor.setFileExplorerSlots(GIT_NAMESPACE, allSlots);
  } catch (_e) {
    // Ignore error
  } finally {
    refreshInFlight = false;
    if (refreshPending) {
      refreshPending = false;
      void refreshCustomGitExplorer();
    }
  }
}
