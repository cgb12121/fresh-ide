import { editor, GUTTER_NAMESPACE, COLORS, GIT_GUTTER_CONFIG } from "./common.ts";

// ---------------------------------------------------------------------------
// Enhanced Git Gutter (Thick Indicators, CRLF Normalization, No False Orange)
// ---------------------------------------------------------------------------

interface DiffHunk {
  type: "added" | "modified" | "deleted";
  startLine: number; // 0-indexed in editor
  lineCount: number;
}

function parseGitDiffOutput(output: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  const lines = output.split("\n");
  for (const line of lines) {
    if (!line.startsWith("@@")) continue;
    const match = /@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/.exec(line);
    if (!match) continue;

    const oldStart = parseInt(match[1], 10);
    const oldCount = match[2] !== undefined ? parseInt(match[2], 10) : 1;
    const newStart = parseInt(match[3], 10);
    const newCount = match[4] !== undefined ? parseInt(match[4], 10) : 1;

    const paired = Math.min(oldCount, newCount);
    if (paired > 0) {
      hunks.push({
        type: "modified",
        startLine: Math.max(0, newStart - 1),
        lineCount: paired,
      });
    }
    if (newCount > oldCount) {
      hunks.push({
        type: "added",
        startLine: Math.max(0, newStart - 1 + paired),
        lineCount: newCount - oldCount,
      });
    } else if (oldCount > newCount) {
      hunks.push({
        type: "deleted",
        startLine: Math.max(0, newStart - 1),
        lineCount: oldCount - newCount,
      });
    }
  }
  return hunks;
}

export async function updateCustomGitGutter(bufferId: number) {
  if (!GIT_GUTTER_CONFIG.enabled) return;
  try {
    const info = editor.getBufferInfo(bufferId);
    if (!info || !info.path || info.path.startsWith("fresh://")) return;

    const cwd = editor.getCwd();
    // Run git diff with --ignore-cr-at-eol to eliminate false modified lines from CRLF vs LF
    const diffRes = await editor.spawnProcess(
      "git",
      ["diff", "-U0", "--ignore-cr-at-eol", "HEAD", "--", info.path],
      cwd
    );

    editor.clearLineIndicators(bufferId, "git-gutter");
    editor.clearLineIndicators(bufferId, GUTTER_NAMESPACE);

    if (diffRes.exit_code !== 0 || !diffRes.stdout) return;

    const hunks = parseGitDiffOutput(diffRes.stdout);
    for (const hunk of hunks) {
      if (hunk.type === "deleted") {
        editor.setLineIndicator(
          bufferId,
          hunk.startLine,
          GUTTER_NAMESPACE,
          GIT_GUTTER_CONFIG.symbolDeleted,
          COLORS.gutterDeleted[0],
          COLORS.gutterDeleted[1],
          COLORS.gutterDeleted[2],
          GIT_GUTTER_CONFIG.priority
        );
      } else if (hunk.type === "added") {
        const lines: number[] = [];
        for (let i = 0; i < hunk.lineCount; i++) {
          lines.push(hunk.startLine + i);
        }
        if (lines.length > 0) {
          editor.setLineIndicators(
            bufferId,
            lines,
            GUTTER_NAMESPACE,
            GIT_GUTTER_CONFIG.symbolAdded,
            COLORS.gutterAdded[0],
            COLORS.gutterAdded[1],
            COLORS.gutterAdded[2],
            GIT_GUTTER_CONFIG.priority
          );
        }
      } else if (hunk.type === "modified" && GIT_GUTTER_CONFIG.showModified) {
        const lines: number[] = [];
        for (let i = 0; i < hunk.lineCount; i++) {
          lines.push(hunk.startLine + i);
        }
        if (lines.length > 0) {
          editor.setLineIndicators(
            bufferId,
            lines,
            GUTTER_NAMESPACE,
            GIT_GUTTER_CONFIG.symbolModified,
            COLORS.gutterModified[0],
            COLORS.gutterModified[1],
            COLORS.gutterModified[2],
            GIT_GUTTER_CONFIG.priority
          );
        }
      }
    }
  } catch (_e) {
    // Ignore error
  }
}
