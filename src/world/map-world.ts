/**
 * The bridge between the map layer and the rest of the world code: the creatures of the maps as the combat code asks for
 * them (`CreatureLocator`), and the create blocks of what the grid notifiers show a player (`Object::BuildCreateUpdateBlock
 * ForPlayer` goes through `Object.createUpdateBlockBuilder`).
 *
 * The creature and gameobject blocks are the ones of `spawn.ts` over the spawn row of the object (`sObjectMgr`), with the
 * live state of a creature taken from the combat world (`CombatWorld.liveView`) of the viewer's session; a player's block is
 * `update-object.ts` `playerUpdateBlock` over the other session's character row.
 */
import type { CreatureSpawn } from "../data/world.ts";
import { Cell } from "../game/Grids/Cells/Cell.ts";
import type { GridTypeMapVisitor } from "../game/Grids/TypeContainer.ts";
import type { Creature } from "../game/Entities/Creature/Creature.ts";
import { Object as AcObject } from "../game/Entities/Object/Object.ts";
import { sObjectMgr } from "../game/Globals/ObjectMgr.ts";
import { sMapMgr } from "../game/Maps/MapMgr.ts";
import type { Map as AcMap } from "../game/Maps/Map.ts";
import type { CreatureMapType } from "../game/Grids/GridDefines.ts";
import { creatureCreateBlock, gameObjectCreateBlock } from "./spawn.ts";
import { SessionMapPlayer } from "./session-map-player.ts";
import { playerUpdateBlock } from "./update-object.ts";

/** A place on a map (the part of a position the creature queries read). */
export type Place = { map: number; x: number; y: number; z: number };

/** The creatures of the loaded grids, for the combat code (what `SpawnIndex` was for the spawn rows). */
export interface CreatureLocator {
  /** The spawn rows of the creatures within `radius` (3D) of a place, of any phase. */
  creaturesNear(place: Place, radius: number): CreatureSpawn[];
  /** The creature of a spawn on a map (the first instance that has it), or null when its grid is not loaded. */
  findCreature(map: number, spawnGuid: number): Creature | null;
}

/** The maps with this id: the world map, or every instance of a dungeon. */
function mapsWithId(mapId: number): AcMap[] {
  const maps: AcMap[] = [];
  sMapMgr().doForAllMapsWithMapId(mapId, (map) => maps.push(map));
  return maps;
}

class CreaturesInRange implements GridTypeMapVisitor {
  readonly found: Creature[] = [];

  constructor(
    private readonly x: number,
    private readonly y: number,
    private readonly z: number,
    private readonly radius: number,
  ) {}

  visitCreatureMap(m: CreatureMapType): void {
    for (const creature of m) {
      // where the creature is now (`Creature::GetPosition`): it wanders, walks a path, or chases
      const dx = creature.getPositionX() - this.x;
      const dy = creature.getPositionY() - this.y;
      const dz = creature.getPositionZ() - this.z;
      if (dx * dx + dy * dy + dz * dz <= this.radius * this.radius) this.found.push(creature);
    }
  }
}

/**
 * `Cell::VisitObjects` over the grids of the maps of the place: the creatures of the cells within `radius`, then the ones within
 * `radius` of the place (3D, by their current position: they move).
 */
export const mapCreatureLocator: CreatureLocator = {
  creaturesNear(place, radius) {
    const rows = new Map<number, CreatureSpawn>();
    for (const map of mapsWithId(place.map)) {
      const visitor = new CreaturesInRange(place.x, place.y, place.z, radius);
      Cell.visitObjects(place.x, place.y, map, visitor, radius);
      for (const creature of visitor.found) {
        const spawn = sObjectMgr.getShownCreatureSpawn(creature.getSpawnId());
        if (spawn && !rows.has(spawn.guid)) rows.set(spawn.guid, spawn);
      }
    }
    return [...rows.values()];
  },

  findCreature(map, spawnGuid) {
    for (const found of mapsWithId(map)) {
      const creature = found.getCreatureBySpawnIdStore().get(spawnGuid)?.[0];
      if (creature) return creature;
    }
    return null;
  },
};

/** `Object::BuildCreateUpdateBlockForPlayer`: the create block of an object for a player's client. */
function buildCreateBlock(obj: AcObject, target: unknown): Uint8Array | null {
  if (!(target instanceof SessionMapPlayer) || obj === target) return null;

  if (obj instanceof SessionMapPlayer) {
    const session = obj.session;
    const character = session.character;
    if (!character) return null;
    return playerUpdateBlock(character, false, session.clientMoveTime, session.standState < 0 ? 0 : session.standState, session.publicFieldStats());
  }

  const world = sObjectMgr.worldData();
  if (!world) return null;

  if (obj.isCreature()) {
    const creature = obj as unknown as Creature;
    const spawn = sObjectMgr.getShownCreatureSpawn(creature.getSpawnId());
    const template = world.creatureTemplate(creature.getEntry());
    if (!spawn || !template) return null;
    // `Creature::GetEntry()` is the entry this creature was created with (a spawn with variants shows its variant)
    const row = creature.getEntry() === spawn.entry ? spawn : { ...spawn, entry: creature.getEntry() };
    const live = target.session.combat?.liveView(creature.getSpawnId(), target.session.character?.guid ?? 0) ?? null;
    return creatureCreateBlock(row, template, world, live, creature);
  }

  if (obj.isGameObject()) {
    const go = obj as unknown as { getSpawnId(): number; getEntry(): number };
    const spawn = sObjectMgr.getShownGameObjectSpawn(go.getSpawnId());
    const template = world.gameObjectTemplate(go.getEntry());
    if (!spawn || !template) return null;
    return gameObjectCreateBlock(spawn, template);
  }

  // @ac-skip corpses and dynamic objects: no create block (corpses are rows of `corpse`; dynamic objects are not ported)
  return null;
}

/** Registers the block builder (`Object::BuildCreateUpdateBlockForPlayer`); every session module installs it on import. */
export function installUpdateBlockBuilder(): void {
  AcObject.createUpdateBlockBuilder = buildCreateBlock;
}

installUpdateBlockBuilder();
