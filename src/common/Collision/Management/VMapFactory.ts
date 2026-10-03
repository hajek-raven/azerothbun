import { VMapMgr2 } from "./VMapMgr2.ts";

let gVMapMgr: VMapMgr2 | null = null;

/**
 * This is the access point to the VMapMgr.
 *
 * @ac common/Collision/Management/VMapFactory.h VMAP::VMapFactory
 */
export const VMapFactory = {
  /** Just return the instance. @ac common/Collision/Management/VMapFactory.cpp VMAP::VMapFactory::createOrGetVMapMgr */
  createOrGetVMapMgr(): VMapMgr2 {
    if (!gVMapMgr) gVMapMgr = new VMapMgr2();
    return gVMapMgr;
  },

  /** Delete all internal data structures. @ac common/Collision/Management/VMapFactory.cpp VMAP::VMapFactory::clear */
  clear(): void {
    gVMapMgr = null;
  },
};
