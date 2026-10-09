import { editor, COLORS, XML_NAMESPACE, computeCharToByteOffsets } from "./common.ts";
import type { RGB } from "./common.ts";

// ---------------------------------------------------------------------------
// XML Syntax Enhancer
// ---------------------------------------------------------------------------

function scanXmlBuffer(text: string): Array<{ start: number; end: number; color: RGB }> {
  const byteOffsets = computeCharToByteOffsets(text);
  const items: Array<{ start: number; end: number; color: RGB }> = [];
  const len = text.length;
  let i = 0;

  while (i < len) {
    // 1. Comment <!-- ... -->
    if (text.startsWith("<!--", i)) {
      const start = i;
      i += 4;
      const endIdx = text.indexOf("-->", i);
      if (endIdx === -1) {
        i = len;
      } else {
        i = endIdx + 3;
      }
      items.push({ start: byteOffsets[start], end: byteOffsets[i], color: COLORS.comment });
      continue;
    }

    // 2. Declaration / Processing instruction <?xml ... ?>
    if (text.startsWith("<?", i)) {
      const start = i;
      i += 2;
      const endIdx = text.indexOf("?>", i);
      if (endIdx === -1) {
        i = len;
      } else {
        i = endIdx + 2;
      }
      items.push({ start: byteOffsets[start], end: byteOffsets[i], color: COLORS.xmlDecl });
      continue;
    }

    // 3. CDATA <![CDATA[ ... ]]>
    if (text.startsWith("<![CDATA[", i)) {
      const start = i;
      i += 9;
      const endIdx = text.indexOf("]]>", i);
      if (endIdx === -1) {
        i = len;
      } else {
        i = endIdx + 3;
      }
      items.push({ start: byteOffsets[start], end: byteOffsets[i], color: COLORS.string });
      continue;
    }

    // 4. Tags: <tag ...> or </tag>
    if (text[i] === "<") {
      i++; // skip '<'
      if (i < len && text[i] === "/") i++; // skip '/'

      // Tag name
      const tagStart = i;
      while (i < len && /[a-zA-Z0-9_.:-]/.test(text[i])) {
        i++;
      }
      if (i > tagStart) {
        items.push({ start: byteOffsets[tagStart], end: byteOffsets[i], color: COLORS.xmlTag });
      }

      // Attributes inside tag until '>'
      while (i < len && text[i] !== ">") {
        if (/\s|\//.test(text[i])) {
          i++;
          continue;
        }

        // Attribute name
        if (/[a-zA-Z0-9_.:-]/.test(text[i])) {
          const attrStart = i;
          while (i < len && /[a-zA-Z0-9_.:-]/.test(text[i])) i++;
          items.push({ start: byteOffsets[attrStart], end: byteOffsets[i], color: COLORS.xmlAttr });
          continue;
        }

        // Attribute value: "..." or '...'
        if (text[i] === '"' || text[i] === "'") {
          const quote = text[i];
          const valStart = i;
          i++;
          while (i < len && text[i] !== quote && text[i] !== "\n") i++;
          if (i < len && text[i] === quote) i++;
          items.push({ start: byteOffsets[valStart], end: byteOffsets[i], color: COLORS.string });
          continue;
        }

        i++;
      }
      if (i < len && text[i] === ">") i++;
      continue;
    }

    i++;
  }

  return items;
}

export async function refreshXmlBuffer(bufferId: number) {
  try {
    const text = await editor.getBufferText(bufferId);
    if (typeof text !== "string") return;

    editor.clearNamespace(bufferId, XML_NAMESPACE);
    const items = scanXmlBuffer(text);
    for (const item of items) {
      editor.addOverlay(bufferId, XML_NAMESPACE, item.start, item.end, {
        fg: item.color,
      });
    }
  } catch (_e) {
    // Ignore error
  }
}
