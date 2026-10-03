/**
 * Port of `tools/mmaps_generator/Config.{h,cpp}`: the YAML configuration of the mmaps generator.
 *
 * The C++ parses the file with fkYAML; this port uses `Bun.YAML`. `get_value<float>` / `get_value<int>` become
 * `Math.fround` / truncation of the parsed number.
 */
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { MmapTileRecastConfig } from "../../common/Collision/Management/MMapDefines.ts";
import { executableDirectoryPath } from "./PathCommon.ts";

const f32 = Math.fround;

/** `static const float GRID_SIZE = 533.3333f` (`TerrainBuilder.h`). @ac tools/mmaps_generator/TerrainBuilder.h MMAP::GRID_SIZE */
export const GRID_SIZE = f32(533.3333);

/** @ac tools/mmaps_generator/Config.cpp MMAP::ComputeBaseUnitDim */
export function ComputeBaseUnitDim(vertexPerMapEdge: number): number {
  return f32(GRID_SIZE / f32(vertexPerMapEdge));
}

/** `std::pair<uint32, uint32>` key of the tile overrides, `"x,y"` as a string key here. @ac tools/mmaps_generator/Config.cpp MMAP::MakeTileKey */
export function MakeTileKey(x: number, y: number): string {
  return `${x >>> 0},${y >>> 0}`;
}

/** @ac tools/mmaps_generator/Config.cpp MMAP::isCurrentDirectory */
export function isCurrentDirectory(pathStr: string): boolean {
  try {
    const givenPath = realpathSync(resolve(pathStr));
    const currentPath = realpathSync(process.cwd());
    return givenPath === currentPath;
  } catch (e) {
    console.error(`Filesystem error: ${(e as Error).message}`);
    return false;
  }
}

/** @ac tools/mmaps_generator/Config.h MMAP::ResolvedMeshConfig */
export class ResolvedMeshConfig {
  walkableSlopeAngle = 0;
  walkableRadius = 0;
  walkableHeight = 0;
  walkableClimb = 0;
  vertexPerMapEdge = 0;
  vertexPerTileEdge = 0;
  tilesPerMapEdge = 0;
  baseUnitDim = 0;
  cellSizeHorizontal = 0;
  cellSizeVertical = 0;
  maxSimplificationError = 0;

  /** @ac tools/mmaps_generator/Config.cpp MMAP::ResolvedMeshConfig::toMMAPTileRecastConfig */
  toMMAPTileRecastConfig(): MmapTileRecastConfig {
    const config = new MmapTileRecastConfig();
    config.walkableSlopeAngle = this.walkableSlopeAngle;
    config.walkableHeight = this.walkableHeight;
    config.walkableClimb = this.walkableClimb;
    config.walkableRadius = this.walkableRadius;
    config.maxSimplificationError = this.maxSimplificationError;
    config.cellSizeHorizontal = this.cellSizeHorizontal;
    config.cellSizeVertical = this.cellSizeVertical;
    config.baseUnitDim = this.baseUnitDim;
    config.vertexPerMapEdge = this.vertexPerMapEdge;
    config.vertexPerTileEdge = this.vertexPerTileEdge;
    config.tilesPerMapEdge = this.tilesPerMapEdge;
    return config;
  }
}

/** `Config::TileOverride`: every member is a `std::optional`, `undefined` is "not set". */
interface TileOverride {
  walkableSlopeAngle?: number;
  walkableRadius?: number;
  walkableHeight?: number;
  walkableClimb?: number;
}

/** `Config::MapOverride` */
interface MapOverride extends TileOverride {
  vertexPerMapEdge?: number;
  vertexPerTileEdge?: number;
  /**
   * The width/depth of each cell in the XZ-plane grid used for voxelization. [Units: world units]
   * A smaller value increases navmesh resolution but also memory and CPU usage.
   * Default is equal to calculated baseUnitDim.
   */
  cellSizeHorizontal?: number;
  /**
   * The height of each cell in the Y-axis used for voxelization. [Units: world units]
   * Controls how vertical features are represented. Lower values improve accuracy for uneven terrain.
   * Default is equal to calculated baseUnitDim.
   */
  cellSizeVertical?: number;
  tileOverrides: Map<string, TileOverride>;
}

/** `Config::GlobalConfig` (the defaults of the C++ member initializers). */
interface GlobalConfig {
  /** Maximum slope angle (in degrees) NPCs can walk on. Surfaces steeper than this will be considered unwalkable. */
  walkableSlopeAngle: number;
  /** Minimum distance (in cell units) around walkable surfaces. */
  walkableRadius: number;
  /** Minimum ceiling height (in cell units) NPCs need to pass under an obstacle. */
  walkableHeight: number;
  /** Maximum height difference (in cell units) NPCs can step up or down. */
  walkableClimb: number;
  /** Number of vertices along one edge of the entire map's navmesh grid. */
  vertexPerMapEdge: number;
  /** Number of vertices along one edge of each tile chunk. Must divide (vertexPerMapEdge - 1) evenly for seamless tiles. */
  vertexPerTileEdge: number;
  /** Tolerance for how much a polygon can deviate from the original geometry when simplified. */
  maxSimplificationError: number;
}

type YamlNode = Record<string, unknown>;

function isMap(n: unknown): n is YamlNode {
  return typeof n === "object" && n !== null && !Array.isArray(n);
}

/** `get_value<float>()` */
function asFloat(v: unknown): number {
  return f32(Number(v));
}

/** `get_value<int>()` */
function asInt(v: unknown): number {
  return Math.trunc(Number(v)) | 0;
}

/** `std::stoi`: leading whitespace, optional sign, digits; throws when there are none. */
function stoi(s: string): number {
  const m = /^\s*([+-]?\d+)/.exec(s);
  if (!m) throw new Error(`stoi: no conversion: ${s}`);
  return Number(m[1]) | 0;
}

/** @ac tools/mmaps_generator/Config.h MMAP::Config */
export class Config {
  private _global: GlobalConfig = {
    walkableSlopeAngle: 60,
    walkableRadius: 2,
    walkableHeight: 6,
    walkableClimb: 6,
    vertexPerMapEdge: 2000,
    vertexPerTileEdge: 80,
    maxSimplificationError: f32(1.8),
  };
  private _maps = new Map<number, MapOverride>();

  // The C++ leaves these uninitialized when the file does not set them; false is the only sensible value.
  private _skipLiquid = false;
  private _skipContinents = false;
  private _skipJunkMaps = false;
  private _skipBattlegrounds = false;
  private _debugOutput = false;

  private _dataDir = "";

  private _offmeshConnections: string[] = [];

  /** The file this configuration was loaded from (the worker threads load the same file). Not in the C++. */
  sourceFile = "";

  /** @ac tools/mmaps_generator/Config.cpp MMAP::Config::Config */
  private constructor() {}

  /** `std::optional<Config>`: `null` when the file cannot be read or has no `mmapsConfig`. @ac tools/mmaps_generator/Config.cpp MMAP::Config::FromFile */
  static async FromFile(configFile: string): Promise<Config | null> {
    const config = new Config();
    config.sourceFile = configFile;
    if (!(await config.LoadConfig(configFile))) return null;

    return config;
  }

  /** @ac tools/mmaps_generator/Config.cpp MMAP::Config::GetConfigForTile */
  GetConfigForTile(mapID: number, tileX: number, tileY: number): ResolvedMeshConfig {
    let mapOverride: MapOverride | null = null;
    let tileOverride: TileOverride | null = null;

    // Lookup map and tile overrides
    const mapIt = this._maps.get(mapID >>> 0);
    if (mapIt) {
      mapOverride = mapIt;

      // sic: the key is written as (tileX, tileY) when loading and looked up as (tileY, tileX)
      const tileIt = mapOverride.tileOverrides.get(MakeTileKey(tileY, tileX));
      if (tileIt) tileOverride = tileIt;
    }

    // Helper lambdas to resolve values in order: tile -> map -> global
    const resolve = (field: keyof TileOverride, globalValue: number): number => {
      const t = tileOverride?.[field];
      if (t !== undefined) return t;
      const m = mapOverride?.[field];
      if (m !== undefined) return m;
      return globalValue;
    };

    // Resolve vertex settings (these have no tile override)
    const vertexPerMap = mapOverride?.vertexPerMapEdge ?? this._global.vertexPerMapEdge;
    const vertexPerTile = mapOverride?.vertexPerTileEdge ?? this._global.vertexPerTileEdge;

    const config = new ResolvedMeshConfig();
    config.walkableSlopeAngle = resolve("walkableSlopeAngle", this._global.walkableSlopeAngle);
    config.walkableRadius = resolve("walkableRadius", this._global.walkableRadius);
    config.walkableHeight = resolve("walkableHeight", this._global.walkableHeight);
    config.walkableClimb = resolve("walkableClimb", this._global.walkableClimb);

    config.vertexPerMapEdge = vertexPerMap;
    config.vertexPerTileEdge = vertexPerTile;
    config.baseUnitDim = ComputeBaseUnitDim(vertexPerMap);
    config.tilesPerMapEdge = Math.trunc(vertexPerMap / vertexPerTile) | 0;
    config.maxSimplificationError = this._global.maxSimplificationError;
    config.cellSizeHorizontal = config.baseUnitDim;
    config.cellSizeVertical = config.baseUnitDim;

    if (mapOverride && mapOverride.cellSizeHorizontal !== undefined) config.cellSizeHorizontal = mapOverride.cellSizeHorizontal;

    if (mapOverride && mapOverride.cellSizeVertical !== undefined) config.cellSizeVertical = mapOverride.cellSizeVertical;

    return config;
  }

  /** @ac tools/mmaps_generator/Config.h MMAP::Config::ShouldSkipLiquid */
  ShouldSkipLiquid(): boolean {
    return this._skipLiquid;
  }

  /** @ac tools/mmaps_generator/Config.h MMAP::Config::ShouldSkipContinents */
  ShouldSkipContinents(): boolean {
    return this._skipContinents;
  }

  /** @ac tools/mmaps_generator/Config.h MMAP::Config::ShouldSkipJunkMaps */
  ShouldSkipJunkMaps(): boolean {
    return this._skipJunkMaps;
  }

  /** @ac tools/mmaps_generator/Config.h MMAP::Config::ShouldSkipBattlegrounds */
  ShouldSkipBattlegrounds(): boolean {
    return this._skipBattlegrounds;
  }

  /** @ac tools/mmaps_generator/Config.h MMAP::Config::IsDebugOutputEnabled */
  IsDebugOutputEnabled(): boolean {
    return this._debugOutput;
  }

  /** @ac tools/mmaps_generator/Config.h MMAP::Config::VMapsPath */
  VMapsPath(): string {
    return joinPath(this._dataDir, "vmaps");
  }

  /** @ac tools/mmaps_generator/Config.h MMAP::Config::MapsPath */
  MapsPath(): string {
    return joinPath(this._dataDir, "maps");
  }

  /** @ac tools/mmaps_generator/Config.h MMAP::Config::MMapsPath */
  MMapsPath(): string {
    return joinPath(this._dataDir, "mmaps");
  }

  /** @ac tools/mmaps_generator/Config.h MMAP::Config::DataDirPath */
  DataDirPath(): string {
    return this._dataDir;
  }

  /** @ac tools/mmaps_generator/Config.h MMAP::Config::OffMeshConnections */
  OffMeshConnections(): readonly string[] {
    return this._offmeshConnections;
  }

  /** @ac tools/mmaps_generator/Config.cpp MMAP::Config::LoadConfig */
  private async LoadConfig(configFile: string): Promise<boolean> {
    const file = Bun.file(configFile);
    if (!(await file.exists())) return false;

    const root: unknown = Bun.YAML.parse(await file.text());
    if (!isMap(root) || !("mmapsConfig" in root)) return false;

    let mmapsNode = root.mmapsConfig as YamlNode;

    const tryBoolean = (n: YamlNode, key: string, out: boolean): boolean => (key in n ? Boolean(n[key]) : out);
    const tryFloat = (n: YamlNode, key: string, out: number): number => (key in n ? asFloat(n[key]) : out);
    const tryInt = (n: YamlNode, key: string, out: number): number => (key in n ? asInt(n[key]) : out);
    const tryString = (n: YamlNode, key: string, out: string): string => (key in n ? String(n[key]) : out);

    this._skipLiquid = tryBoolean(mmapsNode, "skipLiquid", this._skipLiquid);
    this._skipContinents = tryBoolean(mmapsNode, "skipContinents", this._skipContinents);
    this._skipJunkMaps = tryBoolean(mmapsNode, "skipJunkMaps", this._skipJunkMaps);
    this._skipBattlegrounds = tryBoolean(mmapsNode, "skipBattlegrounds", this._skipBattlegrounds);
    this._debugOutput = tryBoolean(mmapsNode, "debugOutput", this._debugOutput);

    if ("offmeshConnections" in mmapsNode && Array.isArray(mmapsNode.offmeshConnections)) {
      this._offmeshConnections = mmapsNode.offmeshConnections.map((l) => String(l));
    } else {
      this._offmeshConnections = [];
    }

    this._dataDir = tryString(mmapsNode, "dataDir", "");

    mmapsNode = mmapsNode.meshSettings as YamlNode;

    // Global config
    const g = this._global;
    g.walkableSlopeAngle = tryFloat(mmapsNode, "walkableSlopeAngle", g.walkableSlopeAngle);
    g.walkableHeight = tryInt(mmapsNode, "walkableHeight", g.walkableHeight);
    g.walkableClimb = tryInt(mmapsNode, "walkableClimb", g.walkableClimb);
    g.walkableRadius = tryInt(mmapsNode, "walkableRadius", g.walkableRadius);
    g.vertexPerMapEdge = tryInt(mmapsNode, "verticesPerMapEdge", g.vertexPerMapEdge);
    g.vertexPerTileEdge = tryInt(mmapsNode, "verticesPerTileEdge", g.vertexPerTileEdge);
    g.maxSimplificationError = tryFloat(mmapsNode, "maxSimplificationError", g.maxSimplificationError);

    // Map overrides
    if ("mapsOverrides" in mmapsNode && isMap(mmapsNode.mapsOverrides)) {
      for (const [mapKey, mapNodeValue] of Object.entries(mmapsNode.mapsOverrides)) {
        const mapId = stoi(mapKey) >>> 0;

        const override: MapOverride = { tileOverrides: new Map() };
        const mapNode = mapNodeValue as YamlNode;

        if ("walkableSlopeAngle" in mapNode) override.walkableSlopeAngle = asFloat(mapNode.walkableSlopeAngle);
        if ("walkableRadius" in mapNode) override.walkableRadius = asInt(mapNode.walkableRadius);
        if ("walkableHeight" in mapNode) override.walkableHeight = asInt(mapNode.walkableHeight);
        if ("walkableClimb" in mapNode) override.walkableClimb = asInt(mapNode.walkableClimb);
        if ("verticesPerMapEdge" in mapNode) override.vertexPerMapEdge = asInt(mapNode.verticesPerMapEdge);
        if ("verticesPerTileEdge" in mapNode) override.vertexPerTileEdge = asInt(mapNode.verticesPerTileEdge);
        if ("cellSizeHorizontal" in mapNode) override.cellSizeHorizontal = asFloat(mapNode.cellSizeHorizontal);
        if ("cellSizeVertical" in mapNode) override.cellSizeVertical = asFloat(mapNode.cellSizeVertical);

        // Tile overrides
        if ("tilesOverrides" in mapNode && isMap(mapNode.tilesOverrides)) {
          for (const [key, tileNodeValue] of Object.entries(mapNode.tilesOverrides)) {
            const tileNode = tileNodeValue as YamlNode;

            const comma = key.indexOf(",");
            if (comma === -1) continue;

            const tileX = stoi(key.slice(0, comma)) >>> 0;
            const tileY = stoi(key.slice(comma + 1)) >>> 0;

            const tileOverride: TileOverride = {};
            if ("walkableSlopeAngle" in tileNode) tileOverride.walkableSlopeAngle = asFloat(tileNode.walkableSlopeAngle);
            if ("walkableRadius" in tileNode) tileOverride.walkableRadius = asInt(tileNode.walkableRadius);
            if ("walkableHeight" in tileNode) tileOverride.walkableHeight = asInt(tileNode.walkableHeight);
            if ("walkableClimb" in tileNode) tileOverride.walkableClimb = asInt(tileNode.walkableClimb);

            override.tileOverrides.set(MakeTileKey(tileX, tileY), tileOverride);
          }
        }

        this._maps.set(mapId, override);
      }
    }

    // Resolve data dir path. Maybe we need to use an executable path instead of the current dir.
    if (isCurrentDirectory(this._dataDir) && !existsSync(this.MapsPath())) {
      const execPath = executableDirectoryPath();
      if (existsSync(joinPath(execPath, "maps"))) this._dataDir = execPath;
    }

    return true;
  }
}

/** `std::filesystem::path(a) / b` as a string. */
function joinPath(a: string, b: string): string {
  if (a === "") return b;
  return a.endsWith("/") ? a + b : `${a}/${b}`;
}
