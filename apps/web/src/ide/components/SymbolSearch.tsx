"use client";

import { useEffect, useState } from "react";
import { intelReachable, searchSymbols, type SymbolHit } from "../intel";

/**
 * Sidebar symbol search backed by the indexer service. Renders nothing when
 * the indexer isn't running — intelligence is an optional plane (doc 09 §8:
 * degraded modes are designed, not discovered).
 */
export default function SymbolSearch({
  onOpen,
}: {
  onOpen: (path: string, line: number) => void;
}) {
  const [available, setAvailable] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SymbolHit[]>([]);

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
        onChange={(e) => setQ(e.target.value)}
        spellCheck={false}
      />
      {hits.length > 0 && (
        <ul className="symbol-results">
          {hits.map((h, i) => (
            <li key={`${h.path}:${h.line}:${h.name}:${i}`}>
              <button
                className="symbol-item"
                onClick={() => onOpen(h.path, h.line)}
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
    </div>
  );
}
