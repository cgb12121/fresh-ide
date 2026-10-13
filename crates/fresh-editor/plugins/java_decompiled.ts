/// <reference path="./lib/fresh.d.ts" />

/**
 * Java LSP Library Decompiler Plugin
 *
 * Eclipse JDT.LS answers go-to-definition (F12) on external library classes (.jar)
 * with a synthetic URI such as `jdt://contents/spring-web-6.1.5.jar/org.springframework.web.bind.annotation/GetMapping.class?...`.
 *
 * This plugin registers the `jdt` and `jar` URI schemes and listens to `lsp_open_external_uri`.
 * When triggered, it requests the decompiled source from JDT.LS via `java/classFileContents`,
 * caches the .java file locally, and opens it in a read-only buffer at the target position.
 */

const editor = getEditor();

const SCHEMES = ["jdt", "jar"];

interface LspOpenExternalUriData {
  uri: string;
  scheme: string;
  line: number;      // 0-indexed (LSP)
  character: number; // 0-indexed (LSP)
  language: string;
  server_name: string;
}

for (const s of SCHEMES) {
  editor.registerLspUriScheme(s);
}

/**
 * Parses a jdt:// or jar:// URI into a clean relative path for disk caching.
 * e.g. "jdt://contents/spring-web-6.1.5.jar/org.springframework.web.bind.annotation/GetMapping.class?=..."
 *   -> { jarName: "spring-web-6.1.5.jar", className: "GetMapping.java", relPath: "spring-web-6.1.5.jar/org/springframework/web/bind/annotation/GetMapping.java" }
 */
function parsePathFromUri(rawUri: string): { jarName: string; className: string; relPath: string } {
  let decoded = rawUri;
  try {
    decoded = decodeURIComponent(rawUri);
  } catch (_e) {
    // Keep raw URI if malformed percent encoding
  }

  let clean = decoded.replace(/^(jdt|jar):\/\/+/, "");
  if (clean.startsWith("contents/")) {
    clean = clean.slice("contents/".length);
  }
  const qIdx = clean.indexOf("?");
  if (qIdx !== -1) {
    clean = clean.slice(0, qIdx);
  }
  if (clean.endsWith(".class")) {
    clean = clean.slice(0, -".class".length) + ".java";
  } else if (!clean.endsWith(".java")) {
    clean += ".java";
  }

  clean = clean.replace(/\\/g, "/");
  const rawParts = clean.split("/").filter((p) => p.length > 0);

  // If package parts have dots instead of slashes:
  // e.g. ["spring-web.jar", "org.springframework.web.bind.annotation", "GetMapping.java"]
  const parts: string[] = [];
  for (let i = 0; i < rawParts.length; i++) {
    const part = rawParts[i];
    if (i > 0 && i < rawParts.length - 1 && part.includes(".") && !part.endsWith(".jar")) {
      parts.push(...part.split("."));
    } else {
      parts.push(part);
    }
  }

  // Sanitize forbidden characters for Windows / Linux filesystem
  const safeParts = parts.map((p) => p.replace(/[<>:"|?*]/g, "_"));
  const fileName = safeParts.length > 0 ? safeParts[safeParts.length - 1] : "Decompiled.java";
  const jarName = safeParts.length > 1 ? safeParts[0] : "external-libs";

  return {
    jarName,
    className: fileName,
    relPath: safeParts.join("/"),
  };
}

editor.on("lsp_open_external_uri", async (data: LspOpenExternalUriData) => {
  if (!SCHEMES.includes(data.scheme)) return;

  const parsed = parsePathFromUri(data.uri);
  const dataDir = editor.getDataDir().replace(/\\/g, "/");
  const targetPath = `${dataDir}/java-decompiled/${parsed.relPath}`;
  const localTarget = editor.localPath(targetPath);

  // 1. Instant open if already cached on disk
  if (editor.fileExists(localTarget)) {
    if (editor.openFile(targetPath, data.line + 1, data.character + 1)) {
      editor.markFileReadOnly(targetPath);
      editor.setStatus(`Opened decompiled ${parsed.className} (cached)`);
      return;
    }
  }

  // 2. Request decompiled content from JDT.LS via standard LSP request
  editor.setStatus(`Java LSP: Decompiling ${parsed.className}...`);

  try {
    let resp: unknown = null;
    const lspLang = data.language || "java";
    try {
      resp = await editor.sendLspRequest(lspLang, "java/classFileContents", {
        uri: data.uri,
      });
    } catch (_err) {
      try {
        resp = await editor.sendLspRequest(lspLang, "workspace/textDocumentContent", {
          uri: data.uri,
        });
      } catch (err2) {
        editor.setStatus(`Java LSP decompile error: ${String(err2)}`);
        return;
      }
    }

    let content: string | null = null;
    if (typeof resp === "string") {
      content = resp;
    } else if (resp && typeof (resp as Record<string, unknown>).text === "string") {
      content = (resp as Record<string, unknown>).text as string;
    } else if (resp && typeof (resp as Record<string, unknown>).content === "string") {
      content = (resp as Record<string, unknown>).content as string;
    } else if (resp && typeof (resp as Record<string, unknown>).result === "string") {
      content = (resp as Record<string, unknown>).result as string;
    }

    if (!content || content.trim().length === 0) {
      editor.setStatus(`Java LSP: No decompiled content returned for ${parsed.className}`);
      return;
    }

    // 3. Write cached .java file and open in read-only mode
    const targetDir = editor.pathDirname(targetPath);
    editor.createDir(editor.localPath(targetDir));
    editor.replaceFile(localTarget, content);

    const opened = editor.openFile(targetPath, data.line + 1, data.character + 1);
    if (opened) {
      editor.markFileReadOnly(targetPath);
      editor.setStatus(`Opened decompiled ${parsed.className}`);
    } else {
      editor.setStatus(`Java LSP: Could not open cached file ${targetPath}`);
    }
  } catch (err) {
    editor.setStatus(`Java LSP decompile error: ${String(err)}`);
  }
});

function on_java_clear_decompiled_cache(): void {
  editor.setStatus("Java decompiled cache is stored at: " + editor.getDataDir() + "/java-decompiled");
}
registerHandler("java_clear_decompiled_cache", on_java_clear_decompiled_cache);

editor.registerCommand(
  "Java: Show Decompiled Cache Path",
  "Show path to cached decompiled Java library files",
  "java_clear_decompiled_cache",
  null
);

editor.debug("java_decompiled: Plugin loaded");
