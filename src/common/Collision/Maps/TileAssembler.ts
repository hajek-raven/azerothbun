import { mkdirSync } from "node:fs";
import { AABox } from "../../../math/AABox.ts";
import { pif } from "../../../math/g3dmath.ts";
import { Matrix3 } from "../../../math/Matrix3.ts";
import { Vector3 } from "../../../math/Vector3.ts";
import { bytesToString, ReadFile, WriteFile } from "../BinaryFile.ts";
import { BIH } from "../BoundingIntervalHierarchy.ts";
import { ModelFlags, ModelSpawn } from "../Models/ModelInstance.ts";
import { GroupModel, WmoLiquid, WorldModel } from "../Models/WorldModel.ts";
import { GAMEOBJECT_MODELS, RAW_VMAP_MAGIC, VMAP_MAGIC } from "../VMapDefinitions.ts";
import { StaticMapTree } from "./MapTree.ts";

export { readChunk } from "../VMapDefinitions.ts";

const f = Math.fround;

/** `printf` / `std::cout` of the tool. */
function print(message: string): void {
  console.log(message);
}

/**
 * Placement transform of a raw model (scale, then the ZYX euler rotation in degrees). Computed in
 * `float` like the C++, because the result is written to the `.vmtree`.
 *
 * @ac common/Collision/Maps/TileAssembler.h VMAP::ModelPosition
 */
export class ModelPosition {
  private iRotation = new Matrix3();
  iPos = new Vector3();
  iDir = new Vector3();
  iScale = 0;

  /** @ac common/Collision/Maps/TileAssembler.h VMAP::ModelPosition::init */
  init(): void {
    this.iRotation = Matrix3.fromEulerAnglesZYX(
      f(f(pif() * f(this.iDir.y)) / 180),
      f(f(pif() * f(this.iDir.x)) / 180),
      f(f(pif() * f(this.iDir.z)) / 180),
    );
  }

  /** @ac common/Collision/Maps/TileAssembler.cpp VMAP::ModelPosition::transform */
  transform(pIn: Vector3): Vector3 {
    const s = f(this.iScale);
    const x = f(pIn.x * s);
    const y = f(pIn.y * s);
    const z = f(pIn.z * s);
    const e = this.iRotation.elt;
    return new Vector3(
      f(f(f(e[0]! * x) + f(e[1]! * y)) + f(e[2]! * z)),
      f(f(f(e[3]! * x) + f(e[4]! * y)) + f(e[5]! * z)),
      f(f(f(e[6]! * x) + f(e[7]! * y)) + f(e[8]! * z)),
    );
  }

  /** @ac common/Collision/Maps/TileAssembler.h VMAP::ModelPosition::moveToBasePos */
  moveToBasePos(pBasePos: Vector3): void {
    this.iPos = new Vector3(f(this.iPos.x - pBasePos.x), f(this.iPos.y - pBasePos.y), f(this.iPos.z - pBasePos.z));
  }
}

/**
 * `std::map<uint32, ModelSpawn> UniqueEntries` and `std::multimap<uint32, uint32> TileEntries`. The maps
 * are kept as insertion ordered containers and sorted by key where the C++ iterates them (a multimap
 * keeps equal keys in insertion order, so the sort is stable).
 *
 * @ac common/Collision/Maps/TileAssembler.h VMAP::MapSpawns
 */
export interface MapSpawns {
  UniqueEntries: Map<number, ModelSpawn>;
  /** `[packed tile id, spawn ID]` pairs. */
  TileEntries: [number, number][];
}

/** `#pragma pack(1)` WMO liquid header of the raw files: 4 int32, 3 float, 1 int16 = 30 bytes. */
export const WMO_LIQUID_HEADER_SIZE = 30;

/**
 * One group of a raw model file (`vmapexport` output).
 *
 * @ac common/Collision/Maps/TileAssembler.h VMAP::GroupModel_Raw
 * @ac-skip common/Collision/Maps/TileAssembler.cpp VMAP::GroupModel_Raw::~GroupModel_Raw: memory is garbage collected
 */
export class GroupModel_Raw {
  mogpflags = 0;
  GroupWMOID = 0;
  bounds = new AABox();
  liquidflags = 0;
  /** Index triples. */
  triangles: Uint32Array = new Uint32Array(0);
  /** xyz floats. */
  vertexArray: Float32Array = new Float32Array(0);
  liquid: WmoLiquid | null = null;

  /**
   * mogpflags, GroupWMOID, bound low and high, liquidflags, `GRP ` (branch index counts, unused),
   * `INDX` (uint16 indices), `VERT` (float triples), and `LIQU` when `liquidflags & 3`.
   *
   * @ac common/Collision/Maps/TileAssembler.cpp VMAP::GroupModel_Raw::Read
   */
  Read(rf: ReadFile): boolean {
    let readOperation = 0;
    const fail = (): boolean => {
      print(`readfail, op = ${readOperation}`);
      return false;
    };
    const cmp = (expected: string): boolean => {
      const got = rf.bytes(4);
      if (!got) return fail();
      const s = bytesToString(got);
      if (s !== expected) {
        print(`cmpfail, ${s}!=${expected}`);
        return false;
      }
      return true;
    };

    const mogpflags = rf.u32();
    const groupWMOID = rf.u32();
    const vec1 = rf.f32Array(3);
    const vec2 = rf.f32Array(3);
    if (mogpflags === undefined || groupWMOID === undefined || !vec1 || !vec2) return fail();
    this.mogpflags = mogpflags;
    this.GroupWMOID = groupWMOID;
    this.bounds.set(new Vector3(vec1[0], vec1[1], vec1[2]), new Vector3(vec2[0], vec2[1], vec2[2]));

    const liquidflags = rf.u32();
    if (liquidflags === undefined) return fail();
    this.liquidflags = liquidflags;

    // will this ever be used? what is it good for anyway??
    if (!cmp("GRP ")) return false;
    if (rf.i32() === undefined) return fail(); // blocksize
    const branches = rf.u32();
    if (branches === undefined) return fail();
    for (let b = 0; b < branches; ++b) {
      // indexes for each branch (not used jet)
      if (rf.u32() === undefined) return fail();
    }

    // ---- indexes
    if (!cmp("INDX")) return false;
    if (rf.i32() === undefined) return fail(); // blocksize
    const nindexes = rf.u32();
    if (nindexes === undefined) return fail();
    if (nindexes > 0) {
      const indexarray = rf.u16Array(nindexes);
      if (!indexarray) return fail();
      const triCount = Math.floor(nindexes / 3);
      const triangles = new Uint32Array(triCount * 3);
      for (let i = 0; i < triCount * 3; ++i) triangles[i] = indexarray[i]!;
      this.triangles = triangles;
    }

    // ---- vectors
    if (!cmp("VERT")) return false;
    if (rf.i32() === undefined) return fail(); // blocksize
    const nvectors = rf.u32();
    if (nvectors === undefined) return fail();
    if (nvectors > 0) {
      const vectorarray = rf.f32Array(nvectors * 3);
      if (!vectorarray) return fail();
      this.vertexArray = vectorarray;
    }

    // ----- liquid
    this.liquid = null;
    if (this.liquidflags & 3) {
      if (!cmp("LIQU")) return false;
      if (rf.i32() === undefined) return fail(); // blocksize
      const liquidType = rf.u32();
      if (liquidType === undefined) return fail();
      if (this.liquidflags & 1) {
        const xverts = rf.i32();
        const yverts = rf.i32();
        const xtiles = rf.i32();
        const ytiles = rf.i32();
        const pos = rf.f32Array(3);
        const material = rf.i16();
        if (xverts === undefined || yverts === undefined || xtiles === undefined || ytiles === undefined || !pos || material === undefined) return fail();
        const liquid = new WmoLiquid(xtiles, ytiles, new Vector3(pos[0], pos[1], pos[2]), liquidType);
        this.liquid = liquid;
        let size = xverts * yverts;
        const heights = rf.f32Array(size);
        if (!heights) return fail();
        const heightStorage = liquid.GetHeightStorage()!;
        heightStorage.set(heights.subarray(0, Math.min(size, heightStorage.length)));
        size = xtiles * ytiles;
        const flags = rf.bytes(size);
        if (!flags) return fail();
        const flagStorage = liquid.GetFlagsStorage();
        if (flagStorage) flagStorage.set(flags.subarray(0, Math.min(size, flagStorage.length)));
      } else {
        const liquid = new WmoLiquid(0, 0, Vector3.zero(), liquidType);
        liquid.GetHeightStorage()![0] = this.bounds.high().z;
        this.liquid = liquid;
      }
    }

    return true;
  }
}

/**
 * A raw model file: `VMAP048\0`, vertex count (skipped), group count, RootWMOID, then the groups.
 *
 * @ac common/Collision/Maps/TileAssembler.h VMAP::WorldModel_Raw
 */
export class WorldModel_Raw {
  RootWMOID = 0;
  groupsArray: GroupModel_Raw[] = [];

  /** @ac common/Collision/Maps/TileAssembler.cpp VMAP::WorldModel_Raw::Read */
  Read(path: string): boolean {
    const rf = ReadFile.open(path);
    if (!rf) {
      print(`ERROR: Can't open raw model file: ${path}`);
      return false;
    }

    const ident = rf.bytes(8);
    if (!ident) {
      print("readfail, op = 0");
      return false;
    }
    // strcmp of the NUL terminated 8 bytes against "VMAP048"
    const nul = ident.indexOf(0);
    const identStr = bytesToString(nul >= 0 ? ident.subarray(0, nul) : ident);
    if (identStr !== RAW_VMAP_MAGIC) {
      print(`cmpfail, ${identStr}!=${RAW_VMAP_MAGIC}`);
      return false;
    }

    // we have to read one int. This is needed during the export and we have to skip it here
    const tempNVectors = rf.u32();
    const groups = rf.u32();
    const root = rf.u32();
    if (tempNVectors === undefined || groups === undefined || root === undefined) {
      print("readfail, op = 0");
      return false;
    }
    this.RootWMOID = root;

    this.groupsArray = [];
    for (let g = 0; g < groups; ++g) this.groupsArray.push(new GroupModel_Raw());
    let succeed = true;
    for (let g = 0; g < groups && succeed; ++g) succeed = this.groupsArray[g]!.Read(rf);

    return succeed;
  }
}

/**
 * Converts the raw extractor output (`dir_bin`, raw model files, `temp_gameobject_models`) into the
 * runtime vmap files: `MMM.vmtree`, `MMM_XX_YY.vmtile`, `<model>.vmo` and `GameObjectModels.dtree`.
 * To start the conversion call `convertWorld2()`.
 *
 * @ac common/Collision/Maps/TileAssembler.h VMAP::TileAssembler
 * @ac-skip common/Collision/Maps/TileAssembler.cpp VMAP::TileAssembler::~TileAssembler: empty in C++
 */
export class TileAssembler {
  private iDestDir: string;
  private iSrcDir: string;
  /** `MapData` (`std::map<uint32, MapSpawns*>`). */
  private mapData = new Map<number, MapSpawns>();
  /** `std::set<std::string>`; iterated in sorted order. */
  private spawnedModelFiles = new Set<string>();

  /** Creates the destination directory (one level, like `boost::filesystem::create_directory`). @ac common/Collision/Maps/TileAssembler.cpp VMAP::TileAssembler::TileAssembler */
  constructor(pSrcDirName: string, pDestDirName: string) {
    this.iDestDir = pDestDirName;
    this.iSrcDir = pSrcDirName;
    try {
      mkdirSync(this.iDestDir);
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") throw error;
    }
  }

  /** @ac common/Collision/Maps/TileAssembler.cpp VMAP::TileAssembler::convertWorld2 */
  async convertWorld2(): Promise<boolean> {
    let success = this.readMapSpawns();
    if (!success) return false;

    // export Map data
    const mapIds = [...this.mapData.keys()].sort((a, b) => a - b);
    for (const mapId of mapIds) {
      if (!success) break;
      const mapSpawnsData = this.mapData.get(mapId)!;
      // build global map tree
      const mapSpawns: ModelSpawn[] = [];
      print(`Calculating model bounds for map ${mapId}...`);
      const uniqueIds = [...mapSpawnsData.UniqueEntries.keys()].sort((a, b) => a - b);
      for (const id of uniqueIds) {
        const entry = mapSpawnsData.UniqueEntries.get(id)!;
        // M2 models don't have a bound set in WDT/ADT placement data, i still think they're not used for LoS at all on retail
        if (entry.flags & ModelFlags.MOD_M2) {
          if (!this.calculateTransformedBound(entry)) break;
        } else if (entry.flags & ModelFlags.MOD_WORLDSPAWN) {
          // WMO maps and terrain maps use different origin, so we need to adapt :/
          /// @todo remove extractor hack and uncomment below line:
          //entry->second.iPos += Vector3(533.33333f*32, 533.33333f*32, 0.f);
          const off = f(f(533.33333) * 32);
          const b = entry.iBound;
          entry.iBound = new AABox(
            new Vector3(f(b.lo.x + off), f(b.lo.y + off), f(b.lo.z + 0)),
            new Vector3(f(b.hi.x + off), f(b.hi.y + off), f(b.hi.z + 0)),
          );
        }
        mapSpawns.push(entry);
        this.spawnedModelFiles.add(entry.name);
      }

      print(`Creating map tree for map ${mapId}...`);
      const pTree = new BIH();

      try {
        pTree.build(mapSpawns, (spawn, out) => out.copy(spawn.GetBounds()));
      } catch (e) {
        print(`Exception ${(e as Error).message} when calling pTree.build`);
        return false;
      }

      // ===> possibly move this code to StaticMapTree class
      const modelNodeIdx = new Map<number, number>();
      for (let i = 0; i < mapSpawns.length; ++i) {
        if (!modelNodeIdx.has(mapSpawns[i]!.ID)) modelNodeIdx.set(mapSpawns[i]!.ID, i);
      }

      // write map tree file
      const mapfilename = `${this.iDestDir}/${String(mapId).padStart(3, "0")}.vmtree`;
      const mapfile = new WriteFile();

      //general info
      mapfile.chars(VMAP_MAGIC, 8);
      const globalTileID = StaticMapTree.packTileID(65, 65);
      const globalRange = mapSpawnsData.TileEntries.filter(([tile]) => tile === globalTileID);
      const isTiled = globalRange.length === 0 ? 1 : 0; // only maps without terrain (tiles) have global WMO
      mapfile.u8(isTiled);
      // Nodes
      mapfile.chars("NODE", 4);
      success = pTree.writeToFile(mapfile);
      // global map spawns (WDT), if any (most instances)
      if (success) mapfile.chars("GOBJ", 4);

      for (const [, spawnId] of globalRange) {
        if (!success) break;
        success = ModelSpawn.writeToFile(mapfile, this.uniqueEntry(mapSpawnsData, spawnId));
      }

      if (!(await mapfile.flush(mapfilename))) {
        success = false;
        print(`Cannot open ${mapfilename}`);
        break;
      }

      // <====

      // write map tile files, similar to ADT files, only with extra BSP tree node info
      const tileEntries = mapSpawnsData.TileEntries.map((e, i) => [e[0], e[1], i] as const).sort((a, b) => a[0] - b[0] || a[2] - b[2]);
      for (let tile = 0; tile < tileEntries.length; ++tile) {
        const tileId = tileEntries[tile]![0];
        const spawn = this.uniqueEntry(mapSpawnsData, tileEntries[tile]![1]);
        if (spawn.flags & ModelFlags.MOD_WORLDSPAWN) {
          // WDT spawn, saved as tile 65/65 currently...
          continue;
        }
        let nSpawns = 0;
        for (const e of tileEntries) if (e[0] === tileId) ++nSpawns;
        const [x, y] = StaticMapTree.unpackTileID(tileId);
        const tilefilename = `${this.iDestDir}/${String(mapId).padStart(3, "0")}_${String(x).padStart(2, "0")}_${String(y).padStart(2, "0")}.vmtile`;
        const tilefile = new WriteFile();
        // file header
        if (success) tilefile.chars(VMAP_MAGIC, 8);
        // write number of tile spawns
        if (success) tilefile.u32(nSpawns);
        // write tile spawns
        for (let s = 0; s < nSpawns; ++s) {
          if (s) ++tile;
          const spawn2 = this.uniqueEntry(mapSpawnsData, tileEntries[tile]![1]);
          success = success && ModelSpawn.writeToFile(tilefile, spawn2);
          // MapTree nodes to update when loading tile:
          const nIdx = modelNodeIdx.get(spawn2.ID);
          if (success) tilefile.u32(nIdx ?? 0);
        }
        if (!(await tilefile.flush(tilefilename))) print(`Cannot open ${tilefilename}`);
      }
      // break; //test, extract only first map; TODO: remvoe this line
    }

    // add an object models, listed in temp_gameobject_models file
    await this.exportGameobjectModels();
    // export objects
    print("\nConverting Model Files");
    const files = [...this.spawnedModelFiles].sort();
    for (const mfile of files) {
      print(`Converting ${mfile}`);
      if (!(await this.convertRawFile(mfile))) {
        print(`error converting ${mfile}`);
        success = false;
        break;
      }
    }

    //cleanup:
    this.mapData.clear();
    return success;
  }

  /** `UniqueEntries[id]`: `std::map::operator[]` inserts a default spawn when the ID is missing. */
  private uniqueEntry(spawns: MapSpawns, id: number): ModelSpawn {
    let spawn = spawns.UniqueEntries.get(id);
    if (!spawn) {
      spawn = new ModelSpawn();
      spawns.UniqueEntries.set(id, spawn);
    }
    return spawn;
  }

  /**
   * Reads `dir_bin`: per spawn mapID, tileX, tileY (u32 each) and a `ModelSpawn` record.
   *
   * @ac common/Collision/Maps/TileAssembler.cpp VMAP::TileAssembler::readMapSpawns
   */
  readMapSpawns(): boolean {
    const fname = `${this.iSrcDir}/dir_bin`;
    const dirf = ReadFile.open(fname);
    if (!dirf) {
      print("Could not read dir_bin file!");
      return false;
    }
    print("Read coordinate mapping...");
    const spawn = new ModelSpawn();
    while (!dirf.eof()) {
      // read mapID, tileX, tileY, Flags, NameSet, UniqueId, Pos, Rot, Scale, Bound_lo, Bound_hi, name
      const mapID = dirf.u32();
      if (mapID === undefined) break; // EoF...
      const tileX = dirf.u32() ?? 0;
      const tileY = dirf.u32() ?? 0;
      if (!ModelSpawn.readFromFile(dirf, spawn)) break;

      let current = this.mapData.get(mapID);
      if (!current) {
        print(`spawning Map ${mapID}`);
        current = { UniqueEntries: new Map(), TileEntries: [] };
        this.mapData.set(mapID, current);
      }

      if (!current.UniqueEntries.has(spawn.ID)) current.UniqueEntries.set(spawn.ID, spawn.cloneSpawn());
      current.TileEntries.push([StaticMapTree.packTileID(tileX, tileY), spawn.ID]);
    }
    return true;
  }

  /**
   * Computes the world bound of an M2 spawn from its raw vertices and sets `MOD_HAS_BOUND`.
   *
   * @ac common/Collision/Maps/TileAssembler.cpp VMAP::TileAssembler::calculateTransformedBound
   */
  calculateTransformedBound(spawn: ModelSpawn): boolean {
    const modelFilename = `${this.iSrcDir}/${spawn.name}`;

    const modelPosition = new ModelPosition();
    modelPosition.iDir = spawn.iRot.clone();
    modelPosition.iScale = spawn.iScale;
    modelPosition.init();

    const raw_model = new WorldModel_Raw();
    if (!raw_model.Read(modelFilename)) return false;

    const groups = raw_model.groupsArray.length;
    if (groups !== 1) print(`Warning: '${modelFilename}' does not seem to be a M2 model!`);

    let modelBound = new AABox();
    let boundEmpty = true;

    for (let g = 0; g < groups; ++g) {
      // should be only one for M2 files...
      const vertices = raw_model.groupsArray[g]!.vertexArray;

      if (vertices.length === 0) {
        print(`error: model '${spawn.name}' has no geometry!`);
        continue;
      }

      const nvectors = vertices.length / 3;
      const vin = new Vector3();
      for (let i = 0; i < nvectors; ++i) {
        vin.set(vertices[i * 3]!, vertices[i * 3 + 1]!, vertices[i * 3 + 2]!);
        const v = modelPosition.transform(vin);

        if (boundEmpty) {
          modelBound = new AABox(v, v);
          boundEmpty = false;
        } else {
          modelBound.merge(v);
        }
      }
    }
    const p = spawn.iPos;
    spawn.iBound = new AABox(
      new Vector3(f(modelBound.lo.x + p.x), f(modelBound.lo.y + p.y), f(modelBound.lo.z + p.z)),
      new Vector3(f(modelBound.hi.x + p.x), f(modelBound.hi.y + p.y), f(modelBound.hi.z + p.z)),
    );
    spawn.flags |= ModelFlags.MOD_HAS_BOUND;
    return true;
  }

  /**
   * Converts one raw model file into `<dest>/<name>.vmo`.
   *
   * @ac common/Collision/Maps/TileAssembler.cpp VMAP::TileAssembler::convertRawFile
   */
  async convertRawFile(pModelFilename: string): Promise<boolean> {
    let filename = this.iSrcDir;
    if (filename.length > 0) filename += "/";
    filename += pModelFilename;

    const raw_model = new WorldModel_Raw();
    if (!raw_model.Read(filename)) return false;

    // write WorldModel
    const model = new WorldModel();
    model.setRootWmoID(raw_model.RootWMOID);
    if (raw_model.groupsArray.length > 0) {
      const groupsArray: GroupModel[] = [];

      for (const raw_group of raw_model.groupsArray) {
        const group = new GroupModel(raw_group.mogpflags, raw_group.GroupWMOID, raw_group.bounds);
        group.setMeshData(raw_group.vertexArray, raw_group.triangles);
        group.setLiquidData(raw_group.liquid);
        raw_group.liquid = null;
        groupsArray.push(group);
      }

      model.setGroupModels(groupsArray);
    }

    return model.writeFile(`${this.iDestDir}/${pModelFilename}.vmo`);
  }

  /**
   * Reads `temp_gameobject_models` (written by the extractor from `GameObjectDisplayInfo.dbc`: per model
   * displayId, isWmo, name length, name), computes each model's bound from its raw vertices, and writes
   * `GameObjectModels.dtree` (the same records plus bound low and high). Listed models are converted
   * with the spawned ones.
   *
   * @ac common/Collision/Maps/TileAssembler.cpp VMAP::TileAssembler::exportGameobjectModels
   */
  async exportGameobjectModels(): Promise<void> {
    const model_list = ReadFile.open(`${this.iSrcDir}/temp_gameobject_models`);
    if (!model_list) return;

    if (!model_list.chunk(RAW_VMAP_MAGIC, 8)) return;

    const model_list_copy = new WriteFile();
    model_list_copy.chars(VMAP_MAGIC, 8);

    while (!model_list.eof()) {
      const displayId = model_list.u32();
      if (displayId === undefined && model_list.eof()) {
        // EOF flag is only set after failed reading attempt
        break;
      }

      const isWmo = model_list.u8();
      const name_length = model_list.u32();
      const buff = name_length !== undefined && name_length < 500 ? model_list.bytes(name_length) : undefined;
      if (isWmo === undefined || name_length === undefined || !buff) {
        print("\nFile 'temp_gameobject_models' seems to be corrupted");
        break;
      }

      const model_name = bytesToString(buff);

      const raw_model = new WorldModel_Raw();
      if (!raw_model.Read(`${this.iSrcDir}/${model_name}`)) continue;

      this.spawnedModelFiles.add(model_name);
      let bounds = new AABox();
      let boundEmpty = true;
      for (const group of raw_model.groupsArray) {
        const vertices = group.vertexArray;
        const nvectors = vertices.length / 3;
        for (let i = 0; i < nvectors; ++i) {
          const v = new Vector3(vertices[i * 3]!, vertices[i * 3 + 1]!, vertices[i * 3 + 2]!);
          if (boundEmpty) {
            bounds = new AABox(v, v);
            boundEmpty = false;
          } else {
            bounds.merge(v);
          }
        }
      }

      model_list_copy.u32(displayId!);
      model_list_copy.u8(isWmo);
      model_list_copy.u32(name_length);
      model_list_copy.bytes(buff);
      model_list_copy.f32(bounds.low().x);
      model_list_copy.f32(bounds.low().y);
      model_list_copy.f32(bounds.low().z);
      model_list_copy.f32(bounds.high().x);
      model_list_copy.f32(bounds.high().y);
      model_list_copy.f32(bounds.high().z);
    }

    await model_list_copy.flush(`${this.iDestDir}/${GAMEOBJECT_MODELS}`);
  }
}
