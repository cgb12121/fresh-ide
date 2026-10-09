import { editor, COLORS, JAVA_NAMESPACE, computeCharToByteOffsets } from "./common.ts";
import type { RGB } from "./common.ts";

// ---------------------------------------------------------------------------
// Java Syntax Enhancer Logic
// ---------------------------------------------------------------------------

const JAVA_KEYWORDS = new Set([
  "abstract", "assert", "boolean", "break", "byte", "case", "catch", "char",
  "class", "const", "continue", "default", "do", "double", "else", "enum",
  "extends", "final", "finally", "float", "for", "goto", "if", "implements",
  "imp" + "ort", "instanceof", "int", "interface", "long", "native", "new",
  "package", "private", "protected", "public", "return", "short", "static",
  "strictfp", "super", "switch", "synchronized", "this", "throw", "throws",
  "transient", "try", "void", "volatile", "while", "true", "false", "null",
  "var", "record", "yield", "sealed", "permits"
]);

const CONTROL_FLOW_KEYWORDS = new Set([
  "if", "while", "for", "switch", "catch", "synchronized"
]);

interface JavaHighlightItem {
  start: number;
  end: number;
  color: RGB;
}

// Kinds of types declared in the file being scanned (no LSP available): name -> "interface" | "enum"
let javaDeclKinds = new Map<string, string>();

function collectJavaDecls(text: string) {
  javaDeclKinds = new Map<string, string>();
  const re = /\b(interface|enum)\s+([A-Z][A-Za-z0-9_$]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    javaDeclKinds.set(m[2], m[1]);
  }
}

function javaTypeColor(name: string): RGB {
  if (/(Exception|Error)$/.test(name)) return COLORS.deleted;
  const kind = javaDeclKinds.get(name);
  if (kind === "enum") return COLORS.javaEnum;
  if (kind === "interface") return COLORS.javaIface;
  // Generic type parameters: T, E, K, V, T1 ...
  if (/^[A-Z][0-9]?$/.test(name)) return COLORS.javaKw;
  return COLORS.javaType;
}

function scanJavaBuffer(text: string): JavaHighlightItem[] {
  collectJavaDecls(text);
  const byteOffsets = computeCharToByteOffsets(text);
  const items: JavaHighlightItem[] = [];
  const len = text.length;
  let i = 0;
  let lastWord = "";

  while (i < len) {
    const ch = text[i];

    // 1. Line comment
    if (ch === "/" && text[i + 1] === "/") {
      i += 2;
      while (i < len && text[i] !== "\n") i++;
      lastWord = "";
      continue;
    }

    // 2. Block comment
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < len && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      lastWord = "";
      continue;
    }

    // 3. String literal & Text block
    if (ch === '"') {
      if (text.slice(i, i + 3) === '"""') {
        i += 3;
        while (i < len && text.slice(i, i + 3) !== '"""') {
          if (text[i] === "\\") i++;
          i++;
        }
        i += 3;
      } else {
        i++;
        while (i < len && text[i] !== '"' && text[i] !== "\n") {
          if (text[i] === "\\") i++;
          i++;
        }
        if (i < len && text[i] === '"') i++;
      }
      lastWord = "";
      continue;
    }

    // 4. Character literal
    if (ch === "'") {
      i++;
      while (i < len && text[i] !== "'" && text[i] !== "\n") {
        if (text[i] === "\\") i++;
        i++;
      }
      if (i < len && text[i] === "'") i++;
      lastWord = "";
      continue;
    }

    // 5. Annotation: @AnnotationIdentifier or qualified @pkg.name.AnnotationIdentifier
    if (ch === "@") {
      const atCharIdx = i;
      i++;
      let cur = i;
      const segs: { start: number; end: number; name: string }[] = [];
      while (cur < len) {
        const segStart = cur;
        while (cur < len && /[a-zA-Z0-9_$]/.test(text[cur])) cur++;
        if (cur > segStart) {
          segs.push({ start: segStart, end: cur, name: text.slice(segStart, cur) });
        }
        if (cur < len && text[cur] === "." && cur + 1 < len && /[a-zA-Z0-9_$]/.test(text[cur + 1])) {
          cur++; // skip dot
        } else {
          break;
        }
      }

      if (segs.length === 1) {
        // Simple annotation: e.g. @Override, @Service
        items.push({
          start: byteOffsets[atCharIdx],
          end: byteOffsets[segs[0].end],
          color: COLORS.javaAnn,
        });
        i = segs[0].end;
      } else if (segs.length > 1) {
        // Qualified annotation: @org.springframework.stereotype.Service
        const lastSeg = segs[segs.length - 1];
        const dotPos = text.lastIndexOf(".", lastSeg.start);
        const pkgEnd = (dotPos !== -1) ? dotPos + 1 : lastSeg.start;
        // Package prefix dimmed (comment color)
        items.push({
          start: byteOffsets[atCharIdx],
          end: byteOffsets[pkgEnd],
          color: COLORS.comment,
        });
        // Annotation name purple
        items.push({
          start: byteOffsets[lastSeg.start],
          end: byteOffsets[lastSeg.end],
          color: COLORS.javaAnn,
        });
        i = lastSeg.end;
      }
      lastWord = "";
      continue;
    }

    // 6. Number literals (skip so they keep theme constant color)
    if (/[0-9]/.test(ch) && (i === 0 || !/[a-zA-Z0-9_$]/.test(text[i - 1]))) {
      while (i < len && /[0-9a-fA-FxX_eEpP.lLfFdD]/.test(text[i])) {
        i++;
      }
      lastWord = "";
      continue;
    }

    // 7. Java package decls: [static] package.prefix.Symbol
    // Dims package prefix in comment color while keeping referenced Types / Symbols bright
    if (
      text.startsWith("imp" + "ort", i) &&
      (i === 0 || !/[a-zA-Z0-9_$]/.test(text[i - 1])) &&
      !/[a-zA-Z0-9_$]/.test(text[i + 6] || "")
    ) {
      items.push({ start: byteOffsets[i], end: byteOffsets[i + 6], color: COLORS.javaKw });
      i += 6;
      while (i < len && /\s/.test(text[i])) i++;

      let isStatic = false;
      if (
        text.startsWith("static", i) &&
        !/[a-zA-Z0-9_$]/.test(text[i + 6] || "")
      ) {
        isStatic = true;
        items.push({ start: byteOffsets[i], end: byteOffsets[i + 6], color: COLORS.javaKw });
        i += 6;
        while (i < len && /\s/.test(text[i])) i++;
      }

      const pkgPathStart = i;
      while (i < len && text[i] !== ";" && text[i] !== "\n") {
        i++;
      }
      const rawPath = text.slice(pkgPathStart, i).trim();

      if (rawPath.length > 0) {
        const segs: { start: number; end: number; name: string }[] = [];
        let p = 0;
        while (p < rawPath.length) {
          while (p < rawPath.length && /\s/.test(rawPath[p])) p++;
          const segStart = p;
          while (p < rawPath.length && /[a-zA-Z0-9_$*]/.test(rawPath[p])) p++;
          if (p > segStart) {
            segs.push({
              start: pkgPathStart + segStart,
              end: pkgPathStart + p,
              name: rawPath.slice(segStart, p),
            });
          }
          while (p < rawPath.length && (rawPath[p] === "." || /\s/.test(rawPath[p]))) {
            p++;
          }
        }

        if (segs.length > 0) {
          if (!isStatic) {
            // Normal decl: java.nio.charset.StandardCharsets or java.util.*
            const lastSeg = segs[segs.length - 1];
            if (segs.length > 1) {
              const dotPos = text.lastIndexOf(".", lastSeg.start);
              const pkgEnd = (dotPos !== -1 && dotPos >= pkgPathStart) ? dotPos + 1 : lastSeg.start;
              items.push({
                start: byteOffsets[segs[0].start],
                end: byteOffsets[pkgEnd],
                color: COLORS.comment,
              });
            }
            if (lastSeg.name !== "*") {
              const isUpper = lastSeg.name[0] >= "A" && lastSeg.name[0] <= "Z";
              items.push({
                start: byteOffsets[lastSeg.start],
                end: byteOffsets[lastSeg.end],
                color: isUpper ? javaTypeColor(lastSeg.name) : COLORS.javaVar,
              });
            }
          } else {
            // Static decl: org.junit.jupiter.api.Assertions.assertEquals
            // Or: java.nio.charset.StandardCharsets.UTF_8
            let classIdx = -1;
            for (let s = 0; s < segs.length; s++) {
              if (segs[s].name[0] >= "A" && segs[s].name[0] <= "Z") {
                classIdx = s;
                break;
              }
            }
            if (classIdx === -1) {
              classIdx = Math.max(0, segs.length - 2);
            }

            if (classIdx > 0) {
              const classSeg = segs[classIdx];
              const dotPos = text.lastIndexOf(".", classSeg.start);
              const pkgEnd = (dotPos !== -1 && dotPos >= pkgPathStart) ? dotPos + 1 : classSeg.start;
              items.push({
                start: byteOffsets[segs[0].start],
                end: byteOffsets[pkgEnd],
                color: COLORS.comment,
              });
            }

            const classSeg = segs[classIdx];
            if (classSeg && classSeg.name !== "*") {
              items.push({
                start: byteOffsets[classSeg.start],
                end: byteOffsets[classSeg.end],
                color: COLORS.javaType,
              });
            }

            for (let m = classIdx + 1; m < segs.length; m++) {
              const memSeg = segs[m];
              if (memSeg.name === "*") continue;
              const isAllUpper = memSeg.name.includes("_") && /^[A-Z0-9_]+$/.test(memSeg.name);
              const color = isAllUpper ? COLORS.javaConst : COLORS.javaFunc;
              items.push({
                start: byteOffsets[memSeg.start],
                end: byteOffsets[memSeg.end],
                color: color,
              });
            }
          }
        }
      }
      lastWord = "";
      continue;
    }

    // 8. Identifiers (Keywords, Types, Functions, Variables, Constants, Inline FQNs)
    if (/[a-zA-Z_$]/.test(ch)) {
      const prevChar = i > 0 ? text[i - 1] : " ";
      const identStart = i;
      while (i < len && /[a-zA-Z0-9_$]/.test(text[i])) {
        i++;
      }
      const identEnd = i;
      const word = text.slice(identStart, identEnd);

      // Check for inline FQN: e.g. java.nio.charset.StandardCharsets or org.slf4j.Logger
      // Must not be preceded by '.' or identifier character, must start with lowercase, and be followed by '.'
      if (prevChar !== "." && /^[a-z]/.test(word) && text[i] === ".") {
        let cur = identStart;
        const chainSegs: { start: number; end: number; name: string }[] = [];
        let validFqn = false;
        let classSeg: { start: number; end: number; name: string } | null = null;

        while (cur < len) {
          const s = cur;
          while (cur < len && /[a-zA-Z0-9_$]/.test(text[cur])) cur++;
          const segName = text.slice(s, cur);
          chainSegs.push({ start: s, end: cur, name: segName });

          if (segName[0] >= "A" && segName[0] <= "Z") {
            validFqn = true;
            classSeg = chainSegs[chainSegs.length - 1];
            break;
          }
          if (cur < len && text[cur] === ".") {
            cur++; // skip dot
          } else {
            break;
          }
        }

        if (validFqn && classSeg && chainSegs.length >= 2) {
          // Dim all package segments and dots up to classSeg
          const dotPos = text.lastIndexOf(".", classSeg.start);
          const pkgEnd = (dotPos !== -1) ? dotPos + 1 : classSeg.start;
          items.push({
            start: byteOffsets[identStart],
            end: byteOffsets[pkgEnd],
            color: COLORS.comment,
          });

          // Class segment
          items.push({
            start: byteOffsets[classSeg.start],
            end: byteOffsets[classSeg.end],
            color: javaTypeColor(classSeg.name),
          });

          i = classSeg.end;
          lastWord = classSeg.name;
          continue;
        }
      }

      // Check if followed by '(' (ignoring whitespace)
      let nextIdx = i;
      while (nextIdx < len && /\s/.test(text[nextIdx])) nextIdx++;
      const isCallOrDecl = nextIdx < len && text[nextIdx] === "(";

      // Package declaration: dim the whole dotted name up to ';'
      if (word === "package" && prevChar !== ".") {
        items.push({
          start: byteOffsets[identStart],
          end: byteOffsets[identEnd],
          color: COLORS.javaKw,
        });
        let p = i;
        while (p < len && /\s/.test(text[p])) p++;
        const pathStart = p;
        while (p < len && /[a-zA-Z0-9_$.\s]/.test(text[p]) && text[p] !== ";") p++;
        let pathEnd = p;
        while (pathEnd > pathStart && /\s/.test(text[pathEnd - 1])) pathEnd--;
        if (pathEnd > pathStart && text[p] === ";") {
          items.push({
            start: byteOffsets[pathStart],
            end: byteOffsets[pathEnd],
            color: COLORS.comment,
          });
          i = p;
          lastWord = "";
          continue;
        }
      }

      if (JAVA_KEYWORDS.has(word)) {
        // Keyword: handled natively by theme / syntect
        lastWord = word;
        continue;
      }

      const firstChar = word[0];
      const isUpper = firstChar >= "A" && firstChar <= "Z";
      const isAllUpperWithUnderscore =
        isUpper && word.includes("_") && /^[A-Z0-9_]+$/.test(word);

      if (isAllUpperWithUnderscore) {
        // Constant (e.g. MAX_VALUE, DEFAULT_TIMEOUT)
        items.push({
          start: byteOffsets[identStart],
          end: byteOffsets[identEnd],
          color: COLORS.javaConst,
        });
      } else if (isUpper) {
        // Class / Interface / Type / Generic; *Exception / *Error are red
        items.push({
          start: byteOffsets[identStart],
          end: byteOffsets[identEnd],
          color: javaTypeColor(word),
        });
      } else {
        // Identifier starts with lowercase [a-z] or [_$]
        if (isCallOrDecl && !CONTROL_FLOW_KEYWORDS.has(word) && lastWord !== "new") {
          // Method name (main, println, execute, etc.)
          items.push({
            start: byteOffsets[identStart],
            end: byteOffsets[identEnd],
            color: COLORS.javaFunc,
          });
        } else {
          // Variable / Parameter name (args, id, user, etc.)
          items.push({
            start: byteOffsets[identStart],
            end: byteOffsets[identEnd],
            color: COLORS.javaVar,
          });
        }
      }

      lastWord = word;
      continue;
    }

    if (!/\s/.test(ch)) {
      lastWord = "";
    }
    i++;
  }

  return items;
}

export async function refreshJavaBuffer(bufferId: number) {
  try {
    const info = editor.getBufferInfo(bufferId);
    if (!info || !info.path || !info.path.endsWith(".java")) {
      return;
    }
    const text = await editor.getBufferText(bufferId);
    if (typeof text !== "string") return;

    editor.clearNamespace(bufferId, JAVA_NAMESPACE);

    const items = scanJavaBuffer(text);
    for (const item of items) {
      editor.addOverlay(bufferId, JAVA_NAMESPACE, item.start, item.end, {
        fg: item.color,
      });
    }
  } catch (_e) {
    // Ignore error
  }
}
