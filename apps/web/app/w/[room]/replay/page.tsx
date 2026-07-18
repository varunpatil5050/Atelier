"use client";

import dynamic from "next/dynamic";
import { use } from "react";

// Client-only island: Monaco + Yjs reconstruction have no SSR story.
const ReplayPlayer = dynamic(() => import("@/src/ide/replay/ReplayPlayer"), {
  ssr: false,
  loading: () => <div className="replay-empty">loading replay…</div>,
});

export default function ReplayPage({
  params,
}: {
  params: Promise<{ room: string }>;
}) {
  const { room } = use(params);
  return <ReplayPlayer room={room} />;
}
