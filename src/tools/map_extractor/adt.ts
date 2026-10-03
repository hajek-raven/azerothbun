/**
 * `adt.h` / `adt.cpp`: the ADT (terrain tile) file. The C++ classes overlay the file bytes; here each class holds the
 * `DataView` of the file and the offset of the chunk's fourcc, and the fields are read on demand. Offsets named like
 * the C++ pointers (`getMCNK`, `getMCVT`, ...) are applied exactly as there, including the `- 84` of `adt_MCIN::getMCNK`
 * (`MCIN` sits at byte 84 in every 3.3.5 ADT: `MVER` 12 bytes, `MHDR` 72).
 */
import { FileLoader, u_map_fcc } from "./loadlib/loadlib.ts";

const F = Math.fround;

/** @ac tools/map_extractor/adt.h TILESIZE */
export const TILESIZE = F(533.33333);
/** @ac tools/map_extractor/adt.h CHUNKSIZE */
export const CHUNKSIZE = F(TILESIZE / 16.0);
/** @ac tools/map_extractor/adt.h UNITSIZE */
export const UNITSIZE = F(CHUNKSIZE / 8.0);

/** @ac tools/map_extractor/adt.h LiquidType */
export const LiquidType = {
  LIQUID_TYPE_WATER: 0,
  LIQUID_TYPE_OCEAN: 1,
  LIQUID_TYPE_MAGMA: 2,
  LIQUID_TYPE_SLIME: 3,
} as const;

/** @ac tools/map_extractor/adt.h ADT_CELLS_PER_GRID */
export const ADT_CELLS_PER_GRID = 16;
/** @ac tools/map_extractor/adt.h ADT_CELL_SIZE */
export const ADT_CELL_SIZE = 8;
/** @ac tools/map_extractor/adt.h ADT_GRID_SIZE */
export const ADT_GRID_SIZE = ADT_CELLS_PER_GRID * ADT_CELL_SIZE;

// Helper
/** @ac tools/map_extractor/adt.cpp holetab_h */
export const holetab_h = [0x1111, 0x2222, 0x4444, 0x8888] as const;
/** @ac tools/map_extractor/adt.cpp holetab_v */
export const holetab_v = [0x000f, 0x00f0, 0x0f00, 0xf000] as const;

/** @ac tools/map_extractor/adt.cpp MHDRMagic */
export const MHDRMagic = u_map_fcc("RDHM");
/** @ac tools/map_extractor/adt.cpp MCINMagic */
export const MCINMagic = u_map_fcc("NICM");
/** @ac tools/map_extractor/adt.cpp MH2OMagic */
export const MH2OMagic = u_map_fcc("O2HM");
/** @ac tools/map_extractor/adt.cpp MCNKMagic */
export const MCNKMagic = u_map_fcc("KNCM");
/** @ac tools/map_extractor/adt.cpp MCVTMagic */
export const MCVTMagic = u_map_fcc("TVCM");
/** @ac tools/map_extractor/adt.cpp MCLQMagic */
export const MCLQMagic = u_map_fcc("QLCM");
/** @ac tools/map_extractor/adt.cpp MFBOMagic */
export const MFBOMagic = u_map_fcc("OBFM");

/** @ac tools/map_extractor/adt.cpp isHole */
export function isHole(holes: number, i: number, j: number): boolean {
  let testi = (i / 2) | 0;
  let testj = (j / 4) | 0;
  if (testi > 3) testi = 3;
  if (testj > 3) testj = 3;
  return (holes & holetab_h[testi]! & holetab_v[testj]!) !== 0;
}

/** `sizeof(adt_MCVT)`: fourcc, size, 9 * 9 + 8 * 8 floats */
export const sizeof_adt_MCVT = 8 + (81 + 64) * 4;
/** `sizeof(adt_MHDR)` */
export const sizeof_adt_MHDR = 8 + 16 * 4;

// ------------------------------------------------------------------------------------------------------------------

/** Adt file height map chunk. @ac tools/map_extractor/adt.h adt_MCVT */
export class adt_MCVT {
  constructor(
    readonly view: DataView,
    readonly pos: number,
  ) {}

  get fcc(): number {
    return this.view.getUint32(this.pos, true);
  }

  get size(): number {
    return this.view.getUint32(this.pos + 4, true);
  }

  /** `height_map[index]`, index in 0..144 (9 outer + 8 inner values per row pair, `y * 17 + x`) */
  height_map(index: number): number {
    return this.view.getFloat32(this.pos + 8 + index * 4, true);
  }

  /** @ac tools/map_extractor/adt.cpp adt_MCVT::prepareLoadedData */
  prepareLoadedData(): boolean {
    if (this.fcc !== MCVTMagic) return false;

    if (this.size !== sizeof_adt_MCVT - 8) return false;

    return true;
  }
}

/** Adt file liquid map chunk (old). @ac tools/map_extractor/adt.h adt_MCLQ */
export class adt_MCLQ {
  constructor(
    readonly view: DataView,
    readonly pos: number,
  ) {}

  get fcc(): number {
    return this.view.getUint32(this.pos, true);
  }

  get size(): number {
    return this.view.getUint32(this.pos + 4, true);
  }

  get height1(): number {
    return this.view.getFloat32(this.pos + 8, true);
  }

  get height2(): number {
    return this.view.getFloat32(this.pos + 12, true);
  }

  /** `liquid[y][x].light` */
  liquidLight(y: number, x: number): number {
    return this.view.getUint32(this.pos + 16 + (y * (ADT_CELL_SIZE + 1) + x) * 8, true);
  }

  /** `liquid[y][x].height` */
  liquidHeight(y: number, x: number): number {
    return this.view.getFloat32(this.pos + 16 + (y * (ADT_CELL_SIZE + 1) + x) * 8 + 4, true);
  }

  // 1<<0 - ochen
  // 1<<1 - lava/slime
  // 1<<2 - water
  // 1<<6 - all water
  // 1<<7 - dark water
  // == 0x0F - not show liquid
  /** `flags[y][x]` */
  flags(y: number, x: number): number {
    return this.view.getUint8(this.pos + 16 + (ADT_CELL_SIZE + 1) * (ADT_CELL_SIZE + 1) * 8 + y * ADT_CELL_SIZE + x);
  }

  /** @ac tools/map_extractor/adt.cpp adt_MCLQ::prepareLoadedData */
  prepareLoadedData(): boolean {
    if (this.fcc !== MCLQMagic) return false;

    return true;
  }
}

/** Adt file cell chunk. @ac tools/map_extractor/adt.h adt_MCNK */
export class adt_MCNK {
  constructor(
    readonly view: DataView,
    readonly pos: number,
  ) {}

  private u32(offset: number): number {
    return this.view.getUint32(this.pos + offset, true);
  }

  get fcc(): number {
    return this.u32(0);
  }
  get size(): number {
    return this.u32(4);
  }
  get flags(): number {
    return this.u32(8);
  }
  get ix(): number {
    return this.u32(12);
  }
  get iy(): number {
    return this.u32(16);
  }
  get nLayers(): number {
    return this.u32(20);
  }
  get nDoodadRefs(): number {
    return this.u32(24);
  }
  /** height map */
  get offsMCVT(): number {
    return this.u32(28);
  }
  /** Normal vectors for each vertex */
  get offsMCNR(): number {
    return this.u32(32);
  }
  /** Texture layer definitions */
  get offsMCLY(): number {
    return this.u32(36);
  }
  /** A list of indices into the parent file's MDDF chunk */
  get offsMCRF(): number {
    return this.u32(40);
  }
  /** Alpha maps for additional texture layers */
  get offsMCAL(): number {
    return this.u32(44);
  }
  get sizeMCAL(): number {
    return this.u32(48);
  }
  /** Shadow map for static shadows on the terrain */
  get offsMCSH(): number {
    return this.u32(52);
  }
  get sizeMCSH(): number {
    return this.u32(56);
  }
  get areaid(): number {
    return this.u32(60);
  }
  get nMapObjRefs(): number {
    return this.u32(64);
  }
  get holes(): number {
    return this.u32(68);
  }
  /** `s[index]` */
  s(index: number): number {
    return this.view.getUint16(this.pos + 72 + index * 2, true);
  }
  get data1(): number {
    return this.u32(76);
  }
  get data2(): number {
    return this.u32(80);
  }
  get data3(): number {
    return this.u32(84);
  }
  get predTex(): number {
    return this.u32(88);
  }
  get nEffectDoodad(): number {
    return this.u32(92);
  }
  get offsMCSE(): number {
    return this.u32(96);
  }
  get nSndEmitters(): number {
    return this.u32(100);
  }
  /** Liqid level (old) */
  get offsMCLQ(): number {
    return this.u32(104);
  }
  get sizeMCLQ(): number {
    return this.u32(108);
  }
  get zpos(): number {
    return this.view.getFloat32(this.pos + 112, true);
  }
  get xpos(): number {
    return this.view.getFloat32(this.pos + 116, true);
  }
  get ypos(): number {
    return this.view.getFloat32(this.pos + 120, true);
  }
  /** offsColorValues in WotLK */
  get offsMCCV(): number {
    return this.u32(124);
  }
  get props(): number {
    return this.u32(128);
  }
  get effectId(): number {
    return this.u32(132);
  }

  /** @ac tools/map_extractor/adt.cpp adt_MCNK::prepareLoadedData */
  prepareLoadedData(): boolean {
    if (this.fcc !== MCNKMagic) return false;

    // Check height map
    if (this.offsMCVT) {
      const mcvt = this.getMCVT();
      if (!mcvt || !mcvt.prepareLoadedData()) return false;
    }
    // Check liquid data
    if (this.offsMCLQ) {
      const mclq = this.getMCLQ();
      if (!mclq || !mclq.prepareLoadedData()) return false;
    }

    return true;
  }

  /** @ac tools/map_extractor/adt.h adt_MCNK::getMCVT */
  getMCVT(): adt_MCVT | null {
    const offs = this.offsMCVT;
    if (offs) return new adt_MCVT(this.view, this.pos + offs);
    return null;
  }

  /** @ac tools/map_extractor/adt.h adt_MCNK::getMCLQ */
  getMCLQ(): adt_MCLQ | null {
    const offs = this.offsMCLQ;
    if (offs) return new adt_MCLQ(this.view, this.pos + offs);
    return null;
  }
}

/** Adt file grid chunk. @ac tools/map_extractor/adt.h adt_MCIN */
export class adt_MCIN {
  constructor(
    readonly view: DataView,
    readonly pos: number,
  ) {}

  get fcc(): number {
    return this.view.getUint32(this.pos, true);
  }

  get size(): number {
    return this.view.getUint32(this.pos + 4, true);
  }

  /** `cells[x][y].offsMCNK` (offset from begin file) */
  offsMCNK(x: number, y: number): number {
    return this.view.getUint32(this.pos + 8 + (x * ADT_CELLS_PER_GRID + y) * 16, true);
  }

  /** `cells[x][y].size` */
  cellSize(x: number, y: number): number {
    return this.view.getUint32(this.pos + 8 + (x * ADT_CELLS_PER_GRID + y) * 16 + 4, true);
  }

  /** `cells[x][y].flags` */
  cellFlags(x: number, y: number): number {
    return this.view.getUint32(this.pos + 8 + (x * ADT_CELLS_PER_GRID + y) * 16 + 8, true);
  }

  /** `cells[x][y].asyncId` */
  cellAsyncId(x: number, y: number): number {
    return this.view.getUint32(this.pos + 8 + (x * ADT_CELLS_PER_GRID + y) * 16 + 12, true);
  }

  /** @ac tools/map_extractor/adt.cpp adt_MCIN::prepareLoadedData */
  prepareLoadedData(): boolean {
    if (this.fcc !== MCINMagic) return false;

    // Check cells data
    for (let i = 0; i < ADT_CELLS_PER_GRID; i++)
      for (let j = 0; j < ADT_CELLS_PER_GRID; j++) {
        if (this.offsMCNK(i, j)) {
          const mcnk = this.getMCNK(i, j);
          if (!mcnk || !mcnk.prepareLoadedData()) return false;
        }
      }

    return true;
  }

  // offset from begin file (used this-84)
  /** @ac tools/map_extractor/adt.h adt_MCIN::getMCNK */
  getMCNK(x: number, y: number): adt_MCNK | null {
    const offs = this.offsMCNK(x, y);
    if (offs) return new adt_MCNK(this.view, this.pos + offs - 84);
    return null;
  }
}

/** @ac tools/map_extractor/adt.h LiquidVertexFormatType */
export const LiquidVertexFormatType = {
  HeightDepth: 0,
  HeightTextureCoord: 1,
  Depth: 2,
} as const;

/** `struct adt_liquid_instance` (24 bytes) */
export class adt_liquid_instance {
  constructor(
    readonly view: DataView,
    readonly pos: number,
  ) {}

  /** Index from LiquidType.db2 */
  get LiquidType(): number {
    return this.view.getUint16(this.pos, true);
  }
  get LiquidVertexFormat(): number {
    return this.view.getUint16(this.pos + 2, true);
  }
  get MinHeightLevel(): number {
    return this.view.getFloat32(this.pos + 4, true);
  }
  get MaxHeightLevel(): number {
    return this.view.getFloat32(this.pos + 8, true);
  }
  get OffsetX(): number {
    return this.view.getUint8(this.pos + 12);
  }
  get OffsetY(): number {
    return this.view.getUint8(this.pos + 13);
  }
  get Width(): number {
    return this.view.getUint8(this.pos + 14);
  }
  get Height(): number {
    return this.view.getUint8(this.pos + 15);
  }
  get OffsetExistsBitmap(): number {
    return this.view.getUint32(this.pos + 16, true);
  }
  get OffsetVertexData(): number {
    return this.view.getUint32(this.pos + 20, true);
  }

  GetOffsetX(): number {
    return this.OffsetX;
  }
  GetOffsetY(): number {
    return this.OffsetY;
  }
  GetWidth(): number {
    return this.Width;
  }
  GetHeight(): number {
    return this.Height;
  }
}

/** `struct adt_liquid_attributes` */
export type adt_liquid_attributes = { Fishable: bigint; Deep: bigint };

const ALL_BITS = 0xffffffffffffffffn;

/** Adt file liquid data chunk (new). @ac tools/map_extractor/adt.h adt_MH2O */
export class adt_MH2O {
  constructor(
    readonly view: DataView,
    readonly pos: number,
  ) {}

  get fcc(): number {
    return this.view.getUint32(this.pos, true);
  }

  get size(): number {
    return this.view.getUint32(this.pos + 4, true);
  }

  private liquidAt(x: number, y: number): number {
    return this.pos + 8 + (x * ADT_CELLS_PER_GRID + y) * 12;
  }

  /** `liquid[x][y].OffsetInstances` */
  OffsetInstances(x: number, y: number): number {
    return this.view.getUint32(this.liquidAt(x, y), true);
  }

  /** `liquid[x][y].used` */
  used(x: number, y: number): number {
    return this.view.getUint32(this.liquidAt(x, y) + 4, true);
  }

  /** `liquid[x][y].OffsetAttributes` */
  OffsetAttributes(x: number, y: number): number {
    return this.view.getUint32(this.liquidAt(x, y) + 8, true);
  }

  /** @ac tools/map_extractor/adt.cpp adt_MH2O::prepareLoadedData */
  prepareLoadedData(): boolean {
    if (this.fcc !== MH2OMagic) return false;

    // Check liquid data
    //    for (int i=0; i<ADT_CELLS_PER_GRID;i++)
    //        for (int j=0; j<ADT_CELLS_PER_GRID;j++)

    return true;
  }

  /** @ac tools/map_extractor/adt.h adt_MH2O::GetLiquidInstance */
  GetLiquidInstance(x: number, y: number): adt_liquid_instance | null {
    if (this.used(x, y) && this.OffsetInstances(x, y)) return new adt_liquid_instance(this.view, this.pos + 8 + this.OffsetInstances(x, y));
    return null;
  }

  /** @ac tools/map_extractor/adt.h adt_MH2O::GetLiquidAttributes */
  GetLiquidAttributes(x: number, y: number): adt_liquid_attributes {
    if (this.used(x, y)) {
      const offs = this.OffsetAttributes(x, y);
      if (offs) {
        const at = this.pos + 8 + offs;
        return { Fishable: this.view.getBigUint64(at, true), Deep: this.view.getBigUint64(at + 8, true) };
      }
      return { Fishable: ALL_BITS, Deep: ALL_BITS };
    }
    return { Fishable: 0n, Deep: 0n };
  }

  /** @ac tools/map_extractor/adt.h adt_MH2O::GetLiquidType */
  GetLiquidType(h: adt_liquid_instance): number {
    if (h.LiquidVertexFormat === LiquidVertexFormatType.Depth) return 2;

    return h.LiquidType;
  }

  /** @ac tools/map_extractor/adt.h adt_MH2O::GetLiquidHeight */
  GetLiquidHeight(h: adt_liquid_instance, pos: number): number {
    if (!h.OffsetVertexData) return 0.0;

    switch (h.LiquidVertexFormat) {
      case LiquidVertexFormatType.HeightDepth:
      case LiquidVertexFormatType.HeightTextureCoord:
        return this.view.getFloat32(this.pos + 8 + h.OffsetVertexData + pos * 4, true);
      case LiquidVertexFormatType.Depth:
        return 0.0;
      default:
        break;
    }

    return 0.0;
  }

  /**
   * @ac tools/map_extractor/adt.h adt_MH2O::GetLiquidDepth
   * (C++ casts `this` to `int8 const*` before adding the offsets, which is the same byte address.)
   */
  GetLiquidDepth(h: adt_liquid_instance, pos: number): number {
    if (!h.OffsetVertexData) return -1;

    switch (h.LiquidVertexFormat) {
      case LiquidVertexFormatType.HeightDepth:
        return this.view.getInt8(this.pos + 8 + h.OffsetVertexData + (h.GetWidth() + 1) * (h.GetHeight() + 1) * 4 + pos);
      case LiquidVertexFormatType.HeightTextureCoord:
        return 0;
      case LiquidVertexFormatType.Depth:
        return this.view.getInt8(this.pos + 8 + h.OffsetVertexData + pos);
      default:
        break;
    }
    return 0;
  }

  /** @ac tools/map_extractor/adt.h adt_MH2O::GetLiquidTextureCoordMap: the offset of the `uint16` pair, or -1 (nullptr) */
  GetLiquidTextureCoordMap(h: adt_liquid_instance, pos: number): number {
    if (!h.OffsetVertexData) return -1;

    switch (h.LiquidVertexFormat) {
      case LiquidVertexFormatType.HeightDepth:
      case LiquidVertexFormatType.Depth:
        return -1;
      case LiquidVertexFormatType.HeightTextureCoord:
        return this.pos + 8 + h.OffsetVertexData + 4 * ((h.GetWidth() + 1) * (h.GetHeight() + 1) + pos);
      default:
        break;
    }
    return -1;
  }

  /** @ac tools/map_extractor/adt.h adt_MH2O::GetLiquidExistsBitmap */
  GetLiquidExistsBitmap(h: adt_liquid_instance): bigint {
    if (h.OffsetExistsBitmap) return this.view.getBigUint64(this.pos + 8 + h.OffsetExistsBitmap, true);
    else return ALL_BITS;
  }
}

/** Adt file min/max height chunk. @ac tools/map_extractor/adt.h adt_MFBO */
export class adt_MFBO {
  constructor(
    readonly view: DataView,
    readonly pos: number,
  ) {}

  get fcc(): number {
    return this.view.getUint32(this.pos, true);
  }

  get size(): number {
    return this.view.getUint32(this.pos + 4, true);
  }

  /** `max.coords[index]` */
  maxCoord(index: number): number {
    return this.view.getInt16(this.pos + 8 + index * 2, true);
  }

  /** `min.coords[index]` */
  minCoord(index: number): number {
    return this.view.getInt16(this.pos + 8 + 18 + index * 2, true);
  }

  /** @ac tools/map_extractor/adt.cpp adt_MFBO::prepareLoadedData */
  prepareLoadedData(): boolean {
    return this.fcc === MFBOMagic;
  }
}

/** Adt file header chunk. @ac tools/map_extractor/adt.h adt_MHDR */
export class adt_MHDR {
  constructor(
    readonly view: DataView,
    readonly pos: number,
  ) {}

  private u32(offset: number): number {
    return this.view.getUint32(this.pos + offset, true);
  }

  get fcc(): number {
    return this.u32(0);
  }
  get size(): number {
    return this.u32(4);
  }
  get flags(): number {
    return this.u32(8);
  }
  /** MCIN */
  get offsMCIN(): number {
    return this.u32(12);
  }
  /** MTEX */
  get offsTex(): number {
    return this.u32(16);
  }
  /** MMDX */
  get offsModels(): number {
    return this.u32(20);
  }
  /** MMID */
  get offsModelsIds(): number {
    return this.u32(24);
  }
  /** MWMO */
  get offsMapObejcts(): number {
    return this.u32(28);
  }
  /** MWID */
  get offsMapObejctsIds(): number {
    return this.u32(32);
  }
  /** MDDF */
  get offsDoodsDef(): number {
    return this.u32(36);
  }
  /** MODF */
  get offsObjectsDef(): number {
    return this.u32(40);
  }
  /** MFBO */
  get offsMFBO(): number {
    return this.u32(44);
  }
  /** MH2O */
  get offsMH2O(): number {
    return this.u32(48);
  }

  /** @ac tools/map_extractor/adt.cpp adt_MHDR::prepareLoadedData */
  prepareLoadedData(): boolean {
    if (this.fcc !== MHDRMagic) return false;

    if (this.size !== sizeof_adt_MHDR - 8) return false;

    // Check and prepare MCIN
    if (this.offsMCIN && !this.getMCIN()!.prepareLoadedData()) return false;

    // Check and prepare MH2O
    if (this.offsMH2O && !this.getMH2O()!.prepareLoadedData()) return false;

    if (this.offsMFBO && this.flags & 1 && !this.getMFBO()!.prepareLoadedData()) return false;

    return true;
  }

  /** @ac tools/map_extractor/adt.h adt_MHDR::getMCIN (`&flags + offsMCIN`) */
  getMCIN(): adt_MCIN | null {
    return new adt_MCIN(this.view, this.pos + 8 + this.offsMCIN);
  }

  /** @ac tools/map_extractor/adt.h adt_MHDR::getMH2O */
  getMH2O(): adt_MH2O | null {
    if (this.offsMH2O) return new adt_MH2O(this.view, this.pos + 8 + this.offsMH2O);
    return null;
  }

  /** @ac tools/map_extractor/adt.h adt_MHDR::getMFBO */
  getMFBO(): adt_MFBO | null {
    if (this.flags & 1 && this.offsMFBO) return new adt_MFBO(this.view, this.pos + 8 + this.offsMFBO);
    return null;
  }
}

/** @ac tools/map_extractor/adt.h ADT_file */
export class ADT_file extends FileLoader {
  a_grid: adt_MHDR | null = null;

  /** @ac tools/map_extractor/adt.cpp ADT_file::prepareLoadedData */
  override prepareLoadedData(): boolean {
    // Check parent
    if (!super.prepareLoadedData()) return false;

    // Check and prepare MHDR
    this.a_grid = new adt_MHDR(this.view, 8 + this.versionSize() + this.version);
    if (!this.a_grid.prepareLoadedData()) return false;

    return true;
  }

  /** @ac tools/map_extractor/adt.cpp ADT_file::free */
  override free(): void {
    this.a_grid = null;
    super.free();
  }
}
