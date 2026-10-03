import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { MPQ_FILE_EXISTS, MPQ_FILE_PATCH_FILE, MPQ_FILE_SINGLE_UNIT, MpqArchive, MpqChain, MpqDescriptorSource } from "./mpq.ts";

/** Runs against a real 3.3.5a client (`WOW_CLIENT_DIR`, default `~/GAMES/ChromieCraft_3.3.5a`) and skips itself without one. */
const clientDir = process.env.WOW_CLIENT_DIR ?? join(homedir(), "GAMES", "ChromieCraft_3.3.5a");
const dataDir = existsSync(join(clientDir, "Data")) ? join(clientDir, "Data") : clientDir;
const present = existsSync(join(dataDir, "common.MPQ"));
const suite = present ? describe : describe.skip;

const magic = (bytes: Uint8Array): string => new TextDecoder().decode(bytes.subarray(0, 4));

suite("real client archives", () => {
  let chain: MpqChain;

  test("opens the whole chain by reading only headers and tables", async () => {
    const started = performance.now();
    chain = await MpqChain.open(dataDir);
    const elapsed = performance.now() - started;
    console.log(`opened ${chain.archives.length} archives (${chain.locale}) in ${elapsed.toFixed(0)} ms`);
    expect(chain.archives.length).toBeGreaterThanOrEqual(8);
    expect(elapsed).toBeLessThan(5000);
    expect(chain.archives[0]!.path.endsWith("common.MPQ")).toBe(true);
  });

  test("no block in any archive is a patch file (PTCH/BSD0 is not needed for this client)", () => {
    for (const archive of chain.archives) {
      for (let index = 0; index < archive.blockTableSize; index++) {
        const flags = archive.blockFlags(index);
        if (flags & MPQ_FILE_EXISTS) {
          expect(flags & MPQ_FILE_PATCH_FILE).toBe(0);
        }
      }
    }
  });

  test("DBFilesClient\\Map.dbc equals the extracted data/dbc/Map.dbc", async () => {
    const bytes = chain.read("DBFilesClient\\Map.dbc")!;
    expect(magic(bytes)).toBe("WDBC");
    expect(bytes.length).toBe(chain.size("DBFilesClient\\Map.dbc")!);
    const extracted = join(import.meta.dir, "..", "..", "data", "dbc", "Map.dbc");
    if (existsSync(extracted)) {
      expect(bytes).toEqual(new Uint8Array(await Bun.file(extracted).arrayBuffer()));
    }
  });

  test("Azeroth.wdt starts with the MVER chunk and has the block table's size", () => {
    const name = "World\\Maps\\Azeroth\\Azeroth.wdt";
    const bytes = chain.read(name)!;
    expect(magic(bytes)).toBe("REVM");
    expect(bytes.length).toBe(chain.size(name)!);
    expect(new DataView(bytes.buffer, bytes.byteOffset).getUint32(4, true)).toBe(4);
  });

  test("an Azeroth ADT near Northshire is readable", () => {
    let found: string | null = null;
    for (const [x, y] of [[32, 48], [32, 49], [31, 48], [32, 47], [33, 48]]) {
      const name = `World\\Maps\\Azeroth\\Azeroth_${x}_${y}.adt`;
      if (chain.has(name)) {
        found = name;
        break;
      }
    }
    expect(found).not.toBeNull();
    const bytes = chain.read(found!)!;
    expect(magic(bytes)).toBe("REVM");
    expect(bytes.length).toBe(chain.size(found!)!);
    // MVER chunk (8 byte header + version), then MHDR
    expect(magic(bytes.subarray(0x0c))).toBe("RDHM");
  });

  test("a WMO and an M2 from the listfiles", () => {
    const wmo = chain.list(/^world\\wmo\\azeroth\\buildings\\[^\\]+\\[^\\]+\.wmo$/)[0]!;
    expect(wmo).toBeDefined();
    const wmoBytes = chain.read(wmo)!;
    expect(magic(wmoBytes)).toBe("REVM");
    expect(wmoBytes.length).toBe(chain.size(wmo)!);

    const m2 = chain.list(/^creature\\[^\\]+\\[^\\]+\.m2$/)[0]!;
    expect(m2).toBeDefined();
    const m2Bytes = chain.read(m2)!;
    expect(magic(m2Bytes)).toBe("MD20");
    expect(m2Bytes.length).toBe(chain.size(m2)!);
  });

  test("the file lists cover what the extractors enumerate", () => {
    expect(chain.list(/\.wmo$/).length).toBeGreaterThan(5000);
    expect(chain.list(/\.m2$/).length).toBeGreaterThan(10000);
    expect(chain.list(/^world\\maps\\[^\\]+\\[^\\]+_\d+_\d+\.adt$/).length).toBeGreaterThan(5000);
  });

  test("names are case and separator blind", () => {
    const upper = chain.read("DBFILESCLIENT/MAP.DBC")!;
    expect(upper).toEqual(chain.read("dbfilesclient\\map.dbc")!);
  });

  test("a file deleted by a patch is absent from the chain although an earlier archive still holds it", () => {
    const name = "DBFilesClient\\CharVariations.dbc";
    expect(chain.archives.some((archive) => archive.has(name))).toBe(true);
    expect(chain.has(name)).toBe(false);
    expect(chain.read(name)).toBeNull();
    expect(chain.list(/CharVariations\.dbc$/)).toEqual([]);
  });

  test("files from every archive: a plain, a zlib and a single unit block each decode to the block table's size", () => {
    for (const archive of chain.archives) {
      let plain = 0;
      let packed = 0;
      let single = 0;
      for (let index = 0; index < archive.blockTableSize && (plain < 3 || packed < 3 || single < 3); index++) {
        const flags = archive.blockFlags(index);
        if (!(flags & MPQ_FILE_EXISTS) || archive.isDeletedBlock(index) || archive.blockSize(index) === 0) {
          continue;
        }
        const isSingle = (flags & MPQ_FILE_SINGLE_UNIT) !== 0;
        const isPacked = (flags & 0xff00) !== 0 && !isSingle;
        if (isSingle ? single >= 3 : isPacked ? packed >= 3 : plain >= 3) {
          continue;
        }
        const bytes = archive.readBlock(index, null);
        expect(bytes.length).toBe(archive.blockSize(index));
        if (isSingle) single++;
        else if (isPacked) packed++;
        else plain++;
      }
    }
  });

  test("every single unit block of lichking.MPQ (zlib and bzip2) decodes", () => {
    const lichking = chain.archives.find((archive) => archive.path.endsWith("lichking.MPQ"))!;
    let count = 0;
    for (let index = 0; index < lichking.blockTableSize; index++) {
      if (lichking.blockFlags(index) & MPQ_FILE_SINGLE_UNIT) {
        expect(lichking.readBlock(index, null).length).toBe(lichking.blockSize(index));
        count++;
      }
    }
    expect(count).toBeGreaterThan(0);
  });

  test("positional reads give the same bytes as the mapping (the fallback for read-only client directories)", () => {
    const lichking = chain.archives.find((archive) => archive.path.endsWith("lichking.MPQ"))!;
    const viaDescriptor = new MpqArchive(lichking.path, new MpqDescriptorSource(lichking.path));
    expect(viaDescriptor.blockTableSize).toBe(lichking.blockTableSize);
    let compared = 0;
    for (let index = 0; index < lichking.blockTableSize && compared < 60; index += 97) {
      if (lichking.blockFlags(index) & MPQ_FILE_EXISTS) {
        expect(viaDescriptor.readBlock(index, null)).toEqual(lichking.readBlock(index, null));
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(20);
    viaDescriptor.close();
  });

  test("reading is not slower than 30 MB/s of decompressed data", () => {
    const names = chain.list(/^world\\maps\\azeroth\\azeroth_\d+_\d+\.adt$/).slice(0, 40);
    let bytes = 0;
    const started = performance.now();
    for (const name of names) {
      bytes += chain.read(name)!.length;
    }
    const seconds = (performance.now() - started) / 1000;
    console.log(`read ${names.length} Azeroth ADTs, ${(bytes / 1e6).toFixed(1)} MB in ${(seconds * 1000).toFixed(0)} ms (${(bytes / 1e6 / seconds).toFixed(0)} MB/s)`);
    expect(bytes / 1e6 / seconds).toBeGreaterThan(30);
  });
});
