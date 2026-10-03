/**
 * @ac game/Maps/ZoneScript.h ZoneScript
 * The hooks an instance script, outdoor PvP, or battlefield gets for the objects created in its zone. Every method is a
 * no-op default that the scripts override.
 */
import type { Creature } from "../Entities/Creature/Creature.ts";
import type { GameObject } from "../Entities/GameObject/GameObject.ts";
import type { WorldObject } from "../Entities/Object/Object.ts";
import type { UnitLike } from "../Grids/GridPlayer.ts";
import type { CreatureData } from "./SpawnData.ts";

export class ZoneScript {
  /** @ac game/Maps/ZoneScript.h ZoneScript::GetCreatureEntry */
  getCreatureEntry(_guidlow: number, data: CreatureData): number {
    return data.id;
  }

  /** @ac game/Maps/ZoneScript.h ZoneScript::GetGameObjectEntry */
  getGameObjectEntry(_guidlow: number, entry: number): number {
    return entry;
  }

  /** @ac game/Maps/ZoneScript.h ZoneScript::OnCreatureCreate */
  onCreatureCreate(_creature: Creature): void {}

  /** @ac game/Maps/ZoneScript.h ZoneScript::OnCreatureRemove */
  onCreatureRemove(_creature: Creature): void {}

  /** @ac game/Maps/ZoneScript.h ZoneScript::OnGameObjectCreate */
  onGameObjectCreate(_go: GameObject): void {}

  /** @ac game/Maps/ZoneScript.h ZoneScript::OnGameObjectRemove */
  onGameObjectRemove(_go: GameObject): void {}

  /** @ac game/Maps/ZoneScript.h ZoneScript::OnUnitDeath */
  onUnitDeath(_unit: UnitLike): void {}

  /** @ac game/Maps/ZoneScript.h ZoneScript::OnCreatureEvade */
  onCreatureEvade(_creature: Creature): void {}

  /** @ac game/Maps/ZoneScript.h ZoneScript::GetGuidData (all-purpose data storage 64 bit) */
  getGuidData(_DataId: number): bigint {
    return 0n;
  }

  /** @ac game/Maps/ZoneScript.h ZoneScript::SetGuidData */
  setGuidData(_DataId: number, _Value: bigint): void {}

  /** @ac game/Maps/ZoneScript.h ZoneScript::GetData64 */
  getData64(_DataId: number): bigint {
    return 0n;
  }

  /** @ac game/Maps/ZoneScript.h ZoneScript::SetData64 */
  setData64(_DataId: number, _Value: bigint): void {}

  /** @ac game/Maps/ZoneScript.h ZoneScript::GetData (all-purpose data storage 32 bit) */
  getData(_DataId: number): number {
    return 0;
  }

  /** @ac game/Maps/ZoneScript.h ZoneScript::SetData */
  setData(_DataId: number, _Value: number): void {}

  /** @ac game/Maps/ZoneScript.h ZoneScript::ProcessEvent */
  processEvent(_obj: WorldObject | null, _eventId: number): void {}
}
