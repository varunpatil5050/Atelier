"use client";

import { useEffect, useRef, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { AtelierProvider } from "@atelier/client";

// v0: one shared terminal per room on stream 1. The protocol supports 65k
// streams; tabs come with the layout system.
const STREAM = 1;

export default function TerminalPane({
  provider,
  room,
}: {
  provider: AtelierProvider;
  room: string;
}) {
  const hostEl = useRef<HTMLDivElement | null>(null);
  const [hostOnline, setHostOnline] = useState(provider.hostOnline);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const openPtyRef = useRef<() => void>(() => {});

  useEffect(() => {
    let disposed = false;
    let term: Terminal | null = null;
    let resizeObserver: ResizeObserver | null = null;
    const offs: Array<() => void> = [];
    const opened = { current: false };

    void (async () => {
      const [{ Terminal: XTerm }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      if (disposed || !hostEl.current) return;

      term = new XTerm({
        fontSize: 12.5,
        fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
        cursorBlink: true,
        scrollback: 5000,
        theme: {
          background: "#0d0f13",
          foreground: "#d6dbe4",
          cursor: "#6d9eff",
          selectionBackground: "#2b3646",
        },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(hostEl.current);
      fit.fit();

      const openPty = () => {
        if (opened.current || !term) return;
        opened.current = true;
        setExitCode(null);
        fit.fit();
        provider.sendCtrl({ type: "pty_open", streamId: STREAM, cols: term.cols, rows: term.rows });
      };
      openPtyRef.current = openPty;

      const encoder = new TextEncoder();
      term.onData((data) => {
        if (opened.current) provider.sendPty(STREAM, encoder.encode(data));
      });

      offs.push(
        provider.onPty((streamId, payload) => {
          if (streamId === STREAM) term?.write(payload);
        }),
      );

      offs.push(
        provider.onCtrl((msg) => {
          if (msg.type === "host_status") {
            setHostOnline(msg.online);
            if (msg.online) {
              // (Re)attach: idempotent on the host — an existing shell is
              // just resized, a fresh host spawns a new one.
              opened.current = false;
              openPty();
            }
          } else if (msg.type === "pty_exit" && msg.streamId === STREAM) {
            opened.current = false;
            setExitCode(msg.code);
            term?.writeln(`\r\n\x1b[90m[shell exited (${msg.code}) — click here to restart]\x1b[0m`);
          }
        }),
      );

      if (provider.hostOnline) {
        setHostOnline(true);
        openPty();
      }

      resizeObserver = new ResizeObserver(() => {
        if (!term) return;
        fit.fit();
        if (opened.current) {
          provider.sendCtrl({ type: "pty_resize", streamId: STREAM, cols: term.cols, rows: term.rows });
        }
      });
      resizeObserver.observe(hostEl.current);
    })();

    return () => {
      disposed = true;
      for (const off of offs) off();
      resizeObserver?.disconnect();
      term?.dispose();
    };
  }, [provider]);

  return (
    <section className="terminal-pane">
      <header className="terminal-head">
        <span
          className="status-dot"
          style={{ background: hostOnline ? "var(--green)" : "var(--text-dim)" }}
        />
        <span>Terminal</span>
        {!hostOnline && (
          <code className="terminal-hint">
            no workspace host — run: go run ./services/workspace-host/cmd/workspace-host --room {room}
          </code>
        )}
      </header>
      <div
        className="terminal-body"
        ref={hostEl}
        onClick={() => {
          if (hostOnline && exitCode !== null) openPtyRef.current();
        }}
      />
    </section>
  );
}
