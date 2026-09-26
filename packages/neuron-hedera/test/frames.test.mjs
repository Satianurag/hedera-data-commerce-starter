import assert from "node:assert/strict";
import test from "node:test";
import { ModeSFramer } from "../dist/index.js";

// Real DF17 example from the pyModeS reference documentation:
// https://github.com/junzis/pyModeS/blob/main/docs/quickstart.md
const adsb = Buffer.from("8D406B902015A678D4D220AA4BDA", "hex");

test("binary Mode-S framing survives arbitrary transport read boundaries", () => {
  const framer = new ModeSFramer();
  assert.deepEqual(framer.push(adsb.subarray(0, 4)), []);
  assert.equal(framer.pendingBytes, 4);
  const frames = framer.push(adsb.subarray(4));
  assert.equal(frames.length, 1);
  assert.deepEqual(Buffer.from(frames[0].bytes), adsb);
  assert.equal(frames[0].downlinkFormat, 17);
  assert.equal(frames[0].icao24, "406B90");
  assert.equal(frames[0].crcValid, true);
  assert.equal(framer.pendingBytes, 0);
});

test("concatenated short and long frames retain exact byte sequence", () => {
  const framer = new ModeSFramer();
  const short = Buffer.from("5D484FDEA248F5", "hex");
  const joined = Buffer.concat([short, adsb, adsb.subarray(0, 6)]);
  const frames = framer.push(joined);
  assert.deepEqual(frames.map(frame => Buffer.from(frame.bytes).toString("hex")), [short.toString("hex"), adsb.toString("hex")]);
  assert.equal(frames[0].downlinkFormat, 11);
  assert.equal(frames[0].crcValid, null);
  assert.equal(framer.pendingBytes, 6);
  framer.reset();
  assert.equal(framer.pendingBytes, 0);
});

test("changed data cannot be presented as CRC-valid DF17", () => {
  const broken = Buffer.from(adsb);
  broken[5] ^= 0x80;
  const frames = new ModeSFramer().push(broken);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].crcValid, false);
});

test("oversized transport chunks are rejected before buffering", () => {
  const framer = new ModeSFramer();
  assert.throws(() => framer.push(new Uint8Array(1_048_577)), /exceeds/);
  assert.equal(framer.pendingBytes, 0);
});
