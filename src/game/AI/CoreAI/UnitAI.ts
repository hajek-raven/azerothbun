/**
 * Port of the part of `game/AI/CoreAI/UnitAI.{h,cpp}` the movement code reaches: the default (empty) movement hooks of `UnitAI`
 * and `UnitAI::AttackStart`.
 *
 * @ac-skip AI: `UnitAI::DoMeleeAttackIfReady`, `SelectTarget*`, `DoCast*`, `UpdateAI` and the rest: the combat world
 * (`src/combat/combat-world.ts`) runs the creature melee, threat and spells; no scripted AI exists.
 */
import type { MovementOwner } from "../../Movement/MovementOwner.ts";
import type { Creature } from "../../Entities/Creature/Creature.ts";

/** @ac game/AI/CoreAI/UnitAI.h UnitAI */
export class UnitAI {
  /** @ac game/AI/CoreAI/UnitAI.h UnitAI::me */
  protected readonly me: Creature;

  /** @ac game/AI/CoreAI/UnitAI.h UnitAI::UnitAI */
  constructor(unit: Creature) {
    this.me = unit;
  }

  /** @ac game/AI/CoreAI/UnitAI.cpp UnitAI::AttackStart */
  AttackStart(victim: MovementOwner | null): void {
    if (victim && this.me.attack(victim, true)) this.me.getMotionMaster().moveChase(victim);
  }

  /** @ac game/AI/CoreAI/UnitAI.cpp UnitAI::AttackStartCaster */
  AttackStartCaster(victim: MovementOwner | null, dist: number): void {
    if (victim && this.me.attack(victim, false)) this.me.getMotionMaster().moveChase(victim, dist);
  }

  /** @ac game/AI/CoreAI/UnitAI.h UnitAI::MovementInform (an empty virtual) */
  MovementInform(_type: number, _id: number): void {}

  /** @ac game/AI/CoreAI/UnitAI.h UnitAI::SummonMovementInform */
  SummonMovementInform(_creature: MovementOwner, _type: number, _id: number): void {}

  /** @ac game/AI/CoreAI/UnitAI.h UnitAI::OnDespawn */
  OnDespawn(): void {}

  /** @ac game/AI/CoreAI/UnitAI.h UnitAI::InitializeAI */
  InitializeAI(): void {}

  /** @ac game/AI/CoreAI/UnitAI.h UnitAI::Reset */
  Reset(): void {}
}
