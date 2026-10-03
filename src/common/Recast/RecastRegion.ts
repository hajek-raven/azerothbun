/**
 * Port of `deps/recastnavigation/Recast/Source/RecastRegion.cpp`.
 *
 * `rcTempVector<LevelStackEntry>` and `rcTempVector<DirtyEntry>` are `rcEntryStack` (three ints per entry in one
 * `Int32Array`), so the watershed allocates nothing per span.
 */
import { rcIntArray } from "./RecastAlloc.ts";
import {
  RC_BORDER_REG,
  RC_LOG_ERROR,
  RC_NOT_CONNECTED,
  RC_NULL_AREA,
  RC_TIMER_BUILD_DISTANCEFIELD,
  RC_TIMER_BUILD_DISTANCEFIELD_BLUR,
  RC_TIMER_BUILD_DISTANCEFIELD_DIST,
  RC_TIMER_BUILD_REGIONS,
  RC_TIMER_BUILD_REGIONS_EXPAND,
  RC_TIMER_BUILD_REGIONS_FILTER,
  RC_TIMER_BUILD_REGIONS_FLOOD,
  RC_TIMER_BUILD_REGIONS_WATERSHED,
  rcGetCon,
  rcGetDirOffsetX,
  rcGetDirOffsetY,
  rcMax,
  rcMin,
  rcScopedTimer,
  type rcCompactHeightfield,
  type rcContext,
  type rcRef,
} from "./Recast.ts";

/**
 * A vector of `{int, int, int}` entries: `LevelStackEntry` (`x`, `y`, `index`) and `DirtyEntry` (`index`, `region`,
 * `distance2`). Entry `j` is `data[j*3 .. j*3+2]`; `data` is replaced on growth.
 * @ac deps/recastnavigation/Recast/Source/RecastRegion.cpp LevelStackEntry
 * @ac deps/recastnavigation/Recast/Source/RecastRegion.cpp DirtyEntry
 */
class rcEntryStack {
  data: Int32Array;
  n = 0;

  constructor(capacity = 256) {
    this.data = new Int32Array(capacity * 3);
  }

  clear(): void {
    this.n = 0;
  }

  size(): number {
    return this.n;
  }

  push(a: number, b: number, c: number): void {
    let o = this.n * 3;
    if (o + 3 > this.data.length) {
      const data = new Int32Array(this.data.length * 2);
      data.set(this.data);
      this.data = data;
    }
    const d = this.data;
    d[o++] = a;
    d[o++] = b;
    d[o] = c;
    this.n++;
  }
}

/** @ac deps/recastnavigation/Recast/Source/RecastRegion.cpp calculateDistanceField */
function calculateDistanceField(chf: rcCompactHeightfield, src: Uint16Array): number {
  const w = chf.width;
  const h = chf.height;
  const cellIndex = chf.cells.index;
  const cellCount = chf.cells.count;
  const con = chf.spans.con;
  const areas = chf.areas;

  // Init distance and points.
  for (let i = 0; i < chf.spanCount; ++i) src[i] = 0xffff;

  // Mark boundary cells.
  for (let y = 0; y < h; ++y) {
    for (let x = 0; x < w; ++x) {
      const c = x + y * w;
      for (let i = cellIndex[c]!, ni = cellIndex[c]! + cellCount[c]!; i < ni; ++i) {
        const area = areas[i]!;

        let nc = 0;
        for (let dir = 0; dir < 4; ++dir) {
          if (rcGetCon(con, i, dir) !== RC_NOT_CONNECTED) {
            const ax = x + rcGetDirOffsetX(dir);
            const ay = y + rcGetDirOffsetY(dir);
            const ai = cellIndex[ax + ay * w]! + rcGetCon(con, i, dir);
            if (area === areas[ai]) nc++;
          }
        }
        if (nc !== 4) src[i] = 0;
      }
    }
  }

  // Pass 1
  for (let y = 0; y < h; ++y) {
    for (let x = 0; x < w; ++x) {
      const c = x + y * w;
      for (let i = cellIndex[c]!, ni = cellIndex[c]! + cellCount[c]!; i < ni; ++i) {
        if (rcGetCon(con, i, 0) !== RC_NOT_CONNECTED) {
          // (-1,0)
          const ax = x + rcGetDirOffsetX(0);
          const ay = y + rcGetDirOffsetY(0);
          const ai = cellIndex[ax + ay * w]! + rcGetCon(con, i, 0);
          if (src[ai]! + 2 < src[i]!) src[i] = src[ai]! + 2;

          // (-1,-1)
          if (rcGetCon(con, ai, 3) !== RC_NOT_CONNECTED) {
            const aax = ax + rcGetDirOffsetX(3);
            const aay = ay + rcGetDirOffsetY(3);
            const aai = cellIndex[aax + aay * w]! + rcGetCon(con, ai, 3);
            if (src[aai]! + 3 < src[i]!) src[i] = src[aai]! + 3;
          }
        }
        if (rcGetCon(con, i, 3) !== RC_NOT_CONNECTED) {
          // (0,-1)
          const ax = x + rcGetDirOffsetX(3);
          const ay = y + rcGetDirOffsetY(3);
          const ai = cellIndex[ax + ay * w]! + rcGetCon(con, i, 3);
          if (src[ai]! + 2 < src[i]!) src[i] = src[ai]! + 2;

          // (1,-1)
          if (rcGetCon(con, ai, 2) !== RC_NOT_CONNECTED) {
            const aax = ax + rcGetDirOffsetX(2);
            const aay = ay + rcGetDirOffsetY(2);
            const aai = cellIndex[aax + aay * w]! + rcGetCon(con, ai, 2);
            if (src[aai]! + 3 < src[i]!) src[i] = src[aai]! + 3;
          }
        }
      }
    }
  }

  // Pass 2
  for (let y = h - 1; y >= 0; --y) {
    for (let x = w - 1; x >= 0; --x) {
      const c = x + y * w;
      for (let i = cellIndex[c]!, ni = cellIndex[c]! + cellCount[c]!; i < ni; ++i) {
        if (rcGetCon(con, i, 2) !== RC_NOT_CONNECTED) {
          // (1,0)
          const ax = x + rcGetDirOffsetX(2);
          const ay = y + rcGetDirOffsetY(2);
          const ai = cellIndex[ax + ay * w]! + rcGetCon(con, i, 2);
          if (src[ai]! + 2 < src[i]!) src[i] = src[ai]! + 2;

          // (1,1)
          if (rcGetCon(con, ai, 1) !== RC_NOT_CONNECTED) {
            const aax = ax + rcGetDirOffsetX(1);
            const aay = ay + rcGetDirOffsetY(1);
            const aai = cellIndex[aax + aay * w]! + rcGetCon(con, ai, 1);
            if (src[aai]! + 3 < src[i]!) src[i] = src[aai]! + 3;
          }
        }
        if (rcGetCon(con, i, 1) !== RC_NOT_CONNECTED) {
          // (0,1)
          const ax = x + rcGetDirOffsetX(1);
          const ay = y + rcGetDirOffsetY(1);
          const ai = cellIndex[ax + ay * w]! + rcGetCon(con, i, 1);
          if (src[ai]! + 2 < src[i]!) src[i] = src[ai]! + 2;

          // (-1,1)
          if (rcGetCon(con, ai, 0) !== RC_NOT_CONNECTED) {
            const aax = ax + rcGetDirOffsetX(0);
            const aay = ay + rcGetDirOffsetY(0);
            const aai = cellIndex[aax + aay * w]! + rcGetCon(con, ai, 0);
            if (src[aai]! + 3 < src[i]!) src[i] = src[aai]! + 3;
          }
        }
      }
    }
  }

  let maxDist = 0;
  for (let i = 0; i < chf.spanCount; ++i) maxDist = rcMax(src[i]!, maxDist);
  return maxDist;
}

/** @ac deps/recastnavigation/Recast/Source/RecastRegion.cpp boxBlur */
function boxBlur(chf: rcCompactHeightfield, thr: number, src: Uint16Array, dst: Uint16Array): Uint16Array {
  const w = chf.width;
  const h = chf.height;
  const cellIndex = chf.cells.index;
  const cellCount = chf.cells.count;
  const con = chf.spans.con;

  thr *= 2;

  for (let y = 0; y < h; ++y) {
    for (let x = 0; x < w; ++x) {
      const c = x + y * w;
      for (let i = cellIndex[c]!, ni = cellIndex[c]! + cellCount[c]!; i < ni; ++i) {
        const cd = src[i]!;
        if (cd <= thr) {
          dst[i] = cd;
          continue;
        }

        let d = cd;
        for (let dir = 0; dir < 4; ++dir) {
          if (rcGetCon(con, i, dir) !== RC_NOT_CONNECTED) {
            const ax = x + rcGetDirOffsetX(dir);
            const ay = y + rcGetDirOffsetY(dir);
            const ai = cellIndex[ax + ay * w]! + rcGetCon(con, i, dir);
            d += src[ai]!;

            const dir2 = (dir + 1) & 0x3;
            if (rcGetCon(con, ai, dir2) !== RC_NOT_CONNECTED) {
              const ax2 = ax + rcGetDirOffsetX(dir2);
              const ay2 = ay + rcGetDirOffsetY(dir2);
              const ai2 = cellIndex[ax2 + ay2 * w]! + rcGetCon(con, ai, dir2);
              d += src[ai2]!;
            } else {
              d += cd;
            }
          } else {
            d += cd * 2;
          }
        }
        dst[i] = ((d + 5) / 9) | 0;
      }
    }
  }
  return dst;
}

/** @ac deps/recastnavigation/Recast/Source/RecastRegion.cpp floodRegion */
function floodRegion(
  x: number,
  y: number,
  i: number,
  level: number,
  r: number,
  chf: rcCompactHeightfield,
  srcReg: Uint16Array,
  srcDist: Uint16Array,
  stack: rcEntryStack,
): boolean {
  const w = chf.width;
  const cellIndex = chf.cells.index;
  const con = chf.spans.con;
  const areas = chf.areas;
  const dist = chf.dist!;

  const area = areas[i]!;

  // Flood fill mark region.
  stack.clear();
  stack.push(x, y, i);
  srcReg[i] = r;
  srcDist[i] = 0;

  const lev = level >= 2 ? level - 2 : 0;
  let count = 0;

  while (stack.n > 0) {
    const back = (stack.n - 1) * 3;
    const sd = stack.data;
    const cx = sd[back]!;
    const cy = sd[back + 1]!;
    const ci = sd[back + 2]!;
    stack.n--;

    // Check if any of the neighbours already have a valid region set.
    let ar = 0;
    for (let dir = 0; dir < 4; ++dir) {
      // 8 connected
      if (rcGetCon(con, ci, dir) !== RC_NOT_CONNECTED) {
        const ax = cx + rcGetDirOffsetX(dir);
        const ay = cy + rcGetDirOffsetY(dir);
        const ai = cellIndex[ax + ay * w]! + rcGetCon(con, ci, dir);
        if (areas[ai] !== area) continue;
        const nr = srcReg[ai]!;
        if (nr & RC_BORDER_REG)
          // Do not take borders into account.
          continue;
        if (nr !== 0 && nr !== r) {
          ar = nr;
          break;
        }

        const dir2 = (dir + 1) & 0x3;
        if (rcGetCon(con, ai, dir2) !== RC_NOT_CONNECTED) {
          const ax2 = ax + rcGetDirOffsetX(dir2);
          const ay2 = ay + rcGetDirOffsetY(dir2);
          const ai2 = cellIndex[ax2 + ay2 * w]! + rcGetCon(con, ai, dir2);
          if (areas[ai2] !== area) continue;
          const nr2 = srcReg[ai2]!;
          if (nr2 !== 0 && nr2 !== r) {
            ar = nr2;
            break;
          }
        }
      }
    }
    if (ar !== 0) {
      srcReg[ci] = 0;
      continue;
    }

    count++;

    // Expand neighbours.
    for (let dir = 0; dir < 4; ++dir) {
      if (rcGetCon(con, ci, dir) !== RC_NOT_CONNECTED) {
        const ax = cx + rcGetDirOffsetX(dir);
        const ay = cy + rcGetDirOffsetY(dir);
        const ai = cellIndex[ax + ay * w]! + rcGetCon(con, ci, dir);
        if (areas[ai] !== area) continue;
        if (dist[ai]! >= lev && srcReg[ai] === 0) {
          srcReg[ai] = r;
          srcDist[ai] = 0;
          stack.push(ax, ay, ai);
        }
      }
    }
  }

  return count > 0;
}

const expandRegionsDirty = new rcEntryStack(256);

/** @ac deps/recastnavigation/Recast/Source/RecastRegion.cpp expandRegions */
function expandRegions(
  maxIter: number,
  level: number,
  chf: rcCompactHeightfield,
  srcReg: Uint16Array,
  srcDist: Uint16Array,
  stack: rcEntryStack,
  fillStack: boolean,
): void {
  const w = chf.width;
  const h = chf.height;
  const cellIndex = chf.cells.index;
  const cellCount = chf.cells.count;
  const con = chf.spans.con;
  const areas = chf.areas;
  const dist = chf.dist!;

  if (fillStack) {
    // Find cells revealed by the raised level.
    stack.clear();
    for (let y = 0; y < h; ++y) {
      for (let x = 0; x < w; ++x) {
        const c = x + y * w;
        for (let i = cellIndex[c]!, ni = cellIndex[c]! + cellCount[c]!; i < ni; ++i) {
          if (dist[i]! >= level && srcReg[i] === 0 && areas[i] !== RC_NULL_AREA) {
            stack.push(x, y, i);
          }
        }
      }
    }
  } else {
    // use cells in the input stack
    // mark all cells which already have a region
    const sd = stack.data;
    for (let j = 0; j < stack.n; j++) {
      const i = sd[j * 3 + 2]!;
      if (srcReg[i] !== 0) sd[j * 3 + 2] = -1;
    }
  }

  const dirtyEntries = expandRegionsDirty;
  let iter = 0;
  while (stack.n > 0) {
    let failed = 0;
    dirtyEntries.clear();

    const sd = stack.data;
    for (let j = 0; j < stack.n; j++) {
      const x = sd[j * 3]!;
      const y = sd[j * 3 + 1]!;
      const i = sd[j * 3 + 2]!;
      if (i < 0) {
        failed++;
        continue;
      }

      let r = srcReg[i]!;
      let d2 = 0xffff;
      const area = areas[i]!;
      for (let dir = 0; dir < 4; ++dir) {
        if (rcGetCon(con, i, dir) === RC_NOT_CONNECTED) continue;
        const ax = x + rcGetDirOffsetX(dir);
        const ay = y + rcGetDirOffsetY(dir);
        const ai = cellIndex[ax + ay * w]! + rcGetCon(con, i, dir);
        if (areas[ai] !== area) continue;
        if (srcReg[ai]! > 0 && (srcReg[ai]! & RC_BORDER_REG) === 0) {
          if (srcDist[ai]! + 2 < d2) {
            r = srcReg[ai]!;
            d2 = (srcDist[ai]! + 2) & 0xffff;
          }
        }
      }
      if (r) {
        sd[j * 3 + 2] = -1; // mark as used
        dirtyEntries.push(i, r, d2);
      } else {
        failed++;
      }
    }

    // Copy entries that differ between src and dst to keep them in sync.
    const dd = dirtyEntries.data;
    for (let i = 0; i < dirtyEntries.n; i++) {
      const idx = dd[i * 3]!;
      srcReg[idx] = dd[i * 3 + 1]!;
      srcDist[idx] = dd[i * 3 + 2]!;
    }

    if (failed === stack.n) break;

    if (level > 0) {
      ++iter;
      if (iter >= maxIter) break;
    }
  }
}

/** @ac deps/recastnavigation/Recast/Source/RecastRegion.cpp sortCellsByLevel */
function sortCellsByLevel(
  startLevel: number,
  chf: rcCompactHeightfield,
  srcReg: Uint16Array,
  nbStacks: number,
  stacks: rcEntryStack[],
  loglevelsPerStack: number,
): void {
  const w = chf.width;
  const h = chf.height;
  const cellIndex = chf.cells.index;
  const cellCount = chf.cells.count;
  const areas = chf.areas;
  const dist = chf.dist!;
  startLevel = startLevel >> loglevelsPerStack;

  for (let j = 0; j < nbStacks; ++j) stacks[j]!.clear();

  // put all cells in the level range into the appropriate stacks
  for (let y = 0; y < h; ++y) {
    for (let x = 0; x < w; ++x) {
      const c = x + y * w;
      for (let i = cellIndex[c]!, ni = cellIndex[c]! + cellCount[c]!; i < ni; ++i) {
        if (areas[i] === RC_NULL_AREA || srcReg[i] !== 0) continue;

        const level = dist[i]! >> loglevelsPerStack;
        let sId = startLevel - level;
        if (sId >= nbStacks) continue;
        if (sId < 0) sId = 0;

        stacks[sId]!.push(x, y, i);
      }
    }
  }
}

/** @ac deps/recastnavigation/Recast/Source/RecastRegion.cpp appendStacks */
function appendStacks(srcStack: rcEntryStack, dstStack: rcEntryStack, srcReg: Uint16Array): void {
  const sd = srcStack.data;
  for (let j = 0; j < srcStack.n; j++) {
    const i = sd[j * 3 + 2]!;
    if (i < 0 || srcReg[i] !== 0) continue;
    dstStack.push(sd[j * 3]!, sd[j * 3 + 1]!, i);
  }
}

/** @ac deps/recastnavigation/Recast/Source/RecastRegion.cpp rcRegion */
class rcRegion {
  /** Number of spans belonging to this region */
  spanCount = 0;
  /** ID of the region (`unsigned short`) */
  id: number;
  /** Are type. */
  areaType = 0;
  remap = false;
  visited = false;
  overlap = false;
  connectsToBorder = false;
  ymin = 0xffff;
  ymax = 0;
  readonly connections = new rcIntArray();
  readonly floors = new rcIntArray();

  /** @ac deps/recastnavigation/Recast/Source/RecastRegion.cpp rcRegion::rcRegion */
  constructor(i: number) {
    this.id = i;
  }
}

/** @ac deps/recastnavigation/Recast/Source/RecastRegion.cpp removeAdjacentNeighbours */
function removeAdjacentNeighbours(reg: rcRegion): void {
  const cons = reg.connections;
  // Remove adjacent duplicates.
  for (let i = 0; i < cons.size() && cons.size() > 1; ) {
    const ni = (i + 1) % cons.size();
    const d = cons.data;
    if (d[i] === d[ni]) {
      // Remove duplicate
      for (let j = i; j < cons.size() - 1; ++j) d[j] = d[j + 1]!;
      cons.pop();
    } else ++i;
  }
}

/** @ac deps/recastnavigation/Recast/Source/RecastRegion.cpp replaceNeighbour */
function replaceNeighbour(reg: rcRegion, oldId: number, newId: number): void {
  let neiChanged = false;
  const cd = reg.connections.data;
  for (let i = 0; i < reg.connections.size(); ++i) {
    if (cd[i] === oldId) {
      cd[i] = newId;
      neiChanged = true;
    }
  }
  const fd = reg.floors.data;
  for (let i = 0; i < reg.floors.size(); ++i) {
    if (fd[i] === oldId) fd[i] = newId;
  }
  if (neiChanged) removeAdjacentNeighbours(reg);
}

/** @ac deps/recastnavigation/Recast/Source/RecastRegion.cpp canMergeWithRegion */
function canMergeWithRegion(rega: rcRegion, regb: rcRegion): boolean {
  if (rega.areaType !== regb.areaType) return false;
  let n = 0;
  const cd = rega.connections.data;
  for (let i = 0; i < rega.connections.size(); ++i) {
    if (cd[i] === regb.id) n++;
  }
  if (n > 1) return false;
  const fd = rega.floors.data;
  for (let i = 0; i < rega.floors.size(); ++i) {
    if (fd[i] === regb.id) return false;
  }
  return true;
}

/** @ac deps/recastnavigation/Recast/Source/RecastRegion.cpp addUniqueFloorRegion */
function addUniqueFloorRegion(reg: rcRegion, n: number): void {
  const fd = reg.floors.data;
  for (let i = 0; i < reg.floors.size(); ++i) if (fd[i] === n) return;
  reg.floors.push(n);
}

/** @ac deps/recastnavigation/Recast/Source/RecastRegion.cpp mergeRegions */
function mergeRegions(rega: rcRegion, regb: rcRegion): boolean {
  const aid = rega.id;
  const bid = regb.id;

  // Duplicate current neighbourhood.
  const acon = rega.connections.data.slice(0, rega.connections.size());
  const bcon = regb.connections;

  // Find insertion point on A.
  let insa = -1;
  for (let i = 0; i < acon.length; ++i) {
    if (acon[i] === bid) {
      insa = i;
      break;
    }
  }
  if (insa === -1) return false;

  // Find insertion point on B.
  let insb = -1;
  for (let i = 0; i < bcon.size(); ++i) {
    if (bcon.data[i] === aid) {
      insb = i;
      break;
    }
  }
  if (insb === -1) return false;

  // Merge neighbours.
  rega.connections.resize(0);
  for (let i = 0, ni = acon.length; i < ni - 1; ++i) rega.connections.push(acon[(insa + 1 + i) % ni]!);

  for (let i = 0, ni = bcon.size(); i < ni - 1; ++i) rega.connections.push(bcon.data[(insb + 1 + i) % ni]!);

  removeAdjacentNeighbours(rega);

  for (let j = 0; j < regb.floors.size(); ++j) addUniqueFloorRegion(rega, regb.floors.data[j]!);
  rega.spanCount += regb.spanCount;
  regb.spanCount = 0;
  regb.connections.resize(0);

  return true;
}

/** @ac deps/recastnavigation/Recast/Source/RecastRegion.cpp isRegionConnectedToBorder */
function isRegionConnectedToBorder(reg: rcRegion): boolean {
  // Region is connected to border if
  // one of the neighbours is null id.
  const cd = reg.connections.data;
  for (let i = 0; i < reg.connections.size(); ++i) {
    if (cd[i] === 0) return true;
  }
  return false;
}

/** @ac deps/recastnavigation/Recast/Source/RecastRegion.cpp isSolidEdge */
function isSolidEdge(chf: rcCompactHeightfield, srcReg: Uint16Array, x: number, y: number, i: number, dir: number): boolean {
  const con = chf.spans.con;
  let r = 0;
  if (rcGetCon(con, i, dir) !== RC_NOT_CONNECTED) {
    const ax = x + rcGetDirOffsetX(dir);
    const ay = y + rcGetDirOffsetY(dir);
    const ai = chf.cells.index[ax + ay * chf.width]! + rcGetCon(con, i, dir);
    r = srcReg[ai]!;
  }
  if (r === srcReg[i]) return false;
  return true;
}

/** @ac deps/recastnavigation/Recast/Source/RecastRegion.cpp walkContour */
function walkContour(x: number, y: number, i: number, dir: number, chf: rcCompactHeightfield, srcReg: Uint16Array, cont: rcIntArray): void {
  const con = chf.spans.con;
  const cellIndex = chf.cells.index;
  const startDir = dir;
  const starti = i;

  let curReg = 0;
  if (rcGetCon(con, i, dir) !== RC_NOT_CONNECTED) {
    const ax = x + rcGetDirOffsetX(dir);
    const ay = y + rcGetDirOffsetY(dir);
    const ai = cellIndex[ax + ay * chf.width]! + rcGetCon(con, i, dir);
    curReg = srcReg[ai]!;
  }
  cont.push(curReg);

  let iter = 0;
  while (++iter < 40000) {
    if (isSolidEdge(chf, srcReg, x, y, i, dir)) {
      // Choose the edge corner
      let r = 0;
      if (rcGetCon(con, i, dir) !== RC_NOT_CONNECTED) {
        const ax = x + rcGetDirOffsetX(dir);
        const ay = y + rcGetDirOffsetY(dir);
        const ai = cellIndex[ax + ay * chf.width]! + rcGetCon(con, i, dir);
        r = srcReg[ai]!;
      }
      if (r !== curReg) {
        curReg = r;
        cont.push(curReg);
      }

      dir = (dir + 1) & 0x3; // Rotate CW
    } else {
      let ni = -1;
      const nx = x + rcGetDirOffsetX(dir);
      const ny = y + rcGetDirOffsetY(dir);
      if (rcGetCon(con, i, dir) !== RC_NOT_CONNECTED) {
        ni = cellIndex[nx + ny * chf.width]! + rcGetCon(con, i, dir);
      }
      if (ni === -1) {
        // Should not happen.
        return;
      }
      x = nx;
      y = ny;
      i = ni;
      dir = (dir + 3) & 0x3; // Rotate CCW
    }

    if (starti === i && startDir === dir) {
      break;
    }
  }

  // Remove adjacent duplicates.
  if (cont.size() > 1) {
    for (let j = 0; j < cont.size(); ) {
      const nj = (j + 1) % cont.size();
      const d = cont.data;
      if (d[j] === d[nj]) {
        for (let k = j; k < cont.size() - 1; ++k) d[k] = d[k + 1]!;
        cont.pop();
      } else ++j;
    }
  }
}

/** @ac deps/recastnavigation/Recast/Source/RecastRegion.cpp mergeAndFilterRegions */
function mergeAndFilterRegions(
  _ctx: rcContext,
  minRegionArea: number,
  mergeRegionSize: number,
  maxRegionId: rcRef<number>,
  chf: rcCompactHeightfield,
  srcReg: Uint16Array,
  overlaps: rcIntArray,
): boolean {
  const w = chf.width;
  const h = chf.height;
  const cellIndex = chf.cells.index;
  const cellCount = chf.cells.count;

  const nreg = maxRegionId.value + 1;
  const regions: rcRegion[] = new Array(nreg);

  // Construct regions
  for (let i = 0; i < nreg; ++i) regions[i] = new rcRegion(i);

  // Find edge of a region and find connections around the contour.
  for (let y = 0; y < h; ++y) {
    for (let x = 0; x < w; ++x) {
      const c = x + y * w;
      const ci = cellIndex[c]!;
      for (let i = ci, ni = ci + cellCount[c]!; i < ni; ++i) {
        const r = srcReg[i]!;
        if (r === 0 || r >= nreg) continue;

        const reg = regions[r]!;
        reg.spanCount++;

        // Update floors.
        for (let j = ci; j < ni; ++j) {
          if (i === j) continue;
          const floorId = srcReg[j]!;
          if (floorId === 0 || floorId >= nreg) continue;
          if (floorId === r) reg.overlap = true;
          addUniqueFloorRegion(reg, floorId);
        }

        // Have found contour
        if (reg.connections.size() > 0) continue;

        reg.areaType = chf.areas[i]!;

        // Check if this cell is next to a border.
        let ndir = -1;
        for (let dir = 0; dir < 4; ++dir) {
          if (isSolidEdge(chf, srcReg, x, y, i, dir)) {
            ndir = dir;
            break;
          }
        }

        if (ndir !== -1) {
          // The cell is at border.
          // Walk around the contour to find all the neighbours.
          walkContour(x, y, i, ndir, chf, srcReg, reg.connections);
        }
      }
    }
  }

  // Remove too small regions.
  const stack = new rcIntArray(32);
  const trace = new rcIntArray(32);
  for (let i = 0; i < nreg; ++i) {
    const reg = regions[i]!;
    if (reg.id === 0 || reg.id & RC_BORDER_REG) continue;
    if (reg.spanCount === 0) continue;
    if (reg.visited) continue;

    // Count the total size of all the connected regions.
    // Also keep track of the regions connects to a tile border.
    let connectsToBorder = false;
    let spanCount = 0;
    stack.resize(0);
    trace.resize(0);

    reg.visited = true;
    stack.push(i);

    while (stack.size()) {
      // Pop
      const ri = stack.pop();

      const creg = regions[ri]!;

      spanCount += creg.spanCount;
      trace.push(ri);

      for (let j = 0; j < creg.connections.size(); ++j) {
        const cj = creg.connections.data[j]!;
        if (cj & RC_BORDER_REG) {
          connectsToBorder = true;
          continue;
        }
        const neireg = regions[cj]!;
        if (neireg.visited) continue;
        if (neireg.id === 0 || neireg.id & RC_BORDER_REG) continue;
        // Visit
        stack.push(neireg.id);
        neireg.visited = true;
      }
    }

    // If the accumulated regions size is too small, remove it.
    // Do not remove areas which connect to tile borders
    // as their size cannot be estimated correctly and removing them
    // can potentially remove necessary areas.
    if (spanCount < minRegionArea && !connectsToBorder) {
      // Kill all visited regions.
      for (let j = 0; j < trace.size(); ++j) {
        regions[trace.data[j]!]!.spanCount = 0;
        regions[trace.data[j]!]!.id = 0;
      }
    }
  }

  // Merge too small regions to neighbour regions.
  let mergeCount = 0;
  do {
    mergeCount = 0;
    for (let i = 0; i < nreg; ++i) {
      const reg = regions[i]!;
      if (reg.id === 0 || reg.id & RC_BORDER_REG) continue;
      if (reg.overlap) continue;
      if (reg.spanCount === 0) continue;

      // Check to see if the region should be merged.
      if (reg.spanCount > mergeRegionSize && isRegionConnectedToBorder(reg)) continue;

      // Small region with more than 1 connection.
      // Or region which is not connected to a border at all.
      // Find smallest neighbour region that connects to this one.
      let smallest = 0xfffffff;
      let mergeId = reg.id;
      for (let j = 0; j < reg.connections.size(); ++j) {
        const cj = reg.connections.data[j]!;
        if (cj & RC_BORDER_REG) continue;
        const mreg = regions[cj]!;
        if (mreg.id === 0 || mreg.id & RC_BORDER_REG || mreg.overlap) continue;
        if (mreg.spanCount < smallest && canMergeWithRegion(reg, mreg) && canMergeWithRegion(mreg, reg)) {
          smallest = mreg.spanCount;
          mergeId = mreg.id;
        }
      }
      // Found new id.
      if (mergeId !== reg.id) {
        const oldId = reg.id;
        const target = regions[mergeId]!;

        // Merge neighbours.
        if (mergeRegions(target, reg)) {
          // Fixup regions pointing to current region.
          for (let j = 0; j < nreg; ++j) {
            const rj = regions[j]!;
            if (rj.id === 0 || rj.id & RC_BORDER_REG) continue;
            // If another region was already merged into current region
            // change the nid of the previous region too.
            if (rj.id === oldId) rj.id = mergeId;
            // Replace the current region with the new one if the
            // current regions is neighbour.
            replaceNeighbour(rj, oldId, mergeId);
          }
          mergeCount++;
        }
      }
    }
  } while (mergeCount > 0);

  // Compress region Ids.
  for (let i = 0; i < nreg; ++i) {
    const ri = regions[i]!;
    ri.remap = false;
    if (ri.id === 0) continue; // Skip nil regions.
    if (ri.id & RC_BORDER_REG) continue; // Skip external regions.
    ri.remap = true;
  }

  let regIdGen = 0;
  for (let i = 0; i < nreg; ++i) {
    if (!regions[i]!.remap) continue;
    const oldId = regions[i]!.id;
    const newId = ++regIdGen & 0xffff;
    for (let j = i; j < nreg; ++j) {
      const rj = regions[j]!;
      if (rj.id === oldId) {
        rj.id = newId;
        rj.remap = false;
      }
    }
  }
  maxRegionId.value = regIdGen & 0xffff;

  // Remap regions.
  for (let i = 0; i < chf.spanCount; ++i) {
    if ((srcReg[i]! & RC_BORDER_REG) === 0) srcReg[i] = regions[srcReg[i]!]!.id;
  }

  // Return regions that we found to be overlapping.
  for (let i = 0; i < nreg; ++i) if (regions[i]!.overlap) overlaps.push(regions[i]!.id);

  return true;
}

/** @ac deps/recastnavigation/Recast/Source/RecastRegion.cpp addUniqueConnection */
function addUniqueConnection(reg: rcRegion, n: number): void {
  const cd = reg.connections.data;
  for (let i = 0; i < reg.connections.size(); ++i) if (cd[i] === n) return;
  reg.connections.push(n);
}

/** @ac deps/recastnavigation/Recast/Source/RecastRegion.cpp mergeAndFilterLayerRegions */
function mergeAndFilterLayerRegions(
  _ctx: rcContext,
  minRegionArea: number,
  maxRegionId: rcRef<number>,
  chf: rcCompactHeightfield,
  srcReg: Uint16Array,
): boolean {
  const w = chf.width;
  const h = chf.height;
  const cellIndex = chf.cells.index;
  const cellCount = chf.cells.count;
  const con = chf.spans.con;
  const spanY = chf.spans.y;

  const nreg = maxRegionId.value + 1;
  const regions: rcRegion[] = new Array(nreg);

  // Construct regions
  for (let i = 0; i < nreg; ++i) regions[i] = new rcRegion(i);

  // Find region neighbours and overlapping regions.
  const lregs = new rcIntArray(32);
  for (let y = 0; y < h; ++y) {
    for (let x = 0; x < w; ++x) {
      const c = x + y * w;

      lregs.resize(0);

      for (let i = cellIndex[c]!, ni = cellIndex[c]! + cellCount[c]!; i < ni; ++i) {
        const ri = srcReg[i]!;
        if (ri === 0 || ri >= nreg) continue;
        const reg = regions[ri]!;

        reg.spanCount++;

        reg.ymin = rcMin(reg.ymin, spanY[i]!);
        reg.ymax = rcMax(reg.ymax, spanY[i]!);

        // Collect all region layers.
        lregs.push(ri);

        // Update neighbours
        for (let dir = 0; dir < 4; ++dir) {
          if (rcGetCon(con, i, dir) !== RC_NOT_CONNECTED) {
            const ax = x + rcGetDirOffsetX(dir);
            const ay = y + rcGetDirOffsetY(dir);
            const ai = cellIndex[ax + ay * w]! + rcGetCon(con, i, dir);
            const rai = srcReg[ai]!;
            if (rai > 0 && rai < nreg && rai !== ri) addUniqueConnection(reg, rai);
            if (rai & RC_BORDER_REG) reg.connectsToBorder = true;
          }
        }
      }

      // Update overlapping regions.
      const ld = lregs.data;
      for (let i = 0; i < lregs.size() - 1; ++i) {
        for (let j = i + 1; j < lregs.size(); ++j) {
          if (ld[i] !== ld[j]) {
            const ri = regions[ld[i]!]!;
            const rj = regions[ld[j]!]!;
            addUniqueFloorRegion(ri, ld[j]!);
            addUniqueFloorRegion(rj, ld[i]!);
          }
        }
      }
    }
  }

  // Create 2D layers from regions.
  let layerId = 1;

  for (let i = 0; i < nreg; ++i) regions[i]!.id = 0;

  // Merge montone regions to create non-overlapping areas.
  const stack = new rcIntArray(32);
  for (let i = 1; i < nreg; ++i) {
    const root = regions[i]!;
    // Skip already visited.
    if (root.id !== 0) continue;

    // Start search.
    root.id = layerId;

    stack.resize(0);
    stack.push(i);

    while (stack.size() > 0) {
      // Pop front
      const sd = stack.data;
      const reg = regions[sd[0]!]!;
      for (let j = 0; j < stack.size() - 1; ++j) sd[j] = sd[j + 1]!;
      stack.resize(stack.size() - 1);

      const ncons = reg.connections.size();
      for (let j = 0; j < ncons; ++j) {
        const nei = reg.connections.data[j]!;
        const regn = regions[nei]!;
        // Skip already visited.
        if (regn.id !== 0) continue;
        // Skip if the neighbour is overlapping root region.
        let overlap = false;
        for (let k = 0; k < root.floors.size(); k++) {
          if (root.floors.data[k] === nei) {
            overlap = true;
            break;
          }
        }
        if (overlap) continue;

        // Deepen
        stack.push(nei);

        // Mark layer id
        regn.id = layerId;
        // Merge current layers to root.
        for (let k = 0; k < regn.floors.size(); ++k) addUniqueFloorRegion(root, regn.floors.data[k]!);
        root.ymin = rcMin(root.ymin, regn.ymin);
        root.ymax = rcMax(root.ymax, regn.ymax);
        root.spanCount += regn.spanCount;
        regn.spanCount = 0;
        root.connectsToBorder = root.connectsToBorder || regn.connectsToBorder;
      }
    }

    layerId = (layerId + 1) & 0xffff;
  }

  // Remove small regions
  for (let i = 0; i < nreg; ++i) {
    const ri = regions[i]!;
    if (ri.spanCount > 0 && ri.spanCount < minRegionArea && !ri.connectsToBorder) {
      const reg = ri.id;
      for (let j = 0; j < nreg; ++j) if (regions[j]!.id === reg) regions[j]!.id = 0;
    }
  }

  // Compress region Ids.
  for (let i = 0; i < nreg; ++i) {
    const ri = regions[i]!;
    ri.remap = false;
    if (ri.id === 0) continue; // Skip nil regions.
    if (ri.id & RC_BORDER_REG) continue; // Skip external regions.
    ri.remap = true;
  }

  let regIdGen = 0;
  for (let i = 0; i < nreg; ++i) {
    if (!regions[i]!.remap) continue;
    const oldId = regions[i]!.id;
    const newId = ++regIdGen & 0xffff;
    for (let j = i; j < nreg; ++j) {
      const rj = regions[j]!;
      if (rj.id === oldId) {
        rj.id = newId;
        rj.remap = false;
      }
    }
  }
  maxRegionId.value = regIdGen & 0xffff;

  // Remap regions.
  for (let i = 0; i < chf.spanCount; ++i) {
    if ((srcReg[i]! & RC_BORDER_REG) === 0) srcReg[i] = regions[srcReg[i]!]!.id;
  }

  return true;
}

/**
 * Builds the distance field for the specified compact heightfield.
 * @ac deps/recastnavigation/Recast/Source/RecastRegion.cpp rcBuildDistanceField
 */
export function rcBuildDistanceField(ctx: rcContext, chf: rcCompactHeightfield): boolean {
  using _timer = new rcScopedTimer(ctx, RC_TIMER_BUILD_DISTANCEFIELD);

  chf.dist = null;

  let src = new Uint16Array(chf.spanCount);
  let dst = new Uint16Array(chf.spanCount);

  {
    using _timerDist = new rcScopedTimer(ctx, RC_TIMER_BUILD_DISTANCEFIELD_DIST);

    chf.maxDistance = calculateDistanceField(chf, src);
  }

  {
    using _timerBlur = new rcScopedTimer(ctx, RC_TIMER_BUILD_DISTANCEFIELD_BLUR);

    // Blur
    if (boxBlur(chf, 1, src, dst) !== src) {
      const t = src;
      src = dst;
      dst = t;
    }

    // Store distance.
    chf.dist = src;
  }

  return true;
}

/** @ac deps/recastnavigation/Recast/Source/RecastRegion.cpp paintRectRegion */
function paintRectRegion(
  minx: number,
  maxx: number,
  miny: number,
  maxy: number,
  regId: number,
  chf: rcCompactHeightfield,
  srcReg: Uint16Array,
): void {
  const w = chf.width;
  const cellIndex = chf.cells.index;
  const cellCount = chf.cells.count;
  for (let y = miny; y < maxy; ++y) {
    for (let x = minx; x < maxx; ++x) {
      const c = x + y * w;
      for (let i = cellIndex[c]!, ni = cellIndex[c]! + cellCount[c]!; i < ni; ++i) {
        if (chf.areas[i] !== RC_NULL_AREA) srcReg[i] = regId;
      }
    }
  }
}

/** @ac deps/recastnavigation/Recast/Source/RecastRegion.cpp RC_NULL_NEI */
const RC_NULL_NEI = 0xffff;

/**
 * `rcSweepSpan[nsweeps]` as parallel `unsigned short` arrays. The C++ sizes it `max(width, height)` and writes past
 * the end when a row holds more sweeps than that (undefined behavior); here it grows instead.
 * @ac deps/recastnavigation/Recast/Source/RecastRegion.cpp rcSweepSpan
 */
class rcSweepSpans {
  /** row id */
  rid: Uint16Array;
  /** region id */
  id: Uint16Array;
  /** number samples */
  ns: Uint16Array;
  /** neighbour id */
  nei: Uint16Array;

  constructor(n: number) {
    n = n > 1 ? n : 1;
    this.rid = new Uint16Array(n);
    this.id = new Uint16Array(n);
    this.ns = new Uint16Array(n);
    this.nei = new Uint16Array(n);
  }

  ensure(i: number): void {
    if (i < this.rid.length) return;
    let n = this.rid.length * 2;
    while (n <= i) n *= 2;
    const grow = (a: Uint16Array): Uint16Array => {
      const b = new Uint16Array(n);
      b.set(a);
      return b;
    };
    this.rid = grow(this.rid);
    this.id = grow(this.id);
    this.ns = grow(this.ns);
    this.nei = grow(this.nei);
  }
}

/** The monotone sweep shared by `rcBuildRegionsMonotone` and `rcBuildLayerRegions`. Returns the next region id. */
function sweepMonotoneRegions(chf: rcCompactHeightfield, borderSize: number, srcReg: Uint16Array, startId: number): number {
  const w = chf.width;
  const h = chf.height;
  const cellIndex = chf.cells.index;
  const cellCount = chf.cells.count;
  const con = chf.spans.con;
  const areas = chf.areas;
  let id = startId;

  const nsweeps = rcMax(chf.width, chf.height);
  const sweeps = new rcSweepSpans(nsweeps);

  const prev = new rcIntArray(256);

  // Sweep one line at a time.
  for (let y = borderSize; y < h - borderSize; ++y) {
    // Collect spans from this row.
    prev.resize(id + 1);
    prev.data.fill(0, 0, id + 1);
    const pd = prev.data;
    let rid = 1;

    for (let x = borderSize; x < w - borderSize; ++x) {
      const c = x + y * w;

      for (let i = cellIndex[c]!, ni = cellIndex[c]! + cellCount[c]!; i < ni; ++i) {
        if (areas[i] === RC_NULL_AREA) continue;

        // -x
        let previd = 0;
        if (rcGetCon(con, i, 0) !== RC_NOT_CONNECTED) {
          const ax = x + rcGetDirOffsetX(0);
          const ay = y + rcGetDirOffsetY(0);
          const ai = cellIndex[ax + ay * w]! + rcGetCon(con, i, 0);
          if ((srcReg[ai]! & RC_BORDER_REG) === 0 && areas[i] === areas[ai]) previd = srcReg[ai]!;
        }

        if (!previd) {
          previd = rid;
          rid = (rid + 1) & 0xffff;
          sweeps.ensure(previd);
          sweeps.rid[previd] = previd;
          sweeps.ns[previd] = 0;
          sweeps.nei[previd] = 0;
        }

        // -y
        if (rcGetCon(con, i, 3) !== RC_NOT_CONNECTED) {
          const ax = x + rcGetDirOffsetX(3);
          const ay = y + rcGetDirOffsetY(3);
          const ai = cellIndex[ax + ay * w]! + rcGetCon(con, i, 3);
          if (srcReg[ai] && (srcReg[ai]! & RC_BORDER_REG) === 0 && areas[i] === areas[ai]) {
            const nr = srcReg[ai]!;
            if (!sweeps.nei[previd] || sweeps.nei[previd] === nr) {
              sweeps.nei[previd] = nr;
              sweeps.ns[previd]!++;
              pd[nr]!++;
            } else {
              sweeps.nei[previd] = RC_NULL_NEI;
            }
          }
        }

        srcReg[i] = previd;
      }
    }

    // Create unique ID.
    for (let i = 1; i < rid; ++i) {
      const nei = sweeps.nei[i]!;
      if (nei !== RC_NULL_NEI && nei !== 0 && pd[nei] === sweeps.ns[i]) {
        sweeps.id[i] = nei;
      } else {
        sweeps.id[i] = id;
        id = (id + 1) & 0xffff;
      }
    }

    // Remap IDs
    for (let x = borderSize; x < w - borderSize; ++x) {
      const c = x + y * w;

      for (let i = cellIndex[c]!, ni = cellIndex[c]! + cellCount[c]!; i < ni; ++i) {
        if (srcReg[i]! > 0 && srcReg[i]! < rid) srcReg[i] = sweeps.id[srcReg[i]!]!;
      }
    }
  }
  return id;
}

/** Paints the four border regions; returns the next region id. */
function paintBorderRegions(chf: rcCompactHeightfield, borderSize: number, srcReg: Uint16Array, id: number): number {
  const w = chf.width;
  const h = chf.height;
  if (borderSize > 0) {
    // Make sure border will not overflow.
    const bw = rcMin(w, borderSize);
    const bh = rcMin(h, borderSize);
    // Paint regions
    paintRectRegion(0, bw, 0, h, (id | RC_BORDER_REG) & 0xffff, chf, srcReg);
    id++;
    paintRectRegion(w - bw, w, 0, h, (id | RC_BORDER_REG) & 0xffff, chf, srcReg);
    id++;
    paintRectRegion(0, w, 0, bh, (id | RC_BORDER_REG) & 0xffff, chf, srcReg);
    id++;
    paintRectRegion(0, w, h - bh, h, (id | RC_BORDER_REG) & 0xffff, chf, srcReg);
    id++;
  }
  return id & 0xffff;
}

/**
 * Builds region data for the heightfield using simple monotone partitioning.
 * @ac deps/recastnavigation/Recast/Source/RecastRegion.cpp rcBuildRegionsMonotone
 */
export function rcBuildRegionsMonotone(
  ctx: rcContext,
  chf: rcCompactHeightfield,
  borderSize: number,
  minRegionArea: number,
  mergeRegionArea: number,
): boolean {
  using _timer = new rcScopedTimer(ctx, RC_TIMER_BUILD_REGIONS);

  const srcReg = new Uint16Array(chf.spanCount);

  // Mark border regions.
  let id = paintBorderRegions(chf, borderSize, srcReg, 1);

  chf.borderSize = borderSize;

  id = sweepMonotoneRegions(chf, borderSize, srcReg, id);

  {
    using _timerFilter = new rcScopedTimer(ctx, RC_TIMER_BUILD_REGIONS_FILTER);

    // Merge regions and filter out small regions.
    const overlaps = new rcIntArray();
    chf.maxRegions = id;
    const maxRegions = { value: chf.maxRegions };
    const ok = mergeAndFilterRegions(ctx, minRegionArea, mergeRegionArea, maxRegions, chf, srcReg, overlaps);
    chf.maxRegions = maxRegions.value;
    if (!ok) return false;

    // Monotone partitioning does not generate overlapping regions.
  }

  // Store the result out.
  chf.spans.reg.set(srcReg);

  return true;
}

/**
 * Builds region data for the heightfield using watershed partitioning.
 * @ac deps/recastnavigation/Recast/Source/RecastRegion.cpp rcBuildRegions
 */
export function rcBuildRegions(
  ctx: rcContext,
  chf: rcCompactHeightfield,
  borderSize: number,
  minRegionArea: number,
  mergeRegionArea: number,
): boolean {
  using _timer = new rcScopedTimer(ctx, RC_TIMER_BUILD_REGIONS);

  ctx.startTimer(RC_TIMER_BUILD_REGIONS_WATERSHED);

  const LOG_NB_STACKS = 3;
  const NB_STACKS = 1 << LOG_NB_STACKS;
  const lvlStacks: rcEntryStack[] = [];
  for (let i = 0; i < NB_STACKS; ++i) lvlStacks.push(new rcEntryStack(256));

  const stack = new rcEntryStack(256);

  const srcReg = new Uint16Array(chf.spanCount);
  const srcDist = new Uint16Array(chf.spanCount);

  let regionId = 1;
  let level = ((chf.maxDistance + 1) & ~1) & 0xffff;

  // TODO: Figure better formula, expandIters defines how much the
  // watershed "overflows" and simplifies the regions. Tying it to
  // agent radius was usually good indication how greedy it could be.
  //	const int expandIters = 4 + walkableRadius * 2;
  const expandIters = 8;

  regionId = paintBorderRegions(chf, borderSize, srcReg, regionId);

  chf.borderSize = borderSize;

  let sId = -1;
  while (level > 0) {
    level = level >= 2 ? level - 2 : 0;
    sId = (sId + 1) & (NB_STACKS - 1);

    if (sId === 0) sortCellsByLevel(level, chf, srcReg, NB_STACKS, lvlStacks, 1);
    else appendStacks(lvlStacks[sId - 1]!, lvlStacks[sId]!, srcReg); // copy left overs from last level

    {
      using _timerExpand = new rcScopedTimer(ctx, RC_TIMER_BUILD_REGIONS_EXPAND);

      // Expand current regions until no empty connected cells found.
      expandRegions(expandIters, level, chf, srcReg, srcDist, lvlStacks[sId]!, false);
    }

    {
      using _timerFloor = new rcScopedTimer(ctx, RC_TIMER_BUILD_REGIONS_FLOOD);

      // Mark new regions with IDs.
      const lvl = lvlStacks[sId]!;
      for (let j = 0; j < lvl.n; j++) {
        const ld = lvl.data;
        const x = ld[j * 3]!;
        const y = ld[j * 3 + 1]!;
        const i = ld[j * 3 + 2]!;
        if (i >= 0 && srcReg[i] === 0) {
          if (floodRegion(x, y, i, level, regionId, chf, srcReg, srcDist, stack)) {
            if (regionId === 0xffff) {
              ctx.log(RC_LOG_ERROR, "rcBuildRegions: Region ID overflow");
              return false;
            }

            regionId++;
          }
        }
      }
    }
  }

  // Expand current regions until no empty connected cells found.
  expandRegions(expandIters * 8, 0, chf, srcReg, srcDist, stack, true);

  ctx.stopTimer(RC_TIMER_BUILD_REGIONS_WATERSHED);

  {
    using _timerFilter = new rcScopedTimer(ctx, RC_TIMER_BUILD_REGIONS_FILTER);

    // Merge regions and filter out smalle regions.
    const overlaps = new rcIntArray();
    chf.maxRegions = regionId;
    const maxRegions = { value: chf.maxRegions };
    const ok = mergeAndFilterRegions(ctx, minRegionArea, mergeRegionArea, maxRegions, chf, srcReg, overlaps);
    chf.maxRegions = maxRegions.value;
    if (!ok) return false;

    // If overlapping regions were found during merging, split those regions.
    if (overlaps.size() > 0) {
      ctx.log(RC_LOG_ERROR, "rcBuildRegions: %d overlapping regions.", overlaps.size());
    }
  }

  // Write the result out.
  chf.spans.reg.set(srcReg);

  return true;
}

/**
 * Builds region data for the heightfield by partitioning the heightfield in non-overlapping layers.
 * @ac deps/recastnavigation/Recast/Source/RecastRegion.cpp rcBuildLayerRegions
 */
export function rcBuildLayerRegions(ctx: rcContext, chf: rcCompactHeightfield, borderSize: number, minRegionArea: number): boolean {
  using _timer = new rcScopedTimer(ctx, RC_TIMER_BUILD_REGIONS);

  const srcReg = new Uint16Array(chf.spanCount);

  // Mark border regions.
  let id = paintBorderRegions(chf, borderSize, srcReg, 1);

  chf.borderSize = borderSize;

  id = sweepMonotoneRegions(chf, borderSize, srcReg, id);

  {
    using _timerFilter = new rcScopedTimer(ctx, RC_TIMER_BUILD_REGIONS_FILTER);

    // Merge monotone regions to layers and remove small regions.
    chf.maxRegions = id;
    const maxRegions = { value: chf.maxRegions };
    const ok = mergeAndFilterLayerRegions(ctx, minRegionArea, maxRegions, chf, srcReg);
    chf.maxRegions = maxRegions.value;
    if (!ok) return false;
  }

  // Store the result out.
  chf.spans.reg.set(srcReg);

  return true;
}
