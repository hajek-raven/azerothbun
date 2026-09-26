import type { DbcRecord, DbcStores } from "../data/dbc.ts";

export type DbcCharacterStart = {
  spells: number[];
  skills: { skill: number; value: number; max: number }[];
  factions: { faction: number; standing: number; flags: number; listId: number }[];
  items: number[];
};

/** SkillLineAbility.AcquireMethod — AbilytyLearnType in DBCEnums.h */
export const SKILL_LINE_ABILITY_LEARNED_ON_SKILL_VALUE = 1;
export const SKILL_LINE_ABILITY_LEARNED_ON_SKILL_LEARN = 2;

const SKILL_RUNEFORGING = 776;

function maskMatches(mask: number, id: number): boolean {
  return mask === 0 || (mask & (1 << (id - 1))) !== 0;
}

function num(record: DbcRecord, key: string): number {
  const value = record[key];
  return typeof value === "number" ? value : 0;
}

function findSkillRaceClassInfo(
  stores: DbcStores,
  skill: number,
  race: number,
  classId: number,
): DbcRecord | undefined {
  for (const row of stores.skillRaceClassInfo) {
    if (num(row, "SkillID") !== skill) {
      continue;
    }
    if (!maskMatches(num(row, "RaceMask"), race)) {
      continue;
    }
    if (!maskMatches(num(row, "ClassMask"), classId)) {
      continue;
    }
    return row;
  }
  return undefined;
}

function skillMaxForRow(rcInfo: DbcRecord, level: number): number {
  const skillId = num(rcInfo, "SkillID");
  // Without SkillLine.dbc, mirror GetSkillRangeType for the cases we can see:
  // runeforging is mono; SkillTierID implies rank (treat max like level skills for now);
  // everything else is a level skill: max = level * 5.
  if (skillId === SKILL_RUNEFORGING) {
    return 1;
  }
  return level * 5;
}

function factionBaseStanding(faction: DbcRecord, race: number, classId: number): number {
  const raceMask = 1 << (race - 1);
  const classMask = 1 << (classId - 1);
  for (let i = 0; i < 4; i += 1) {
    const baseRace = num(faction, `BaseRepRaceMask${i}`);
    const baseClass = num(faction, `BaseRepClassMask${i}`);
    if (
      ((baseRace & raceMask) !== 0 || (baseRace === 0 && baseClass !== 0)) &&
      ((baseClass & classMask) !== 0 || baseClass === 0)
    ) {
      return num(faction, `BaseRepValue${i}`);
    }
  }
  return 0;
}

function factionDefaultFlags(faction: DbcRecord, race: number, classId: number): number {
  const raceMask = 1 << (race - 1);
  const classMask = 1 << (classId - 1);
  for (let i = 0; i < 4; i += 1) {
    const baseRace = num(faction, `BaseRepRaceMask${i}`);
    const baseClass = num(faction, `BaseRepClassMask${i}`);
    if (
      ((baseRace & raceMask) !== 0 || (baseRace === 0 && baseClass !== 0)) &&
      ((baseClass & classMask) !== 0 || baseClass === 0)
    ) {
      return num(faction, `ReputationFlags${i}`);
    }
  }
  return 0;
}

function learnSpellsForSkill(
  stores: DbcStores,
  skillId: number,
  skillValue: number,
  race: number,
  classId: number,
  into: Set<number>,
): void {
  const raceMask = 1 << (race - 1);
  const classMask = 1 << (classId - 1);
  const abilities = stores.skillLineAbilities
    .filter((row) => num(row, "SkillLine") === skillId)
    .slice()
    .sort((a, b) => num(a, "MinSkillLineRank") - num(b, "MinSkillLineRank"));

  for (const ability of abilities) {
    const acquire = num(ability, "AcquireMethod");
    if (
      acquire !== SKILL_LINE_ABILITY_LEARNED_ON_SKILL_VALUE &&
      acquire !== SKILL_LINE_ABILITY_LEARNED_ON_SKILL_LEARN
    ) {
      continue;
    }
    const abilityRace = num(ability, "RaceMask");
    if (abilityRace !== 0 && (abilityRace & raceMask) === 0) {
      continue;
    }
    const abilityClass = num(ability, "ClassMask");
    if (abilityClass !== 0 && (abilityClass & classMask) === 0) {
      continue;
    }
    if (acquire === SKILL_LINE_ABILITY_LEARNED_ON_SKILL_VALUE && skillValue < num(ability, "MinSkillLineRank")) {
      continue;
    }
    const spellId = num(ability, "Spell");
    if (!stores.spells.has(spellId)) {
      continue;
    }
    const supercededBy = num(ability, "SupercededBySpell");
    if (acquire === SKILL_LINE_ABILITY_LEARNED_ON_SKILL_LEARN && supercededBy !== 0) {
      let skipCurrent = false;
      for (const other of stores.skillLineAbilities) {
        if (num(other, "Spell") !== supercededBy) {
          continue;
        }
        if (num(other, "AcquireMethod") !== SKILL_LINE_ABILITY_LEARNED_ON_SKILL_LEARN) {
          continue;
        }
        if (skillValue >= num(other, "MinSkillLineRank")) {
          skipCurrent = true;
          break;
        }
      }
      if (skipCurrent) {
        continue;
      }
    }
    into.add(spellId);
  }
}

export function characterStartFromDbc(
  stores: DbcStores,
  race: number,
  classId: number,
  gender: number,
  level: number,
  knownSkills: readonly { skill: number; value: number; max: number }[],
): DbcCharacterStart {
  const skills: { skill: number; value: number; max: number }[] = [];
  for (const known of knownSkills) {
    const rcInfo = findSkillRaceClassInfo(stores, known.skill, race, classId);
    if (!rcInfo) {
      continue;
    }
    const max = skillMaxForRow(rcInfo, level);
    const value = Math.max(known.value, 1);
    skills.push({ skill: known.skill, value, max });
  }

  const spellSet = new Set<number>();
  for (const skill of skills) {
    learnSpellsForSkill(stores, skill.skill, skill.value, race, classId, spellSet);
  }
  const spells = [...spellSet].sort((a, b) => a - b);

  const factions: DbcCharacterStart["factions"] = [];
  for (const faction of stores.factions) {
    const listId = num(faction, "reputationListID");
    if (listId < 0) {
      continue;
    }
    factions.push({
      faction: num(faction, "ID"),
      standing: factionBaseStanding(faction, race, classId),
      flags: factionDefaultFlags(faction, race, classId),
      listId,
    });
  }
  factions.sort((a, b) => a.listId - b.listId);

  const outfitKey = race | (classId << 8) | (gender << 16);
  const items: number[] = [];
  for (const outfit of stores.charStartOutfits) {
    const key = num(outfit, "Race") | (num(outfit, "Class") << 8) | (num(outfit, "Gender") << 16);
    if (key !== outfitKey) {
      continue;
    }
    for (let i = 0; i < 24; i += 1) {
      const itemId = num(outfit, `ItemId${i}`);
      if (itemId > 0) {
        items.push(itemId);
      }
    }
    break;
  }

  return { spells, skills, factions, items };
}
