/**
 * Client-only module: bundles monaco-editor and wires its web workers.
 * Everything that touches monaco imports it from here so the app and
 * y-monaco share one instance (two instances break instanceof checks).
 *
 * Only reachable via dynamic import from client components (never SSR).
 */
import * as monaco from "monaco-editor";
export { MonacoBinding } from "y-monaco";
export { monaco };

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    switch (label) {
      case "typescript":
      case "javascript":
        return new Worker(
          new URL("monaco-editor/esm/vs/language/typescript/ts.worker.js", import.meta.url),
        );
      case "json":
        return new Worker(
          new URL("monaco-editor/esm/vs/language/json/json.worker.js", import.meta.url),
        );
      case "css":
      case "scss":
      case "less":
        return new Worker(
          new URL("monaco-editor/esm/vs/language/css/css.worker.js", import.meta.url),
        );
      case "html":
        return new Worker(
          new URL("monaco-editor/esm/vs/language/html/html.worker.js", import.meta.url),
        );
      default:
        return new Worker(
          new URL("monaco-editor/esm/vs/editor/editor.worker.js", import.meta.url),
        );
    }
  },
};

const EXT_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  json: "json",
  css: "css",
  html: "html",
  md: "markdown",
  py: "python",
  go: "go",
  rs: "rust",
  yaml: "yaml",
  yml: "yaml",
  sh: "shell",
};

export function languageForPath(path: string): string {
  const ext = path.split(".").pop() ?? "";
  return EXT_LANG[ext] ?? "plaintext";
}
