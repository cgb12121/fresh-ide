import { editor, COLORS, YAML_NAMESPACE, computeCharToByteOffsets } from "./common.ts";
import type { RGB } from "./common.ts";

// ---------------------------------------------------------------------------
// YAML Syntax Enhancer
// ---------------------------------------------------------------------------

function scanYamlBuffer(text: string): Array<{ start: number; end: number; color: RGB }> {
  const byteOffsets = computeCharToByteOffsets(text);
  const items: Array<{ start: number; end: number; color: RGB }> = [];
  const lines = text.split("\n");
  let textIdx = 0;

  for (const line of lines) {
    const lineLen = line.length;
    const lineStart = textIdx;
    textIdx += lineLen + 1; // +1 for '\n'

    let i = 0;
    while (i < lineLen && /\s/.test(line[i])) i++;
    if (i >= lineLen) continue;

    // Comment line: # ...
    if (line[i] === "#") {
      items.push({
        start: byteOffsets[lineStart + i],
        end: byteOffsets[lineStart + lineLen],
        color: COLORS.comment,
      });
      continue;
    }

    // List marker: - 
    if (line[i] === "-" && (i + 1 === lineLen || line[i + 1] === " ")) {
      i++;
      while (i < lineLen && /\s/.test(line[i])) i++;
      if (i >= lineLen) continue;
    }

    // Key scan: key: or "key":
    const keyStart = i;
    let colonIdx = -1;

    if (line[i] === '"' || line[i] === "'") {
      const q = line[i];
      i++;
      while (i < lineLen && line[i] !== q) i++;
      if (i < lineLen) i++; // past quote
      while (i < lineLen && /\s/.test(line[i])) i++;
      if (i < lineLen && line[i] === ":") {
        colonIdx = i;
      }
    } else {
      const cIdx = line.indexOf(":", i);
      if (cIdx !== -1 && (cIdx + 1 === lineLen || /\s/.test(line[cIdx + 1]))) {
        colonIdx = cIdx;
      }
    }

    if (colonIdx > keyStart) {
      items.push({
        start: byteOffsets[lineStart + keyStart],
        end: byteOffsets[lineStart + colonIdx],
        color: COLORS.yamlKey,
      });

      // Value scan after colon
      let v = colonIdx + 1;
      while (v < lineLen && /\s/.test(line[v])) v++;
      if (v < lineLen) {
        const commentIdx = line.indexOf(" #", v);
        const valEnd = commentIdx !== -1 ? commentIdx : lineLen;
        if (commentIdx !== -1) {
          items.push({
            start: byteOffsets[lineStart + commentIdx + 1],
            end: byteOffsets[lineStart + lineLen],
            color: COLORS.comment,
          });
        }

        const valStr = line.slice(v, valEnd).trim();
        if (valStr.startsWith('"') || valStr.startsWith("'")) {
          items.push({
            start: byteOffsets[lineStart + v],
            end: byteOffsets[lineStart + valEnd],
            color: COLORS.string,
          });
        } else if (/^(true|false|yes|no|null|~)$/i.test(valStr) || /^-?[0-9]+(\.[0-9]+)?$/.test(valStr)) {
          items.push({
            start: byteOffsets[lineStart + v],
            end: byteOffsets[lineStart + valEnd],
            color: COLORS.yamlConst,
          });
        }
      }
    }
  }

  return items;
}

export async function refreshYamlBuffer(bufferId: number) {
  try {
    const text = await editor.getBufferText(bufferId);
    if (typeof text !== "string") return;

    editor.clearNamespace(bufferId, YAML_NAMESPACE);
    const items = scanYamlBuffer(text);
    for (const item of items) {
      editor.addOverlay(bufferId, YAML_NAMESPACE, item.start, item.end, {
        fg: item.color,
      });
    }
  } catch (_e) {
    // Ignore error
  }
}
