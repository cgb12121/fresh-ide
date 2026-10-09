import { editor, COLORS, PROP_NAMESPACE, computeCharToByteOffsets } from "./common.ts";
import type { RGB } from "./common.ts";

// ---------------------------------------------------------------------------
// Properties Syntax Enhancer
// ---------------------------------------------------------------------------

function scanPropertiesBuffer(text: string): Array<{ start: number; end: number; color: RGB }> {
  const byteOffsets = computeCharToByteOffsets(text);
  const items: Array<{ start: number; end: number; color: RGB }> = [];
  const lines = text.split("\n");
  let textIdx = 0;

  for (const line of lines) {
    const lineLen = line.length;
    const lineStart = textIdx;
    textIdx += lineLen + 1;

    let i = 0;
    while (i < lineLen && /\s/.test(line[i])) i++;
    if (i >= lineLen) continue;

    // Comment: # or !
    if (line[i] === "#" || line[i] === "!") {
      items.push({
        start: byteOffsets[lineStart + i],
        end: byteOffsets[lineStart + lineLen],
        color: COLORS.comment,
      });
      continue;
    }

    // Key before '=' or ':'
    const sepMatch = /[=:]/.exec(line.slice(i));
    if (sepMatch) {
      const sepIdx = i + sepMatch.index;
      items.push({
        start: byteOffsets[lineStart + i],
        end: byteOffsets[lineStart + sepIdx],
        color: COLORS.propKey,
      });

      const valStart = sepIdx + 1;
      if (valStart < lineLen) {
        const valStr = line.slice(valStart).trim();
        if (/^(true|false)$/i.test(valStr) || /^-?[0-9]+(\.[0-9]+)?$/.test(valStr)) {
          items.push({
            start: byteOffsets[lineStart + valStart],
            end: byteOffsets[lineStart + lineLen],
            color: COLORS.yamlConst,
          });
        }
      }
    }
  }

  return items;
}

export async function refreshPropertiesBuffer(bufferId: number) {
  try {
    const text = await editor.getBufferText(bufferId);
    if (typeof text !== "string") return;

    editor.clearNamespace(bufferId, PROP_NAMESPACE);
    const items = scanPropertiesBuffer(text);
    for (const item of items) {
      editor.addOverlay(bufferId, PROP_NAMESPACE, item.start, item.end, {
        fg: item.color,
      });
    }
  } catch (_e) {
    // Ignore error
  }
}
