import { creature, creature_template } from "../database/schema/world.ts";
import type { WorldTables } from "../database/world-tables.ts";
import { creatureStatLevel, generateCreatureStats } from "../data/creature-stats.ts";
import type { CreatureSpawn, CreatureTemplate, WorldData } from "../data/world.ts";
import { creatureFlags, creatureModel } from "../data/world.ts";
import { logError } from "../log.ts";
import { creatureGuid } from "../world/spawn.ts";
import { CREATURE_ELITE_NORMAL, CREATURE_ELITE_RARE } from "./constants.ts";
import { creatureMeleeDamage } from "./formulas.ts";

const BASE_RUN = 7;
const DEFAULT_BASE_ATTACK_TIME = 2000;

/** `creature_template` columns the combat port reads that `WorldData` does not carry. */
export type CreatureCombatColumns = {
  detectionRange: number;
  flagsExtra: number;
  baseAttackTime: number;
  baseVariance: number;
  dmgSchool: number;
  lootId: number;
  minGold: number;
  maxGold: number;
  skinLoot: number;
  aiName: string;
  experienceModifier: number;
  regenHealth: boolean;
};

/** `creature` columns the combat port reads that `WorldData` does not carry. */
export type CreatureSpawnColumns = { spawnTimeSecs: number; wanderDistance: number; movementType: number };

/** Everything a live creature needs that does not change while it lives (template, spawn row, and `SelectLevel`). */
export type CreatureInfo = {
  spawnGuid: number;
  entry: number;
  guid: bigint;
  map: number;
  home: { x: number; y: number; z: number; o: number };
  phaseMask: number;
  spawnMask: number;
  level: number;
  minLevel: number;
  maxHealth: number;
  maxMana: number;
  armor: number;
  attackPower: number;
  minDamage: number;
  maxDamage: number;
  attackTime: number;
  factionTemplate: number;
  combatReach: number;
  boundingRadius: number;
  /** The display and scale `Unit::GetCollisionHeight` reads (`creature_template_model`). */
  displayId?: number;
  scale?: number;
  runSpeed: number;
  rank: number;
  type: number;
  typeFlags: number;
  unitFlags: number;
  npcFlags: number;
  dynamicFlags: number;
  healthModifier: number;
  killCredit: [number, number];
  respawnDelay: number;
  /** `creature_template.unit_class` */
  unitClass: number;
  /** `creature_template.exp` */
  expansion: number;
  /** `creature_template.DamageModifier` */
  damageModifier: number;
  /** `CreatureBaseStats::GenerateBaseDamage` (the weapon damage `SetBaseWeaponDamage` stores). */
  baseDamage: number;
  /** Armor then `creature_template_resistance` by school. */
  resistances: [number, number, number, number, number, number, number];
} & CreatureCombatColumns;

const COLUMN_DEFAULTS: CreatureCombatColumns = {
  detectionRange: 20,
  flagsExtra: 0,
  baseAttackTime: DEFAULT_BASE_ATTACK_TIME,
  baseVariance: 1,
  dmgSchool: 0,
  lootId: 0,
  minGold: 0,
  maxGold: 0,
  skinLoot: 0,
  aiName: "",
  experienceModifier: 1,
  regenHealth: true,
};

export class CreatureInfoStore {
  private readonly columns = new Map<number, CreatureCombatColumns>();
  private readonly spawnColumns = new Map<number, CreatureSpawnColumns>();
  private readonly infos = new Map<number, CreatureInfo | null>();
  private readonly spawnsByGuid = new Map<number, CreatureSpawn>();

  constructor(
    private readonly world: WorldData,
    private readonly db: WorldTables | null,
  ) {
    for (const spawn of world.creaturesOnMap) {
      this.spawnsByGuid.set(spawn.guid, spawn);
    }
  }

  spawn(spawnGuid: number): CreatureSpawn | null {
    return this.spawnsByGuid.get(spawnGuid) ?? null;
  }

  spawns(): Iterable<CreatureSpawn> {
    return this.spawnsByGuid.values();
  }

  info(spawnGuid: number): CreatureInfo | null {
    const cached = this.infos.get(spawnGuid);
    if (cached !== undefined) {
      return cached;
    }
    const spawn = this.spawnsByGuid.get(spawnGuid);
    const template = spawn ? this.world.creatureTemplate(spawn.entry) : undefined;
    const info = spawn && template ? this.build(spawn, template) : null;
    this.infos.set(spawnGuid, info);
    return info;
  }

  private build(spawn: CreatureSpawn, template: CreatureTemplate): CreatureInfo {
    const columns = this.templateColumns(template.entry);
    const spawnColumns = this.spawnRow(spawn.guid);
    const level = creatureStatLevel(template.minLevel, template.maxLevel);
    const generated = generateCreatureStats(this.world.creatureClassLevelStats(level, template.unitClass), {
      expansion: template.expansion,
      healthMod: template.healthMod,
      manaMod: template.manaMod,
      armorMod: template.armorMod,
      rank: template.rank,
    });
    const model = creatureModel(template);
    const stored = template.models.find((row) => row.displayId === model.displayId);
    const scale = model.scale > 0 ? model.scale : 1;
    const flags = creatureFlags(template, spawn);
    const attackTime = columns.baseAttackTime > 0 ? columns.baseAttackTime : DEFAULT_BASE_ATTACK_TIME;
    const damage = creatureMeleeDamage({
      baseDamage: generated?.minDamage ?? 0,
      attackPower: generated?.attackPower ?? 0,
      variance: columns.baseVariance,
      damageModifier: template.damageMod ?? 1,
      attackTimeMs: attackTime,
    });
    const maxHealth = generated ? generated.health : spawn.health > 0 ? spawn.health : 1;
    return {
      spawnGuid: spawn.guid,
      entry: spawn.entry,
      guid: creatureGuid(spawn.entry, spawn.guid),
      map: spawn.map,
      home: { x: spawn.x, y: spawn.y, z: spawn.z, o: spawn.orientation },
      phaseMask: spawn.phaseMask,
      spawnMask: spawn.spawnMask,
      level,
      minLevel: template.minLevel,
      maxHealth,
      maxMana: generated ? generated.mana : spawn.mana,
      armor: generated?.armor ?? 0,
      attackPower: generated?.attackPower ?? 0,
      minDamage: damage.min,
      maxDamage: damage.max,
      attackTime,
      factionTemplate: template.faction,
      combatReach: (stored?.combatReach ?? 0) * scale,
      boundingRadius: (stored?.boundingRadius ?? 0) * scale,
      displayId: model.displayId,
      scale,
      runSpeed: BASE_RUN * (template.speedRun > 0 ? template.speedRun : 1),
      rank: template.rank,
      type: template.type,
      typeFlags: template.typeFlags,
      unitFlags: flags.unitFlags,
      npcFlags: flags.npcFlags,
      dynamicFlags: flags.dynamicFlags,
      healthModifier: template.healthMod,
      killCredit: template.killCredit,
      respawnDelay: spawnColumns.spawnTimeSecs,
      unitClass: template.unitClass,
      expansion: template.expansion,
      damageModifier: template.damageMod ?? 1,
      baseDamage: generated?.minDamage ?? 0,
      resistances: [generated?.armor ?? 0, ...template.resistances.slice(1, 7)] as CreatureInfo["resistances"],
      ...columns,
    };
  }

  private templateColumns(entry: number): CreatureCombatColumns {
    const cached = this.columns.get(entry);
    if (cached) {
      return cached;
    }
    let columns = COLUMN_DEFAULTS;
    const row = this.db?.first(creature_template, "entry", entry);
    if (row) {
      columns = {
        detectionRange: row.detection_range,
        flagsExtra: row.flags_extra,
        baseAttackTime: row.BaseAttackTime,
        baseVariance: row.BaseVariance,
        dmgSchool: row.dmgschool,
        lootId: row.lootid,
        minGold: row.mingold,
        maxGold: row.maxgold,
        skinLoot: row.skinloot,
        aiName: row.AIName,
        experienceModifier: row.ExperienceModifier,
        regenHealth: row.RegenHealth !== 0,
      };
    }
    this.columns.set(entry, columns);
    return columns;
  }

  private spawnRow(guid: number): CreatureSpawnColumns {
    const cached = this.spawnColumns.get(guid);
    if (cached) {
      return cached;
    }
    let row: CreatureSpawnColumns = { spawnTimeSecs: 300, wanderDistance: 0, movementType: 0 };
    const found = this.db?.first(creature, "guid", guid);
    if (found) {
      row = { spawnTimeSecs: found.spawntimesecs, wanderDistance: found.wander_distance, movementType: found.MovementType };
    }
    this.spawnColumns.set(guid, row);
    return row;
  }
}

/** `Creature::isElite` */
export function isElite(rank: number): boolean {
  return rank !== CREATURE_ELITE_NORMAL && rank !== CREATURE_ELITE_RARE;
}

const CREATURE_TYPE_FLAG_BOSS_MOB = 0x00000004;

/** `Creature::isWorldBoss` */
export function isWorldBoss(typeFlags: number): boolean {
  return (typeFlags & CREATURE_TYPE_FLAG_BOSS_MOB) !== 0;
}
