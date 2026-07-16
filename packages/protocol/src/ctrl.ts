/**
 * CTRL channel messages. JSON payloads for v0 — the envelope stays binary, so
 * migrating CTRL to protobuf later changes only this file and its Go twin.
 */

export interface UserInfo {
  id: string;
  name: string;
  color: string;
}

export type ClientCtrl =
  | { type: "hello"; v: 1; room: string; user: UserInfo; role?: "host"; token?: string }
  | { type: "ping"; t: number }
  | { type: "pty_open"; streamId: number; cols: number; rows: number }
  | { type: "pty_resize"; streamId: number; cols: number; rows: number }
  | { type: "pty_close"; streamId: number };

export type ServerCtrl =
  | { type: "welcome"; clientId: string; room: string; logLen: number }
  | { type: "sync_done" }
  | { type: "pong"; t: number }
  | { type: "compact_request" }
  | { type: "peer_joined"; clientId: string; user: UserInfo }
  | { type: "peer_left"; clientId: string }
  | { type: "host_status"; online: boolean }
  | { type: "pty_exit"; streamId: number; code: number }
  | { type: "error"; code: string; msg: string };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeCtrl(msg: ClientCtrl | ServerCtrl): Uint8Array {
  return encoder.encode(JSON.stringify(msg));
}

export function decodeServerCtrl(payload: Uint8Array): ServerCtrl {
  const msg = JSON.parse(decoder.decode(payload)) as ServerCtrl;
  if (typeof msg !== "object" || msg === null || typeof msg.type !== "string") {
    throw new Error("ctrl: malformed message");
  }
  return msg;
}

export function decodeClientCtrl(payload: Uint8Array): ClientCtrl {
  const msg = JSON.parse(decoder.decode(payload)) as ClientCtrl;
  if (typeof msg !== "object" || msg === null || typeof msg.type !== "string") {
    throw new Error("ctrl: malformed message");
  }
  return msg;
}
