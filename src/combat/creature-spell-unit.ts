import { GetCollisionHeight } from "../game/Entities/Unit/UnitCollision.ts";
import { packedGuid } from "../world/update-object.ts";
import type { AuraEffect } from "../spells/aura.ts";
import * as E from "../spells/enums.ts";
import { splineSetRunSpeedPacket } from "../spells/packets.ts";
import { SpellUnit, type SpellMap, type UnitPosition, type UnitStatHost } from "../spells/unit.ts";
import { CREATURE_FLAG_EXTRA_TRIGGER, CREATURE_TYPE_TOTEM } from "./constants.ts";
import type { CreatureUnit } from "./combat-world.ts";
import { isWorldBoss, type CreatureInfo } from "./creature.ts";
import type { FactionStore, ReactionPlayer } from "./faction.ts";
import type { Point } from "./formulas.ts";
import type { MovementOwner } from "../game/Movement/MovementOwner.ts";

const f = Math.fround;

const OBJECT_END = 0x0006;
export const UNIT_FIELD_CHANNEL_OBJECT = OBJECT_END + 0x000e;
export const UNIT_CHANNEL_SPELL = OBJECT_END + 0x0010;
const UNIT_FIELD_POWER1 = OBJECT_END + 0x0013;
const UNIT_FIELD_MAXHEALTH = OBJECT_END + 0x001a;
const UNIT_FIELD_MAXPOWER1 = OBJECT_END + 0x001b;
export const UNIT_FIELD_AURASTATE = OBJECT_END + 0x0037;
const UNIT_FIELD_RESISTANCES = OBJECT_END + 0x005d;

/** `SMSG_SPLINE_MOVE_ROOT` / `SMSG_SPLINE_MOVE_UNROOT` */
const SMSG_SPLINE_MOVE_ROOT = 0x31a;
const SMSG_SPLINE_MOVE_UNROOT = 0x304;
/** `SMSG_SPLINE_SET_*_SPEED` by `UnitMoveType` (run is `SMSG_SPLINE_SET_RUN_SPEED`). */
const SPLINE_SPEED_OPCODES = [0x301, 0x2fe, 0x2ff, 0x300, 0x303, 0x302, 0x385, 0x386, 0x3c1];
/** `CONFIG_WORLD_BOSS_LEVEL_DIFF` */
const WORLD_BOSS_LEVEL_DIFF = 3;
/** The placeholder spell id `Creature::LoadTemplateImmunities` registers template immunities under. */
const TEMPLATE_IMMUNITY_SPELL = 0xffffffff;

/** The creature side of the map the combat world provides (`Map`, `Creature`, and `CreatureAI` hooks). */
export interface CreatureWorld extends SpellMap {
  readonly factions: FactionStore;
  creaturePosition(unit: CreatureUnit): Point & { o: number };
  creatureSendToViewers(unit: CreatureUnit, opcode: number, body: Uint8Array): void;
  /** `Unit::DealDamage` on the creature: tap, threat, player damage requirement, and `Unit::Kill`. Returns true on death. */
  creatureTakeDamage(unit: CreatureUnit, attacker: SpellUnit | null, damage: number): boolean;
  /** `Unit::EngageWithTarget` / `CreatureAI::AttackStart` */
  creatureEngage(unit: CreatureUnit, enemy: SpellUnit): void;
  /** `ThreatManager::AddThreat` (only players are on creature threat lists). */
  creatureAddThreat(unit: CreatureUnit, attacker: SpellUnit, amount: number): void;
  /** Values update of the listed fields to every viewer. */
  creatureFieldsChanged(unit: CreatureUnit, fields: { index: number; value: number }[]): void;
  /** `Unit::AttackStop`: true when the creature had a victim. */
  creatureAttackStop(unit: CreatureUnit): boolean;
  /** `Unit::StopMoving` (root and stun). */
  creatureStopMoving(unit: CreatureUnit): void;
  /** `Unit::NearTeleportTo` */
  creatureNearTeleport(unit: CreatureUnit, position: { x: number; y: number; z: number; o: number }): void;
  creatureVictim(unit: CreatureUnit): SpellUnit | null;
  creatureUnitFlags(unit: CreatureUnit): number;
  /** `MotionMaster::propagateSpeedChange` after the spell unit changed a speed rate. */
  creaturePropagateSpeedChange(unit: CreatureUnit): void;

  // What a `Creature` linked to this unit (`Creature::m_combatUnit`) asks for the `Unit` members the movement code calls.
  /** `Unit::GetVictim`: the map object of the player the creature attacks. */
  creatureVictimObject(unit: CreatureUnit): MovementOwner | null;
  /** `Unit::Attack`: the combat world sets the victim, sends `SMSG_ATTACKSTART` and the target fields. */
  creatureAttack(unit: CreatureUnit, victim: MovementOwner, meleeAttack: boolean): boolean;
  /** `Unit::EngageWithTarget` */
  creatureEngageWithTarget(unit: CreatureUnit, target: MovementOwner): void;
  /** `Unit::IsValidAttackTarget` */
  creatureIsValidAttackTarget(unit: CreatureUnit, target: MovementOwner): boolean;
  /** `CreatureAI::_EnterEvadeMode`: the combat world's part (threat list, tap, damage requirement, auras, packets). */
  creatureEvadeCombat(unit: CreatureUnit): void;
  /** `ObjectAccessor::GetUnit`: a player in this world or a creature spawn. */
  creatureUnitObject(unit: CreatureUnit, guid: bigint): MovementOwner | null;
  /** `Creature::SetNoCallAssistance` */
  creatureSetNoCallAssistance(unit: CreatureUnit, value: boolean): void;
  /** `Creature::CallAssistance` */
  creatureCallAssistance(unit: CreatureUnit): void;
}

/** A unit whose faction standing `FactionStore` can resolve (players). */
export type ReactionSource = { reactionPlayer(): ReactionPlayer };

/**
 * `Creature` stat system (`StatSystem.cpp`, creature section): the aura modifier groups over the template values
 * `Creature::UpdateEntry` stores, and the fields they drive.
 */
export class CreatureStats implements UnitStatHost {
  private readonly flatMods = Array.from({ length: E.UNIT_MOD_END }, () => [0, 0]);
  private readonly pctMods = Array.from({ length: E.UNIT_MOD_END }, () => [1, 1]);
  private readonly modAttackSpeedPct = [1, 1, 1];
  private castSpeedValue = 1;
  private readonly resistances = [0, 0, 0, 0, 0, 0, 0];
  private readonly statBuff: [number, number][] = [[0, 0], [0, 0], [0, 0], [0, 0], [0, 0]];
  maxHealth: number;
  maxPower: number[] = [0, 0, 0, 0, 0, 0, 0];
  attackPower = [0, 0];
  attackPowerMods = [0, 0];
  attackPowerMultiplier = [0, 0];
  private canParryValue = true;
  private canBlockValue = true;
  private canDualWieldValue = false;
  modSpellHitChance = 0;
  modMeleeHitChance = 0;
  modRangedHitChance = 0;

  constructor(
    private readonly info: CreatureInfo,
    private readonly changed: (fields: { index: number; value: number }[]) => void,
  ) {
    this.maxHealth = info.maxHealth;
    this.flatMods[E.UNIT_MOD_HEALTH]![E.BASE_VALUE] = info.maxHealth;
    this.flatMods[E.UNIT_MOD_MANA]![E.BASE_VALUE] = info.maxMana;
    this.maxPower[0] = info.maxMana;
    for (let school = 0; school < 7; school++) {
      this.flatMods[E.UNIT_MOD_RESISTANCE_START + school]![E.BASE_VALUE] = info.resistances[school] ?? 0;
      this.resistances[school] = info.resistances[school] ?? 0;
    }
    this.flatMods[E.UNIT_MOD_ATTACK_POWER]![E.BASE_VALUE] = info.attackPower;
    this.attackPower[0] = info.attackPower;
  }

  get castSpeed(): number {
    return this.castSpeedValue;
  }

  /** `Unit::GetTotalAuraModValue` */
  private totalAuraModValue(unitMod: number): number {
    if (this.pctMods[unitMod]![E.TOTAL_PCT]! <= 0) return 0;
    let value = f(this.flatMods[unitMod]![E.BASE_VALUE]! * this.pctMods[unitMod]![E.BASE_PCT]!);
    value = f(value + this.flatMods[unitMod]![E.TOTAL_VALUE]!);
    return f(value * this.pctMods[unitMod]![E.TOTAL_PCT]!);
  }

  handleStatFlatModifier(unitMod: number, modifierType: number, amount: number, apply: boolean): void {
    if (!amount) return;
    this.flatMods[unitMod]![modifierType] = f(this.flatMods[unitMod]![modifierType]! + (apply ? amount : -amount));
    this.updateUnitMod(unitMod);
  }

  setStatFlatModifier(unitMod: number, modifierType: number, value: number): void {
    if (this.flatMods[unitMod]![modifierType] === value) return;
    this.flatMods[unitMod]![modifierType] = f(value);
    this.updateUnitMod(unitMod);
  }

  applyStatPctModifier(unitMod: number, modifierType: number, pct: number): void {
    if (!pct) return;
    const current = this.pctMods[unitMod]![modifierType]!;
    this.pctMods[unitMod]![modifierType] = f(current + (current * pct) / 100);
    this.updateUnitMod(unitMod);
  }

  setStatPctModifier(unitMod: number, modifierType: number, value: number): void {
    if (this.pctMods[unitMod]![modifierType] === value) return;
    this.pctMods[unitMod]![modifierType] = f(value);
    this.updateUnitMod(unitMod);
  }

  getPctModifierValue(unitMod: number, modifierType: number): number {
    return this.pctMods[unitMod]![modifierType]!;
  }

  getFlatModifierValue(unitMod: number, modifierType: number): number {
    return this.flatMods[unitMod]![modifierType]!;
  }

  /** `Unit::UpdateUnitMod` → the `Creature::Update*` for the group. */
  private updateUnitMod(unitMod: number): void {
    if (unitMod < E.UNIT_MOD_STAT_END) return; // `Creature::UpdateStats` does nothing.
    if (unitMod === E.UNIT_MOD_HEALTH) {
      this.maxHealth = Math.trunc(this.totalAuraModValue(E.UNIT_MOD_HEALTH));
      this.changed([{ index: UNIT_FIELD_MAXHEALTH, value: this.maxHealth }]);
      return;
    }
    if (unitMod >= E.UNIT_MOD_POWER_START && unitMod < E.UNIT_MOD_POWER_END) {
      const power = unitMod - E.UNIT_MOD_POWER_START;
      this.maxPower[power] = Math.trunc(this.totalAuraModValue(unitMod));
      this.changed([{ index: UNIT_FIELD_MAXPOWER1 + power, value: this.maxPower[power]! }]);
      return;
    }
    if (unitMod >= E.UNIT_MOD_RESISTANCE_START && unitMod < E.UNIT_MOD_RESISTANCE_END) {
      const school = unitMod - E.UNIT_MOD_RESISTANCE_START;
      this.resistances[school] = Math.trunc(this.totalAuraModValue(unitMod));
      this.changed([{ index: UNIT_FIELD_RESISTANCES + school, value: this.resistances[school]! >>> 0 }]);
      return;
    }
    if (unitMod === E.UNIT_MOD_ATTACK_POWER || unitMod === E.UNIT_MOD_ATTACK_POWER_RANGED) {
      const ranged = unitMod === E.UNIT_MOD_ATTACK_POWER_RANGED ? 1 : 0;
      this.attackPower[ranged] = Math.trunc(f(this.flatMods[unitMod]![E.BASE_VALUE]! * this.pctMods[unitMod]![E.BASE_PCT]!));
      this.attackPowerMods[ranged] = Math.trunc(this.flatMods[unitMod]![E.TOTAL_VALUE]!);
      this.attackPowerMultiplier[ranged] = f(this.pctMods[unitMod]![E.TOTAL_PCT]! - 1);
    }
  }

  /** `Unit::UpdateStatBuffMod` (creatures keep the values; the client does not show them). */
  updateStatBuffMod(stat: number, positive: number, negative: number): void {
    this.statBuff[stat] = [positive, negative];
  }

  updateResistanceBuffModsMod(_school: number, _positive: number, _negative: number): void {}

  updateSpellDamageAndHealingBonus(): void {}

  applyModDamageDoneField(): void {}

  setModDamageDonePctField(): void {}

  getStat(_stat: number): number {
    return 0;
  }

  getArmor(): number {
    return this.resistances[0]!;
  }

  getResistance(school: number): number {
    return this.resistances[school]!;
  }

  /** `Unit::GetTotalAttackPowerValue` */
  getTotalAttackPowerValue(attType: number): number {
    const ranged = attType === 2 ? 1 : 0;
    const ap = this.attackPower[ranged]! + this.attackPowerMods[ranged]!;
    return ap < 0 ? 0 : f(ap * (1 + this.attackPowerMultiplier[ranged]!));
  }

  applyTargetResistanceField(): void {}

  baseSpellDamageBonus(): number {
    return 0;
  }

  baseSpellHealingBonus(): number {
    return 0;
  }

  spellPenetrationItemMod(): number {
    return 0;
  }

  /** `m_baseSpellCritChance` */
  spellCritChance(_school: number): number | null {
    return 5;
  }

  weaponCritChance(_attType: number): number | null {
    return null;
  }

  ratingBonus(_rating: number): number {
    return 0;
  }

  /** `Unit::GetMaxSkillValueForLevel` */
  maxSkillValueForLevel(target: SpellUnit | null): number {
    return (target ? this.levelFor(target) : this.info.level) * 5;
  }

  /** `Creature::GetWeaponSkillValue` → `GetMaxSkillValueForLevel` */
  weaponSkillValue(_attType: number, target: SpellUnit | null): number {
    return this.maxSkillValueForLevel(target);
  }

  defenseSkillValue(target: SpellUnit | null): number {
    return this.maxSkillValueForLevel(target);
  }

  private levelFor(target: SpellUnit): number {
    if (!isWorldBoss(this.info.typeFlags)) return this.info.level;
    return Math.min(255, Math.max(1, target.level + WORLD_BOSS_LEVEL_DIFF));
  }

  dodgeChance(): number {
    return isWorldBoss(this.info.typeFlags) ? 5.85 : 5;
  }

  parryChance(): number {
    return isWorldBoss(this.info.typeFlags) ? 13.4 : 0;
  }

  blockChance(): number {
    return 5;
  }

  missFromDefense(): number {
    return 0;
  }

  expertiseDodgeOrParryReduction(_attType: number): number {
    return 0;
  }

  /** `Creature::GetShieldBlockValue` */
  shieldBlockValue(): number {
    return Math.trunc(this.info.level / 2);
  }

  /** `Unit::CalculateDamage` → `Creature::CalculateMinMaxDamage` (creatures have one damage entry). */
  weaponDamage(attType: number, normalized: boolean, addTotalPct: boolean): number {
    const range = this.minMaxDamage(attType, normalized, addTotalPct);
    return Math.trunc(range.min + Math.random() * (Math.trunc(range.max) - Math.trunc(range.min) + 1));
  }

  /** `Creature::CalculateMinMaxDamage` */
  minMaxDamage(attType: number, normalized: boolean, addTotalPct: boolean): { min: number; max: number } {
    if (attType === 1) return { min: 0, max: 0 };
    const unitMod = attType === 2 ? E.UNIT_MOD_DAMAGE_RANGED : E.UNIT_MOD_DAMAGE_MAINHAND;
    const variance = this.info.baseVariance;
    const weaponMin = this.info.baseDamage;
    const weaponMax = this.info.baseDamage * 1.5;
    const attackPower = this.getTotalAttackPowerValue(attType);
    const attackSpeedMulti = normalized ? 2.4 : this.attackTime(attType) / 1000;
    const baseValue = f(this.flatMods[unitMod]![E.BASE_VALUE]! + (attackPower / 14) * variance);
    const basePct = f(this.pctMods[unitMod]![E.BASE_PCT]! * attackSpeedMulti);
    const totalValue = this.flatMods[unitMod]![E.TOTAL_VALUE]!;
    const totalPct = addTotalPct ? this.pctMods[unitMod]![E.TOTAL_PCT]! : 1;
    const dmgMultiplier = this.info.damageModifier;
    let min = f(((weaponMin + baseValue) * dmgMultiplier * basePct + totalValue) * totalPct);
    let max = f(((weaponMax + baseValue) * dmgMultiplier * basePct + totalValue) * totalPct);
    if (min < 0 || min > 1e9) min = 0;
    if (max < 0 || max > 1e9) max = 0;
    if (min > max) min = max;
    return { min, max };
  }

  /** `Unit::GetAttackTime` */
  attackTime(attType: number): number {
    return Math.trunc(this.info.attackTime / this.modAttackSpeedPct[attType === 2 ? 2 : attType]!);
  }

  hasOffhandWeapon(): boolean {
    return false;
  }

  /** `Unit::ApplyAttackTimePercentMod` */
  applyAttackTimePercentMod(attType: number, pct: number, apply: boolean): void {
    const current = this.modAttackSpeedPct[attType]!;
    this.modAttackSpeedPct[attType] = pct > 0 ? applyPercentMod(current, pct, !apply) : applyPercentMod(current, -pct, apply);
  }

  /** `Unit::ApplyCastTimePercentMod` */
  applyCastTimePercentMod(pct: number, apply: boolean): void {
    this.castSpeedValue = pct > 0 ? applyPercentMod(this.castSpeedValue, pct, !apply) : applyPercentMod(this.castSpeedValue, -pct, apply);
  }

  weaponForAttack(_attType: number): { inventoryType: number; subClass: number } | null {
    return null;
  }

  canParry(): boolean {
    return this.canParryValue;
  }

  canBlock(): boolean {
    return this.canBlockValue;
  }

  canDualWield(): boolean {
    return this.canDualWieldValue;
  }

  setCanParry(on: boolean): void {
    this.canParryValue = on;
  }

  setCanBlock(on: boolean): void {
    this.canBlockValue = on;
  }

  setCanDualWield(on: boolean): void {
    this.canDualWieldValue = on;
  }

  updateManaRegen(): void {}
}

/** `ApplyPercentModFloatVar` */
function applyPercentMod(value: number, pct: number, apply: boolean): number {
  if (pct === -100) pct = -99.99;
  return f(value * (apply ? (100 + pct) / 100 : 100 / (100 + pct)));
}

/** A live creature as the spell and aura code sees it (`Creature` : `Unit`). */
export class CreatureSpellUnit extends SpellUnit {
  readonly isPlayer = false;
  readonly stats: CreatureStats;
  private power0: number;
  private flags = 0;
  private auraState = 0;
  private stand = 0;

  constructor(
    readonly world: CreatureWorld,
    readonly unit: CreatureUnit,
  ) {
    super();
    this.stats = new CreatureStats(unit.info, (fields) => this.world.creatureFieldsChanged(this.unit, fields));
    this.power0 = unit.info.maxMana;
    this.speedRate[E.MOVE_RUN] = unit.info.runSpeed / 7;
    // the map object's speeds (`Creature::InitEntry` `SetSpeed`) are the start of the aura modifiers
    const creature = unit.creature;
    if (creature) for (let type = 0; type < this.speedRate.length; type++) this.speedRate[type] = creature.getSpeedRate(type);
    this.loadTemplateImmunities();
  }

  get guid(): bigint {
    return this.unit.info.guid;
  }

  /** `Creature::LoadTemplateImmunities` */
  private loadTemplateImmunities(): void {
    const immunities = this.world.spells.creatureImmunities(this.unit.info.entry);
    if (!immunities) return;
    for (let school = 0; school < 7; school++) if (immunities.school & (1 << school)) this.applySpellImmune(TEMPLATE_IMMUNITY_SPELL, E.IMMUNITY_SCHOOL, 1 << school, true);
    for (let dispel = 0; dispel < 16; dispel++) if (immunities.dispelType & (1 << dispel)) this.applySpellImmune(TEMPLATE_IMMUNITY_SPELL, E.IMMUNITY_DISPEL, dispel, true);
    for (let mechanic = 0; mechanic < 64; mechanic++) if (immunities.mechanic & (1n << BigInt(mechanic))) this.applySpellImmune(TEMPLATE_IMMUNITY_SPELL, E.IMMUNITY_MECHANIC, mechanic, true);
    for (const effect of immunities.effects) this.applySpellImmune(TEMPLATE_IMMUNITY_SPELL, E.IMMUNITY_EFFECT, effect, true);
    for (const aura of immunities.auras) this.applySpellImmune(TEMPLATE_IMMUNITY_SPELL, E.IMMUNITY_STATE, aura, true);
  }

  get info(): CreatureInfo {
    return this.unit.info;
  }

  get entry(): number {
    return this.unit.info.entry;
  }

  get level(): number {
    return this.unit.info.level;
  }

  get classId(): number {
    return this.unit.info.unitClass;
  }

  get inWorld(): boolean {
    return this.unit.deathState !== "dead";
  }

  position(): UnitPosition {
    const pos = this.world.creaturePosition(this.unit);
    return { map: this.unit.info.map, x: pos.x, y: pos.y, z: pos.z, o: pos.o };
  }

  get combatReach(): number {
    return this.unit.info.combatReach;
  }

  override collisionHeight(): number {
    const info = this.unit.info;
    return GetCollisionHeight({ scale: info.scale ?? 1, nativeDisplayId: info.displayId ?? 0, mountDisplayId: 0 });
  }

  override get phaseMask(): number {
    return this.unit.info.phaseMask;
  }

  get boundingRadius(): number {
    return this.unit.info.boundingRadius;
  }

  isAlive(): boolean {
    return this.unit.deathState === "alive";
  }

  get health(): number {
    return this.unit.health;
  }

  get maxHealth(): number {
    return this.stats.maxHealth;
  }

  setHealth(value: number): void {
    const next = Math.max(0, Math.min(this.maxHealth, Math.trunc(value)));
    if (next === this.unit.health) return;
    this.unit.health = next;
    this.world.creatureFieldsChanged(this.unit, [{ index: OBJECT_END + 0x0012, value: next }]);
  }

  get createHealth(): number {
    return this.unit.info.maxHealth;
  }

  get createMana(): number {
    return this.unit.info.maxMana;
  }

  /** `UNIT_FIELD_BYTES_0` power type: mana when the template has mana, else rage-less 0. */
  get powerType(): number {
    return E.POWER_MANA;
  }

  power(power: number): number {
    return power === E.POWER_MANA ? this.power0 : 0;
  }

  maxPower(power: number): number {
    return this.stats.maxPower[power] ?? 0;
  }

  setPower(power: number, value: number): void {
    if (power !== E.POWER_MANA) return;
    const next = Math.max(0, Math.min(this.maxPower(power), Math.trunc(value)));
    if (next === this.power0) return;
    this.power0 = next;
    this.world.creatureFieldsChanged(this.unit, [{ index: UNIT_FIELD_POWER1, value: next }]);
  }

  get unitFlags(): number {
    return (this.unit.info.unitFlags | this.flags) >>> 0;
  }

  /** Aura-driven `UNIT_FIELD_FLAGS` bits (stun, silence, pacify, ...). */
  get auraUnitFlags(): number {
    return this.flags;
  }

  setUnitFlag(flag: number, on: boolean): void {
    const next = on ? this.flags | flag : this.flags & ~flag;
    if (next === this.flags) return;
    this.flags = next;
    this.world.creatureFieldsChanged(this.unit, [{ index: OBJECT_END + 0x0035, value: this.world.creatureUnitFlags(this.unit) }]);
  }

  get auraStateField(): number {
    return this.auraState;
  }

  set auraStateField(value: number) {
    if (value === this.auraState) return;
    this.auraState = value;
    this.world.creatureFieldsChanged(this.unit, [{ index: UNIT_FIELD_AURASTATE, value }]);
  }

  /** `Unit::GetReactionTo` */
  reactionTo(target: SpellUnit): number {
    if (target === this) return 4 /* REP_FRIENDLY */;
    if (target.isPlayer) return this.world.factions.creatureToPlayer(this.unit.info.factionTemplate, (target as unknown as ReactionSource).reactionPlayer());
    if (target instanceof CreatureSpellUnit) return this.world.factions.creatureToCreature(this.unit.info.factionTemplate, target.unit.info.factionTemplate);
    return 3 /* REP_NEUTRAL */;
  }

  isInCombat(): boolean {
    return this.unit.threat.size > 0;
  }

  setInCombatWith(enemy: SpellUnit): void {
    this.world.creatureEngage(this.unit, enemy);
  }

  override engageWithTarget(enemy: SpellUnit): void {
    this.world.creatureEngage(this.unit, enemy);
  }

  get creatureType(): number {
    return this.unit.info.type;
  }

  isGameMaster(): boolean {
    return false;
  }

  isInFlight(): boolean {
    return false;
  }

  isMounted(): boolean {
    return false;
  }

  isMoving(): boolean {
    return this.unit.creature?.isMoving() ?? false;
  }

  isEvading(): boolean {
    return this.unit.evading;
  }

  get shapeshiftForm(): number {
    return 0;
  }

  get standState(): number {
    return this.stand;
  }

  setStandState(state: number): void {
    this.stand = state;
  }

  get isTotem(): boolean {
    return this.unit.info.type === CREATURE_TYPE_TOTEM;
  }

  sendToSelf(): void {}

  sendToSet(opcode: number, body: Uint8Array): void {
    this.world.creatureSendToViewers(this.unit, opcode, body);
  }

  receiveDamage(attacker: SpellUnit | null, damage: number): boolean {
    return this.world.creatureTakeDamage(this.unit, attacker, damage);
  }

  addThreat(attacker: SpellUnit, amount: number): void {
    this.world.creatureAddThreat(this.unit, attacker, amount);
  }

  /** `ThreatManager::ModifyThreatByPercent` */
  modifyThreatPercent(attacker: SpellUnit, percent: number): void {
    if (!attacker.isPlayer) return;
    const key = Number(attacker.guid & 0xffffffffn);
    const threat = this.unit.threat.get(key);
    if (threat === undefined) return;
    this.unit.threat.set(key, percent > -100 ? (threat * (100 + percent)) / 100 : 0);
  }

  forwardThreatForAssistingMe(): void {}

  /** `ThreatManager::TauntUpdate` */
  taunt(taunter: SpellUnit, apply: boolean): void {
    if (!taunter.isPlayer) return;
    const key = Number(taunter.guid & 0xffffffffn);
    const list = this.unit.taunts;
    const index = list.indexOf(key);
    if (index >= 0) list.splice(index, 1);
    if (apply) {
      list.push(key);
      if (!this.unit.threat.has(key)) this.world.creatureAddThreat(this.unit, taunter, 0);
    }
  }

  attackStop(): void {
    this.world.creatureAttackStop(this.unit);
  }

  /** `Unit::SetSpeed` → `SMSG_SPLINE_SET_*_SPEED` for a unit without a controlling client. */
  sendSpeed(moveType: number, speed: number): void {
    // `Unit::SetSpeed` -> `propagateSpeedChange`: the generators recompute their splines with the new speed
    this.world.creaturePropagateSpeedChange(this.unit);
    const opcode = SPLINE_SPEED_OPCODES[moveType];
    if (opcode === undefined) return;
    this.sendToSet(opcode, splineSetRunSpeedPacket(this.guid, speed));
  }

  sendRoot(rooted: boolean): void {
    if (rooted) this.world.creatureStopMoving(this.unit);
    this.sendToSet(rooted ? SMSG_SPLINE_MOVE_ROOT : SMSG_SPLINE_MOVE_UNROOT, packedGuid(this.guid));
  }

  get comboPoints(): number {
    return 0;
  }

  get comboTarget(): bigint {
    return 0n;
  }

  addComboPoints(): void {}

  clearComboPoints(): void {}

  startCooldownOnEvent(): void {}

  isInPartyWith(other: SpellUnit): boolean {
    return other === this;
  }

  charmerOrOwner(): SpellUnit | null {
    return null;
  }

  victim(): SpellUnit | null {
    return this.world.creatureVictim(this.unit);
  }

  nearTeleportTo(x: number, y: number, z: number, orientation: number): void {
    this.world.creatureNearTeleport(this.unit, { x, y, z, o: orientation });
  }

  // ---- Creature overrides

  override creatureFlagsExtra(): number {
    return this.unit.info.flagsExtra;
  }

  override isTrigger(): boolean {
    return (this.unit.info.flagsExtra & CREATURE_FLAG_EXTRA_TRIGGER) !== 0;
  }

  override creatureExpansion(): number {
    return this.unit.info.expansion;
  }

  /** `Creature::GetLevelForTarget` */
  override levelForTarget(target: SpellUnit): number {
    if (!isWorldBoss(this.unit.info.typeFlags)) return this.level;
    return Math.min(255, Math.max(1, target.level + WORLD_BOSS_LEVEL_DIFF));
  }

  override canHaveThreatList(): boolean {
    return !this.isTotem;
  }

  /** `ThreatManager::MatchUnitThreatToHighestThreat` */
  override matchUnitThreatToHighestThreat(target: SpellUnit): void {
    if (!target.isPlayer || !this.unit.threat.size) return;
    let highest = 0;
    for (const value of this.unit.threat.values()) if (value > highest) highest = value;
    this.unit.threat.set(Number(target.guid & 0xffffffffn), highest);
  }

  override resetAttackTimers(): void {
    this.unit.attackTimer = this.stats.attackTime(0);
  }

  override isTappedBy(player: SpellUnit): boolean {
    return this.unit.lootRecipient === null || BigInt(this.unit.lootRecipient) === player.guid;
  }

  override immuneToAoE(): boolean {
    return this.world.spells.creatureImmunities(this.unit.info.entry)?.immuneAoE ?? false;
  }

  override immuneToChain(): boolean {
    return this.world.spells.creatureImmunities(this.unit.info.entry)?.immuneChain ?? false;
  }

  /** `Unit::CheckAttackFitToAuraRequirement` (creatures have no weapon requirement). */
  override checkAttackFitToAuraRequirement(_attType: number, _aurEff: AuraEffect): boolean {
    return true;
  }

  /** `creature_template.speed_run` */
  protected override templateRunSpeed(): number {
    return this.unit.info.runSpeed / 7;
  }

  /** `Unit::UpdateSpeed`: 1.66% slower for each health percent under 30 (not snare-immune templates or dungeon bosses). */
  protected override slowFromHealth(): number {
    if (this.unit.info.flagsExtra & 0x10000000 /* CREATURE_FLAG_EXTRA_DUNGEON_BOSS */) return 0;
    const immunities = this.world.spells.creatureImmunities(this.unit.info.entry);
    if (immunities && immunities.mechanic & (1n << BigInt(E.MECHANIC_SNARE))) return 0;
    return Math.trunc(Math.min(0, 1.66 * (this.healthPct() - 30)));
  }

  override rangedAttackSpeedPct(): number {
    return 1;
  }

  protected override onChannelChanged(): void {
    const guid = this.channelObject;
    this.world.creatureFieldsChanged(this.unit, [
      { index: UNIT_FIELD_CHANNEL_OBJECT, value: Number(guid & 0xffffffffn) },
      { index: UNIT_FIELD_CHANNEL_OBJECT + 1, value: Number((guid >> 32n) & 0xffffffffn) },
      { index: UNIT_CHANNEL_SPELL, value: this.channelSpell },
    ]);
  }
}
