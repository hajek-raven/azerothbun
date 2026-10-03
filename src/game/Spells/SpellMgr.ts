/** `sSpellMgr` for the command code: spell lookups over the loaded `SpellStore` and `SpellMgr::IsSpellValid`. */
import type { SpellInfo, SpellStore } from "../../spells/spell-info.ts";
import {
  SPELL_EFFECT_CREATE_ITEM,
  SPELL_EFFECT_CREATE_ITEM_2,
  SPELL_EFFECT_CREATE_RANDOM_ITEM,
  SPELL_EFFECT_DUAL_WIELD,
  SPELL_EFFECT_LEARN_SPELL,
  SPELL_EFFECT_SKILL,
} from "../../spells/defines.ts";
import { sSkillLineAbilityStore } from "../DataStores/DBCStores.ts";
import type { SkillLineAbilityEntry } from "../../gen/DBCStructure.gen.ts";

const SKILL_DUAL_WIELD = 118;
import { sObjectMgr } from "../Globals/ObjectMgr.ts";

export class SpellMgr {
  private store: SpellStore | null = null;
  private readonly valid = new Map<number, boolean>();

  setStore(store: SpellStore | null): void {
    this.store = store;
    this.valid.clear();
    this.learnSkills = null;
  }

  spellStore(): SpellStore | null {
    return this.store;
  }

  /** @ac game/Spells/SpellMgr.h SpellMgr::GetSpellInfo */
  getSpellInfo(spellId: number): SpellInfo | null {
    return this.store?.get(spellId) ?? null;
  }

  /** @ac game/Spells/SpellMgr.cpp SpellMgr::GetFirstSpellInChain */
  getFirstSpellInChain(spellId: number): number {
    return this.store?.worldData.firstRank(spellId) ?? spellId;
  }

  /** @ac game/Spells/SpellMgr.cpp SpellMgr::GetNextSpellInChain */
  getNextSpellInChain(spellId: number): number {
    const rank = this.store?.worldData.rank(spellId);
    if (!rank) return 0;
    return this.store?.worldData.withRank(spellId, rank.rank + 1) ?? 0;
  }

  /** @ac game/Spells/SpellMgr.cpp SpellMgr::GetPrevSpellInChain */
  getPrevSpellInChain(spellId: number): number {
    const rank = this.store?.worldData.rank(spellId);
    if (!rank || rank.rank <= 1) return 0;
    return this.store?.worldData.withRank(spellId, rank.rank - 1) ?? 0;
  }

  /** @ac game/Spells/SpellMgr.cpp SpellMgr::GetSpellRank */
  getSpellRank(spellId: number): number {
    return this.store?.worldData.rank(spellId)?.rank ?? 0;
  }

  private learnSkills: Map<number, { skill: number; step: number }> | null = null;
  private skillLineAbilities: Map<number, SkillLineAbilityEntry[]> | null = null;

  /** @ac game/Spells/SpellMgr.cpp SpellMgr::LoadSpellLearnSkills (`mSpellLearnSkills`: skill and step by spell) */
  private spellLearnSkills(): Map<number, { skill: number; step: number }> {
    if (!this.learnSkills) {
      this.learnSkills = new Map();
      for (const spell of this.spellIds()) {
        const entry = this.getSpellInfo(spell);
        if (!entry) continue;
        for (const effect of entry.effects) {
          if (effect.effect === SPELL_EFFECT_SKILL) this.learnSkills.set(spell, { skill: effect.miscValue, step: effect.basePoints + 1 });
          else if (effect.effect === SPELL_EFFECT_DUAL_WIELD) this.learnSkills.set(spell, { skill: SKILL_DUAL_WIELD, step: 1 });
          else continue;
          break;
        }
      }
    }
    return this.learnSkills;
  }

  /** @ac game/Spells/SpellMgr.cpp SpellMgr::GetSkillRankSpells */
  getSkillRankSpells(skillId: number): number[] {
    const learn = this.spellLearnSkills();
    return [...learn].filter(([, node]) => node.skill === skillId).sort((a, b) => a[1].step - b[1].step).map(([spellId]) => spellId);
  }

  /** @ac game/Spells/SpellMgr.h SpellMgr::GetSkillLineAbilityMapBounds */
  getSkillLineAbilityMapBounds(spellId: number): readonly SkillLineAbilityEntry[] {
    if (!this.skillLineAbilities) {
      this.skillLineAbilities = new Map();
      for (const entry of sSkillLineAbilityStore) {
        const list = this.skillLineAbilities.get(entry.Spell) ?? [];
        list.push(entry);
        this.skillLineAbilities.set(entry.Spell, list);
      }
    }
    return this.skillLineAbilities.get(spellId) ?? [];
  }

  /** @ac game/Spells/SpellInfo.cpp SpellInfo::IsAbilityOfSkillType */
  isAbilityOfSkillType(spellId: number, skillType: number): boolean {
    return this.getSkillLineAbilityMapBounds(spellId).some((entry) => entry.SkillLine === skillType);
  }

  /** Spell ids in `Spell.dbc` order (`sSpellMgr->GetSpellInfoStoreSize()` loops). */
  spellIds(): number[] {
    return this.store?.ids() ?? [];
  }

  /** @ac game/Spells/SpellMgr.cpp SpellMgr::IsSpellValid (`SpellInfo::_isSpellValid` set by `InitializeSpellInfoPrecomputedData`) */
  isSpellValid(info: SpellInfo | null): boolean {
    if (!info) return false;
    let result = this.valid.get(info.id);
    if (result === undefined) {
      result = this.computeIsSpellValid(info, new Set());
      this.valid.set(info.id, result);
    }
    return result;
  }

  /** @ac game/Spells/SpellMgr.cpp SpellMgr::ComputeIsSpellValid */
  private computeIsSpellValid(info: SpellInfo | null, visiting: Set<number>): boolean {
    if (!info) return false;
    if (visiting.has(info.id)) return true;
    visiting.add(info.id);
    let needCheckReagents = false;
    for (const effect of info.effects) {
      switch (effect.effect) {
        case 0:
          continue;
        case SPELL_EFFECT_CREATE_ITEM:
        case SPELL_EFFECT_CREATE_ITEM_2:
          if (effect.itemType === 0) {
            if (!isLootCrafting(info)) return false;
          } else if (!sObjectMgr.getItemTemplate(effect.itemType)) {
            return false;
          }
          needCheckReagents = true;
          break;
        case SPELL_EFFECT_LEARN_SPELL:
          if (!this.computeIsSpellValid(this.getSpellInfo(effect.triggerSpell), visiting)) return false;
          break;
      }
    }
    if (needCheckReagents) {
      for (const reagent of info.reagents) {
        if (reagent.item > 0 && !sObjectMgr.getItemTemplate(reagent.item)) return false;
      }
    }
    return true;
  }
}

/** @ac game/Spells/SpellInfo.cpp SpellInfo::IsLootCrafting */
export function isLootCrafting(info: SpellInfo): boolean {
  const first = info.effects[0];
  return (
    first.effect === SPELL_EFFECT_CREATE_RANDOM_ITEM ||
    (first.effect === SPELL_EFFECT_CREATE_ITEM_2 && (info.totemCategory[0] !== 0 || (info.totem[0] !== 0 && info.spellIconId === 1) || first.itemType === 0))
  );
}

export const sSpellMgr = new SpellMgr();
