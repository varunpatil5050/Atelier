"use client";

import { useEffect, useState } from "react";
import {
  getReferences,
  intelReachable,
  retrieve,
  searchSymbols,
  type Refs,
  type RetrievedChunk,
  type SymbolHit,
} from "../intel";

type Mode = "symbols" | "content";

/**
 * Sidebar intelligence panel backed by the indexer service. Renders nothing
 * when the indexer isn't running — intelligence is an optional plane (doc 09
 * §8: degraded modes are designed, not discovered).
 *
 * Two modes:
 *  - symbols: name search → definition + find-references (callers, doc 06 §8)
 *  - content: hybrid retrieval (semantic ⊕ lexical, doc 06 §6) — finds code by
 *    what it does, not just by symbol name.
 */
export default function SymbolSearch({
  onOpen,
}: {
  onOpen: (path: string, line: number) => void;
}) {
  const [available, setAvailable] = useState(false);
  const [mode, setMode] = useState<Mode>("symbols");
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SymbolHit[]>([]);
  const [chunks, setChunks] = useState<RetrievedChunk[]>([]);
  const [focused, setFocused] = useState<string | null>(null);
  const [refs, setRefs] = useState<Refs | null>(null);

  useEffect(() => {
    let cancelled = false;
    void intelReachable().then((ok) => {
      if (!cancelled) setAvailable(ok);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!available || q.trim() === "") {
      setHits([]);
      setChunks([]);
      return;
    }
    const query = q.trim();
    const timer = setTimeout(() => {
      if (mode === "symbols") {
        searchSymbols(query).then(setHits).catch(() => setHits([]));
      } else {
        retrieve(query).then(setChunks).catch(() => setChunks([]));
      }
    }, 150);
    return () => clearTimeout(timer);
  }, [q, mode, available]);

  const switchMode = (m: Mode) => {
    setMode(m);
    setFocused(null);
    setRefs(null);
  };

  const pickSymbol = (h: SymbolHit) => {
    onOpen(h.path, h.line);
    setFocused(h.name);
    setRefs(null);
    getReferences(h.name).then(setRefs).catch(() => setRefs(null));
  };

  if (!available) return null;

  return (
    <div className="symbol-search">
      <div className="sidebar-head">
        <span>Intelligence</span>
        <div className="intel-modes">
          <button
            className={mode === "symbols" ? "intel-mode active" : "intel-mode"}
            onClick={() => switchMode("symbols")}
          >
            symbols
          </button>
          <button
            className={mode === "content" ? "intel-mode active" : "intel-mode"}
            onClick={() => switchMode("content")}
          >
            content
          </button>
        </div>
      </div>
      <input
        className="symbol-input"
        placeholder={mode === "symbols" ? "search symbols…" : "search by content…"}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setFocused(null);
          setRefs(null);
        }}
        spellCheck={false}
      />

      {mode === "symbols" && hits.length > 0 && (
        <ul className="symbol-results">
          {hits.map((h, i) => (
            <li key={`${h.path}:${h.line}:${h.name}:${i}`}>
              <button
                className={h.name === focused ? "symbol-item focused" : "symbol-item"}
                onClick={() => pickSymbol(h)}
                title={h.preview}
              >
                <span className={`sym-kind sym-kind-${h.kind}`}>{h.kind}</span>
                <span className="sym-name">
                  {h.container ? `${h.container}.` : ""}
                  {h.name}
                </span>
                <span className="sym-loc">
                  {h.path.split("/").pop()}:{h.line}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {mode === "content" && chunks.length > 0 && (
        <ul className="symbol-results">
          {chunks.map((c, i) => (
            <li key={`${c.path}:${c.line}:${i}`}>
              <button
                className="symbol-item chunk-item"
                onClick={() => onOpen(c.path, c.line)}
                title={c.preview}
              >
                <span className="chunk-top">
                  <span className={`sym-kind sym-kind-${c.kind}`}>{c.kind}</span>
                  <span className="sym-name">{c.symbol ?? c.path.split("/").pop()}</span>
                  <span className="sym-loc">
                    {c.path.split("/").pop()}:{c.line}
                  </span>
                </span>
                <span className="chunk-bottom">
                  {c.why.map((w) => (
                    <span key={w} className={`why-badge why-${w}`}>
                      {w}
                    </span>
                  ))}
                  <span className="chunk-preview">{c.preview}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {mode === "symbols" && focused && refs && (
        <div className="refs-panel">
          <div className="refs-head">
            {refs.count === 0 ? (
              <span>
                no callers of <b>{focused}</b>
              </span>
            ) : (
              <span>
                <b>{focused}</b> — {refs.count} {refs.count === 1 ? "call" : "calls"} across{" "}
                {refs.files} {refs.files === 1 ? "file" : "files"}
                <span className="refs-confidence" title="name-based resolution">
                  {refs.confidence}
                </span>
              </span>
            )}
          </div>
          <ul className="refs-list">
            {refs.callers.map((r, i) => (
              <li key={`${r.path}:${r.line}:${i}`}>
                <button
                  className="refs-item"
                  onClick={() => onOpen(r.path, r.line)}
                  title={r.preview}
                >
                  <span className="refs-loc">
                    {r.path.split("/").pop()}:{r.line}
                  </span>
                  <span className="refs-in">{r.in_symbol ? `in ${r.in_symbol}` : "top-level"}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
