/** `wdt.h` / `wdt.cpp`: the WDT file of a map; `MAIN` tells which of the 64 x 64 ADT tiles exist. */
import { FileLoader, u_map_fcc } from "./loadlib/loadlib.ts";

/** @ac tools/map_extractor/wdt.h WDT_MAP_SIZE */
export const WDT_MAP_SIZE = 64;

/** @ac tools/map_extractor/wdt.cpp MPHDMagic */
export const MPHDMagic = u_map_fcc("DHPM");
/** @ac tools/map_extractor/wdt.cpp MAINMagic */
export const MAINMagic = u_map_fcc("NIAM");

/** `sizeof(wdt_MPHD)`: fourcc, size and eight `uint32` */
const sizeof_wdt_MPHD = 40;

/** @ac tools/map_extractor/wdt.h wdt_MPHD */
export class wdt_MPHD {
  constructor(
    readonly view: DataView,
    readonly pos: number,
  ) {}

  get size(): number {
    return this.view.getUint32(this.pos + 4, true);
  }

  /** @ac tools/map_extractor/wdt.cpp wdt_MPHD::prepareLoadedData */
  prepareLoadedData(): boolean {
    return this.view.getUint32(this.pos, true) === MPHDMagic;
  }
}

/** @ac tools/map_extractor/wdt.h wdt_MAIN */
export class wdt_MAIN {
  constructor(
    readonly view: DataView,
    readonly pos: number,
  ) {}

  get size(): number {
    return this.view.getUint32(this.pos + 4, true);
  }

  /** `adt_list[y][x].exist` */
  exist(y: number, x: number): number {
    return this.view.getUint32(this.pos + 8 + (y * WDT_MAP_SIZE + x) * 8, true);
  }

  /** `adt_list[y][x].data1` */
  data1(y: number, x: number): number {
    return this.view.getUint32(this.pos + 8 + (y * WDT_MAP_SIZE + x) * 8 + 4, true);
  }

  /** @ac tools/map_extractor/wdt.cpp wdt_MAIN::prepareLoadedData */
  prepareLoadedData(): boolean {
    return this.view.getUint32(this.pos, true) === MAINMagic;
  }
}

/** @ac tools/map_extractor/wdt.h WDT_file */
export class WDT_file extends FileLoader {
  mphd: wdt_MPHD | null = null;
  main: wdt_MAIN | null = null;

  /** @ac tools/map_extractor/wdt.cpp WDT_file::prepareLoadedData */
  override prepareLoadedData(): boolean {
    // Check parent
    if (!super.prepareLoadedData()) return false;

    this.mphd = new wdt_MPHD(this.view, this.version + this.versionSize() + 8);
    if (!this.mphd.prepareLoadedData()) return false;
    this.main = new wdt_MAIN(this.view, this.mphd.pos + this.mphd.size + 8);
    if (!this.main.prepareLoadedData()) return false;
    // wdt_MAIN holds 64 * 64 `adtData` (two uint32)
    return this.main.pos + 8 + WDT_MAP_SIZE * WDT_MAP_SIZE * 8 <= this.data_size && this.mphd.pos + sizeof_wdt_MPHD <= this.data_size;
  }

  /** @ac tools/map_extractor/wdt.cpp WDT_file::free */
  override free(): void {
    this.mphd = null;
    this.main = null;
    super.free();
  }
}
