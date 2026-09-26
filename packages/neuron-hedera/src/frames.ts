export type ModeSFrame = Readonly<{
  bytes: Uint8Array;
  downlinkFormat: number;
  icao24: string | null;
  crcValid: boolean | null;
}>;

const maxChunkBytes = 1_048_576;
const crcPolynomial = 0xfff409;

function crc24(bytes: Uint8Array): number {
  let remainder = 0;
  for (const byte of bytes) {
    for (let bit = 7; bit >= 0; bit--) {
      const top = remainder >>> 23;
      remainder = ((remainder << 1) & 0xffffff) | ((byte >>> bit) & 1);
      if (top) remainder ^= crcPolynomial;
    }
  }
  return remainder;
}

export class ModeSFramer {
  private pending = new Uint8Array(0);

  get pendingBytes(): number {
    return this.pending.length;
  }

  reset(): void {
    this.pending = new Uint8Array(0);
  }

  push(chunk: Uint8Array): ModeSFrame[] {
    if (!(chunk instanceof Uint8Array) || chunk.length > maxChunkBytes) {
      throw new Error(`Mode-S transport chunk exceeds ${maxChunkBytes} bytes or is not binary`);
    }
    if (chunk.length === 0) return [];
    const joined = new Uint8Array(this.pending.length + chunk.length);
    joined.set(this.pending);
    joined.set(chunk, this.pending.length);
    const frames: ModeSFrame[] = [];
    let offset = 0;
    while (offset < joined.length) {
      const downlinkFormat = joined[offset] >>> 3;
      const length = downlinkFormat < 16 ? 7 : 14;
      if (joined.length - offset < length) break;
      const bytes = joined.slice(offset, offset + length);
      const plainIcao = downlinkFormat === 17;
      frames.push({
        bytes,
        downlinkFormat,
        icao24: plainIcao ? Array.from(bytes.subarray(1, 4), byte => byte.toString(16).padStart(2, "0")).join("").toUpperCase() : null,
        crcValid: plainIcao ? crc24(bytes) === 0 : null,
      });
      offset += length;
    }
    this.pending = joined.slice(offset);
    return frames;
  }
}

export type AircraftObservation = Readonly<{
  icao24: string;
  callsign: string | null;
  callsignAt: number | null;
  lastSeenAt: number;
  validFrames: number;
}>;

// DF17 identification: type codes 1–4, eight six-bit characters in ME.
// https://mode-s.org/1090mhz/content/ads-b/2-identification.html
export function decodeAircraftIdentification(bytes: Uint8Array): string | null {
  if (bytes.length !== 14 || bytes[0] >>> 3 !== 17 || crc24(bytes) !== 0) return null;
  const typeCode = bytes[4] >>> 3;
  if (typeCode < 1 || typeCode > 4) return null;
  let callsign = "";
  for (let character = 0; character < 8; character++) {
    let code = 0;
    for (let bit = 0; bit < 6; bit++) {
      const position = 40 + character * 6 + bit;
      code = (code << 1) | ((bytes[position >>> 3] >>> (7 - position % 8)) & 1);
    }
    if (code >= 1 && code <= 26) callsign += String.fromCharCode(64 + code);
    else if (code >= 48 && code <= 57) callsign += String.fromCharCode(code);
    else if (code === 32) callsign += " ";
    else return null;
  }
  return callsign.trimEnd() || null;
}

export class AircraftObservations {
  private records = new Map<string, AircraftObservation>();
  constructor(private readonly capacity = 256) {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 4096) throw new Error("Invalid aircraft capacity");
  }
  reset(): void { this.records.clear(); }
  observe(frame: ModeSFrame, receivedAt: number): void {
    const bytes = frame.bytes;
    if (!Number.isFinite(receivedAt) || receivedAt < 0 || bytes.length !== 14 ||
        bytes[0] >>> 3 !== 17 || crc24(bytes) !== 0) return;
    const icao24 = Array.from(bytes.subarray(1, 4), byte => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
    const previous = this.records.get(icao24);
    if (previous && receivedAt < previous.lastSeenAt) return;
    const callsign = decodeAircraftIdentification(bytes);
    this.records.delete(icao24);
    if (this.records.size >= this.capacity) this.records.delete(this.records.keys().next().value!);
    this.records.set(icao24, { icao24, callsign: callsign ?? previous?.callsign ?? null,
      callsignAt: callsign ? receivedAt : previous?.callsignAt ?? null,
      lastSeenAt: receivedAt, validFrames: (previous?.validFrames ?? 0) + 1 });
  }
  snapshot(): AircraftObservation[] { return Array.from(this.records.values()).reverse(); }
}

export function aircraftStreamStatus(now: number, openedAt: number, lastByteAt: number, lastValidAt: number): string {
  if (now - (lastByteAt || openedAt) > 15_000) return "Stale: no bytes for 15 seconds";
  if (lastByteAt === 0) return "Waiting for seller bytes";
  if (lastValidAt === 0 || now - lastValidAt > 15_000) return "Bytes arriving; no fresh CRC-valid aircraft data";
  return "Streaming valid aircraft frames";
}
