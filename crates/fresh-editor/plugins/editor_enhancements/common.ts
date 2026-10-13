/// <reference path="../lib/fresh.d.ts" />

/**
 * Shared state and helpers for the `editor_enhancements` plugin bundle.
 *
 * This plugin used to be a single ~1550-line `init.ts`. It is split here into
 * one entry file (`../editor_enhancements.ts`) plus this folder of modules.
 * Everything more than one module needs lives here: the editor handle, the
 * decoration namespace names, the RGB palette, the git-gutter config and the
 * small path/offset helpers.
 *
 * `editor_enhancements.ts` is the only *plugin*; this folder is imported by it
 * and is never scanned as a plugin directory (the loader only looks at
 * top-level `.ts` files).
 */

export const editor = getEditor();

export const GIT_NAMESPACE = "git-explorer";
export const JAVA_NAMESPACE = "java-enhancer";
export const XML_NAMESPACE = "xml-enhancer";
export const YAML_NAMESPACE = "yaml-enhancer";
export const PROP_NAMESPACE = "prop-enhancer";
export const GUTTER_NAMESPACE = "git-gutter-custom";

/** An explicit RGB tuple, so rendering never depends on a theme string lookup. */
export type RGB = [number, number, number];

export const GIT_GUTTER_CONFIG = {
  enabled: true,
  // Thicker bar indicator (U+258E Left Three Eighths Block) - clearly visible
  symbolAdded: "▎",
  symbolModified: "▎",
  symbolDeleted: "▾",
  // showModified: set to false to completely hide orange for modified lines.
  // With true, we pass --ignore-cr-at-eol to git diff so Windows CRLF
  // differences never cause false modified marks on unchanged lines!
  showModified: true,
  priority: 25,
};

export const COLORS = {
  // Explicit RGB tuples ensure 100% dependable rendering without relying on theme string lookups:
  staged:      [137, 209, 133] as RGB, // Pale Green (#89D185 - VS Code staged)
  added:       [86, 211, 100] as RGB,  // Vibrant Green (#56D364 - VS Code added/untracked)
  modified:    [88, 166, 255] as RGB,  // Sea Blue (#58A6FF - VS Code modified)
  deleted:     [248, 81, 73] as RGB,   // Red
  renamed:     [88, 166, 255] as RGB,  // Sea Blue
  untracked:   [86, 211, 100] as RGB,  // Vibrant Green (#56D364)
  conflicted:  [248, 81, 73] as RGB,   // Red
  ignored:     [84, 110, 122] as RGB,  // Muted Gray
  cleanFolder: [238, 255, 255] as RGB, // Crisp White

  // Syntax Colors:
  javaType:    [255, 203, 107] as RGB, // Yellow
  javaFunc:    [130, 170, 255] as RGB, // Blue
  javaVar:     [248, 248, 242] as RGB, // Crisp White
  javaConst:   [247, 140, 108] as RGB, // Orange
  javaAnn:     [199, 146, 234] as RGB, // Purple
  javaKw:      [137, 221, 255] as RGB, // Cyan (package and imp-statement keywords, type params)
  javaIface:   [195, 232, 141] as RGB, // Green (interfaces)
  javaEnum:    [240, 113, 120] as RGB, // Red-pink (enums)

  // XML Colors:
  xmlTag:      [130, 170, 255] as RGB, // Blue for tag names
  xmlAttr:     [255, 203, 107] as RGB, // Yellow for attributes
  xmlDecl:     [199, 146, 234] as RGB, // Purple for <?xml ... ?>

  // YAML Colors:
  yamlKey:     [130, 170, 255] as RGB, // Blue for keys
  yamlConst:   [247, 140, 108] as RGB, // Orange for numbers, true/false, null

  // Properties Colors:
  propKey:     [130, 170, 255] as RGB, // Blue for keys

  // Shared literals:
  string:      [195, 232, 141] as RGB, // Green
  comment:     [84, 110, 122] as RGB,  // Gray

  // Custom Git Gutter:
  gutterAdded:    [86, 211, 100] as RGB,  // Vibrant Green
  gutterModified: [88, 166, 255] as RGB,  // Sea Blue
  gutterDeleted:  [248, 81, 73] as RGB,   // Red
};

export const PRIORITY = {
  conflicted: 90,
  deleted:    80,
  modified:   70,
  staged:     65,
  added:      60,
  renamed:    55,
  untracked:  50,
};

/** A file-explorer badge/decoration derived from a git status code. */
export interface Decoration {
  symbol: string;
  color: RGB;
  priority: number;
}

export function statusToDecoration(status: string, staged: boolean): Decoration | null {
  if (staged) {
    switch (status) {
      case "A":
        return { symbol: "A", color: COLORS.staged, priority: PRIORITY.staged };
      case "M":
        return { symbol: "M", color: COLORS.staged, priority: PRIORITY.staged };
      case "D":
        return { symbol: "D", color: COLORS.staged, priority: PRIORITY.staged };
      case "R":
      case "C":
        return { symbol: "R", color: COLORS.staged, priority: PRIORITY.staged };
      case "U":
        return { symbol: "!", color: COLORS.conflicted, priority: PRIORITY.conflicted };
      default:
        return null;
    }
  }

  switch (status) {
    case "A":
      return { symbol: "A", color: COLORS.added, priority: PRIORITY.added };
    case "?":
      return { symbol: "U", color: COLORS.untracked, priority: PRIORITY.untracked };
    case "M":
      return {
        symbol: "M",
        color: COLORS.modified,
        priority: PRIORITY.modified,
      };
    case "D":
      return { symbol: "D", color: COLORS.deleted, priority: PRIORITY.deleted };
    case "R":
    case "C":
      return { symbol: "R", color: COLORS.renamed, priority: PRIORITY.renamed };
    case "U":
      return { symbol: "!", color: COLORS.conflicted, priority: PRIORITY.conflicted };
    default:
      return null;
  }
}

export function normalizePath(p: string): string {
  let s = p.replace(/\\/g, "/");
  if (s.startsWith("//?/")) {
    s = s.slice(4);
  }
  return s.replace(/\/+$/, "");
}

/** Order-independent key for the payload signature (path is unique per array). */
export function compareByPath(a: Record<string, unknown>, b: Record<string, unknown>): number {
  const pa = String(a.path);
  const pb = String(b.path);
  return pa < pb ? -1 : pa > pb ? 1 : 0;
}

export function getPathVariants(p: string): string[] {
  let clean = p.replace(/\\/g, "/").replace(/\/+$/, "");
  if (clean.startsWith("//?/")) {
    clean = clean.slice(4);
  }
  const winClean = clean.replace(/\//g, "\\");
  const verbatim = "\\\\?\\" + winClean;
  return [clean, winClean, verbatim];
}

/** Fingerprint of a decoration payload, used to skip a no-op apply.
 *
 * Two independent FNV-1a accumulators over the fields that actually reach the
 * editor. This replaced `JSON.stringify(slots) + JSON.stringify(decorations)`,
 * which built a ~457KB temporary string twice per refresh purely to answer
 * "did anything change?" — on the payload this plugin used to emit. */
export function payloadSignature(
  slots: Record<string, unknown>[],
  decorations: Record<string, unknown>[]
): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const mix = (v: unknown) => {
    const s = typeof v === "string" ? v : String(v);
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193);
      h2 = Math.imul(h2 ^ c, 0x85ebca6b);
    }
    // Field separator so ["ab","c"] and ["a","bc"] hash differently.
    h1 = Math.imul(h1 ^ 0x2f, 0x01000193);
    h2 = Math.imul(h2 ^ 0x2f, 0x85ebca6b);
  };

  for (const s of slots) {
    mix(s.path);
    mix(s.nameColor);
    mix(s.priority);
    mix(s.suppressTrailing);
  }
  for (const d of decorations) {
    mix(d.path);
    mix(d.symbol);
    mix(d.color);
    mix(d.priority);
  }

  return (h1 >>> 0).toString(16) + (h2 >>> 0).toString(16);
}

/** Char-index -> byte-offset table for one text, used by every syntax scanner. */
export function computeCharToByteOffsets(text: string): Uint32Array {
  const offsets = new Uint32Array(text.length + 1);
  let byteLen = 0;
  for (let i = 0; i < text.length; i++) {
    offsets[i] = byteLen;
    const code = text.charCodeAt(i);
    if (code < 0x80) {
      byteLen += 1;
    } else if (code < 0x800) {
      byteLen += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      byteLen += 4;
      i++;
      offsets[i] = byteLen;
    } else {
      byteLen += 3;
    }
  }
  offsets[text.length] = byteLen;
  return offsets;
}
