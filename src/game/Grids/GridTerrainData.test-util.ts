/**
 * Writes `.map` files for the terrain tests, the way `tools/map_extractor/System.cpp` `ConvertADT` writes them:
 * `map_fileheader`, then the area, height (V9 before V8, flight bounds after them), liquid and holes sections, each
 * at the offset the previous section ends. The height encodings quantize like the extractor
 * (`uint8((V - minHeight) * step + 0.5f)` with `step = 255 / diff`, or `65535 / diff` for uint16).
 */
import {
  MAP_AREA_NO_AREA,
  MAP_HEIGHT_AS_INT16,
  MAP_HEIGHT_AS_INT8,
  MAP_HEIGHT_HAS_FLIGHT_BOUNDS,
  MAP_HEIGHT_NO_HEIGHT,
  MAP_LIQUID_NO_HEIGHT,
  MAP_LIQUID_NO_TYPE,
  MapAreaMagic,
  MapHeightMagic,
  MapLiquidMagic,
  MapMagic,
  MapVersionMagic,
  sizeof_map_areaHeader,
  sizeof_map_fileheader,
  sizeof_map_heightHeader,
  sizeof_map_liquidHeader,
  writeMapFileHeader,
} from "./GridTerrainData.ts";

const F = Math.fround;

/** `ADT_GRID_SIZE` */
export const ADT_GRID_SIZE = 128;
/** `ADT_CELLS_PER_GRID` */
export const ADT_CELLS_PER_GRID = 16;

export type TestMapHeight = {
  /** 129 * 129 values, `V9[x * 129 + y]` */
  V9: Float32Array;
  /** 128 * 128 values, `V8[x * 128 + y]` */
  V8: Float32Array;
  /** `flat` writes `MAP_HEIGHT_NO_HEIGHT` (only `gridHeight` = the minimum is stored) */
  encoding: "flat" | "float" | "uint8" | "uint16";
  /** `MFBO` flight bounds: 9 `int16` maximum and 9 `int16` minimum heights */
  flightBox?: { max: ArrayLike<number>; min: ArrayLike<number> };
};

export type TestMapLiquid = {
  /** `map_liquidHeader.liquidType` (the entry used when no per cell entries are stored) */
  liquidType?: number;
  /** `map_liquidHeader.liquidFlags` (the flags used when no per cell flags are stored) */
  liquidFlags?: number;
  offsetX?: number;
  offsetY?: number;
  width?: number;
  height?: number;
  liquidLevel?: number;
  /** 16 * 16 entries; stored together with `flags` (without both the header carries the type: `MAP_LIQUID_NO_TYPE`) */
  entry?: Uint16Array;
  flags?: Uint8Array;
  /** `width * height` levels; without them the header level is the level (`MAP_LIQUID_NO_HEIGHT`) */
  heights?: Float32Array;
};

export type TestMap = {
  build?: number;
  /** 16 * 16 area ids (`area_ids[i][j]` at `i * 16 + j`); all equal ids are packed as `MAP_AREA_NO_AREA` + `gridArea` */
  areaIds?: Uint16Array;
  /** `undefined` writes no height section at all (`heightMapOffset` 0 is not written by the extractor, but is valid) */
  height?: TestMapHeight;
  liquid?: TestMapLiquid;
  /** 16 * 16 hole masks; the section is written when any is set */
  holes?: Uint16Array;
};

/** `selectUInt8StepStore` / `selectUInt16StepStore` */
function step(encoding: "uint8" | "uint16", diff: number): number {
  return F((encoding === "uint8" ? 255 : 65535) / diff);
}

/** Builds the bytes of a `.map` file. */
export function buildMapFile(map: TestMap): Uint8Array {
  const chunks: Uint8Array[] = [];
  const header = {
    mapMagic: MapMagic.asUInt,
    versionMagic: MapVersionMagic,
    buildMagic: map.build ?? 12340,
    areaMapOffset: 0,
    areaMapSize: 0,
    heightMapOffset: 0,
    heightMapSize: 0,
    liquidMapOffset: 0,
    liquidMapSize: 0,
    holesOffset: 0,
    holesSize: 0,
  };
  let offset = sizeof_map_fileheader;

  // Area: pack a uniform grid as `gridArea`
  if (map.areaIds) {
    const areaId = map.areaIds[0]!;
    const fullAreaData = map.areaIds.some((id) => id !== areaId);
    const area = new Uint8Array(sizeof_map_areaHeader + (fullAreaData ? 512 : 0));
    const view = new DataView(area.buffer);
    view.setUint32(0, MapAreaMagic.asUInt, true);
    view.setUint16(4, fullAreaData ? 0 : MAP_AREA_NO_AREA, true);
    view.setUint16(6, fullAreaData ? 0 : areaId, true);
    if (fullAreaData) for (let i = 0; i < 256; i++) view.setUint16(8 + i * 2, map.areaIds[i]!, true);
    header.areaMapOffset = offset;
    header.areaMapSize = area.length;
    offset += area.length;
    chunks.push(area);
  }

  // Height
  if (map.height) {
    const { V9, V8, encoding, flightBox } = map.height;
    let maxHeight = -20000;
    let minHeight = 20000;
    for (const h of V8) {
      if (maxHeight < h) maxHeight = h;
      if (minHeight > h) minHeight = h;
    }
    for (const h of V9) {
      if (maxHeight < h) maxHeight = h;
      if (minHeight > h) minHeight = h;
    }
    const elementSize = encoding === "float" ? 4 : encoding === "uint16" ? 2 : 1;
    const hasHeights = encoding !== "flat";
    const size = sizeof_map_heightHeader + (hasHeights ? (V9.length + V8.length) * elementSize : 0) + (flightBox ? 36 : 0);
    const bytes = new Uint8Array(size);
    const view = new DataView(bytes.buffer);
    let flags = 0;
    if (!hasHeights) flags |= MAP_HEIGHT_NO_HEIGHT;
    if (encoding === "uint8") flags |= MAP_HEIGHT_AS_INT8;
    if (encoding === "uint16") flags |= MAP_HEIGHT_AS_INT16;
    if (flightBox) flags |= MAP_HEIGHT_HAS_FLIGHT_BOUNDS;
    view.setUint32(0, MapHeightMagic.asUInt, true);
    view.setUint32(4, flags, true);
    view.setFloat32(8, minHeight, true);
    view.setFloat32(12, maxHeight, true);
    let pos = sizeof_map_heightHeader;
    if (hasHeights) {
      const s = encoding === "float" ? 0 : step(encoding, F(maxHeight - minHeight));
      const put = (values: Float32Array): void => {
        for (const v of values) {
          if (encoding === "float") view.setFloat32(pos, v, true);
          else if (encoding === "uint16") view.setUint16(pos, F(F(F(v - minHeight) * s) + 0.5) | 0, true);
          else view.setUint8(pos, F(F(F(v - minHeight) * s) + 0.5) | 0);
          pos += elementSize;
        }
      };
      put(V9);
      put(V8);
    }
    if (flightBox) {
      for (let i = 0; i < 9; i++) view.setInt16(pos + i * 2, flightBox.max[i]!, true);
      for (let i = 0; i < 9; i++) view.setInt16(pos + 18 + i * 2, flightBox.min[i]!, true);
    }
    header.heightMapOffset = offset;
    header.heightMapSize = size;
    offset += size;
    chunks.push(bytes);
  }

  // Liquid
  if (map.liquid) {
    const liquid = map.liquid;
    const width = liquid.width ?? 0;
    const height = liquid.height ?? 0;
    const hasType = !!liquid.entry && !!liquid.flags;
    const hasHeights = !!liquid.heights;
    const size = sizeof_map_liquidHeader + (hasType ? 512 + 256 : 0) + (hasHeights ? width * height * 4 : 0);
    const bytes = new Uint8Array(size);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, MapLiquidMagic.asUInt, true);
    view.setUint8(4, (hasType ? 0 : MAP_LIQUID_NO_TYPE) | (hasHeights ? 0 : MAP_LIQUID_NO_HEIGHT));
    view.setUint8(5, liquid.liquidFlags ?? 0);
    view.setUint16(6, liquid.liquidType ?? 0, true);
    view.setUint8(8, liquid.offsetX ?? 0);
    view.setUint8(9, liquid.offsetY ?? 0);
    view.setUint8(10, width);
    view.setUint8(11, height);
    view.setFloat32(12, liquid.liquidLevel ?? 0, true);
    let pos = sizeof_map_liquidHeader;
    if (hasType) {
      for (let i = 0; i < 256; i++) view.setUint16(pos + i * 2, liquid.entry![i]!, true);
      pos += 512;
      for (let i = 0; i < 256; i++) view.setUint8(pos + i, liquid.flags![i]!);
      pos += 256;
    }
    if (hasHeights) for (let i = 0; i < width * height; i++) view.setFloat32(pos + i * 4, liquid.heights![i]!, true);
    header.liquidMapOffset = offset;
    header.liquidMapSize = size;
    offset += size;
    chunks.push(bytes);
  }

  // Holes
  if (map.holes?.some((hole) => hole !== 0)) {
    const bytes = new Uint8Array(512);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < 256; i++) view.setUint16(i * 2, map.holes[i]!, true);
    header.holesOffset = offset;
    header.holesSize = 512;
    offset += 512;
    chunks.push(bytes);
  }

  const out = new Uint8Array(offset);
  writeMapFileHeader(new DataView(out.buffer), 0, header);
  let at = sizeof_map_fileheader;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** Writes `buildMapFile(map)` to `path`. */
export async function writeMapFile(path: string, map: TestMap): Promise<void> {
  await Bun.write(path, buildMapFile(map));
}

/**
 * The extractor's liquid packing (`ConvertADT`, "Pack liquid data"): the `liquid_show` cells decide the
 * offset and size of the stored rectangle (`width = maxX - minX + 2`), cells that are not shown get `useMinHeight`
 * as level, and the header level is the minimum.
 */
export function packLiquid(
  entry: Uint16Array,
  flags: Uint8Array,
  show: (x: number, y: number) => boolean,
  level: (x: number, y: number) => number,
  useMinHeight = -2000,
): TestMapLiquid {
  let minX = 255;
  let minY = 255;
  let maxX = 0;
  let maxY = 0;
  let maxHeight = -20000;
  let minHeight = 20000;
  const heights = new Float32Array(129 * 129);
  for (let y = 0; y < ADT_GRID_SIZE; y++) {
    for (let x = 0; x < ADT_GRID_SIZE; x++) {
      if (show(x, y)) {
        if (minX > x) minX = x;
        if (maxX < x) maxX = x;
        if (minY > y) minY = y;
        if (maxY < y) maxY = y;
        const h = level(x, y);
        heights[y * 129 + x] = h;
        if (maxHeight < h) maxHeight = h;
        if (minHeight > h) minHeight = h;
      } else {
        heights[y * 129 + x] = useMinHeight;
        if (minHeight > useMinHeight) minHeight = useMinHeight;
      }
    }
  }
  const width = maxX - minX + 1 + 1;
  const height = maxY - minY + 1 + 1;
  const stored = new Float32Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) stored[y * width + x] = heights[(y + minY) * 129 + (x + minX)]!;
  return { offsetX: minX, offsetY: minY, width, height, liquidLevel: minHeight, entry, flags, heights: stored };
}
