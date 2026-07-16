"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ensureSession, listWorkspaces, type Workspace } from "@/src/ide/coreApi";

const ROOM_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export default function Home() {
  const router = useRouter();
  const [room, setRoom] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [recents, setRecents] = useState<Workspace[]>([]);

  // Establish a session and show recent workspaces when core-api is reachable.
  // Silent no-op in tokenless mode.
  useEffect(() => {
    void (async () => {
      try {
        await ensureSession();
        setRecents(await listWorkspaces());
      } catch {
        // core-api not running — the quickstart still works without it
      }
    })();
  }, []);

  const join = (target: string) => {
    if (!ROOM_RE.test(target)) {
      setError("Room names: letters, digits, - or _ (max 64, must start alphanumeric).");
      return;
    }
    router.push(`/w/${target}`);
  };

  return (
    <main className="landing">
      <h1 className="landing-title">Atelier</h1>
      <p className="landing-sub">
        A multiplayer cloud workspace — humans and AI agents, one live session.
      </p>
      <form
        className="landing-form"
        onSubmit={(e) => {
          e.preventDefault();
          join(room.trim());
        }}
      >
        <input
          className="landing-input"
          placeholder="room name, e.g. demo"
          value={room}
          onChange={(e) => {
            setRoom(e.target.value);
            setError(null);
          }}
          autoFocus
        />
        <button className="landing-btn" type="submit">
          Join room
        </button>
        <button
          className="landing-btn secondary"
          type="button"
          onClick={() => join(`room-${Math.random().toString(36).slice(2, 8)}`)}
        >
          Random room
        </button>
      </form>
      {error && <p className="landing-error">{error}</p>}

      {recents.length > 0 && (
        <div className="landing-recents">
          <span className="landing-recents-label">Recent workspaces</span>
          <ul>
            {recents.map((ws) => (
              <li key={ws.id}>
                <button className="landing-recent" onClick={() => join(ws.slug)}>
                  {ws.slug}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="landing-hint">
        Open the same room in two tabs to see live multiplayer editing.
      </p>
    </main>
  );
}
