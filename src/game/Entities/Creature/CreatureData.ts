/**
 * @ac game/Entities/Creature/CreatureData.h (the movement part: `CreatureGroundMovementType`, `CreatureFlightMovementType`,
 * `CreatureChaseMovementType`, `CreatureRandomMovementType`, `CreatureMovementData`) and `CreatureMovementData::CreatureMovementData`
 * of `Creature.cpp`.
 *
 * The rest of `CreatureData.h` lives where the creature template and spawn data already are (`src/data/world.ts`,
 * `src/game/Maps/SpawnData.ts`).
 */
import { ServerConfig } from "../../world/world-config-data.ts";
import { sWorld } from "../../world/world.ts";

/** @ac game/Entities/Creature/CreatureData.h CreatureGroundMovementType */
export const CreatureGroundMovementType = { None: 0, Run: 1, Hover: 2, Max: 3 } as const;
/** @ac game/Entities/Creature/CreatureData.h CreatureFlightMovementType */
export const CreatureFlightMovementType = { None: 0, DisableGravity: 1, CanFly: 2, Max: 3 } as const;
/** @ac game/Entities/Creature/CreatureData.h CreatureChaseMovementType */
export const CreatureChaseMovementType = { Run: 0, CanWalk: 1, AlwaysWalk: 2, Max: 3 } as const;
/** @ac game/Entities/Creature/CreatureData.h CreatureRandomMovementType */
export const CreatureRandomMovementType = { Walk: 0, CanRun: 1, AlwaysRun: 2, Max: 3 } as const;

/** @ac game/Entities/Creature/CreatureData.h CreatureMovementData */
export class CreatureMovementData {
  Ground: number = CreatureGroundMovementType.Run;
  Flight: number = CreatureFlightMovementType.None;
  Swim = true;
  Rooted = false;
  Chase: number = CreatureChaseMovementType.Run;
  Random: number = CreatureRandomMovementType.Walk;
  InteractionPauseTimer: number;

  /** @ac game/Entities/Creature/Creature.cpp CreatureMovementData::CreatureMovementData */
  constructor() {
    this.InteractionPauseTimer = sWorld().getIntConfig(ServerConfig.CONFIG_CREATURE_STOP_FOR_PLAYER);
  }

  /** @ac game/Entities/Creature/CreatureData.h CreatureMovementData::IsGroundAllowed */
  isGroundAllowed(): boolean {
    return this.Ground !== CreatureGroundMovementType.None;
  }

  /** @ac game/Entities/Creature/CreatureData.h CreatureMovementData::IsSwimAllowed */
  isSwimAllowed(): boolean {
    return this.Swim;
  }

  /** @ac game/Entities/Creature/CreatureData.h CreatureMovementData::IsFlightAllowed */
  isFlightAllowed(): boolean {
    return this.Flight !== CreatureFlightMovementType.None;
  }

  /** @ac game/Entities/Creature/CreatureData.h CreatureMovementData::IsRooted */
  isRooted(): boolean {
    return this.Rooted;
  }

  /** @ac game/Entities/Creature/CreatureData.h CreatureMovementData::GetChase */
  getChase(): number {
    return this.Chase;
  }

  /** @ac game/Entities/Creature/CreatureData.h CreatureMovementData::GetRandom */
  getRandom(): number {
    return this.Random;
  }

  /** @ac game/Entities/Creature/CreatureData.h CreatureMovementData::GetInteractionPauseTimer */
  getInteractionPauseTimer(): number {
    return this.InteractionPauseTimer;
  }

  /** @ac game/Entities/Creature/Creature.cpp CreatureMovementData::ToString */
  toString(): string {
    const GroundStates = ["None", "Run", "Hover"];
    const FlightStates = ["None", "DisableGravity", "CanFly"];
    const ChaseStates = ["Run", "CanWalk", "AlwaysWalk"];
    const RandomStates = ["Walk", "CanRun", "AlwaysRun"];
    return (
      `Ground: ${GroundStates[this.Ground]}, Swim: ${this.Swim}, Flight: ${FlightStates[this.Flight]}, ` +
      `Chase: ${ChaseStates[this.Chase]}, Random: ${RandomStates[this.Random]}${this.Rooted ? ", Rooted" : ""}, ` +
      `InteractionPauseTimer: ${this.InteractionPauseTimer}`
    );
  }
}
