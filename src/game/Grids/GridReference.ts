/**
 * @ac game/Grids/GridReference.h GridReference
 * @ac common/Dynamic/LinkedReference/Reference.h Reference
 * One object's membership in one `GridRefMgr` (the C++ `GridObject<T>::_gridRef`). The target is the manager, the
 * source is the object.
 */
import type { GridRefMgr } from "./GridRefMgr.ts";

export class GridReference<OBJECT> {
  private iRefTo: GridRefMgr<OBJECT> | null = null;
  private iRefFrom: OBJECT | null = null;
  /** The manager's link counter when this reference was linked (see `GridRefMgr`). */
  _linkGeneration = 0;

  /**
   * @ac common/Dynamic/LinkedReference/Reference.h Reference::link
   * Create new link
   */
  link(toObj: GridRefMgr<OBJECT> | null, fromObj: OBJECT): void {
    if (this.isValid()) {
      this.unlink();
    }
    if (toObj !== null) {
      this.iRefTo = toObj;
      this.iRefFrom = fromObj;
      this.targetObjectBuildLink();
    }
  }

  /**
   * @ac common/Dynamic/LinkedReference/Reference.h Reference::unlink
   * We don't need the reference anymore. Call comes from the refFrom object. Tell our refTo object, that the link is cut
   */
  unlink(): void {
    this.targetObjectDestroyLink();
    this.iRefTo = null;
    this.iRefFrom = null;
  }

  /**
   * @ac common/Dynamic/LinkedReference/Reference.h Reference::invalidate
   * Link is invalid due to destruction of referenced target object. Call comes from the refTo object. Tell our refFrom
   * object, that the link is cut. The iRefFrom MUST remain!!
   */
  invalidate(): void {
    this.sourceObjectDestroyLink();
    this.iRefTo = null;
  }

  /** @ac common/Dynamic/LinkedReference/Reference.h Reference::isValid (only check the iRefTo) */
  isValid(): boolean {
    return this.iRefTo !== null;
  }

  /** @ac common/Dynamic/LinkedReference/Reference.h Reference::getTarget */
  getTarget(): GridRefMgr<OBJECT> | null {
    return this.iRefTo;
  }

  /** @ac common/Dynamic/LinkedReference/Reference.h Reference::GetSource */
  getSource(): OBJECT | null {
    return this.iRefFrom;
  }

  /** @ac game/Grids/GridReference.h GridReference::targetObjectBuildLink (called from link()) */
  protected targetObjectBuildLink(): void {
    this.iRefTo?.insertFirst(this);
  }

  /** @ac game/Grids/GridReference.h GridReference::targetObjectDestroyLink (called from unlink()) */
  protected targetObjectDestroyLink(): void {
    if (this.isValid()) this.iRefTo?.delink(this);
  }

  /** @ac game/Grids/GridReference.h GridReference::sourceObjectDestroyLink (called from invalidate()) */
  protected sourceObjectDestroyLink(): void {
    this.iRefTo?.delink(this);
  }
}
