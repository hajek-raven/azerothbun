/**
 * Port of `tools/mmaps_generator/MapBuilder.{h,cpp}`: discovers the maps and tiles in `data/`, builds the Recast
 * navmesh of every tile and writes `mmaps/MMM.mmap` and `mmaps/MMMXXYY.mmtile`.
 *
 * Threading: the C++ starts `threads` `TileBuilder` threads that pop `TileInfo` from a `ProducerConsumerQueue`. Here
 * the queue is an array filled by `buildMap` and drained after the last map was queued, either inline (one thread) or
 * by `threads` Bun `Worker`s running `TileBuilderWorker.ts` (each with its own `TileBuilder` and `TerrainBuilder`).
 * Progress counters are kept by the main thread; a worker reports every finished tile.
 */
import { MAP_FILE_NAME_FORMAT, TILE_FILE_NAME_FORMAT } from "../../common/Collision/Management/MMapMgr.ts";
import { MMAP_MAGIC, MMAP_VERSION, MmapTileHeader, NAV_GROUND, SIZEOF_MMAP_TILE_HEADER } from "../../common/Collision/Management/MMapDefines.ts";
import { StaticMapTree } from "../../common/Collision/Maps/MapTree.ts";
import {
  DT_NAVMESH_VERSION,
  DT_POLY_BITS,
  DT_TILE_FREE_DATA,
  DT_VERTS_PER_POLYGON,
  type dtNavMesh,
  dtAllocNavMesh,
  dtFreeNavMesh,
  dtNavMeshParams,
} from "../../common/Detour/DetourNavMesh.ts";
import { dtCreateNavMeshData, dtNavMeshCreateParams } from "../../common/Detour/DetourNavMeshBuilder.ts";
import { DT_SUCCESS } from "../../common/Detour/DetourStatus.ts";
import {
  RC_WALKABLE_AREA,
  f32,
  rcAllocCompactHeightfield,
  rcAllocContourSet,
  rcAllocHeightfield,
  rcAllocPolyMesh,
  rcAllocPolyMeshDetail,
  rcBuildCompactHeightfield,
  rcCalcBounds,
  rcCalcGridSize,
  rcClearUnwalkableTriangles,
  rcConfig,
  rcContext,
  rcCreateHeightfield,
  rcVcopy,
  rcVmax,
  rcVmin,
  type rcCompactHeightfield,
  type rcContourSet,
  type rcHeightfield,
  type rcPolyMesh,
  type rcPolyMeshDetail,
  type rcRef,
} from "../../common/Recast/Recast.ts";
import { rcErodeWalkableArea } from "../../common/Recast/RecastArea.ts";
import { rcBuildContours } from "../../common/Recast/RecastContour.ts";
import { rcFilterLedgeSpans, rcFilterLowHangingWalkableObstacles, rcFilterWalkableLowHeightSpans } from "../../common/Recast/RecastFilter.ts";
import { rcMergePolyMeshes, rcBuildPolyMesh } from "../../common/Recast/RecastMesh.ts";
import { rcBuildPolyMeshDetail, rcMergePolyMeshDetails } from "../../common/Recast/RecastMeshDetail.ts";
import { rcRasterizeTriangles } from "../../common/Recast/RecastRasterization.ts";
import { rcBuildDistanceField, rcBuildRegions } from "../../common/Recast/RecastRegion.ts";
import { type Config, GRID_SIZE, type ResolvedMeshConfig } from "./Config.ts";
import { IntermediateValues } from "./IntermediateValues.ts";
import { getDirContents } from "./PathCommon.ts";
import { G3DArray, MeshData, TerrainBuilder } from "./TerrainBuilder.ts";

/** `FLT_MIN`, `FLT_MAX` */
const FLT_MIN = 1.1754943508222875e-38;
const FLT_MAX = 3.4028234663852886e38;

const pad = (n: number, w: number): string => String(n).padStart(w, "0");

/** @ac tools/mmaps_generator/MapBuilder.h MMAP::MapTiles */
export class MapTiles {
  m_mapId: number;
  m_tiles: Set<number> | null;

  constructor(id = 0xffffffff, tiles: Set<number> | null = null) {
    this.m_mapId = id;
    this.m_tiles = tiles;
  }

  /** `operator==(uint32 id)` */
  equals(id: number): boolean {
    return this.m_mapId === id;
  }
}

/** @ac tools/mmaps_generator/MapBuilder.h MMAP::TileList */
export type TileList = MapTiles[];

/**
 * The Recast intermediates of one sub tile. The C++ destructor frees them; here the garbage collector does.
 * @ac tools/mmaps_generator/MapBuilder.h MMAP::Tile
 */
export class Tile {
  chf: rcCompactHeightfield | null = null;
  solid: rcHeightfield | null = null;
  cset: rcContourSet | null = null;
  pmesh: rcPolyMesh | null = null;
  dmesh: rcPolyMeshDetail | null = null;
}

/** @ac tools/mmaps_generator/MapBuilder.h MMAP::TileInfo */
export class TileInfo {
  m_mapId = 0xffffffff;
  m_tileX = 0;
  m_tileY = 0;
  m_navMeshParams = new dtNavMeshParams();
}

/** `rcConfig` copy (`rcConfig tileCfg = config`). */
function cloneRcConfig(c: rcConfig): rcConfig {
  const r = new rcConfig();
  r.width = c.width;
  r.height = c.height;
  r.tileSize = c.tileSize;
  r.borderSize = c.borderSize;
  r.cs = c.cs;
  r.ch = c.ch;
  r.bmin.set(c.bmin);
  r.bmax.set(c.bmax);
  r.walkableSlopeAngle = c.walkableSlopeAngle;
  r.walkableHeight = c.walkableHeight;
  r.walkableClimb = c.walkableClimb;
  r.walkableRadius = c.walkableRadius;
  r.maxEdgeLen = c.maxEdgeLen;
  r.maxSimplificationError = c.maxSimplificationError;
  r.minRegionArea = c.minRegionArea;
  r.mergeRegionArea = c.mergeRegionArea;
  r.maxVertsPerPoly = c.maxVertsPerPoly;
  r.detailSampleDist = c.detailSampleDist;
  r.detailSampleMaxError = c.detailSampleMaxError;
  return r;
}

/**
 * @todo: move this to its own file. For now it will stay here to keep the changes to a minimum, especially in the cpp file
 * @ac tools/mmaps_generator/MapBuilder.h MMAP::TileBuilder
 */
export class TileBuilder {
  private m_debugOutput: boolean;
  private m_mapBuilder: MapBuilder;
  private m_terrainBuilder: TerrainBuilder;
  /** build performance - not really used for now */
  private m_rcContext: rcContext;

  /**
   * `@ac-skip m_workerThread(&TileBuilder::WorkerThread, this)`: the worker lives in `TileBuilderWorker.ts` (or the
   * caller loops over the queue inline), see the file comment.
   * @ac tools/mmaps_generator/MapBuilder.cpp MMAP::TileBuilder::TileBuilder
   */
  constructor(mapBuilder: MapBuilder, skipLiquid: boolean, debugOutput: boolean) {
    this.m_debugOutput = debugOutput;
    this.m_mapBuilder = mapBuilder;
    this.m_terrainBuilder = new TerrainBuilder(this.m_mapBuilder.getConfig().DataDirPath(), skipLiquid);
    this.m_rcContext = new rcContext(false);
  }

  /** @ac tools/mmaps_generator/MapBuilder.cpp MMAP::TileBuilder::WorkerThread */
  async WorkerThread(queue: TileInfo[]): Promise<void> {
    for (;;) {
      const tileInfo = queue.shift();
      if (!tileInfo) return;

      const navMesh = dtAllocNavMesh();
      if (!navMesh.init(tileInfo.m_navMeshParams)) {
        console.log(`[Map ${pad(tileInfo.m_mapId, 4)}] Failed creating navmesh for tile ${tileInfo.m_tileX},${tileInfo.m_tileY} !`);
        dtFreeNavMesh(navMesh);
        return;
      }

      await this.buildTile(tileInfo.m_mapId, tileInfo.m_tileX, tileInfo.m_tileY, navMesh);

      dtFreeNavMesh(navMesh);
    }
  }

  /** @ac tools/mmaps_generator/MapBuilder.cpp MMAP::TileBuilder::buildTile */
  async buildTile(mapID: number, tileX: number, tileY: number, navMesh: dtNavMesh): Promise<void> {
    if (await this.shouldSkipTile(mapID, tileX, tileY)) {
      ++this.m_mapBuilder.m_totalTilesProcessed;
      return;
    }

    console.log(`${this.m_mapBuilder.currentPercentageDone()}% [Map ${pad(mapID, 4)}] Building tile [${pad(tileX, 2)},${pad(tileY, 2)}]`);

    const meshData = new MeshData();

    // get heightmap data
    this.m_terrainBuilder.loadMap(mapID, tileX, tileY, meshData);

    // get model data
    this.m_terrainBuilder.loadVMap(mapID, tileY, tileX, meshData);

    // if there is no data, give up now
    if (!meshData.solidVerts.size() && !meshData.liquidVerts.size()) {
      ++this.m_mapBuilder.m_totalTilesProcessed;
      return;
    }

    // remove unused vertices
    TerrainBuilder.cleanVertices(meshData.solidVerts, meshData.solidTris);
    TerrainBuilder.cleanVertices(meshData.liquidVerts, meshData.liquidTris);

    // gather all mesh data for final data check, and bounds calculation
    const allVerts = new G3DArray(Float32Array);
    allVerts.appendArray(meshData.liquidVerts);
    allVerts.appendArray(meshData.solidVerts);

    if (!allVerts.size()) {
      ++this.m_mapBuilder.m_totalTilesProcessed;
      return;
    }

    // get bounds of current tile
    const bmin = new Float32Array(3);
    const bmax = new Float32Array(3);
    this.m_mapBuilder.getTileBounds(tileX, tileY, allVerts.getCArray(), (allVerts.size() / 3) | 0, bmin, bmax);
    this.m_terrainBuilder.loadOffMeshConnections(mapID, tileX, tileY, meshData, this.m_mapBuilder.getConfig().OffMeshConnections());

    // build navmesh tile
    await this.buildMoveMapTile(mapID, tileX, tileY, meshData, bmin, bmax, navMesh);

    ++this.m_mapBuilder.m_totalTilesProcessed;
  }

  /** move map building. @ac tools/mmaps_generator/MapBuilder.cpp MMAP::TileBuilder::buildMoveMapTile */
  async buildMoveMapTile(
    mapID: number,
    tileX: number,
    tileY: number,
    meshData: MeshData,
    bmin: Float32Array,
    bmax: Float32Array,
    navMesh: dtNavMesh,
  ): Promise<void> {
    // console output
    const tileString = `[Map ${pad(mapID, 3)}] [${pad(tileX, 2)},${pad(tileY, 2)}]: `;
    console.log(`${tileString} Building movemap tiles...`);

    const iv = new IntermediateValues();

    const tVerts = meshData.solidVerts.getCArray();
    const tVertCount = (meshData.solidVerts.size() / 3) | 0;
    const tTris = meshData.solidTris.getCArray();
    const tTriCount = (meshData.solidTris.size() / 3) | 0;

    const lVerts = meshData.liquidVerts.getCArray();
    const lVertCount = (meshData.liquidVerts.size() / 3) | 0;
    const lTris = meshData.liquidTris.getCArray();
    const lTriCount = (meshData.liquidTris.size() / 3) | 0;
    const lTriFlags = meshData.liquidType.getCArray();

    const cfg = this.m_mapBuilder.getConfig().GetConfigForTile(mapID, tileX, tileY);
    const tilesPerMap = cfg.tilesPerMapEdge;
    const baseUnitDim = cfg.baseUnitDim;

    const config = this.m_mapBuilder.getRecastConfig(cfg, bmin, bmax);

    // this sets the dimensions of the heightfield - should maybe happen before border padding
    const gw: rcRef<number> = { value: 0 };
    const gh: rcRef<number> = { value: 0 };
    rcCalcGridSize(config.bmin, config.bmax, config.cs, gw, gh);
    config.width = gw.value;
    config.height = gh.value;

    // allocate subregions : tiles
    const tiles: Tile[] = [];
    for (let i = 0; i < tilesPerMap * tilesPerMap; ++i) tiles.push(new Tile());

    // Initialize per tile config.
    const tileCfg = cloneRcConfig(config);
    tileCfg.width = config.tileSize + config.borderSize * 2;
    tileCfg.height = config.tileSize + config.borderSize * 2;

    // merge per tile poly and detail meshes
    const pmmerge: rcPolyMesh[] = [];
    const dmmerge: rcPolyMeshDetail[] = [];
    let nmerge = 0;

    // build all tiles
    for (let y = 0; y < tilesPerMap; ++y) {
      for (let x = 0; x < tilesPerMap; ++x) {
        const tile = tiles[x + y * tilesPerMap]!;

        // Calculate the per tile bounding box.
        const tileExtent = f32(f32(config.tileSize * config.cs));
        tileCfg.bmin[0] = f32(config.bmin[0]! + f32(x * tileExtent));
        tileCfg.bmin[2] = f32(config.bmin[2]! + f32(y * tileExtent));
        tileCfg.bmax[0] = f32(config.bmin[0]! + f32((x + 1) * tileExtent));
        tileCfg.bmax[2] = f32(config.bmin[2]! + f32((y + 1) * tileExtent));

        tileCfg.bmin[0] = f32(tileCfg.bmin[0]! - f32(tileCfg.borderSize * tileCfg.cs));
        tileCfg.bmin[2] = f32(tileCfg.bmin[2]! - f32(tileCfg.borderSize * tileCfg.cs));
        tileCfg.bmax[0] = f32(tileCfg.bmax[0]! + f32(tileCfg.borderSize * tileCfg.cs));
        tileCfg.bmax[2] = f32(tileCfg.bmax[2]! + f32(tileCfg.borderSize * tileCfg.cs));

        // build heightfield
        tile.solid = rcAllocHeightfield();
        if (!rcCreateHeightfield(this.m_rcContext, tile.solid, tileCfg.width, tileCfg.height, tileCfg.bmin, tileCfg.bmax, tileCfg.cs, tileCfg.ch)) {
          console.log(`${tileString} Failed building heightfield!            `);
          continue;
        }

        // mark all walkable tiles, both liquids and solids

        const triFlags = new Uint8Array(tTriCount);
        triFlags.fill(NAV_GROUND);
        rcClearUnwalkableTriangles(this.m_rcContext, tileCfg.walkableSlopeAngle, tVerts, tVertCount, tTris, tTriCount, triFlags);
        rcRasterizeTriangles(this.m_rcContext, tVerts, tVertCount, tTris, triFlags, tTriCount, tile.solid, config.walkableClimb);

        rcFilterLowHangingWalkableObstacles(this.m_rcContext, config.walkableClimb, tile.solid);
        rcFilterLedgeSpans(this.m_rcContext, tileCfg.walkableHeight, tileCfg.walkableClimb, tile.solid);
        rcFilterWalkableLowHeightSpans(this.m_rcContext, tileCfg.walkableHeight, tile.solid);

        // add liquid triangles
        rcRasterizeTriangles(this.m_rcContext, lVerts, lVertCount, lTris, lTriFlags, lTriCount, tile.solid, config.walkableClimb);

        // compact heightfield spans
        tile.chf = rcAllocCompactHeightfield();
        if (!rcBuildCompactHeightfield(this.m_rcContext, tileCfg.walkableHeight, tileCfg.walkableClimb, tile.solid, tile.chf)) {
          console.log(`${tileString} Failed compacting heightfield!            `);
          continue;
        }

        // build polymesh intermediates
        if (!rcErodeWalkableArea(this.m_rcContext, config.walkableRadius, tile.chf)) {
          console.log(`${tileString} Failed eroding area!                    `);
          continue;
        }

        if (!rcBuildDistanceField(this.m_rcContext, tile.chf)) {
          console.log(`${tileString} Failed building distance field!         `);
          continue;
        }

        if (!rcBuildRegions(this.m_rcContext, tile.chf, tileCfg.borderSize, tileCfg.minRegionArea, tileCfg.mergeRegionArea)) {
          console.log(`${tileString} Failed building regions!                `);
          continue;
        }

        tile.cset = rcAllocContourSet();
        if (!rcBuildContours(this.m_rcContext, tile.chf, tileCfg.maxSimplificationError, tileCfg.maxEdgeLen, tile.cset)) {
          console.log(`${tileString} Failed building contours!               `);
          continue;
        }

        // build polymesh
        tile.pmesh = rcAllocPolyMesh();
        if (!rcBuildPolyMesh(this.m_rcContext, tile.cset, tileCfg.maxVertsPerPoly, tile.pmesh)) {
          console.log(`${tileString} Failed building polymesh!               `);
          continue;
        }

        tile.dmesh = rcAllocPolyMeshDetail();
        if (!rcBuildPolyMeshDetail(this.m_rcContext, tile.pmesh, tile.chf, tileCfg.detailSampleDist, tileCfg.detailSampleMaxError, tile.dmesh)) {
          console.log(`${tileString} Failed building polymesh detail!        `);
          continue;
        }

        // free those up
        // we may want to keep them in the future for debug
        // but right now, we don't have the code to merge them
        tile.solid = null;
        tile.chf = null;
        tile.cset = null;

        pmmerge[nmerge] = tile.pmesh;
        dmmerge[nmerge] = tile.dmesh;
        nmerge++;
      }
    }

    iv.polyMesh = rcAllocPolyMesh();
    rcMergePolyMeshes(this.m_rcContext, pmmerge, nmerge, iv.polyMesh);

    iv.polyMeshDetail = rcAllocPolyMeshDetail();
    rcMergePolyMeshDetails(this.m_rcContext, dmmerge, nmerge, iv.polyMeshDetail);

    // free things up
    tiles.length = 0;

    // set polygons as walkable
    /// @todo: special flags for DYNAMIC polygons, ie surfaces that can be turned on and off
    for (let i = 0; i < iv.polyMesh.npolys; ++i) if (iv.polyMesh.areas![i]! & RC_WALKABLE_AREA) iv.polyMesh.flags![i] = iv.polyMesh.areas![i]!;

    // setup mesh parameters
    const params = new dtNavMeshCreateParams();
    params.verts = iv.polyMesh.verts;
    params.vertCount = iv.polyMesh.nverts;
    params.polys = iv.polyMesh.polys;
    params.polyAreas = iv.polyMesh.areas;
    params.polyFlags = iv.polyMesh.flags;
    params.polyCount = iv.polyMesh.npolys;
    params.nvp = iv.polyMesh.nvp;
    params.detailMeshes = iv.polyMeshDetail.meshes;
    params.detailVerts = iv.polyMeshDetail.verts;
    params.detailVertsCount = iv.polyMeshDetail.nverts;
    params.detailTris = iv.polyMeshDetail.tris;
    params.detailTriCount = iv.polyMeshDetail.ntris;

    params.offMeshConVerts = meshData.offMeshConnections.getCArray();
    params.offMeshConCount = (meshData.offMeshConnections.size() / 6) | 0;
    params.offMeshConRad = meshData.offMeshConnectionRads.getCArray();
    params.offMeshConDir = meshData.offMeshConnectionDirs.getCArray();
    params.offMeshConAreas = meshData.offMeshConnectionsAreas.getCArray();
    params.offMeshConFlags = meshData.offMeshConnectionsFlags.getCArray();

    params.walkableHeight = f32(baseUnitDim * config.walkableHeight); // agent height
    params.walkableRadius = f32(baseUnitDim * config.walkableRadius); // agent radius
    params.walkableClimb = f32(baseUnitDim * config.walkableClimb); // keep less that walkableHeight (aka agent height)!
    const orig = navMesh.getParams().orig;
    params.tileX = Math.trunc(f32(f32(f32(f32(bmin[0]! + bmax[0]!) / 2) - orig[0]!) / GRID_SIZE));
    params.tileY = Math.trunc(f32(f32(f32(f32(bmin[2]! + bmax[2]!) / 2) - orig[2]!) / GRID_SIZE));
    rcVcopy(params.bmin, 0, bmin, 0);
    rcVcopy(params.bmax, 0, bmax, 0);
    params.cs = config.cs;
    params.ch = config.ch;
    params.tileLayer = 0;
    params.buildBvTree = true;

    // will hold final navmesh
    const navData: { value: Uint8Array | null } = { value: null };
    const navDataSize = { value: 0 };

    do {
      // these values are checked within dtCreateNavMeshData - handle them here
      // so we have a clear error message
      if (params.nvp > DT_VERTS_PER_POLYGON) {
        console.log(`${tileString} Invalid verts-per-polygon value!        `);
        break;
      }
      if (params.vertCount >= 0xffff) {
        console.log(`${tileString} Too many vertices! ${params.vertCount} out of ${0xffff}!        `);
        break;
      }
      if (!params.vertCount || !params.verts) {
        // occurs mostly when adjacent tiles have models
        // loaded but those models don't span into this tile

        // message is an annoyance
        console.log(`${tileString}No vertices to build tile!              `);
        break;
      }
      if (!params.polyCount || !params.polys) {
        // we have flat tiles with no actual geometry - don't build those, its useless
        // keep in mind that we do output those into debug info
        console.log(`${tileString} No polygons to build on tile!              `);
        break;
      }
      if (!params.detailMeshes || !params.detailVerts || !params.detailTris) {
        console.log(`${tileString} No detail mesh to build tile!           `);
        break;
      }

      console.log(`${tileString} Building navmesh tile...`);
      if (!dtCreateNavMeshData(params, navData, navDataSize)) {
        console.log(`${tileString} Failed building navmesh tile!           `);
        break;
      }

      const tileRefOut = new Float64Array(1);
      console.log(`${tileString} Adding tile to navmesh...`);
      // DT_TILE_FREE_DATA tells detour to unallocate memory when the tile
      // is removed via removeTile()
      const dtResult = navMesh.addTile(navData.value!, navDataSize.value, DT_TILE_FREE_DATA, 0, tileRefOut);
      const tileRef = tileRefOut[0]!;
      if (!tileRef || dtResult !== DT_SUCCESS) {
        console.log(`${tileString} Failed adding tile to navmesh!           `);
        break;
      }

      // file output
      const fileName = TILE_FILE_NAME_FORMAT(this.m_mapBuilder.getConfig().DataDirPath(), mapID, tileY, tileX);

      // write header
      const header = new MmapTileHeader();
      header.usesLiquids = this.m_terrainBuilder.usesLiquids() ? 1 : 0;
      header.size = navDataSize.value >>> 0;
      Object.assign(header.recastConfig, cfg.toMMAPTileRecastConfig());

      // write data
      const out = new Uint8Array(SIZEOF_MMAP_TILE_HEADER + navDataSize.value);
      out.set(header.toBytes(), 0);
      out.set(navData.value!.subarray(0, navDataSize.value), SIZEOF_MMAP_TILE_HEADER);

      try {
        console.log(`${tileString} Writing to file...`);
        await Bun.write(fileName, out);
      } catch (e) {
        console.error(`[Map ${pad(mapID, 3)}] Failed to open ${fileName} for writing!\n: ${(e as Error).message}`);
        navMesh.removeTile(tileRef, null, null);
        break;
      }

      // now that tile is written to disk, we can unload it
      navMesh.removeTile(tileRef, null, null);
    } while (false);

    if (this.m_debugOutput) {
      // restore padding so that the debug visualization is correct
      for (let i = 0; i < iv.polyMesh.nverts; ++i) {
        const v = i * 3;
        iv.polyMesh.verts![v] = (iv.polyMesh.verts![v]! + config.borderSize) & 0xffff;
        iv.polyMesh.verts![v + 2] = (iv.polyMesh.verts![v + 2]! + config.borderSize) & 0xffff;
      }

      await iv.generateObjFile(this.m_mapBuilder.getConfig().DataDirPath(), mapID, tileX, tileY, meshData);
      await iv.writeIV(this.m_mapBuilder.getConfig().DataDirPath(), mapID, tileX, tileY);
    }
  }

  /** @ac tools/mmaps_generator/MapBuilder.cpp MMAP::TileBuilder::shouldSkipTile */
  async shouldSkipTile(mapID: number, tileX: number, tileY: number): Promise<boolean> {
    const fileName = TILE_FILE_NAME_FORMAT(this.m_mapBuilder.getConfig().DataDirPath(), mapID, tileY, tileX);

    const file = Bun.file(fileName);
    if (!(await file.exists())) return false;

    if (file.size < SIZEOF_MMAP_TILE_HEADER) return false;
    const header = MmapTileHeader.fromBytes(new Uint8Array(await file.slice(0, SIZEOF_MMAP_TILE_HEADER).arrayBuffer()));
    if (!header) return false;

    if (header.mmapMagic !== MMAP_MAGIC || header.dtVersion !== DT_NAVMESH_VERSION) return false;

    if (header.mmapVersion !== MMAP_VERSION) return false;

    const desiredRecastConfig = this.m_mapBuilder.getConfig().GetConfigForTile(mapID, tileX, tileY).toMMAPTileRecastConfig();
    return header.recastConfig.equals(desiredRecastConfig);
  }
}

/** @ac tools/mmaps_generator/MapBuilder.h MMAP::MapBuilder */
export class MapBuilder {
  private m_terrainBuilder: TerrainBuilder;
  private m_tiles: TileList = [];

  private m_debugOutput: boolean;

  private m_threads: number;
  private m_skipContinents: boolean;
  private m_skipJunkMaps: boolean;
  private m_skipBattlegrounds: boolean;
  private m_skipLiquid: boolean;

  private m_mapid: number;

  private m_config: Config;

  m_totalTiles = 0;
  m_totalTilesProcessed = 0;

  /** build performance - not really used for now */
  private m_rcContext: rcContext;

  /** `ProducerConsumerQueue<TileInfo> _queue` */
  private _queue: TileInfo[] = [];

  /**
   * `discover = false` is for the worker threads, which only need the tile builder side (`getConfig`,
   * `getTileBounds`, `getRecastConfig`); the C++ workers share the `MapBuilder` of the main thread instead.
   * @ac tools/mmaps_generator/MapBuilder.cpp MMAP::MapBuilder::MapBuilder
   */
  constructor(config: Config, mapid: number, threads: number, discover = true) {
    this.m_config = config;
    this.m_debugOutput = config.IsDebugOutputEnabled();
    this.m_threads = threads;
    this.m_skipContinents = config.ShouldSkipContinents();
    this.m_skipJunkMaps = config.ShouldSkipJunkMaps();
    this.m_skipBattlegrounds = config.ShouldSkipBattlegrounds();
    this.m_skipLiquid = config.ShouldSkipLiquid();
    this.m_mapid = mapid;

    this.m_terrainBuilder = new TerrainBuilder(config.DataDirPath(), config.ShouldSkipLiquid());

    this.m_rcContext = new rcContext(false);

    // At least 1 thread is needed
    this.m_threads = Math.max(1, this.m_threads);

    if (discover) this.discoverTiles();
  }

  /** detect maps and tiles. @ac tools/mmaps_generator/MapBuilder.cpp MMAP::MapBuilder::discoverTiles */
  private discoverTiles(): void {
    let files: string[] = [];
    let count = 0;
    let mapID: number;
    let tileX: number;
    let tileY: number;
    let tileID: number;

    process.stdout.write("Discovering maps... ");
    getDirContents(files, this.m_config.MapsPath());
    for (const file of files) {
      mapID = atoi(file.length < 8 ? file : file.slice(0, file.length - 8)) >>> 0;
      if (!this.m_tiles.some((t) => t.equals(mapID))) {
        this.m_tiles.push(new MapTiles(mapID, new Set<number>()));
        count++;
      }
    }

    files = [];
    getDirContents(files, this.m_config.VMapsPath(), "*.vmtree");
    for (const file of files) {
      mapID = atoi(file.length < 7 ? file : file.slice(0, file.length - 7)) >>> 0;
      if (!this.m_tiles.some((t) => t.equals(mapID))) {
        this.m_tiles.push(new MapTiles(mapID, new Set<number>()));
        count++;
      }
    }
    console.log(`found ${count}.`);

    count = 0;
    process.stdout.write("Discovering tiles... ");
    for (const m_tile of this.m_tiles) {
      const tiles = m_tile.m_tiles!;
      mapID = m_tile.m_mapId;

      let filter = `${pad(mapID, 3)}*.vmtile`;
      files = [];
      getDirContents(files, this.m_config.VMapsPath(), filter);
      for (const file of files) {
        const fsize = file.length;

        tileY = atoi(file.substr(fsize - 12, 2)) >>> 0;
        tileX = atoi(file.substr(fsize - 9, 2)) >>> 0;
        tileID = StaticMapTree.packTileID(tileY, tileX);

        tiles.add(tileID);
        count++;
      }

      filter = `${pad(mapID, 3)}*`;
      files = [];
      getDirContents(files, this.m_config.MapsPath(), filter);
      for (const file of files) {
        const fsize = file.length;

        tileY = atoi(file.substr(fsize - 8, 2)) >>> 0;
        tileX = atoi(file.substr(fsize - 6, 2)) >>> 0;
        tileID = StaticMapTree.packTileID(tileX, tileY);

        if (!tiles.has(tileID)) {
          tiles.add(tileID);
          count++;
        }
      }

      // make sure we process maps which don't have tiles
      if (tiles.size === 0) {
        // convert coord bounds to grid bounds
        const { minX, minY, maxX, maxY } = this.getGridBounds(mapID);

        // add all tiles within bounds to tile list.
        for (let i = minX; i <= maxX; ++i)
          for (let j = minY; j <= maxY; ++j) {
            const id = StaticMapTree.packTileID(i, j);
            if (!tiles.has(id)) {
              tiles.add(id);
              count++;
            }
          }
      }
    }
    console.log(`found ${count}.\n`);

    // Calculate tiles to process in total
    for (const m_tile of this.m_tiles) {
      if (!this.shouldSkipMap(m_tile.m_mapId)) this.m_totalTiles += m_tile.m_tiles!.size;
    }
  }

  /** @ac tools/mmaps_generator/MapBuilder.cpp MMAP::MapBuilder::getTileList */
  private getTileList(mapID: number): Set<number> {
    const itr = this.m_tiles.find((t) => t.equals(mapID));
    if (itr) return itr.m_tiles!;

    const tiles = new Set<number>();
    this.m_tiles.push(new MapTiles(mapID, tiles));
    return tiles;
  }

  /**
   * builds list of maps, then builds all of mmap tiles (based on the skip settings)
   * @ac tools/mmaps_generator/MapBuilder.cpp MMAP::MapBuilder::buildMaps
   */
  async buildMaps(mapID: number | null): Promise<void> {
    console.log(`Using ${this.m_threads} threads to generate mmaps`);

    if (mapID !== null) {
      await this.buildMap(mapID);
    } else {
      // Build all maps if no map id has been specified
      for (const it of this.m_tiles) {
        if (!this.shouldSkipMap(it.m_mapId)) await this.buildMap(it.m_mapId);
      }
    }

    await this.processQueue();
  }

  /**
   * The `TileBuilder` threads of the C++: one inline `TileBuilder` for a single thread, otherwise `m_threads` workers.
   * @ac tools/mmaps_generator/MapBuilder.cpp MMAP::TileBuilder::WorkerThread
   */
  private async processQueue(): Promise<void> {
    if (this._queue.length === 0) return;

    if (this.m_threads <= 1) {
      const builder = new TileBuilder(this, this.m_skipLiquid, this.m_debugOutput);
      await builder.WorkerThread(this._queue);
      return;
    }

    const workerCount = Math.min(this.m_threads, this._queue.length);
    const workers: Worker[] = [];
    const finished: Promise<void>[] = [];
    for (let i = 0; i < workerCount; ++i) {
      const worker = new Worker(new URL("./TileBuilderWorker.ts", import.meta.url).href);
      workers.push(worker);
      finished.push(
        new Promise<void>((resolve, reject) => {
          const feed = (): void => {
            const tileInfo = this._queue.shift();
            if (!tileInfo) {
              resolve();
              return;
            }
            worker.postMessage({
              kind: "tile",
              mapId: tileInfo.m_mapId,
              tileX: tileInfo.m_tileX,
              tileY: tileInfo.m_tileY,
              params: tileInfo.m_navMeshParams.toBytes(),
              percent: this.currentPercentageDone(),
            });
          };
          worker.onmessage = (ev: MessageEvent): void => {
            const msg = ev.data as { kind: string; processed?: number; error?: string };
            if (msg.kind === "ready") feed();
            else if (msg.kind === "done") {
              this.m_totalTilesProcessed += msg.processed ?? 1;
              feed();
            } else if (msg.kind === "error") reject(new Error(msg.error));
          };
          worker.onerror = (ev: ErrorEvent): void => reject(new Error(ev.message));
          worker.postMessage({
            kind: "init",
            configFile: this.m_config.sourceFile,
            mapid: this.m_mapid,
          });
        }),
      );
    }

    try {
      await Promise.all(finished);
    } finally {
      for (const w of workers) w.terminate();
    }
  }

  /** @ac tools/mmaps_generator/MapBuilder.cpp MMAP::MapBuilder::getGridBounds */
  private getGridBounds(mapID: number): { minX: number; minY: number; maxX: number; maxY: number } {
    // min and max are initialized to invalid values so the caller iterating the [min, max] range
    // will never enter the loop unless valid min/max values are found
    let maxX = 0;
    let maxY = 0;
    let minX = 0xffffffff;
    let minY = 0xffffffff;

    const bmin = new Float32Array(3);
    const bmax = new Float32Array(3);
    const lmin = new Float32Array(3);
    const lmax = new Float32Array(3);
    const meshData = new MeshData();

    // make sure we process maps which don't have tiles
    // initialize the static tree, which loads WDT models
    if (!this.m_terrainBuilder.loadVMap(mapID, 64, 64, meshData)) return { minX, minY, maxX, maxY };

    // get the coord bounds of the model data
    if (meshData.solidVerts.size() + meshData.liquidVerts.size() === 0) return { minX, minY, maxX, maxY };

    // get the coord bounds of the model data
    if (meshData.solidVerts.size() && meshData.liquidVerts.size()) {
      rcCalcBounds(meshData.solidVerts.getCArray(), (meshData.solidVerts.size() / 3) | 0, bmin, bmax);
      rcCalcBounds(meshData.liquidVerts.getCArray(), (meshData.liquidVerts.size() / 3) | 0, lmin, lmax);
      rcVmin(bmin, 0, lmin, 0);
      rcVmax(bmax, 0, lmax, 0);
    } else if (meshData.solidVerts.size()) rcCalcBounds(meshData.solidVerts.getCArray(), (meshData.solidVerts.size() / 3) | 0, bmin, bmax);
    else rcCalcBounds(meshData.liquidVerts.getCArray(), (meshData.liquidVerts.size() / 3) | 0, lmin, lmax);

    // convert coord bounds to grid bounds
    maxX = floatToUint32(f32(32 - f32(bmin[0]! / GRID_SIZE)));
    maxY = floatToUint32(f32(32 - f32(bmin[2]! / GRID_SIZE)));
    minX = floatToUint32(f32(32 - f32(bmax[0]! / GRID_SIZE)));
    minY = floatToUint32(f32(32 - f32(bmax[2]! / GRID_SIZE)));
    return { minX, minY, maxX, maxY };
  }

  /** @ac tools/mmaps_generator/MapBuilder.cpp MMAP::MapBuilder::buildMeshFromFile */
  async buildMeshFromFile(name: string): Promise<void> {
    const f = Bun.file(name);
    if (!(await f.exists())) return;
    const bytes = new Uint8Array(await f.arrayBuffer());
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let pos = 0;
    const need = (n: number): boolean => pos + n <= bytes.length;

    console.log("Building mesh from file");
    if (!need(4)) return;
    const mapId = view.getInt32(pos, true);
    pos += 4;
    if (!need(4)) return;
    const tileX = view.getInt32(pos, true);
    pos += 4;
    if (!need(4)) return;
    const tileY = view.getInt32(pos, true);
    pos += 4;

    const navMesh = await this.buildNavMesh(mapId);
    if (!navMesh) {
      console.log("Failed creating navmesh!              ");
      return;
    }

    if (!need(4)) return;
    const verticesCount = view.getUint32(pos, true);
    pos += 4;
    if (!need(4)) return;
    const indicesCount = view.getUint32(pos, true);
    pos += 4;

    if (!need(verticesCount * 4)) return;
    const verts = new Float32Array(verticesCount);
    for (let i = 0; i < verticesCount; ++i) verts[i] = view.getFloat32(pos + i * 4, true);
    pos += verticesCount * 4;

    if (!need(indicesCount * 4)) return;
    const inds = new Int32Array(indicesCount);
    for (let i = 0; i < indicesCount; ++i) inds[i] = view.getInt32(pos + i * 4, true);

    const data = new MeshData();

    for (let i = 0; i < verticesCount; ++i) data.solidVerts.append(verts[i]!);

    for (let i = 0; i < indicesCount; ++i) data.solidTris.append(inds[i]!);

    TerrainBuilder.cleanVertices(data.solidVerts, data.solidTris);
    // get bounds of current tile
    const bmin = new Float32Array(3);
    const bmax = new Float32Array(3);
    this.getTileBounds(tileX, tileY, data.solidVerts.getCArray(), (data.solidVerts.size() / 3) | 0, bmin, bmax);

    // build navmesh tile
    const tileBuilder = new TileBuilder(this, this.m_skipLiquid, this.m_debugOutput);
    await tileBuilder.buildMoveMapTile(mapId, tileX, tileY, data, bmin, bmax, navMesh);
  }

  /** builds an mmap tile for the specified map and its mesh. @ac tools/mmaps_generator/MapBuilder.cpp MMAP::MapBuilder::buildSingleTile */
  async buildSingleTile(mapID: number, tileX: number, tileY: number): Promise<void> {
    const navMesh = await this.buildNavMesh(mapID);
    if (!navMesh) {
      console.log("Failed creating navmesh!              ");
      return;
    }

    /// @todo: delete the old tile as the user clearly wants to rebuild it

    const tileBuilder = new TileBuilder(this, this.m_skipLiquid, this.m_debugOutput);
    await tileBuilder.buildTile(mapID, tileX, tileY, navMesh);
    dtFreeNavMesh(navMesh);
  }

  /** builds all mmap tiles for the specified map id (ignores skip settings). @ac tools/mmaps_generator/MapBuilder.cpp MMAP::MapBuilder::buildMap */
  private async buildMap(mapID: number): Promise<void> {
    const tiles = this.getTileList(mapID);

    if (tiles.size !== 0) {
      // build navMesh
      const navMesh = await this.buildNavMesh(mapID);
      if (!navMesh) {
        console.log(`[Map ${pad(mapID, 3)}] Failed creating navmesh!`);
        this.m_totalTilesProcessed += tiles.size;
        return;
      }

      // now start building mmtiles for each tile
      console.log(`[Map ${pad(mapID, 3)}] We have ${tiles.size} tiles.                          `);
      for (const tile of tiles) {
        // unpack tile coords
        const [tileX, tileY] = StaticMapTree.unpackTileID(tile);

        const tileInfo = new TileInfo();
        tileInfo.m_mapId = mapID;
        tileInfo.m_tileX = tileX;
        tileInfo.m_tileY = tileY;
        tileInfo.m_navMeshParams.copyFrom(navMesh.getParams());
        this._queue.push(tileInfo);
      }

      dtFreeNavMesh(navMesh);
    }
  }

  /** @ac tools/mmaps_generator/MapBuilder.cpp MMAP::MapBuilder::buildNavMesh */
  private async buildNavMesh(mapID: number): Promise<dtNavMesh | null> {
    const tiles = this.getTileList(mapID);

    // old code for non-statically assigned bitmask sizes:
    ///*** calculate number of bits needed to store tiles & polys ***/
    //int tileBits = dtIlog2(dtNextPow2(tiles->size()));
    //if (tileBits < 1) tileBits = 1;                                     // need at least one bit!
    //int polyBits = sizeof(dtPolyRef)*8 - SALT_MIN_BITS - tileBits;

    const polyBits = DT_POLY_BITS;

    const maxTiles = tiles.size;
    const maxPolysPerTile = 1 << polyBits;

    /***          calculate bounds of map         ***/

    let tileXMin = 64;
    let tileYMin = 64;
    let tileXMax = 0;
    let tileYMax = 0;
    for (const tile of tiles) {
      const [tileX, tileY] = StaticMapTree.unpackTileID(tile);

      if (tileX > tileXMax) tileXMax = tileX;
      else if (tileX < tileXMin) tileXMin = tileX;

      if (tileY > tileYMax) tileYMax = tileY;
      else if (tileY < tileYMin) tileYMin = tileY;
    }

    // use Max because '32 - tileX' is negative for values over 32
    const bmin = new Float32Array(3);
    const bmax = new Float32Array(3);
    this.getTileBounds(tileXMax, tileYMax, null, 0, bmin, bmax);

    /***       now create the navmesh       ***/

    // navmesh creation params
    const navMeshParams = new dtNavMeshParams();
    navMeshParams.tileWidth = GRID_SIZE;
    navMeshParams.tileHeight = GRID_SIZE;
    rcVcopy(navMeshParams.orig, 0, bmin, 0);
    navMeshParams.maxTiles = maxTiles;
    navMeshParams.maxPolys = maxPolysPerTile;

    const navMesh = dtAllocNavMesh();
    console.log(`[Map ${pad(mapID, 3)}] Creating navMesh...`);
    if (!navMesh.init(navMeshParams)) {
      console.log(`[Map ${pad(mapID, 3)}] Failed creating navmesh!                `);
      return navMesh;
    }

    const fileName = MAP_FILE_NAME_FORMAT(this.m_config.DataDirPath(), mapID);

    // now that we know navMesh params are valid, we can write them to file
    try {
      await Bun.write(fileName, navMeshParams.toBytes());
    } catch (e) {
      dtFreeNavMesh(navMesh);
      console.error(`[Map ${pad(mapID, 3)}] Failed to open ${fileName} for writing!\n: ${(e as Error).message}`);
      return null;
    }
    return navMesh;
  }

  /** @ac tools/mmaps_generator/MapBuilder.cpp MMAP::MapBuilder::getTileBounds */
  getTileBounds(tileX: number, tileY: number, verts: Float32Array | null, vertCount: number, bmin: Float32Array, bmax: Float32Array): void {
    // this is for elevation
    if (verts && vertCount) rcCalcBounds(verts, vertCount, bmin, bmax);
    else {
      bmin[1] = FLT_MIN;
      bmax[1] = FLT_MAX;
    }

    // this is for width and depth
    bmax[0] = f32(f32(32 - (tileX | 0)) * GRID_SIZE);
    bmax[2] = f32(f32(32 - (tileY | 0)) * GRID_SIZE);
    bmin[0] = f32(bmax[0]! - GRID_SIZE);
    bmin[2] = f32(bmax[2]! - GRID_SIZE);
  }

  /** @ac tools/mmaps_generator/MapBuilder.cpp MMAP::MapBuilder::shouldSkipMap */
  private shouldSkipMap(mapID: number): boolean {
    if (this.m_mapid >= 0) return this.m_mapid >>> 0 !== mapID;

    if (this.m_skipContinents) if (this.isContinentMap(mapID)) return true;

    if (this.m_skipJunkMaps)
      switch (mapID) {
        case 13: // test.wdt
        case 25: // ScottTest.wdt
        case 29: // Test.wdt
        case 42: // Colin.wdt
        case 169: // EmeraldDream.wdt (unused, and very large)
        case 451: // development.wdt
        case 573: // ExteriorTest.wdt
        case 597: // CraigTest.wdt
        case 605: // development_nonweighted.wdt
        case 606: // QA_DVD.wdt
          return true;
        default:
          if (this.isTransportMap(mapID)) return true;
          break;
      }

    if (this.m_skipBattlegrounds)
      switch (mapID) {
        case 30: // AV
        case 37: // ?
        case 489: // WSG
        case 529: // AB
        case 566: // EotS
        case 607: // SotA
        case 628: // IoC
          return true;
        default:
          break;
      }

    return false;
  }

  /** @ac tools/mmaps_generator/MapBuilder.cpp MMAP::MapBuilder::isTransportMap */
  private isTransportMap(mapID: number): boolean {
    switch (mapID) {
      // transport maps
      case 582:
      case 584:
      case 586:
      case 587:
      case 588:
      case 589:
      case 590:
      case 591:
      case 592:
      case 593:
      case 594:
      case 596:
      case 610:
      case 612:
      case 613:
      case 614:
      case 620:
      case 621:
      case 622:
      case 623:
      case 641:
      case 642:
      case 647:
      case 672:
      case 673:
      case 712:
      case 713:
      case 718:
        return true;
      default:
        return false;
    }
  }

  /** @ac tools/mmaps_generator/MapBuilder.cpp MMAP::MapBuilder::isContinentMap */
  private isContinentMap(mapID: number): boolean {
    switch (mapID) {
      case 0:
      case 1:
      case 530:
      case 571:
        return true;
      default:
        return false;
    }
  }

  /** @ac tools/mmaps_generator/MapBuilder.cpp MMAP::MapBuilder::getRecastConfig */
  getRecastConfig(cfg: ResolvedMeshConfig, bmin: Float32Array, bmax: Float32Array): rcConfig {
    const config = new rcConfig();

    rcVcopy(config.bmin, 0, bmin, 0);
    rcVcopy(config.bmax, 0, bmax, 0);

    config.maxVertsPerPoly = DT_VERTS_PER_POLYGON;
    config.cs = f32(cfg.cellSizeHorizontal);
    config.ch = f32(cfg.cellSizeVertical);
    config.walkableSlopeAngle = cfg.walkableSlopeAngle;
    config.tileSize = cfg.vertexPerTileEdge;
    config.walkableRadius = cfg.walkableRadius;
    config.borderSize = cfg.walkableRadius + 3;
    config.maxEdgeLen = cfg.vertexPerTileEdge + 1; // anything bigger than tileSize
    config.walkableHeight = cfg.walkableHeight;
    config.walkableClimb = cfg.walkableClimb;
    config.minRegionArea = 60 * 60;
    config.mergeRegionArea = 50 * 50;
    config.maxSimplificationError = cfg.maxSimplificationError; // eliminates most jagged edges (tiny polygons)
    config.detailSampleDist = f32(config.cs * 16);
    config.detailSampleMaxError = f32(config.ch * 1);
    return config;
  }

  /** @ac tools/mmaps_generator/MapBuilder.cpp MMAP::MapBuilder::percentageDone */
  percentageDone(totalTiles: number, totalTilesBuilt: number): number {
    if (totalTiles) return Math.trunc((totalTilesBuilt * 100) / totalTiles) >>> 0;

    return 0;
  }

  /** @ac tools/mmaps_generator/MapBuilder.cpp MMAP::MapBuilder::currentPercentageDone */
  currentPercentageDone(): number {
    return this.percentageDone(this.m_totalTiles, this.m_totalTilesProcessed);
  }

  getConfig(): Config {
    return this.m_config;
  }
}

/** `atoi`: leading whitespace, optional sign, digits; 0 when there are none. */
function atoi(s: string): number {
  const m = /^\s*([+-]?\d+)/.exec(s);
  return m ? Number(m[1]) | 0 : 0;
}

/** float to `uint32` assignment (the C++ conversion of the grid bounds). */
function floatToUint32(v: number): number {
  return (Math.trunc(v) | 0) >>> 0;
}

