/**
 * @ac game/Maps/MapRefMgr.h MapRefMgr
 * @ac common/Dynamic/LinkedReference/RefMgr.h RefMgr
 *
 * The players on a map (`Map::m_mapRefMgr`, a `RefMgr<Map, Player>`). The C++ manager is the head of an intrusive doubly
 * linked list of `MapReference`s; here it is a `Set` of the references, like `GridRefMgr`: O(1) link and unlink, a walk
 * survives any element being unlinked during the visit, and references linked after a walk started are not visited by
 * it. The C++ `insertFirst` walk goes newest first, this one oldest first. `incSize`/`decSize` are the `Set` size.
 */
import type { GridPlayer } from "../Grids/GridPlayer.ts";
import type { MapReference } from "./MapReference.ts";

export class MapRefMgr<PLAYER = GridPlayer> {
  private readonly refs = new Set<MapReference<PLAYER>>();
  private linkGeneration = 0;

  /** @ac common/Dynamic/LinkedList.h LinkedListHead::IsEmpty */
  isEmpty(): boolean {
    return this.refs.size === 0;
  }

  /** @ac common/Dynamic/LinkedList.h LinkedListHead::getSize */
  getSize(): number {
    return this.refs.size;
  }

  /** @ac game/Maps/MapRefMgr.h MapRefMgr::getFirst */
  getFirst(): MapReference<PLAYER> | null {
    for (const ref of this.refs) return ref;
    return null;
  }

  /** @ac game/Maps/MapRefMgr.h MapRefMgr::getLast */
  getLast(): MapReference<PLAYER> | null {
    let last: MapReference<PLAYER> | null = null;
    for (const ref of this.refs) last = ref;
    return last;
  }

  /** @ac common/Dynamic/LinkedList.h LinkedListHead::insertFirst (with `incSize`) */
  insertFirst(ref: MapReference<PLAYER>): void {
    ref._linkGeneration = ++this.linkGeneration;
    this.refs.add(ref);
  }

  /** @ac common/Dynamic/LinkedList.h LinkedListElement::delink (the list side, with `decSize`) */
  delink(ref: MapReference<PLAYER>): void {
    this.refs.delete(ref);
  }

  /** @ac common/Dynamic/LinkedReference/RefMgr.h RefMgr::clearReferences */
  clearReferences(): void {
    let ref: MapReference<PLAYER> | null;
    while ((ref = this.getFirst()) !== null) {
      ref.invalidate();
      this.refs.delete(ref);
    }
  }

  /**
   * @ac game/Maps/MapRefMgr.h MapRefMgr::begin
   * The players (`itr->GetSource()`) linked when the walk started and still linked when reached.
   */
  *[Symbol.iterator](): IterableIterator<PLAYER> {
    const generation = this.linkGeneration;
    for (const ref of this.refs) {
      if (ref._linkGeneration > generation) continue;
      const source = ref.getSource();
      if (source !== null) yield source;
    }
  }

  /** @ac game/Maps/MapRefMgr.h MapRefMgr::begin (the references, for code that needs `MapReference` itself) */
  references(): MapReference<PLAYER>[] {
    return [...this.refs];
  }
}
