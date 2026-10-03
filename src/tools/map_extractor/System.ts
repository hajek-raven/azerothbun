/**
 * `System.cpp`: the map and DBC extractor. Reads a 3.3.5a client and writes `<out>/dbc/*.dbc`, `<out>/Cameras/*.m2` and
 * `<out>/maps/MMMXXYY.map` (`MMM` map id, `XX` grid x, `YY` grid y), the files `data/` holds for the world server.
 *
 *   bun src/tools/map_extractor/System.ts <client dir> [output dir = data] [--maps 0,1,530] [--locale enUS]
 *                                         [--extract map,dbc,camera] [--float-to-int 0|1]
 *   (C++ spelling: -i <client dir> -o <output dir> -e <1 map | 2 dbc | 4 camera> -f <0|1>)
 *
 * The `.map` writer is `ConvertADT`; its output is byte for byte what AzerothCore's tool writes (all the `float` math
 * is rounded with `Math.fround` where C++ stores or computes a 32 bit float).
 */
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { writeMapFileHeader } from "../../game/Grids/GridTerrainData.ts";
import { extractDbc } from "../extract-dbc.ts";
import { detectLocale } from "../mpq.ts";
import {
  ADT_CELLS_PER_GRID,
  ADT_CELL_SIZE,
  ADT_GRID_SIZE,
  ADT_file,
  LiquidType,
} from "./adt.ts";
import { DBCFile } from "./dbcfile.ts";
import { MPQFile, closeArchives, gOpenArchives, openArchives } from "./mpq_libmpq04.ts";
import { WDT_MAP_SIZE, WDT_file } from "./wdt.ts";

const F = Math.fround;

/** @ac tools/map_extractor/System.cpp map_id */
export type map_id = { name: string; id: number };

/** @ac tools/map_extractor/System.cpp LiquidTypeEntry */
export type LiquidTypeEntry = { SoundBank: number };

/** @ac tools/map_extractor/System.cpp map_ids */
export let map_ids: map_id[] = [];
/** @ac tools/map_extractor/System.cpp LiquidTypes */
export const LiquidTypes = new Map<number, LiquidTypeEntry>();
let output_path = ".";
let input_path = ".";

// **************************************************
// Extractor options
// **************************************************
/** @ac tools/map_extractor/System.cpp Extract */
export const Extract = {
  EXTRACT_MAP: 1,
  EXTRACT_DBC: 2,
  EXTRACT_CAMERA: 4,
} as const;

// Select data for extract
let CONF_extract: number = Extract.EXTRACT_MAP | Extract.EXTRACT_DBC | Extract.EXTRACT_CAMERA;
// This option allow limit minimum height to some value (Allow save some memory)
const CONF_allow_height_limit = true;
const CONF_use_minHeight = F(-500.0);

// This option allow use float to int conversion
let CONF_allow_float_to_int = true;
const CONF_float_to_int8_limit = F(2.0); // Max accuracy = val/256
const CONF_float_to_int16_limit = F(2048.0); // Max accuracy = val/65536
const CONF_flat_height_delta_limit = F(0.005); // If max - min less this value - surface is flat
const CONF_flat_liquid_delta_limit = F(0.001); // If max - min less this value - liquid surface is flat

/** @ac tools/map_extractor/System.cpp langs */
const langs = ["enGB", "enUS", "deDE", "esES", "frFR", "koKR", "zhCN", "zhTW", "enCN", "enTW", "esMX", "ruRU"] as const;

/** Log line sink (the C++ tool prints). */
let log: (line: string) => void = (line) => console.log(line);

/** @ac tools/map_extractor/System.cpp CreateDir */
async function CreateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

/** @ac tools/map_extractor/System.cpp FileExists */
function FileExists(fileName: string): boolean {
  return existsSync(fileName);
}

const USAGE = `Usage:
bun System.ts <client dir> [output dir = data] [--maps 0,1,530] [--locale enUS] [--extract map,dbc,camera]
bun System.ts -[var] [value]
-i set input path
-o set output path
-e extract only MAP(1)/DBC(2)/Camera(4) - standard: all(7)
-f height stored as int (less map size but lost some accuracy) 1 by default
--maps only these map ids (comma separated), --locale only this locale
Example: bun System.ts -f 0 -i "~/games/wow"`;

/** @ac tools/map_extractor/System.cpp Usage */
function Usage(): never {
  console.log(USAGE);
  process.exit(1);
}

export type ExtractorOptions = {
  input: string;
  output: string;
  extract: number;
  allowFloatToInt: boolean;
  /** Map ids to convert, `null` for every map in `Map.dbc` */
  maps: Set<number> | null;
  locale: string | null;
};

/** @ac tools/map_extractor/System.cpp HandleArgs */
export function HandleArgs(args: string[]): ExtractorOptions {
  const options: ExtractorOptions = { input: ".", output: "data", extract: CONF_extract, allowFloatToInt: true, maps: null, locale: null };
  const positional: string[] = [];
  for (let c = 0; c < args.length; ++c) {
    const arg = args[c]!;
    const next = (): string => {
      if (c + 1 >= args.length) Usage();
      return args[++c]!;
    };
    if (arg === "--maps") {
      options.maps = new Set(
        next()
          .split(",")
          .filter((id) => id !== "")
          .map((id) => {
            const value = Number(id);
            if (!Number.isInteger(value) || value < 0) Usage();
            return value;
          }),
      );
    } else if (arg === "--locale") {
      options.locale = next();
    } else if (arg === "--extract") {
      const names = next().split(",");
      let mask = 0;
      for (const name of names) {
        if (name === "map") mask |= Extract.EXTRACT_MAP;
        else if (name === "dbc") mask |= Extract.EXTRACT_DBC;
        else if (name === "camera") mask |= Extract.EXTRACT_CAMERA;
        else mask |= Number(name) || 0;
      }
      if (!(mask > 0 && mask < 8)) Usage();
      options.extract = mask;
    } else if (arg === "--float-to-int") {
      options.allowFloatToInt = Number(next()) !== 0;
    } else if (arg.startsWith("-") && arg.length >= 2 && !arg.startsWith("--")) {
      switch (arg[1]) {
        case "i":
          options.input = next();
          break;
        case "o":
          options.output = next();
          break;
        case "f":
          options.allowFloatToInt = Number(next()) !== 0;
          break;
        case "e": {
          const mask = Number(next());
          if (!(mask > 0 && mask < 8)) Usage();
          options.extract = mask;
          break;
        }
        default:
          Usage();
      }
    } else if (arg.startsWith("--")) {
      Usage();
    } else {
      positional.push(arg);
    }
  }
  if (positional[0] !== undefined) options.input = positional[0];
  if (positional[1] !== undefined) options.output = positional[1];
  if (positional.length > 2) Usage();
  return options;
}

/** @ac tools/map_extractor/System.cpp ReadBuild */
export function ReadBuild(locale: string): number {
  // include build info file also
  const filename = `component.wow-${locale}.txt`;

  const m = new MPQFile(filename);
  if (m.isEof()) {
    console.log(`Fatal error: Not found ${filename} file!`);
    process.exit(1);
  }

  const text = new TextDecoder().decode(m.getBuffer()!);
  m.close();

  const pos = text.indexOf('version="');
  const pos1 = pos + 'version="'.length;
  const pos2 = text.indexOf('"', pos1);
  if (pos < 0 || pos2 < 0 || pos1 >= pos2) {
    console.log(`Fatal error: Invalid  ${filename} file format!`);
    process.exit(1);
  }

  const build_str = text.substring(pos1, pos2);

  const build = Number.parseInt(build_str, 10);
  if (!(build > 0)) {
    console.log(`Fatal error: Invalid  ${filename} file format!`);
    process.exit(1);
  }

  return build;
}

/** @ac tools/map_extractor/System.cpp ReadMapDBC */
export function ReadMapDBC(): number {
  process.stdout.write("Read Map.dbc file... ");
  const dbc = new DBCFile("DBFilesClient\\Map.dbc");

  if (!dbc.open()) {
    console.log("Fatal error: Invalid Map.dbc file format!");
    process.exit(1);
  }

  const map_count = dbc.getRecordCount();
  map_ids = new Array<map_id>(map_count);
  for (let x = 0; x < map_count; ++x) {
    const record = dbc.getRecord(x);
    // strncpy(name, ..., sizeof(name) - 1)
    map_ids[x] = { id: record.getUInt(0), name: record.getString(1).slice(0, 63) };
  }
  console.log(`Done! (${map_count} maps loaded)`);
  return map_count;
}

/** @ac tools/map_extractor/System.cpp ReadLiquidTypeTableDBC */
export function ReadLiquidTypeTableDBC(): void {
  process.stdout.write("Read LiquidType.dbc file...");
  const dbc = new DBCFile("DBFilesClient\\LiquidType.dbc");
  if (!dbc.open()) {
    console.log("Fatal error: Invalid LiquidType.dbc file format!");
    process.exit(1);
  }

  LiquidTypes.clear();
  for (let x = 0; x < dbc.getRecordCount(); ++x) {
    const record = dbc.getRecord(x);
    LiquidTypes.set(record.getUInt(0), { SoundBank: record.getUInt(3) & 0xff });
  }

  console.log(`Done! (${LiquidTypes.size} LiquidTypes loaded)`);
}

//
// Adt file convertor function and data
//

// Map file format data
/** @ac tools/map_extractor/System.cpp MAP_MAGIC */
const MAP_MAGIC = "MAPS";
/** @ac tools/map_extractor/System.cpp MAP_VERSION_MAGIC */
const MAP_VERSION_MAGIC = 9;
const MAP_AREA_MAGIC = "AREA";
const MAP_HEIGHT_MAGIC = "MHGT";
const MAP_LIQUID_MAGIC = "MLIQ";

/** `*reinterpret_cast<uint32 const*>("MAPS")` */
function fourcc(text: string): number {
  return (text.charCodeAt(0) | (text.charCodeAt(1) << 8) | (text.charCodeAt(2) << 16) | (text.charCodeAt(3) << 24)) >>> 0;
}

/** `sizeof(map_fileheader)`, `sizeof(map_areaHeader)`, ... (`GridTerrainData.ts` has the same layout for the reader) */
const sizeof_map_fileheader = 44;
const sizeof_map_areaHeader = 8;
const sizeof_map_heightHeader = 16;
const sizeof_map_liquidHeader = 16;

const MAP_AREA_NO_AREA = 0x0001;

const MAP_HEIGHT_NO_HEIGHT = 0x0001;
const MAP_HEIGHT_AS_INT16 = 0x0002;
const MAP_HEIGHT_AS_INT8 = 0x0004;
const MAP_HEIGHT_HAS_FLIGHT_BOUNDS = 0x0008;

const MAP_LIQUID_TYPE_NO_WATER = 0x00;
const MAP_LIQUID_TYPE_WATER = 0x01;
const MAP_LIQUID_TYPE_OCEAN = 0x02;
const MAP_LIQUID_TYPE_MAGMA = 0x04;
const MAP_LIQUID_TYPE_SLIME = 0x08;

const MAP_LIQUID_TYPE_DARK_WATER = 0x10;

const MAP_LIQUID_NO_TYPE = 0x0001;
const MAP_LIQUID_NO_HEIGHT = 0x0002;

/** @ac tools/map_extractor/System.cpp selectUInt8StepStore */
function selectUInt8StepStore(maxDiff: number): number {
  return F(255 / maxDiff);
}

/** @ac tools/map_extractor/System.cpp selectUInt16StepStore */
function selectUInt16StepStore(maxDiff: number): number {
  return F(65535 / maxDiff);
}

// Temporary grid data store (module globals like the C++ ones; typed arrays store 32 bit floats)
const area_ids = new Uint16Array(ADT_CELLS_PER_GRID * ADT_CELLS_PER_GRID);

const V8 = new Float32Array(ADT_GRID_SIZE * ADT_GRID_SIZE);
const V9 = new Float32Array((ADT_GRID_SIZE + 1) * (ADT_GRID_SIZE + 1));
const uint16_V8 = new Uint16Array(ADT_GRID_SIZE * ADT_GRID_SIZE);
const uint16_V9 = new Uint16Array((ADT_GRID_SIZE + 1) * (ADT_GRID_SIZE + 1));
const uint8_V8 = new Uint8Array(ADT_GRID_SIZE * ADT_GRID_SIZE);
const uint8_V9 = new Uint8Array((ADT_GRID_SIZE + 1) * (ADT_GRID_SIZE + 1));

const liquid_entry = new Uint16Array(ADT_CELLS_PER_GRID * ADT_CELLS_PER_GRID);
const liquid_flags = new Uint8Array(ADT_CELLS_PER_GRID * ADT_CELLS_PER_GRID);
const liquid_show = new Uint8Array(ADT_GRID_SIZE * ADT_GRID_SIZE);
const liquid_height = new Float32Array((ADT_GRID_SIZE + 1) * (ADT_GRID_SIZE + 1));
const holes = new Uint16Array(ADT_CELLS_PER_GRID * ADT_CELLS_PER_GRID);

const flight_box_max = new Int16Array(9);
const flight_box_min = new Int16Array(9);

const G9 = ADT_GRID_SIZE + 1;
const G8 = ADT_GRID_SIZE;

/** Copies the bytes of a typed array to `out` at `at` (alignment free). */
function putBytes(out: Uint8Array, at: number, array: Uint8Array | Uint16Array | Int16Array | Float32Array): number {
  out.set(new Uint8Array(array.buffer, array.byteOffset, array.byteLength), at);
  return at + array.byteLength;
}

/**
 * Builds the `.map` file of an already loaded ADT (the body of `ConvertADT` up to the `fopen`). Returns the file
 * bytes, or `null` when the ADT has no `MCIN`.
 *
 * @ac tools/map_extractor/System.cpp ConvertADT
 */
export function convertADTData(adt: ADT_file, inputPath: string, build: number): Uint8Array | null {
  const cells = adt.a_grid!.getMCIN();
  if (!cells) {
    console.log(`Can't find cells in '${inputPath}'`);
    return null;
  }

  liquid_show.fill(0);
  liquid_flags.fill(0);
  liquid_entry.fill(0);

  holes.fill(0);

  // Prepare map header
  const map = {
    mapMagic: fourcc(MAP_MAGIC),
    versionMagic: MAP_VERSION_MAGIC,
    buildMagic: build,
    areaMapOffset: 0,
    areaMapSize: 0,
    heightMapOffset: 0,
    heightMapSize: 0,
    liquidMapOffset: 0,
    liquidMapSize: 0,
    holesOffset: 0,
    holesSize: 0,
  };

  // Get area flags data (a cell the file does not have counts as area 0; C++ dereferences a null pointer there)
  for (let i = 0; i < ADT_CELLS_PER_GRID; i++)
    for (let j = 0; j < ADT_CELLS_PER_GRID; j++) area_ids[i * ADT_CELLS_PER_GRID + j] = cells.getMCNK(i, j)?.areaid ?? 0;

  //============================================
  // Try pack area data
  //============================================
  let fullAreaData = false;
  const areaId = area_ids[0]!;
  for (let i = 0; i < area_ids.length; ++i) {
    if (area_ids[i] !== areaId) {
      fullAreaData = true;
      break;
    }
  }

  map.areaMapOffset = sizeof_map_fileheader;
  map.areaMapSize = sizeof_map_areaHeader;

  const areaHeader = { fourcc: fourcc(MAP_AREA_MAGIC), flags: 0, gridArea: 0 };
  if (fullAreaData) {
    areaHeader.gridArea = 0;
    map.areaMapSize += area_ids.byteLength;
  } else {
    areaHeader.flags |= MAP_AREA_NO_AREA;
    areaHeader.gridArea = areaId & 0xffff;
  }

  //
  // Get Height map from grid
  //
  for (let i = 0; i < ADT_CELLS_PER_GRID; i++) {
    for (let j = 0; j < ADT_CELLS_PER_GRID; j++) {
      const cell = cells.getMCNK(i, j);
      if (!cell) continue;
      // Height values for triangles stored in order:
      // 1     2     3     4     5     6     7     8     9
      //    10    11    12    13    14    15    16    17
      // 18    19    20    21    22    23    24    25    26
      //    27    28    29    30    31    32    33    34
      // . . . . . . . .
      // For better get height values merge it to V9 and V8 map
      // V9 height map:
      // 1     2     3     4     5     6     7     8     9
      // 18    19    20    21    22    23    24    25    26
      // . . . . . . . .
      // V8 height map:
      //    10    11    12    13    14    15    16    17
      //    27    28    29    30    31    32    33    34
      // . . . . . . . .

      // Set map height as grid height
      const ypos = cell.ypos;
      for (let y = 0; y <= ADT_CELL_SIZE; y++) {
        const cy = i * ADT_CELL_SIZE + y;
        for (let x = 0; x <= ADT_CELL_SIZE; x++) {
          const cx = j * ADT_CELL_SIZE + x;
          V9[cy * G9 + cx] = ypos;
        }
      }
      for (let y = 0; y < ADT_CELL_SIZE; y++) {
        const cy = i * ADT_CELL_SIZE + y;
        for (let x = 0; x < ADT_CELL_SIZE; x++) {
          const cx = j * ADT_CELL_SIZE + x;
          V8[cy * G8 + cx] = ypos;
        }
      }
      // Get custom height
      const v = cell.getMCVT();
      if (!v) continue;
      // get V9 height map
      for (let y = 0; y <= ADT_CELL_SIZE; y++) {
        const cy = i * ADT_CELL_SIZE + y;
        for (let x = 0; x <= ADT_CELL_SIZE; x++) {
          const cx = j * ADT_CELL_SIZE + x;
          V9[cy * G9 + cx] = V9[cy * G9 + cx]! + v.height_map(y * (ADT_CELL_SIZE * 2 + 1) + x);
        }
      }
      // get V8 height map
      for (let y = 0; y < ADT_CELL_SIZE; y++) {
        const cy = i * ADT_CELL_SIZE + y;
        for (let x = 0; x < ADT_CELL_SIZE; x++) {
          const cx = j * ADT_CELL_SIZE + x;
          V8[cy * G8 + cx] = V8[cy * G8 + cx]! + v.height_map(y * (ADT_CELL_SIZE * 2 + 1) + ADT_CELL_SIZE + 1 + x);
        }
      }
    }
  }
  //============================================
  // Try pack height data
  //============================================
  let maxHeight = F(-20000);
  let minHeight = F(20000);
  for (let k = 0; k < V8.length; k++) {
    const h = V8[k]!;
    if (maxHeight < h) maxHeight = h;
    if (minHeight > h) minHeight = h;
  }
  for (let k = 0; k < V9.length; k++) {
    const h = V9[k]!;
    if (maxHeight < h) maxHeight = h;
    if (minHeight > h) minHeight = h;
  }

  // Check for allow limit minimum height (not store height in deep ochean - allow save some memory)
  if (CONF_allow_height_limit && minHeight < CONF_use_minHeight) {
    for (let k = 0; k < V8.length; k++) if (V8[k]! < CONF_use_minHeight) V8[k] = CONF_use_minHeight;
    for (let k = 0; k < V9.length; k++) if (V9[k]! < CONF_use_minHeight) V9[k] = CONF_use_minHeight;
    if (minHeight < CONF_use_minHeight) minHeight = CONF_use_minHeight;
    if (maxHeight < CONF_use_minHeight) maxHeight = CONF_use_minHeight;
  }

  let hasFlightBox = false;
  const mfbo = adt.a_grid!.getMFBO();
  if (mfbo) {
    for (let k = 0; k < 9; k++) {
      flight_box_max[k] = mfbo.maxCoord(k);
      flight_box_min[k] = mfbo.minCoord(k);
    }
    hasFlightBox = true;
  }

  map.heightMapOffset = map.areaMapOffset + map.areaMapSize;
  map.heightMapSize = sizeof_map_heightHeader;

  const heightHeader = { fourcc: fourcc(MAP_HEIGHT_MAGIC), flags: 0, gridHeight: minHeight, gridMaxHeight: maxHeight };

  if (maxHeight === minHeight) heightHeader.flags |= MAP_HEIGHT_NO_HEIGHT;

  // Not need store if flat surface
  if (CONF_allow_float_to_int && F(maxHeight - minHeight) < CONF_flat_height_delta_limit) heightHeader.flags |= MAP_HEIGHT_NO_HEIGHT;

  if (hasFlightBox) {
    heightHeader.flags |= MAP_HEIGHT_HAS_FLIGHT_BOUNDS;
    map.heightMapSize += flight_box_max.byteLength + flight_box_min.byteLength;
  }

  // Try store as packed in uint16 or uint8 values
  if (!(heightHeader.flags & MAP_HEIGHT_NO_HEIGHT)) {
    let step = 0;
    // Try Store as uint values
    if (CONF_allow_float_to_int) {
      const diff = F(maxHeight - minHeight);
      if (diff < CONF_float_to_int8_limit) {
        // As uint8 (max accuracy = CONF_float_to_int8_limit/256)
        heightHeader.flags |= MAP_HEIGHT_AS_INT8;
        step = selectUInt8StepStore(diff);
      } else if (diff < CONF_float_to_int16_limit) {
        // As uint16 (max accuracy = CONF_float_to_int16_limit/65536)
        heightHeader.flags |= MAP_HEIGHT_AS_INT16;
        step = selectUInt16StepStore(diff);
      }
    }

    // Pack it to int values if need
    if (heightHeader.flags & MAP_HEIGHT_AS_INT8) {
      for (let k = 0; k < V8.length; k++) uint8_V8[k] = F(F(F(V8[k]! - minHeight) * step) + 0.5);
      for (let k = 0; k < V9.length; k++) uint8_V9[k] = F(F(F(V9[k]! - minHeight) * step) + 0.5);
      map.heightMapSize += uint8_V9.byteLength + uint8_V8.byteLength;
    } else if (heightHeader.flags & MAP_HEIGHT_AS_INT16) {
      for (let k = 0; k < V8.length; k++) uint16_V8[k] = F(F(F(V8[k]! - minHeight) * step) + 0.5);
      for (let k = 0; k < V9.length; k++) uint16_V9[k] = F(F(F(V9[k]! - minHeight) * step) + 0.5);
      map.heightMapSize += uint16_V9.byteLength + uint16_V8.byteLength;
    } else map.heightMapSize += V9.byteLength + V8.byteLength;
  }

  // Get from MCLQ chunk (old)
  for (let i = 0; i < ADT_CELLS_PER_GRID; i++) {
    for (let j = 0; j < ADT_CELLS_PER_GRID; j++) {
      const cell = cells.getMCNK(i, j);
      if (!cell) continue;

      const liquid = cell.getMCLQ();
      let count = 0;
      if (!liquid || cell.sizeMCLQ <= 8) continue;

      const ij = i * ADT_CELLS_PER_GRID + j;
      for (let y = 0; y < ADT_CELL_SIZE; y++) {
        const cy = i * ADT_CELL_SIZE + y;
        for (let x = 0; x < ADT_CELL_SIZE; x++) {
          const cx = j * ADT_CELL_SIZE + x;
          const flags = liquid.flags(y, x);
          if (flags !== 0x0f) {
            liquid_show[cy * G8 + cx] = 1;
            if (flags & (1 << 7)) liquid_flags[ij] = liquid_flags[ij]! | MAP_LIQUID_TYPE_DARK_WATER;
            ++count;
          }
        }
      }

      const c_flag = cell.flags;
      if (c_flag & (1 << 2)) {
        liquid_entry[ij] = 1;
        liquid_flags[ij] = liquid_flags[ij]! | MAP_LIQUID_TYPE_WATER; // water
      }
      if (c_flag & (1 << 3)) {
        liquid_entry[ij] = 2;
        liquid_flags[ij] = liquid_flags[ij]! | MAP_LIQUID_TYPE_OCEAN; // ocean
      }
      if (c_flag & (1 << 4)) {
        liquid_entry[ij] = 3;
        liquid_flags[ij] = liquid_flags[ij]! | MAP_LIQUID_TYPE_MAGMA; // magma/slime
      }

      if (!count && liquid_flags[ij]) console.error("Wrong liquid detect in MCLQ chunk");

      for (let y = 0; y <= ADT_CELL_SIZE; y++) {
        const cy = i * ADT_CELL_SIZE + y;
        for (let x = 0; x <= ADT_CELL_SIZE; x++) {
          const cx = j * ADT_CELL_SIZE + x;
          liquid_height[cy * G9 + cx] = liquid.liquidHeight(y, x);
        }
      }
    }
  }

  // Get liquid map for grid (in WOTLK used MH2O chunk)
  const h2o = adt.a_grid!.getMH2O();
  if (h2o) {
    for (let i = 0; i < ADT_CELLS_PER_GRID; i++) {
      for (let j = 0; j < ADT_CELLS_PER_GRID; j++) {
        const h = h2o.GetLiquidInstance(i, j);
        if (!h) continue;

        const attrs = h2o.GetLiquidAttributes(i, j);
        const ij = i * ADT_CELLS_PER_GRID + j;

        let count = 0;
        let existsMask = h2o.GetLiquidExistsBitmap(h);
        const hHeight = h.GetHeight();
        const hWidth = h.GetWidth();
        const hOffsetX = h.GetOffsetX();
        const hOffsetY = h.GetOffsetY();
        for (let y = 0; y < hHeight; y++) {
          const cy = i * ADT_CELL_SIZE + y + hOffsetY;
          for (let x = 0; x < hWidth; x++) {
            const cx = j * ADT_CELL_SIZE + x + hOffsetX;
            if (existsMask & 1n) {
              liquid_show[cy * G8 + cx] = 1;
              ++count;
            }
            existsMask >>= 1n;
          }
        }

        liquid_entry[ij] = h.LiquidType;
        const liquidType = LiquidTypes.get(h.LiquidType);
        if (!liquidType) throw new Error(`_Map_base::at: liquid type ${h.LiquidType} is not in LiquidType.dbc (${inputPath} chunk ${i},${j})`);
        switch (liquidType.SoundBank) {
          case LiquidType.LIQUID_TYPE_WATER:
            liquid_flags[ij] = liquid_flags[ij]! | MAP_LIQUID_TYPE_WATER;
            break;
          case LiquidType.LIQUID_TYPE_OCEAN:
            liquid_flags[ij] = liquid_flags[ij]! | MAP_LIQUID_TYPE_OCEAN;
            if (attrs.Deep) liquid_flags[ij] = liquid_flags[ij]! | MAP_LIQUID_TYPE_DARK_WATER;
            break;
          case LiquidType.LIQUID_TYPE_MAGMA:
            liquid_flags[ij] = liquid_flags[ij]! | MAP_LIQUID_TYPE_MAGMA;
            break;
          case LiquidType.LIQUID_TYPE_SLIME:
            liquid_flags[ij] = liquid_flags[ij]! | MAP_LIQUID_TYPE_SLIME;
            break;
          default:
            console.log(`\nCan't find Liquid type ${h.LiquidType} for map ${inputPath}\nchunk ${i},${j}`);
            break;
        }

        if (!count && liquid_flags[ij]) console.log("Wrong liquid detect in MH2O chunk");

        let pos = 0;
        for (let y = 0; y <= hHeight; y++) {
          const cy = i * ADT_CELL_SIZE + y + hOffsetY;
          for (let x = 0; x <= hWidth; x++) {
            const cx = j * ADT_CELL_SIZE + x + hOffsetX;
            liquid_height[cy * G9 + cx] = h2o.GetLiquidHeight(h, pos);

            pos++;
          }
        }
      }
    }
  }
  //============================================
  // Pack liquid data
  //============================================
  const firstLiquidType = liquid_entry[0]!;
  const firstLiquidFlag = liquid_flags[0]!;
  let fullType = false;
  for (let y = 0; y < ADT_CELLS_PER_GRID && !fullType; y++) {
    for (let x = 0; x < ADT_CELLS_PER_GRID; x++) {
      if (liquid_entry[y * ADT_CELLS_PER_GRID + x] !== firstLiquidType || liquid_flags[y * ADT_CELLS_PER_GRID + x] !== firstLiquidFlag) {
        fullType = true;
        break;
      }
    }
  }

  const liquidHeader = { fourcc: 0, flags: 0, liquidFlags: 0, liquidType: 0, offsetX: 0, offsetY: 0, width: 0, height: 0, liquidLevel: 0 };

  // no water data (if all grid have 0 liquid type)
  if (firstLiquidFlag === 0 && !fullType) {
    // No liquid data
    map.liquidMapOffset = 0;
    map.liquidMapSize = 0;
  } else {
    let minX = 255;
    let minY = 255;
    let maxX = 0;
    let maxY = 0;
    maxHeight = F(-20000);
    minHeight = F(20000);
    for (let y = 0; y < ADT_GRID_SIZE; y++) {
      for (let x = 0; x < ADT_GRID_SIZE; x++) {
        if (liquid_show[y * G8 + x]) {
          if (minX > x) minX = x;
          if (maxX < x) maxX = x;
          if (minY > y) minY = y;
          if (maxY < y) maxY = y;
          const h = liquid_height[y * G9 + x]!;
          if (maxHeight < h) maxHeight = h;
          if (minHeight > h) minHeight = h;
        } else {
          liquid_height[y * G9 + x] = CONF_use_minHeight;

          if (minHeight > CONF_use_minHeight) {
            minHeight = CONF_use_minHeight;
          }
        }
      }
    }
    map.liquidMapOffset = map.heightMapOffset + map.heightMapSize;
    map.liquidMapSize = sizeof_map_liquidHeader;
    liquidHeader.fourcc = fourcc(MAP_LIQUID_MAGIC);
    liquidHeader.flags = 0;
    liquidHeader.liquidType = 0;
    liquidHeader.offsetX = minX & 0xff;
    liquidHeader.offsetY = minY & 0xff;
    liquidHeader.width = (maxX - minX + 1 + 1) & 0xff;
    liquidHeader.height = (maxY - minY + 1 + 1) & 0xff;
    liquidHeader.liquidLevel = minHeight;

    if (maxHeight === minHeight) liquidHeader.flags |= MAP_LIQUID_NO_HEIGHT;

    // Not need store if flat surface
    if (CONF_allow_float_to_int && F(maxHeight - minHeight) < CONF_flat_liquid_delta_limit) liquidHeader.flags |= MAP_LIQUID_NO_HEIGHT;

    if (!fullType) liquidHeader.flags |= MAP_LIQUID_NO_TYPE;

    if (liquidHeader.flags & MAP_LIQUID_NO_TYPE) {
      liquidHeader.liquidFlags = firstLiquidFlag;
      liquidHeader.liquidType = firstLiquidType;
    } else map.liquidMapSize += liquid_entry.byteLength + liquid_flags.byteLength;

    if (!(liquidHeader.flags & MAP_LIQUID_NO_HEIGHT)) map.liquidMapSize += 4 * liquidHeader.width * liquidHeader.height;
  }

  let hasHoles = false;

  for (let i = 0; i < ADT_CELLS_PER_GRID; ++i) {
    for (let j = 0; j < ADT_CELLS_PER_GRID; ++j) {
      const cell = cells.getMCNK(i, j);
      if (!cell) continue;
      const cellHoles = cell.holes;
      holes[i * ADT_CELLS_PER_GRID + j] = cellHoles;
      if (!hasHoles && cellHoles !== 0) hasHoles = true;
    }
  }

  if (hasHoles) {
    if (map.liquidMapOffset) map.holesOffset = map.liquidMapOffset + map.liquidMapSize;
    else map.holesOffset = map.heightMapOffset + map.heightMapSize;

    map.holesSize = holes.byteLength;
  } else {
    map.holesOffset = 0;
    map.holesSize = 0;
  }

  // Ok all data prepared - store it
  const total = (hasHoles ? map.holesOffset + map.holesSize : map.liquidMapOffset ? map.liquidMapOffset + map.liquidMapSize : map.heightMapOffset + map.heightMapSize);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  writeMapFileHeader(view, 0, map);
  let at = sizeof_map_fileheader;

  // Store area data
  view.setUint32(at, areaHeader.fourcc, true);
  view.setUint16(at + 4, areaHeader.flags, true);
  view.setUint16(at + 6, areaHeader.gridArea, true);
  at += sizeof_map_areaHeader;
  if (!(areaHeader.flags & MAP_AREA_NO_AREA)) at = putBytes(out, at, area_ids);

  // Store height data
  view.setUint32(at, heightHeader.fourcc, true);
  view.setUint32(at + 4, heightHeader.flags, true);
  view.setFloat32(at + 8, heightHeader.gridHeight, true);
  view.setFloat32(at + 12, heightHeader.gridMaxHeight, true);
  at += sizeof_map_heightHeader;
  if (!(heightHeader.flags & MAP_HEIGHT_NO_HEIGHT)) {
    if (heightHeader.flags & MAP_HEIGHT_AS_INT16) {
      at = putBytes(out, at, uint16_V9);
      at = putBytes(out, at, uint16_V8);
    } else if (heightHeader.flags & MAP_HEIGHT_AS_INT8) {
      at = putBytes(out, at, uint8_V9);
      at = putBytes(out, at, uint8_V8);
    } else {
      at = putBytes(out, at, V9);
      at = putBytes(out, at, V8);
    }
  }

  if (heightHeader.flags & MAP_HEIGHT_HAS_FLIGHT_BOUNDS) {
    at = putBytes(out, at, flight_box_max);
    at = putBytes(out, at, flight_box_min);
  }

  // Store liquid data if need
  if (map.liquidMapOffset) {
    view.setUint32(at, liquidHeader.fourcc, true);
    view.setUint8(at + 4, liquidHeader.flags);
    view.setUint8(at + 5, liquidHeader.liquidFlags);
    view.setUint16(at + 6, liquidHeader.liquidType, true);
    view.setUint8(at + 8, liquidHeader.offsetX);
    view.setUint8(at + 9, liquidHeader.offsetY);
    view.setUint8(at + 10, liquidHeader.width);
    view.setUint8(at + 11, liquidHeader.height);
    view.setFloat32(at + 12, liquidHeader.liquidLevel, true);
    at += sizeof_map_liquidHeader;
    if (!(liquidHeader.flags & MAP_LIQUID_NO_TYPE)) {
      at = putBytes(out, at, liquid_entry);
      at = putBytes(out, at, liquid_flags);
    }
    if (!(liquidHeader.flags & MAP_LIQUID_NO_HEIGHT)) {
      for (let y = 0; y < liquidHeader.height; y++) {
        const row = (y + liquidHeader.offsetY) * G9 + liquidHeader.offsetX;
        // C++ reads the 129 * 129 array out of bounds for a rectangle that does not fit (no liquid shown at all)
        if (row + liquidHeader.width <= liquid_height.length) {
          at = putBytes(out, at, liquid_height.subarray(row, row + liquidHeader.width));
        } else {
          at += 4 * liquidHeader.width;
        }
      }
    }
  }

  // store hole data
  if (hasHoles) at = putBytes(out, at, holes);

  return out;
}

/**
 * Loads `inputPath` from the archives, converts it and writes `outputPath` (one `Bun.write`).
 *
 * @ac tools/map_extractor/System.cpp ConvertADT
 */
export async function ConvertADT(inputPath: string, outputPath: string, _cell_y: number, _cell_x: number, build: number): Promise<boolean> {
  const adt = new ADT_file();

  if (!adt.loadFile(inputPath)) return false;

  const bytes = convertADTData(adt, inputPath, build);
  adt.free();
  if (!bytes) return false;

  try {
    await Bun.write(outputPath, bytes);
  } catch {
    console.log(`Can't create the output file '${outputPath}'`);
    return false;
  }
  return true;
}

export type ExtractStats = { maps: number; tiles: number; failed: number; bytes: number };

/** @ac tools/map_extractor/System.cpp ExtractMapsFromMpq */
export async function ExtractMapsFromMpq(build: number, mapFilter: Set<number> | null = null): Promise<ExtractStats> {
  const stats: ExtractStats = { maps: 0, tiles: 0, failed: 0, bytes: 0 };
  console.log("Extracting maps...");

  const map_count = ReadMapDBC();

  ReadLiquidTypeTableDBC();

  const path = `${output_path}/maps/`;
  await CreateDir(path);

  console.log("Convert map files");
  for (let z = 0; z < map_count; ++z) {
    const map = map_ids[z]!;
    if (mapFilter && !mapFilter.has(map.id)) continue;
    const started = performance.now();
    // Loadup map grid data
    const mpqMapName = `World\\Maps\\${map.name}\\${map.name}.wdt`;
    const wdt = new WDT_file();
    if (!wdt.loadFile(mpqMapName, false)) {
      //            printf("Error loading %s map wdt data\n", map_ids[z].name);
      log(`Extract ${map.name} (${z + 1}/${map_count}) id ${map.id}: no wdt`);
      continue;
    }

    let tiles = 0;
    let failed = 0;
    let bytes = 0;
    for (let y = 0; y < WDT_MAP_SIZE; ++y) {
      for (let x = 0; x < WDT_MAP_SIZE; ++x) {
        if (!wdt.main!.exist(y, x)) continue;
        const mpqFileName = `World\\Maps\\${map.name}\\${map.name}_${x}_${y}.adt`;
        const outputFileName = `${output_path}/maps/${String(map.id).padStart(3, "0")}${String(y).padStart(2, "0")}${String(x).padStart(2, "0")}.map`;
        if (await ConvertADT(mpqFileName, outputFileName, y, x, build)) {
          tiles++;
          bytes += Bun.file(outputFileName).size;
        } else failed++;
      }
    }
    wdt.free();
    stats.maps++;
    stats.tiles += tiles;
    stats.failed += failed;
    stats.bytes += bytes;
    log(`Extract ${map.name} (${z + 1}/${map_count}) id ${map.id}: ${tiles} tiles, ${failed} failed, ${bytes} bytes, ${((performance.now() - started) / 1000).toFixed(1)}s`);
  }
  console.log("");
  return stats;
}

/** @ac tools/map_extractor/System.cpp ExtractFile */
async function ExtractFile(mpq_name: string, filename: string): Promise<boolean> {
  const m = new MPQFile(mpq_name);
  try {
    // fopen("wb") creates the file even when the archives do not have it; fwrite writes the body
    await Bun.write(filename, m.isEof() ? new Uint8Array(0) : m.getBuffer()!);
  } catch {
    console.log(`Can't create the output file '${filename}'`);
    return false;
  }
  m.close();
  return true;
}

/**
 * The C++ `ExtractDBCFiles` for one locale. `src/tools/extract-dbc.ts` is the implementation for the basic locale
 * (it writes the same `dbc/*.dbc` from the same archives); this one writes the other locales to `dbc/<locale>/` and
 * the `component.wow-<locale>.txt` build info of every locale.
 *
 * @ac tools/map_extractor/System.cpp ExtractDBCFiles
 */
async function ExtractDBCFiles(locale: string, basicLocale: boolean, useExtractDbc: boolean): Promise<void> {
  console.log("Extracting dbc files...");

  let path = `${output_path}/dbc/`;
  await CreateDir(path);
  if (!basicLocale) {
    path += `${locale}/`;
    await CreateDir(path);
  }

  if (basicLocale && useExtractDbc) {
    // `map_extractor` skips files that already exist; extract-dbc.ts overwrites them with the same bytes
    await extractDbc(input_path, path, (line) => console.log(line));
  } else {
    const chain = gOpenArchives.chain!;
    // get DBC file list
    const dbcfiles = chain.list(/^dbfilesclient\\.*\.dbc$/);
    let count = 0;
    for (const dbcfile of dbcfiles) {
      const filename = path + dbcfile.slice("DBFilesClient\\".length);
      if (FileExists(filename)) continue;
      if (await ExtractFile(dbcfile, filename)) ++count;
    }
    console.log(`Extracted ${count} DBC files\n`);
  }

  // extract Build info file
  {
    const mpq_name = `component.wow-${locale}.txt`;
    await ExtractFile(mpq_name, path + mpq_name);
  }
}

/** @ac tools/map_extractor/System.cpp ExtractCameraFiles */
export async function ExtractCameraFiles(locale: string, basicLocale: boolean): Promise<number> {
  console.log("Extracting camera files...");
  const camdbc = new DBCFile("DBFilesClient\\CinematicCamera.dbc");

  if (!camdbc.open()) {
    console.log("Unable to open CinematicCamera.dbc. Camera extract aborted.");
    return 0;
  }

  // get camera file list from DBC
  const camerafiles: string[] = [];
  const cam_count = camdbc.getRecordCount();

  for (let i = 0; i < cam_count; ++i) {
    let camFile = camdbc.getRecord(i).getString(1);
    const loc = camFile.indexOf(".mdx");
    if (loc >= 0) {
      camFile = camFile.slice(0, loc) + ".m2" + camFile.slice(loc + 4);
    }
    camerafiles.push(camFile);
  }

  let path = `${output_path}/Cameras/`;
  await CreateDir(path);
  if (!basicLocale) {
    path += `${locale}/`;
    await CreateDir(path);
  }

  // extract M2s
  let count = 0;
  for (const thisFile of camerafiles) {
    const filename = path + thisFile.slice("Cameras\\".length);

    if (existsSync(filename)) {
      continue;
    }

    if (await ExtractFile(thisFile, filename)) {
      ++count;
    }
  }
  console.log(`Extracted ${count} camera files`);
  return count;
}

export type MapExtractorResult = { build: number; locale: string; maps: ExtractStats | null; seconds: number };

/**
 * `main` of `System.cpp`.
 *
 * @ac tools/map_extractor/System.cpp main
 */
export async function main(args: string[]): Promise<MapExtractorResult | null> {
  console.log("Map & DBC Extractor");
  console.log("===================\n");

  const options = HandleArgs(args);
  input_path = options.input;
  output_path = options.output.replace(/\/+$/, "") || ".";
  CONF_extract = options.extract;
  CONF_allow_float_to_int = options.allowFloatToInt;
  const started = performance.now();

  const dataDir = existsSync(join(input_path, "Data")) ? join(input_path, "Data") : input_path;
  const basicLocale = detectLocale(dataDir);

  let FirstLocale: string | null = null;
  let build = 0;

  for (const lang of langs) {
    if (options.locale && lang !== options.locale) continue;
    if (!FileExists(join(dataDir, lang, `locale-${lang}.MPQ`))) continue;
    console.log(`Detected locale: ${lang}`);

    //Open MPQs
    await openArchives(input_path, lang);

    if ((CONF_extract & Extract.EXTRACT_DBC) === 0) {
      FirstLocale = lang;
      build = ReadBuild(FirstLocale);
      console.log(`Detected client build: ${build}`);
      break;
    }

    //Extract DBC files
    if (FirstLocale === null) {
      FirstLocale = lang;
      build = ReadBuild(FirstLocale);
      console.log(`Detected client build: ${build}`);
      await ExtractDBCFiles(lang, true, lang === basicLocale);
    } else await ExtractDBCFiles(lang, false, false);

    //Close MPQs
    closeArchives();
  }

  if (FirstLocale === null) {
    console.log("No locales detected");
    return null;
  }

  if (CONF_extract & Extract.EXTRACT_CAMERA) {
    console.log(`Using locale: ${FirstLocale}`);

    // Open MPQs
    await openArchives(input_path, FirstLocale);

    await ExtractCameraFiles(FirstLocale, true);
    // Close MPQs
    closeArchives();
  }

  let maps: ExtractStats | null = null;
  if (CONF_extract & Extract.EXTRACT_MAP) {
    console.log(`Using locale: ${FirstLocale}`);

    // Open MPQs
    await openArchives(input_path, FirstLocale);

    // Extract maps
    maps = await ExtractMapsFromMpq(build, options.maps);

    // Close MPQs
    closeArchives();
  }

  const seconds = (performance.now() - started) / 1000;
  if (maps) console.log(`Converted ${maps.tiles} tiles of ${maps.maps} maps (${maps.failed} failed), ${(maps.bytes / 1e6).toFixed(1)} MB in ${seconds.toFixed(1)}s`);
  return { build, locale: FirstLocale, maps, seconds };
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
