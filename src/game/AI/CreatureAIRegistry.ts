/**
 * Port of the movement part of `game/AI/CreatureAIRegistry.cpp` (`AIRegistry::Initialize`): registers the movement
 * generator factories that `FactorySelector::SelectMovementGenerator` and `MotionMaster` look up. Call it once at startup,
 * before the first `MotionMaster::Initialize`; calling it again changes nothing.
 *
 * @ac-skip AI: the `CreatureAIFactory` / `GameObjectAIFactory` registrations (the AI classes are not ported).
 */
import { MovementGeneratorFactory } from "../Movement/MovementGenerator.ts";
import { IdleMovementFactory } from "../Movement/MovementGenerators/IdleMovementGenerator.ts";
import { RandomMovementGenerator } from "../Movement/MovementGenerators/RandomMovementGenerator.ts";
import { WaypointMovementGenerator } from "../Movement/MovementGenerators/WaypointMovementGenerator.ts";
import { sMovementGeneratorRegistry } from "../Movement/MovementGenerator.ts";
import { IDLE_MOTION_TYPE, RANDOM_MOTION_TYPE, WAYPOINT_MOTION_TYPE } from "../Movement/MotionMaster.ts";

/** @ac game/AI/CreatureAIRegistry.cpp AIRegistry::Initialize (the movement generator factories) */
export function AddMovementGeneratorFactories(): void {
  if (!sMovementGeneratorRegistry.hasItem(IDLE_MOTION_TYPE)) new IdleMovementFactory().registerSelf();
  if (!sMovementGeneratorRegistry.hasItem(RANDOM_MOTION_TYPE)) new MovementGeneratorFactory(RANDOM_MOTION_TYPE, RandomMovementGenerator).registerSelf();
  if (!sMovementGeneratorRegistry.hasItem(WAYPOINT_MOTION_TYPE)) new MovementGeneratorFactory(WAYPOINT_MOTION_TYPE, WaypointMovementGenerator).registerSelf();
}
