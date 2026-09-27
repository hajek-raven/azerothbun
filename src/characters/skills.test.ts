import { and, asc, eq } from "drizzle-orm";
import { testDatabase } from "../database/test-db.ts";
import { character_skills } from "../database/schema/characters.ts";
import { playercreateinfo_skills } from "../database/schema/world.ts";
import { WorldTables } from "../database/world-tables.ts";
import { describe, expect, test } from "bun:test";
import {
  buildSkillData,
  emptySkillData,
  type SkillData,
  type SkillLineAbilityEntry,
  type SkillLineEntry,
  type SkillRaceClassInfoEntry,
} from "../data/dbc-skills.ts";
import { ConfigMgr, ConfigSeverity, defaultConfigPolicy } from "../common/config.ts";
import { WorldConfig } from "../game/world/world-config.ts";
import {
  ACHIEVEMENT_CRITERIA_TYPE_LEARN_SKILL_LEVEL,
  ACHIEVEMENT_CRITERIA_TYPE_REACH_SKILL_LEVEL,
  BASE_ATTACK,
  ITEM_CLASS_ARMOR,
  ITEM_CLASS_WEAPON,
  ITEM_SUBCLASS_WEAPON_FISHING_POLE,
  ITEM_SUBCLASS_WEAPON_FIST,
  LANG_ADDON,
  LANG_COMMON,
  LANG_DESCRIPTION,
  LANG_GUTTERSPEAK,
  LANG_ORCISH,
  LANG_UNIVERSAL,
  LANG_ZOMBIE,
  OFF_ATTACK,
  PLAYER_MAX_SKILLS,
  PLAYER_SKILL_FIELD_COUNT,
  PLAYER_SKILL_INFO_1_1,
  PlayerSkills,
  SKILL_CHANGED,
  SKILL_DELETED,
  SKILL_NEW,
  SKILL_RANGE_LANGUAGE,
  SKILL_RANGE_LEVEL,
  SKILL_RANGE_MONO,
  SKILL_RANGE_NONE,
  SKILL_RANGE_RANK,
  SKILL_UNCHANGED,
  SkillType,
  canSpeakLanguage,
  configMaxSkillValue,
  craftSkillGainChance,
  DEFAULT_SKILL_CONFIG,
  fishingLevelUpProbability,
  getSkillRaceClassInfo,
  getSkillRangeType,
  grayLevel,
  isProfessionOrRidingSkill,
  itemSkill,
  languageDesc,
  languageSkill,
  loadPlayerCreateSkills,
  makePair32,
  playerCreateSkillsFor,
  skillConfigFromWorld,
  skillGainChance,
  spellChangesFromEvents,
  type SkillEvent,
  type SkillRandom,
} from "./skills.ts";

const S = SkillType;
const HUMAN = 1;
const ORC = 2;
const WARRIOR = 1;
const PALADIN = 2;
const DEATH_KNIGHT = 6;
const TIER_PROFESSION = 10;

function line(id: number, categoryId: number): [number, SkillLineEntry] {
  return [id, { id, categoryId, name: `skill ${id}`, spellIcon: 0, canLink: 0 }];
}

let rcId = 1;
function rc(skillId: number, extra: Partial<SkillRaceClassInfoEntry> = {}): SkillRaceClassInfoEntry {
  return { id: rcId++, skillId, raceMask: 0, classMask: 0, flags: 0, skillTierId: 0, ...extra };
}

let abilityId = 1;
function ability(skillLine: number, spell: number, extra: Partial<SkillLineAbilityEntry> = {}): SkillLineAbilityEntry {
  return {
    id: abilityId++,
    skillLine,
    spell,
    raceMask: 0,
    classMask: 0,
    minSkillLineRank: 0,
    supercededBySpell: 0,
    acquireMethod: 0,
    trivialSkillLineRankHigh: 0,
    trivialSkillLineRankLow: 0,
    ...extra,
  };
}

function testData(): SkillData {
  const abilities = [
    ability(S.SKILL_SWORDS, 201, { acquireMethod: 2 }),
    ability(S.SKILL_BLACKSMITHING, 2018, { acquireMethod: 1, minSkillLineRank: 1 }),
    ability(S.SKILL_BLACKSMITHING, 3100, { acquireMethod: 1, minSkillLineRank: 75 }),
    ability(S.SKILL_BLACKSMITHING, 9999, { acquireMethod: 0 }),
    ability(S.SKILL_BLACKSMITHING, 7777, { acquireMethod: 1, minSkillLineRank: 1, raceMask: 1 << (ORC - 1) }),
    ability(S.SKILL_BLACKSMITHING, 6666, { acquireMethod: 1, minSkillLineRank: 1 }), // spell not in Spell.dbc
    ability(S.SKILL_BLACKSMITHING, 2660, { acquireMethod: 2, minSkillLineRank: 1, trivialSkillLineRankHigh: 45, trivialSkillLineRankLow: 15 }),
    // Seal-of-Righteousness style: 5000 is superseded by 5001 once skill >= 50
    ability(S.SKILL_RETRIBUTION, 5000, { acquireMethod: 2, supercededBySpell: 5001 }),
    ability(S.SKILL_RETRIBUTION, 5001, { acquireMethod: 2, minSkillLineRank: 50 }),
  ];
  return buildSkillData({
    skillLines: new Map([
      line(S.SKILL_DEFENSE, 6),
      line(S.SKILL_UNARMED, 6),
      line(S.SKILL_FIST_WEAPONS, 6),
      line(S.SKILL_SWORDS, 6),
      line(S.SKILL_DAGGERS, 6),
      line(S.SKILL_LANG_COMMON, 10),
      line(S.SKILL_LANG_ORCISH, 10),
      line(S.SKILL_CLOTH, 8),
      line(S.SKILL_RUNEFORGING, 7),
      line(S.SKILL_BLACKSMITHING, 11),
      line(S.SKILL_HERBALISM, 11),
      line(S.SKILL_MINING, 11),
      line(S.SKILL_SKINNING, 11),
      line(S.SKILL_FISHING, 9),
      line(S.SKILL_RIDING, 9),
      line(S.SKILL_RACIAL_HUMAN, 7),
      line(S.SKILL_RETRIBUTION, 7),
      line(S.SKILL_LOCKPICKING, 7),
    ]),
    skillTiers: new Map([[TIER_PROFESSION, { id: TIER_PROFESSION, value: [75, 150, 225, 300, 375, 450, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] }]]),
    skillRaceClassInfo: [
      rc(S.SKILL_DEFENSE),
      rc(S.SKILL_UNARMED),
      rc(S.SKILL_FIST_WEAPONS),
      rc(S.SKILL_SWORDS, { classMask: (1 << (WARRIOR - 1)) | (1 << (PALADIN - 1)) | (1 << (DEATH_KNIGHT - 1)) }),
      rc(S.SKILL_DAGGERS),
      rc(S.SKILL_LANG_COMMON, { raceMask: 1 << (HUMAN - 1) }),
      rc(S.SKILL_LANG_ORCISH, { raceMask: 1 << (ORC - 1) }),
      rc(S.SKILL_CLOTH),
      rc(S.SKILL_RUNEFORGING, { classMask: 1 << (DEATH_KNIGHT - 1) }),
      rc(S.SKILL_BLACKSMITHING, { skillTierId: TIER_PROFESSION }),
      rc(S.SKILL_HERBALISM, { skillTierId: TIER_PROFESSION }),
      rc(S.SKILL_MINING, { skillTierId: TIER_PROFESSION }),
      rc(S.SKILL_SKINNING, { skillTierId: TIER_PROFESSION }),
      rc(S.SKILL_FISHING, { skillTierId: TIER_PROFESSION }),
      rc(S.SKILL_RIDING, { skillTierId: TIER_PROFESSION }),
      rc(S.SKILL_RACIAL_HUMAN, { raceMask: 1 << (HUMAN - 1), flags: 0x10 }),
      rc(S.SKILL_RETRIBUTION, { classMask: 1 << (PALADIN - 1) }),
      rc(S.SKILL_LOCKPICKING),
    ],
    skillLineAbilities: abilities,
    spells: new Set([201, 2018, 3100, 9999, 7777, 2660, 5000, 5001]),
  });
}

function fixedRandom(rolls: number[] = [], chances: boolean[] = []): SkillRandom & { chances: number[]; irands: number[][] } {
  const seenChances: number[] = [];
  const irands: number[][] = [];
  return {
    chances: seenChances,
    irands,
    irand(min: number, max: number) {
      irands.push([min, max]);
      return rolls.shift() ?? min;
    },
    rollChanceF(chance: number) {
      seenChances.push(chance);
      return chances.shift() ?? true;
    },
  };
}

function player(
  owner: Partial<{ race: number; classId: number; level: number }> = {},
  options: Partial<ConstructorParameters<typeof PlayerSkills>[1]> = {},
): PlayerSkills {
  return new PlayerSkills(
    { race: owner.race ?? HUMAN, classId: owner.classId ?? WARRIOR, level: owner.level ?? 10 },
    { data: options.data ?? testData(), ...options },
  );
}

function ofType<T extends SkillEvent["type"]>(events: SkillEvent[], type: T): Extract<SkillEvent, { type: T }>[] {
  return events.filter((event): event is Extract<SkillEvent, { type: T }> => event.type === type);
}

describe("SetSkill", () => {
  test("adding a skill takes the first free slot and writes the three fields", () => {
    const skills = player();
    skills.setSkill(S.SKILL_SWORDS, 0, 1, 50);
    const fields = skills.fieldValues();
    expect(fields).toHaveLength(PLAYER_SKILL_FIELD_COUNT);
    expect(fields[0]).toBe(makePair32(S.SKILL_SWORDS, 0));
    expect(fields[1]).toBe(makePair32(1, 50));
    expect(fields[2]).toBe(0);
    expect(skills.statusMap().get(S.SKILL_SWORDS)).toEqual({ pos: 0, uState: SKILL_NEW });
    expect(skills.flushChangedFields()).toEqual([0, 1]);

    const events = skills.drainEvents();
    expect(events).toEqual([
      { type: "skillEnchantments", skill: S.SKILL_SWORDS, oldValue: 0, newValue: 1 },
      { type: "applySkillAuras", skill: S.SKILL_SWORDS },
      { type: "learnSpell", skill: S.SKILL_SWORDS, spell: 201, inWorld: false },
      { type: "achievementCriteria", criteriaType: ACHIEVEMENT_CRITERIA_TYPE_REACH_SKILL_LEVEL, skill: S.SKILL_SWORDS },
      { type: "achievementCriteria", criteriaType: ACHIEVEMENT_CRITERIA_TYPE_LEARN_SKILL_LEVEL, skill: S.SKILL_SWORDS },
    ]);
    expect(skills.drainEvents()).toEqual([]);

    skills.setSkill(S.SKILL_DAGGERS, 3, 5, 50);
    expect(skills.statusMap().get(S.SKILL_DAGGERS)?.pos).toBe(1);
    expect(skills.getSkillStep(S.SKILL_DAGGERS)).toBe(3);
  });

  test("id 0 and unknown skill lines are ignored", () => {
    const skills = player();
    skills.setSkill(0, 0, 1, 1);
    skills.setSkill(4242, 0, 1, 1);
    expect(skills.rows()).toEqual([]);
    expect(skills.drainEvents()).toEqual([]);
  });

  test("updating an existing skill marks it CHANGED unless NEW; enchant hook order follows direction", () => {
    const skills = player();
    skills.load([{ skill: S.SKILL_SWORDS, value: 20, max: 50 }]);
    skills.drainEvents();
    skills.setSkill(S.SKILL_SWORDS, 0, 30, 50);
    expect(skills.statusMap().get(S.SKILL_SWORDS)?.uState).toBe(SKILL_CHANGED);
    let events = skills.drainEvents();
    expect(events[0]?.type).toBe("learnSpell");
    expect(events[1]).toEqual({ type: "skillEnchantments", skill: S.SKILL_SWORDS, oldValue: 20, newValue: 30 });

    skills.setSkill(S.SKILL_SWORDS, 0, 10, 50);
    events = skills.drainEvents();
    expect(events[0]).toEqual({ type: "skillEnchantments", skill: S.SKILL_SWORDS, oldValue: 30, newValue: 10 });
    expect(events.filter((e) => e.type === "skillEnchantments")).toHaveLength(1);

    const fresh = player();
    fresh.setSkill(S.SKILL_SWORDS, 0, 1, 50);
    fresh.setSkill(S.SKILL_SWORDS, 0, 2, 50);
    expect(fresh.statusMap().get(S.SKILL_SWORDS)?.uState).toBe(SKILL_NEW);
  });

  test("value 0 removes: NEW is erased, saved skills become DELETED; fields cleared; ability spells removed", () => {
    const skills = player({}, { firstSpellInChain: (spell) => (spell === 3100 ? 3000 : spell) });
    skills.setSkill(S.SKILL_DAGGERS, 0, 1, 50);
    skills.setSkill(S.SKILL_DAGGERS, 0, 0, 0);
    expect(skills.statusMap().has(S.SKILL_DAGGERS)).toBe(false);

    skills.load([{ skill: S.SKILL_BLACKSMITHING, value: 80, max: 150 }]);
    skills.modifySkillBonus(S.SKILL_BLACKSMITHING, 5, false);
    skills.drainEvents();
    skills.flushChangedFields();
    skills.setSkill(S.SKILL_BLACKSMITHING, 0, 0, 0);
    expect(skills.statusMap().get(S.SKILL_BLACKSMITHING)?.uState).toBe(SKILL_DELETED);
    expect(skills.hasSkill(S.SKILL_BLACKSMITHING)).toBe(false);
    expect(skills.getSkillValue(S.SKILL_BLACKSMITHING)).toBe(0);
    expect([...skills.fieldValues().subarray(0, 3)]).toEqual([0, 0, 0]);
    expect(skills.flushChangedFields()).toEqual([0, 1, 2]);

    const events = skills.drainEvents();
    expect(events[0]).toEqual({ type: "skillEnchantments", skill: S.SKILL_BLACKSMITHING, oldValue: 80, newValue: 0 });
    // every SkillLineAbility of the skill, no race/class/acquire filter
    expect(ofType(events, "removeSpell").map((e) => e.spell)).toEqual([2018, 3000, 9999, 7777, 6666, 2660]);
    expect(ofType(events, "removeAuras").map((e) => e.spell)).toEqual([2018, 3100, 9999, 7777, 6666, 2660]);
  });

  test("re-adding a DELETED skill reuses the status entry as CHANGED in the first free slot", () => {
    const skills = player();
    skills.load([
      { skill: S.SKILL_DAGGERS, value: 5, max: 50 },
      { skill: S.SKILL_SWORDS, value: 5, max: 50 },
    ]);
    skills.setSkill(S.SKILL_DAGGERS, 0, 0, 0);
    skills.setSkill(S.SKILL_DEFENSE, 0, 1, 50);
    expect(skills.statusMap().get(S.SKILL_DEFENSE)).toEqual({ pos: 0, uState: SKILL_NEW });
    skills.setSkill(S.SKILL_DAGGERS, 0, 7, 50);
    expect(skills.statusMap().get(S.SKILL_DAGGERS)).toEqual({ pos: 2, uState: SKILL_CHANGED });
    expect(skills.getSkillValue(S.SKILL_DAGGERS)).toBe(7);
  });

  test("no more than PLAYER_MAX_SKILLS slots are used", () => {
    const skills = player({}, { data: emptySkillData() });
    for (let i = 0; i < PLAYER_MAX_SKILLS; i += 1) {
      skills.setSkill(1000 + i, 0, 1, 5);
    }
    skills.setSkill(5000, 0, 1, 5);
    expect(skills.hasSkill(5000)).toBe(false);
    expect(skills.rows()).toHaveLength(PLAYER_MAX_SKILLS);
    const fields = skills.fieldValues();
    expect([...fields.subarray(381, 384)]).toEqual([0, 0, 0]);
    skills.setSkill(1003, 0, 0, 0);
    skills.setSkill(5000, 0, 1, 5);
    expect(skills.statusMap().get(5000)?.pos).toBe(3);
  });
});

describe("getters and bonuses", () => {
  test("value, max, base, pure and step with temp and perm bonus", () => {
    const skills = player();
    skills.load([{ skill: S.SKILL_BLACKSMITHING, value: 100, max: 150 }]);
    skills.modifySkillBonus(S.SKILL_BLACKSMITHING, 10, false);
    skills.modifySkillBonus(S.SKILL_BLACKSMITHING, 15, true);
    expect(skills.getSkillTempBonusValue(S.SKILL_BLACKSMITHING)).toBe(10);
    expect(skills.getSkillPermBonusValue(S.SKILL_BLACKSMITHING)).toBe(15);
    expect(skills.getSkillValue(S.SKILL_BLACKSMITHING)).toBe(125);
    expect(skills.getMaxSkillValue(S.SKILL_BLACKSMITHING)).toBe(175);
    expect(skills.getBaseSkillValue(S.SKILL_BLACKSMITHING)).toBe(115);
    expect(skills.getPureSkillValue(S.SKILL_BLACKSMITHING)).toBe(100);
    expect(skills.getPureMaxSkillValue(S.SKILL_BLACKSMITHING)).toBe(150);
    expect(skills.fieldValues()[2]).toBe(makePair32(10, 15));
    expect(skills.getSkillStep(S.SKILL_BLACKSMITHING)).toBe(0);
  });

  test("negative bonuses are signed int16 and results clamp at 0", () => {
    const skills = player();
    skills.load([{ skill: S.SKILL_SWORDS, value: 5, max: 50 }]);
    skills.modifySkillBonus(S.SKILL_SWORDS, -20, false);
    expect(skills.getSkillTempBonusValue(S.SKILL_SWORDS)).toBe(-20);
    expect(skills.getSkillValue(S.SKILL_SWORDS)).toBe(0);
    expect(skills.getMaxSkillValue(S.SKILL_SWORDS)).toBe(30);
    skills.modifySkillBonus(S.SKILL_SWORDS, 20, false);
    expect(skills.getSkillTempBonusValue(S.SKILL_SWORDS)).toBe(0);
  });

  test("unknown skills and id 0 return 0 / false; bonus on unknown skill is ignored", () => {
    const skills = player();
    expect(skills.hasSkill(0)).toBe(false);
    expect(skills.getSkillValue(S.SKILL_SWORDS)).toBe(0);
    expect(skills.getMaxSkillValue(0)).toBe(0);
    skills.modifySkillBonus(S.SKILL_SWORDS, 5, true);
    expect(skills.changedFieldIndices()).toEqual([]);
  });

  test("base weapon skill uses the weapon's skill or unarmed for main hand", () => {
    const skills = player();
    skills.load([
      { skill: S.SKILL_UNARMED, value: 12, max: 50 },
      { skill: S.SKILL_DAGGERS, value: 30, max: 50 },
      { skill: S.SKILL_DEFENSE, value: 40, max: 50 },
    ]);
    expect(skills.getBaseWeaponSkillValue(BASE_ATTACK, null)).toBe(12);
    expect(skills.getBaseWeaponSkillValue(OFF_ATTACK, null)).toBe(0);
    expect(skills.getBaseWeaponSkillValue(OFF_ATTACK, { itemClass: ITEM_CLASS_WEAPON, subClass: 15 })).toBe(30);
    expect(skills.getBaseDefenseSkillValue()).toBe(40);
  });
});

describe("_LoadSkills", () => {
  test("applies range types, level max and tier step; learns rewarded spells after loading", () => {
    const skills = player({ level: 12 });
    const result = skills.load([
      { skill: S.SKILL_LANG_COMMON, value: 1, max: 1 },
      { skill: S.SKILL_CLOTH, value: 50, max: 60 },
      { skill: S.SKILL_SWORDS, value: 20, max: 25 },
      { skill: S.SKILL_BLACKSMITHING, value: 80, max: 75 },
      { skill: S.SKILL_HERBALISM, value: 80, max: 150 },
    ]);
    expect(result.zeroValueSkills).toEqual([]);
    expect(skills.rows()).toEqual([
      { skill: S.SKILL_LANG_COMMON, value: 300, max: 300 },
      { skill: S.SKILL_CLOTH, value: 1, max: 1 },
      { skill: S.SKILL_SWORDS, value: 20, max: 60 },
      { skill: S.SKILL_BLACKSMITHING, value: 80, max: 75 },
      { skill: S.SKILL_HERBALISM, value: 80, max: 150 },
    ]);
    // step: 1 only when tier Value[0] == max (the C++ always compares Value[0])
    expect(skills.getSkillStep(S.SKILL_BLACKSMITHING)).toBe(1);
    expect(skills.getSkillStep(S.SKILL_HERBALISM)).toBe(0);
    for (const skill of [S.SKILL_LANG_COMMON, S.SKILL_SWORDS]) {
      expect(skills.statusMap().get(skill)?.uState).toBe(SKILL_UNCHANGED);
    }
    expect(skills.changedFieldIndices().length).toBeGreaterThan(0);

    const events = skills.drainEvents();
    expect(events.every((e) => e.type === "learnSpell" || e.type === "unlearnSpell")).toBe(true);
    expect(ofType(events, "learnSpell").map((e) => e.spell)).toEqual([201, 2018, 2660, 3100]);
  });

  test("race/class-invalid skills are marked DELETED; zero values are reported", () => {
    const skills = player({ race: HUMAN, classId: WARRIOR });
    const result = skills.load([
      { skill: S.SKILL_LANG_ORCISH, value: 300, max: 300 },
      { skill: S.SKILL_DAGGERS, value: 0, max: 50 },
      { skill: S.SKILL_DEFENSE, value: 3, max: 50 },
    ]);
    expect(result.zeroValueSkills).toEqual([S.SKILL_DAGGERS]);
    expect(skills.statusMap().get(S.SKILL_LANG_ORCISH)).toEqual({ pos: 0, uState: SKILL_DELETED });
    expect(skills.hasSkill(S.SKILL_LANG_ORCISH)).toBe(false);
    expect(skills.statusMap().get(S.SKILL_DEFENSE)).toEqual({ pos: 0, uState: SKILL_UNCHANGED });
  });

  test("stops at PLAYER_MAX_SKILLS", () => {
    const skills = player({}, { data: emptySkillData() });
    const rows = Array.from({ length: 130 }, (_, i) => ({ skill: 1000 + i, value: 1, max: 1 }));
    skills.load(rows);
    expect(skills.rows()).toHaveLength(PLAYER_MAX_SKILLS);
  });

  test("reload resets previous state", () => {
    const skills = player();
    skills.setSkill(S.SKILL_SWORDS, 0, 1, 50);
    skills.load([{ skill: S.SKILL_DAGGERS, value: 1, max: 50 }]);
    expect(skills.hasSkill(S.SKILL_SWORDS)).toBe(false);
    expect(skills.statusMap().get(S.SKILL_DAGGERS)?.pos).toBe(0);
  });
});

describe("_SaveSkills", () => {
  type TestDb = Awaited<ReturnType<typeof testDatabase>>;

  function db(): Promise<TestDb> {
    return testDatabase("characters");
  }

  function stored(database: TestDb, guid: number) {
    return database
      .select({ skill: character_skills.skill, value: character_skills.value, max: character_skills.max })
      .from(character_skills)
      .where(eq(character_skills.guid, guid))
      .orderBy(asc(character_skills.skill));
  }

  function insert(database: TestDb, guid: number, skill: number, value: number, max: number) {
    return database.insert(character_skills).values({ guid, skill, value, max });
  }

  test("loadFromDb reads rows and deletes zero-value ones", async () => {
    const database = await db();
    await insert(database, 7, S.SKILL_DAGGERS, 0, 50);
    await insert(database, 7, S.SKILL_SWORDS, 12, 50);
    await insert(database, 8, S.SKILL_SWORDS, 99, 99);
    const skills = player({ level: 10 });
    expect((await skills.loadFromDb(database, 7)).zeroValueSkills).toEqual([S.SKILL_DAGGERS]);
    expect(skills.rows()).toEqual([{ skill: S.SKILL_SWORDS, value: 12, max: 50 }]);
    expect(await stored(database, 7)).toEqual([{ skill: S.SKILL_SWORDS, value: 12, max: 50 }]);
  });

  test("writes NEW / CHANGED / DELETED and leaves UNCHANGED alone", async () => {
    const database = await db();
    await insert(database, 1, S.SKILL_SWORDS, 10, 50);
    await insert(database, 1, S.SKILL_DAGGERS, 10, 50);
    await insert(database, 1, S.SKILL_DEFENSE, 10, 50);
    await insert(database, 1, S.SKILL_LANG_ORCISH, 300, 300); // invalid for a human
    const skills = player({ level: 10 });
    await skills.loadFromDb(database, 1);
    // Tamper with an UNCHANGED row to prove save does not rewrite it.
    await database
      .update(character_skills)
      .set({ value: 11 })
      .where(and(eq(character_skills.guid, 1), eq(character_skills.skill, S.SKILL_DEFENSE)));

    skills.setSkill(S.SKILL_SWORDS, 0, 25, 50);
    skills.setSkill(S.SKILL_DAGGERS, 0, 0, 0);
    skills.setSkill(S.SKILL_UNARMED, 0, 1, 50);
    await skills.save(database, 1);

    expect(await stored(database, 1)).toEqual([
      { skill: S.SKILL_SWORDS, value: 25, max: 50 },
      { skill: S.SKILL_DEFENSE, value: 11, max: 50 },
      { skill: S.SKILL_UNARMED, value: 1, max: 50 },
    ]);
    for (const itr of skills.statusMap().values()) {
      expect(itr.uState).toBe(SKILL_UNCHANGED);
    }
    expect(skills.statusMap().has(S.SKILL_DAGGERS)).toBe(false);
    expect(skills.statusMap().has(S.SKILL_LANG_ORCISH)).toBe(false);

    // A second save with no changes writes nothing.
    await database.delete(character_skills).where(eq(character_skills.guid, 1));
    await skills.save(database, 1);
    expect(await stored(database, 1)).toEqual([]);
  });

  test("delete then re-add in one session updates the existing row", async () => {
    const database = await db();
    await insert(database, 1, S.SKILL_SWORDS, 10, 50);
    const skills = player();
    await skills.loadFromDb(database, 1);
    skills.setSkill(S.SKILL_SWORDS, 0, 0, 0);
    skills.setSkill(S.SKILL_SWORDS, 0, 3, 50);
    await skills.save(database, 1);
    expect(await stored(database, 1)).toEqual([{ skill: S.SKILL_SWORDS, value: 3, max: 50 }]);
  });
});

describe("learnSkillRewardedSpells", () => {
  test("value-based abilities learn at their rank and unlearn below it; filters race, acquire method and Spell.dbc", () => {
    const skills = player({ race: HUMAN });
    skills.learnSkillRewardedSpells(S.SKILL_BLACKSMITHING, 10);
    let events = skills.drainEvents();
    expect(ofType(events, "learnSpell").map((e) => e.spell)).toEqual([2018, 2660]);
    expect(ofType(events, "unlearnSpell").map((e) => e.spell)).toEqual([3100]);

    skills.inWorld = true;
    skills.learnSkillRewardedSpells(S.SKILL_BLACKSMITHING, 75);
    events = skills.drainEvents();
    expect(ofType(events, "learnSpell")).toContainEqual({ type: "learnSpell", skill: S.SKILL_BLACKSMITHING, spell: 3100, inWorld: true });
    expect(ofType(events, "unlearnSpell")).toEqual([]);

    const orc = player({ race: ORC, classId: WARRIOR });
    orc.learnSkillRewardedSpells(S.SKILL_BLACKSMITHING, 1);
    expect(ofType(orc.drainEvents(), "learnSpell").map((e) => e.spell)).toContain(7777);
  });

  test("a learn-on-skill spell is skipped when its superseding spell is already reachable", () => {
    const skills = player({ classId: PALADIN });
    skills.learnSkillRewardedSpells(S.SKILL_RETRIBUTION, 10);
    expect(ofType(skills.drainEvents(), "learnSpell").map((e) => e.spell)).toEqual([5000, 5001]);
    skills.learnSkillRewardedSpells(S.SKILL_RETRIBUTION, 50);
    expect(ofType(skills.drainEvents(), "learnSpell").map((e) => e.spell)).toEqual([5001]);
  });

  test("spellChangesFromEvents resolves the net result", () => {
    expect(
      spellChangesFromEvents([
        { type: "learnSpell", skill: 1, spell: 10, inWorld: false },
        { type: "unlearnSpell", skill: 1, spell: 11 },
        { type: "removeSpell", skill: 1, spell: 10 },
        { type: "learnSpell", skill: 1, spell: 12, inWorld: false },
      ]),
    ).toEqual({ learn: [12], remove: [10, 11] });
  });
});

describe("range types", () => {
  test("GetSkillRangeType follows tier, runeforging, armor and language rules", () => {
    const data = testData();
    const type = (skill: number, race = HUMAN, classId = DEATH_KNIGHT) =>
      getSkillRangeType(data, getSkillRaceClassInfo(data, skill, race, classId)!);
    expect(type(S.SKILL_BLACKSMITHING)).toBe(SKILL_RANGE_RANK);
    expect(type(S.SKILL_RUNEFORGING)).toBe(SKILL_RANGE_MONO);
    expect(type(S.SKILL_CLOTH)).toBe(SKILL_RANGE_MONO);
    expect(type(S.SKILL_LANG_COMMON)).toBe(SKILL_RANGE_LANGUAGE);
    expect(type(S.SKILL_SWORDS)).toBe(SKILL_RANGE_LEVEL);
    expect(getSkillRangeType(data, { id: 0, skillId: 4242, raceMask: 0, classMask: 0, flags: 0, skillTierId: 0 })).toBe(
      SKILL_RANGE_NONE,
    );
  });

  test("GetSkillRaceClassInfo checks race and class masks", () => {
    const data = testData();
    expect(getSkillRaceClassInfo(data, S.SKILL_LANG_COMMON, HUMAN, WARRIOR)).not.toBeNull();
    expect(getSkillRaceClassInfo(data, S.SKILL_LANG_COMMON, ORC, WARRIOR)).toBeNull();
    expect(getSkillRaceClassInfo(data, S.SKILL_RETRIBUTION, HUMAN, WARRIOR)).toBeNull();
    expect(getSkillRaceClassInfo(data, S.SKILL_RETRIBUTION, HUMAN, PALADIN)).not.toBeNull();
  });

  test("profession or riding", () => {
    const data = testData();
    expect(isProfessionOrRidingSkill(data, S.SKILL_BLACKSMITHING)).toBe(true);
    expect(isProfessionOrRidingSkill(data, S.SKILL_FISHING)).toBe(true);
    expect(isProfessionOrRidingSkill(data, S.SKILL_COOKING)).toBe(true);
    expect(isProfessionOrRidingSkill(data, S.SKILL_RIDING)).toBe(true);
    expect(isProfessionOrRidingSkill(data, S.SKILL_SWORDS)).toBe(false);
    expect(isProfessionOrRidingSkill(data, S.SKILL_ENCHANTING)).toBe(false); // not in this SkillLine set
  });
});

describe("UpdateSkillsForLevel", () => {
  test("raises max of level skills, maximizes ALWAYS_MAX_VALUE skills, keeps other ranges", () => {
    const skills = player({ level: 10 });
    skills.load([
      { skill: S.SKILL_SWORDS, value: 30, max: 50 },
      { skill: S.SKILL_RACIAL_HUMAN, value: 50, max: 50 },
      { skill: S.SKILL_BLACKSMITHING, value: 80, max: 150 },
      { skill: S.SKILL_CLOTH, value: 1, max: 1 },
    ]);
    skills.flushChangedFields();
    skills.updateSkillsForLevel(11);
    expect(skills.rows()).toEqual([
      { skill: S.SKILL_SWORDS, value: 30, max: 55 },
      { skill: S.SKILL_RACIAL_HUMAN, value: 55, max: 55 },
      { skill: S.SKILL_BLACKSMITHING, value: 80, max: 150 },
      { skill: S.SKILL_CLOTH, value: 1, max: 1 },
    ]);
    expect(skills.statusMap().get(S.SKILL_SWORDS)?.uState).toBe(SKILL_CHANGED);
    expect(skills.statusMap().get(S.SKILL_BLACKSMITHING)?.uState).toBe(SKILL_UNCHANGED);
    expect(skills.flushChangedFields()).toEqual([1, 4]);
  });

  test("skills already at the configured cap keep their max; AlwaysMaxSkillForLevel maximizes", () => {
    const capped = player({ level: 90 });
    capped.load([{ skill: S.SKILL_SWORDS, value: 400, max: 450 }]);
    // load() forces max to level*5 for level skills, so set the cap explicitly
    capped.setSkill(S.SKILL_SWORDS, 0, 400, configMaxSkillValue(80));
    capped.updateSkillsForLevel(90);
    expect(capped.getPureMaxSkillValue(S.SKILL_SWORDS)).toBe(450);

    const always = player({ level: 10 }, { config: { alwaysMaxSkillForLevel: true } });
    always.load([{ skill: S.SKILL_SWORDS, value: 3, max: 50 }]);
    always.updateSkillsForLevel(20);
    expect(always.rows()).toEqual([{ skill: S.SKILL_SWORDS, value: 100, max: 100 }]);
  });

  test("UpdateSkillsToMaxSkillsForLevel maximizes non-profession skills and flags defense", () => {
    const skills = player({ level: 10 });
    skills.load([
      { skill: S.SKILL_SWORDS, value: 3, max: 50 },
      { skill: S.SKILL_DEFENSE, value: 4, max: 50 },
      { skill: S.SKILL_BLACKSMITHING, value: 5, max: 75 },
      { skill: S.SKILL_CLOTH, value: 1, max: 1 },
    ]);
    skills.drainEvents();
    skills.updateSkillsToMaxSkillsForLevel();
    expect(skills.rows()).toEqual([
      { skill: S.SKILL_SWORDS, value: 50, max: 50 },
      { skill: S.SKILL_DEFENSE, value: 50, max: 50 },
      { skill: S.SKILL_BLACKSMITHING, value: 5, max: 75 },
      { skill: S.SKILL_CLOTH, value: 1, max: 1 },
    ]);
    expect(skills.drainEvents()).toEqual([{ type: "defenseBonuses" }]);
  });
});

describe("LearnDefaultSkills", () => {
  test("uses range types, flags, tiers and existing skills", () => {
    const skills = player({ race: HUMAN, classId: WARRIOR, level: 1 });
    skills.setSkill(S.SKILL_UNARMED, 0, 4, 5);
    skills.learnDefaultSkills([
      { skillId: S.SKILL_LANG_COMMON, rank: 0 },
      { skillId: S.SKILL_LANG_ORCISH, rank: 0 }, // no rc for humans
      { skillId: S.SKILL_SWORDS, rank: 0 },
      { skillId: S.SKILL_RACIAL_HUMAN, rank: 0 },
      { skillId: S.SKILL_CLOTH, rank: 0 },
      { skillId: S.SKILL_FIST_WEAPONS, rank: 0 },
      { skillId: S.SKILL_LOCKPICKING, rank: 0 },
      { skillId: S.SKILL_BLACKSMITHING, rank: 2 },
      { skillId: S.SKILL_HERBALISM, rank: 0 }, // rank skill without a rank
      { skillId: S.SKILL_UNARMED, rank: 0 }, // already known
    ]);
    expect(skills.rows()).toEqual([
      { skill: S.SKILL_UNARMED, value: 4, max: 5 },
      { skill: S.SKILL_LANG_COMMON, value: 300, max: 300 },
      { skill: S.SKILL_SWORDS, value: 1, max: 5 },
      { skill: S.SKILL_RACIAL_HUMAN, value: 5, max: 5 },
      { skill: S.SKILL_CLOTH, value: 1, max: 1 },
      { skill: S.SKILL_FIST_WEAPONS, value: 4, max: 5 },
      { skill: S.SKILL_LOCKPICKING, value: 1, max: 5 },
      { skill: S.SKILL_BLACKSMITHING, value: 1, max: 150 },
    ]);
    expect(skills.getSkillStep(S.SKILL_BLACKSMITHING)).toBe(2);
  });

  test("death knights start level skills at (level - 1) * 5, capped by max", () => {
    const dk = player({ race: HUMAN, classId: DEATH_KNIGHT, level: 55 });
    dk.learnDefaultSkills([
      { skillId: S.SKILL_SWORDS, rank: 0 },
      { skillId: S.SKILL_BLACKSMITHING, rank: 1 },
      { skillId: S.SKILL_RUNEFORGING, rank: 0 },
    ]);
    expect(dk.rows()).toEqual([
      { skill: S.SKILL_SWORDS, value: 270, max: 275 },
      { skill: S.SKILL_BLACKSMITHING, value: 75, max: 75 },
      { skill: S.SKILL_RUNEFORGING, value: 1, max: 1 },
    ]);
  });

  test("AlwaysMaxWeaponSkill maximizes non-profession level skills", () => {
    const skills = player({ level: 20 }, { config: { alwaysMaxWeaponSkill: true } });
    skills.learnDefaultSkills([{ skillId: S.SKILL_SWORDS, rank: 0 }]);
    expect(skills.rows()).toEqual([{ skill: S.SKILL_SWORDS, value: 100, max: 100 }]);
  });
});

describe("skill gains", () => {
  test("UpdateSkill adds step capped at max and refuses 0/maxed skills", () => {
    const skills = player();
    skills.load([
      { skill: S.SKILL_SWORDS, value: 48, max: 50 },
      { skill: S.SKILL_DAGGERS, value: 50, max: 50 },
    ]);
    skills.drainEvents();
    expect(skills.updateSkill(S.SKILL_SWORDS, 5)).toBe(true);
    expect(skills.getPureSkillValue(S.SKILL_SWORDS)).toBe(50);
    expect(skills.statusMap().get(S.SKILL_SWORDS)?.uState).toBe(SKILL_CHANGED);
    expect(skills.drainEvents()).toEqual([
      { type: "skillEnchantments", skill: S.SKILL_SWORDS, oldValue: 48, newValue: 50 },
      { type: "achievementCriteria", criteriaType: ACHIEVEMENT_CRITERIA_TYPE_REACH_SKILL_LEVEL, skill: S.SKILL_SWORDS },
    ]);
    expect(skills.updateSkill(S.SKILL_SWORDS, 1)).toBe(false);
    expect(skills.updateSkill(S.SKILL_DAGGERS, 1)).toBe(false);
    expect(skills.updateSkill(S.SKILL_DEFENSE, 1)).toBe(false);
    expect(skills.updateSkill(0, 1)).toBe(false);
  });

  test("UpdateSkillPro rolls irand(1, 1000) against per-mille chance and learns at bonus levels", () => {
    const random = fixedRandom([500, 501]);
    const skills = player({}, { random });
    skills.load([{ skill: S.SKILL_BLACKSMITHING, value: 74, max: 150 }]);
    skills.drainEvents();
    expect(skills.updateSkillPro(S.SKILL_BLACKSMITHING, 500, 1)).toBe(true);
    expect(random.irands).toEqual([[1, 1000]]);
    expect(skills.getPureSkillValue(S.SKILL_BLACKSMITHING)).toBe(75);
    const events = skills.drainEvents();
    expect(ofType(events, "learnSpell").map((e) => e.spell)).toContain(3100);
    expect(skills.updateSkillPro(S.SKILL_BLACKSMITHING, 500, 1)).toBe(false);
    expect(skills.updateSkillPro(S.SKILL_BLACKSMITHING, 0, 1)).toBe(false);
    expect(random.irands).toHaveLength(2);
  });

  test("UpdateSkillPro respects the trial trade skill cap", () => {
    const skills = player({}, { random: fixedRandom([1]) });
    skills.trialAccount = true;
    skills.load([{ skill: S.SKILL_BLACKSMITHING, value: 100, max: 150 }]);
    expect(skills.updateSkillPro(S.SKILL_BLACKSMITHING, 1000, 1)).toBe(false);
    skills.trialAccount = false;
    expect(skills.updateSkillPro(S.SKILL_BLACKSMITHING, 1000, 1)).toBe(true);
  });

  test("gain chance formulas", () => {
    const config = DEFAULT_SKILL_CONFIG;
    expect(skillGainChance(config, 125, 125, 75, 50)).toBe(0);
    expect(skillGainChance(config, 80, 125, 75, 50)).toBe(250);
    expect(skillGainChance(config, 60, 125, 75, 50)).toBe(750);
    expect(skillGainChance(config, 10, 125, 75, 50)).toBe(1000);
    expect(craftSkillGainChance(config, 10, 45, 15)).toBe(1000);
    expect(craftSkillGainChance(config, 45, 45, 15)).toBe(0);
    expect(craftSkillGainChance(config, 30, 45, 15)).toBe(500);
    expect(craftSkillGainChance(config, 10, 10, 10)).toBe(0);
    expect(craftSkillGainChance(config, 9, 10, 10)).toBe(1000);
    expect(fishingLevelUpProbability(0)).toBe(0);
    expect(fishingLevelUpProbability(115)).toBe(100);
    expect(fishingLevelUpProbability(116)).toBe(50);
    expect(Math.trunc(fishingLevelUpProbability(150))).toBe(33);
    expect(fishingLevelUpProbability(451)).toBe(100);
  });

  test("gather, craft and fishing feed UpdateSkillPro", () => {
    const random = fixedRandom([1, 1, 1, 1]);
    const skills = player({}, { random, config: { skillChanceMiningSteps: 75 } });
    skills.load([
      { skill: S.SKILL_HERBALISM, value: 10, max: 75 },
      { skill: S.SKILL_MINING, value: 80, max: 150 },
      { skill: S.SKILL_BLACKSMITHING, value: 20, max: 75 },
      { skill: S.SKILL_FISHING, value: 116, max: 150 },
    ]);
    expect(skills.updateGatherSkill(S.SKILL_HERBALISM, 10, 1)).toBe(true);
    expect(skills.getPureSkillValue(S.SKILL_HERBALISM)).toBe(11);
    // mining: orange 1000 >> (80 / 75 = 1) = 500 per-mille
    expect(skills.updateGatherSkill(S.SKILL_MINING, 80, 100)).toBe(true);
    expect(skills.updateGatherSkill(S.SKILL_SWORDS, 1, 1)).toBe(false);
    expect(skills.updateCraftSkill(2660)).toBe(true);
    expect(skills.getPureSkillValue(S.SKILL_BLACKSMITHING)).toBe(21);
    expect(skills.updateCraftSkill(424242)).toBe(false);
    expect(skills.updateFishingSkill()).toBe(true);
    expect(skills.getPureSkillValue(S.SKILL_FISHING)).toBe(117);
  });

  test("gray level formula", () => {
    expect(grayLevel(5)).toBe(0);
    expect(grayLevel(10)).toBe(4);
    expect(grayLevel(39)).toBe(31);
    expect(grayLevel(40)).toBe(31);
    expect(grayLevel(59)).toBe(47);
    expect(grayLevel(80)).toBe(71);
    expect(configMaxSkillValue(80)).toBe(450);
    expect(configMaxSkillValue(60)).toBe(300);
    expect(configMaxSkillValue(70)).toBe(375);
  });
});

describe("weapon and defense skills", () => {
  function combatPlayer(random = fixedRandom()) {
    const skills = player({ level: 10 }, { random });
    skills.load([
      { skill: S.SKILL_UNARMED, value: 10, max: 50 },
      { skill: S.SKILL_FIST_WEAPONS, value: 10, max: 50 },
      { skill: S.SKILL_DAGGERS, value: 10, max: 50 },
      { skill: S.SKILL_DEFENSE, value: 10, max: 50 },
    ]);
    skills.drainEvents();
    return skills;
  }

  test("item skill table", () => {
    expect(itemSkill(ITEM_CLASS_WEAPON, 0)).toBe(S.SKILL_AXES);
    expect(itemSkill(ITEM_CLASS_WEAPON, 17)).toBe(S.SKILL_ASSASSINATION);
    expect(itemSkill(ITEM_CLASS_WEAPON, ITEM_SUBCLASS_WEAPON_FISHING_POLE)).toBe(S.SKILL_FISHING);
    expect(itemSkill(ITEM_CLASS_WEAPON, 21)).toBe(0);
    expect(itemSkill(ITEM_CLASS_ARMOR, 4)).toBe(S.SKILL_PLATE_MAIL);
    expect(itemSkill(ITEM_CLASS_ARMOR, 6)).toBe(S.SKILL_SHIELD);
    expect(itemSkill(0, 0)).toBe(0);
  });

  test("unarmed main hand raises unarmed and fist weapons together", () => {
    const skills = combatPlayer();
    skills.updateWeaponSkill({ attackType: BASE_ATTACK, weapon: null });
    expect(skills.getPureSkillValue(S.SKILL_UNARMED)).toBe(11);
    expect(skills.getPureSkillValue(S.SKILL_FIST_WEAPONS)).toBe(11);
    expect(skills.drainEvents().at(-1)).toEqual({ type: "critPercentages" });
  });

  test("fist weapons raise unarmed and fist; fishing poles and forms raise nothing; item overrides weapon", () => {
    const skills = combatPlayer();
    skills.updateWeaponSkill({ attackType: BASE_ATTACK, weapon: { itemClass: ITEM_CLASS_WEAPON, subClass: ITEM_SUBCLASS_WEAPON_FIST } });
    expect(skills.getPureSkillValue(S.SKILL_UNARMED)).toBe(11);
    expect(skills.getPureSkillValue(S.SKILL_FIST_WEAPONS)).toBe(11);

    skills.updateWeaponSkill({ attackType: BASE_ATTACK, weapon: { itemClass: ITEM_CLASS_WEAPON, subClass: ITEM_SUBCLASS_WEAPON_FISHING_POLE } });
    skills.updateWeaponSkill({ attackType: BASE_ATTACK, weapon: null, inFeralForm: true });
    skills.updateWeaponSkill({ attackType: BASE_ATTACK, weapon: null, inTreeForm: true });
    skills.updateWeaponSkill({ attackType: BASE_ATTACK, weapon: null, victimNoSkillGains: true });
    skills.updateWeaponSkill({ attackType: OFF_ATTACK, weapon: null });
    expect(skills.getPureSkillValue(S.SKILL_UNARMED)).toBe(11);

    const dagger = { itemClass: ITEM_CLASS_WEAPON, subClass: 15 };
    skills.updateWeaponSkill({ attackType: BASE_ATTACK, weapon: null, item: dagger });
    expect(skills.getPureSkillValue(S.SKILL_DAGGERS)).toBe(11);
    skills.updateWeaponSkill({ attackType: BASE_ATTACK, weapon: null, item: { ...dagger, broken: true } });
    expect(skills.getPureSkillValue(S.SKILL_DAGGERS)).toBe(11);
    expect(skills.getPureSkillValue(S.SKILL_UNARMED)).toBe(12);
  });

  test("UpdateCombatSkills chance formula and roll", () => {
    const random = fixedRandom([], [true, false, true]);
    const skills = combatPlayer(random);
    // level 10: max 50, skill 10 -> diff 40; gray 4; mob 12 -> lvldif 8; 3*8*40/10 = 96; +2%*int
    skills.updateCombatSkills({ attackType: BASE_ATTACK, weapon: null, victimLevel: 12, defence: false, intellect: 20 });
    expect(random.chances[0]).toBe(Math.fround(Math.fround(96) + Math.fround(Math.fround(96 * Math.fround(0.02)) * 20)));
    expect(skills.getPureSkillValue(S.SKILL_UNARMED)).toBe(11);

    // defence ignores intellect; low-level mob clamps lvldif to 3; roll fails
    skills.updateCombatSkills({ attackType: BASE_ATTACK, weapon: null, victimLevel: 1, defence: true, intellect: 20 });
    expect(random.chances[1]).toBe(Math.fround((3 * 3 * 40) / 10));
    expect(skills.getPureSkillValue(S.SKILL_DEFENSE)).toBe(10);

    // mob level is capped to player + 5
    skills.drainEvents();
    skills.updateCombatSkills({ attackType: BASE_ATTACK, weapon: null, victimLevel: 60, defence: true, intellect: 0 });
    expect(random.chances[2]).toBe(Math.fround((3 * (15 - 4) * 40) / 10));
    expect(skills.getPureSkillValue(S.SKILL_DEFENSE)).toBe(11);
    expect(skills.drainEvents().at(-1)).toEqual({ type: "defenseBonuses" });
  });

  test("UpdateCombatSkills does nothing at max for level and has a 1% floor", () => {
    const random = fixedRandom();
    const skills = player({ level: 10 }, { random });
    skills.load([
      { skill: S.SKILL_DEFENSE, value: 50, max: 50 },
      { skill: S.SKILL_UNARMED, value: 49, max: 50 },
    ]);
    skills.updateCombatSkills({ attackType: BASE_ATTACK, weapon: null, victimLevel: 10, defence: true, intellect: 0 });
    expect(random.chances).toEqual([]);
    skills.updateCombatSkills({ attackType: BASE_ATTACK, weapon: null, victimLevel: 10, defence: false, intellect: 0 });
    expect(random.chances[0]).toBeCloseTo(Math.fround((3 * 6 * 1) / 10), 5);
    skills.level = 80;
    skills.load([{ skill: S.SKILL_UNARMED, value: 399, max: 400 }]);
    skills.updateCombatSkills({ attackType: BASE_ATTACK, weapon: null, victimLevel: 1, defence: false, intellect: 0 });
    expect(random.chances[1]).toBe(1);
  });

  test("UpdateDefense uses SkillGain.Defense", () => {
    const skills = player({ level: 10 }, { config: { skillGainDefense: 3 } });
    skills.load([{ skill: S.SKILL_DEFENSE, value: 10, max: 50 }]);
    skills.drainEvents();
    expect(skills.updateDefense()).toBe(true);
    expect(skills.getPureSkillValue(S.SKILL_DEFENSE)).toBe(13);
    expect(skills.drainEvents().at(-1)).toEqual({ type: "defenseBonuses" });
  });
});

describe("fields", () => {
  test("changed indices are tracked only when a value actually changes", () => {
    const skills = player();
    skills.setSkill(S.SKILL_SWORDS, 0, 1, 50);
    skills.setSkill(S.SKILL_DAGGERS, 0, 1, 50);
    expect(skills.flushChangedFields()).toEqual([0, 1, 3, 4]);
    skills.setSkill(S.SKILL_DAGGERS, 0, 1, 50);
    expect(skills.changedFieldIndices()).toEqual([]);
    skills.modifySkillBonus(S.SKILL_DAGGERS, 1, true);
    expect(skills.flushChangedFields()).toEqual([5]);
    expect(PLAYER_SKILL_INFO_1_1).toBe(636);
  });

  test("fieldValues returns a copy", () => {
    const skills = player();
    const copy = skills.fieldValues();
    copy[0] = 99;
    expect(skills.fieldValues()[0]).toBe(0);
  });
});

describe("without DBC", () => {
  test("load keeps every skill, derives language/armor ranges and level max", () => {
    const skills = player({ level: 5 }, { data: emptySkillData() });
    const result = skills.load([
      { skill: S.SKILL_LANG_ORCISH, value: 1, max: 1 },
      { skill: S.SKILL_MAIL, value: 5, max: 5 },
      { skill: S.SKILL_SWORDS, value: 3, max: 10 },
      { skill: S.SKILL_BLACKSMITHING, value: 40, max: 75 },
    ]);
    expect(result.zeroValueSkills).toEqual([]);
    expect(skills.rows()).toEqual([
      { skill: S.SKILL_LANG_ORCISH, value: 300, max: 300 },
      { skill: S.SKILL_MAIL, value: 1, max: 1 },
      { skill: S.SKILL_SWORDS, value: 3, max: 25 },
      // no SkillTiers.dbc -> not RANK; treated as a level skill
      { skill: S.SKILL_BLACKSMITHING, value: 40, max: 25 },
    ]);
    expect(isProfessionOrRidingSkill(emptySkillData(), S.SKILL_BLACKSMITHING)).toBe(true);
    expect(skills.drainEvents()).toEqual([]);
  });
});

describe("playercreateinfo_skills", () => {
  test("loads per race/class with ObjectMgr filters", () => {
    const row = (raceMask: number, classMask: number, skill: number, rank: number) => ({ raceMask, classMask, skill, rank });
    const world = WorldTables.fromRows([
      [
        playercreateinfo_skills,
        [
          row(0, 0, S.SKILL_DEFENSE, 0),
          row(1, 0, S.SKILL_LANG_COMMON, 0),
          row(0, 1 << (PALADIN - 1), S.SKILL_RETRIBUTION, 0),
          row(0, 0, S.SKILL_SWORDS, 0), // rc limits it to warrior/paladin/dk
          row(0, 0, S.SKILL_BLACKSMITHING, 16), // rank too high
          row(0, 0, 4242, 0), // unknown skill line
          row(1 << 8, 0, S.SKILL_UNARMED, 0), // goblin race bit (not playable)
          row(0, 1 << 9, S.SKILL_UNARMED, 0), // class 10 (not playable)
        ],
      ],
    ]);

    const table = loadPlayerCreateSkills(world, testData());
    expect(playerCreateSkillsFor(table, HUMAN, WARRIOR)).toEqual([
      { skillId: S.SKILL_SWORDS, rank: 0 },
      { skillId: S.SKILL_DEFENSE, rank: 0 },
      { skillId: S.SKILL_LANG_COMMON, rank: 0 },
    ]);
    expect(playerCreateSkillsFor(table, HUMAN, PALADIN).map((s) => s.skillId)).toEqual([
      S.SKILL_SWORDS,
      S.SKILL_DEFENSE,
      S.SKILL_RETRIBUTION,
      S.SKILL_LANG_COMMON,
    ]);
    expect(playerCreateSkillsFor(table, ORC, 8).map((s) => s.skillId)).toEqual([S.SKILL_DEFENSE]);
    expect(playerCreateSkillsFor(table, 9, WARRIOR)).toEqual([]);

    const skills = player({ race: HUMAN, classId: WARRIOR, level: 1 });
    skills.learnDefaultSkills(playerCreateSkillsFor(table, HUMAN, WARRIOR));
    expect(skills.rows().map((row) => row.skill)).toEqual([S.SKILL_SWORDS, S.SKILL_DEFENSE, S.SKILL_LANG_COMMON]);
  });
});

describe("languages", () => {
  test("lang_description matches ObjectMgr.cpp", () => {
    expect(LANG_DESCRIPTION).toHaveLength(19);
    expect(languageDesc(LANG_COMMON)).toEqual({ langId: 7, spellId: 668, skillId: 98 });
    expect(languageDesc(LANG_GUTTERSPEAK)).toEqual({ langId: 33, spellId: 17737, skillId: 673 });
    expect(languageSkill(LANG_ORCISH)).toBe(109);
    expect(languageSkill(2)).toBe(113);
    expect(languageSkill(3)).toBe(115);
    expect(languageSkill(6)).toBe(111);
    expect(languageSkill(8)).toBe(139);
    expect(languageSkill(9)).toBe(140);
    expect(languageSkill(10)).toBe(137);
    expect(languageSkill(11)).toBe(138);
    expect(languageSkill(12)).toBe(141);
    expect(languageSkill(13)).toBe(313);
    expect(languageSkill(14)).toBe(315);
    expect(languageSkill(35)).toBe(759);
    expect(languageSkill(LANG_UNIVERSAL)).toBe(0);
    expect(languageSkill(LANG_ZOMBIE)).toBe(0);
    expect(languageSkill(37)).toBe(0);
    expect(languageSkill(38)).toBe(0);
    expect(languageSkill(LANG_ADDON)).toBe(0);
    expect(languageSkill(-1)).toBe(0);
    expect(languageSkill(4)).toBeNull();
  });

  test("canSpeakLanguage checks the skill and comprehend-language auras", () => {
    const skills = player({ race: HUMAN });
    skills.learnDefaultSkills([{ skillId: S.SKILL_LANG_COMMON, rank: 0 }]);
    expect(canSpeakLanguage(skills, LANG_COMMON)).toBe("ok");
    expect(canSpeakLanguage(skills, LANG_UNIVERSAL)).toBe("ok");
    expect(canSpeakLanguage(skills, LANG_ADDON)).toBe("ok");
    expect(canSpeakLanguage(skills, LANG_ORCISH)).toBe("not-learned");
    expect(canSpeakLanguage(skills, LANG_ORCISH, [LANG_ORCISH])).toBe("ok");
    expect(canSpeakLanguage(skills, 5)).toBe("unknown-language");
  });
});

describe("config", () => {
  test("skillConfigFromWorld reads the WorldConfig values", async () => {
    const path = `/tmp/wow-skill-config-${crypto.randomUUID()}.conf`;
    await Bun.write(path, "SkillGain.Weapon = 3\nAlwaysMaxWeaponSkill = 1\nSkillChance.Orange = 90\n");
    const config = new ConfigMgr();
    const policy = defaultConfigPolicy();
    policy.missingOptionSeverity = ConfigSeverity.Skip;
    policy.missingFileSeverity = ConfigSeverity.Skip;
    policy.criticalOptionSeverity = ConfigSeverity.Skip;
    policy.valueErrorSeverity = ConfigSeverity.Skip;
    config.configure(path, [], "", policy);
    expect(await config.loadAppConfigs()).toBe(true);
    const world = new WorldConfig(config);
    world.load();
    expect(skillConfigFromWorld(world)).toEqual({
      ...DEFAULT_SKILL_CONFIG,
      skillGainWeapon: 3,
      alwaysMaxWeaponSkill: true,
      skillChanceOrange: 90,
    });
  });
});
