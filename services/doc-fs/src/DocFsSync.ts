import { promises as fs, watch, type FSWatcher } from "node:fs";
import { createHash } from "node:crypto";
import * as path from "node:path";
import * as Y from "yjs";
import type { AtelierProvider } from "@atelier/client";
import {
  MAX_FILE_BYTES,
  atomicWrite,
  isIgnored,
  looksBinary,
  resolveInside,
  walkTextFiles,
} from "./fsutil.js";
import { applyTextDiff } from "./textdiff.js";

/**
 * DocFsSync bridges a room's CRDT file map and a workspace directory
 * (blueprint doc 04 §3): the CRDT is the truth for live editing, the
 * filesystem is the truth at rest — so terminals, compilers, and git all see
 * what collaborators type, and external writes flow back into the room.
 *
 * v0 semantics (deliberate, documented):
 *  - Initial reconcile: CRDT wins for paths present in both; disk-only files
 *    are imported into the room.
 *  - Disk-side deletions are NOT propagated (git checkout churn is too easy
 *    to misread as intent); doc-side deletions DO delete the file on disk.
 *  - Text files ≤ 1 MiB only; binaries and build dirs are ignored.
 */

/** Transaction origin marking CRDT changes that came from disk. */
const ORIGIN = "doc-fs";

export interface DocFsOptions {
  provider: AtelierProvider;
  dir: string;
  debounceMs?: number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export class DocFsSync {
  private readonly provider: AtelierProvider;
  private readonly dir: string;
  private readonly debounceMs: number;
  private readonly log: (msg: string, extra?: Record<string, unknown>) => void;

  private readonly files: Y.Map<Y.Text>;
  /** rel → sha256 of content we just wrote (suppresses watcher echoes). */
  private readonly selfWrites = new Map<string, string>();
  private readonly docTimers = new Map<string, NodeJS.Timeout>();
  private readonly diskTimers = new Map<string, NodeJS.Timeout>();
  private watcher: FSWatcher | null = null;
  private stopped = false;

  constructor(opts: DocFsOptions) {
    this.provider = opts.provider;
    this.dir = path.resolve(opts.dir);
    this.debounceMs = opts.debounceMs ?? 300;
    this.log = opts.log ?? (() => {});
    this.files = this.provider.doc.getMap<Y.Text>("files");
  }

  async start(): Promise<void> {
    await this.waitSynced();
    await this.reconcile();
    this.files.observeDeep(this.onDocEvents);
    this.watcher = watch(this.dir, { recursive: true }, (_evt, filename) => {
      if (filename) this.onFsEvent(filename.toString());
    });
    this.log("doc-fs started", { dir: this.dir, files: this.files.size });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.watcher?.close();
    for (const t of this.diskTimers.values()) clearTimeout(t);
    this.diskTimers.clear();
    // Flush pending doc→disk writes so no acknowledged edit is lost.
    const pending = [...this.docTimers.keys()];
    for (const t of this.docTimers.values()) clearTimeout(t);
    this.docTimers.clear();
    for (const rel of pending) await this.writeDocToDisk(rel);
  }

  // ── sync-state helpers ───────────────────────────────────────────────────

  /** Subscribe-then-check: sync may already be done when we're called. */
  private waitSynced(): Promise<void> {
    return new Promise((resolve) => {
      const off = this.provider.onSynced((synced) => {
        if (synced) {
          off();
          resolve();
        }
      });
      if (this.provider.synced) {
        off();
        resolve();
      }
    });
  }

  /** Initial reconciliation between the room and the directory. */
  private async reconcile(): Promise<void> {
    const disk = await walkTextFiles(this.dir);

    // CRDT wins for known paths.
    for (const [rel, ytext] of this.files.entries()) {
      const want = ytext.toString();
      if (disk.get(rel) !== want) {
        await this.writeToDisk(rel, want);
        this.log("reconcile: doc → disk", { rel });
      }
    }

    // Disk-only files are imported into the room.
    const toImport = [...disk].filter(([rel]) => !this.files.has(rel));
    if (toImport.length > 0) {
      this.provider.doc.transact(() => {
        for (const [rel, content] of toImport) {
          this.files.set(rel, new Y.Text(content));
        }
      }, ORIGIN);
      this.log("reconcile: imported from disk", { count: toImport.length });
    }
  }

  // ── doc → disk ───────────────────────────────────────────────────────────

  private onDocEvents = (events: Y.YEvent<Y.Text | Y.Map<Y.Text>>[], txn: Y.Transaction): void => {
    if (txn.origin === ORIGIN || this.stopped) return;
    const changed = new Set<string>();
    for (const event of events) {
      if (event.target === (this.files as unknown)) {
        for (const [key, change] of event.changes.keys) {
          if (change.action === "delete") void this.deleteFromDisk(key);
          else changed.add(key);
        }
      } else {
        const key = event.path[0];
        if (typeof key === "string") changed.add(key);
      }
    }
    for (const rel of changed) this.scheduleDocToDisk(rel);
  };

  private scheduleDocToDisk(rel: string): void {
    clearTimeout(this.docTimers.get(rel));
    this.docTimers.set(
      rel,
      setTimeout(() => {
        this.docTimers.delete(rel);
        void this.writeDocToDisk(rel);
      }, this.debounceMs),
    );
  }

  private async writeDocToDisk(rel: string): Promise<void> {
    const ytext = this.files.get(rel);
    if (!ytext) return;
    await this.writeToDisk(rel, ytext.toString());
  }

  private async writeToDisk(rel: string, content: string): Promise<void> {
    try {
      const abs = resolveInside(this.dir, rel);
      this.selfWrites.set(rel, sha256(content));
      await atomicWrite(abs, content);
    } catch (err) {
      this.log("write failed", { rel, err: String(err) });
    }
  }

  private async deleteFromDisk(rel: string): Promise<void> {
    try {
      const abs = resolveInside(this.dir, rel);
      await fs.rm(abs, { force: true });
      this.selfWrites.delete(rel);
      this.log("deleted from disk", { rel });
    } catch (err) {
      this.log("delete failed", { rel, err: String(err) });
    }
  }

  // ── disk → doc ───────────────────────────────────────────────────────────

  private onFsEvent(filename: string): void {
    if (this.stopped) return;
    const rel = filename.split(path.sep).join("/");
    if (isIgnored(rel)) return;
    clearTimeout(this.diskTimers.get(rel));
    this.diskTimers.set(
      rel,
      setTimeout(() => {
        this.diskTimers.delete(rel);
        void this.syncFromDisk(rel);
      }, this.debounceMs),
    );
  }

  private async syncFromDisk(rel: string): Promise<void> {
    if (this.stopped) return;
    let buf: Buffer;
    try {
      const abs = resolveInside(this.dir, rel);
      const stat = await fs.stat(abs);
      if (stat.isDirectory() || stat.size > MAX_FILE_BYTES) return;
      buf = await fs.readFile(abs);
    } catch {
      return; // deleted/renamed/unreadable — disk deletions not propagated in v0
    }
    if (looksBinary(buf)) return;
    const content = buf.toString("utf8");

    const selfHash = this.selfWrites.get(rel);
    if (selfHash === sha256(content)) {
      this.selfWrites.delete(rel);
      return; // our own write echoing back through the watcher
    }

    const ytext = this.files.get(rel);
    this.provider.doc.transact(() => {
      if (!ytext) {
        this.files.set(rel, new Y.Text(content));
      } else {
        applyTextDiff(ytext, content);
      }
    }, ORIGIN);
    this.log("disk → doc", { rel, bytes: content.length });
  }
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}
