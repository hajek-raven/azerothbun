/**
 * @ac game/Maps/MapReference.h MapReference
 * @ac common/Dynamic/LinkedReference/Reference.h Reference
 *
 * One player's membership in its map's player list (`Player::m_mapRef`, a `Reference<Map, Player>`). The target is the
 * map (anything holding an `m_mapRefMgr`), the source is the player.
 */
import type { GridPlayer } from "../Grids/GridPlayer.ts";
import type { MapRefMgr } from "./MapRefMgr.ts";

/** The `Map` side of the link: `MapReference` reaches into `Map::m_mapRefMgr` (a friend in C++). */
export interface MapRefTarget<PLAYER = GridPlayer> {
  readonly m_mapRefMgr: MapRefMgr<PLAYER>;
}

export class MapReference<PLAYER = GridPlayer> {
  private iRefTo: MapRefTarget<PLAYER> | null = null;
  private iRefFrom: PLAYER | null = null;
  /** The manager's link counter when this reference was linked (see `MapRefMgr`). */
  _linkGeneration = 0;

  /**
   * @ac common/Dynamic/LinkedReference/Reference.h Reference::link
   * Create new link
   */
  link(toObj: MapRefTarget<PLAYER> | null, fromObj: PLAYER): void {
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
  getTarget(): MapRefTarget<PLAYER> | null {
    return this.iRefTo;
  }

  /** @ac common/Dynamic/LinkedReference/Reference.h Reference::GetSource */
  getSource(): PLAYER | null {
    return this.iRefFrom;
  }

  /** @ac game/Maps/MapReference.h MapReference::targetObjectBuildLink (called from link(); `insertFirst` plus `incSize`) */
  protected targetObjectBuildLink(): void {
    this.iRefTo?.m_mapRefMgr.insertFirst(this);
  }

  /** @ac game/Maps/MapReference.h MapReference::targetObjectDestroyLink (called from unlink(); `decSize` when valid) */
  protected targetObjectDestroyLink(): void {
    if (this.isValid()) this.iRefTo?.m_mapRefMgr.delink(this);
  }

  /** @ac game/Maps/MapReference.h MapReference::sourceObjectDestroyLink (called from invalidate(); `decSize`) */
  protected sourceObjectDestroyLink(): void {
    this.iRefTo?.m_mapRefMgr.delink(this);
  }
}
