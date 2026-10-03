import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { bunzip2 } from "./mpq-bzip2.ts";
import {
  MPQ_FILE_COMPRESS,
  MPQ_FILE_DELETE_MARKER,
  MPQ_FILE_ENCRYPTED,
  MPQ_FILE_EXISTS,
  MPQ_FILE_FIX_KEY,
  MPQ_FILE_IMPLODE,
  MPQ_FILE_PATCH_FILE,
  MPQ_FILE_SECTOR_CRC,
  MPQ_FILE_SINGLE_UNIT,
  MpqArchive,
  MpqChain,
  MpqDescriptorSource,
  computeNameHashes,
  decompressSector,
  decryptBlock,
  encryptBlock,
  explode,
  hashString,
} from "./mpq.ts";

/** bzip2 -1 output of "MPQ bzip2 sector test. " x 40 (920 bytes). */
const BZIP2_TEXT = "QlpoMTFBWSZTWbagKN0AAIufgEABEAAAAmAAGiDcECAAcFMABNApVEP1QNPKcCeBOwnQmhPwmCeRPQnIn0TQmCbE4E0JsTBMEwTkTYmxP4u5IpwoSFtQFG6A";
const BZIP2_TEXT_PLAIN = "MPQ bzip2 sector test. ".repeat(40);

/** bzip2 -1 output of 700 bytes of (i * i) % 251, 300 zero bytes and "abcabcabcabc" (1012 bytes, runs and a multi-table block). */
const BZIP2_MIXED =
  "QlpoMTFBWSZTWeHZ4v0AAAR//+6m56yNomwU/jjvbz61e74IhUp8JCOOA18m6TsoYmooMAF4AEGmJgAAAAAAAAAAAAAAjCMAAAAINMTAAAAAAAAAAAAAABGEYAAAAG1VJqNB6j1NDNRptEeo9QPKaHpBk9AjBoh6jyanpPFPU9TMjTU8p6nhTan6TMVPyo7OxEnq0cRYqeE81R8sUvkFb5orrrol08g/JZxHtWYn5UNtXDUXAfUcIxhNAzVjjJpq0Sxk21cPuR1ANdRBgnnjwk9chUV0hqQuwNlI3TTGDumA9RJJJMWSSh6cJqnAbQ6ViaPiotQ418SgPzAYDCPDhWYUzplY0C0pgyPi0pw2PxwiLZU0/RkEpTiaUq6VhK0og4Y55iiWzLHSAR1vnItc2ioMEonrIGSuSisXzWP6QhhRhkpjKnHbLBILJllkwEI3j+GcrZhUUqqkNKQUFxjRBGzYIF4eJg9BbJgwZI4oY4QT8rdLpsq8R1TKJQKZVNxWV7i0Z42QU6Qi+ohZNguHpLx500NDJDGx6USkv8c4klgrm4MEYcOkYDNOIlp0fmccq+BVWkWzWP2mzGJZvHKRU0YxFL5QPmYf+LuSKcKEhw7PF+g=";
const BZIP2_MIXED_PLAIN = (() => {
  const out = new Uint8Array(700 + 300 + 12);
  for (let index = 0; index < 700; index++) {
    out[index] = (index * index) % 251;
  }
  out.set(new TextEncoder().encode("abcabcabcabc"), 1000);
  return out;
})();

function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0));
}

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

function pattern(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  let state = seed;
  for (let index = 0; index < length; index++) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    // compressible: long runs with occasional noise
    out[index] = (state >>> 28) < 3 ? (state >>> 16) & 0xff : (index >> 5) & 0xff;
  }
  return out;
}

/** Bit writer for PKWARE DCL streams (least significant bit first), enough to build literal and copy items. */
function implode(items: Array<{ literal: number } | { copy: number; distance: number }>): Uint8Array {
  const bytes: number[] = [0, 4];
  let acc = 0;
  let count = 0;
  const put = (value: number, bits: number): void => {
    for (let index = 0; index < bits; index++) {
      acc |= ((value >> index) & 1) << count;
      count++;
      if (count === 8) {
        bytes.push(acc);
        acc = 0;
        count = 0;
      }
    }
  };
  for (const item of items) {
    if ("literal" in item) {
      put(0, 1);
      put(item.literal, 8);
    } else {
      // only the two byte copy (length code index 0, distance code index 0) is needed by the fixtures
      expect(item.copy).toBe(2);
      put(1, 1);
      put(0x05, 3);
      put(0x03, 2);
      put(item.distance - 1, 2);
    }
  }
  put(1, 1);
  put(0x00, 7); // length code 15 ...
  put(0xff, 8); // ... with all extra bits set: end of stream
  put(0, 8);
  if (count > 0) {
    bytes.push(acc);
  }
  return Uint8Array.from(bytes);
}

type FileSpec = {
  name: string;
  data: Uint8Array;
  /** How each sector (or the single unit) is packed. `pack` returns the payload after the mask byte. */
  mode?: "stored" | "zlib" | "implode" | "custom";
  mask?: number;
  pack?: (plain: Uint8Array) => Uint8Array;
  single?: boolean;
  encrypted?: boolean;
  fixKey?: boolean;
  crc?: boolean;
  locale?: number;
  /** Extra flags OR-ed into the block flags (delete marker, patch file) and an explicit flags replacement. */
  extraFlags?: number;
  flags?: number;
  /** Writes this block offset instead of the real one. */
  offsetOverride?: number;
};

type BuildOptions = { version?: 1 | 2; sectorShift?: number; prefix?: number; hashSize?: number };

function baseName(name: string): string {
  return name.slice(name.lastIndexOf("\\") + 1);
}

function encryptCopy(bytes: Uint8Array, key: number): Uint8Array {
  const copy = bytes.slice();
  const words = new Uint32Array(copy.buffer, 0, copy.length >>> 2);
  encryptBlock(words, key);
  return copy;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** A minimal MPQ writer: header (v1 or v2), file data, encrypted hash table and block table. */
function buildMpq(files: FileSpec[], options: BuildOptions = {}): Uint8Array {
  const version = options.version ?? 2;
  const shift = options.sectorShift ?? 3;
  const sectorSize = 512 << shift;
  const prefix = options.prefix ?? 0;
  const headerSize = version === 2 ? 44 : 32;
  const dataParts: Uint8Array[] = [];
  let dataLength = headerSize;
  const blocks: Array<[number, number, number, number]> = [];

  for (const file of files) {
    const size = file.data.length;
    let flags = file.flags ?? MPQ_FILE_EXISTS;
    const offset = dataLength;
    let key = 0;
    if (file.encrypted) {
      flags |= MPQ_FILE_ENCRYPTED;
      key = hashString(baseName(file.name), 3);
      if (file.fixKey) {
        flags |= MPQ_FILE_FIX_KEY;
        key = ((key + offset) ^ size) >>> 0;
      }
    }
    const mode = file.mode ?? "stored";
    const packSector = (plain: Uint8Array): Uint8Array => {
      let packed: Uint8Array;
      if (mode === "zlib") {
        packed = concat([Uint8Array.of(0x02), new Uint8Array(deflateSync(plain))]);
      } else if (mode === "implode") {
        const items: Array<{ literal: number } | { copy: number; distance: number }> = [];
        for (let at = 0; at < plain.length; ) {
          if (at >= 2 && at + 1 < plain.length && plain[at] === plain[at - 2] && plain[at + 1] === plain[at - 1]) {
            items.push({ copy: 2, distance: 2 });
            at += 2;
          } else {
            items.push({ literal: plain[at]! });
            at++;
          }
        }
        packed = implode(items);
      } else if (mode === "custom") {
        packed = concat([Uint8Array.of(file.mask ?? 0x10), file.pack!(plain)]);
      } else {
        return plain;
      }
      return packed.length < plain.length ? packed : plain;
    };
    if (mode === "zlib" || mode === "custom") {
      flags |= MPQ_FILE_COMPRESS;
    } else if (mode === "implode") {
      flags |= MPQ_FILE_IMPLODE;
    }

    let body: Uint8Array;
    if (file.single) {
      flags |= MPQ_FILE_SINGLE_UNIT;
      body = packSector(file.data);
      if (file.encrypted) {
        body = encryptCopy(body, key);
      }
    } else if (mode === "stored") {
      body = file.data;
      if (file.encrypted) {
        body = concat(
          Array.from({ length: Math.ceil(size / sectorSize) }, (_, sector) =>
            encryptCopy(file.data.subarray(sector * sectorSize, (sector + 1) * sectorSize), (key + sector) >>> 0),
          ),
        );
        // encryptCopy leaves a trailing partial word untouched, so the layout is unchanged
      }
    } else {
      const sectorCount = Math.ceil(size / sectorSize);
      const sectors: Uint8Array[] = [];
      for (let sector = 0; sector < sectorCount; sector++) {
        let packed = packSector(file.data.subarray(sector * sectorSize, (sector + 1) * sectorSize));
        if (file.encrypted) {
          packed = encryptCopy(packed, (key + sector) >>> 0);
        }
        sectors.push(packed);
      }
      if (file.crc) {
        flags |= MPQ_FILE_SECTOR_CRC;
      }
      const tableWords = sectorCount + 1 + (file.crc ? 1 : 0);
      const table = new Uint32Array(tableWords);
      let at = tableWords * 4;
      for (let sector = 0; sector < sectorCount; sector++) {
        table[sector] = at;
        at += sectors[sector]!.length;
      }
      table[sectorCount] = at;
      if (file.crc) {
        table[sectorCount + 1] = at;
      }
      if (file.encrypted) {
        encryptBlock(table, (key - 1) >>> 0);
      }
      body = concat([new Uint8Array(table.buffer), ...sectors]);
    }
    flags |= file.extraFlags ?? 0;
    blocks.push([file.offsetOverride ?? offset, body.length, size, flags >>> 0]);
    dataParts.push(body);
    dataLength += body.length;
  }

  const hashSize = options.hashSize ?? 64;
  const hashWords = new Uint32Array(hashSize * 4).fill(0xffffffff);
  files.forEach((file, blockIndex) => {
    const hashes = computeNameHashes(file.name, { index: 0, nameA: 0, nameB: 0 });
    let slot = hashes.index & (hashSize - 1);
    while (hashWords[slot * 4 + 3] !== 0xffffffff) {
      slot = (slot + 1) & (hashSize - 1);
    }
    hashWords[slot * 4] = hashes.nameA;
    hashWords[slot * 4 + 1] = hashes.nameB;
    hashWords[slot * 4 + 2] = file.locale ?? 0;
    hashWords[slot * 4 + 3] = blockIndex;
  });
  encryptBlock(hashWords, hashString("(hash table)", 3));
  const blockWords = new Uint32Array(blocks.length * 4);
  blocks.forEach((block, index) => blockWords.set(block, index * 4));
  encryptBlock(blockWords, hashString("(block table)", 3));

  const hashPos = dataLength;
  const blockPos = hashPos + hashWords.byteLength;
  const total = blockPos + blockWords.byteLength;
  const header = new Uint8Array(headerSize);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x1a51504d, true);
  view.setUint32(4, headerSize, true);
  view.setUint32(8, total, true);
  view.setUint16(12, version === 2 ? 1 : 0, true);
  view.setUint16(14, shift, true);
  view.setUint32(16, hashPos, true);
  view.setUint32(20, blockPos, true);
  view.setUint32(24, hashSize, true);
  view.setUint32(28, blocks.length, true);
  return concat([new Uint8Array(prefix), header, ...dataParts, new Uint8Array(hashWords.buffer), new Uint8Array(blockWords.buffer)]);
}

function open(files: FileSpec[], options?: BuildOptions): MpqArchive {
  return new MpqArchive("fixture.mpq", buildMpq(files, options));
}

describe("name hash and cipher", () => {
  test("file keys of the two tables match the values every MPQ implementation uses", () => {
    expect(hashString("(hash table)", 3)).toBe(0xc3af3770);
    expect(hashString("(block table)", 3)).toBe(0xec83b3a3);
  });

  test("hashing ignores case and treats / as \\", () => {
    expect(hashString("World/Maps/Azeroth/Azeroth.wdt", 1)).toBe(hashString("WORLD\\maps\\AZEROTH\\azeroth.WDT", 1));
    expect(hashString("a", 0)).not.toBe(hashString("b", 0));
  });

  test("encryptBlock and decryptBlock are inverses", () => {
    const words = Uint32Array.from({ length: 64 }, (_, index) => Math.imul(index, 2654435761) >>> 0);
    const copy = words.slice();
    encryptBlock(words, 0x12345678);
    expect(words).not.toEqual(copy);
    decryptBlock(words, 0x12345678);
    expect(words).toEqual(copy);
  });
});

describe("bzip2", () => {
  test("decodes precomputed bzip2 streams", () => {
    expect(new TextDecoder().decode(bunzip2(fromBase64(BZIP2_TEXT), 920))).toBe(BZIP2_TEXT_PLAIN);
    expect(bunzip2(fromBase64(BZIP2_MIXED), 1012)).toEqual(BZIP2_MIXED_PLAIN);
  });

  test("rejects a truncated stream and a wrong signature", () => {
    expect(() => bunzip2(fromBase64(BZIP2_TEXT).subarray(0, 40), 920)).toThrow();
    expect(() => bunzip2(bytesOf("not bzip2 at all"), 10)).toThrow("bad stream signature");
  });

  test("fails when the stream is larger than the block table says", () => {
    expect(() => bunzip2(fromBase64(BZIP2_TEXT), 100)).toThrow("larger than expected");
  });
});

describe("explode", () => {
  test("decodes literals and a two byte copy", () => {
    const stream = implode([{ literal: 0x61 }, { literal: 0x62 }, { copy: 2, distance: 2 }, { literal: 0x21 }]);
    expect(new TextDecoder().decode(explode(stream, 5))).toBe("abab!");
  });
});

describe("sector decompression", () => {
  test("the first byte selects the algorithm and unknown masks name themselves", () => {
    const zlib = concat([Uint8Array.of(0x02), new Uint8Array(deflateSync(bytesOf("zlib payload zlib payload zlib payload")))]);
    expect(new TextDecoder().decode(decompressSector(zlib, 38))).toBe("zlib payload zlib payload zlib payload");
    const bzip = concat([Uint8Array.of(0x10), fromBase64(BZIP2_TEXT)]);
    expect(new TextDecoder().decode(decompressSector(bzip, 920))).toBe(BZIP2_TEXT_PLAIN);
    expect(() => decompressSector(Uint8Array.of(0x41, 1, 2, 3), 10)).toThrow("huffman+adpcm-mono");
    expect(() => decompressSector(Uint8Array.of(0x20, 1, 2, 3), 10)).toThrow("sparse");
  });
});

describe("MpqArchive", () => {
  const big = pattern(5000, 7);
  const medium = pattern(1300, 9);
  const small = bytesOf("tiny file");

  const files: FileSpec[] = [
    { name: "plain\\small.txt", data: small },
    { name: "plain\\big.bin", data: big },
    { name: "zlib\\big.bin", data: big, mode: "zlib" },
    { name: "zlib\\crc.bin", data: big, mode: "zlib", crc: true },
    { name: "zlib\\single.bin", data: medium, mode: "zlib", single: true },
    { name: "bzip2\\text.txt", data: bytesOf(BZIP2_TEXT_PLAIN), mode: "custom", mask: 0x10, pack: () => fromBase64(BZIP2_TEXT), single: true },
    { name: "bzip2\\mixed.bin", data: BZIP2_MIXED_PLAIN, mode: "custom", mask: 0x10, pack: () => fromBase64(BZIP2_MIXED) },
    { name: "implode\\copy.bin", data: bytesOf("ab".repeat(120) + "tail"), mode: "implode" },
    { name: "crypt\\plain.bin", data: big, encrypted: true },
    { name: "crypt\\fixed.bin", data: big, encrypted: true, fixKey: true },
    { name: "crypt\\zlib.bin", data: big, mode: "zlib", encrypted: true },
    { name: "crypt\\zlib-fixed.bin", data: big, mode: "zlib", encrypted: true, fixKey: true },
    { name: "crypt\\single.bin", data: medium, mode: "zlib", single: true, encrypted: true },
    { name: "empty.bin", data: new Uint8Array(0) },
    { name: "deleted\\marker.bin", data: Uint8Array.of(0), extraFlags: MPQ_FILE_DELETE_MARKER },
    { name: "deleted\\noexist.bin", data: small, flags: 0 },
    { name: "patched\\file.bin", data: small, extraFlags: MPQ_FILE_PATCH_FILE },
    { name: "huffman\\wave.wav", data: big, mode: "custom", mask: 0x41, pack: (plain) => plain.subarray(0, 100) },
  ];

  for (const version of [1, 2] as const) {
    describe(`header version ${version}`, () => {
      for (const shift of [0, 3]) {
        const archive = open(files, { version, sectorShift: shift });
        test(`sector size ${512 << shift}`, () => {
          expect(archive.sectorSize).toBe(512 << shift);
          expect(archive.formatVersion).toBe(version - 1);
          expect(archive.read("plain\\small.txt")).toEqual(small);
          expect(archive.read("plain\\big.bin")).toEqual(big);
          expect(archive.read("zlib\\big.bin")).toEqual(big);
          expect(archive.read("zlib\\crc.bin")).toEqual(big);
          expect(archive.read("zlib\\single.bin")).toEqual(medium);
          expect(archive.read("implode\\copy.bin")).toEqual(files[7]!.data);
          expect(archive.read("empty.bin")).toEqual(new Uint8Array(0));
        });

        test(`encrypted files, sector size ${512 << shift}`, () => {
          expect(archive.read("crypt\\plain.bin")).toEqual(big);
          expect(archive.read("crypt\\fixed.bin")).toEqual(big);
          expect(archive.read("crypt\\zlib.bin")).toEqual(big);
          expect(archive.read("crypt\\zlib-fixed.bin")).toEqual(big);
          expect(archive.read("crypt\\single.bin")).toEqual(medium);
        });
      }
    });
  }

  test("bzip2 files, single unit and multi sector table", () => {
    const archive = open(files);
    expect(new TextDecoder().decode(archive.read("bzip2\\text.txt")!)).toBe(BZIP2_TEXT_PLAIN);
    expect(archive.read("bzip2\\mixed.bin")).toEqual(BZIP2_MIXED_PLAIN);
  });

  test("lookup is case and separator blind and does not match other names", () => {
    const archive = open(files);
    expect(archive.has("PLAIN/SMALL.TXT")).toBe(true);
    expect(archive.read("Plain/Small.txt")).toEqual(small);
    expect(archive.has("plain\\small.txt2")).toBe(false);
    expect(archive.read("nothing\\here")).toBeNull();
    expect(archive.size("plain\\big.bin")).toBe(5000);
    expect(archive.size("nothing\\here")).toBeNull();
  });

  test("deleted blocks are hidden and patch files are refused with a clear error", () => {
    const archive = open(files);
    expect(archive.has("deleted\\marker.bin")).toBe(false);
    expect(archive.has("deleted\\noexist.bin")).toBe(false);
    expect(() => archive.read("patched\\file.bin")).toThrow("patch file");
  });

  test("unsupported compression names the mask", () => {
    expect(() => open(files).read("huffman\\wave.wav")).toThrow("huffman+adpcm-mono");
  });

  test("the archive may start at a 512 byte boundary after other data", () => {
    const archive = open(files, { prefix: 1024 });
    expect(archive.archiveOffset).toBe(1024);
    expect(archive.read("zlib\\big.bin")).toEqual(big);
    expect(archive.read("crypt\\fixed.bin")).toEqual(big);
  });

  test("listFiles reads the (listfile) entry", () => {
    const listing = "plain\\small.txt\r\nplain\\big.bin\r\n";
    const archive = open([...files, { name: "(listfile)", data: bytesOf(listing), mode: "zlib" }], { hashSize: 32 });
    expect(archive.listFiles()).toEqual(["plain\\small.txt", "plain\\big.bin"]);
  });

  test("a hash table that is full still terminates and finds files", () => {
    const names = Array.from({ length: 8 }, (_, index) => `full\\file${index}.bin`);
    const archive = open(names.map((name, index) => ({ name, data: bytesOf(`file ${index}`) })), { hashSize: 8 });
    names.forEach((name, index) => expect(new TextDecoder().decode(archive.read(name)!)).toBe(`file ${index}`));
    expect(archive.read("full\\absent.bin")).toBeNull();
  });

  test("a locale specific entry is found, the neutral one wins when both exist", () => {
    const archive = open([
      { name: "loc\\only.txt", data: bytesOf("german"), locale: 0x407 },
      { name: "loc\\both.txt", data: bytesOf("german"), locale: 0x407 },
      { name: "loc\\both.txt", data: bytesOf("neutral"), locale: 0 },
    ]);
    expect(new TextDecoder().decode(archive.read("loc\\only.txt")!)).toBe("german");
    expect(new TextDecoder().decode(archive.read("loc\\both.txt")!)).toBe("neutral");
  });

  test("a read-only archive file (which Bun.mmap cannot open) is read through positional reads", () => {
    const dir = mkdtempSync(join(tmpdir(), "mpq-test-"));
    try {
      const path = join(dir, "readonly.mpq");
      writeFileSync(path, buildMpq(files));
      chmodSync(path, 0o444);
      const archive = MpqArchive.openSync(path);
      expect(archive.read("zlib\\big.bin")).toEqual(big);
      expect(archive.read("crypt\\zlib-fixed.bin")).toEqual(big);
      expect(new TextDecoder().decode(archive.read("bzip2\\text.txt")!)).toBe(BZIP2_TEXT_PLAIN);
      expect(archive.read("nothing")).toBeNull();
      archive.close();
      const direct = new MpqArchive(path, new MpqDescriptorSource(path));
      expect(direct.read("plain\\big.bin")).toEqual(big);
      direct.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("not an MPQ and a truncated file are rejected", () => {
    expect(() => new MpqArchive("junk", new Uint8Array(4096))).toThrow("no MPQ header");
    const bytes = buildMpq(files);
    expect(() => new MpqArchive("cut", bytes.subarray(0, 200))).toThrow();
  });

  test("a block that lies outside the file is reported", () => {
    const archive = open([{ name: "x.bin", data: pattern(100, 1), offsetOverride: 1_000_000 }]);
    expect(() => archive.read("x.bin")).toThrow("lies outside the archive");
  });
});

describe("MpqChain", () => {
  const common = buildMpq([
    { name: "World\\Maps\\Test\\Test.wdt", data: bytesOf("MVER-old") },
    { name: "World\\Maps\\Test\\only-common.adt", data: pattern(9000, 3), mode: "zlib" },
    { name: "Doomed\\file.m2", data: bytesOf("will be deleted") },
    { name: "Creature\\Boar\\Boar.m2", data: bytesOf("boar") },
    { name: "(listfile)", data: bytesOf("World\\Maps\\Test\\Test.wdt\r\nWorld\\Maps\\Test\\only-common.adt\r\nDoomed\\file.m2\r\nCreature\\Boar\\Boar.m2\r\n"), mode: "zlib" },
  ]);
  const patch = buildMpq([
    { name: "World\\Maps\\Test\\Test.wdt", data: bytesOf("MVER-patched-version"), mode: "zlib" },
    { name: "Doomed\\file.m2", data: Uint8Array.of(0), extraFlags: MPQ_FILE_DELETE_MARKER },
    { name: "World\\wmo\\New\\house.wmo", data: bytesOf("wmo") },
    { name: "(listfile)", data: bytesOf("World\\Maps\\Test\\Test.wdt\r\nDoomed\\file.m2\r\nWorld\\wmo\\New\\house.wmo\r\n") },
  ]);
  const chain = MpqChain.fromArchives([new MpqArchive("common.mpq", common), new MpqArchive("patch.mpq", patch)]);

  test("the highest priority archive that has a file wins", () => {
    expect(new TextDecoder().decode(chain.read("World\\Maps\\Test\\Test.wdt")!)).toBe("MVER-patched-version");
    expect(chain.size("world/maps/test/test.wdt")).toBe(20);
    expect(chain.archiveOf("World\\Maps\\Test\\Test.wdt")!.path).toBe("patch.mpq");
    expect(chain.archiveOf("World\\Maps\\Test\\only-common.adt")!.path).toBe("common.mpq");
    expect(chain.read("World\\Maps\\Test\\only-common.adt")).toEqual(pattern(9000, 3));
  });

  test("a delete marker in a later archive hides the file of an earlier one", () => {
    expect(chain.archives[0]!.has("Doomed\\file.m2")).toBe(true);
    expect(chain.has("Doomed\\file.m2")).toBe(false);
    expect(chain.read("Doomed\\file.m2")).toBeNull();
    expect(chain.size("Doomed\\file.m2")).toBeNull();
  });

  test("missing files are null", () => {
    expect(chain.has("Nope\\nope.adt")).toBe(false);
    expect(chain.read("Nope\\nope.adt")).toBeNull();
  });

  test("list merges the (listfile) entries, drops deleted names and filters by pattern", () => {
    expect(chain.list()).toEqual([
      "Creature\\Boar\\Boar.m2",
      "World\\Maps\\Test\\only-common.adt",
      "World\\Maps\\Test\\Test.wdt",
      "World\\wmo\\New\\house.wmo",
    ]);
    expect(chain.list(/\.WMO$/)).toEqual(["World\\wmo\\New\\house.wmo"]);
    expect(chain.list(/^creature\/.*\.m2$/i)).toEqual([]);
    expect(chain.list(/^creature\\.*\.m2$/)).toEqual(["Creature\\Boar\\Boar.m2"]);
    expect(chain.list("world/maps/")).toEqual(["World\\Maps\\Test\\only-common.adt", "World\\Maps\\Test\\Test.wdt"]);
    expect(chain.list("nothing")).toEqual([]);
  });

  test("a global regexp does not skip matches between calls", () => {
    const pattern = /\.adt$|\.wdt$/g;
    expect(chain.list(pattern)).toHaveLength(2);
    expect(chain.list(pattern)).toHaveLength(2);
  });
});
