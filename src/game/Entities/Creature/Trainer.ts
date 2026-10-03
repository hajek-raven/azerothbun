/**
 * `Trainer.cpp`: the `trainer` / `trainer_spell` rows and which spells a trainer can teach a player. The trainer NPC
 * window (`SMSG_TRAINER_LIST`, `CMSG_TRAINER_BUY_SPELL`) is not ported; `.learn all my trainer` uses these rules.
 */
import { trainer, trainer_spell } from "../../../database/schema/world.ts";
import type { WorldTables } from "../../../database/world-tables.ts";
import { SPELL_EFFECT_LEARN_SPELL, SPELL_EFFECT_SKILL } from "../../../spells/defines.ts";
import type { SpellInfo } from "../../../spells/spell-info.ts";
import { sSkillLineStore } from "../../DataStores/DBCStores.ts";
import { sSpellMgr } from "../../Spells/SpellMgr.ts";
import type { Player } from "../Player/Player.ts";

const SKILL_CATEGORY_PROFESSION = 11;

/** @ac game/Entities/Creature/Trainer.h Trainer::Type */
export const TrainerType = { Class: 0, Mount: 1, Tradeskill: 2, Pet: 3 } as const;

/** @ac game/Entities/Creature/Trainer.h Trainer::SpellState */
export const SpellState = { Available: 0, Unavailable: 1, Known: 2 } as const;

/** @ac game/Entities/Creature/Trainer.h Trainer::Spell */
export class TrainerSpell {
  constructor(
    readonly SpellId: number,
    readonly MoneyCost: number,
    readonly ReqSkillLine: number,
    readonly ReqSkillRank: number,
    readonly ReqAbility: readonly [number, number, number],
    readonly ReqLevel: number,
  ) {}

  /** @ac game/Entities/Creature/Trainer.cpp Trainer::Spell::IsCastable */
  IsCastable(): boolean {
    return sSpellMgr.getSpellInfo(this.SpellId)?.effects.some((effect) => effect.effect === SPELL_EFFECT_LEARN_SPELL) ?? false;
  }
}

/** @ac game/Spells/SpellMgr.cpp IsPrimaryProfessionSkill */
function IsPrimaryProfessionSkill(skill: number): boolean {
  const pSkill = sSkillLineStore.lookupEntry(skill);
  return pSkill !== null && pSkill.categoryId === SKILL_CATEGORY_PROFESSION;
}

/** @ac game/Spells/SpellInfo.cpp SpellInfo::IsPrimaryProfessionFirstRank */
function IsPrimaryProfessionFirstRank(info: SpellInfo): boolean {
  const primary = info.effects.some((effect) => effect.effect === SPELL_EFFECT_SKILL && IsPrimaryProfessionSkill(effect.miscValue));
  return primary && sSpellMgr.getSpellRank(info.id) === 1;
}

/** @ac game/Entities/Creature/Trainer.h Trainer::Trainer */
export class Trainer {
  constructor(
    readonly trainerId: number,
    readonly type: number,
    readonly requirement: number,
    readonly spells: readonly TrainerSpell[],
  ) {}

  GetSpells(): readonly TrainerSpell[] {
    return this.spells;
  }

  /** @ac game/Entities/Creature/Trainer.cpp Trainer::CanTeachSpell */
  CanTeachSpell(player: Player, trainerSpell: TrainerSpell): boolean {
    if (this.GetSpellState(player, trainerSpell) !== SpellState.Available) return false;
    const trainerSpellInfo = sSpellMgr.getSpellInfo(trainerSpell.SpellId);
    for (const effect of trainerSpellInfo?.effects ?? []) {
      if (effect.effect !== SPELL_EFFECT_LEARN_SPELL) continue;
      const learnedSpellInfo = sSpellMgr.getSpellInfo(effect.triggerSpell);
      if (learnedSpellInfo && IsPrimaryProfessionFirstRank(learnedSpellInfo) && !player.getFreePrimaryProfessionPoints()) return false;
    }
    return true;
  }

  /** @ac game/Entities/Creature/Trainer.cpp Trainer::GetSpellState */
  GetSpellState(player: Player, trainerSpell: TrainerSpell): number {
    if (player.hasSpell(trainerSpell.SpellId)) return SpellState.Known;
    // check race/class requirement
    if (!player.isSpellFitByClassAndRace(trainerSpell.SpellId)) return SpellState.Unavailable;
    // check skill requirement
    if (trainerSpell.ReqSkillLine && player.getPureSkillValue(trainerSpell.ReqSkillLine) < trainerSpell.ReqSkillRank) return SpellState.Unavailable;
    for (const reqAbility of trainerSpell.ReqAbility) if (reqAbility && !player.hasSpell(reqAbility)) return SpellState.Unavailable;
    // check level requirement
    if (player.getLevel() < trainerSpell.ReqLevel) return SpellState.Unavailable;
    // check ranks
    let hasLearnSpellEffect = false;
    let knowsAllLearnedSpells = true;
    for (const effect of sSpellMgr.getSpellInfo(trainerSpell.SpellId)?.effects ?? []) {
      if (effect.effect !== SPELL_EFFECT_LEARN_SPELL) continue;
      hasLearnSpellEffect = true;
      if (!player.hasSpell(effect.triggerSpell)) knowsAllLearnedSpells = false;
      const previousRankSpellId = sSpellMgr.getPrevSpellInChain(effect.triggerSpell);
      if (previousRankSpellId && !player.hasSpell(previousRankSpellId)) return SpellState.Unavailable;
    }
    if (!hasLearnSpellEffect) {
      const previousRankSpellId = sSpellMgr.getPrevSpellInChain(trainerSpell.SpellId);
      if (previousRankSpellId && !player.hasSpell(previousRankSpellId)) return SpellState.Unavailable;
    } else if (knowsAllLearnedSpells) {
      return SpellState.Known;
    }
    // check additional spell requirement
    for (const required of sSpellMgr.spellStore()?.worldData.required(trainerSpell.SpellId) ?? []) {
      if (!player.hasSpell(required)) return SpellState.Unavailable;
    }
    return SpellState.Available;
  }

  /** @ac game/Entities/Creature/Trainer.cpp Trainer::IsTrainerValidForPlayer */
  IsTrainerValidForPlayer(player: Player): boolean {
    if (!this.requirement) return true;
    switch (this.type) {
      case TrainerType.Class:
      case TrainerType.Pet:
        // check class for class trainers
        return player.getClass() === this.requirement;
      case TrainerType.Mount:
        // check race for mount trainers
        return player.getRace() === this.requirement;
      case TrainerType.Tradeskill:
        // check spell for profession trainers
        return player.hasSpell(this.requirement);
      default:
        return true;
    }
  }
}

/** @ac game/Globals/ObjectMgr.cpp ObjectMgr::LoadTrainers (`_trainers` and `_classTrainers`) */
export function LoadTrainers(world: WorldTables): { trainers: Map<number, Trainer>; classTrainers: Map<number, Trainer[]> } {
  const spellsByTrainer = new Map<number, TrainerSpell[]>();
  for (const row of world.all(trainer_spell)) {
    if (!sSpellMgr.getSpellInfo(row.SpellId)) continue;
    const list = spellsByTrainer.get(row.TrainerId) ?? [];
    list.push(new TrainerSpell(row.SpellId, row.MoneyCost, row.ReqSkillLine, row.ReqSkillRank, [row.ReqAbility1, row.ReqAbility2, row.ReqAbility3], row.ReqLevel));
    spellsByTrainer.set(row.TrainerId, list);
  }
  const trainers = new Map<number, Trainer>();
  const classTrainers = new Map<number, Trainer[]>();
  for (const row of world.all(trainer)) {
    const created = new Trainer(row.Id, row.Type, row.Requirement, spellsByTrainer.get(row.Id) ?? []);
    trainers.set(row.Id, created);
    if (row.Type === TrainerType.Class) {
      const list = classTrainers.get(row.Requirement) ?? [];
      list.push(created);
      classTrainers.set(row.Requirement, list);
    }
  }
  return { trainers, classTrainers };
}
