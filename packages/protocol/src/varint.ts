/**
 * Unsigned LEB128 varint, capped at 32 bits (payload lengths).
 * Must stay byte-identical with the Go implementation in
 * services/collab-relay/internal/wsproto — both are pinned by
 * fixtures/frames.json golden vectors.
 */

export function writeVarUint(out: number[], value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(`varint out of range: ${value}`);
  }
  let v = value;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
}

export function readVarUint(
  buf: Uint8Array,
  offset: number,
): { value: number; bytesRead: number } {
  let value = 0;
  let shiftMul = 1;
  let bytesRead = 0;
  for (;;) {
    if (offset + bytesRead >= buf.length) {
      throw new RangeError("varint: unexpected end of buffer");
    }
    const byte = buf[offset + bytesRead]!;
    bytesRead++;
    value += (byte & 0x7f) * shiftMul;
    if ((byte & 0x80) === 0) break;
    shiftMul *= 128;
    if (bytesRead > 5) {
      throw new RangeError("varint: too long (max 5 bytes / 32 bits)");
    }
  }
  if (value > 0xffffffff) {
    throw new RangeError(`varint: value out of range: ${value}`);
  }
  return { value, bytesRead };
}
