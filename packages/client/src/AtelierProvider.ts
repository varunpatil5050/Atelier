import {
  Channel,
  Flag,
  decodeServerCtrl,
  encodeCtrl,
  type ClientCtrl,
  type ServerCtrl,
  type UserInfo,
} from "@atelier/protocol";
import * as Y from "yjs";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import type { WsConnection } from "./WsConnection.js";

const PING_INTERVAL_MS = 10_000;

export interface AtelierProviderOptions {
  /**
   * Supplies the auth token sent in each hello. Called once per (re)connect so
   * short-lived tokens stay fresh (blueprint doc 10 §6). Return undefined to
   * send no token (tokenless dev mode). May be async.
   */
  getToken?: () => Promise<string | undefined> | string | undefined;
  /** "host" connects as a workspace host; omit for a normal participant. */
  role?: "host";
}

/**
 * Yjs provider speaking the Atelier relay protocol.
 *
 * Sync model (v0, matches relay semantics — see collab-relay room.go):
 *  - hello → server replays its update log → sync_done
 *  - on sync_done we push our full doc state (covers offline edits and makes
 *    reconnect the same code path as initial connect; redundant content is
 *    harmless — Yjs updates are idempotent, the log compacts)
 *  - steady state: incremental updates both directions
 *  - compact_request → reply with full state, FlagCompact
 */
export class AtelierProvider {
  readonly doc = new Y.Doc();
  readonly awareness = new Awareness(this.doc);

  synced = false;
  latencyMs: number | null = null;
  /** Whether a workspace host (PTY provider) is attached to the room. */
  hostOnline = false;

  private readonly syncedHandlers = new Set<(synced: boolean) => void>();
  private readonly latencyHandlers = new Set<(ms: number) => void>();
  private readonly ctrlHandlers = new Set<(msg: ServerCtrl) => void>();
  private readonly ptyHandlers = new Set<(streamId: number, payload: Uint8Array) => void>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;

  constructor(
    private readonly conn: WsConnection,
    private readonly room: string,
    private readonly user: UserInfo,
    private readonly opts: AtelierProviderOptions = {},
  ) {
    conn.onChannel(Channel.CTRL, (f) => this.onCtrlFrame(f.payload));
    conn.onChannel(Channel.CRDT, (f) => this.onCrdt(f.payload));
    conn.onChannel(Channel.AWARE, (f) => this.onAware(f.payload));
    conn.onChannel(Channel.PTY, (f) => {
      if (this.destroyed) return;
      for (const h of this.ptyHandlers) h(f.streamId, f.payload);
    });
    conn.onOpen(() => void this.sendHello());

    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === this) return; // remote echo
      this.conn.send({ channel: Channel.CRDT, flags: 0, streamId: 0, payload: update });
    });

    this.awareness.on(
      "update",
      (
        changes: { added: number[]; updated: number[]; removed: number[] },
        origin: unknown,
      ) => {
        if (origin === "remote") return;
        const changed = [...changes.added, ...changes.updated, ...changes.removed];
        this.conn.send({
          channel: Channel.AWARE,
          flags: 0,
          streamId: 0,
          payload: encodeAwarenessUpdate(this.awareness, changed),
        });
      },
    );

    this.pingTimer = setInterval(() => {
      this.conn.send({
        channel: Channel.CTRL,
        flags: 0,
        streamId: 0,
        payload: encodeCtrl({ type: "ping", t: Date.now() }),
      });
    }, PING_INTERVAL_MS);
  }

  onSynced(handler: (synced: boolean) => void): () => void {
    this.syncedHandlers.add(handler);
    return () => this.syncedHandlers.delete(handler);
  }

  onLatency(handler: (ms: number) => void): () => void {
    this.latencyHandlers.add(handler);
    return () => this.latencyHandlers.delete(handler);
  }

  /** Subscribe to every server CTRL message (host_status, pty_exit, …). */
  onCtrl(handler: (msg: ServerCtrl) => void): () => void {
    this.ctrlHandlers.add(handler);
    return () => this.ctrlHandlers.delete(handler);
  }

  onPty(handler: (streamId: number, payload: Uint8Array) => void): () => void {
    this.ptyHandlers.add(handler);
    return () => this.ptyHandlers.delete(handler);
  }

  sendCtrl(msg: ClientCtrl): void {
    this.conn.send({ channel: Channel.CTRL, flags: 0, streamId: 0, payload: encodeCtrl(msg) });
  }

  sendPty(streamId: number, data: Uint8Array): void {
    this.conn.send({ channel: Channel.PTY, flags: 0, streamId, payload: data });
  }

  destroy(): void {
    this.destroyed = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    removeAwarenessStates(this.awareness, [this.doc.clientID], "destroy");
    this.awareness.destroy();
    this.conn.close();
    this.doc.destroy();
  }

  private async sendHello(): Promise<void> {
    this.setSynced(false);
    let token: string | undefined;
    try {
      token = await this.opts.getToken?.();
    } catch (err) {
      console.error("[atelier] token fetch failed; connecting without token", err);
    }
    if (this.destroyed || this.conn.status !== "open") return;
    this.conn.send({
      channel: Channel.CTRL,
      flags: 0,
      streamId: 0,
      payload: encodeCtrl({
        type: "hello",
        v: 1,
        room: this.room,
        user: this.user,
        ...(this.opts.role ? { role: this.opts.role } : {}),
        ...(token ? { token } : {}),
      }),
    });
  }

  private onCtrlFrame(payload: Uint8Array): void {
    if (this.destroyed) return;
    const msg = decodeServerCtrl(payload);
    switch (msg.type) {
      case "host_status":
        this.hostOnline = msg.online;
        break;
      case "sync_done": {
        // Push our full state: no-op on a fresh doc, recovers offline edits
        // on reconnect.
        this.conn.send({
          channel: Channel.CRDT,
          flags: 0,
          streamId: 0,
          payload: Y.encodeStateAsUpdate(this.doc),
        });
        // Re-announce presence. Double-set bumps our awareness clock past any
        // removal the relay synthesized for our previous connection (equal
        // clocks lose to removals in y-protocols).
        const state = this.awareness.getLocalState();
        this.awareness.setLocalState(state);
        this.awareness.setLocalState(state);
        this.setSynced(true);
        break;
      }
      case "compact_request":
        this.conn.send({
          channel: Channel.CRDT,
          flags: Flag.Compact,
          streamId: 0,
          payload: Y.encodeStateAsUpdate(this.doc),
        });
        break;
      case "pong": {
        this.latencyMs = Date.now() - msg.t;
        for (const h of this.latencyHandlers) h(this.latencyMs);
        break;
      }
      case "error":
        console.error(`[relay] ${msg.code}: ${msg.msg}`);
        break;
      case "welcome":
      case "peer_joined":
      case "peer_left":
      case "pty_exit":
        break; // handled by ctrl subscribers below
    }
    for (const h of this.ctrlHandlers) h(msg);
  }

  private onCrdt(payload: Uint8Array): void {
    if (this.destroyed) return;
    Y.applyUpdate(this.doc, payload, this);
  }

  private onAware(payload: Uint8Array): void {
    if (this.destroyed) return;
    applyAwarenessUpdate(this.awareness, payload, "remote");
  }

  private setSynced(v: boolean): void {
    if (this.synced === v) return;
    this.synced = v;
    for (const h of this.syncedHandlers) h(v);
  }
}
