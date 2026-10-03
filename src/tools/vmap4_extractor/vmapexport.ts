import { existsSync, mkdirSync } from "node:fs";
import { MpqChain } from "../mpq.ts";
import { ADTFile, GetPlainName, fixPlainName } from "./adtfile.ts";
import { DBCFile } from "./dbcfile.ts";
import { FileWriter, fileExists, readVertexCountAt8, removeFile } from "./fileio.ts";
import { gOpenArchives } from "./mpq_libmpq04.ts";
import { WDTFile } from "./wdtfile.ts";
import { WMOGroup, WMORoot, type WMODoodadData } from "./wmo.ts";

export { ExtractGameobjectModels, ExtractSingleModel } from "./gameobject_extract.ts";
export { fileExists as FileExists };
import { ExtractGameobjectModels } from "./gameobject_extract.ts";

/**
 * `main` and the helpers of the vmap4 extractor.
 *
 * @ac tools/vmap4_extractor/vmapexport.h VMAP::VMAP_MAGIC
 * @ac tools/vmap4_extractor/vmapexport.h VMAP::RAW_VMAP_MAGIC
 * @ac tools/vmap4_extractor/vmapexport.h ModelFlags
 */
export const VMAP_MAGIC = "VMAP_4.8";
/** Used in extracted vmap files with raw data (8 bytes with the terminating NUL, as `fwrite(RAW_VMAP_MAGIC, 1, 8)`). */
export const RAW_VMAP_MAGIC = "VMAP048";

export const MOD_M2 = 1;
export const MOD_WORLDSPAWN = 1 << 1;
export const MOD_HAS_BOUND = 1 << 2;

/** A C++ `std::string&` the callee edits in place. */
export interface MutableString {
  value: string;
}

/** The C++ `printf` + `exit(1)` of the fatal paths. */
export class FatalError extends Error {}

/**
 * The file scope variables of `vmapexport.cpp` (`szWorkDirWmo`, `WmoDoodads`, `preciseVectorData`, ...).
 *
 * @ac tools/vmap4_extractor/vmapexport.cpp szWorkDirWmo
 * @ac tools/vmap4_extractor/vmapexport.cpp WmoDoodads
 * @ac tools/vmap4_extractor/vmapexport.cpp preciseVectorData
 */
export const globals = {
  /** `szWorkDirWmo`: the output directory (`./Buildings` in the C++, relative to the working directory). */
  szWorkDirWmo: "./Buildings",
  WmoDoodads: new Map<string, WMODoodadData>(),
  preciseVectorData: false,
};

const uniqueObjectIds = new Map<number, number>();

/**
 * Stable ids for (client id, doodad id) pairs, in first use order starting at 1.
 *
 * @ac tools/vmap4_extractor/vmapexport.cpp GenerateUniqueObjectId
 */
export function GenerateUniqueObjectId(clientId: number, clientDoodadId: number): number {
  // clientId < 2^32 and clientDoodadId < 2^16, so the product key is exact in a double
  const key = clientId * 65536 + clientDoodadId;
  let id = uniqueObjectIds.get(key);
  if (id === undefined) {
    id = uniqueObjectIds.size + 1;
    uniqueObjectIds.set(key, id);
  }
  return id;
}

/** Test hook: the C++ `uniqueObjectIds` / `WmoDoodads` start empty in every process. */
export function resetExtractorState(): void {
  uniqueObjectIds.clear();
  globals.WmoDoodads.clear();
  modelVertexCounts.clear();
}

/**
 * The vertex count at offset 8 of an extracted model file. C++ (`Doodad::Extract`, `MapObject::Extract`) reopens the
 * file for every instance; this keeps the value of files written by this run and reads the file otherwise.
 * Undefined when the file does not exist.
 */
const modelVertexCounts = new Map<string, number>();

export function setModelVertexCount(name: string, count: number): void {
  modelVertexCounts.set(name, count);
}

export function getModelVertexCount(name: string): number | undefined {
  const cached = modelVertexCounts.get(name);
  if (cached !== undefined) {
    return cached;
  }
  const count = readVertexCountAt8(`${globals.szWorkDirWmo}/${name}`);
  if (count !== undefined) {
    modelVertexCounts.set(name, count);
  }
  return count;
}

/** @ac tools/vmap4_extractor/vmapexport.cpp strToLower */
export function strToLower(text: string): string {
  return text.replace(/[A-Z]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) | 0x20));
}

/**
 * Extracts one WMO (root file plus its groups) into the work directory as a raw vmap model. `fname` is edited in
 * place like the C++ (`fixnamen` / `fixname2` of the plain name).
 *
 * @ac tools/vmap4_extractor/vmapexport.cpp ExtractSingleWmo
 */
export function ExtractSingleWmo(fname: MutableString): boolean {
  // Copy files from archive
  const originalName = fname.value;

  fname.value = fixPlainName(fname.value);
  const plain_name = GetPlainName(fname.value);
  const szLocalFile = `${globals.szWorkDirWmo}/${plain_name}`;

  if (fileExists(szLocalFile)) {
    return true;
  }

  let p = 0;
  // Select root wmo files
  const rchr = plain_name.lastIndexOf("_");
  if (rchr >= 0) {
    const cpy = plain_name.slice(rchr, rchr + 4);
    for (let index = 0; index < cpy.length; ++index) {
      const m = cpy.charCodeAt(index);
      if (m >= 0x30 && m <= 0x39) {
        p++;
      }
    }
  }

  if (p === 3) {
    return true;
  }

  let file_ok = true;
  console.log(`Extracting ${originalName}`);
  const froot = new WMORoot(originalName);
  if (!froot.open()) {
    console.log("Couldn't open RootWmo!!!");
    return false;
  }
  const output = FileWriter.open(szLocalFile);
  if (!output) {
    console.log(`couldn't open ${szLocalFile} for writing!`);
    return false;
  }
  froot.ConvertToVMAPRootWmo(output);
  // std::swap(WmoDoodads[plain_name], froot.DoodadData): the map keeps the doodad data of the root
  const doodads = froot.DoodadData;
  globals.WmoDoodads.set(plain_name, doodads);
  let Wmo_nVertices = 0;
  let groupCount = 0;
  if (froot.nGroups !== 0) {
    for (let i = 0; i < froot.nGroups; ++i) {
      const temp = fname.value.slice(0, fname.value.length - 4);
      const groupFileName = `${temp}_${String(i).padStart(3, "0")}.wmo`;

      const fgroup = new WMOGroup(groupFileName);
      if (!fgroup.open(froot)) {
        console.log(`Could not open all Group file for: ${plain_name}`);
        file_ok = false;
        break;
      }

      if (fgroup.ShouldSkip(froot)) {
        continue;
      }

      Wmo_nVertices += fgroup.ConvertToVMAPGroupWmo(output, globals.preciseVectorData);
      ++groupCount;
      for (const groupReference of fgroup.DoodadReferences) {
        if (groupReference >= doodads.Spawns.length) {
          continue;
        }

        const doodadNameIndex = doodads.Spawns[groupReference]!.NameIndex;
        if (!froot.ValidDoodadNames.has(doodadNameIndex)) {
          continue;
        }

        doodads.References.add(groupReference);
      }
    }
  }

  // store the correct no of vertices, then the correct no of groups
  output.patchU32(8, Wmo_nVertices);
  output.patchU32(12, groupCount);
  output.close();

  // Delete the extracted file in the case of an error
  if (!file_ok) {
    removeFile(szLocalFile);
  } else {
    setModelVertexCount(plain_name, Wmo_nVertices);
  }
  return true;
}

export interface MapId {
  name: string;
  id: number;
}

/**
 * Walks the WDT and every ADT of each map in `Map.dbc`, extracting the models they reference and writing `dir_bin`.
 * `onlyMaps` limits it to those map ids (an option of this port; the C++ always does every map).
 *
 * @ac tools/vmap4_extractor/vmapexport.cpp ParsMapFiles
 */
export function ParsMapFiles(map_ids: MapId[], onlyMaps: ReadonlySet<number> | null = null): void {
  for (const map of map_ids) {
    if (onlyMaps && !onlyMaps.has(map.id)) {
      continue;
    }
    const fn = `World\\Maps\\${map.name}\\${map.name}.wdt`;
    const WDT = new WDTFile(fn, map.name);
    if (WDT.init(map.id)) {
      let line = `Processing Map ${map.id}\n[`;
      for (let x = 0; x < 64; ++x) {
        for (let y = 0; y < 64; ++y) {
          const ADT = WDT.GetMap(x, y);
          if (ADT) {
            ADT.init(map.id, x, y);
            ADT.close();
          }
        }
        line += "#";
      }
      console.log(`${line}]`);
    }
  }
}

export interface VMapExtractorOptions {
  /** `-d <path>`: the client directory (or its `Data` directory). */
  input: string;
  /** `szWorkDirWmo`. */
  output: string;
  locale: string | null;
  /** `--maps`: only these map ids are walked (the models of `GameObjectDisplayInfo.dbc` are always extracted). */
  maps: Set<number> | null;
  /** `-l`: large size, more detailed vector data (`preciseVectorData`). */
  preciseVectorData: boolean;
}

export const VMAP_EXTRACTOR_VERSION = "V4.00 2012_02";

export const USAGE = `Extract ${VMAP_EXTRACTOR_VERSION}.
bun src/tools/vmap4_extractor/VMapExtractor.ts <client dir> [output dir = data/Buildings] [--locale enUS] [--maps 0,1,530] [-s | -l]
   <client dir>: the client directory (or its Data directory), \`-d <path>\` works as well
   -s : (default) small size (data size optimization), ~500MB less vmap data.
   -l : large size, ~500MB more vmap data. (might contain more details)
   --locale <locale>: use this locale's archives (default: the first locale found)
   --maps <ids>: only walk these map ids (comma separated)
   -? : This message.`;

/**
 * Parses the command line. Null (after the usage was printed) when it is invalid.
 *
 * @ac tools/vmap4_extractor/vmapexport.cpp processArgv
 */
export function processArgv(argv: string[]): VMapExtractorOptions | null {
  const options: VMapExtractorOptions = {
    input: "",
    output: "data/Buildings",
    locale: null,
    maps: null,
    preciseVectorData: false,
  };
  let result = true;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; ++i) {
    const arg = argv[i]!;
    if (arg === "-s") {
      options.preciseVectorData = false;
    } else if (arg === "-l") {
      options.preciseVectorData = true;
    } else if (arg === "-d") {
      const next = argv[i + 1];
      if (next !== undefined) {
        options.input = next;
        ++i;
      } else {
        result = false;
      }
    } else if (arg === "--locale") {
      const next = argv[++i];
      if (next === undefined) {
        result = false;
      } else {
        options.locale = next;
      }
    } else if (arg === "--maps") {
      const next = argv[++i];
      if (next === undefined) {
        result = false;
      } else {
        options.maps = new Set(next.split(",").map((id) => Number.parseInt(id, 10)));
        if ([...options.maps].some((id) => Number.isNaN(id))) {
          result = false;
        }
      }
    } else if (arg === "-?" || arg === "--help" || arg.startsWith("-")) {
      result = false;
      break;
    } else {
      positional.push(arg);
    }
  }
  if (positional.length > 0 && options.input === "") {
    options.input = positional.shift()!;
  }
  if (positional.length > 0) {
    options.output = positional.shift()!;
  }
  if (positional.length > 0 || options.input === "") {
    result = false;
  }
  if (!result) {
    console.log(USAGE);
    return null;
  }
  return options;
}

/**
 * The body of `main`: opens the archives, reads `Map.dbc`, walks the maps and extracts the gameobject models.
 * Returns the process exit code.
 *
 * @ac tools/vmap4_extractor/vmapexport.cpp main
 * @ac tools/vmap4_extractor/vmapexport.cpp fillArchiveNameVector
 * @ac tools/vmap4_extractor/vmapexport.cpp scan_patches
 * @ac tools/vmap4_extractor/vmapexport.cpp getGamePath
 * @ac-skip getGamePath: there is no default `Data/`; the client directory is a required argument
 * @ac-skip fillArchiveNameVector / scan_patches: the archive list and its order are `MpqChain.open` (`archiveOrder`)
 */
export async function runVMapExtractor(options: VMapExtractorOptions): Promise<number> {
  let success = true;
  globals.szWorkDirWmo = options.output.replace(/[\\/]+$/, "");
  globals.preciseVectorData = options.preciseVectorData;

  // some simple check if working dir is dirty
  const sdir = `${globals.szWorkDirWmo}/dir`;
  const sdir_bin = `${globals.szWorkDirWmo}/dir_bin`;
  if (existsSync(sdir) || existsSync(sdir_bin)) {
    console.log("Your output directory seems to be polluted, please use an empty directory!");
    return 1;
  }

  console.log(`Extract ${VMAP_EXTRACTOR_VERSION}. Beginning work ....`);
  // Create the working directory
  if (!existsSync(globals.szWorkDirWmo) && !makeDirectoryRecursive(globals.szWorkDirWmo)) {
    success = false;
  }

  // prepare archive name list
  console.log(`\nGame path: ${options.input}`);
  let chain: MpqChain;
  try {
    chain = await MpqChain.open(options.input, options.locale ?? undefined);
  } catch (error) {
    console.log(`FATAL ERROR: None MPQ archive found by path '${options.input}'. ${(error as Error).message}`);
    return 1;
  }
  gOpenArchives.chain = chain;
  console.log(`Locale '${chain.locale}', ${chain.archives.length} archives`);

  try {
    //map.dbc
    if (success) {
      const dbc = new DBCFile("DBFilesClient\\Map.dbc");
      if (!dbc.open()) {
        console.log("FATAL ERROR: Map.dbc not found in data file.");
        return 1;
      }
      const map_count = dbc.getRecordCount();
      const map_ids: MapId[] = [];
      for (let x = 0; x < map_count; ++x) {
        const record = dbc.getRecord(x);
        const id = record.getUInt(0);
        const name = record.getString(1);
        if (name.length >= 64) {
          console.log("FATAL ERROR: Map name too long.");
          return 1;
        }
        map_ids.push({ id, name });
        console.log(`Map - ${name}`);
      }

      ParsMapFiles(map_ids, options.maps);
      // Extract models, listed in DameObjectDisplayInfo.dbc
      ExtractGameobjectModels();
    }
  } catch (error) {
    if (error instanceof FatalError) {
      console.log(error.message);
      return 1;
    }
    throw error;
  } finally {
    chain.close();
    gOpenArchives.chain = null;
  }

  console.log("");
  if (!success) {
    console.log(`ERROR: Extract ${VMAP_EXTRACTOR_VERSION}. Work NOT complete.\n   Precise vector data=${options.preciseVectorData ? 1 : 0}.`);
    return 1;
  }

  console.log(`Extract ${VMAP_EXTRACTOR_VERSION}. Work complete. No errors.`);
  return 0;
}

function makeDirectoryRecursive(path: string): boolean {
  try {
    mkdirSync(path, { recursive: true, mode: 0o711 });
    return true;
  } catch {
    return false;
  }
}
