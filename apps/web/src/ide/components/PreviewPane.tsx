"use client";

import { useEffect, useRef, useState } from "react";
import { fetchPreviews, type Preview } from "../previewApi";

const POLL_MS = 2000;

/**
 * Live preview pane: polls the preview-router for the room's running dev
 * servers and embeds the selected one. A dev server started in the shared
 * terminal (e.g. `python3 -m http.server 3000`) appears here automatically —
 * the workspace-host detects the listening port and registers it.
 */
export default function PreviewPane({ room }: { room: string }) {
  const [previews, setPreviews] = useState<Preview[]>([]);
  const [activePort, setActivePort] = useState<number | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [collapsed, setCollapsed] = useState(false);

  // Poll the router; abort in-flight on unmount / room change.
  useEffect(() => {
    let stop = false;
    const ctrl = new AbortController();
    const tick = async () => {
      const list = await fetchPreviews(room, ctrl.signal);
      if (!stop) setPreviews(list);
    };
    void tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      stop = true;
      ctrl.abort();
      clearInterval(id);
    };
  }, [room]);

  // Keep a valid selection: default to the first preview, and follow along if
  // the selected port disappears.
  useEffect(() => {
    if (previews.length === 0) {
      if (activePort !== null) setActivePort(null);
      return;
    }
    if (activePort === null || !previews.some((p) => p.port === activePort)) {
      setActivePort(previews[0]!.port);
    }
  }, [previews, activePort]);

  const active = previews.find((p) => p.port === activePort) ?? null;

  if (previews.length === 0) {
    return (
      <div className="preview-pane preview-empty">
        <div className="preview-head">
          <span>Preview</span>
          <span className="preview-hint">
            no dev server detected — run one in the terminal (e.g. python3 -m http.server 3000)
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className={collapsed ? "preview-pane collapsed" : "preview-pane"}>
      <div className="preview-head">
        <span>Preview</span>
        {previews.length > 1 ? (
          <select
            className="preview-select"
            value={activePort ?? ""}
            onChange={(e) => setActivePort(Number(e.target.value))}
          >
            {previews.map((p) => (
              <option key={p.port} value={p.port}>
                {p.name ? `${p.name} · :${p.port}` : `:${p.port}`}
              </option>
            ))}
          </select>
        ) : (
          active && (
            <span className="preview-port">
              {active.name ? `${active.name} · :${active.port}` : `:${active.port}`}
            </span>
          )
        )}
        {active && (
          <a className="preview-url" href={active.url} target="_blank" rel="noreferrer" title="Open in a new tab (shareable URL)">
            {active.url.replace(/^https?:\/\//, "").replace(/\/$/, "")} ↗
          </a>
        )}
        <div className="preview-actions">
          <button className="btn-icon" title="Reload preview" onClick={() => setReloadNonce((n) => n + 1)}>
            ↻
          </button>
          <button className="btn-icon" title={collapsed ? "Expand" : "Collapse"} onClick={() => setCollapsed((c) => !c)}>
            {collapsed ? "▢" : "—"}
          </button>
        </div>
      </div>
      {!collapsed && active && (
        <iframe
          key={`${active.port}:${reloadNonce}`}
          className="preview-frame"
          src={active.url}
          title={`preview of ${active.name || `port ${active.port}`}`}
          sandbox="allow-scripts allow-forms allow-same-origin allow-popups"
        />
      )}
    </div>
  );
}
