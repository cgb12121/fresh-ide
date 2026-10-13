# Java Decompiled Library Code Navigation via LSP

> **Status:** IMPLEMENTED  
> **Audience:** Java developers, Fresh core and plugin maintainers.  
> **Target Scenarios:** Java / Maven / Gradle projects inspected with Eclipse JDT.LS language server.

---

## 1. Context & Problem Statement

In standard Java projects managed by Maven or Gradle, third-party libraries (e.g., Spring Framework, Netty, Jackson, Kafka Client) are resolved from local repository caches (`~/.m2/repository` or `~/.gradle/caches`).

When a developer invokes **Go to Definition** (`F12`) on a library type or method (such as `@GetMapping`, `ChannelHandlerContext`, `ObjectMapper`), Eclipse JDT.LS does not return a normal `file://` URI because the source may not exist as a loose file on disk. Instead, JDT.LS returns a synthetic URI scheme:

```text
jdt://contents/spring-web-6.1.5.jar/org.springframework.web.bind.annotation/GetMapping.class?=...
```

Previously, text editors lacking specialized external URI handlers would report:
```text
external location, no local source file
```
leaving developers unable to inspect bytecode, decompiled source, parameter names, or method contracts of dependencies.

---

## 2. Architecture & Solution Design

### 2.1 Scheme Interception via Core Router

Fresh core (`crates/fresh-core/src/hooks.rs` and `crates/fresh-editor/src/app/lsp_requests.rs`) provides a scheme-agnostic extension point:
1. Plugins register claimed URI schemes via `editor.registerLspUriScheme("jdt")` and `editor.registerLspUriScheme("jar")`.
2. When Fresh receives LSP definition or declaration responses containing a matching scheme, instead of throwing an unsupported URI error, it emits the `lsp_open_external_uri` event hook with payload:
   ```ts
   interface LspOpenExternalUriData {
     uri: string;
     scheme: string;
     line: number;      // 0-indexed (LSP)
     character: number; // 0-indexed (LSP)
     language: string;
     server_name: string;
   }
   ```

### 2.2 Plugin Implementation (`crates/fresh-editor/plugins/java_decompiled.ts`)

The plugin handles the `lsp_open_external_uri` event through a 3-stage lifecycle:

```text
[Go to Definition (F12)]
          │
          ▼
   LSP returns jdt://...
          │
          ▼
[lsp_open_external_uri Hook]
          │
          ├── 1. Check Local Cache (AppData/Local/fresh/java-decompiled/...)
          │        ├── Cache Hit  ─► Open read-only buffer at (line, col)
          │        └── Cache Miss ─► Continue
          │
          ├── 2. Send LSP Request: "java/classFileContents"
          │        └── JDT.LS decompiles / fetches attached source
          │
          └── 3. Persist to Cache Directory
                   ├── Write source to disk
                   ├── editor.openFile(path, line, col)
                   └── editor.markFileReadOnly(path)
```

### 2.3 URI Parsing & Path Sanitization

JDT.LS URIs encode JAR names, package segments, and class names:
`jdt://contents/spring-web-6.1.5.jar/org.springframework.web.bind.annotation/GetMapping.class?=...`

The parser extracts:
- **JAR name:** `spring-web-6.1.5.jar`
- **Package segments:** `org/springframework/web/bind/annotation`
- **File name:** `GetMapping.java`
- **Full cached relative path:** `spring-web-6.1.5.jar/org/springframework/web/bind/annotation/GetMapping.java`

Sanitization strips query fragments (`?=...`) and replaces characters forbidden on Windows/Linux file systems (`<>:"|?*`).

### 2.4 Safety & Read-Only Protection

Decompiled files are generated views of compiled bytecode. Allowing accidental edits would desynchronize the cache and confuse developers. The plugin calls `editor.markFileReadOnly(targetPath)` immediately after opening the file.

In Fresh core (`crates/fresh-editor/src/app/plugin_dispatch.rs`), `handle_mark_buffer_read_only` normalizes both the input path and the buffer metadata's canonical path (stripping Windows verbatim UNC `\\?\` prefix, converting backslashes to forward slashes, and lowercasing on Windows) so that the open buffer is reliably identified and locked regardless of path representations.

### 2.5 Extended Client Capabilities Negotiation (`extendedClientCapabilities`)

Eclipse JDT.LS strictly requires the client to advertise support for decompiled class files during LSP initialization:
```json
{
  "extendedClientCapabilities": {
    "classFileContentsSupport": true
  }
}
```
If this capability is missing or false:
- JDT.LS considers the client incapable of handling synthetic `jdt://` URIs.
- On `textDocument/definition` (F12) for bytecode symbols, JDT.LS silently returns empty locations (`[]` / `null`) instead of returning a `jdt://` URI.
- The editor would display `"No definition found"`.

To provide a zero-configuration experience:
1. **Fresh Core Auto-Injection:** In `crates/fresh-editor/src/services/lsp/async_handler.rs`, during `handle_initialize_sequential`, whenever the LSP language is `"java"` or the server is JDT.LS, Fresh automatically injects `extendedClientCapabilities.classFileContentsSupport = true` into `initialization_options` if not already set.
2. **Configuration Fallback:** `resolve_configuration_section` supports resolving sections located either directly at the top level or nested under `settings` (e.g. `initialization_options.settings.java`), ensuring configuration pulls succeed across different client configuration formats.
3. **Project Config:** Project configuration (`.fresh/config.json`) explicitly defines `classFileContentsSupport: true` under `initialization_options.extendedClientCapabilities`.

---

## 3. Supported Features & User Experience

1. **Seamless F12 Navigation:** Jump from application code directly into dependency source code as naturally as opening local project files.
2. **Instant Warm Re-Open:** Once decompiled, subsequent navigations to the same class load instantly from the local disk cache without re-querying the language server.
3. **Cache Path Discovery:** Includes the command `Java: Show Decompiled Cache Path` (`java:show_decompiled_cache_path`) accessible via the command palette (`Ctrl+P` / `F1`).
4. **Read-Only Status:** The buffer status bar reflects read-only mode, preventing unintentional modifications.
