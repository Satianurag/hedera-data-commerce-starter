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

// Published identification vector, not product data:
// https://mode-s.org/1090mhz/content/ads-b/2-identification.html
const identification = Buffer.from("8D4840D6202CC371C32CE0576098", "hex");
const { decodeAircraftIdentification, AircraftObservations } = await import("../dist/index.js");

test("identification decodes the published callsign and strips trailing padding", () => {
  assert.equal(decodeAircraftIdentification(identification), "KLM1023");
  const changed = Buffer.from(identification);
  changed[5] ^= 1;
  assert.equal(decodeAircraftIdentification(changed), null);
  assert.equal(decodeAircraftIdentification(identification.subarray(0, 13)), null);
  assert.equal(decodeAircraftIdentification(Buffer.from("8D40621D58C382D690C8AC2863A7", "hex")), null);
});

test("observations reject forged metadata, bound capacity, and reset reconnect state", () => {
  const records = new AircraftObservations(1);
  const frame = new ModeSFramer().push(identification)[0];
  records.observe(frame, 1000);
  records.observe(frame, 2000);
  assert.deepEqual(records.snapshot()[0], { icao24: "4840D6", callsign: "KLM1023",
    callsignAt: 2000, lastSeenAt: 2000, validFrames: 2 });
  const corrupt = Buffer.from(identification); corrupt[5] ^= 1;
  records.observe({ ...frame, bytes: corrupt, crcValid: true }, 3000);
  records.observe(frame, 500);
  assert.equal(records.snapshot()[0].lastSeenAt, 2000);
  records.observe(new ModeSFramer().push(adsb)[0], 4000);
  assert.equal(records.snapshot().length, 1);
  assert.equal(records.snapshot()[0].icao24, "406B90");
  records.reset(); assert.deepEqual(records.snapshot(), []);
  assert.throws(() => new AircraftObservations(0));
});

test("non-identification valid data creates no invented callsign", () => {
  const records = new AircraftObservations();
  records.observe(new ModeSFramer().push(identification)[0], 1000);
  const position = new ModeSFramer().push(Buffer.from("8D40621D58C382D690C8AC2863A7", "hex"))[0];
  records.observe(position, 2000);
  assert.equal(records.snapshot()[0].callsign, null);
  assert.equal(records.snapshot()[1].callsignAt, 1000);
});

test("fresh transport cannot conceal stale or absent valid aircraft data", async () => {
  const { aircraftStreamStatus } = await import("../dist/index.js");
  assert.match(aircraftStreamStatus(1000, 1000, 0, 0), /Waiting/);
  assert.match(aircraftStreamStatus(17001, 1000, 0, 0), /Stale/);
  assert.match(aircraftStreamStatus(20000, 1000, 20000, 0), /no fresh CRC-valid/);
  assert.match(aircraftStreamStatus(20000, 1000, 20000, 2000), /no fresh CRC-valid/);
  assert.equal(aircraftStreamStatus(20000, 1000, 20000, 19000), "Streaming valid aircraft frames");
});
