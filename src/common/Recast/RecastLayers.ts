/**
 * Port of `deps/recastnavigation/Recast/Source/RecastLayers.cpp`.
 *
 * `rcLayerRegion` and `rcLayerSweepSpan` are structs of typed arrays (`regs.ymin[i]` is `regs[i].ymin`) so the
 * unsigned char / unsigned short fields wrap exactly like the C++ members.
 */
import {
  RC_LOG_ERROR,
  RC_NOT_CONNECTED,
  RC_NULL_AREA,
  RC_TIMER_BUILD_LAYERS,
  f32,
  rcGetCon,
  rcGetDirOffsetX,
  rcGetDirOffsetY,
  rcHeightfieldLayer,
  rcMax,
  rcMin,
  rcScopedTimer,
  rcVcopy,
  type rcCompactHeightfield,
  type rcContext,
  type rcHeightfieldLayerSet,
} from "./Recast.ts";
import { rcAssert } from "./RecastAssert.ts";

/** Must be 255 or smaller (not 256) because layer IDs are stored as a byte where 255 is a special value. */
const RC_MAX_LAYERS = 63;
const RC_MAX_NEIS = 16;

/**
 * Per region data of the layer builder. C++ `regs[i].layers[k]` is `layers[i * RC_MAX_LAYERS + k]`, `regs[i].neis[k]`
 * is `neis[i * RC_MAX_NEIS + k]`.
 * @ac deps/recastnavigation/Recast/Source/RecastLayers.cpp rcLayerRegion
 */
class rcLayerRegions {
  readonly layers: Uint8Array;
  readonly neis: Uint8Array;
  readonly ymin: Uint16Array;
  readonly ymax: Uint16Array;
  /** Layer ID. */
  readonly layerId: Uint8Array;
  /** Layer count. */
  readonly nlayers: Uint8Array;
  /** Neighbour count. */
  readonly nneis: Uint8Array;
  /** Flag indicating if the region is the base of merged regions. */
  readonly base: Uint8Array;

  constructor(n: number) {
    this.layers = new Uint8Array(n * RC_MAX_LAYERS);
    this.neis = new Uint8Array(n * RC_MAX_NEIS);
    this.ymin = new Uint16Array(n);
    this.ymax = new Uint16Array(n);
    this.layerId = new Uint8Array(n);
    this.nlayers = new Uint8Array(n);
    this.nneis = new Uint8Array(n);
    this.base = new Uint8Array(n);
  }
}

/** @ac deps/recastnavigation/Recast/Source/RecastLayers.cpp contains */
function contains(a: Uint8Array, aOff: number, an: number, v: number): boolean {
  const n = an;
  for (let i = 0; i < n; ++i) {
    if (a[aOff + i] === v) return true;
  }
  return false;
}

/**
 * `an` is the count member `counts[ci]`.
 * @ac deps/recastnavigation/Recast/Source/RecastLayers.cpp addUnique
 */
function addUnique(a: Uint8Array, aOff: number, counts: Uint8Array, ci: number, anMax: number, v: number): boolean {
  if (contains(a, aOff, counts[ci]!, v)) return true;

  if (counts[ci]! >= anMax) return false;

  a[aOff + counts[ci]!] = v;
  counts[ci]!++;
  return true;
}

/** @ac deps/recastnavigation/Recast/Source/RecastLayers.cpp overlapRange */
function overlapRange(amin: number, amax: number, bmin: number, bmax: number): boolean {
  return amin > bmax || amax < bmin ? false : true;
}

/** @ac deps/recastnavigation/Recast/Source/RecastLayers.cpp rcLayerSweepSpan */
class rcLayerSweepSpans {
  /** number samples */
  readonly ns: Uint16Array;
  /** region id */
  readonly id: Uint8Array;
  /** neighbour id */
  readonly nei: Uint8Array;

  constructor(n: number) {
    this.ns = new Uint16Array(n);
    this.id = new Uint8Array(n);
    this.nei = new Uint8Array(n);
  }
}

/**
 * See the #rcConfig documentation for more information on the configuration parameters.
 * @ac deps/recastnavigation/Recast/Source/RecastLayers.cpp rcBuildHeightfieldLayers
 */
export function rcBuildHeightfieldLayers(
  ctx: rcContext,
  chf: rcCompactHeightfield,
  borderSize: number,
  walkableHeight: number,
  lset: rcHeightfieldLayerSet,
): boolean {
  using _timer = new rcScopedTimer(ctx, RC_TIMER_BUILD_LAYERS);

  const w = chf.width;
  const h = chf.height;
  const con = chf.spans.con;

  const srcReg = new Uint8Array(chf.spanCount);
  srcReg.fill(0xff);

  const nsweeps = chf.width;
  const sweeps = new rcLayerSweepSpans(nsweeps);

  // Partition walkable area into monotone regions.
  const prevCount = new Int32Array(256);
  let regId = 0;

  for (let y = borderSize; y < h - borderSize; ++y) {
    prevCount.fill(0, 0, regId);
    let sweepId = 0;

    for (let x = borderSize; x < w - borderSize; ++x) {
      const c = x + y * w;

      for (let i = chf.cells.index[c]!, ni = chf.cells.index[c]! + chf.cells.count[c]!; i < ni; ++i) {
        if (chf.areas[i] === RC_NULL_AREA) continue;

        let sid = 0xff;

        // -x
        if (rcGetCon(con, i, 0) !== RC_NOT_CONNECTED) {
          const ax = x + rcGetDirOffsetX(0);
          const ay = y + rcGetDirOffsetY(0);
          const ai = chf.cells.index[ax + ay * w]! + rcGetCon(con, i, 0);
          if (chf.areas[ai] !== RC_NULL_AREA && srcReg[ai] !== 0xff) sid = srcReg[ai]!;
        }

        if (sid === 0xff) {
          sid = sweepId;
          sweepId = (sweepId + 1) & 0xff;
          sweeps.nei[sid] = 0xff;
          sweeps.ns[sid] = 0;
        }

        // -y
        if (rcGetCon(con, i, 3) !== RC_NOT_CONNECTED) {
          const ax = x + rcGetDirOffsetX(3);
          const ay = y + rcGetDirOffsetY(3);
          const ai = chf.cells.index[ax + ay * w]! + rcGetCon(con, i, 3);
          const nr = srcReg[ai]!;
          if (nr !== 0xff) {
            // Set neighbour when first valid neighbour is encoutered.
            if (sweeps.ns[sid] === 0) sweeps.nei[sid] = nr;

            if (sweeps.nei[sid] === nr) {
              // Update existing neighbour
              sweeps.ns[sid]!++;
              prevCount[nr]!++;
            } else {
              // This is hit if there is nore than one neighbour.
              // Invalidate the neighbour.
              sweeps.nei[sid] = 0xff;
            }
          }
        }

        srcReg[i] = sid;
      }
    }

    // Create unique ID.
    for (let i = 0; i < sweepId; ++i) {
      // If the neighbour is set and there is only one continuous connection to it,
      // the sweep will be merged with the previous one, else new region is created.
      if (sweeps.nei[i] !== 0xff && prevCount[sweeps.nei[i]!] === sweeps.ns[i]) {
        sweeps.id[i] = sweeps.nei[i]!;
      } else {
        if (regId === 255) {
          ctx.log(RC_LOG_ERROR, "rcBuildHeightfieldLayers: Region ID overflow.");
          return false;
        }
        sweeps.id[i] = regId++;
      }
    }

    // Remap local sweep ids to region ids.
    for (let x = borderSize; x < w - borderSize; ++x) {
      const c = x + y * w;
      for (let i = chf.cells.index[c]!, ni = chf.cells.index[c]! + chf.cells.count[c]!; i < ni; ++i) {
        if (srcReg[i] !== 0xff) srcReg[i] = sweeps.id[srcReg[i]!]!;
      }
    }
  }

  // Allocate and init layer regions.
  const nregs = regId;
  const regs = new rcLayerRegions(nregs);
  for (let i = 0; i < nregs; ++i) {
    regs.layerId[i] = 0xff;
    regs.ymin[i] = 0xffff;
    regs.ymax[i] = 0;
  }

  // Find region neighbours and overlapping regions.
  const lregs = new Uint8Array(RC_MAX_LAYERS);
  for (let y = 0; y < h; ++y) {
    for (let x = 0; x < w; ++x) {
      const c = x + y * w;

      let nlregs = 0;

      for (let i = chf.cells.index[c]!, ni = chf.cells.index[c]! + chf.cells.count[c]!; i < ni; ++i) {
        const ri = srcReg[i]!;
        if (ri === 0xff) continue;

        regs.ymin[ri] = rcMin(regs.ymin[ri]!, chf.spans.y[i]!);
        regs.ymax[ri] = rcMax(regs.ymax[ri]!, chf.spans.y[i]!);

        // Collect all region layers.
        if (nlregs < RC_MAX_LAYERS) lregs[nlregs++] = ri;

        // Update neighbours
        for (let dir = 0; dir < 4; ++dir) {
          if (rcGetCon(con, i, dir) !== RC_NOT_CONNECTED) {
            const ax = x + rcGetDirOffsetX(dir);
            const ay = y + rcGetDirOffsetY(dir);
            const ai = chf.cells.index[ax + ay * w]! + rcGetCon(con, i, dir);
            const rai = srcReg[ai]!;
            if (rai !== 0xff && rai !== ri) {
              // Don't check return value -- if we cannot add the neighbor
              // it will just cause a few more regions to be created, which
              // is fine.
              addUnique(regs.neis, ri * RC_MAX_NEIS, regs.nneis, ri, RC_MAX_NEIS, rai);
            }
          }
        }
      }

      // Update overlapping regions.
      for (let i = 0; i < nlregs - 1; ++i) {
        for (let j = i + 1; j < nlregs; ++j) {
          if (lregs[i] !== lregs[j]) {
            const ri = lregs[i]!;
            const rj = lregs[j]!;

            if (
              !addUnique(regs.layers, ri * RC_MAX_LAYERS, regs.nlayers, ri, RC_MAX_LAYERS, rj) ||
              !addUnique(regs.layers, rj * RC_MAX_LAYERS, regs.nlayers, rj, RC_MAX_LAYERS, ri)
            ) {
              ctx.log(
                RC_LOG_ERROR,
                "rcBuildHeightfieldLayers: layer overflow (too many overlapping walkable platforms). Try increasing RC_MAX_LAYERS.",
              );
              return false;
            }
          }
        }
      }
    }
  }

  // Create 2D layers from regions.
  let layerId = 0;

  const MAX_STACK = 64;
  const stack = new Uint8Array(MAX_STACK);
  let nstack = 0;

  for (let i = 0; i < nregs; ++i) {
    const root = i;
    // Skip already visited.
    if (regs.layerId[root] !== 0xff) continue;

    // Start search.
    regs.layerId[root] = layerId;
    regs.base[root] = 1;

    nstack = 0;
    stack[nstack++] = i;

    while (nstack) {
      // Pop front
      const reg = stack[0]!;
      nstack--;
      for (let j = 0; j < nstack; ++j) stack[j] = stack[j + 1]!;

      const nneis = regs.nneis[reg]!;
      for (let j = 0; j < nneis; ++j) {
        const nei = regs.neis[reg * RC_MAX_NEIS + j]!;
        const regn = nei;
        // Skip already visited.
        if (regs.layerId[regn] !== 0xff) continue;
        // Skip if the neighbour is overlapping root region.
        if (contains(regs.layers, root * RC_MAX_LAYERS, regs.nlayers[root]!, nei)) continue;
        // Skip if the height range would become too large.
        const ymin = rcMin(regs.ymin[root]!, regs.ymin[regn]!);
        const ymax = rcMax(regs.ymax[root]!, regs.ymax[regn]!);
        if (ymax - ymin >= 255) continue;

        if (nstack < MAX_STACK) {
          // Deepen
          stack[nstack++] = nei;

          // Mark layer id
          regs.layerId[regn] = layerId;
          // Merge current layers to root.
          for (let k = 0; k < regs.nlayers[regn]!; ++k) {
            if (!addUnique(regs.layers, root * RC_MAX_LAYERS, regs.nlayers, root, RC_MAX_LAYERS, regs.layers[regn * RC_MAX_LAYERS + k]!)) {
              ctx.log(
                RC_LOG_ERROR,
                "rcBuildHeightfieldLayers: layer overflow (too many overlapping walkable platforms). Try increasing RC_MAX_LAYERS.",
              );
              return false;
            }
          }
          regs.ymin[root] = rcMin(regs.ymin[root]!, regs.ymin[regn]!);
          regs.ymax[root] = rcMax(regs.ymax[root]!, regs.ymax[regn]!);
        }
      }
    }

    layerId++;
  }

  // Merge non-overlapping regions that are close in height.
  const mergeHeight = (walkableHeight * 4) & 0xffff;

  for (let i = 0; i < nregs; ++i) {
    const ri = i;
    if (!regs.base[ri]) continue;

    const newId = regs.layerId[ri]!;

    for (;;) {
      let oldId = 0xff;

      for (let j = 0; j < nregs; ++j) {
        if (i === j) continue;
        const rj = j;
        if (!regs.base[rj]) continue;

        // Skip if the regions are not close to each other.
        if (!overlapRange(regs.ymin[ri]!, (regs.ymax[ri]! + mergeHeight) & 0xffff, regs.ymin[rj]!, (regs.ymax[rj]! + mergeHeight) & 0xffff))
          continue;
        // Skip if the height range would become too large.
        const ymin = rcMin(regs.ymin[ri]!, regs.ymin[rj]!);
        const ymax = rcMax(regs.ymax[ri]!, regs.ymax[rj]!);
        if (ymax - ymin >= 255) continue;

        // Make sure that there is no overlap when merging 'ri' and 'rj'.
        let overlap = false;
        // Iterate over all regions which have the same layerId as 'rj'
        for (let k = 0; k < nregs; ++k) {
          if (regs.layerId[k] !== regs.layerId[rj]) continue;
          // Check if region 'k' is overlapping region 'ri'
          // Index to 'regs' is the same as region id.
          if (contains(regs.layers, ri * RC_MAX_LAYERS, regs.nlayers[ri]!, k & 0xff)) {
            overlap = true;
            break;
          }
        }
        // Cannot merge of regions overlap.
        if (overlap) continue;

        // Can merge i and j.
        oldId = regs.layerId[rj]!;
        break;
      }

      // Could not find anything to merge with, stop.
      if (oldId === 0xff) break;

      // Merge
      for (let j = 0; j < nregs; ++j) {
        const rj = j;
        if (regs.layerId[rj] === oldId) {
          regs.base[rj] = 0;
          // Remap layerIds.
          regs.layerId[rj] = newId;
          // Add overlaid layers from 'rj' to 'ri'.
          for (let k = 0; k < regs.nlayers[rj]!; ++k) {
            if (!addUnique(regs.layers, ri * RC_MAX_LAYERS, regs.nlayers, ri, RC_MAX_LAYERS, regs.layers[rj * RC_MAX_LAYERS + k]!)) {
              ctx.log(
                RC_LOG_ERROR,
                "rcBuildHeightfieldLayers: layer overflow (too many overlapping walkable platforms). Try increasing RC_MAX_LAYERS.",
              );
              return false;
            }
          }

          // Update height bounds.
          regs.ymin[ri] = rcMin(regs.ymin[ri]!, regs.ymin[rj]!);
          regs.ymax[ri] = rcMax(regs.ymax[ri]!, regs.ymax[rj]!);
        }
      }
    }
  }

  // Compact layerIds
  const remap = new Uint8Array(256);

  // Find number of unique layers.
  layerId = 0;
  for (let i = 0; i < nregs; ++i) remap[regs.layerId[i]!] = 1;
  for (let i = 0; i < 256; ++i) {
    if (remap[i]) remap[i] = layerId++;
    else remap[i] = 0xff;
  }
  // Remap ids.
  for (let i = 0; i < nregs; ++i) regs.layerId[i] = remap[regs.layerId[i]!]!;

  // No layers, return empty.
  if (layerId === 0) return true;

  // Create layers.
  rcAssert(lset.layers === null);

  const lw = w - borderSize * 2;
  const lh = h - borderSize * 2;

  // Build contracted bbox for layers.
  const bmin = new Float32Array(3);
  const bmax = new Float32Array(3);
  rcVcopy(bmin, 0, chf.bmin, 0);
  rcVcopy(bmax, 0, chf.bmax, 0);
  const chcs = f32(chf.cs);
  const chch = f32(chf.ch);
  bmin[0] = f32(bmin[0]! + f32(borderSize * chcs));
  bmin[2] = f32(bmin[2]! + f32(borderSize * chcs));
  bmax[0] = f32(bmax[0]! - f32(borderSize * chcs));
  bmax[2] = f32(bmax[2]! - f32(borderSize * chcs));

  lset.nlayers = layerId;

  lset.layers = [];
  for (let i = 0; i < lset.nlayers; ++i) lset.layers.push(new rcHeightfieldLayer());

  // Store layers.
  for (let i = 0; i < lset.nlayers; ++i) {
    const curId = i & 0xff;

    const layer = lset.layers[i]!;

    const gridSize = lw * lh;

    const heights = new Uint8Array(gridSize);
    heights.fill(0xff);
    layer.heights = heights;

    const areas = new Uint8Array(gridSize);
    layer.areas = areas;

    const cons = new Uint8Array(gridSize);
    layer.cons = cons;

    // Find layer height bounds.
    let hmin = 0;
    let hmax = 0;
    for (let j = 0; j < nregs; ++j) {
      if (regs.base[j] && regs.layerId[j] === curId) {
        hmin = regs.ymin[j]!;
        hmax = regs.ymax[j]!;
      }
    }

    layer.width = lw;
    layer.height = lh;
    layer.cs = chcs;
    layer.ch = chch;

    // Adjust the bbox to fit the heightfield.
    rcVcopy(layer.bmin, 0, bmin, 0);
    rcVcopy(layer.bmax, 0, bmax, 0);
    layer.bmin[1] = f32(bmin[1]! + f32(hmin * chch));
    layer.bmax[1] = f32(bmin[1]! + f32(hmax * chch));
    layer.hmin = hmin;
    layer.hmax = hmax;

    // Update usable data region.
    layer.minx = layer.width;
    layer.maxx = 0;
    layer.miny = layer.height;
    layer.maxy = 0;

    // Copy height and area from compact heightfield.
    for (let y = 0; y < lh; ++y) {
      for (let x = 0; x < lw; ++x) {
        const cx = borderSize + x;
        const cy = borderSize + y;
        const c = cx + cy * w;
        for (let j = chf.cells.index[c]!, nj = chf.cells.index[c]! + chf.cells.count[c]!; j < nj; ++j) {
          // Skip unassigned regions.
          if (srcReg[j] === 0xff) continue;
          // Skip of does nto belong to current layer.
          const lid = regs.layerId[srcReg[j]!]!;
          if (lid !== curId) continue;

          // Update data bounds.
          layer.minx = rcMin(layer.minx, x);
          layer.maxx = rcMax(layer.maxx, x);
          layer.miny = rcMin(layer.miny, y);
          layer.maxy = rcMax(layer.maxy, y);

          // Store height and area type.
          const idx = x + y * lw;
          heights[idx] = chf.spans.y[j]! - hmin;
          areas[idx] = chf.areas[j]!;

          // Check connection.
          let portal = 0;
          let cn = 0;
          for (let dir = 0; dir < 4; ++dir) {
            if (rcGetCon(con, j, dir) !== RC_NOT_CONNECTED) {
              const ax = cx + rcGetDirOffsetX(dir);
              const ay = cy + rcGetDirOffsetY(dir);
              const ai = chf.cells.index[ax + ay * w]! + rcGetCon(con, j, dir);
              const alid = srcReg[ai] !== 0xff ? regs.layerId[srcReg[ai]!]! : 0xff;
              // Portal mask
              if (chf.areas[ai] !== RC_NULL_AREA && lid !== alid) {
                portal |= (1 << dir) & 0xff;
                // Update height so that it matches on both sides of the portal.
                if (chf.spans.y[ai]! > hmin) heights[idx] = rcMax(heights[idx]!, (chf.spans.y[ai]! - hmin) & 0xff);
              }
              // Valid connection mask
              if (chf.areas[ai] !== RC_NULL_AREA && lid === alid) {
                const nx = ax - borderSize;
                const ny = ay - borderSize;
                if (nx >= 0 && ny >= 0 && nx < lw && ny < lh) cn |= (1 << dir) & 0xff;
              }
            }
          }

          cons[idx] = (portal << 4) | cn;
        }
      }
    }

    if (layer.minx > layer.maxx) layer.minx = layer.maxx = 0;
    if (layer.miny > layer.maxy) layer.miny = layer.maxy = 0;
  }

  return true;
}
