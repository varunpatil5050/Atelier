import { describe, expect, it } from "vitest";
import fixtures from "../fixtures/frames.json";
import { decodeFrame, decodeFrames, encodeFrame, type Frame } from "./frames.js";
import { readVarUint, writeVarUint } from "./varint.js";

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(buf: Uint8Array): string {
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

function expandPayload(repeatHex: string, count: number): Uint8Array {
  return hexToBytes(repeatHex.repeat(count));
}

describe("varint (LEB128)", () => {
  const cases: Array<[number, string]> = [
    [0, "00"],
    [1, "01"],
    [127, "7f"],
    [128, "8001"],
    [300, "ac02"],
    [16384, "808001"],
    [0xffffffff, "ffffffff0f"],
  ];
  for (const [value, hex] of cases) {
    it(`roundtrips ${value}`, () => {
      const out: number[] = [];
      writeVarUint(out, value);
      expect(bytesToHex(new Uint8Array(out))).toBe(hex);
      const { value: back, bytesRead } = readVarUint(new Uint8Array(out), 0);
      expect(back).toBe(value);
      expect(bytesRead).toBe(out.length);
    });
  }

  it("rejects negative and oversized values", () => {
    expect(() => writeVarUint([], -1)).toThrow(RangeError);
    expect(() => writeVarUint([], 2 ** 33)).toThrow(RangeError);
  });

  it("rejects truncated input", () => {
    expect(() => readVarUint(new Uint8Array([0x80]), 0)).toThrow(RangeError);
  });
});

describe("golden vectors (shared with Go)", () => {
  for (const v of fixtures.vectors) {
    it(v.name, () => {
      const payload = expandPayload(v.payloadRepeatHex, v.payloadRepeatCount);
      const frame: Frame = {
        channel: v.channel,
        flags: v.flags,
        streamId: v.streamId,
        payload,
      };
      const expectedWire = v.wireHeaderHex + v.payloadRepeatHex.repeat(v.payloadRepeatCount);

      expect(bytesToHex(encodeFrame(frame))).toBe(expectedWire);

      const { frame: decoded, bytesRead } = decodeFrame(hexToBytes(expectedWire));
      expect(bytesRead).toBe(expectedWire.length / 2);
      expect(decoded.channel).toBe(v.channel);
      expect(decoded.flags).toBe(v.flags);
      expect(decoded.streamId).toBe(v.streamId);
      expect(bytesToHex(decoded.payload)).toBe(
        v.payloadRepeatHex.repeat(v.payloadRepeatCount),
      );
    });
  }
});

describe("frame edge cases", () => {
  it("decodes batched frames back-to-back", () => {
    const a = encodeFrame({ channel: 1, flags: 0, streamId: 0, payload: new Uint8Array([1]) });
    const b = encodeFrame({ channel: 2, flags: 8, streamId: 9, payload: new Uint8Array([2, 3]) });
    const joined = new Uint8Array(a.length + b.length);
    joined.set(a);
    joined.set(b, a.length);

    const frames = decodeFrames(joined);
    expect(frames).toHaveLength(2);
    expect(frames[0]!.channel).toBe(1);
    expect(frames[1]!.streamId).toBe(9);
    expect(Array.from(frames[1]!.payload)).toEqual([2, 3]);
  });

  it("rejects truncated payload", () => {
    const full = encodeFrame({ channel: 1, flags: 0, streamId: 0, payload: new Uint8Array(10) });
    expect(() => decodeFrame(full.subarray(0, full.length - 1))).toThrow(RangeError);
  });

  it("rejects out-of-range header fields at encode time", () => {
    const p = new Uint8Array(0);
    expect(() => encodeFrame({ channel: 256, flags: 0, streamId: 0, payload: p })).toThrow();
    expect(() => encodeFrame({ channel: 1, flags: 0, streamId: 70000, payload: p })).toThrow();
  });
});
