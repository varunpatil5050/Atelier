"use client";

import dynamic from "next/dynamic";
import { use } from "react";

// The IDE is a client-only island: monaco + WebSocket + Yjs have no SSR story.
const Ide = dynamic(() => import("@/src/ide/components/Ide"), {
  ssr: false,
  loading: () => <div className="ide-loading">loading workspace…</div>,
});

export default function WorkspacePage({
  params,
}: {
  params: Promise<{ room: string }>;
}) {
  const { room } = use(params);
  return <Ide room={room} />;
}
