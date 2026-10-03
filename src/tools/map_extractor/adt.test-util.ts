/**
 * Assembles a 3.3.5 ADT file for the extractor tests: `MVER`, `MHDR`, `MCIN`, 16 * 16 `MCNK` (each with an optional
 * `MCVT` and `MCLQ`), an optional `MH2O` and `MFBO`. The chunk names are stored reversed like on disk (`REVM`).
 */
import { u_map_fcc } from "./loadlib/loadlib.ts";

export type TestMCLQ = {
  /** 9 * 9 liquid heights, `liquid[y][x].height` at `y * 9 + x` */
  heights: Float32Array;
  /** 8 * 8 flags, `0x0f` = not shown */
  flags: Uint8Array;
};

export type TestCell = {
  areaid?: number;
  holes?: number;
  /** `MCNK::flags` (bit 2 water, 3 ocean, 4 magma for MCLQ cells) */
  flags?: number;
  /** `MCNK::ypos`: the base height the `MCVT` values are relative to */
  ypos?: number;
  /** 145 values: 9 outer then 8 inner per row pair, `y * 17 + x` (outer) and `y * 17 + 9 + x` (inner) */
  mcvt?: Float32Array;
  mclq?: TestMCLQ;
  /** `MCNK::sizeMCLQ` override (the extractor ignores MCLQ when it is 8 or less) */
  sizeMCLQ?: number;
};

export type TestH2OInstance = {
  liquidType: number;
  /** `LiquidVertexFormatType` */
  format?: number;
  minHeight?: number;
  maxHeight?: number;
  offsetX?: number;
  offsetY?: number;
  width: number;
  height: number;
  /** `width * height` bits, first cell = lowest bit; `undefined` = no bitmap (all cells exist) */
  exists?: bigint;
  /** `(width + 1) * (height + 1)` heights; `undefined` = no vertex data */
  heights?: Float32Array;
  /** `liquid_attributes.Deep` (`undefined` = no attributes block) */
  deep?: bigint;
};

export type TestADT = {
  /** `(i, j)` = `MCIN` index of the cell; default cell when the callback returns `undefined` */
  cell?: (i: number, j: number) => TestCell | undefined;
  /** `[i * 16 + j]` */
  h2o?: Map<number, TestH2OInstance>;
  mfbo?: { max: number[]; min: number[] };
  /** `MVER` version, 18 by default */
  version?: number;
};

const MCNK_HEADER = 136;
const MCVT_SIZE = 8 + 145 * 4;
const MCLQ_SIZE = 8 + 8 + 81 * 8 + 64 + 84;

export function buildADT(adt: TestADT): Uint8Array {
  const parts: Uint8Array[] = [];
  const push = (size: number): DataView => {
    const bytes = new Uint8Array(size);
    parts.push(bytes);
    return new DataView(bytes.buffer);
  };
  let offset = 0;
  const add = (size: number): { view: DataView; at: number } => {
    const view = push(size);
    const at = offset;
    offset += size;
    return { view, at };
  };

  // MVER
  const mver = add(12);
  mver.view.setUint32(0, u_map_fcc("REVM"), true);
  mver.view.setUint32(4, 4, true);
  mver.view.setUint32(8, adt.version ?? 18, true);

  // MHDR (offsets are relative to the end of the chunk header, `&flags`)
  const mhdr = add(72);
  const mhdrBase = mhdr.at + 8;
  mhdr.view.setUint32(0, u_map_fcc("RDHM"), true);
  mhdr.view.setUint32(4, 64, true);
  mhdr.view.setUint32(8, adt.mfbo ? 1 : 0, true);

  // MCIN
  const mcin = add(8 + 16 * 16 * 16);
  mcin.view.setUint32(0, u_map_fcc("NICM"), true);
  mcin.view.setUint32(4, 16 * 16 * 16, true);
  mhdr.view.setUint32(12, mcin.at - mhdrBase, true);

  // MCNK chunks
  for (let i = 0; i < 16; i++) {
    for (let j = 0; j < 16; j++) {
      const cell = adt.cell?.(i, j) ?? {};
      const size = MCNK_HEADER + (cell.mcvt ? MCVT_SIZE : 0) + (cell.mclq ? MCLQ_SIZE : 0);
      const mcnk = add(size);
      const v = mcnk.view;
      v.setUint32(0, u_map_fcc("KNCM"), true);
      v.setUint32(4, size - 8, true);
      v.setUint32(8, cell.flags ?? 0, true);
      v.setUint32(12, j, true);
      v.setUint32(16, i, true);
      let at = MCNK_HEADER;
      if (cell.mcvt) {
        v.setUint32(28, at, true);
        v.setUint32(at, u_map_fcc("TVCM"), true);
        v.setUint32(at + 4, 145 * 4, true);
        for (let k = 0; k < 145; k++) v.setFloat32(at + 8 + k * 4, cell.mcvt[k]!, true);
        at += MCVT_SIZE;
      }
      v.setUint32(60, cell.areaid ?? 0, true);
      v.setUint32(68, cell.holes ?? 0, true);
      if (cell.mclq) {
        v.setUint32(104, at, true);
        v.setUint32(108, cell.sizeMCLQ ?? MCLQ_SIZE, true);
        v.setUint32(at, u_map_fcc("QLCM"), true);
        v.setUint32(at + 4, MCLQ_SIZE - 8, true);
        for (let k = 0; k < 81; k++) v.setFloat32(at + 16 + k * 8 + 4, cell.mclq.heights[k]!, true);
        for (let k = 0; k < 64; k++) v.setUint8(at + 16 + 81 * 8 + k, cell.mclq.flags[k]!);
        at += MCLQ_SIZE;
      }
      v.setFloat32(120, cell.ypos ?? 0, true);
      // MCIN entry `cells[i][j]`: offset from the beginning of the file, size
      mcin.view.setUint32(8 + (i * 16 + j) * 16, mcnk.at, true);
      mcin.view.setUint32(8 + (i * 16 + j) * 16 + 4, size, true);
    }
  }

  // MH2O
  if (adt.h2o) {
    let bodySize = 256 * 12;
    for (const inst of adt.h2o.values()) {
      bodySize += 24 + (inst.exists !== undefined ? 8 : 0) + (inst.heights ? inst.heights.length * 4 : 0) + (inst.deep !== undefined ? 16 : 0);
    }
    const mh2o = add(8 + bodySize);
    const v = mh2o.view;
    v.setUint32(0, u_map_fcc("O2HM"), true);
    v.setUint32(4, bodySize, true);
    let at = 256 * 12; // relative to the chunk data
    for (const [index, inst] of [...adt.h2o.entries()].sort((a, b) => a[0] - b[0])) {
      const base = 8 + at;
      v.setUint16(base, inst.liquidType, true);
      v.setUint16(base + 2, inst.format ?? 0, true);
      v.setFloat32(base + 4, inst.minHeight ?? 0, true);
      v.setFloat32(base + 8, inst.maxHeight ?? 0, true);
      v.setUint8(base + 12, inst.offsetX ?? 0);
      v.setUint8(base + 13, inst.offsetY ?? 0);
      v.setUint8(base + 14, inst.width);
      v.setUint8(base + 15, inst.height);
      const entry = 8 + index * 12;
      v.setUint32(entry, at, true);
      v.setUint32(entry + 4, 1, true);
      at += 24;
      if (inst.exists !== undefined) {
        v.setUint32(base + 16, at, true);
        v.setBigUint64(8 + at, inst.exists, true);
        at += 8;
      }
      if (inst.heights) {
        v.setUint32(base + 20, at, true);
        for (let k = 0; k < inst.heights.length; k++) v.setFloat32(8 + at + k * 4, inst.heights[k]!, true);
        at += inst.heights.length * 4;
      }
      if (inst.deep !== undefined) {
        v.setUint32(entry + 8, at, true);
        v.setBigUint64(8 + at, 0n, true);
        v.setBigUint64(8 + at + 8, inst.deep, true);
        at += 16;
      }
    }
    mhdr.view.setUint32(48, mh2o.at - mhdrBase, true);
  }

  // MFBO
  if (adt.mfbo) {
    const mfbo = add(8 + 36);
    mfbo.view.setUint32(0, u_map_fcc("OBFM"), true);
    mfbo.view.setUint32(4, 36, true);
    for (let k = 0; k < 9; k++) mfbo.view.setInt16(8 + k * 2, adt.mfbo.max[k]!, true);
    for (let k = 0; k < 9; k++) mfbo.view.setInt16(8 + 18 + k * 2, adt.mfbo.min[k]!, true);
    mhdr.view.setUint32(44, mfbo.at - mhdrBase, true);
  }

  const out = new Uint8Array(offset);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** `MCVT` values (145) for a cell whose outer vertices are `outer(x, y)` and inner vertices `inner(x, y)`. */
export function buildMCVT(outer: (x: number, y: number) => number, inner: (x: number, y: number) => number = () => 0): Float32Array {
  const values = new Float32Array(145);
  for (let y = 0; y < 9; y++) {
    for (let x = 0; x < 9; x++) values[y * 17 + x] = outer(x, y);
    if (y < 8) for (let x = 0; x < 8; x++) values[y * 17 + 9 + x] = inner(x, y);
  }
  return values;
}
