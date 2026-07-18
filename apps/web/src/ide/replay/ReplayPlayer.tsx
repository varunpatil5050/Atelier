"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type * as MonacoNs from "monaco-editor";
import {
  fetchTimeline,
  filesOf,
  presenceAt,
  reconstructAt,
  type TimelineEvent,
} from "./timeline";

type MonacoModule = typeof import("../editor/monacoSetup");

const SPEEDS = [0.5, 1, 2, 4, 8] as const;

/**
 * Session replay (blueprint doc 12): scrub through a room's recorded history,
 * rebuilding the document at each point. "Git + multiplayer replay" — every
 * keystroke and every agent edit is here, because it all flowed through the
 * CRDT the relay recorded.
 */
export default function ReplayPlayer({ room }: { room: string }) {
  const [events, setEvents] = useState<TimelineEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [idx, setIdx] = useState(0); // scrub position (event index)
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<number>(1);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [editorReady, setEditorReady] = useState(false);

  const editorHostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<MonacoNs.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<MonacoModule | null>(null);

  // Load the recorded timeline.
  useEffect(() => {
    let cancelled = false;
    fetchTimeline(room)
      .then((evs) => {
        if (cancelled) return;
        setEvents(evs);
        setIdx(evs.length > 0 ? evs.length - 1 : 0); // start at the end (final state)
      })
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [room]);

  // Mount a read-only Monaco.
  useEffect(() => {
    let disposed = false;
    let editor: MonacoNs.editor.IStandaloneCodeEditor | null = null;
    void import("../editor/monacoSetup").then((mod) => {
      if (disposed || !editorHostRef.current) return;
      editor = mod.monaco.editor.create(editorHostRef.current, {
        theme: "vs-dark",
        fontSize: 13,
        readOnly: true,
        automaticLayout: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        padding: { top: 8 },
      });
      editorRef.current = editor;
      monacoRef.current = mod;
      setEditorReady(true); // refs don't trigger effects; this state does
    });
    return () => {
      disposed = true;
      editor?.dispose();
      editorRef.current = null;
    };
  }, []);

  // Reconstruct doc state at the scrub position.
  const snapshot = useMemo(() => {
    if (!events) return { files: new Map<string, string>(), present: [] as ReturnType<typeof presenceAt> };
    const doc = reconstructAt(events, idx);
    const files = filesOf(doc);
    const present = presenceAt(events, idx);
    doc.destroy();
    return { files, present };
  }, [events, idx]);

  // Pick/keep an active file that exists at this point.
  useEffect(() => {
    const names = [...snapshot.files.keys()].sort();
    if (names.length === 0) return;
    if (!activeFile || !snapshot.files.has(activeFile)) {
      setActiveFile(names[0] ?? null);
    }
  }, [snapshot, activeFile]);

  // Render the active file into Monaco (read-only). Depends on editorReady so
  // it re-runs once Monaco has mounted (refs alone wouldn't re-trigger it).
  useEffect(() => {
    if (!editorReady) return;
    const mod = monacoRef.current;
    const editor = editorRef.current;
    if (!mod || !editor) return;
    const content = activeFile ? snapshot.files.get(activeFile) ?? "" : "";
    const lang = activeFile ? mod.languageForPath(activeFile) : "plaintext";
    const model = editor.getModel();
    if (model && model.getLanguageId() === lang) {
      if (model.getValue() !== content) model.setValue(content);
    } else {
      editor.setModel(mod.monaco.editor.createModel(content, lang));
    }
  }, [snapshot, activeFile, editorReady]);

  // Playback clock: advance one event at a time, paced by wall-clock gaps
  // between recorded events (scaled by speed, clamped so long idles fast-fwd).
  useEffect(() => {
    if (!playing || !events || idx >= events.length - 1) {
      if (playing && events && idx >= events.length - 1) setPlaying(false);
      return;
    }
    const cur = events[idx]!;
    const next = events[idx + 1]!;
    const gap = Math.min(Math.max(next.ts - cur.ts, 30), 1500) / speed;
    const timer = setTimeout(() => setIdx((i) => i + 1), gap);
    return () => clearTimeout(timer);
  }, [playing, idx, events, speed]);

  if (error) {
    return (
      <div className="replay-empty">
        <p>No timeline for this room.</p>
        <p className="replay-hint">{error}</p>
        <Link className="replay-back" href={`/w/${room}`}>
          ← back to the workspace
        </Link>
      </div>
    );
  }
  if (!events) return <div className="replay-empty">loading timeline…</div>;

  const total = events.length;
  const cur = events[idx];
  const elapsed = cur && events[0] ? cur.ts - events[0].ts : 0;
  const fileNames = [...snapshot.files.keys()].sort();

  return (
    <div className="replay">
      <header className="replay-topbar">
        <Link className="ide-logo" href={`/w/${room}`}>
          Atelier
        </Link>
        <span className="ide-room">/{room}</span>
        <span className="replay-badge">◷ replay</span>
        <div className="replay-presence">
          {snapshot.present.map((u) => (
            <span key={u.id} className="presence-chip" style={{ borderColor: u.color }}>
              <span className="presence-dot" style={{ background: u.color }} />
              {u.name}
            </span>
          ))}
        </div>
        <Link className="replay-back" href={`/w/${room}`}>
          exit replay
        </Link>
      </header>

      <div className="replay-body">
        <aside className="ide-sidebar">
          <div className="sidebar-head">
            <span>Files (at this point)</span>
          </div>
          <ul className="file-list">
            {fileNames.length === 0 && <li className="replay-nofiles">— empty —</li>}
            {fileNames.map((name) => (
              <li key={name}>
                <button
                  className={name === activeFile ? "file-item active" : "file-item"}
                  onClick={() => setActiveFile(name)}
                >
                  {name}
                </button>
              </li>
            ))}
          </ul>
        </aside>
        <main className="ide-editor" ref={editorHostRef} />
      </div>

      <footer className="replay-controls">
        <button
          className="replay-play"
          onClick={() => {
            if (idx >= total - 1) setIdx(0);
            setPlaying((p) => !p);
          }}
        >
          {playing ? "❚❚" : "▶"}
        </button>
        <div className="replay-scrub-wrap">
          <input
            className="replay-scrub"
            type="range"
            min={0}
            max={Math.max(total - 1, 0)}
            value={idx}
            onChange={(e) => {
              setPlaying(false);
              setIdx(Number(e.target.value));
            }}
          />
          <Heatbar events={events} idx={idx} />
        </div>
        <span className="replay-meta">
          {idx + 1}/{total} · {formatMs(elapsed)}
        </span>
        <div className="replay-speeds">
          {SPEEDS.map((s) => (
            <button
              key={s}
              className={s === speed ? "replay-speed active" : "replay-speed"}
              onClick={() => setSpeed(s)}
            >
              {s}×
            </button>
          ))}
        </div>
      </footer>
    </div>
  );
}

/** A little density strip under the scrubber: where the edits happened. */
function Heatbar({ events, idx }: { events: TimelineEvent[]; idx: number }) {
  const bins = 80;
  const counts = useMemo(() => {
    const arr = new Array(bins).fill(0);
    if (events.length <= 1) return arr;
    for (let i = 0; i < events.length; i++) {
      if (events[i]!.kind !== "crdt") continue;
      const b = Math.min(bins - 1, Math.floor((i / (events.length - 1)) * bins));
      arr[b]++;
    }
    return arr;
  }, [events]);
  const max = Math.max(1, ...counts);
  const playhead = events.length > 1 ? idx / (events.length - 1) : 0;
  return (
    <div className="replay-heatbar">
      {counts.map((c, i) => (
        <span key={i} className="heat-cell" style={{ opacity: 0.15 + 0.85 * (c / max) }} />
      ))}
      <span className="heat-playhead" style={{ left: `${playhead * 100}%` }} />
    </div>
  );
}

function formatMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}
