/**
 * Port of `game/AI/CoreAI/ReactorAI.{h,cpp}`: the AI of creatures that react to attacks (the default AI of this server).
 *
 * @ac-skip AI: `ReactorAI::UpdateAI` (`UpdateVictim` + `DoMeleeAttackIfReady`) is the combat world's per-creature update.
 * `FactorySelector::SelectAI` is not ported: every creature gets a `ReactorAI`.
 */
import type { Creature } from "../../Entities/Creature/Creature.ts";
import { CreatureAI } from "../CreatureAI.ts";

/** @ac game/AI/CoreAI/ReactorAI.h ReactorAI */
export class ReactorAI extends CreatureAI {
  /** @ac game/AI/CoreAI/ReactorAI.h ReactorAI::ReactorAI */
  constructor(creature: Creature) {
    super(creature);
  }

  /** @ac game/AI/CoreAI/ReactorAI.cpp ReactorAI::UpdateAI (@ac-skip AI: the combat world updates the victim and the melee swing) */
  UpdateAI(_diff: number): void {}
}
