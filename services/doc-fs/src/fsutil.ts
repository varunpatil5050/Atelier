import { promises as fs } from "node:fs";
import * as path from "node:path";

/** Directories/files never synced into the CRDT (build output, VCS, deps). */
export const DEFAULT_IGNORE = new Set([
  "node_modules",
  ".git",
  ".next",
  ".turbo",
  "dist",
  "data",
  "coverage",
  "test-results",
  ".DS_Store",
  ".pnpm-store",
]);

export const TMP_SUFFIX = ".atelier-tmp";
export const MAX_FILE_BYTES = 1 << 20; // 1 MiB per file, v0

export function isIgnored(rel: string): boolean {
  if (rel.endsWith(TMP_SUFFIX)) return true;
  return rel.split("/").some((seg) => DEFAULT_IGNORE.has(seg));
}

/** Null byte in the head is our binary heuristic (same as git's). */
export function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0);
}

/** Resolve rel inside root, refusing traversal outside it. */
export function resolveInside(root: string, rel: string): string {
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`doc-fs: path escapes workspace: ${rel}`);
  }
  return abs;
}

/** Walk all syncable text files under root → Map<relPath, content>. */
export async function walkTextFiles(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function visit(dirAbs: string): Promise<void> {
    const entries = await fs.readdir(dirAbs, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(dirAbs, entry.name);
      const rel = path.relative(root, abs).split(path.sep).join("/");
      if (isIgnored(rel)) continue;
      if (entry.isDirectory()) {
        await visit(abs);
      } else if (entry.isFile()) {
        const stat = await fs.stat(abs);
        if (stat.size > MAX_FILE_BYTES) continue;
        const buf = await fs.readFile(abs);
        if (looksBinary(buf)) continue;
        out.set(rel, buf.toString("utf8"));
      }
    }
  }
  await visit(root);
  return out;
}

/** Write via temp file + rename so watchers/readers never see partial content. */
export async function atomicWrite(abs: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const tmp = abs + TMP_SUFFIX;
  await fs.writeFile(tmp, content, "utf8");
  await fs.rename(tmp, abs);
}
