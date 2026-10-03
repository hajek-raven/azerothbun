/** `Base32` over `GenericBaseEncoding` (`BaseEncoding.h`, `Base32.cpp`). */
const BITS_PER_CHAR = 5;
const PADDING = "=";
const DECODE_ERROR = 0xff;

function encodeChar(v: number): string {
  return v < 26 ? String.fromCharCode(0x41 + v) : String.fromCharCode(0x32 + (v - 26));
}

function decodeChar(c: string): number {
  if (c === "0") return decodeChar("O");
  if (c === "1") return decodeChar("l");
  if (c === "8") return decodeChar("B");
  const v = c.charCodeAt(0);
  if (v >= 0x41 && v <= 0x5a) return v - 0x41;
  if (v >= 0x61 && v <= 0x7a) return v - 0x61;
  if (v >= 0x32 && v <= 0x37) return v - 0x32 + 26;
  return DECODE_ERROR;
}

export const Base32 = {
  /** @ac common/Encoding/BaseEncoding.h GenericBaseEncoding::Encode */
  Encode(data: Uint8Array): string {
    if (data.length === 0) return "";
    let s = "";
    let i = 0;
    let bitsLeft = 8;
    do {
      let thisC = 0;
      const byte = data[i]!;
      if (bitsLeft >= BITS_PER_CHAR) {
        bitsLeft -= BITS_PER_CHAR;
        thisC = (byte >> bitsLeft) & ((1 << BITS_PER_CHAR) - 1);
        if (!bitsLeft) {
          ++i;
          bitsLeft = 8;
        }
      } else {
        thisC = ((byte & ((1 << bitsLeft) - 1)) << (BITS_PER_CHAR - bitsLeft)) & 0xff;
        bitsLeft += 8 - BITS_PER_CHAR;
        if (++i !== data.length) thisC |= data[i]! >> bitsLeft;
      }
      s += encodeChar(thisC);
    } while (i !== data.length);
    while (bitsLeft !== 8) {
      if (bitsLeft > BITS_PER_CHAR) bitsLeft -= BITS_PER_CHAR;
      else bitsLeft += 8 - BITS_PER_CHAR;
      s += PADDING;
    }
    return s;
  },

  /** @ac common/Encoding/BaseEncoding.h GenericBaseEncoding::Decode */
  Decode(data: string): Uint8Array | null {
    if (data.length === 0) return new Uint8Array(0);
    const v: number[] = [];
    let currentByte = 0;
    let bitsLeft = 8;
    let i = 0;
    while (i < data.length && data[i] !== PADDING) {
      const cur = decodeChar(data[i++]!);
      if (cur === DECODE_ERROR) return null;
      if (bitsLeft > BITS_PER_CHAR) {
        bitsLeft -= BITS_PER_CHAR;
        currentByte |= (cur << bitsLeft) & 0xff;
      } else {
        bitsLeft = BITS_PER_CHAR - bitsLeft;
        currentByte |= cur >> bitsLeft;
        v.push(currentByte & 0xff);
        currentByte = cur & ((1 << bitsLeft) - 1);
        bitsLeft = 8 - bitsLeft;
        currentByte = (currentByte << bitsLeft) & 0xff;
      }
    }
    if (currentByte) return null;
    while (i < data.length && data[i] === PADDING && bitsLeft !== 8) {
      if (bitsLeft > BITS_PER_CHAR) bitsLeft -= BITS_PER_CHAR;
      else bitsLeft += 8 - BITS_PER_CHAR;
      ++i;
    }
    return i === data.length ? Uint8Array.from(v) : null;
  },
};
