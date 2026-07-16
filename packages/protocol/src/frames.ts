import { readVarUint, writeVarUint } from "./varint.js";

/**
 * Wire format (one or more frames per WebSocket binary message):
 *
 *   [u8 channel][u8 flags][u16 streamId (big-endian)][varint payloadLen][payload]
 *
 * Mirrored by services/collab-relay/internal/wsproto (Go). Golden vectors in
 * fixtures/frames.json keep the two implementations in lockstep.
 */

export const Channel = {
  CTRL: 1,
  CRDT: 2,
  AWARE: 3,
  PTY: 4,
  EXEC: 5,
  LSP: 6,
  AGENT: 7,
  FS: 8,
} as const;
export type ChannelId = (typeof Channel)[keyof typeof Channel];

export const Flag = {
  Compressed: 0x01,
  Batch: 0x02,
  Trace: 0x04,
  /** CRDT payload is a full-state snapshot replacing the room log (compaction). */
  Compact: 0x08,
} as const;

export interface Frame {
  channel: number;
  flags: number;
  streamId: number;
  payload: Uint8Array;
}

const HEADER_FIXED = 4; // channel + flags + streamId

export function encodeFrame(f: Frame): Uint8Array {
  if (f.channel < 0 || f.channel > 0xff) throw new RangeError("bad channel");
  if (f.flags < 0 || f.flags > 0xff) throw new RangeError("bad flags");
  if (f.streamId < 0 || f.streamId > 0xffff) throw new RangeError("bad streamId");

  const lenBytes: number[] = [];
  writeVarUint(lenBytes, f.payload.length);

  const out = new Uint8Array(HEADER_FIXED + lenBytes.length + f.payload.length);
  out[0] = f.channel;
  out[1] = f.flags;
  out[2] = (f.streamId >> 8) & 0xff;
  out[3] = f.streamId & 0xff;
  out.set(lenBytes, HEADER_FIXED);
  out.set(f.payload, HEADER_FIXED + lenBytes.length);
  return out;
}

export function decodeFrame(
  buf: Uint8Array,
  offset = 0,
): { frame: Frame; bytesRead: number } {
  if (buf.length - offset < HEADER_FIXED + 1) {
    throw new RangeError("frame: buffer too short for header");
  }
  const channel = buf[offset]!;
  const flags = buf[offset + 1]!;
  const streamId = (buf[offset + 2]! << 8) | buf[offset + 3]!;
  const { value: payloadLen, bytesRead: varLen } = readVarUint(
    buf,
    offset + HEADER_FIXED,
  );
  const payloadStart = offset + HEADER_FIXED + varLen;
  if (buf.length < payloadStart + payloadLen) {
    throw new RangeError("frame: buffer too short for payload");
  }
  return {
    frame: {
      channel,
      flags,
      streamId,
      payload: buf.subarray(payloadStart, payloadStart + payloadLen),
    },
    bytesRead: HEADER_FIXED + varLen + payloadLen,
  };
}

/** Decode every frame in a message (frames may be batched back-to-back). */
export function decodeFrames(buf: Uint8Array): Frame[] {
  const frames: Frame[] = [];
  let offset = 0;
  while (offset < buf.length) {
    const { frame, bytesRead } = decodeFrame(buf, offset);
    frames.push(frame);
    offset += bytesRead;
  }
  return frames;
}
