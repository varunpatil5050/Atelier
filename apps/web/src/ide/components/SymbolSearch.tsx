"use client";

import { useEffect, useState } from "react";
import {
  getReferences,
  intelReachable,
  searchSymbols,
  type Refs,
  type SymbolHit,
} from "../intel";

/**
 * Sidebar symbol search + find-references, backed by the indexer service.
 * Renders nothing when the indexer isn't running — intelligence is an optional
 * plane (doc 09 §8: degraded modes are designed, not discovered).
 *
 * Clicking a symbol navigates to its definition and loads its callers (a
 * 1-hop blast radius, doc 06 §8); clicking a caller navigates there.
 */
export default function SymbolSearch({
  onOpen,
}: {
  onOpen: (path: string, line: number) => void;
}) {
  const [available, setAvailable] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SymbolHit[]>([]);
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
      return;
    }
    const timer = setTimeout(() => {
      searchSymbols(q.trim())
        .then(setHits)
        .catch(() => setHits([]));
    }, 150);
    return () => clearTimeout(timer);
  }, [q, available]);

  const pickSymbol = (h: SymbolHit) => {
    onOpen(h.path, h.line);
    setFocused(h.name);
    setRefs(null);
    getReferences(h.name)
      .then(setRefs)
      .catch(() => setRefs(null));
  };

  if (!available) return null;

  return (
    <div className="symbol-search">
      <div className="sidebar-head">
        <span>Symbols</span>
      </div>
      <input
        className="symbol-input"
        placeholder="search symbols…"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setFocused(null);
          setRefs(null);
        }}
        spellCheck={false}
      />
      {hits.length > 0 && (
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

      {focused && refs && (
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
