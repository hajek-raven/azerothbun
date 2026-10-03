/**
 * Port of `deps/recastnavigation/Detour/Include/DetourNode.h` and `Source/DetourNode.cpp`.
 *
 * The pool allocates every `dtNode` once (`new dtNodePool(maxNodes, hashSize)`), and the open list is a binary heap
 * over node references, so a search allocates nothing.
 */
import { dtAssert } from "./DetourAssert.ts";
import { dtNextPow2 } from "./DetourCommon.ts";
import type { dtPolyRef } from "./DetourNavMesh.ts";

/** @ac deps/recastnavigation/Detour/Include/DetourNode.h dtNodeFlags */
export const dtNodeFlags = {
  DT_NODE_OPEN: 0x01,
  DT_NODE_CLOSED: 0x02,
  /** parent of the node is not adjacent. Found using raycast. */
  DT_NODE_PARENT_DETACHED: 0x04,
} as const;
export const DT_NODE_OPEN = dtNodeFlags.DT_NODE_OPEN;
export const DT_NODE_CLOSED = dtNodeFlags.DT_NODE_CLOSED;
export const DT_NODE_PARENT_DETACHED = dtNodeFlags.DT_NODE_PARENT_DETACHED;

/** @ac deps/recastnavigation/Detour/Include/DetourNode.h dtNodeIndex */
export type dtNodeIndex = number;
/** @ac deps/recastnavigation/Detour/Include/DetourNode.h DT_NULL_IDX */
export const DT_NULL_IDX: dtNodeIndex = 0xffff;

/** @ac deps/recastnavigation/Detour/Include/DetourNode.h DT_NODE_PARENT_BITS */
export const DT_NODE_PARENT_BITS = 24;
/** @ac deps/recastnavigation/Detour/Include/DetourNode.h DT_NODE_STATE_BITS */
export const DT_NODE_STATE_BITS = 2;

/** @ac deps/recastnavigation/Detour/Include/DetourNode.h dtNode */
export class dtNode {
  /** Position of the node. */
  readonly pos = new Float32Array(3);
  /** Cost from previous node to current node. */
  cost = 0;
  /** Cost up to the node. */
  total = 0;
  /** Index to parent node (24 bits). */
  pidx = 0;
  /** extra state information. A polyRef can have multiple nodes with different extra info. see DT_MAX_STATES_PER_NODE */
  state = 0;
  /** Node flags. A combination of dtNodeFlags. */
  flags = 0;
  /** Polygon ref the node corresponds to. */
  id: dtPolyRef = 0;
  /** Position in `dtNodePool::m_nodes` (the C++ `node - m_nodes`). */
  readonly index: number;

  constructor(index: number) {
    this.index = index;
  }
}

/** number of extra states per node. See dtNode::state @ac deps/recastnavigation/Detour/Include/DetourNode.h DT_MAX_STATES_PER_NODE */
export const DT_MAX_STATES_PER_NODE = 1 << DT_NODE_STATE_BITS;

/**
 * `dtHashRef` of the 64-bit build hashes the full `uint64`. A JavaScript `dtPolyRef` is a 53-bit number, so the
 * two 32-bit halves are folded and mixed with the 32-bit Thomas Wang hash of the non-64-bit build. The hash only
 * picks the bucket; lookups compare the full ref, so results do not depend on it.
 * @ac deps/recastnavigation/Detour/Source/DetourNode.cpp dtHashRef
 */
export function dtHashRef(ref: dtPolyRef): number {
  let a = (ref >>> 0) ^ Math.floor(ref / 4294967296);
  a = (a + ~(a << 15)) >>> 0;
  a = (a ^ (a >>> 10)) >>> 0;
  a = (a + (a << 3)) >>> 0;
  a = (a ^ (a >>> 6)) >>> 0;
  a = (a + ~(a << 11)) >>> 0;
  a = (a ^ (a >>> 16)) >>> 0;
  return a;
}

/** @ac deps/recastnavigation/Detour/Include/DetourNode.h dtNodePool */
export class dtNodePool {
  private readonly m_nodes: dtNode[];
  private readonly m_first: Uint16Array;
  private readonly m_next: Uint16Array;
  private readonly m_maxNodes: number;
  private readonly m_hashSize: number;
  private m_nodeCount = 0;

  /** @ac deps/recastnavigation/Detour/Source/DetourNode.cpp dtNodePool::dtNodePool */
  constructor(maxNodes: number, hashSize: number) {
    this.m_maxNodes = maxNodes;
    this.m_hashSize = hashSize;
    dtAssert(dtNextPow2(this.m_hashSize) === this.m_hashSize, "dtNextPow2(m_hashSize) == (unsigned int)m_hashSize");
    // pidx is special as 0 means "none" and 1 is the first node. For that reason
    // we have 1 fewer nodes available than the number of values it can contain.
    dtAssert(
      this.m_maxNodes > 0 && this.m_maxNodes <= DT_NULL_IDX && this.m_maxNodes <= (1 << DT_NODE_PARENT_BITS) - 1,
      "m_maxNodes > 0 && m_maxNodes <= DT_NULL_IDX && m_maxNodes <= (1 << DT_NODE_PARENT_BITS) - 1",
    );

    this.m_nodes = new Array<dtNode>(this.m_maxNodes);
    for (let i = 0; i < this.m_maxNodes; ++i) this.m_nodes[i] = new dtNode(i);
    this.m_next = new Uint16Array(this.m_maxNodes).fill(0xffff);
    this.m_first = new Uint16Array(hashSize).fill(0xffff);
  }

  /** @ac deps/recastnavigation/Detour/Source/DetourNode.cpp dtNodePool::clear */
  clear(): void {
    this.m_first.fill(0xffff);
    this.m_nodeCount = 0;
  }

  /**
   * Get a dtNode by ref and extra state information. If there is none then - allocate
   * There can be more than one node for the same polyRef but with different extra state information
   * @ac deps/recastnavigation/Detour/Source/DetourNode.cpp dtNodePool::getNode
   */
  getNode(id: dtPolyRef, state = 0): dtNode | null {
    const bucket = dtHashRef(id) & (this.m_hashSize - 1);
    let i = this.m_first[bucket]!;
    while (i !== DT_NULL_IDX) {
      const n = this.m_nodes[i]!;
      if (n.id === id && n.state === state) return n;
      i = this.m_next[i]!;
    }

    if (this.m_nodeCount >= this.m_maxNodes) return null;

    i = this.m_nodeCount;
    this.m_nodeCount++;

    // Init node
    const node = this.m_nodes[i]!;
    node.pidx = 0;
    node.cost = 0;
    node.total = 0;
    node.id = id;
    node.state = state;
    node.flags = 0;

    this.m_next[i] = this.m_first[bucket]!;
    this.m_first[bucket] = i;

    return node;
  }

  /** @ac deps/recastnavigation/Detour/Source/DetourNode.cpp dtNodePool::findNode */
  findNode(id: dtPolyRef, state: number): dtNode | null {
    const bucket = dtHashRef(id) & (this.m_hashSize - 1);
    let i = this.m_first[bucket]!;
    while (i !== DT_NULL_IDX) {
      const n = this.m_nodes[i]!;
      if (n.id === id && n.state === state) return n;
      i = this.m_next[i]!;
    }
    return null;
  }

  /** @ac deps/recastnavigation/Detour/Source/DetourNode.cpp dtNodePool::findNodes */
  findNodes(id: dtPolyRef, nodes: (dtNode | null)[], maxNodes: number): number {
    let n = 0;
    const bucket = dtHashRef(id) & (this.m_hashSize - 1);
    let i = this.m_first[bucket]!;
    while (i !== DT_NULL_IDX) {
      const node = this.m_nodes[i]!;
      if (node.id === id) {
        if (n >= maxNodes) return n;
        nodes[n++] = node;
      }
      i = this.m_next[i]!;
    }

    return n;
  }

  /** @ac deps/recastnavigation/Detour/Include/DetourNode.h dtNodePool::getNodeIdx */
  getNodeIdx(node: dtNode | null): number {
    if (!node) return 0;
    return node.index + 1;
  }

  /** @ac deps/recastnavigation/Detour/Include/DetourNode.h dtNodePool::getNodeAtIdx */
  getNodeAtIdx(idx: number): dtNode | null {
    if (!idx) return null;
    return this.m_nodes[idx - 1]!;
  }

  /** @ac deps/recastnavigation/Detour/Include/DetourNode.h dtNodePool::getMemUsed */
  getMemUsed(): number {
    // sizeof(dtNode) is 32 with a 64-bit dtPolyRef.
    return 48 + 32 * this.m_maxNodes + 2 * this.m_maxNodes + 2 * this.m_hashSize;
  }

  /** @ac deps/recastnavigation/Detour/Include/DetourNode.h dtNodePool::getMaxNodes */
  getMaxNodes(): number {
    return this.m_maxNodes;
  }

  /** @ac deps/recastnavigation/Detour/Include/DetourNode.h dtNodePool::getHashSize */
  getHashSize(): number {
    return this.m_hashSize;
  }

  /** @ac deps/recastnavigation/Detour/Include/DetourNode.h dtNodePool::getFirst */
  getFirst(bucket: number): dtNodeIndex {
    return this.m_first[bucket]!;
  }

  /** @ac deps/recastnavigation/Detour/Include/DetourNode.h dtNodePool::getNext */
  getNext(i: number): dtNodeIndex {
    return this.m_next[i]!;
  }

  /** @ac deps/recastnavigation/Detour/Include/DetourNode.h dtNodePool::getNodeCount */
  getNodeCount(): number {
    return this.m_nodeCount;
  }
}

/** @ac deps/recastnavigation/Detour/Include/DetourNode.h dtNodeQueue */
export class dtNodeQueue {
  private readonly m_heap: (dtNode | null)[];
  private readonly m_capacity: number;
  private m_size = 0;

  /** @ac deps/recastnavigation/Detour/Source/DetourNode.cpp dtNodeQueue::dtNodeQueue */
  constructor(n: number) {
    this.m_capacity = n;
    dtAssert(this.m_capacity > 0, "m_capacity > 0");
    this.m_heap = new Array<dtNode | null>(this.m_capacity + 1).fill(null);
  }

  /** @ac deps/recastnavigation/Detour/Include/DetourNode.h dtNodeQueue::clear */
  clear(): void {
    this.m_size = 0;
  }

  /** @ac deps/recastnavigation/Detour/Include/DetourNode.h dtNodeQueue::top */
  top(): dtNode {
    return this.m_heap[0]!;
  }

  /** @ac deps/recastnavigation/Detour/Include/DetourNode.h dtNodeQueue::pop */
  pop(): dtNode {
    const result = this.m_heap[0]!;
    this.m_size--;
    this.trickleDown(0, this.m_heap[this.m_size]!);
    return result;
  }

  /** @ac deps/recastnavigation/Detour/Include/DetourNode.h dtNodeQueue::push */
  push(node: dtNode): void {
    this.m_size++;
    this.bubbleUp(this.m_size - 1, node);
  }

  /** @ac deps/recastnavigation/Detour/Include/DetourNode.h dtNodeQueue::modify */
  modify(node: dtNode): void {
    for (let i = 0; i < this.m_size; ++i) {
      if (this.m_heap[i] === node) {
        this.bubbleUp(i, node);
        return;
      }
    }
  }

  /** @ac deps/recastnavigation/Detour/Include/DetourNode.h dtNodeQueue::empty */
  empty(): boolean {
    return this.m_size === 0;
  }

  /** @ac deps/recastnavigation/Detour/Include/DetourNode.h dtNodeQueue::getMemUsed */
  getMemUsed(): number {
    return 16 + 8 * (this.m_capacity + 1);
  }

  /** @ac deps/recastnavigation/Detour/Include/DetourNode.h dtNodeQueue::getCapacity */
  getCapacity(): number {
    return this.m_capacity;
  }

  /** @ac deps/recastnavigation/Detour/Source/DetourNode.cpp dtNodeQueue::bubbleUp */
  private bubbleUp(i: number, node: dtNode): void {
    let parent = Math.trunc((i - 1) / 2);
    // note: (index > 0) means there is a parent
    while (i > 0 && this.m_heap[parent]!.total > node.total) {
      this.m_heap[i] = this.m_heap[parent]!;
      i = parent;
      parent = Math.trunc((i - 1) / 2);
    }
    this.m_heap[i] = node;
  }

  /** @ac deps/recastnavigation/Detour/Source/DetourNode.cpp dtNodeQueue::trickleDown */
  private trickleDown(i: number, node: dtNode): void {
    let child = i * 2 + 1;
    while (child < this.m_size) {
      if (child + 1 < this.m_size && this.m_heap[child]!.total > this.m_heap[child + 1]!.total) {
        child++;
      }
      this.m_heap[i] = this.m_heap[child]!;
      i = child;
      child = i * 2 + 1;
    }
    this.bubbleUp(i, node);
  }
}
