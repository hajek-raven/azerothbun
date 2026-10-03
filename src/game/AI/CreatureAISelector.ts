/**
 * Port of the movement part of `game/AI/CreatureAISelector.{h,cpp}`: `FactorySelector::SelectMovementGenerator`, which
 * `MotionMaster::InitDefault` calls to pick the default (idle slot) generator of a unit.
 *
 * @ac-skip AI: `SelectAI` and `SelectGameObjectAI` (the AI factories are not ported).
 */
import { sMovementGeneratorRegistry, type MovementGenerator } from "../Movement/MovementGenerator.ts";
import { IDLE_MOTION_TYPE, type MovementGeneratorType } from "../Movement/MotionMaster.ts";
import type { MovementOwner } from "../Movement/MovementOwner.ts";

/** @ac game/AI/CreatureAISelector.cpp FactorySelector::SelectMovementGenerator */
export function SelectMovementGenerator(unit: MovementOwner): MovementGenerator {
  let type: MovementGeneratorType = IDLE_MOTION_TYPE;
  const creature = unit.toCreature();
  if (creature) if (!creature.getCharmerOrOwnerPlayerOrPlayerItself()) type = creature.getDefaultMovementType() as MovementGeneratorType;

  const mv_factory = sMovementGeneratorRegistry.getRegistryItem(type);
  if (!mv_factory) throw new Error(`FactorySelector::SelectMovementGenerator: no movement generator registered for type ${type}`);
  return mv_factory.create(unit);
}
