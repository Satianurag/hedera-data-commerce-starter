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
