import type * as Y from "yjs";

/**
 * Apply `next` to a Y.Text as a minimal single replace (common prefix/suffix
 * preserved). Compared to delete-all + insert-all, this keeps collaborators'
 * relative cursor positions stable through external file writes.
 * Must be called inside a doc.transact().
 */
export function applyTextDiff(ytext: Y.Text, next: string): void {
  const prev = ytext.toString();
  if (prev === next) return;

  let start = 0;
  const minLen = Math.min(prev.length, next.length);
  while (start < minLen && prev.charCodeAt(start) === next.charCodeAt(start)) start++;

  let endPrev = prev.length;
  let endNext = next.length;
  while (
    endPrev > start &&
    endNext > start &&
    prev.charCodeAt(endPrev - 1) === next.charCodeAt(endNext - 1)
  ) {
    endPrev--;
    endNext--;
  }

  if (endPrev > start) ytext.delete(start, endPrev - start);
  if (endNext > start) ytext.insert(start, next.slice(start, endNext));
}
