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

/** Get bounded Git hunk metadata before loading file bodies or aligning panes. */
export async function getGitFileDiffInfo(
  editor: EditorAPI,
  repoRoot: string,
  path: string,
  staged: boolean,
): Promise<{ changedLines: number; binary: boolean; hunks: Array<{ oldStart: number; oldCount: number; newStart: number; newCount: number }> }> {
  const repo = { root: repoRoot };
  const stageArgs = staged ? ["--cached"] : [];
  const statResult = await git(editor, repo, diffArgs(["diff"], ...stageArgs, "--numstat", "--", path));
  if (statResult.exit_code !== 0) {
    return { changedLines: 0, binary: false, hunks: [] };
  }

  let changedLines = 0;
  let binary = false;
  const hunks: Array<{ oldStart: number; oldCount: number; newStart: number; newCount: number }> = [];
  for (const line of statResult.stdout.split("\n")) {
    const firstTab = line.indexOf("\t");
    if (firstTab < 0) continue;
    const secondTab = line.indexOf("\t", firstTab + 1);
    if (secondTab < 0) continue;
    const added = line.slice(0, firstTab);
    const removed = line.slice(firstTab + 1, secondTab);
    if (added === "-" || removed === "-") {
      binary = true;
    } else {
      changedLines += (Number(added) || 0) + (Number(removed) || 0);
    }
  }
  // Do not ask Git to materialize the patch for a file we will skip below.
  if (binary || changedLines > 2000) return { changedLines, binary, hunks: [] };

  const patchResult = await git(editor, repo, diffArgs(["diff"], ...stageArgs, "--unified=0", "--", path));
  if (patchResult.exit_code !== 0) return { changedLines, binary, hunks: [] };
  for (const line of patchResult.stdout.split("\n")) {
    if (line.startsWith("@@")) {
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
  }
  return { changedLines, binary, hunks };
}

/** Read the two snapshots compared by a staged or unstaged file review. */
export async function getGitFileSnapshots(
  editor: EditorAPI,
  repoRoot: string,
  path: string,
  staged: boolean,
): Promise<{ oldText: string; newText: string } | null> {
  const repo = { root: repoRoot };

  const readObject = async (spec: string): Promise<string> => {
    const result = await git(editor, repo, ["show", spec]);
    return result.exit_code === 0 ? result.stdout : "";
  };

  if (staged) {
    return {
      oldText: await readObject(`HEAD:${path}`),
      newText: await readObject(`:${path}`),
    };
  }

  const oldText = await readObject(`:${path}`);
  const absolutePath = editor.pathJoin(repo.root, path);
  return { oldText, newText: editor.readFile(absolutePath) ?? "" };
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
