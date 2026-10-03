/**
 * @ac game/Grids/GridRefMgr.h GridRefMgr
 * @ac common/Dynamic/LinkedReference/RefMgr.h RefMgr
 *
 * The C++ manager is the head of an intrusive doubly linked list of `GridReference`s. Here it is a `Set` of the
 * references: O(1) link and unlink, and a walk over it survives any element being unlinked during the visit (a removed
 * reference that was not reached yet is skipped, the current one may unlink itself). References linked after a walk
 * started are not visited by that walk, which matches the C++ list where `insertFirst` puts new links behind the
 * iterator. One difference: the C++ walk goes newest first (`insertFirst`), this one oldest first.
 */
import type { GridReference } from "./GridReference.ts";

export class GridRefMgr<OBJECT> {
  /** The linked references in link order. */
  private readonly refs = new Set<GridReference<OBJECT>>();
  /** Bumped at every link; a walk ignores references stamped after it started. */
  private linkGeneration = 0;

  /** @ac common/Dynamic/LinkedList.h LinkedListHead::IsEmpty */
  isEmpty(): boolean {
    return this.refs.size === 0;
  }

  /** @ac common/Dynamic/LinkedList.h LinkedListHead::getSize */
  getSize(): number {
    return this.refs.size;
  }

  /** @ac game/Grids/GridRefMgr.h GridRefMgr::getFirst */
  getFirst(): GridReference<OBJECT> | null {
    for (const ref of this.refs) return ref;
    return null;
  }

  /** @ac game/Grids/GridRefMgr.h GridRefMgr::getLast */
  getLast(): GridReference<OBJECT> | null {
    let last: GridReference<OBJECT> | null = null;
    for (const ref of this.refs) last = ref;
    return last;
  }

  /**
   * @ac common/Dynamic/LinkedList.h LinkedListHead::insertFirst
   * Called from `GridReference::targetObjectBuildLink`; `incSize` is the `Set` size.
   */
  insertFirst(ref: GridReference<OBJECT>): void {
    ref._linkGeneration = ++this.linkGeneration;
    this.refs.add(ref);
  }

  /** @ac common/Dynamic/LinkedList.h LinkedListElement::delink (the list side; `decSize` is the `Set` size) */
  delink(ref: GridReference<OBJECT>): void {
    this.refs.delete(ref);
  }

  /** @ac common/Dynamic/LinkedReference/RefMgr.h RefMgr::clearReferences */
  clearReferences(): void {
    let ref: GridReference<OBJECT> | null;
    while ((ref = this.getFirst()) !== null) {
      ref.invalidate();
      this.refs.delete(ref); // the delink might be already done by invalidate(), but doing it here again does not hurt and insures an empty list
    }
  }

  /**
   * @ac game/Grids/GridRefMgr.h GridRefMgr::begin
   * The sources (`iter->GetSource()`) of the references linked when the walk started and still linked when reached.
   */
  *[Symbol.iterator](): IterableIterator<OBJECT> {
    const generation = this.linkGeneration;
    for (const ref of this.refs) {
      if (ref._linkGeneration > generation) continue;
      const source = ref.getSource();
      if (source !== null) yield source;
    }
  }
}
