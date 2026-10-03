import { AABox } from "../../math/AABox.ts";
import { fnan, fuzzyEq, fuzzyNe, inf } from "../../math/g3dmath.ts";
import type { Ray } from "../../math/Ray.ts";
import { Vector3 } from "../../math/Vector3.ts";
import type { ReadFile, WriteFile } from "./BinaryFile.ts";

/** @ac common/Collision/BoundingIntervalHierarchy.h MAX_STACK_SIZE */
export const MAX_STACK_SIZE = 64;

const convF32 = new Float32Array(1);
const convU32 = new Uint32Array(convF32.buffer);

/** @ac common/Collision/BoundingIntervalHierarchy.h floatToRawIntBits */
export function floatToRawIntBits(f: number): number {
  convF32[0] = f;
  return convU32[0]!;
}

/** @ac common/Collision/BoundingIntervalHierarchy.h intBitsToFloat */
export function intBitsToFloat(i: number): number {
  convU32[0] = i;
  return convF32[0]!;
}

/** `float&` arguments: the callee reads and writes `value`. Callers keep one per call site and reuse it. */
export interface FloatRef {
  value: number;
}

/** The `RayCallback` functor of `BIH::intersectRay`: `bool operator()(Ray const&, uint32 idx, float& maxDist, bool stopAtFirstHit)`. */
export interface BIHRayCallback {
  onRay(ray: Ray, entry: number, maxDist: FloatRef, stopAtFirstHit: boolean): boolean;
}

/** The `IsectCallback` functor of `BIH::intersectPoint`: `void operator()(Vector3 const&, uint32 idx)`. */
export interface BIHPointCallback {
  onPoint(point: Vector3, entry: number): void;
}

/** @ac common/Collision/BoundingIntervalHierarchy.h AABound */
export interface AABound {
  lo: Vector3;
  hi: Vector3;
}

function copyBound(b: AABound): AABound {
  return { lo: b.lo.clone(), hi: b.hi.clone() };
}

/**
 * The traversal stack (`StackNode stack[MAX_STACK_SIZE]` in each C++ call), shared by all traversals.
 * A traversal uses the slots from `stackTop` up; before it runs a callback (which may start a nested
 * traversal, e.g. MapTree -> WorldModel -> GroupModel) it moves `stackTop` past its live entries, and it
 * restores `stackTop` when it returns. Nothing is allocated per query.
 */
let stackCapacity = 1024;
let stackNode = new Int32Array(stackCapacity);
let stackNear = new Float64Array(stackCapacity);
let stackFar = new Float64Array(stackCapacity);
let stackTop = 0;

function growStack(): void {
  const next = stackCapacity * 2;
  const n = new Int32Array(next);
  n.set(stackNode);
  const a = new Float64Array(next);
  a.set(stackNear);
  const b = new Float64Array(next);
  b.set(stackFar);
  stackNode = n;
  stackNear = a;
  stackFar = b;
  stackCapacity = next;
}

/** @ac common/Collision/BoundingIntervalHierarchy.h BIH::buildData */
interface BuildData {
  indices: Uint32Array;
  /** Six floats per primitive: low xyz, high xyz. */
  primBound: Float32Array;
  numPrims: number;
  maxPrims: number;
}

/** @ac common/Collision/BoundingIntervalHierarchy.h BIH::BuildStats */
export class BuildStats {
  private numNodes = 0;
  private numLeaves = 0;
  private sumObjects = 0;
  private minObjects = 0x0fffffff;
  private maxObjects = -1;
  private sumDepth = 0;
  private minDepth = 0x0fffffff;
  private maxDepth = -1;
  private readonly numLeavesN = [0, 0, 0, 0, 0, 0];
  private numBVH2 = 0;

  /** @ac common/Collision/BoundingIntervalHierarchy.h BIH::BuildStats::updateInner */
  updateInner(): void {
    this.numNodes++;
  }

  /** @ac common/Collision/BoundingIntervalHierarchy.h BIH::BuildStats::updateBVH2 */
  updateBVH2(): void {
    this.numBVH2++;
  }

  /** @ac common/Collision/BoundingIntervalHierarchy.cpp BIH::BuildStats::updateLeaf */
  updateLeaf(depth: number, n: number): void {
    this.numLeaves++;
    this.minDepth = Math.min(depth, this.minDepth);
    this.maxDepth = Math.max(depth, this.maxDepth);
    this.sumDepth += depth;
    this.minObjects = Math.min(n, this.minObjects);
    this.maxObjects = Math.max(n, this.maxObjects);
    this.sumObjects += n;
    const nl = Math.min(n, 5);
    ++this.numLeavesN[nl]!;
  }

  /** @ac common/Collision/BoundingIntervalHierarchy.cpp BIH::BuildStats::printStats */
  printStats(): void {
    const pct = (v: number) => String(Math.trunc((100 * v) / this.numLeaves)).padStart(3, " ");
    const lines = [
      "Tree stats:",
      `  * Nodes:          ${this.numNodes}`,
      `  * Leaves:         ${this.numLeaves}`,
      `  * Objects: min    ${this.minObjects}`,
      `             avg    ${(this.sumObjects / this.numLeaves).toFixed(2)}`,
      `           avg(n>0) ${(this.sumObjects / (this.numLeaves - this.numLeavesN[0]!)).toFixed(2)}`,
      `             max    ${this.maxObjects}`,
      `  * Depth:   min    ${this.minDepth}`,
      `             avg    ${(this.sumDepth / this.numLeaves).toFixed(2)}`,
      `             max    ${this.maxDepth}`,
      `  * Leaves w/: N=0  ${pct(this.numLeavesN[0]!)}%`,
      `               N=1  ${pct(this.numLeavesN[1]!)}%`,
      `               N=2  ${pct(this.numLeavesN[2]!)}%`,
      `               N=3  ${pct(this.numLeavesN[3]!)}%`,
      `               N=4  ${pct(this.numLeavesN[4]!)}%`,
      `               N>4  ${pct(this.numLeavesN[5]!)}%`,
      `  * BVH2 nodes:     ${this.numBVH2} (${String(Math.trunc((100 * this.numBVH2) / (this.numNodes + this.numLeaves - 2 * this.numBVH2))).padStart(3, " ")}%)`,
    ];
    console.log(lines.join("\n"));
  }
}

const scratchBound = new AABox();

/**
 * Bounding Interval Hierarchy (Sunflow BIH, as used by TrinityCore and AzerothCore).
 *
 * The tree is a `Uint32Array` of 3-word nodes; split planes are stored as raw float bits and read through
 * a `Float32Array` view of the same buffer, so `intBitsToFloat(tree[i])` is `treeF[i]`.
 *
 * @ac common/Collision/BoundingIntervalHierarchy.h BIH
 */
export class BIH {
  protected tree: Uint32Array = new Uint32Array(3);
  protected treeF: Float32Array = new Float32Array(this.tree.buffer);
  protected objects: Uint32Array = new Uint32Array(0);
  protected bounds: AABox = new AABox();

  /** @ac common/Collision/BoundingIntervalHierarchy.h BIH::BIH */
  constructor() {
    this.init_empty();
  }

  /** @ac common/Collision/BoundingIntervalHierarchy.h BIH::init_empty */
  private init_empty(): void {
    this.setTree([(3 << 30) >>> 0, 0, 0]);
    this.objects = new Uint32Array(0);
    this.bounds = AABox.empty();
  }

  private setTree(words: ArrayLike<number>): void {
    this.tree = Uint32Array.from(words as ArrayLike<number>);
    this.treeF = new Float32Array(this.tree.buffer, this.tree.byteOffset, this.tree.length);
  }

  /**
   * Builds the tree over `primitives`. `getBounds(prim, out)` writes the bounds of one primitive. The
   * bounds are stored as floats, as in C++.
   *
   * @ac common/Collision/BoundingIntervalHierarchy.h BIH::build
   */
  build<T>(primitives: ArrayLike<T>, getBounds: (prim: T, out: AABox) => void, leafSize = 3, printStats = false): void {
    if (primitives.length === 0) {
      this.init_empty();
      return;
    }

    const numPrims = primitives.length;
    const dat: BuildData = {
      maxPrims: leafSize,
      numPrims,
      indices: new Uint32Array(numPrims),
      primBound: new Float32Array(numPrims * 6),
    };
    getBounds(primitives[0]!, scratchBound);
    this.bounds = new AABox();
    this.bounds.setBounds(
      Math.fround(scratchBound.lo.x), Math.fround(scratchBound.lo.y), Math.fround(scratchBound.lo.z),
      Math.fround(scratchBound.hi.x), Math.fround(scratchBound.hi.y), Math.fround(scratchBound.hi.z),
    );
    const primBox = new AABox();
    for (let i = 0; i < numPrims; ++i) {
      dat.indices[i] = i;
      getBounds(primitives[i]!, scratchBound);
      const pb = dat.primBound;
      pb[i * 6] = scratchBound.lo.x;
      pb[i * 6 + 1] = scratchBound.lo.y;
      pb[i * 6 + 2] = scratchBound.lo.z;
      pb[i * 6 + 3] = scratchBound.hi.x;
      pb[i * 6 + 4] = scratchBound.hi.y;
      pb[i * 6 + 5] = scratchBound.hi.z;
      primBox.setBounds(pb[i * 6]!, pb[i * 6 + 1]!, pb[i * 6 + 2]!, pb[i * 6 + 3]!, pb[i * 6 + 4]!, pb[i * 6 + 5]!);
      this.bounds.merge(primBox);
    }
    const tempTree: number[] = [];
    const stats = new BuildStats();
    this.buildHierarchy(tempTree, dat, stats);
    if (printStats) stats.printStats();

    this.objects = new Uint32Array(numPrims);
    for (let i = 0; i < numPrims; ++i) this.objects[i] = dat.indices[i]!;
    this.setTree(tempTree);
  }

  /** @ac common/Collision/BoundingIntervalHierarchy.h BIH::primCount */
  primCount(): number {
    return this.objects.length;
  }

  /** @ac common/Collision/BoundingIntervalHierarchy.h BIH::bound */
  bound(): AABox {
    return this.bounds;
  }

  /**
   * Walks the leaves the ray passes through, nearest first, and calls `intersectCallback` for each
   * object. `maxDist.value` is the current ray length; callbacks shorten it on a hit.
   *
   * @ac common/Collision/BoundingIntervalHierarchy.h BIH::intersectRay
   */
  intersectRay(r: Ray, intersectCallback: BIHRayCallback, maxDist: FloatRef, stopAtFirstHit: boolean): void {
    let intervalMin = -1;
    let intervalMax = -1;
    const org = r.origin();
    const dir = r.direction();
    const ox = org.x, oy = org.y, oz = org.z;
    const dx = dir.x, dy = dir.y, dz = dir.z;
    const ix = 1 / dx, iy = 1 / dy, iz = 1 / dz;
    const lo = this.bounds.lo;
    const hi = this.bounds.hi;
    for (let i = 0; i < 3; ++i) {
      const d = i === 0 ? dx : i === 1 ? dy : dz;
      if (fuzzyNe(d, 0)) {
        const o = i === 0 ? ox : i === 1 ? oy : oz;
        const inv = i === 0 ? ix : i === 1 ? iy : iz;
        let t1 = ((i === 0 ? lo.x : i === 1 ? lo.y : lo.z) - o) * inv;
        let t2 = ((i === 0 ? hi.x : i === 1 ? hi.y : hi.z) - o) * inv;
        if (t1 > t2) {
          const t = t1;
          t1 = t2;
          t2 = t;
        }
        if (t1 > intervalMin) intervalMin = t1;
        if (t2 < intervalMax || intervalMax < 0) intervalMax = t2;
        // intervalMax can only become smaller for other axis, and intervalMin only larger respectively, so stop early
        if (intervalMax <= 0 || intervalMin >= maxDist.value) return;
      }
    }

    if (intervalMin > intervalMax) return;
    intervalMin = Math.max(intervalMin, 0);
    intervalMax = Math.min(intervalMax, maxDist.value);

    // sign bit of each direction component: offsetFront = s + 1, offsetBack = (s ^ 1) + 1, offset*3 = s * 3
    const s0 = dx < 0 || Object.is(dx, -0) ? 1 : 0;
    const s1 = dy < 0 || Object.is(dy, -0) ? 1 : 0;
    const s2 = dz < 0 || Object.is(dz, -0) ? 1 : 0;

    const tree = this.tree;
    const treeF = this.treeF;
    const objects = this.objects;
    const base = stackTop;
    let stackPos = base;
    let node = 0;

    try {
      while (true) {
        while (true) {
          const tn = tree[node]!;
          const axis = tn >>> 30;
          const BVH2 = (tn & 0x20000000) !== 0;
          let offset = tn & 0x1fffffff;
          if (!BVH2) {
            if (axis < 3) {
              // "normal" interior node
              const s = axis === 0 ? s0 : axis === 1 ? s1 : s2;
              const o = axis === 0 ? ox : axis === 1 ? oy : oz;
              const inv = axis === 0 ? ix : axis === 1 ? iy : iz;
              const tf = (treeF[node + s + 1]! - o) * inv;
              const tb = (treeF[node + (s ^ 1) + 1]! - o) * inv;
              // ray passes between clip zones
              if (tf < intervalMin && tb > intervalMax) break;
              const back = offset + (s ^ 1) * 3;
              node = back;
              // ray passes through far node only
              if (tf < intervalMin) {
                intervalMin = tb >= intervalMin ? tb : intervalMin;
                continue;
              }
              node = offset + s * 3; // front
              // ray passes through near node only
              if (tb > intervalMax) {
                intervalMax = tf <= intervalMax ? tf : intervalMax;
                continue;
              }
              // ray passes through both nodes: push back node
              if (stackPos >= stackCapacity) growStack();
              stackNode[stackPos] = back;
              stackNear[stackPos] = tb >= intervalMin ? tb : intervalMin;
              stackFar[stackPos] = intervalMax;
              stackPos++;
              // update ray interval for front node
              intervalMax = tf <= intervalMax ? tf : intervalMax;
              continue;
            }
            // leaf - test some objects
            let n = tree[node + 1]! | 0;
            stackTop = stackPos;
            while (n > 0) {
              const hit = intersectCallback.onRay(r, objects[offset]!, maxDist, stopAtFirstHit);
              if (stopAtFirstHit && hit) return;
              --n;
              ++offset;
            }
            break;
          }
          if (axis > 2) return; // should not happen
          const s = axis === 0 ? s0 : axis === 1 ? s1 : s2;
          const o = axis === 0 ? ox : axis === 1 ? oy : oz;
          const inv = axis === 0 ? ix : axis === 1 ? iy : iz;
          const tf = (treeF[node + s + 1]! - o) * inv;
          const tb = (treeF[node + (s ^ 1) + 1]! - o) * inv;
          node = offset;
          intervalMin = tf >= intervalMin ? tf : intervalMin;
          intervalMax = tb <= intervalMax ? tb : intervalMax;
          if (intervalMin > intervalMax) break;
        } // traversal loop
        while (true) {
          // stack is empty?
          if (stackPos === base) return;
          // move back up the stack
          stackPos--;
          intervalMin = stackNear[stackPos]!;
          if (maxDist.value < intervalMin) continue;
          node = stackNode[stackPos]!;
          intervalMax = stackFar[stackPos]!;
          break;
        }
      }
    } finally {
      stackTop = base;
    }
  }

  /**
   * Calls `intersectCallback` for every object in the leaves whose clip zones contain `p`.
   *
   * @ac common/Collision/BoundingIntervalHierarchy.h BIH::intersectPoint
   */
  intersectPoint(p: Vector3, intersectCallback: BIHPointCallback): void {
    if (!this.bounds.contains(p)) return;

    const px = p.x, py = p.y, pz = p.z;
    const tree = this.tree;
    const treeF = this.treeF;
    const objects = this.objects;
    const base = stackTop;
    let stackPos = base;
    let node = 0;

    try {
      while (true) {
        while (true) {
          const tn = tree[node]!;
          const axis = tn >>> 30;
          const BVH2 = (tn & 0x20000000) !== 0;
          let offset = tn & 0x1fffffff;
          if (!BVH2) {
            if (axis < 3) {
              // "normal" interior node
              const pa = axis === 0 ? px : axis === 1 ? py : pz;
              const tl = treeF[node + 1]!;
              const tr = treeF[node + 2]!;
              // point is between clip zones
              if (tl < pa && tr > pa) break;
              const right = offset + 3;
              node = right;
              // point is in right node only
              if (tl < pa) continue;
              node = offset; // left
              // point is in left node only
              if (tr > pa) continue;
              // point is in both nodes: push back right node
              if (stackPos >= stackCapacity) growStack();
              stackNode[stackPos] = right;
              stackPos++;
              continue;
            }
            // leaf - test some objects
            let n = tree[node + 1]! | 0;
            stackTop = stackPos;
            while (n > 0) {
              intersectCallback.onPoint(p, objects[offset]!);
              --n;
              ++offset;
            }
            break;
          }
          // BVH2 node (empty space cut off left and right)
          if (axis > 2) return; // should not happen
          const pa = axis === 0 ? px : axis === 1 ? py : pz;
          const tl = treeF[node + 1]!;
          const tr = treeF[node + 2]!;
          node = offset;
          if (tl > pa || tr < pa) break;
        } // traversal loop

        // stack is empty?
        if (stackPos === base) return;
        // move back up the stack
        stackPos--;
        node = stackNode[stackPos]!;
      }
    } finally {
      stackTop = base;
    }
  }

  /** @ac common/Collision/BoundingIntervalHierarchy.cpp BIH::writeToFile */
  writeToFile(wf: WriteFile): boolean {
    const lo = this.bounds.low();
    const hi = this.bounds.high();
    wf.f32(lo.x);
    wf.f32(lo.y);
    wf.f32(lo.z);
    wf.f32(hi.x);
    wf.f32(hi.y);
    wf.f32(hi.z);
    wf.u32(this.tree.length);
    wf.u32Array(this.tree);
    wf.u32(this.objects.length);
    wf.u32Array(this.objects);
    return true;
  }

  /** @ac common/Collision/BoundingIntervalHierarchy.cpp BIH::readFromFile */
  readFromFile(rf: ReadFile): boolean {
    const b = rf.f32Array(6);
    if (!b) return false;
    this.bounds = new AABox(new Vector3(b[0], b[1], b[2]), new Vector3(b[3], b[4], b[5]));
    const treeSize = rf.u32();
    if (treeSize === undefined) return false;
    const tree = rf.u32Array(treeSize);
    if (!tree) return false;
    this.tree = tree;
    this.treeF = new Float32Array(tree.buffer, tree.byteOffset, tree.length);
    const count = rf.u32();
    if (count === undefined) return false;
    const objects = rf.u32Array(count);
    if (!objects) return false;
    this.objects = objects;
    return true;
  }

  /** @ac common/Collision/BoundingIntervalHierarchy.cpp BIH::buildHierarchy */
  protected buildHierarchy(tempTree: number[], dat: BuildData, stats: BuildStats): void {
    // create space for the first node
    tempTree.push((3 << 30) >>> 0, 0, 0); // dummy leaf

    // seed bbox
    const gridBox: AABound = { lo: this.bounds.low().clone(), hi: this.bounds.high().clone() };
    const nodeBox: AABound = copyBound(gridBox);
    // seed subdivide function
    this.subdivide(0, dat.numPrims - 1, tempTree, dat, gridBox, nodeBox, 0, 1, stats);
  }

  /** @ac common/Collision/BoundingIntervalHierarchy.h BIH::createNode */
  protected createNode(tempTree: number[], nodeIndex: number, left: number, right: number): void {
    // write leaf node
    tempTree[nodeIndex + 0] = ((3 << 30) | left) >>> 0;
    tempTree[nodeIndex + 1] = (right - left + 1) >>> 0;
  }

  /**
   * Splits `[left, right]` of `dat.indices`. All split and clip values are `float` in C++, so they are
   * rounded with `Math.fround` where the C++ stores them; the tree words are then the same as the
   * C++ build of the same input.
   *
   * @ac common/Collision/BoundingIntervalHierarchy.cpp BIH::subdivide
   */
  protected subdivide(
    left: number, right: number, tempTree: number[], dat: BuildData,
    gridBox: AABound, nodeBox: AABound, nodeIndex: number, depth: number, stats: BuildStats,
  ): void {
    if (right - left + 1 <= dat.maxPrims || depth >= MAX_STACK_SIZE) {
      // write leaf node
      stats.updateLeaf(depth, right - left + 1);
      this.createNode(tempTree, nodeIndex, left, right);
      return;
    }
    // calculate extents
    let axis = -1;
    let prevAxis: number;
    let rightOrig = right;
    let clipL = fnan();
    let clipR = fnan();
    let prevClip = fnan();
    let split = fnan();
    let prevSplit: number;
    let wasLeft = true;
    const f = Math.fround;
    const pb = dat.primBound;
    const indices = dat.indices;
    while (true) {
      prevAxis = axis;
      prevSplit = split;
      // perform quick consistency checks
      const d = new Vector3(f(gridBox.hi.x - gridBox.lo.x), f(gridBox.hi.y - gridBox.lo.y), f(gridBox.hi.z - gridBox.lo.z));
      if (d.x < 0 || d.y < 0 || d.z < 0) throw new Error("negative node extents");
      for (let i = 0; i < 3; i++) {
        if (nodeBox.hi.get(i) < gridBox.lo.get(i) || nodeBox.lo.get(i) > gridBox.hi.get(i)) {
          throw new Error("invalid node overlap");
        }
      }
      // find longest axis
      axis = d.primaryAxis();
      split = f(0.5 * f(gridBox.lo.get(axis) + gridBox.hi.get(axis)));
      // partition L/R subsets
      clipL = -inf();
      clipR = inf();
      rightOrig = right; // save this for later
      let nodeL = inf();
      let nodeR = -inf();
      for (let i = left; i <= right; ) {
        const obj = indices[i]!;
        const minb = pb[obj * 6 + axis]!;
        const maxb = pb[obj * 6 + 3 + axis]!;
        const center = f(f(minb + maxb) * 0.5);
        if (center <= split) {
          // stay left
          i++;
          if (clipL < maxb) clipL = maxb;
        } else {
          // move to the right most
          const t = indices[i]!;
          indices[i] = indices[right]!;
          indices[right] = t;
          right--;
          if (clipR > minb) clipR = minb;
        }
        nodeL = Math.min(nodeL, minb);
        nodeR = Math.max(nodeR, maxb);
      }
      // check for empty space
      if (nodeL > nodeBox.lo.get(axis) && nodeR < nodeBox.hi.get(axis)) {
        const nodeBoxW = f(nodeBox.hi.get(axis) - nodeBox.lo.get(axis));
        const nodeNewW = f(nodeR - nodeL);
        // node box is too big compare to space occupied by primitives?
        if (f(f(1.3) * nodeNewW) < nodeBoxW) {
          stats.updateBVH2();
          const nextIndex = tempTree.length;
          // allocate child
          tempTree.push(0, 0, 0);
          // write bvh2 clip node
          stats.updateInner();
          tempTree[nodeIndex + 0] = ((axis << 30) | (1 << 29) | nextIndex) >>> 0;
          tempTree[nodeIndex + 1] = floatToRawIntBits(nodeL);
          tempTree[nodeIndex + 2] = floatToRawIntBits(nodeR);
          // update nodebox and recurse
          nodeBox.lo.setAxis(axis, nodeL);
          nodeBox.hi.setAxis(axis, nodeR);
          this.subdivide(left, rightOrig, tempTree, dat, gridBox, nodeBox, nextIndex, depth + 1, stats);
          return;
        }
      }
      // ensure we are making progress in the subdivision
      if (right === rightOrig) {
        // all left
        if (prevAxis === axis && fuzzyEq(prevSplit, split)) {
          // we are stuck here - create a leaf
          stats.updateLeaf(depth, right - left + 1);
          this.createNode(tempTree, nodeIndex, left, right);
          return;
        }
        if (clipL <= split) {
          // keep looping on left half
          gridBox.hi.setAxis(axis, split);
          prevClip = clipL;
          wasLeft = true;
          continue;
        }
        gridBox.hi.setAxis(axis, split);
        prevClip = fnan();
      } else if (left > right) {
        // all right
        right = rightOrig;
        if (prevAxis === axis && fuzzyEq(prevSplit, split)) {
          // we are stuck here - create a leaf
          stats.updateLeaf(depth, right - left + 1);
          this.createNode(tempTree, nodeIndex, left, right);
          return;
        }
        if (clipR >= split) {
          // keep looping on right half
          gridBox.lo.setAxis(axis, split);
          prevClip = clipR;
          wasLeft = false;
          continue;
        }
        gridBox.lo.setAxis(axis, split);
        prevClip = fnan();
      } else {
        // we are actually splitting stuff
        if (prevAxis !== -1 && !Number.isNaN(prevClip)) {
          // second time through - lets create the previous split since it produced empty space
          const nextIndex = tempTree.length;
          // allocate child node
          tempTree.push(0, 0, 0);
          if (wasLeft) {
            // create a node with a left child
            stats.updateInner();
            tempTree[nodeIndex + 0] = ((prevAxis << 30) | nextIndex) >>> 0;
            tempTree[nodeIndex + 1] = floatToRawIntBits(prevClip);
            tempTree[nodeIndex + 2] = floatToRawIntBits(inf());
          } else {
            // create a node with a right child
            stats.updateInner();
            tempTree[nodeIndex + 0] = ((prevAxis << 30) | (nextIndex - 3)) >>> 0;
            tempTree[nodeIndex + 1] = floatToRawIntBits(-inf());
            tempTree[nodeIndex + 2] = floatToRawIntBits(prevClip);
          }
          // count stats for the unused leaf
          depth++;
          stats.updateLeaf(depth, 0);
          // now we keep going as we are, with a new nodeIndex:
          nodeIndex = nextIndex;
        }
        break;
      }
    }
    // compute index of child nodes
    let nextIndex = tempTree.length;
    // allocate left node
    const nl = right - left + 1;
    const nr = rightOrig - (right + 1) + 1;
    if (nl > 0) tempTree.push(0, 0, 0);
    else nextIndex -= 3;
    // allocate right node
    if (nr > 0) tempTree.push(0, 0, 0);
    // write leaf node
    stats.updateInner();
    tempTree[nodeIndex + 0] = ((axis << 30) | nextIndex) >>> 0;
    tempTree[nodeIndex + 1] = floatToRawIntBits(clipL);
    tempTree[nodeIndex + 2] = floatToRawIntBits(clipR);
    // prepare L/R child boxes
    const gridBoxL = copyBound(gridBox);
    const gridBoxR = copyBound(gridBox);
    const nodeBoxL = copyBound(nodeBox);
    const nodeBoxR = copyBound(nodeBox);
    gridBoxL.hi.setAxis(axis, split);
    gridBoxR.lo.setAxis(axis, split);
    nodeBoxL.hi.setAxis(axis, clipL);
    nodeBoxR.lo.setAxis(axis, clipR);
    // recurse
    if (nl > 0) this.subdivide(left, right, tempTree, dat, gridBoxL, nodeBoxL, nextIndex, depth + 1, stats);
    else stats.updateLeaf(depth + 1, 0);
    if (nr > 0) this.subdivide(right + 1, rightOrig, tempTree, dat, gridBoxR, nodeBoxR, nextIndex + 3, depth + 1, stats);
    else stats.updateLeaf(depth + 1, 0);
  }
}
