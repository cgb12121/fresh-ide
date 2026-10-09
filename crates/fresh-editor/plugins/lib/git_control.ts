/// <reference path="./fresh.d.ts" />

/**
 * Git Control Service
 *
 * Provides high-level git staging, commit, graph queries and working tree mutations.
 */

import { resolveGitRepo, git, type GitRepo } from "./git_repo.ts";

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

  // Get current branch
  let branch = "HEAD";
  let upstream = "";
  let ahead = 0;
  let behind = 0;
  try {
    const branchRes = await git(editor, repo, ["status", "--porcelain=2", "--branch"]);
    if (branchRes.exit_code === 0) {
      for (const line of branchRes.stdout.split("\n")) {
        if (line.startsWith("# branch.head ")) branch = line.slice(14).trim() || "HEAD";
        else if (line.startsWith("# branch.upstream ")) upstream = line.slice(18).trim();
        else if (line.startsWith("# branch.ab ")) {
          const m = line.match(/\+(\d+)\s+-(\d+)/);
          if (m) { ahead = Number(m[1]); behind = Number(m[2]); }
        }
      }
    }
  } catch {
    // Keep fallback
  }

  // Get status output
  const staged: GitFileChange[] = [];
  const unstaged: GitFileChange[] = [];

  try {
    const statusRes = await git(editor, repo, ["status", "--porcelain=v1", "-u"]);
    if (statusRes.exit_code === 0) {
      const lines = statusRes.stdout.split("\n");
      for (const line of lines) {
        if (line.length < 3) continue;
        const x = line[0];
        const y = line[1];
        let filePath = line.slice(3).trim();

        if (filePath.includes(" -> ")) {
          filePath = filePath.split(" -> ").pop() ?? filePath;
        }

        // Staged changes (X column is not space and not untracked)
        if (x !== " " && x !== "?") {
          staged.push({
            path: filePath,
            staged: true,
            status: parseCode(x),
            rawCode: x,
          });
        }

        // Unstaged changes (Y column is not space)
        if (y !== " ") {
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
  const result = await git(editor, repo, ["show", "--format=fuller", "--stat", "--patch", hash]);
  return result.exit_code === 0 ? result.stdout : result.stderr;
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
