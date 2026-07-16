import { decodeFrames, encodeFrame, type Frame } from "@atelier/protocol";

export type ConnStatus = "connecting" | "open" | "closed";

const BACKOFF_BASE_MS = 200;
const BACKOFF_CAP_MS = 10_000;

/**
 * One WebSocket to the relay, multiplexing all channels (blueprint doc 03 §6).
 * Reconnects with decorrelated-jitter backoff; per-channel handlers; frames
 * sent while closed are dropped (the provider re-syncs full state on every
 * reconnect, so dropped CRDT frames are recovered by design).
 */
export class WsConnection {
  private ws: WebSocket | null = null;
  private readonly handlers = new Map<number, (f: Frame) => void>();
  private readonly openHandlers = new Set<() => void>();
  private readonly statusHandlers = new Set<(s: ConnStatus) => void>();
  private closedByUser = false;
  private prevDelay = BACKOFF_BASE_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  status: ConnStatus = "connecting";

  constructor(private readonly url: string) {}

  /** Register the handler for a channel. Last registration wins. */
  onChannel(channel: number, handler: (f: Frame) => void): void {
    this.handlers.set(channel, handler);
  }

  /** Fires on every successful (re)connect. */
  onOpen(handler: () => void): void {
    this.openHandlers.add(handler);
  }

  onStatus(handler: (s: ConnStatus) => void): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  connect(): void {
    this.closedByUser = false;
    this.dial();
  }

  /** Returns false if the socket isn't open (frame dropped). */
  send(frame: Frame): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(encodeFrame(frame));
    return true;
  }

  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.setStatus("closed");
  }

  /**
   * Chaos hook (e2e harness): sever the socket WITHOUT marking it
   * user-closed, exercising the real reconnect + re-sync path.
   */
  debugDrop(): void {
    this.ws?.close();
  }

  private dial(): void {
    this.setStatus("connecting");
    const ws = new WebSocket(this.url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      this.prevDelay = BACKOFF_BASE_MS;
      this.setStatus("open");
      for (const h of this.openHandlers) h();
    };

    ws.onmessage = (ev: MessageEvent) => {
      if (!(ev.data instanceof ArrayBuffer)) return;
      let frames: Frame[];
      try {
        frames = decodeFrames(new Uint8Array(ev.data));
      } catch (err) {
        console.error("[ws] malformed message", err);
        return;
      }
      for (const f of frames) this.handlers.get(f.channel)?.(f);
    };

    ws.onclose = () => {
      if (this.ws !== ws) return; // superseded by a newer dial
      this.setStatus("closed");
      if (!this.closedByUser) this.scheduleReconnect();
    };

    ws.onerror = () => ws.close();
  }

  private scheduleReconnect(): void {
    // Decorrelated jitter: delay ∈ [base, prev*3], capped.
    const delay = Math.min(
      BACKOFF_CAP_MS,
      BACKOFF_BASE_MS + Math.random() * (this.prevDelay * 3 - BACKOFF_BASE_MS),
    );
    this.prevDelay = delay;
    this.reconnectTimer = setTimeout(() => this.dial(), delay);
  }

  private setStatus(s: ConnStatus): void {
    if (this.status === s) return;
    this.status = s;
    for (const h of this.statusHandlers) h(s);
  }
}
