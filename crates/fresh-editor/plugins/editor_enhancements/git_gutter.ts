import { editor, GUTTER_NAMESPACE, COLORS, GIT_GUTTER_CONFIG } from "./common.ts";
import {
  col,
  row,
  label,
  spacer,
  text,
  type WidgetSpec,
} from "../lib/widgets.ts";

// ---------------------------------------------------------------------------
// Enhanced Git Gutter (Thick Indicators, CRLF Safe, Scrollbar Overview, Click-to-Diff)
// ---------------------------------------------------------------------------

export interface DiffHunk {
  type: "added" | "modified" | "deleted";
  startLine: number; // 0-indexed in editor
  lineCount: number;
  oldStart: number;  // 1-indexed in old file
  oldCount: number;
  newStart: number;  // 1-indexed in new file
  newCount: number;
}

interface BufferGitGutterState {
  filePath: string;
  hunks: DiffHunk[];
}

const SCROLL_NAMESPACE = "git-gutter-scroll";
const DIFF_PANEL_ID = 9988;

const bufferGutterStates: Map<number, BufferGitGutterState> = new Map();
let currentPeekBufferId: number | null = null;
let currentPeekHunk: DiffHunk | null = null;
let currentPeekDiffText: string | null = null;
let isPeekMounted = false;

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
        oldStart,
        oldCount,
        newStart,
        newCount,
      });
    }
    if (newCount > oldCount) {
      hunks.push({
        type: "added",
        startLine: Math.max(0, newStart - 1 + paired),
        lineCount: newCount - oldCount,
        oldStart,
        oldCount,
        newStart,
        newCount,
      });
    } else if (oldCount > newCount) {
      hunks.push({
        type: "deleted",
        startLine: Math.max(0, newStart - 1),
        lineCount: oldCount - newCount,
        oldStart,
        oldCount,
        newStart,
        newCount,
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

    if (diffRes.exit_code !== 0 || !diffRes.stdout) {
      editor.clearScrollbarMarkers(bufferId, SCROLL_NAMESPACE);
      bufferGutterStates.delete(bufferId);
      return;
    }

    const hunks = parseGitDiffOutput(diffRes.stdout);
    bufferGutterStates.set(bufferId, {
      filePath: info.path,
      hunks,
    });

    const scrollMarkers: ScrollbarMarker[] = [];

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
        scrollMarkers.push({
          line: hunk.startLine,
          color: COLORS.gutterDeleted,
          priority: GIT_GUTTER_CONFIG.priority,
        });
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
          scrollMarkers.push({
            line: hunk.startLine,
            endLine: Math.max(hunk.startLine, hunk.startLine + hunk.lineCount - 1),
            color: COLORS.gutterAdded,
            priority: GIT_GUTTER_CONFIG.priority,
          });
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
          scrollMarkers.push({
            line: hunk.startLine,
            endLine: Math.max(hunk.startLine, hunk.startLine + hunk.lineCount - 1),
            color: COLORS.gutterModified,
            priority: GIT_GUTTER_CONFIG.priority,
          });
        }
      }
    }

    // Publish scrollbar markers so git changes appear along the vertical scrollbar track
    editor.setScrollbarMarkers(bufferId, SCROLL_NAMESPACE, scrollMarkers);
  } catch (_e) {
    // Ignore error
  }
}

// ---------------------------------------------------------------------------
// Click-to-Diff (Peek Modal)
// ---------------------------------------------------------------------------

export async function handleGutterClick(args: MouseClickHookArgs): Promise<boolean> {
  if (args.button !== "left" || args.buffer_id == null || args.buffer_row == null) {
    return false;
  }
  const relCol = args.column - args.content_x;
  // Gutter occupies leftmost columns of the split (indicator col + line numbers + separator)
  if (relCol < 0 || relCol > 8) {
    return false;
  }

  const state = bufferGutterStates.get(args.buffer_id);
  if (!state || state.hunks.length === 0) {
    return false;
  }

  const clickedRow = args.buffer_row; // 0-indexed line number in buffer
  const matchingHunk = state.hunks.find((h) => {
    if (h.type === "deleted") {
      return clickedRow === h.startLine;
    }
    return clickedRow >= h.startLine && clickedRow < h.startLine + Math.max(1, h.lineCount);
  });

  if (!matchingHunk) {
    return false;
  }

  await openDiffPeek(args.buffer_id, matchingHunk, state.filePath);
  return true;
}

export async function openDiffPeek(
  bufferId: number,
  hunk: DiffHunk,
  filePath: string
): Promise<void> {
  const cwd = editor.getCwd();
  // Spawn git diff with -U3 context
  const diffRes = await editor.spawnProcess(
    "git",
    ["diff", "-U3", "--ignore-cr-at-eol", "HEAD", "--", filePath],
    cwd
  );

  let hunkHeader = `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`;
  let hunkLines: string[] = [];

  if (diffRes.exit_code === 0 && diffRes.stdout) {
    const rawHunks = diffRes.stdout.split(/^@@ /m);
    const targetLine = hunk.startLine + 1;

    for (let i = 1; i < rawHunks.length; i++) {
      const rawHunk = "@@ " + rawHunks[i];
      const firstLine = rawHunk.split("\n")[0];
      const match = /@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/.exec(firstLine);
      if (!match) continue;
      const hStart = parseInt(match[3], 10);
      const hCount = match[4] !== undefined ? parseInt(match[4], 10) : 1;
      if (
        targetLine >= Math.max(1, hStart - 1) &&
        targetLine <= hStart + Math.max(1, hCount)
      ) {
        const lines = rawHunk.trimEnd().split("\n");
        hunkHeader = lines[0];
        hunkLines = lines.slice(1);
        break;
      }
    }
  }

  // Fallback if full contextual diff hunk was not resolved
  if (hunkLines.length === 0) {
    hunkLines = [
      `[Hunk: lines ${hunk.newStart}..${hunk.newStart + Math.max(0, hunk.newCount - 1)}]`,
      hunk.type === "added"
        ? `+ ${hunk.lineCount} line(s) added`
        : hunk.type === "deleted"
        ? `- ${hunk.lineCount} line(s) deleted`
        : `~ ${hunk.lineCount} line(s) modified`,
    ];
  }

  currentPeekBufferId = bufferId;
  currentPeekHunk = hunk;
  currentPeekDiffText = hunkLines.join("\n");

  const fileName = filePath.replace(/\\/g, "/").split("/").pop() || filePath;
  const typeColor =
    hunk.type === "added"
      ? "syntax.string"
      : hunk.type === "deleted"
      ? "diagnostic.error_fg"
      : "diagnostic.warning_fg";
  const typeBadge = hunk.type.toUpperCase();

  const linesWidgets: WidgetSpec[] = [];

  // 1. File name row in pure white (editor.fg) with diff type badge and line range
  linesWidgets.push(
    row(
      label(` ${fileName} `, { style: { bold: true, fg: "editor.fg" } }),
      label(` ${typeBadge} `, { style: { bold: true, fg: typeColor } }),
      spacer(1),
      label(
        `Line ${hunk.newStart}${
          hunk.newCount > 1 ? ".." + (hunk.newStart + hunk.newCount - 1) : ""
        } `,
        { style: { fg: "editor.line_number_fg" } }
      )
    )
  );

  // 2. Hunk header row (@@ ... @@) dynamically colored according to hunk diff status
  linesWidgets.push(
    label(" " + hunkHeader, { style: { bold: true, fg: typeColor } })
  );
  linesWidgets.push(
    label("─".repeat(56), { style: { fg: "editor.line_number_fg" } })
  );

  // 3. Selectable, copyable diff code block with full syntax highlighting & instant response
  const maxLines = 40;
  const displayLines = hunkLines.slice(0, maxLines);
  if (hunkLines.length > maxLines) {
    displayLines.push(`... (${hunkLines.length - maxLines} more lines)`);
  }
  // Keep the diff fence for Git's added/deleted colors, while bounding each
  // line and letting the floating panel choose the text widget's width.
  const diffBody = displayLines
    .map((line) => line.replace(/\t/g, "    ").slice(0, 100))
    .join("\n");
  const diffText = `\`\`\`diff\n${diffBody}\n\`\`\``;
  const contentRows = Math.min(22, Math.max(3, displayLines.length));

  linesWidgets.push(
    text({
      value: diffText,
      markdown: true,
      rows: contentRows,
      readOnly: true,
      focused: true,
      fullWidth: false,
      key: "git_diff_text",
    })
  );

  const spec = col(...linesWidgets);
  const heightRows = contentRows + 4;
  const heightPct = Math.min(85, Math.max(18, Math.round(heightRows * 3.2)));

  editor.mountFloatingWidget(
    DIFF_PANEL_ID,
    spec,
    72,
    heightPct,
    false,
    false,
    "",
    true,
    false,
    "git-diff-peek"
  );
  isPeekMounted = true;
}

export function closeDiffPeek(): void {
  if (isPeekMounted) {
    try {
      editor.unmountFloatingWidget(DIFF_PANEL_ID);
    } catch {
      // Ignored
    }
    isPeekMounted = false;
    currentPeekBufferId = null;
    currentPeekHunk = null;
    currentPeekDiffText = null;
  }
}

export function handleGutterWidgetEvent(event: {
  panel_id: number;
  widget_key: string;
  event_type: string;
}): void {
  if (event.panel_id !== DIFF_PANEL_ID) return;
  if (
    event.widget_key === "git_diff_btn_close" ||
    event.event_type === "cancel" ||
    event.event_type === "dismiss"
  ) {
    closeDiffPeek();
  }
}

// Action to peek diff at current cursor line via keyboard command
(globalThis as unknown as Record<string, unknown>).git_peek_diff_at_cursor = async () => {
  const activeBid = editor.getActiveBufferId();
  if (activeBid == null) return;
  const state = bufferGutterStates.get(activeBid);
  if (!state || state.hunks.length === 0) {
    editor.setStatus("No git changes in current file");
    return;
  }
  const cursorLine = editor.getCursorLine ? editor.getCursorLine() : 0;
  const hunk =
    state.hunks.find((h) => {
      if (h.type === "deleted") return cursorLine === h.startLine;
      return cursorLine >= h.startLine && cursorLine < h.startLine + Math.max(1, h.lineCount);
    }) || state.hunks[0];
  if (hunk) {
    await openDiffPeek(activeBid, hunk, state.filePath);
  }
};

editor.registerCommand(
  "git:peek_diff_at_cursor",
  "Git: Peek Diff at Cursor",
  "git_peek_diff_at_cursor",
  null
);

// Action to copy current peek diff to clipboard
(globalThis as unknown as Record<string, unknown>).git_copy_peek_diff = () => {
  if (currentPeekDiffText) {
    editor.copyToClipboard(currentPeekDiffText);
    editor.setStatus("Copied diff hunk to clipboard");
  } else {
    editor.setStatus("No active diff peek to copy");
  }
};

editor.registerCommand(
  "git:copy_peek_diff",
  "Git: Copy Current Peek Diff",
  "git_copy_peek_diff",
  null
);
