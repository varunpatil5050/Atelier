"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import * as Y from "yjs";
import type * as MonacoNs from "monaco-editor";
import type { UserInfo } from "@atelier/protocol";
import { WsConnection, type ConnStatus } from "@atelier/client";
import { AtelierProvider } from "@atelier/client";
import { resolveRoomAuth, relayWsUrl } from "../identity";
import { postRumSample } from "../coreApi";
import TerminalPane from "./TerminalPane";
import SymbolSearch from "./SymbolSearch";
import ProposalPanel from "./ProposalPanel";
import AgentActivity from "./AgentActivity";

type MonacoModule = typeof import("../editor/monacoSetup");

const SEED_FILE = "main.ts";
const SEED_CONTENT = `// Welcome to Atelier — a multiplayer workspace.
// Open this URL in another tab and type: every keystroke syncs live.

export function greet(name: string): string {
  return \`Hello, \${name}!\`;
}

console.log(greet("world"));
`;

interface Peer {
  clientId: number;
  user: UserInfo;
  isLocal: boolean;
}

export default function Ide({ room }: { room: string }) {
  const [provider, setProvider] = useState<AtelierProvider | null>(null);
  const [status, setStatus] = useState<ConnStatus>("connecting");
  const [synced, setSynced] = useState(false);
  const [latency, setLatency] = useState<number | null>(null);
  const [authed, setAuthed] = useState(false);
  const [fileNames, setFileNames] = useState<string[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [monacoMod, setMonacoMod] = useState<MonacoModule | null>(null);
  const [editorReady, setEditorReady] = useState(false);

  const editorHostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<MonacoNs.editor.IStandaloneCodeEditor | null>(null);
  const pendingRevealRef = useRef<{ path: string; line: number } | null>(null);

  // Open a symbol-search hit: switch files if needed, then reveal the line
  // (immediately when the file is already bound; via pendingRevealRef when
  // the binding effect must run first).
  const openSymbol = (path: string, line: number) => {
    if (path === active) {
      const editor = editorRef.current;
      if (editor) {
        editor.revealLineInCenter(line);
        editor.setPosition({ lineNumber: line, column: 1 });
        editor.focus();
      }
      return;
    }
    if (!fileNames.includes(path)) {
      console.warn(`[intel] ${path} not in the room's file map (not synced?)`);
      return;
    }
    pendingRevealRef.current = { path, line };
    setActive(path);
  };

  // ── provider lifecycle ─────────────────────────────────────────────────
  // Auth resolution is async (core-api session + room token), so the provider
  // is created after it resolves; a cancelled flag guards against unmount and
  // room changes racing the await.
  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | null = null;

    void (async () => {
      const auth = await resolveRoomAuth(room);
      if (cancelled) return;
      setAuthed(auth.authenticated);

      const conn = new WsConnection(relayWsUrl());
      const p = new AtelierProvider(conn, room, auth.user, {
        ...(auth.getToken ? { getToken: auth.getToken } : {}),
      });
      p.awareness.setLocalStateField("user", auth.user);

      const offStatus = conn.onStatus(setStatus);
      const offSynced = p.onSynced(setSynced);
      const offLatency = p.onLatency((ms) => {
        setLatency(ms);
        // RUM: every measured RTT becomes a sample (doc 10 §2). Session-gated
        // server-side, so only beacon when core-api authenticated us.
        if (auth.authenticated) postRumSample("ws_rtt", ms);
      });

      const awarenessChanged = () => {
        const entries: Peer[] = [];
        for (const [clientId, state] of p.awareness.getStates()) {
          const u = (state as { user?: UserInfo }).user;
          if (u) entries.push({ clientId, user: u, isLocal: clientId === p.doc.clientID });
        }
        entries.sort((a, b) => a.clientId - b.clientId);
        setPeers(entries);
      };
      p.awareness.on("change", awarenessChanged);
      awarenessChanged();

      conn.connect();
      setProvider(p);

      // Test/debug hook: the e2e harness reads doc state and injects chaos
      // (forced disconnects) through this. Not part of the public surface.
      (window as unknown as Record<string, unknown>).__atelier = { provider: p, conn };

      cleanup = () => {
        offStatus();
        offSynced();
        offLatency();
        p.awareness.off("change", awarenessChanged);
        p.destroy();
        delete (window as unknown as Record<string, unknown>).__atelier;
      };
    })();

    return () => {
      cancelled = true;
      cleanup?.();
      setProvider(null);
    };
  }, [room]);

  // ── shared file map ────────────────────────────────────────────────────
  useEffect(() => {
    if (!provider) return;
    const files = provider.doc.getMap<Y.Text>("files");

    const refresh = () => setFileNames([...files.keys()].sort());
    files.observe(refresh);
    refresh();

    // Seed an empty room once synced. Subscribe-then-check: sync may already
    // have completed before this effect ran (fast local connections), so the
    // event alone is not a reliable trigger. (Two simultaneous first-joiners
    // can both seed; Y.Map converges per-key — acceptable v0, noted in doc 03.)
    const seedIfEmpty = () => {
      if (files.size === 0) {
        provider.doc.transact(() => files.set(SEED_FILE, new Y.Text(SEED_CONTENT)));
      }
    };
    const offSynced = provider.onSynced((isSynced) => {
      if (isSynced) seedIfEmpty();
    });
    if (provider.synced) seedIfEmpty();

    return () => {
      files.unobserve(refresh);
      offSynced();
    };
  }, [provider]);

  useEffect(() => {
    if (active === null && fileNames.length > 0) setActive(fileNames[0] ?? null);
    if (active !== null && !fileNames.includes(active)) setActive(fileNames[0] ?? null);
  }, [fileNames, active]);

  // ── editor mount (client-only monaco bundle) ───────────────────────────
  useEffect(() => {
    let disposed = false;
    let editor: MonacoNs.editor.IStandaloneCodeEditor | null = null;
    void import("../editor/monacoSetup").then((mod) => {
      if (disposed || !editorHostRef.current) return;
      editor = mod.monaco.editor.create(editorHostRef.current, {
        theme: "vs-dark",
        fontSize: 13,
        automaticLayout: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        padding: { top: 8 },
      });
      editorRef.current = editor;
      setMonacoMod(mod);
      setEditorReady(true);
    });
    return () => {
      disposed = true;
      editor?.dispose();
      editorRef.current = null;
    };
  }, []);

  // ── bind active file: Y.Text ⇄ monaco model ────────────────────────────
  useEffect(() => {
    if (!provider || !monacoMod || !editorReady || !active || !synced) return;
    const editor = editorRef.current;
    if (!editor) return;

    const files = provider.doc.getMap<Y.Text>("files");
    const ytext = files.get(active);
    if (!ytext) return;

    const { monaco, MonacoBinding } = monacoMod;
    const uri = monaco.Uri.parse(`atelier://${room}/${active}`);
    let model = monaco.editor.getModel(uri);
    if (!model) {
      model = monaco.editor.createModel("", monacoMod.languageForPath(active), uri);
    }
    editor.setModel(model);
    const binding = new MonacoBinding(ytext, model, new Set([editor]), provider.awareness);

    // Symbol-search navigation: reveal the requested line once the target
    // file's binding is attached.
    const pending = pendingRevealRef.current;
    if (pending && pending.path === active) {
      pendingRevealRef.current = null;
      editor.revealLineInCenter(pending.line);
      editor.setPosition({ lineNumber: pending.line, column: 1 });
      editor.focus();
    }

    return () => binding.destroy();
  }, [provider, monacoMod, editorReady, active, synced, room]);

  // ── remote cursor styles from awareness ────────────────────────────────
  const cursorCss = useMemo(
    () =>
      peers
        .filter((p) => !p.isLocal)
        .map((p) => {
          const color = sanitizeColor(p.user.color);
          const name = p.user.name.replace(/[^\w -]/g, "").slice(0, 24);
          return `
.yRemoteSelection-${p.clientId} { background-color: ${color}44; }
.yRemoteSelectionHead-${p.clientId} {
  position: absolute; border-left: 2px solid ${color}; height: 100%;
}
.yRemoteSelectionHead-${p.clientId}::after {
  content: "${name}"; position: absolute; top: -1.2em; left: -2px;
  background: ${color}; color: #fff; font-size: 10px; line-height: 1.2;
  padding: 0 4px; border-radius: 2px; white-space: nowrap; pointer-events: none;
}`;
        })
        .join("\n"),
    [peers],
  );

  const addFile = () => {
    if (!provider) return;
    const name = window.prompt("File name (e.g. utils.ts):")?.trim();
    if (!name || !/^[\w.-]{1,64}$/.test(name)) return;
    const files = provider.doc.getMap<Y.Text>("files");
    if (!files.has(name)) {
      provider.doc.transact(() => files.set(name, new Y.Text("")));
    }
    setActive(name);
  };

  return (
    <div className="ide">
      <style>{cursorCss}</style>

      <header className="ide-topbar">
        <span className="ide-logo">Atelier</span>
        <span className="ide-room">/{room}</span>
        <span
          className="auth-badge"
          title={authed ? "Authenticated via core-api room token" : "Tokenless dev mode (core-api not reached)"}
        >
          {authed ? "🔒 signed" : "unsigned"}
        </span>
        <div className="ide-presence">
          {peers.map((p) => (
            <span
              key={p.clientId}
              className="presence-chip"
              style={{ borderColor: p.user.color }}
              title={p.isLocal ? `${p.user.name} (you)` : p.user.name}
            >
              <span className="presence-dot" style={{ background: p.user.color }} />
              {p.user.name}
              {p.isLocal ? " (you)" : ""}
            </span>
          ))}
        </div>
        <Link className="replay-link" href={`/w/${room}/replay`} title="Replay this session">
          ◷ replay
        </Link>
        <StatusPill status={status} synced={synced} latency={latency} />
      </header>

      <div className="ide-body">
        <aside className="ide-sidebar">
          <SymbolSearch onOpen={openSymbol} />
          <div className="sidebar-head">
            <span>Files</span>
            <button className="btn-icon" onClick={addFile} title="New file">
              +
            </button>
          </div>
          <ul className="file-list">
            {fileNames.map((name) => (
              <li key={name}>
                <button
                  className={name === active ? "file-item active" : "file-item"}
                  onClick={() => setActive(name)}
                >
                  {name}
                </button>
              </li>
            ))}
          </ul>
          {provider && <AgentActivity provider={provider} />}
        </aside>

        <div className="ide-main">
          <main className="ide-editor" ref={editorHostRef}>
            {!synced && <div className="editor-overlay">connecting to room…</div>}
          </main>
          {provider && <TerminalPane provider={provider} room={room} />}
          {provider && (
            <ProposalPanel
              provider={provider}
              deciderName={peers.find((p) => p.isLocal)?.user.name ?? "me"}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function StatusPill({
  status,
  synced,
  latency,
}: {
  status: ConnStatus;
  synced: boolean;
  latency: number | null;
}) {
  const label =
    status === "open" ? (synced ? "live" : "syncing") : status === "connecting" ? "connecting" : "offline";
  return (
    <span className={`status-pill status-${label}`}>
      <span className="status-dot" />
      {label}
      {label === "live" && latency !== null ? ` · ${latency}ms` : ""}
    </span>
  );
}

function sanitizeColor(c: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(c) ? c : "#888888";
}
