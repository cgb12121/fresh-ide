/// <reference path="./fresh.d.ts" />

/**
 * Git Control Service
 *
 * Provides high-level git staging, commit, graph queries and working tree mutations.
 */

import { resolveGitRepo, git, diffArgs, type GitRepo } from "./git_repo.ts";
import { fetchCommitShow } from "./git_history.ts";

export type GitChangeType = "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted";

export interface GitFileChange {
  path: string;
  staged: boolean;
  status: GitChangeType;
  rawCode: string;
}

export interface GitStatusSummary {
  branch: string;
  upstream: string;
  ahead: number;
  behind: number;
  staged: GitFileChange[];
  unstaged: GitFileChange[];
  repoRoot: string;
}

export interface GitGraphLine {
  graph: string;
  hash: string;
  refs: string;
  subject: string;
}

function parseCode(code: string): GitChangeType {
  switch (code) {
    case "A":
      return "added";
    case "M":
      return "modified";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "U":
      return "conflicted";
    case "?":
      return "untracked";
    default:
      return "modified";
  }
}

/**
 * Fetch current repository status (staged and unstaged changes).
 */
export async function getGitStatus(editor: EditorAPI): Promise<GitStatusSummary | null> {
  const repo = await resolveGitRepo(editor);
  if (!repo) {
    return null;
  }

  // Porcelain v2 includes branch/upstream and file state in one git process.
  let branch = "HEAD";
  let upstream = "";
  let ahead = 0;
  let behind = 0;
  const staged: GitFileChange[] = [];
  const unstaged: GitFileChange[] = [];

  try {
    const statusRes = await git(editor, repo, ["status", "--porcelain=v2", "--branch", "-u"]);
    if (statusRes.exit_code === 0) {
      const lines = statusRes.stdout.split("\n");
      for (const line of lines) {
        if (line.startsWith("# branch.head ")) {
          branch = line.slice(14).trim() || "HEAD";
          continue;
        }
        if (line.startsWith("# branch.upstream ")) {
          upstream = line.slice(18).trim();
          continue;
        }
        if (line.startsWith("# branch.ab ")) {
          const match = line.match(/\+(\d+)\s+-(\d+)/);
          if (match) {
            ahead = Number(match[1]);
            behind = Number(match[2]);
          }
          continue;
        }
        const fields = line.split(" ");
        const record = fields[0];
        if (record === "?" && line.startsWith("? ")) {
          unstaged.push({ path: line.slice(2), staged: false, status: "untracked", rawCode: "?" });
          continue;
        }
        if (record !== "1" && record !== "2" && record !== "u") continue;
        const xy = fields[1] ?? "..";
        const pathStart = record === "1" ? 8 : record === "2" ? 9 : 10;
        let filePath = fields.slice(pathStart).join(" ");
        // For a type-2 rename, the current path precedes the tab and the
        // original path follows it.
        if (record === "2") filePath = filePath.split("\t", 1)[0];
        if (!filePath) continue;
        const x = xy[0] ?? ".";
        const y = xy[1] ?? ".";

        if (record === "u") {
          staged.push({ path: filePath, staged: true, status: "conflicted", rawCode: "U" });
          unstaged.push({ path: filePath, staged: false, status: "conflicted", rawCode: "U" });
          continue;
        }
        // Staged changes are in X; worktree changes are in Y.
        if (x !== ".") {
          staged.push({
            path: filePath,
            staged: true,
            status: parseCode(x),
            rawCode: x,
          });
        }

        if (y !== ".") {
          unstaged.push({
            path: filePath,
            staged: false,
            status: parseCode(y),
            rawCode: y,
          });
        }
      }
    }
  } catch {
    // Return partial results
  }

  return {
    branch,
    upstream,
    ahead,
    behind,
    staged,
    unstaged,
    repoRoot: repo.root,
  };
}

/** Return commit details for a selected graph row. */
export async function gitShowCommit(editor: EditorAPI, hash: string): Promise<string> {
  if (!/^[0-9a-f]{7,40}$/i.test(hash)) return "";
  const repo = await resolveGitRepo(editor);
  if (!repo) return "";
  return await fetchCommitShow(editor, hash, repo.root);
}

/** Memoized per-file diff metadata and blob snapshots, keyed by repo + staged
 *  flag + path. Every miss costs 1-3 `git.exe` spawns (~40ms each on Windows
 *  regardless of how little they print), and the panel re-opens the same files
 *  constantly — so a revisit is a map hit. Cleared whenever the panel
 *  refreshes git status, which is the only moment a cached blob can be stale. */
const diffInfoCache = new Map<string, GitFileDiffInfo>();
const snapshotCache = new Map<string, { oldText: string; newText: string }>();

export function clearGitFileCaches(): void {
  diffInfoCache.clear();
  snapshotCache.clear();
}

export interface GitDiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

export interface GitFileDiffInfo {
  changedLines: number;
  binary: boolean;
  hunks: GitDiffHunk[];
}

/** Above this many changed lines the viewer reports the count instead of
 *  materialising the patch. */
export const MAX_CHANGED_LINES_FOR_PATCH = 2000;

/**
 * Hunk metadata for one file, from ONE git process.
 *
 * `--numstat --unified=0` is a single call whose output is the numstat table
 * first and the patch after it, so the size is known before the patch is read
 * — the same "know the budget, then spend it" order VS Code's diff computer
 * uses with `maxComputationTime` / `quitEarly`. This used to be two spawns,
 * and on Windows `git.exe` startup dominated: ~40ms per call to move a few KB.
 */
export async function getGitFileDiffInfo(
  editor: EditorAPI,
  repoRoot: string,
  path: string,
  staged: boolean,
): Promise<GitFileDiffInfo> {
  const repo = { root: repoRoot };
  const key = `${repoRoot}\u0000${staged ? 1 : 0}\u0000${path}`;
  const memo = diffInfoCache.get(key);
  if (memo) return memo;

  const stageArgs = staged ? ["--cached"] : [];
  const result = await git(
    editor,
    repo,
    diffArgs(["diff"], ...stageArgs, "--numstat", "--unified=0", "--", path)
  );
  if (result.exit_code !== 0) {
    const empty: GitFileDiffInfo = { changedLines: 0, binary: false, hunks: [] };
    diffInfoCache.set(key, empty);
    return empty;
  }

  const lines = result.stdout.split("\n");
  let changedLines = 0;
  let binary = false;
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (!line) break;
    const firstTab = line.indexOf("\t");
    if (firstTab < 0) break;
    const secondTab = line.indexOf("\t", firstTab + 1);
    if (secondTab < 0) break;
    const added = line.slice(0, firstTab);
    const removed = line.slice(firstTab + 1, secondTab);
    if (added === "-" || removed === "-") {
      binary = true;
    } else {
      changedLines += (Number(added) || 0) + (Number(removed) || 0);
    }
  }
  // Do not ask for a patch we will skip below.
  if (binary || changedLines > MAX_CHANGED_LINES_FOR_PATCH) {
    const bounded: GitFileDiffInfo = { changedLines, binary, hunks: [] };
    diffInfoCache.set(key, bounded);
    return bounded;
  }

  const hunks: GitDiffHunk[] = [];
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith("@@")) continue;
    const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!match) continue;
    const oldLine = Number(match[1]);
    const oldCount = match[2] === undefined ? 1 : Number(match[2]);
    const newLine = Number(match[3]);
    const newCount = match[4] === undefined ? 1 : Number(match[4]);
    hunks.push({
      oldStart: oldCount === 0 ? oldLine : oldLine - 1,
      oldCount,
      newStart: newCount === 0 ? newLine : newLine - 1,
      newCount,
    });
  }
  const info: GitFileDiffInfo = { changedLines, binary, hunks };
  diffInfoCache.set(key, info);
  return info;
}

/** Read the two snapshots compared by a staged or unstaged file review. */
export async function getGitFileSnapshots(
  editor: EditorAPI,
  repoRoot: string,
  path: string,
  staged: boolean,
): Promise<{ oldText: string; newText: string } | null> {
  const key = `${repoRoot}\u0000${staged ? 1 : 0}\u0000${path}`;
  const memo = snapshotCache.get(key);
  if (memo) return memo;

  const repo = { root: repoRoot };

  const readObject = async (spec: string): Promise<string> => {
    const result = await git(editor, repo, ["show", spec]);
    return result.exit_code === 0 ? result.stdout : "";
  };

  let snapshots: { oldText: string; newText: string };
  if (staged) {
    snapshots = {
      oldText: await readObject(`HEAD:${path}`),
      newText: await readObject(`:${path}`),
    };
  } else {
    const oldText = await readObject(`:${path}`);
    const absolutePath = editor.pathJoin(repo.root, path);
    snapshots = { oldText, newText: editor.readFile(absolutePath) ?? "" };
  }
  snapshotCache.set(key, snapshots);
  return snapshots;
}

export interface CollapsedDiff {
  oldText: string;
  newText: string;
  /** Hunks rewritten to the collapsed coordinates, so the side-by-side panes
   *  still align. */
  hunks: GitDiffHunk[];
  hiddenOldLines: number;
  hiddenNewLines: number;
}

/**
 * Keep only what a reader needs: every hunk plus `contextLines` of context
 * around it, with one `... N unchanged lines ...` marker per skipped run.
 *
 * This is VS Code's `hideUnchangedRegions` (contextLineCount: 3), and its
 * point is not prettiness. The review panes are ordinary buffers, so without
 * this a 500 KB file becomes two 500 KB buffers — and a large buffer costs
 * ~40ms of layout per frame per pane, paid again on every scroll.
 */
export function collapseUnchangedRanges(
  oldText: string,
  newText: string,
  hunks: GitDiffHunk[],
  contextLines: number,
): CollapsedDiff {
  const oldLines = oldText.length > 0 ? oldText.split("\n") : [];
  const newLines = newText.length > 0 ? newText.split("\n") : [];

  // No hunks: both sides are equal (or the hunk list was bounded away). Show
  // the head of each so the panes are not blank, and say what was left out.
  if (hunks.length === 0) {
    const head = Math.max(contextLines * 4, 16);
    const oldHead = oldLines.slice(0, head);
    const newHead = newLines.slice(0, head);
    return {
      oldText: oldHead.join("\n"),
      newText: newHead.join("\n"),
      hunks: [],
      hiddenOldLines: Math.max(0, oldLines.length - oldHead.length),
      hiddenNewLines: Math.max(0, newLines.length - newHead.length),
    };
  }

  interface Window {
    start: number;
    end: number;
  }
  const merge = (spans: Window[]): Window[] => {
    const sorted = spans.slice().sort((a, b) => a.start - b.start);
    const out: Window[] = [];
    for (const span of sorted) {
      const last = out[out.length - 1];
      if (last && span.start <= last.end) {
        last.end = Math.max(last.end, span.end);
      } else {
        out.push({ start: span.start, end: span.end });
      }
    }
    return out;
  };

  const windowFor = (start: number, count: number, total: number): Window => ({
    start: Math.max(0, start - contextLines),
    end: Math.min(total, start + Math.max(count, 1) + contextLines),
  });

  const oldWindows = merge(hunks.map((h) => windowFor(h.oldStart, h.oldCount, oldLines.length)));
  const newWindows = merge(hunks.map((h) => windowFor(h.newStart, h.newCount, newLines.length)));

  const build = (
    lines: string[],
    windows: Window[],
  ): { text: string; map: Map<number, number>; hidden: number } => {
    const out: string[] = [];
    const map = new Map<number, number>();
    let hidden = 0;
    let cursor = 0;
    for (const w of windows) {
      if (w.end <= w.start) continue;
      if (w.start > cursor) {
        hidden += w.start - cursor;
        out.push(`... ${w.start - cursor} unchanged lines ...`);
      }
      for (let i = w.start; i < w.end; i++) {
        map.set(i, out.length);
        out.push(lines[i] ?? "");
      }
      cursor = Math.max(cursor, w.end);
    }
    if (cursor < lines.length) hidden += lines.length - cursor;
    return { text: out.join("\n"), map, hidden };
  };

  const oldBuilt = build(oldLines, oldWindows);
  const newBuilt = build(newLines, newWindows);

  const remapped = hunks
    .map((h) => ({
      oldStart: oldBuilt.map.get(h.oldStart) ?? 0,
      oldCount: h.oldCount,
      newStart: newBuilt.map.get(h.newStart) ?? 0,
      newCount: h.newCount,
    }))
    .sort((a, b) => a.oldStart - b.oldStart);

  return {
    oldText: oldBuilt.text,
    newText: newBuilt.text,
    hunks: remapped,
    hiddenOldLines: oldBuilt.hidden,
    hiddenNewLines: newBuilt.hidden,
  };
}

/** Explicitly update remote tracking refs; this is never run as a side effect of refresh. */
export async function fetchRemote(editor: EditorAPI): Promise<string | null> {
  const repo = await resolveGitRepo(editor);
  if (!repo) return "Not inside a git repository";
  const result = await git(editor, repo, ["fetch", "--prune"]);
  return result.exit_code === 0 ? null : (result.stderr || result.stdout || "Git fetch failed");
}

/**
 * Fetch visual git commit graph lines.
 */
export async function getGitGraph(editor: EditorAPI, maxCommits = 15): Promise<GitGraphLine[]> {
  const repo = await resolveGitRepo(editor);
  if (!repo) {
    return [];
  }

  const results: GitGraphLine[] = [];
  try {
    const logRes = await git(editor, repo, [
      "log",
      "--graph",
      `--max-count=${maxCommits}`,
      "--oneline",
      "--decorate",
      "--color=never",
    ]);

    if (logRes.exit_code === 0 && logRes.stdout) {
      const lines = logRes.stdout.split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;

        // Parse graph symbol prefix and the commit message
        // Example: * 10f79326 (HEAD -> master) chore: tooling update
        // Or:      | * 24a18f3e feat: separate outcome
        const match = line.match(/^([*|/\\_ -]+)\s*([0-9a-f]{7,12})?(?:\s*\(([^)]+)\))?\s*(.*)$/i);
        if (match) {
          results.push({
            graph: match[1] || "*",
            hash: match[2] || "",
            refs: match[3] ? `(${match[3]})` : "",
            subject: match[4] || "",
          });
        } else {
          results.push({
            graph: line.slice(0, 3),
            hash: "",
            refs: "",
            subject: line.slice(3),
          });
        }
      }
    }
  } catch {
    // Return empty on failure
  }

  return results;
}

/**
 * Stage a specific file (`git add -- <path>`).
 */
export async function stageFile(editor: EditorAPI, path: string): Promise<boolean> {
  const repo = await resolveGitRepo(editor);
  if (!repo) return false;
  const res = await git(editor, repo, ["add", "--", path]);
  return res.exit_code === 0;
}

/**
 * Stage all modified and untracked files (`git add -A`).
 */
export async function stageAll(editor: EditorAPI): Promise<boolean> {
  const repo = await resolveGitRepo(editor);
  if (!repo) return false;
  const res = await git(editor, repo, ["add", "-A"]);
  return res.exit_code === 0;
}

/**
 * Unstage a specific file (`git restore --staged -- <path>`).
 */
export async function unstageFile(editor: EditorAPI, path: string): Promise<boolean> {
  const repo = await resolveGitRepo(editor);
  if (!repo) return false;
  const res = await git(editor, repo, ["restore", "--staged", "--", path]);
  return res.exit_code === 0;
}

/**
 * Unstage all files (`git restore --staged .`).
 */
export async function unstageAll(editor: EditorAPI): Promise<boolean> {
  const repo = await resolveGitRepo(editor);
  if (!repo) return false;
  const res = await git(editor, repo, ["restore", "--staged", "."]);
  return res.exit_code === 0;
}

/**
 * Discard changes in a file (`git restore -- <path>` or clean untracked).
 */
export async function discardFile(editor: EditorAPI, path: string, untracked: boolean): Promise<boolean> {
  const repo = await resolveGitRepo(editor);
  if (!repo) return false;
  if (untracked) {
    const res = await git(editor, repo, ["clean", "-f", "--", path]);
    return res.exit_code === 0;
  }
  const res = await git(editor, repo, ["restore", "--", path]);
  return res.exit_code === 0;
}

/**
 * Commit staged changes with message (`git commit -m "<msg>"`).
 */
export async function commitStaged(editor: EditorAPI, message: string): Promise<string | null> {
  const trimmed = message.trim();
  if (!trimmed) {
    return "Commit message cannot be empty";
  }
  const repo = await resolveGitRepo(editor);
  if (!repo) return "Not inside a git repository";

  const res = await git(editor, repo, ["commit", "-m", trimmed]);
  if (res.exit_code === 0) {
    return null; // Success
  }
  return res.stderr || res.stdout || "Git commit failed";
}
