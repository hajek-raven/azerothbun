import { ByteWriter } from "../net/byte-buffer.ts";
import { packedGuid } from "../world/update-object.ts";
import { Aura, AuraApplication, AuraEffect } from "./aura.ts";
import {
  SPELL_ATTR0_NO_IMMUNITIES,
  SPELL_ATTR0_ONLY_INDOORS,
  SPELL_ATTR0_ONLY_OUTDOORS,
  SPELL_ATTR1_IMMUNITY_TO_HOSTILE_AND_FRIENDLY_EFFECTS,
  SPELL_ATTR2_NO_SCHOOL_IMMUNITIES,
  SPELL_ATTR3_ALWAYS_HIT,
  SPELL_ATTR4_NO_PARTIAL_IMMUNITY,
  SPELL_ATTR4_OWNER_POWER_SCALING,
  SPELL_ATTR7_DISABLE_AURA_WHILE_DEAD,
  SPELL_AURA_ABILITY_IGNORE_AURASTATE,
  SPELL_AURA_MOD_DECREASE_SPEED,
  SPELL_AURA_MOD_IMMUNE_AURA_APPLY_SCHOOL,
  SPELL_AURA_MOD_INCREASE_SPEED,
  SPELL_AURA_MOD_MINIMUM_SPEED,
  SPELL_AURA_MOD_SPEED_ALWAYS,
  SPELL_AURA_MOD_SPEED_NOT_STACK,
  SPELL_AURA_MOD_INCREASE_SWIM_SPEED,
  SPELL_AURA_USE_NORMAL_MOVEMENT_SPEED,
  SPELL_AURA_MOD_INCREASE_MOUNTED_SPEED,
  SPELL_AURA_MOD_MOUNTED_SPEED_ALWAYS,
  SPELL_AURA_MOD_MOUNTED_SPEED_NOT_STACK,
  SPELL_AURA_SPIRIT_OF_REDEMPTION,
  SPELL_AURA_TRANSFORM,
  SPELL_AURA_ARENA_PREPARATION,
  SPELL_AURA_MOD_STUN,
  SPELL_AURA_MOD_ROOT,
  SPELL_AURA_MOD_COOLDOWN,
  SPELL_ATTR5_NO_REAGENT_COST_WITH_AURA,
  SPELL_FAILED_SPELL_UNAVAILABLE,
} from "./defines.ts";
import {
  AURA_EFFECT_HANDLE_REAL,
  AURA_INTERRUPT_FLAG_NOT_SEATED,
  AURA_REMOVE_BY_DEATH,
  AURA_REMOVE_BY_DEFAULT,
  AURA_STATE_CONFLAGRATE,
  AURA_STATE_DEADLY_POISON,
  AURA_STATE_ENRAGE,
  CURRENT_AUTOREPEAT_SPELL,
  CURRENT_CHANNELED_SPELL,
  CURRENT_GENERIC_SPELL,
  CURRENT_MELEE_SPELL,
  IMMUNITY_ALLOW_ID,
  IMMUNITY_DAMAGE,
  IMMUNITY_DISPEL,
  IMMUNITY_EFFECT,
  IMMUNITY_ID,
  IMMUNITY_MECHANIC,
  IMMUNITY_SCHOOL,
  IMMUNITY_STATE,
  MOVE_FLIGHT,
  MOVE_FLIGHT_BACK,
  MOVE_RUN,
  MOVE_RUN_BACK,
  MOVE_SWIM,
  MOVE_SWIM_BACK,
  MOVE_WALK,
  POWER_MANA,
  SPELL_ATTR0_CU_BYPASS_MECHANIC_IMMUNITY,
  SPELL_GROUP_STACK_RULE_EXCLUSIVE_HIGHEST,
  SPELL_SCHOOL_MASK_NONE,
  SPELL_STATE_FINISHED,
  UNIT_FLAG_CONFUSED,
  UNIT_FLAG_FLEEING,
  UNIT_FLAG_PACIFIED,
  UNIT_FLAG_PLAYER_CONTROLLED,
  UNIT_FLAG_SILENCED,
  UNIT_FLAG_STUNNED,
  UNIT_STATE_CASTING,
  UNIT_STATE_ROOT,
  UNIT_STATE_STUNNED,
  UNIT_STAND_STATE_SIT,
  UNIT_FLAG_PREPARATION,
  TRIGGERED_FULL_MASK,
  TRIGGERED_IGNORE_SPELL_AND_CATEGORY_CD,
} from "./enums.ts";
import {
  canSpellProvideImmunityAgainstAura,
  hasAttribute,
  hasAura,
  hasCustomAttribute,
  isAllowingDeadTarget,
  isDeathPersistent,
  isMultiSlotAura,
  isPassive,
  isPositive,
  allEffectsMechanicMask,
  spellMaxDuration,
  dispelMask,
  calcSpellDuration,
  isCooldownStartedOnEvent,
  maxRange,
  minRange,
  type PowerCostCaster,
  type SpellInfo,
} from "./spell-info.ts";
import type { SpellStore } from "./spell-info.ts";
import { emptyTargets, SMSG_CLEAR_COOLDOWN, TARGET_FLAG_DEST_LOCATION, TARGET_FLAG_UNIT, type CastTargets } from "./packets.ts";
import { Spell, type CastItem } from "./spell.ts";
import * as UnitMath from "./unit-math.ts";
import { DEFAULT_COLLISION_HEIGHT } from "../game/Entities/Object/ObjectDefines.ts";
import { isWithinLOS, isWithinLOSInMap, type LineOfSightObject } from "../game/Maps/MapLineOfSight.ts";
import { LINEOFSIGHT_ALL_CHECKS, ModelIgnoreFlags } from "../game/Grids/MapLike.ts";

export type Point = { x: number; y: number; z: number };
export type UnitPosition = Point & { map: number; o: number };

/** The map a spell runs on: unit lookup, area searches, and game time. */
export interface SpellMap {
  readonly spells: SpellStore;
  /** Game time in milliseconds. */
  now(): number;
  unit(guid: bigint): SpellUnit | null;
  /** Units on `reference`'s map whose position lies within `radius` of `center` (default: `reference`). */
  unitsInRange(reference: SpellUnit, radius: number, center?: Point): SpellUnit[];
  /** `ThreatManager::_threatenedByMe`: the creatures whose threat list holds `unit`. */
  threatenedBy?(unit: SpellUnit): SpellUnit[];
}

/** `playerBaseMoveSpeed` / `baseMoveSpeed` indexed by `UnitMoveType`. */
export const BASE_MOVE_SPEED = [2.5, 7, 4.5, 4.722222, 2.5, 3.141594, 7, 4.5, 3.14];

/** `LEEWAY_BONUS_RANGE` */
const LEEWAY_BONUS_RANGE = 2.66;
/** `infinityCooldownDelay` (a month, in milliseconds). */
const INFINITY_COOLDOWN_DELAY = 30 * 24 * 3600 * 1000;
const SMSG_COOLDOWN_EVENT = 0x135;

const PER_CASTER_AURA_STATE_MASK = (1 << (AURA_STATE_CONFLAGRATE - 1)) | (1 << (AURA_STATE_DEADLY_POISON - 1));
const SPELL_AURA_OF_DESPAIR_1 = 62692;
const SPELL_AURA_OF_DESPAIR_2 = 64848;

/** A `DamageInfo` in flight through `CalcAbsorbResist`. */
export type DamageInfo = {
  attacker: SpellUnit | null;
  victim: SpellUnit;
  damage: number;
  absorb: number;
  resist: number;
  schoolMask: number;
  spell: SpellInfo | null;
  damageType: number;
};

/** Options for `Unit::CastSpell`. */
export type CastOptions = {
  triggered?: boolean;
  triggerFlags?: number;
  originalCaster?: bigint;
  /** `CustomSpellValues` base points by effect index. */
  basePoints?: readonly (number | undefined)[];
  triggeredByAura?: AuraEffect | null;
  targets?: CastTargets;
  castCount?: number;
  castItem?: CastItem | null;
  /** `SpellCastTargets::SetDst` for triggered casts. */
  dest?: Point | null;
  /** The channel the triggering periodic aura belongs to (`TARGET_UNIT_CHANNEL_TARGET` / `TARGET_DEST_CHANNEL_TARGET`). */
  channelTarget?: { channelGuid: bigint; dest: Point | null } | null;
};

/**
 * The `Unit` side that the spell and aura code reads and writes. Players and creatures extend it; the base holds the
 * AzerothCore aura containers, immunity lists, aura states, controlled states, speed rates, and current spells.
 */
export abstract class SpellUnit {
  abstract readonly guid: bigint;
  abstract readonly isPlayer: boolean;
  abstract readonly world: SpellMap;

  readonly ownedAuras: Aura[] = [];
  readonly appliedAuras: AuraApplication[] = [];
  readonly modAuras = new Map<number, AuraEffect[]>();
  readonly interruptableAuras: AuraApplication[] = [];
  readonly auraStateAuras: { state: number; app: AuraApplication }[] = [];
  readonly visibleAuras = new Map<number, AuraApplication>();
  readonly singleCastAuras: Aura[] = [];
  /** `m_spellImmune[op]` as (value, spellId) pairs. */
  readonly spellImmune: [number, number][][] = Array.from({ length: 8 }, () => []);
  interruptMask = 0;
  removedAurasCount = 0;
  unitState = 0;
  /** `m_currentSpells[CURRENT_*_SPELL]` */
  readonly currentSpells: (Spell | null)[] = [null, null, null, null];
  /** Spells whose events still run (casting, channeling, or projectiles in flight). */
  readonly activeSpells = new Set<Spell>();
  /** `m_speed_rate` */
  readonly speedRate = [1, 1, 1, 1, 1, 1, 1, 1, 1];
  channelObject = 0n;
  channelSpell = 0;
  /** `m_lastSanctuaryTime` */
  lastSanctuaryTime = 0;

  // ------------------------------------------------------------------ host

  abstract get entry(): number;
  abstract get level(): number;
  abstract get classId(): number;
  abstract get inWorld(): boolean;
  abstract position(): UnitPosition;
  abstract get combatReach(): number;
  abstract get boundingRadius(): number;
  abstract isAlive(): boolean;
  abstract get health(): number;
  abstract get maxHealth(): number;
  /** `Unit::SetHealth` with its field update. */
  abstract setHealth(value: number): void;
  abstract get createHealth(): number;
  abstract get createMana(): number;
  abstract get powerType(): number;
  abstract power(power: number): number;
  abstract maxPower(power: number): number;
  /** `Unit::SetPower` with `SMSG_POWER_UPDATE`. */
  abstract setPower(power: number, value: number): void;
  abstract get unitFlags(): number;
  abstract setUnitFlag(flag: number, on: boolean): void;
  abstract get auraStateField(): number;
  abstract set auraStateField(value: number);
  /** `Unit::GetReactionTo` */
  abstract reactionTo(target: SpellUnit): number;
  abstract isInCombat(): boolean;
  /** `Unit::SetInCombatWith` / `EngageWithTarget` */
  abstract setInCombatWith(enemy: SpellUnit): void;
  abstract get creatureType(): number;
  abstract isGameMaster(): boolean;
  abstract isInFlight(): boolean;
  abstract isMounted(): boolean;
  abstract isMoving(): boolean;
  abstract isEvading(): boolean;
  abstract get shapeshiftForm(): number;
  abstract get standState(): number;
  abstract setStandState(state: number): void;
  abstract get isTotem(): boolean;
  /** `SMSG_*` to this player's client only (no-op for creatures). */
  abstract sendToSelf(opcode: number, body: Uint8Array): void;
  /** `WorldObject::SendMessageToSet` */
  abstract sendToSet(opcode: number, body: Uint8Array, self: boolean): void;
  /** Health loss, death, rewards, and creature threat for `Unit::DealDamage`. Returns true when the victim died. */
  abstract receiveDamage(attacker: SpellUnit | null, damage: number, spell: SpellInfo | null, damageType: number): boolean;
  /** `ThreatMgr::AddThreat` on this unit's threat list (creatures). */
  abstract addThreat(attacker: SpellUnit, amount: number): void;
  /** `Unit::GetThreatMgr().ModifyThreatByPercent` */
  abstract modifyThreatPercent(attacker: SpellUnit, percent: number): void;
  /** `ThreatMgr::ForwardThreatForAssistingMe` */
  abstract forwardThreatForAssistingMe(assistant: SpellUnit, amount: number): void;
  /** Taunt handlers (`TauntApply` / `TauntFadeOut`). */
  abstract taunt(taunter: SpellUnit, apply: boolean): void;
  abstract attackStop(): void;
  /** Speed and root packets for this unit's movement controller. */
  abstract sendSpeed(moveType: number, speed: number): void;
  abstract sendRoot(rooted: boolean): void;
  abstract get stats(): UnitStatHost;
  abstract get comboPoints(): number;
  abstract get comboTarget(): bigint;
  abstract addComboPoints(target: SpellUnit, count: number): void;
  abstract clearComboPoints(): void;
  /** Cooldown bookkeeping for `SPELL_ATTR0_COOLDOWN_ON_EVENT` auras. */
  abstract startCooldownOnEvent(info: SpellInfo, apply: boolean): void;
  /** `Unit::IsInPartyWith` / `IsInRaidWith` */
  abstract isInPartyWith(other: SpellUnit, raid: boolean): boolean;
  /** `GetCharmerOrOwner` */
  abstract charmerOrOwner(): SpellUnit | null;

  /** `Unit::GetCollisionHeight`: the default; players and creatures read the model of their display. */
  collisionHeight(): number {
    return DEFAULT_COLLISION_HEIGHT;
  }

  /** `WorldObject::GetPhaseMask` (the phase the unit is seen in). */
  get phaseMask(): number {
    return 1;
  }

  /** `WorldObject::GetInstanceId` (0 for a world map). */
  get instanceId(): number {
    return 0;
  }

  /** The place and size `WorldObject::IsWithinLOS` reads. */
  losObject(): LineOfSightObject {
    const at = this.position();
    return {
      map: at.map,
      instance: this.instanceId,
      phaseMask: this.phaseMask,
      isPlayer: this.isPlayer,
      x: at.x,
      y: at.y,
      z: at.z,
      collisionHeight: this.collisionHeight(),
      combatReach: this.combatReach,
    };
  }

  /** `WorldObject::IsWithinLOS` */
  isWithinLOS(x: number, y: number, z: number, ignoreFlags: number = ModelIgnoreFlags.Nothing, checks: number = LINEOFSIGHT_ALL_CHECKS): boolean {
    return isWithinLOS(this.losObject(), x, y, z, ignoreFlags, checks);
  }

  /** `WorldObject::IsWithinLOSInMap` */
  isWithinLOSInMap(target: SpellUnit, ignoreFlags: number = ModelIgnoreFlags.Nothing, checks: number = LINEOFSIGHT_ALL_CHECKS): boolean {
    return isWithinLOSInMap(this.losObject(), target.losObject(), ignoreFlags, checks);
  }

  get isCreature(): boolean {
    return !this.isPlayer;
  }

  get castSpeed(): number {
    return this.stats.castSpeed;
  }

  /** `IsControlledByPlayer` */
  isControlledByPlayer(): boolean {
    return (this.unitFlags & UNIT_FLAG_PLAYER_CONTROLLED) !== 0;
  }

  creatureTypeMask(): number {
    return this.creatureType ? 1 << (this.creatureType - 1) : 0;
  }

  isFriendlyTo(target: SpellUnit): boolean {
    return this.reactionTo(target) >= 4;
  }

  isHostileTo(target: SpellUnit): boolean {
    return this.reactionTo(target) <= 1;
  }

  hasUnitState(state: number): boolean {
    return (this.unitState & state) !== 0;
  }

  addUnitState(state: number): void {
    this.unitState |= state;
  }

  clearUnitState(state: number): void {
    this.unitState &= ~state;
  }

  hasUnitFlag(flag: number): boolean {
    return (this.unitFlags & flag) !== 0;
  }

  distanceTo(target: SpellUnit | Point): number {
    const a = this.position();
    const b = target instanceof SpellUnit ? target.position() : target;
    return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  }

  /** `WorldObject::IsWithinDistInMap` (object size not included). */
  isWithinDist(target: SpellUnit, dist: number): boolean {
    return target.position().map === this.position().map && this.distanceTo(target) <= dist;
  }

  /** `Unit::IsWithinCombatRange` */
  isWithinCombatRange(target: SpellUnit, dist: number): boolean {
    if (target.position().map !== this.position().map) return false;
    const maxdist = dist + this.combatReach + target.combatReach;
    const a = this.position();
    const b = target.position();
    return (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2 < maxdist * maxdist;
  }

  /** `Unit::GetMeleeRange` */
  meleeRange(target: SpellUnit): number {
    return Math.max(this.combatReach + target.combatReach + 4 / 3, 5);
  }

  /** `Unit::IsWithinMeleeRange` */
  isWithinMeleeRange(target: SpellUnit, dist?: number): boolean {
    if (target.position().map !== this.position().map) return false;
    const a = this.position();
    const b = target.position();
    const maxdist = dist ?? this.meleeRange(target);
    return (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2 < maxdist * maxdist;
  }

  /** `Position::HasInArc` */
  hasInArc(arc: number, target: SpellUnit | Point): boolean {
    const self = this.position();
    const other = target instanceof SpellUnit ? target.position() : target;
    if (self.x === other.x && self.y === other.y) return true;
    const full = Math.PI * 2;
    const norm = (value: number): number => ((value % full) + full) % full;
    let angle = norm(Math.atan2(other.y - self.y, other.x - self.x) - self.o);
    if (angle > Math.PI) angle -= full;
    const normalizedArc = norm(arc) === 0 && arc !== 0 ? full : norm(arc);
    return angle >= -normalizedArc / 2 && angle <= normalizedArc / 2;
  }

  /** `WorldObject::IsWithinBoundaryRadius` */
  isWithinBoundaryRadius(target: SpellUnit): boolean {
    const radius = target.boundingRadius > 0 ? target.boundingRadius : 0;
    return this.distanceTo(target) <= radius;
  }

  /** `Unit::IsStandState` */
  isStandState(): boolean {
    const state = this.standState;
    return !(state >= 1 && state <= 6) && state !== 8;
  }

  isSitState(): boolean {
    const state = this.standState;
    return state === 1 || (state >= 2 && state <= 6);
  }

  // ------------------------------------------------------------------ health and power

  /** `Unit::ModifyHealth` */
  modifyHealth(delta: number): number {
    if (delta === 0) return 0;
    const current = this.health;
    const value = delta + current;
    if (value <= 0) {
      this.setHealth(0);
      return -current;
    }
    const max = this.maxHealth;
    if (value < max) {
      this.setHealth(value);
      return value - current;
    }
    if (current !== max) {
      this.setHealth(max);
      return max - current;
    }
    return 0;
  }

  /** `Unit::GetHealthGain` */
  healthGain(delta: number): number {
    if (delta === 0) return 0;
    const current = this.health;
    const value = delta + current;
    if (value <= 0) return -current;
    const max = this.maxHealth;
    if (value < max) return delta;
    if (current !== max) return max - current;
    return 0;
  }

  /** `Unit::ModifyPower` */
  modifyPower(power: number, delta: number): number {
    if (delta === 0) return 0;
    const current = this.power(power);
    const value = delta + current;
    if (value <= 0) {
      this.setPower(power, 0);
      return -current;
    }
    const max = this.maxPower(power);
    if (value < max) {
      this.setPower(power, value);
      return value - current;
    }
    if (current !== max) {
      this.setPower(power, max);
      return max - current;
    }
    return 0;
  }

  /** `Unit::HasActivePowerType` */
  hasActivePowerType(power: number): boolean {
    return this.powerType === power;
  }

  healthPct(): number {
    return this.maxHealth ? (this.health * 100) / this.maxHealth : 0;
  }

  // ------------------------------------------------------------------ valid targets

  /** `Unit::_IsValidAttackTarget` without PvP, duels, vehicles, stealth, or phases. */
  isValidAttackTarget(target: SpellUnit, bySpell: SpellInfo | null): boolean {
    if (this === target) return false;
    if (target.hasUnitState(0x00000100 /* UNIT_STATE_UNATTACKABLE */) || (target.isPlayer && target.isGameMaster())) return false;
    if ((!bySpell || !isAllowingDeadTarget(bySpell)) && !target.isAlive()) return false;
    if ((!bySpell || !hasAttribute(bySpell, 6, 0x00000100 /* SPELL_ATTR6_CAN_TARGET_UNTARGETABLE */)) && target.hasUnitFlag(0x02000000 /* UNIT_FLAG_NOT_SELECTABLE */)) return false;
    const playerControlled = this.isControlledByPlayer();
    const targetPlayerControlled = target.isControlledByPlayer();
    if (
      target.hasUnitFlag(0x00000002 | 0x00000004 | 0x00000080 | 0x00010000) ||
      (!playerControlled && target.hasUnitFlag(0x00000200)) ||
      (!targetPlayerControlled && this.hasUnitFlag(0x00000200)) ||
      (playerControlled && target.hasUnitFlag(0x00000100)) ||
      (targetPlayerControlled && this.hasUnitFlag(0x00000100))
    ) return false;
    if (!playerControlled && !targetPlayerControlled) return this.reactionTo(target) <= 1 || target.reactionTo(this) <= 1;
    const thisToTarget = this.reactionTo(target);
    let targetToThis = 0;
    if (thisToTarget > 3 || (targetToThis = target.reactionTo(this)) > 3) return false;
    // Player versus player combat needs PvP flags and duels, which are not in the baseline.
    if (playerControlled && targetPlayerControlled) return false;
    return thisToTarget !== 3 || targetToThis > 3 || this.atWarWith(target);
  }

  /** The reputation "at war" part of `_IsValidAttackTarget` for a neutral creature and a player. */
  protected atWarWith(_target: SpellUnit): boolean {
    return true;
  }

  /** `Unit::_IsValidAssistTarget` without PvP and duels. */
  isValidAssistTarget(target: SpellUnit, bySpell: SpellInfo | null): boolean {
    if (this === target) return true;
    if (target.hasUnitState(0x00000100) || (target.isPlayer && target.isGameMaster())) return false;
    if ((!bySpell || !isAllowingDeadTarget(bySpell)) && !target.isAlive()) return false;
    if ((!bySpell || !hasAttribute(bySpell, 6, 0x00000100)) && target.hasUnitFlag(0x02000000)) return false;
    if (!bySpell || !hasAttribute(bySpell, 6, 0x00100000 /* SPELL_ATTR6_CAN_ASSIST_IMMUNE_PC */)) {
      if (target.hasUnitFlag(0x00000002)) return false;
      if (this.isControlledByPlayer() ? target.hasUnitFlag(0x00000100) : target.hasUnitFlag(0x00000200)) return false;
    }
    if (this.reactionTo(target) < 3 && target.reactionTo(this) < 3) return false;
    if (!target.isControlledByPlayer() && this.isControlledByPlayer() && (!bySpell || !hasAttribute(bySpell, 6, 0x00100000))) {
      return target.canBeAssistedByPlayers();
    }
    return true;
  }

  /** `CREATURE_TYPE_FLAG_TREAT_AS_RAID_UNIT` / `CAN_ASSIST` for creatures; players are PvP-gated. */
  canBeAssistedByPlayers(): boolean {
    return false;
  }

  // ------------------------------------------------------------------ aura containers

  /** `Unit::GetAuraEffectsByType` */
  auraEffectsByType(type: number): readonly AuraEffect[] {
    return this.modAuras.get(type) ?? [];
  }

  hasAuraType(type: number): boolean {
    return (this.modAuras.get(type)?.length ?? 0) > 0;
  }

  /** `Unit::_RegisterAuraEffect` */
  registerAuraEffect(effect: AuraEffect, apply: boolean): void {
    const list = this.modAuras.get(effect.auraType) ?? [];
    if (apply) {
      list.push(effect);
      this.modAuras.set(effect.auraType, list);
    } else {
      const index = list.indexOf(effect);
      if (index >= 0) list.splice(index, 1);
    }
  }

  /** `Unit::GetAuraApplication` */
  getAuraApplication(spellId: number, casterGuid = 0n, itemGuid = 0n, reqEffMask = 0, except: AuraApplication | null = null): AuraApplication | null {
    for (const app of this.appliedAuras) {
      const aura = app.base;
      if (aura.id !== spellId) continue;
      if ((aura.effectMask & reqEffMask) === reqEffMask && (!casterGuid || aura.casterGuid === casterGuid) && (!itemGuid || aura.castItemGuid === itemGuid) && app !== except) return app;
    }
    return null;
  }

  getAura(spellId: number, casterGuid = 0n, itemGuid = 0n, reqEffMask = 0): Aura | null {
    return this.getAuraApplication(spellId, casterGuid, itemGuid, reqEffMask)?.base ?? null;
  }

  hasAura(spellId: number, casterGuid = 0n): boolean {
    return this.getAuraApplication(spellId, casterGuid) !== null;
  }

  /** `Unit::GetOwnedAura` */
  getOwnedAura(spellId: number, casterGuid = 0n, itemGuid = 0n, reqEffMask = 0, except: Aura | null = null): Aura | null {
    for (const aura of this.ownedAuras) {
      if (aura.id !== spellId) continue;
      if ((aura.effectMask & reqEffMask) === reqEffMask && (!casterGuid || aura.casterGuid === casterGuid) && (!itemGuid || aura.castItemGuid === itemGuid) && aura !== except) return aura;
    }
    return null;
  }

  /** `Unit::GetAuraEffect(spellId, effIndex, caster)` */
  getAuraEffect(spellId: number, effIndex: number, casterGuid = 0n): AuraEffect | null {
    for (const app of this.appliedAuras) {
      if (app.base.id === spellId && app.hasEffect(effIndex) && (!casterGuid || app.base.casterGuid === casterGuid)) return app.base.effects[effIndex] ?? null;
    }
    return null;
  }

  /** `Unit::GetAuraEffect(type, family, flags..., caster)` */
  getAuraEffectByFamily(type: number, family: number, flag0: number, flag1: number, flag2: number, casterGuid = 0n): AuraEffect | null {
    for (const effect of this.auraEffectsByType(type)) {
      const info = effect.spellInfo;
      if (info.spellFamilyName === family && (info.spellFamilyFlags[0] & flag0 || info.spellFamilyFlags[1] & flag1 || info.spellFamilyFlags[2] & flag2)) {
        if (casterGuid && effect.casterGuid !== casterGuid) continue;
        return effect;
      }
    }
    return null;
  }

  /** `Unit::GetDummyAuraEffect(family, iconId, effIndex)` */
  getDummyAuraEffect(family: number, iconId: number, effIndex: number): AuraEffect | null {
    for (const effect of this.auraEffectsByType(4 /* SPELL_AURA_DUMMY */)) {
      if (effect.effIndex === effIndex && effect.spellInfo.spellIconId === iconId && effect.spellInfo.spellFamilyName === family) return effect;
    }
    return null;
  }

  /** `Unit::HasAuraWithMechanic` */
  hasAuraWithMechanic(mask: bigint): boolean {
    for (const app of this.appliedAuras) {
      const info = app.base.spellInfo;
      if (info.mechanic && mask & (1n << BigInt(info.mechanic))) return true;
      for (let i = 0; i < 3; i++) {
        if (app.base.effects[i] && info.effects[i]!.effect && info.effects[i]!.mechanic && mask & (1n << BigInt(info.effects[i]!.mechanic))) return true;
      }
    }
    return false;
  }

  // ------------------------------------------------------------------ aura modifier totals

  private totalWithSameEffect(type: number, predicate: (effect: AuraEffect) => boolean, combine: (acc: number, amount: number) => number, start: number): number {
    const list = this.auraEffectsByType(type);
    if (!list.length) return start;
    const groups = new Map<number, number>();
    let value = start;
    for (const effect of list) {
      if (!predicate(effect)) continue;
      if (!this.world.spells.addSameEffectStackRuleSpellGroups(effect.spellInfo, type, effect.amount, groups)) value = combine(value, effect.amount);
    }
    for (const amount of groups.values()) value = combine(value, amount);
    return value;
  }

  /** `Unit::GetTotalAuraModifier` */
  getTotalAuraModifier(type: number, predicate: (effect: AuraEffect) => boolean = () => true): number {
    return this.totalWithSameEffect(type, predicate, (acc, amount) => acc + amount, 0);
  }

  /** `Unit::GetTotalAuraMultiplier` */
  getTotalAuraMultiplier(type: number, predicate: (effect: AuraEffect) => boolean = () => true): number {
    return this.totalWithSameEffect(type, predicate, (acc, amount) => Math.fround(acc + (acc * amount) / 100), 1);
  }

  /** `Unit::GetMaxPositiveAuraModifier` */
  getMaxPositiveAuraModifier(type: number, predicate: (effect: AuraEffect) => boolean = () => true): number {
    let modifier = 0;
    for (const effect of this.auraEffectsByType(type)) if (predicate(effect)) modifier = Math.max(modifier, effect.amount);
    return modifier;
  }

  /** `Unit::GetMaxNegativeAuraModifier` */
  getMaxNegativeAuraModifier(type: number, predicate: (effect: AuraEffect) => boolean = () => true): number {
    let modifier = 0;
    for (const effect of this.auraEffectsByType(type)) if (predicate(effect)) modifier = Math.min(modifier, effect.amount);
    return modifier;
  }

  getTotalAuraModifierByMiscMask(type: number, mask: number): number {
    return this.getTotalAuraModifier(type, (effect) => (effect.miscValue & mask) !== 0);
  }

  getTotalAuraMultiplierByMiscMask(type: number, mask: number): number {
    return this.getTotalAuraMultiplier(type, (effect) => (effect.miscValue & mask) !== 0);
  }

  getMaxPositiveAuraModifierByMiscMask(type: number, mask: number, except: AuraEffect | null = null): number {
    return this.getMaxPositiveAuraModifier(type, (effect) => effect !== except && (effect.miscValue & mask) !== 0);
  }

  getMaxNegativeAuraModifierByMiscMask(type: number, mask: number): number {
    return this.getMaxNegativeAuraModifier(type, (effect) => (effect.miscValue & mask) !== 0);
  }

  getTotalAuraModifierByMiscValue(type: number, value: number): number {
    return this.getTotalAuraModifier(type, (effect) => effect.miscValue === value);
  }

  getTotalAuraMultiplierByMiscValue(type: number, value: number): number {
    return this.getTotalAuraMultiplier(type, (effect) => effect.miscValue === value);
  }

  getMaxPositiveAuraModifierByMiscValue(type: number, value: number): number {
    return this.getMaxPositiveAuraModifier(type, (effect) => effect.miscValue === value);
  }

  getMaxNegativeAuraModifierByMiscValue(type: number, value: number): number {
    return this.getMaxNegativeAuraModifier(type, (effect) => effect.miscValue === value);
  }

  getTotalAuraModifierByAffectMask(type: number, spell: SpellInfo): number {
    return this.getTotalAuraModifier(type, (effect) => effect.isAffectedOnSpell(spell));
  }

  /** `Unit::GetHighestExclusiveSameEffectSpellGroupValue` */
  getHighestExclusiveSameEffectSpellGroupValue(aurEff: AuraEffect, type: number, checkMiscValue = false, miscValue = 0): number {
    let value = 0;
    const worldData = this.world.spells.worldData;
    for (const groupId of worldData.spellGroupsOf(aurEff.spellInfo.id)) {
      if (worldData.spellGroupStackRule(groupId) !== 3 /* SPELL_GROUP_STACK_RULE_EXCLUSIVE_SAME_EFFECT */) continue;
      for (const other of this.auraEffectsByType(type)) {
        if (other !== aurEff && (!checkMiscValue || other.miscValue === miscValue) && worldData.isSpellMemberOfSpellGroup(other.spellInfo.id, groupId)) {
          if (Math.abs(value) < Math.abs(other.amount)) value = other.amount;
        }
      }
    }
    return value;
  }

  // ------------------------------------------------------------------ aura lifecycle

  /** `Unit::IsHighestExclusiveAura` */
  isHighestExclusiveAura(aura: Aura, removeOtherAuraApplications = false): boolean {
    for (const effect of aura.effects) {
      if (effect && !this.isHighestExclusiveAuraEffect(aura.spellInfo, effect.auraType, effect.amount, aura.effectMask, removeOtherAuraApplications)) return false;
    }
    return true;
  }

  /** `Unit::IsHighestExclusiveAuraEffect` */
  isHighestExclusiveAuraEffect(info: SpellInfo, type: number, amount: number, effectMask: number, removeOther = false): boolean {
    const spells = this.world.spells;
    let list = [...this.auraEffectsByType(type)];
    for (let index = 0; index < list.length; index++) {
      const existing = list[index]!;
      if (spells.worldData.checkSpellGroupStackRules(info.id, existing.spellInfo.id) !== SPELL_GROUP_STACK_RULE_EXCLUSIVE_HIGHEST) continue;
      let diff = Math.abs(amount) - Math.abs(existing.amount);
      if (!diff) {
        for (let i = 0; i < 3; i++) diff += ((effectMask >> i) & 1) - ((existing.base.effectMask >> i) & 1);
      }
      if (!diff && spells.worldData.firstRank(info.id) !== spells.worldData.firstRank(existing.spellInfo.id)) {
        const newDuration = spellMaxDuration(info);
        const existingDuration = existing.base.maxDuration;
        if (newDuration === -1 && existingDuration !== -1) diff = 1;
        else if (newDuration !== -1 && existingDuration === -1) diff = -1;
        else diff = newDuration - existingDuration;
      }
      if (diff > 0) {
        const base = existing.base;
        if (removeOther && (!base.isArea() || base.owner !== this)) {
          const app = base.getApplicationOfTarget(this.guid);
          if (app) {
            this.removeAuraApplication(app);
            list = [...this.auraEffectsByType(type)];
            index = -1;
          }
        }
      } else if (diff < 0) {
        return false;
      }
    }
    return true;
  }

  /** `Unit::_TryStackingOrRefreshingExistingAura` */
  tryStackingOrRefreshingExistingAura(info: SpellInfo, effMask: number, caster: SpellUnit | null, baseAmount: readonly number[] | undefined, castItemGuid: bigint, casterGuid: bigint, periodicReset: boolean): Aura | null {
    const guid = casterGuid || caster?.guid || 0n;
    if (isMultiSlotAura(info)) return null;
    const useItemGuid = isPassive(info) || hasCustomAttribute(info, 0x00000001 /* SPELL_ATTR0_CU_ENCHANT_PROC */);
    const found = this.getOwnedAura(info.id, hasCustomAttribute(info, 0x00400000 /* SPELL_ATTR0_CU_SINGLE_AURA_STACK */) ? 0n : guid, useItemGuid && castItemGuid ? castItemGuid : 0n, 0);
    if (!found) return null;
    if (effMask !== found.effectMask) return null;
    for (let i = 0; i < 3; i++) {
      const effect = found.effects[i];
      if (!effect) continue;
      effect.baseAmount = baseAmount?.[i] ?? found.spellInfo.effects[i]!.basePoints;
    }
    if (castItemGuid !== found.castItemGuid) found.castItemGuid = castItemGuid;
    found.modStackAmount(1, AURA_REMOVE_BY_DEFAULT, periodicReset);
    return found;
  }

  /** `Unit::_AddAura` */
  addOwnedAura(aura: Aura, caster: SpellUnit | null): void {
    this.ownedAuras.push(aura);
    this.removeNoStackAurasDueToAura(aura, true);
    if (aura.isRemoved) return;
    aura.isSingleTarget = !!caster && (hasAttribute(aura.spellInfo, 5, 0x20) || aura.hasEffectType(236 /* CONTROL_VEHICLE */));
    if (aura.isSingleTarget && caster) {
      caster.singleCastAuras.push(aura);
      for (const other of [...caster.singleCastAuras]) {
        if (other !== aura && other.isSingleTargetWith(aura)) other.remove();
      }
    }
  }

  /** `Unit::_CreateAuraApplication` */
  createAuraApplication(aura: Aura, effMask: number): AuraApplication | null {
    const info = aura.spellInfo;
    if (!this.isAlive() && !isDeathPersistent(info) && !isAllowingDeadTarget(info) && this.inWorld) return null;
    const caster = aura.getCaster();
    const app = new AuraApplication(this, caster, aura, effMask);
    this.appliedAuras.push(app);
    if (info.auraInterruptFlags && this === aura.owner) {
      this.interruptableAuras.push(app);
      this.interruptMask |= info.auraInterruptFlags;
    }
    if (info.auraState) this.auraStateAuras.push({ state: info.auraState, app });
    aura.applyForTarget(this, caster, app);
    return app;
  }

  /** `Unit::_ApplyAuraEffect` */
  applyAuraEffect(aura: Aura, effIndex: number): void {
    const app = aura.getApplicationOfTarget(this.guid);
    if (!app) return;
    if (!app.effectMask) this.applyAura(app, 1 << effIndex);
    else app.handleEffect(effIndex, true);
  }

  /** `Unit::_ApplyAura` */
  applyAura(app: AuraApplication, effMask: number): void {
    const aura = app.base;
    this.removeNoStackAurasDueToAura(aura, false);
    if (app.removeMode) return;
    const caster = aura.getCaster();
    const info = aura.spellInfo;
    if (info.auraState) {
      const mask = 1 << (info.auraState - 1);
      if (!(mask & PER_CASTER_AURA_STATE_MASK) || !(this.auraStateField & mask)) this.modifyAuraState(info.auraState, true);
    }
    if (app.removeMode) return;
    if (info.auraInterruptFlags & AURA_INTERRUPT_FLAG_NOT_SEATED && !this.isSitState()) this.setStandState(UNIT_STAND_STATE_SIT);
    if (app.removeMode) return;
    aura.handleAuraSpecificMods(app, caster, true, false);
    for (let i = 0; i < 3; i++) {
      if (effMask & (1 << i) && !app.removeMode) app.handleEffect(i, true);
    }
  }

  /** `Unit::_UnapplyAura` */
  unapplyAura(app: AuraApplication, removeMode: number): void {
    const index = this.appliedAuras.indexOf(app);
    if (index < 0 || app.removeMode) return;
    app.removeMode = removeMode;
    const aura = app.base;
    this.removedAurasCount++;
    const caster = aura.getCaster();
    this.appliedAuras.splice(index, 1);
    if (aura.spellInfo.auraInterruptFlags && this === aura.owner) {
      const at = this.interruptableAuras.indexOf(app);
      if (at >= 0) this.interruptableAuras.splice(at, 1);
      this.updateInterruptMask();
    }
    const auraState = aura.spellInfo.auraState;
    let auraStateFound = false;
    if (auraState) {
      const at = this.auraStateAuras.findIndex((entry) => entry.app === app);
      if (at >= 0) this.auraStateAuras.splice(at, 1);
      auraStateFound = this.auraStateAuras.some((entry) => entry.state === auraState);
    }
    app.remove();
    aura.unapplyForTarget(this, caster, app);
    for (let i = 0; i < 3; i++) if (app.hasEffect(i)) app.handleEffect(i, false);
    if (auraState && !auraStateFound) this.modifyAuraState(auraState, false);
    aura.handleAuraSpecificMods(app, caster, false, false);
  }

  /** `Unit::_RemoveNoStackAurasDueToAura` */
  removeNoStackAurasDueToAura(aura: Aura, owned: boolean): void {
    if (!this.isHighestExclusiveAura(aura)) {
      aura.remove();
      return;
    }
    if (owned) this.removeOwnedAuras((owned) => !aura.canStackWith(owned));
    else this.removeAppliedAuras((app) => !aura.canStackWith(app.base));
  }

  /** `Unit::RemoveOwnedAura(Aura*)` — every base removal goes through here. */
  removeOwnedAura(aura: Aura, removeMode = AURA_REMOVE_BY_DEFAULT): void {
    if (aura.isRemoved) return;
    const index = this.ownedAuras.indexOf(aura);
    if (index < 0) return;
    this.ownedAuras.splice(index, 1);
    if (aura.isSingleTarget) {
      const caster = aura.getCaster();
      if (caster) {
        const at = caster.singleCastAuras.indexOf(aura);
        if (at >= 0) caster.singleCastAuras.splice(at, 1);
      }
      aura.isSingleTarget = false;
    }
    aura.removeFromApplications(removeMode);
  }

  /** `Unit::RemoveOwnedAuras(check)` */
  removeOwnedAuras(check: (aura: Aura) => boolean): void {
    for (const aura of [...this.ownedAuras]) if (!aura.isRemoved && check(aura)) this.removeOwnedAura(aura);
  }

  /** `Unit::RemoveAppliedAuras(check)` */
  removeAppliedAuras(check: (app: AuraApplication) => boolean): void {
    for (const app of [...this.appliedAuras]) if (!app.removeMode && this.appliedAuras.includes(app) && check(app)) this.removeAuraApplication(app);
  }

  /** `Unit::RemoveAura(AuraApplication*, mode)` */
  removeAuraApplication(app: AuraApplication, mode = AURA_REMOVE_BY_DEFAULT): void {
    if (app.removeMode) {
      for (let i = 0; i < 3; i++) if (app.hasEffect(i)) app.handleEffect(i, false);
      return;
    }
    if (app.base.getApplicationOfTarget(this.guid) !== app || app.base.isRemoved) return;
    if (app.base.hasEffectType(SPELL_AURA_ARENA_PREPARATION)) return;
    const aura = app.base;
    this.unapplyAura(app, mode);
    if (aura.owner === this) aura.remove(mode);
  }

  /** `Unit::RemoveAura(Aura*, mode)` */
  removeAura(aura: Aura, mode = AURA_REMOVE_BY_DEFAULT): void {
    if (aura.isRemoved) return;
    const app = aura.getApplicationOfTarget(this.guid);
    if (app) this.removeAuraApplication(app, mode);
  }

  /** `Unit::RemoveAurasDueToSpell` */
  removeAurasDueToSpell(spellId: number, casterGuid = 0n, reqEffMask = 0, mode = AURA_REMOVE_BY_DEFAULT): void {
    for (const app of [...this.appliedAuras]) {
      const aura = app.base;
      if (aura.id === spellId && (aura.effectMask & reqEffMask) === reqEffMask && (!casterGuid || aura.casterGuid === casterGuid)) this.removeAuraApplication(app, mode);
    }
  }

  /** `Unit::RemoveAuraFromStack` */
  removeAuraFromStack(spellId: number, casterGuid = 0n, mode = AURA_REMOVE_BY_DEFAULT): void {
    const aura = this.ownedAuras.find((owned) => owned.id === spellId && (!casterGuid || owned.casterGuid === casterGuid));
    aura?.modStackAmount(-1, mode);
  }

  /** `Unit::RemoveAurasByType` */
  removeAurasByType(type: number, casterGuid = 0n, except: Aura | null = null, negative = true, positive = true): void {
    for (const effect of [...this.auraEffectsByType(type)]) {
      const aura = effect.base;
      const app = aura.getApplicationOfTarget(this.guid);
      if (!app) continue;
      if (aura !== except && (!casterGuid || aura.casterGuid === casterGuid) && ((negative && !app.isPositive()) || (positive && app.isPositive()))) this.removeAuraApplication(app);
    }
  }

  /** `Unit::RemoveAurasWithMechanic` */
  removeAurasWithMechanic(mask: bigint, mode = AURA_REMOVE_BY_DEFAULT, except = 0): void {
    for (const app of [...this.appliedAuras]) {
      if (except && app.base.id === except) continue;
      if (allEffectsMechanicMask(app.base.spellInfo) & mask) this.removeAuraApplication(app, mode);
    }
  }

  /** `Unit::RemoveAurasDueToSpellByDispel` (the Noxious Stings and Icy Clutch branches are class scripts). */
  removeAurasDueToSpellByDispel(spellId: number, casterGuid: bigint, chargesRemoved = 1): void {
    const aura = this.ownedAuras.find((owned) => owned.id === spellId && owned.casterGuid === casterGuid);
    aura?.dispelStacks(chargesRemoved);
  }

  /** `Unit::RemoveAurasWithInterruptFlags` */
  removeAurasWithInterruptFlags(flag: number, except = 0): void {
    if (!(this.interruptMask & flag)) return;
    for (const app of [...this.interruptableAuras]) {
      const aura = app.base;
      if (aura.spellInfo.auraInterruptFlags & flag && (!except || aura.id !== except)) this.removeAura(aura);
    }
    const channel = this.currentSpells[CURRENT_CHANNELED_SPELL];
    if (channel && channel.state === 2 /* SPELL_STATE_CASTING */ && channel.info.channelInterruptFlags & flag && channel.info.id !== except) {
      this.interruptNonMeleeSpells(false, channel.info.id);
    }
    this.updateInterruptMask();
  }

  /** `Unit::UpdateInterruptMask` */
  updateInterruptMask(): void {
    this.interruptMask = 0;
    for (const app of this.interruptableAuras) this.interruptMask |= app.base.spellInfo.auraInterruptFlags;
    const channel = this.currentSpells[CURRENT_CHANNELED_SPELL];
    if (channel && channel.state === 2) this.interruptMask |= channel.info.channelInterruptFlags;
  }

  /** `Unit::RemoveAllAurasOnDeath` */
  removeAllAurasOnDeath(): void {
    for (const app of [...this.appliedAuras]) {
      const aura = app.base;
      if ((!aura.isPassive() || hasAttribute(aura.spellInfo, 7, SPELL_ATTR7_DISABLE_AURA_WHILE_DEAD)) && !aura.isDeathPersistent()) this.unapplyAura(app, AURA_REMOVE_BY_DEATH);
    }
    for (const aura of [...this.ownedAuras]) {
      if ((!aura.isPassive() || hasAttribute(aura.spellInfo, 7, SPELL_ATTR7_DISABLE_AURA_WHILE_DEAD)) && !aura.isDeathPersistent()) this.removeOwnedAura(aura, AURA_REMOVE_BY_DEATH);
    }
  }

  /** `Unit::RemoveAllAuras` */
  removeAllAuras(): void {
    while (this.ownedAuras.length) this.removeOwnedAura(this.ownedAuras[0]!);
    for (const app of [...this.appliedAuras]) this.removeAuraApplication(app);
  }

  /**
   * `Player::CheckAreaExploreAndOutdoor` (the `CONFIG_VMAP_INDOOR_CHECK` part): the player went outdoors or indoors. Auras whose
   * spell is `SPELL_ATTR0_ONLY_INDOORS` (going outdoors) or `SPELL_ATTR0_ONLY_OUTDOORS` (going indoors) end, a passive one only
   * turns its effects off; passive auras of the other kind turn their effects on.
   */
  updateOutdoorsAuras(isOutdoor: boolean): void {
    const attrToRemove = isOutdoor ? SPELL_ATTR0_ONLY_INDOORS : SPELL_ATTR0_ONLY_OUTDOORS;
    const attrToRecalculate = isOutdoor ? SPELL_ATTR0_ONLY_OUTDOORS : SPELL_ATTR0_ONLY_INDOORS;
    for (const app of [...this.appliedAuras]) {
      if (app.removeMode || !this.appliedAuras.includes(app)) continue;
      const aura = app.base;
      const attributes = aura.spellInfo.attributes[0] ?? 0;
      if (attributes & attrToRemove) {
        // if passive - do not remove and just turn off all effects
        if (aura.isPassive()) aura.handleAllEffects(app, AURA_EFFECT_HANDLE_REAL, false);
        else this.removeAuraApplication(app);
      } else if (attributes & attrToRecalculate && aura.isPassive()) {
        // if passive - turn on all effects
        aura.handleAllEffects(app, AURA_EFFECT_HANDLE_REAL, true);
      }
    }
  }

  /** `Unit::RemoveEvadeAuras` */
  removeEvadeAuras(): void {
    if (this.isControlledByPlayer()) return;
    const keep = (aura: Aura): boolean => {
      const info = aura.spellInfo;
      return hasCustomAttribute(info, 0x00000800 /* SPELL_ATTR0_CU_IGNORE_EVADE */) || hasAttribute(info, 1, 0x2000000 /* SPELL_ATTR1_AURA_STAYS_AFTER_COMBAT */) || hasAura(info, 236 /* SPELL_AURA_CONTROL_VEHICLE */) || hasAura(info, 247 /* SPELL_AURA_CLONE_CASTER */);
    };
    for (const app of [...this.appliedAuras]) if (!keep(app.base)) this.removeAuraApplication(app);
    for (const aura of [...this.ownedAuras]) if (!aura.isRemoved && !keep(aura)) this.removeOwnedAura(aura);
  }

  /** `Unit::DelayOwnedAuras` */
  delayOwnedAuras(spellId: number, casterGuid: bigint, delay: number): void {
    for (const aura of this.ownedAuras) {
      if (aura.id !== spellId || (casterGuid && aura.casterGuid !== casterGuid)) continue;
      aura.setDuration(aura.duration < delay ? 0 : aura.duration - delay);
      aura.setNeedClientUpdateForTargets();
    }
  }

  /** `Unit::GetDispellableAuraList` */
  getDispellableAuraList(caster: SpellUnit, mask: number, dispelSpell: SpellInfo): { aura: Aura; charges: number }[] {
    const DISPEL_DISEASE = 3;
    if (mask & (1 << DISPEL_DISEASE) && this.hasAura(50536)) mask &= ~(1 << DISPEL_DISEASE);
    const positive = this.reactionTo(caster) >= 4;
    const list: { aura: Aura; charges: number }[] = [];
    for (const app of [...this.visibleAuras.entries()].sort(([a], [b]) => a - b).map(([, app]) => app)) {
      const aura = app.base;
      if (aura.isPassive()) continue;
      if (!(dispelMask(aura.spellInfo.dispel) & mask)) continue;
      if (aura.spellInfo.dispel === 1 /* DISPEL_MAGIC */ && app.isPositive() === positive) continue;
      if (aura.spellInfo.mechanic === 18 /* MECHANIC_BANISH */ && !hasAttribute(dispelSpell, 0, SPELL_ATTR0_NO_IMMUNITIES)) continue;
      const charges = hasAttribute(aura.spellInfo, 7, 0x400) ? aura.procCharges : aura.stackAmount;
      if (charges > 0) list.push({ aura, charges });
    }
    return list;
  }

  /** `Unit::AddAura(spellId, target)` */
  addAura(spellId: number, target: SpellUnit): Aura | null {
    const info = this.world.spells.get(spellId);
    if (!info || !target.isAlive()) return null;
    if (target.isImmunedToSpell(info, this)) return null;
    let effMask = 0;
    for (let i = 0; i < 3; i++) if (!target.isImmunedToSpellEffect(info, i, this)) effMask |= 1 << i;
    const { aura } = Aura.tryRefreshStackOrCreate(info, effMask, target, this);
    if (aura) {
      aura.applyForTargetsNow();
      return aura;
    }
    return null;
  }

  // ------------------------------------------------------------------ aura states

  /** `Unit::ModifyAuraState` */
  modifyAuraState(flag: number, apply: boolean): void {
    const mask = 1 << (flag - 1);
    if (apply) {
      if (this.auraStateField & mask) return;
      this.auraStateField = this.auraStateField | mask;
      for (const aura of [...this.ownedAuras]) {
        if (aura.isRemoved || aura.spellInfo.casterAuraState !== flag) continue;
        const app = aura.getApplicationOfTarget(this.guid);
        if (app) aura.handleAllEffects(app, AURA_EFFECT_HANDLE_REAL, true);
      }
    } else {
      if (!(this.auraStateField & mask)) return;
      this.auraStateField = this.auraStateField & ~mask;
      if (flag === AURA_STATE_ENRAGE) return;
      for (const aura of [...this.ownedAuras]) {
        if (aura.spellInfo.casterAuraState !== flag) continue;
        const app = aura.getApplicationOfTarget(this.guid);
        if (app) aura.handleAllEffects(app, AURA_EFFECT_HANDLE_REAL, false);
      }
    }
  }

  /** `Unit::HasAuraState` */
  hasAuraState(flag: number, spell: SpellInfo | null = null, caster: SpellUnit | null = null): boolean {
    if (caster) {
      if (spell) {
        for (const effect of caster.auraEffectsByType(SPELL_AURA_ABILITY_IGNORE_AURASTATE)) if (effect.isAffectedOnSpell(spell)) return true;
      }
      if ((1 << (flag - 1)) & PER_CASTER_AURA_STATE_MASK) {
        return this.auraStateAuras.some((entry) => entry.state === flag && entry.app.base.casterGuid === caster.guid);
      }
    }
    return (this.auraStateField & (1 << (flag - 1))) !== 0;
  }

  // ------------------------------------------------------------------ immunities

  /** `Unit::ApplySpellImmune` */
  applySpellImmune(spellId: number, op: number, type: number, apply: boolean): void {
    const list = this.spellImmune[op]!;
    if (apply) list.push([type >>> 0, spellId]);
    else for (let i = list.length - 1; i >= 0; i--) if (list[i]![0] === type >>> 0 && list[i]![1] === spellId) list.splice(i, 1);
  }

  /** `SpellInfo::ApplyAllSpellImmunitiesTo` for one effect. */
  applyAllSpellImmunities(info: SpellInfo, effIndex: number, apply: boolean): void {
    const immune = info.immunity[effIndex]!;
    const purges = hasAttribute(info, 1, 0x00008000 /* SPELL_ATTR1_IMMUNITY_PURGES_EFFECT */);
    if (immune.schoolImmuneMask) {
      this.applySpellImmune(info.id, IMMUNITY_SCHOOL, immune.schoolImmuneMask, apply);
      if (apply && purges) {
        this.removeAppliedAuras((app) => {
          const other = app.base.spellInfo;
          if (other.id === info.id || isPassive(other) || !(other.schoolMask & immune.schoolImmuneMask) || isPassive(other) || hasAttribute(other, 0, SPELL_ATTR0_NO_IMMUNITIES)) return false;
          if (!hasAttribute(info, 1, SPELL_ATTR1_IMMUNITY_TO_HOSTILE_AND_FRIENDLY_EFFECTS)) {
            const existingCaster = app.base.getCaster();
            if (existingCaster && existingCaster.isFriendlyTo(this)) return false;
          }
          return true;
        });
      }
    }
    if (immune.mechanicImmuneMask) {
      for (let mechanic = 0; mechanic < 37; mechanic++) {
        if (immune.mechanicImmuneMask & (1n << BigInt(mechanic))) this.applySpellImmune(info.id, IMMUNITY_MECHANIC, mechanic, apply);
      }
      if (apply && purges) this.removeAurasWithMechanic(immune.mechanicImmuneMask, AURA_REMOVE_BY_DEFAULT, info.id);
    }
    if (immune.dispelImmuneMask) {
      this.applySpellImmune(info.id, IMMUNITY_DISPEL, immune.dispelImmuneMask, apply);
      if (apply && purges) this.removeAppliedAuras((app) => app.base.spellInfo.dispel === immune.dispelImmuneMask);
    }
    if (immune.damageSchoolMask) this.applySpellImmune(info.id, IMMUNITY_DAMAGE, immune.damageSchoolMask, apply);
    for (const auraType of immune.auraTypeImmune) {
      this.applySpellImmune(info.id, IMMUNITY_STATE, auraType, apply);
      if (apply && purges) this.removeAppliedAuras((app) => hasAura(app.base.spellInfo, auraType) && !isPassive(app.base.spellInfo) && !hasAttribute(app.base.spellInfo, 0, SPELL_ATTR0_NO_IMMUNITIES));
    }
    for (const effect of immune.spellEffectImmune) this.applySpellImmune(info.id, IMMUNITY_EFFECT, effect, apply);
  }

  private hasSpiritOfRedemptionAura(): boolean {
    return this.hasAuraType(SPELL_AURA_SPIRIT_OF_REDEMPTION);
  }

  /** `Unit::IgnoresSchoolImmunityFromFriendlyCaster` */
  private ignoresSchoolImmunityFromFriendlyCaster(caster: SpellUnit | null, immunityAuraId: number, immunitySpell: SpellInfo | null): boolean {
    if (!caster || !caster.isFriendlyTo(this)) return false;
    if (immunitySpell) return !hasAttribute(immunitySpell, 1, SPELL_ATTR1_IMMUNITY_TO_HOSTILE_AND_FRIENDLY_EFFECTS);
    return immunityAuraId === 0xffffffff;
  }

  /** `Unit::HasSchoolImmunityForMask` */
  hasSchoolImmunityForMask(schoolMask: number, caster: SpellUnit | null, spell: SpellInfo | null): boolean {
    if (schoolMask === SPELL_SCHOOL_MASK_NONE) return false;
    let accumulated = 0;
    for (const [mask, auraId] of this.spellImmune[IMMUNITY_SCHOOL]!) {
      if (spell && isPositive(spell) && auraId === spell.id) continue;
      const immuneInfo = this.world.spells.get(auraId);
      if (this.ignoresSchoolImmunityFromFriendlyCaster(caster, auraId, immuneInfo)) continue;
      if (spell && immuneInfo && hasAttribute(spell, 1, 0x00008000) && canSpellProvideImmunityAgainstAura(spell, immuneInfo)) continue;
      accumulated |= mask;
    }
    return (accumulated & schoolMask) === schoolMask;
  }

  /** `Unit::IsImmunedToDamage(SpellSchoolMask)` */
  isImmunedToDamageMask(schoolMask: number): boolean {
    if (schoolMask === SPELL_SCHOOL_MASK_NONE) return false;
    for (const [mask] of this.spellImmune[IMMUNITY_SCHOOL]!) if ((mask & schoolMask) === schoolMask) return true;
    for (const [mask] of this.spellImmune[IMMUNITY_DAMAGE]!) if ((mask & schoolMask) === schoolMask) return true;
    return false;
  }

  /** `Unit::IsImmunedToDamage(caster, spellInfo)` */
  isImmunedToDamage(caster: SpellUnit | null, spell: SpellInfo | null): boolean {
    if (!spell) return false;
    if (hasAttribute(spell, 0, SPELL_ATTR0_NO_IMMUNITIES) || hasAttribute(spell, 2, SPELL_ATTR2_NO_SCHOOL_IMMUNITIES)) return false;
    const schoolMask = spell.schoolMask;
    if (schoolMask === SPELL_SCHOOL_MASK_NONE) return false;
    const has = (list: [number, number][]): boolean => {
      let mask = 0;
      for (const [immunity, auraId] of list) {
        const immuneInfo = this.world.spells.get(auraId);
        if (this.ignoresSchoolImmunityFromFriendlyCaster(caster, auraId, immuneInfo)) continue;
        if (immuneInfo && hasAttribute(spell, 1, 0x00008000) && canSpellProvideImmunityAgainstAura(spell, immuneInfo)) continue;
        mask |= immunity;
      }
      return (mask & schoolMask) === schoolMask;
    };
    return has(this.spellImmune[IMMUNITY_SCHOOL]!) || has(this.spellImmune[IMMUNITY_DAMAGE]!);
  }

  /** `Unit::IsImmunedToDamageOrSchool` */
  isImmunedToDamageOrSchool(schoolMask: number): boolean {
    if (schoolMask === SPELL_SCHOOL_MASK_NONE) return false;
    return this.isImmunedToDamageMask(schoolMask) || this.spellImmune[IMMUNITY_SCHOOL]!.some(([mask]) => (mask & schoolMask) === schoolMask);
  }

  /** `Unit::IsImmunedToSpell(spellInfo, caster, schoolMask)` */
  isImmunedToSpell(spell: SpellInfo, caster: SpellUnit | null, schoolMask = spell.schoolMask): boolean {
    if (this.spellImmune[IMMUNITY_ID]!.some(([id]) => id === spell.id)) return true;
    const allow = this.spellImmune[IMMUNITY_ALLOW_ID]!;
    if (allow.length) return !allow.some(([id]) => id === spell.id);
    if (hasAttribute(spell, 0, SPELL_ATTR0_NO_IMMUNITIES) && !this.hasSpiritOfRedemptionAura()) return false;
    if (spell.dispel && this.spellImmune[IMMUNITY_DISPEL]!.some(([value]) => value === spell.dispel)) return true;
    if (spell.mechanic && !hasCustomAttribute(spell, SPELL_ATTR0_CU_BYPASS_MECHANIC_IMMUNITY) && this.spellImmune[IMMUNITY_MECHANIC]!.some(([value]) => value === spell.mechanic)) return true;
    let immuneToAllEffects = true;
    for (let i = 0; i < 3; i++) {
      if (!spell.effects[i]!.effect) continue;
      if (this.isImmunedToSpellEffect(spell, i, caster)) {
        if (hasAura(spell, SPELL_AURA_TRANSFORM)) return true;
        continue;
      }
      immuneToAllEffects = false;
      break;
    }
    if (immuneToAllEffects) return true;
    if (!hasAttribute(spell, 2, SPELL_ATTR2_NO_SCHOOL_IMMUNITIES) && this.hasSchoolImmunityForMask(schoolMask, caster, spell)) return true;
    return false;
  }

  /** `Unit::IsImmunedToSpell(spellInfo, effectMask, caster)` */
  isImmunedToSpellEffects(spell: SpellInfo, effectMask: number, caster: SpellUnit | null): boolean {
    if (hasAttribute(spell, 0, SPELL_ATTR0_NO_IMMUNITIES) && !this.hasSpiritOfRedemptionAura()) return false;
    let immuneToAll = true;
    let checked = false;
    for (let i = 0; i < 3; i++) {
      if (!(effectMask & (1 << i)) || !spell.effects[i]!.effect) continue;
      checked = true;
      if (this.isImmunedToSpellEffect(spell, i, caster)) {
        if (hasAttribute(spell, 4, SPELL_ATTR4_NO_PARTIAL_IMMUNITY)) return true;
        continue;
      }
      immuneToAll = false;
      break;
    }
    if (checked && immuneToAll) return true;
    return !hasAttribute(spell, 2, SPELL_ATTR2_NO_SCHOOL_IMMUNITIES) && this.hasSchoolImmunityForMask(spell.schoolMask, caster, spell);
  }

  /** `Unit::IsImmunedToSpellEffect` */
  isImmunedToSpellEffect(spell: SpellInfo, index: number, caster: SpellUnit | null): boolean {
    const effect = spell.effects[index]!;
    if (!effect.effect) return false;
    if (hasAttribute(spell, 4, SPELL_ATTR4_OWNER_POWER_SCALING)) return false;
    if (hasAttribute(spell, 0, SPELL_ATTR0_NO_IMMUNITIES) && !this.hasSpiritOfRedemptionAura()) return false;
    for (const [value, source] of this.spellImmune[IMMUNITY_EFFECT]!) {
      if (value === effect.effect && (source !== SPELL_AURA_OF_DESPAIR_1 || effect.miscValue === POWER_MANA)) return true;
    }
    if (effect.mechanic && !hasCustomAttribute(spell, SPELL_ATTR0_CU_BYPASS_MECHANIC_IMMUNITY) && this.spellImmune[IMMUNITY_MECHANIC]!.some(([value]) => value === effect.mechanic)) return true;
    if (!hasAttribute(spell, 3, SPELL_ATTR3_ALWAYS_HIT) && effect.applyAuraName) {
      for (const [value, source] of this.spellImmune[IMMUNITY_STATE]!) {
        if (value === effect.applyAuraName && (source !== SPELL_AURA_OF_DESPAIR_2 || effect.miscValue === POWER_MANA)) return true;
      }
      if (!hasAttribute(spell, 2, SPELL_ATTR2_NO_SCHOOL_IMMUNITIES)) {
        for (const immune of this.auraEffectsByType(SPELL_AURA_MOD_IMMUNE_AURA_APPLY_SCHOOL)) {
          if (!(immune.miscValue & spell.schoolMask)) continue;
          if (hasAttribute(spell, 1, SPELL_ATTR1_IMMUNITY_TO_HOSTILE_AND_FRIENDLY_EFFECTS) || (caster && !this.isFriendlyTo(caster))) return true;
        }
      }
    }
    return false;
  }

  // ------------------------------------------------------------------ controlled states

  /** `Unit::SetControlled` for stun and root (fear and confusion need movement generators). */
  setControlled(apply: boolean, state: number): void {
    if (apply) {
      if (this.hasUnitState(state)) return;
      this.addUnitState(state);
      if (state === UNIT_STATE_STUNNED) this.setStunned(true);
      else if (state === UNIT_STATE_ROOT && !this.hasUnitState(UNIT_STATE_STUNNED)) this.setRooted(true);
    } else {
      if (state === UNIT_STATE_STUNNED && this.hasAuraType(SPELL_AURA_MOD_STUN)) return;
      if (state === UNIT_STATE_ROOT && this.hasAuraType(SPELL_AURA_MOD_ROOT)) return;
      this.clearUnitState(state);
      if (state === UNIT_STATE_STUNNED) this.setStunned(false);
      else if (state === UNIT_STATE_ROOT && !this.hasUnitState(UNIT_STATE_STUNNED)) this.setRooted(false);
      if (this.hasUnitState(UNIT_STATE_STUNNED)) this.setStunned(true);
      else if (this.hasUnitState(UNIT_STATE_ROOT)) this.setRooted(true);
    }
  }

  /** `Unit::SetStunned` */
  private setStunned(apply: boolean): void {
    if (apply) {
      this.setUnitFlag(UNIT_FLAG_STUNNED, true);
      this.attackStop();
      this.setRooted(true);
      this.castStop();
    } else {
      this.setUnitFlag(UNIT_FLAG_STUNNED, false);
      if (!this.hasUnitState(UNIT_STATE_ROOT)) this.setRooted(false);
    }
  }

  /** `Unit::SetRooted` */
  private setRooted(apply: boolean): void {
    this.sendRoot(apply);
  }

  /** `Unit::SetSilenced`-style unit flag toggles used by the silence and pacify handlers. */
  setSilencedFlag(on: boolean): void {
    this.setUnitFlag(UNIT_FLAG_SILENCED, on);
  }

  setPacifiedFlag(on: boolean): void {
    this.setUnitFlag(UNIT_FLAG_PACIFIED, on);
  }

  isConfusedOrFleeing(): { confused: boolean; fleeing: boolean } {
    return { confused: this.hasUnitFlag(UNIT_FLAG_CONFUSED), fleeing: this.hasUnitFlag(UNIT_FLAG_FLEEING) };
  }

  // ------------------------------------------------------------------ speed

  /** `Unit::UpdateSpeed` (mounted and flight auras follow the mount layer). */
  updateSpeed(moveType: number): void {
    let mainSpeedMod = 0;
    let stackBonus = 1;
    let nonStackBonus = 1;
    switch (moveType) {
      case MOVE_FLIGHT_BACK:
      case MOVE_RUN_BACK:
      case MOVE_SWIM_BACK:
      case MOVE_WALK:
        break;
      case MOVE_RUN:
        if (this.isMounted()) {
          mainSpeedMod = this.getMaxPositiveAuraModifier(SPELL_AURA_MOD_INCREASE_MOUNTED_SPEED);
          stackBonus = this.getTotalAuraMultiplier(SPELL_AURA_MOD_MOUNTED_SPEED_ALWAYS);
          nonStackBonus += this.getMaxPositiveAuraModifier(SPELL_AURA_MOD_MOUNTED_SPEED_NOT_STACK) / 100;
        } else {
          mainSpeedMod = this.getMaxPositiveAuraModifier(SPELL_AURA_MOD_INCREASE_SPEED);
          stackBonus = this.getTotalAuraMultiplier(SPELL_AURA_MOD_SPEED_ALWAYS);
          nonStackBonus += this.getMaxPositiveAuraModifier(SPELL_AURA_MOD_SPEED_NOT_STACK) / 100;
        }
        break;
      case MOVE_SWIM:
        for (const effect of this.auraEffectsByType(SPELL_AURA_MOD_INCREASE_SWIM_SPEED)) {
          if (effect.id === 64731) {
            this.setSpeedRate(moveType, nonStackBonus + (nonStackBonus * effect.amount) / 100);
            return;
          }
          if ((effect.amount > 0 && effect.amount > mainSpeedMod) || (effect.amount < 0 && effect.amount < mainSpeedMod)) mainSpeedMod = effect.amount;
        }
        break;
      case MOVE_FLIGHT:
        break;
      default:
        return;
    }
    let speed = Math.fround(Math.max(nonStackBonus, stackBonus));
    if (mainSpeedMod) speed = Math.fround(speed + (speed * mainSpeedMod) / 100);
    if (moveType === MOVE_RUN || moveType === MOVE_SWIM || moveType === MOVE_FLIGHT) {
      if (this.isCreature) speed = Math.fround(speed * this.templateRunSpeed());
      const normalization = this.getMaxPositiveAuraModifier(SPELL_AURA_USE_NORMAL_MOVEMENT_SPEED);
      if (normalization) {
        const maxSpeed = normalization / BASE_MOVE_SPEED[moveType]!;
        if (speed > maxSpeed) speed = maxSpeed;
      }
    }
    const slowFromHealth = this.slowFromHealth();
    if (slowFromHealth) speed = Math.fround(speed + (speed * slowFromHealth) / 100);
    const slow = this.getMaxNegativeAuraModifier(SPELL_AURA_MOD_DECREASE_SPEED);
    if (slow) speed = Math.fround(speed + (speed * slow) / 100);
    const minSpeedMod = this.getMaxPositiveAuraModifier(SPELL_AURA_MOD_MINIMUM_SPEED);
    if (minSpeedMod) {
      const minSpeed = (this.isCreature ? this.templateRunSpeed() : 1) * (minSpeedMod / 100);
      if (speed < minSpeed) speed = minSpeed;
    }
    this.setSpeedRate(moveType, speed);
  }

  /** `creature_template.speed_run` (1 for players). */
  protected templateRunSpeed(): number {
    return 1;
  }

  /** Creature low-health slow (1.66% per point under 30%); players and snare-immune creatures return 0. */
  protected slowFromHealth(): number {
    return 0;
  }

  /** `Unit::SetSpeed` with forced sends. */
  setSpeedRate(moveType: number, rate: number): void {
    const next = rate < 0 ? 0 : rate;
    if (this.speedRate[moveType] === next) return;
    this.speedRate[moveType] = next;
    this.sendSpeed(moveType, this.speed(moveType));
  }

  /** `Unit::GetSpeed` */
  speed(moveType: number): number {
    return this.speedRate[moveType]! * BASE_MOVE_SPEED[moveType]!;
  }

  // ------------------------------------------------------------------ spells

  /** `Unit::IsMovementPreventedByCasting` */
  isMovementPreventedByCasting(): boolean {
    // can always move when not casting
    if (!this.hasUnitState(UNIT_STATE_CASTING)) return false;

    // channeled spells during channel stage (after the initial cast timer) allow movement with a specific spell attribute
    const channel = this.currentSpells[CURRENT_CHANNELED_SPELL];
    if (channel && channel.state === 2 /* SPELL_STATE_CASTING */ && isActionAllowedChannelSpell(channel.info)) return false;

    // prohibit movement for all other spell casts
    return true;
  }

  /** `Unit::IsNonMeleeSpellCast` */
  isNonMeleeSpellCast(withDelayed: boolean, skipChanneled = false, skipAutorepeat = false, isAutoshot = false): boolean {
    const generic = this.currentSpells[CURRENT_GENERIC_SPELL];
    if (generic && generic.state !== SPELL_STATE_FINISHED && (withDelayed || generic.state !== 5 /* SPELL_STATE_DELAYED */)) {
      if (!isAutoshot || !hasAttribute(generic.info, 2, 0x00020000)) return true;
    }
    const channel = this.currentSpells[CURRENT_CHANNELED_SPELL];
    if (!skipChanneled && channel && channel.state !== SPELL_STATE_FINISHED) {
      if (!isAutoshot || !hasAttribute(channel.info, 2, 0x00020000)) return true;
    }
    if (!skipAutorepeat && this.currentSpells[CURRENT_AUTOREPEAT_SPELL]) return true;
    return false;
  }

  /** `Unit::InterruptSpell` */
  interruptSpell(type: number, withDelayed = true, withInstant = true): void {
    const spell = this.currentSpells[type];
    if (!spell) return;
    if ((withDelayed || spell.state !== 5) && (withInstant || spell.castTime > 0 || spell.state === 2)) {
      // `Spell::IsInterruptable`: a spell that is executing right now (for example a self-stun) cannot interrupt itself.
      if (spell.executedCurrently) return;
      if (spell.state !== SPELL_STATE_FINISHED) {
        spell.cancel();
      } else {
        this.currentSpells[type] = null;
        spell.referencedFromCurrent = false;
      }
    }
  }

  /** `Unit::InterruptNonMeleeSpells` */
  interruptNonMeleeSpells(withDelayed: boolean, spellId = 0, withInstant = true): void {
    const generic = this.currentSpells[CURRENT_GENERIC_SPELL];
    if (generic && (!spellId || generic.info.id === spellId)) this.interruptSpell(CURRENT_GENERIC_SPELL, withDelayed, withInstant);
    const autoRepeat = this.currentSpells[CURRENT_AUTOREPEAT_SPELL];
    if (autoRepeat && (!spellId || autoRepeat.info.id === spellId)) this.interruptSpell(CURRENT_AUTOREPEAT_SPELL, withDelayed, withInstant);
    const channel = this.currentSpells[CURRENT_CHANNELED_SPELL];
    if (channel && (!spellId || channel.info.id === spellId)) this.interruptSpell(CURRENT_CHANNELED_SPELL, true, true);
  }

  /** `Unit::CastStop` */
  castStop(exceptSpellId = 0, withInstant = true): void {
    for (let type = CURRENT_GENERIC_SPELL; type <= CURRENT_AUTOREPEAT_SPELL; type++) {
      const spell = this.currentSpells[type];
      if (spell && spell.info.id !== exceptSpellId) this.interruptSpell(type, false, withInstant);
    }
  }

  /** `Unit::SetCurrentCastedSpell` */
  setCurrentCastedSpell(spell: Spell): void {
    const type = spell.currentContainer();
    if (this.currentSpells[type] === spell) return;
    switch (type) {
      case CURRENT_GENERIC_SPELL:
        this.interruptSpell(CURRENT_GENERIC_SPELL, false);
        if (this.currentSpells[CURRENT_CHANNELED_SPELL] && !isActionAllowedChannelSpell(this.currentSpells[CURRENT_CHANNELED_SPELL]!.info)) this.interruptSpell(CURRENT_CHANNELED_SPELL, false);
        if (this.currentSpells[CURRENT_AUTOREPEAT_SPELL]) this.interruptSpell(CURRENT_AUTOREPEAT_SPELL);
        if (spell.castTime > 0) this.addUnitState(UNIT_STATE_CASTING);
        break;
      case CURRENT_CHANNELED_SPELL:
        this.interruptSpell(CURRENT_GENERIC_SPELL, false);
        this.interruptSpell(CURRENT_CHANNELED_SPELL);
        if (this.currentSpells[CURRENT_AUTOREPEAT_SPELL]) this.interruptSpell(CURRENT_AUTOREPEAT_SPELL);
        this.addUnitState(UNIT_STATE_CASTING);
        break;
      case CURRENT_AUTOREPEAT_SPELL:
        this.interruptSpell(CURRENT_AUTOREPEAT_SPELL);
        break;
      case CURRENT_MELEE_SPELL:
        this.interruptSpell(CURRENT_MELEE_SPELL);
        break;
      default:
        break;
    }
    this.currentSpells[type] = spell;
  }

  /** `Unit::FindCurrentSpellBySpellId` */
  findCurrentSpellBySpellId(spellId: number): Spell | null {
    return this.currentSpells.find((spell) => spell?.info.id === spellId) ?? null;
  }

  /** `Unit::CastSpell(target, spellId, triggered)` */
  castSpell(target: SpellUnit | null, spellId: number, options: CastOptions = {}): number {
    return this.castSpellInfo(target, this.world.spells.get(spellId), options);
  }

  /** `Unit::CastSpell(SpellCastTargets, spellInfo, ...)` → `Spell::prepare`. */
  castSpellInfo(target: SpellUnit | null, info: SpellInfo | null, options: CastOptions = {}): number {
    if (!info) return SPELL_FAILED_SPELL_UNAVAILABLE;
    const triggerFlags = options.triggerFlags ?? (options.triggered ? TRIGGERED_FULL_MASK : 0);
    const targets = options.targets ? { ...options.targets } : emptyTargets();
    if (!options.targets && target) {
      targets.object = target.guid;
      targets.mask |= TARGET_FLAG_UNIT;
    }
    if (options.dest) {
      targets.dest = { transport: 0n, x: options.dest.x, y: options.dest.y, z: options.dest.z };
      targets.mask |= TARGET_FLAG_DEST_LOCATION;
    }
    const spell = new Spell(this, info, triggerFlags, {
      originalCaster: options.originalCaster,
      castCount: options.castCount,
      castItem: options.castItem ?? null,
      triggeredByAura: options.triggeredByAura ?? null,
      basePoints: options.basePoints,
      targets,
    });
    spell.channelTarget = options.channelTarget ?? null;
    return spell.prepare();
  }

  // ------------------------------------------------------------------ host hooks (Unit defaults; players and creatures override)

  /** `Unit::IsPet` */
  isPet(): boolean {
    return false;
  }

  /** `Creature::IsTrigger` */
  isTrigger(): boolean {
    return false;
  }

  /** `CreatureTemplate::flags_extra` (0 for players). */
  creatureFlagsExtra(): number {
    return 0;
  }

  /** `CreatureTemplate::expansion` for `CalculateSpellDamage` scaling. */
  creatureExpansion(): number {
    return 0;
  }

  /** `Creature::GetSpellDamageMod(rank)` */
  creatureSpellDamageMod(): number {
    return 1;
  }

  /** `GetSpellModOwner()` is a player. */
  spellModOwnerIsPlayer(): boolean {
    return this.isPlayer;
  }

  /** `Unit::GetLevelForTarget` */
  levelForTarget(_target: SpellUnit): number {
    return this.level;
  }

  /** `Unit::CanApplyResilience` (`m_applyResilience`: players, and units owned by players). */
  canApplyResilience(): boolean {
    return this.isPlayer;
  }

  /** `Unit::GetAPMultiplier` */
  apMultiplier(attType: number, normalized: boolean): number {
    if (!normalized || !this.isPlayer) return this.stats.attackTime(attType) / 1000;
    const weapon = this.stats.weaponForAttack(attType);
    if (!weapon) return 2.4;
    switch (weapon.inventoryType) {
      case 17 /* INVTYPE_2HWEAPON */:
        return 3.3;
      case 15 /* INVTYPE_RANGED */:
      case 26 /* INVTYPE_RANGEDRIGHT */:
      case 25 /* INVTYPE_THROWN */:
        return 2.8;
      default:
        return weapon.subClass === 15 /* ITEM_SUBCLASS_WEAPON_DAGGER */ ? 1.7 : 2.4;
    }
  }

  /** `Player::HasItemFitToSpellRequirements` (always true for units without an inventory). */
  hasItemFitToSpellRequirements(_info: SpellInfo): boolean {
    return true;
  }

  /** `Player::RewardRage` */
  rewardRage(_damage: number, _weaponSpeedHitFactor: number, _attacker: boolean): void {}

  /** Whether `other`'s `SendMessageToSet` already reaches this unit. */
  seesSetOf(_other: SpellUnit): boolean {
    return true;
  }

  /** `Unit::CheckAttackFitToAuraRequirement` (players check the weapon). */
  checkAttackFitToAuraRequirement(_attType: number, _aurEff: AuraEffect): boolean {
    return true;
  }

  /** `Unit::IsImmunedToAuraPeriodicTick` */
  isImmunedToAuraPeriodicTick(caster: SpellUnit | null, info: SpellInfo | null): boolean {
    if (!info) return false;
    if (hasAttribute(info, 0, SPELL_ATTR0_NO_IMMUNITIES) || hasAttribute(info, 2, SPELL_ATTR2_NO_SCHOOL_IMMUNITIES)) return false;
    const schoolMask = info.schoolMask;
    if (schoolMask === SPELL_SCHOOL_MASK_NONE) return false;
    let immunityMask = 0;
    for (const [mask, auraId] of this.spellImmune[IMMUNITY_SCHOOL]!) {
      if (this.ignoresSchoolImmunityFromFriendlyCaster(caster, auraId, this.world.spells.get(auraId))) continue;
      immunityMask |= mask;
    }
    return (immunityMask & schoolMask) === schoolMask;
  }

  /** `CHEAT_GOD` (players only). */
  isGodMode(): boolean {
    return false;
  }

  /** `Player::GetCommandStatus` (the `.cheat` flags; players only). */
  getCommandStatus(_command: number): boolean {
    return false;
  }

  /** `Player::EnvironmentalDamage` */
  environmentalDamage(_type: number, _damage: number): void {}

  /** `Player::GetSelection` */
  selectionGuid(): bigint {
    return 0n;
  }

  /** `Unit::GetVictim` */
  abstract victim(): SpellUnit | null;

  /** `SpellInfo::CalcPowerCost` inputs. */
  powerCostCaster(): PowerCostCaster {
    return {
      health: this.health,
      power: (power) => this.power(power),
      maxPower: (power) => this.maxPower(power),
      createHealth: this.createHealth,
      createMana: this.createMana,
      powerCostModifier: () => 0,
      powerCostMultiplier: () => 0,
      controlledByPlayer: this.isControlledByPlayer(),
      level: this.level,
      weaponSpeed: (offhand) => this.stats.attackTime(offhand ? 1 : 0),
    };
  }

  /** `m_modAttackSpeedPct[RANGED_ATTACK]` */
  rangedAttackSpeedPct(): number {
    return 1;
  }

  /** `Unit::RemoveOwnedAura(spellId, casterGUID, reqEffMask, removeMode)` */
  removeOwnedAuraBySpell(spellId: number, casterGuid = 0n, reqEffMask = 0, mode = AURA_REMOVE_BY_DEFAULT): void {
    for (const aura of [...this.ownedAuras]) {
      if (aura.isRemoved || aura.id !== spellId) continue;
      if (casterGuid && aura.casterGuid !== casterGuid) continue;
      if ((aura.effectMask & reqEffMask) !== reqEffMask) continue;
      this.removeOwnedAura(aura, mode);
    }
  }

  /** `Unit::ResetAttackTimer` for every hand. */
  resetAttackTimers(): void {}

  /** `WorldObject::GetLeewayBonusRadius` */
  leewayBonusRadius(): number {
    return this.isPlayer && this.hasLeewayMovement() ? LEEWAY_BONUS_RANGE : 0;
  }

  /** `WorldObject::GetLeewayBonusRange(target)` */
  leewayBonusRange(target: SpellUnit | null): number {
    if (!target) return 0;
    if (this.isPlayer || target.isPlayer) return this.leewayMoving() && target.leewayMoving() ? LEEWAY_BONUS_RANGE : 0;
    return 0;
  }

  /** Moving forward, strafing, or falling while not walking (`GetLeewayBonusRangeForTargets`). */
  leewayMoving(): boolean {
    return false;
  }

  /** Jumping, falling, or moving faster than `LEEWAY_MIN_MOVE_SPEED` (`GetLeewayBonusRadius`). */
  hasLeewayMovement(): boolean {
    return false;
  }

  /** `WorldObject::GetSpellMaxRangeForTarget` */
  spellMaxRangeForTarget(target: SpellUnit | null, info: SpellInfo): number {
    const range = info.range;
    if (!range) return 0;
    if (range.maxHostile === range.maxFriend) return maxRange(info, false);
    if (!target) return maxRange(info, true);
    return maxRange(info, !this.isHostileTo(target));
  }

  /** `WorldObject::GetSpellMinRangeForTarget` */
  spellMinRangeForTarget(target: SpellUnit | null, info: SpellInfo): number {
    const range = info.range;
    if (!range) return 0;
    if (range.minHostile === range.minFriend) return minRange(info, false);
    return minRange(info, !!target && !this.isHostileTo(target));
  }

  /** `Player::m_homebind` */
  homebind(): UnitPosition | null {
    return null;
  }

  /** `Unit::AtTargetAttacked` */
  atTargetAttacked(target: SpellUnit, canInitialAggro: boolean): void {
    if (!target.isInCombat() && !canInitialAggro) return;
    target.engageWithTarget(this);
    target.charmerOrOwner()?.engageWithTarget(this);
  }

  /** `Unit::EngageWithTarget`: creatures start their AI attack, players enter combat. */
  engageWithTarget(enemy: SpellUnit): void {
    this.setInCombatWith(enemy);
  }

  /** `Unit::SetLastManaUse` */
  setLastManaUse(time: number): void {
    this.lastManaUse = time;
  }

  lastManaUse = 0;
  lastDamagedTarget = 0n;

  /** `Player::CanNoReagentCast` */
  canNoReagentCast(info: SpellInfo): boolean {
    return hasAttribute(info, 5, SPELL_ATTR5_NO_REAGENT_COST_WITH_AURA) && this.hasUnitFlag(UNIT_FLAG_PREPARATION);
  }

  /** `Player::HasItemCount` */
  hasItemCount(_item: number, _count: number): boolean {
    return false;
  }

  /** `Player::DestroyItemCount` */
  destroyItemCount(_item: number, _count: number): void {}

  /** The cast item is still in the caster's inventory (`Spell::UpdatePointers`). */
  hasItem(_guid: bigint): boolean {
    return false;
  }

  /** `CreatureImmunities::ImmuneAoE` */
  immuneToAoE(): boolean {
    return false;
  }

  /** `CreatureImmunities::ImmuneChain` */
  immuneToChain(): boolean {
    return false;
  }

  /** `Creature::isTappedBy` */
  isTappedBy(_player: SpellUnit): boolean {
    return true;
  }

  /** `Unit::SetChannelObjectGuid` + `UNIT_CHANNEL_SPELL`. */
  setChannel(target: bigint, spellId: number): void {
    this.channelObject = target;
    this.channelSpell = spellId;
    this.onChannelChanged();
  }

  /** The unit's `UNIT_FIELD_CHANNEL_OBJECT` / `UNIT_CHANNEL_SPELL` changed. */
  protected onChannelChanged(): void {}

  /** `WorldObject::ModSpellDuration` */
  modSpellDuration(info: SpellInfo, target: SpellUnit, duration: number, positive: boolean, effectMask: number): number {
    return unitMath().modSpellDuration(this, info, target, duration, positive, effectMask);
  }

  /** `Unit::CalcSpellDuration` */
  calcSpellDurationFor(info: SpellInfo): number {
    return calcSpellDuration(info, this.isPlayer ? this.comboPoints : 0);
  }

  // ------------------------------------------------------------------ spell history (`Player::m_spellCooldowns`, `GlobalCooldownMgr`, school lockouts)

  /** Spell id → cooldown end (game time ms), category, and item. */
  readonly spellCooldowns = new Map<number, { end: number; category: number; item: number; needSend: boolean }>();
  readonly globalCooldowns = new Map<number, { start: number; duration: number }>();
  /** `m_prohibitSchool` / `ProhibitSpellSchool` lockouts: school index → end time. */
  readonly schoolLockouts = new Map<number, number>();

  /** `Player::HasSpellCooldown` (and the item variant when a cast item is given). */
  hasSpellCooldown(spellId: number, castItem: CastItem | null = null): boolean {
    const row = this.spellCooldowns.get(spellId);
    if (row && row.end > this.world.now() && (!castItem || !row.item || row.item === castItem.entry)) return true;
    const info = this.world.spells.get(spellId);
    return !!info && this.isSpellSchoolLocked(info.schoolMask) && info.preventionType === 1 /* SPELL_PREVENTION_TYPE_SILENCE */;
  }

  isSpellSchoolLocked(schoolMask: number): boolean {
    const now = this.world.now();
    for (const [school, end] of this.schoolLockouts) if (schoolMask & (1 << school) && end > now) return true;
    return false;
  }

  /** `Player::AddSpellAndCategoryCooldowns` without spell mods (`SPELLMOD_COOLDOWN` is the spell-mod layer). */
  addSpellAndCategoryCooldowns(info: SpellInfo, castItem: CastItem | null, infinity = false): void {
    let category = 0;
    let rec = -1;
    let catrec = -1;
    if (castItem && (castItem.cooldownMs !== undefined || castItem.categoryCooldownMs !== undefined)) {
      category = castItem.category ?? 0;
      rec = castItem.cooldownMs ?? -1;
      catrec = castItem.categoryCooldownMs ?? -1;
    }
    if (rec < 0 && catrec < 0) {
      category = info.category;
      rec = info.recoveryTime;
      catrec = info.categoryRecoveryTime;
    }
    let recTime: number;
    let catrecTime: number;
    if (infinity) {
      catrecTime = catrec > 0 ? INFINITY_COOLDOWN_DELAY : 0;
      recTime = rec > 0 ? INFINITY_COOLDOWN_DELAY : catrecTime;
    } else {
      if (rec <= 0 && catrec <= 0 && category === 76) rec = this.stats.attackTime(2);
      const cooldownMod = this.getTotalAuraModifier(SPELL_AURA_MOD_COOLDOWN);
      if (cooldownMod && this.hasSpell(info.id)) rec += cooldownMod * 1000;
      if (rec < 0) rec = 0;
      if (catrec < 0) catrec = 0;
      if (rec === 0 && catrec === 0) return;
      catrecTime = catrec;
      recTime = rec ? rec : catrecTime;
    }
    const item = castItem?.entry ?? 0;
    if (category && catrec > 0) {
      this.addSpellCooldown(info.id, 0, item, recTime, true);
      for (const spellId of this.world.spells.spellsInCategory(category, item > 0)) {
        if (spellId === info.id) continue;
        const other = this.world.spells.get(spellId);
        if (!other || other.spellFamilyName !== info.spellFamilyName) continue;
        this.addSpellCooldown(spellId, category, item, catrecTime, !isCooldownStartedOnEvent(info) && catrec > 0 && rec > 0 && catrec !== rec);
      }
    } else if (recTime > 0) {
      this.addSpellCooldown(info.id, 0, item, recTime, true);
    }
  }

  /** `Player::_AddSpellCooldown` */
  addSpellCooldown(spellId: number, category: number, item: number, duration: number, needSend: boolean): void {
    this.spellCooldowns.set(spellId, { end: this.world.now() + duration, category, item, needSend });
    this.onCooldownsChanged();
  }

  /** `Player::RemoveSpellCooldown` */
  removeSpellCooldown(spellId: number, update: boolean): void {
    this.spellCooldowns.delete(spellId);
    if (update) this.sendClearCooldown(spellId);
    this.onCooldownsChanged();
  }

  /** `Player::SendCooldownEvent` */
  sendCooldownEvent(info: SpellInfo, setCooldown = true, castItem: CastItem | null = null): void {
    if (setCooldown) this.addSpellAndCategoryCooldowns(info, castItem);
    this.sendToSelf(SMSG_COOLDOWN_EVENT, new ByteWriter().writeU32(info.id).writeU64(this.guid).toUint8Array());
  }

  /** `Player::m_lastPotionId`: the potion whose cooldown waits for the end of combat. */
  lastPotion: { info: SpellInfo; castItem: CastItem } | null = null;

  /** `Player::UpdatePotionCooldown`: out of combat, start the waiting potion cooldown. */
  updatePotionCooldown(spell: Spell | null = null): void {
    const potion = this.lastPotion;
    if (!potion || this.isInCombat()) return;
    if (spell) {
      if (spell.hasTriggeredCastFlag(TRIGGERED_IGNORE_SPELL_AND_CATEGORY_CD)) return;
      this.sendCooldownEvent(spell.info, true, potion.castItem);
    } else {
      this.sendCooldownEvent(potion.info, true, potion.castItem);
    }
    this.lastPotion = null;
  }

  /** `Player::SendClearCooldown` */
  sendClearCooldown(spellId: number): void {
    this.sendToSelf(SMSG_CLEAR_COOLDOWN, new ByteWriter().writeU32(spellId).writeU64(this.guid).toUint8Array());
  }

  /** The cooldown map changed (players persist it to `character_spell_cooldown`). */
  protected onCooldownsChanged(): void {}

  /** `Player::HasSpell` (creatures know every spell they cast). */
  hasSpell(_spellId: number): boolean {
    return !this.isPlayer;
  }

  /** `GlobalCooldownMgr::HasGlobalCooldown` */
  hasGlobalCooldown(info: SpellInfo): boolean {
    const row = this.globalCooldowns.get(info.startRecoveryCategory);
    return !!row && row.duration > 0 && this.world.now() - row.start < row.duration;
  }

  /** `GlobalCooldownMgr::AddGlobalCooldown` */
  addGlobalCooldown(info: SpellInfo, gcd: number): void {
    this.globalCooldowns.set(info.startRecoveryCategory, { start: this.world.now(), duration: gcd });
  }

  /** `GlobalCooldownMgr::CancelGlobalCooldown` */
  cancelGlobalCooldown(info: SpellInfo): void {
    const row = this.globalCooldowns.get(info.startRecoveryCategory);
    if (row) row.duration = 0;
  }

  /** `Unit::ProhibitSpellSchool` (`Player` sends the lockout for every known spell of the school). */
  prohibitSpellSchool(schoolMask: number, duration: number): void {
    const end = this.world.now() + duration;
    for (let school = 0; school < 7; school++) if (schoolMask & (1 << school)) this.schoolLockouts.set(school, end);
  }

  // ------------------------------------------------------------------ threat (`ThreatManager`; players have none)

  /** `Unit::CanHaveThreatList` */
  canHaveThreatList(): boolean {
    return false;
  }

  /** `ThreatManager::MatchUnitThreatToHighestThreat` */
  matchUnitThreatToHighestThreat(_target: SpellUnit): void {}

  // ------------------------------------------------------------------ effects that move or teach

  /** `Player::learnSpell` */
  learnSpell(_spellId: number): void {}

  /** `Unit::NearTeleportTo` */
  abstract nearTeleportTo(x: number, y: number, z: number, orientation: number, casting: boolean): void;

  /** `Player::TeleportTo` (creatures never change maps). */
  teleportTo(_map: number, _x: number, _y: number, _z: number, _orientation: number): void {}

  /** One unit tick: spell events (`SpellEvent::Execute`) then `_UpdateSpells`. */
  updateSpellsAndAuras(diff: number): void {
    for (const spell of [...this.activeSpells]) spell.eventTick(diff);
    for (let type = 0; type < 4; type++) {
      if (this.currentSpells[type]?.state === SPELL_STATE_FINISHED) this.currentSpells[type] = null;
    }
    for (const aura of [...this.ownedAuras]) if (!aura.isRemoved) aura.updateOwner(diff);
    for (const aura of [...this.ownedAuras]) {
      if (aura.isExpired()) this.removeOwnedAura(aura, 4 /* AURA_REMOVE_BY_EXPIRE */);
      else if (isChannelledAuraWithMissingCaster(aura)) this.removeOwnedAura(aura, 2 /* AURA_REMOVE_BY_CANCEL */);
    }
    for (const app of [...this.visibleAuras.values()]) if (app.needClientUpdate) app.clientUpdate();
  }

  /** All visible aura slots for `SMSG_AURA_UPDATE_ALL`. */
  visibleAuraUpdates(): ReturnType<AuraApplication["slotUpdate"]>[] {
    return [...this.visibleAuras.entries()].sort(([a], [b]) => a - b).map(([, app]) => app.slotUpdate(false));
  }

  /** `Unit::SendClearTarget`-style helper packets that several handlers send. */
  packed(): Uint8Array {
    return packedGuid(this.guid);
  }

  /** `Unit::SendSpellDamageImmune` */
  sendSpellDamageImmune(target: SpellUnit, spellId: number): void {
    const body = new ByteWriter().writeU64(this.guid).writeU64(target.guid).writeU32(spellId).writeU8(0).toUint8Array();
    this.sendToSet(0x263 /* SMSG_SPELLORDAMAGE_IMMUNE */, body, true);
  }

  // Unit math lives in `unit-math.ts`; these forwards are the member functions the aura code calls.

  calculateSpellDamage(info: SpellInfo, effIndex: number, basePoints?: number): number {
    return unitMath().calculateSpellDamage(this, info, effIndex, basePoints);
  }

  spellDamageBonusDone(victim: SpellUnit, info: SpellInfo, damage: number, damageType: number, effIndex: number, totalMod = 0, stack = 1): number {
    return unitMath().spellDamageBonusDone(this, victim, info, damage, damageType, effIndex, totalMod, stack);
  }

  spellHealingBonusDone(victim: SpellUnit, info: SpellInfo, heal: number, damageType: number, effIndex: number, totalMod = 0, stack = 1): number {
    return unitMath().spellHealingBonusDone(this, victim, info, heal, damageType, effIndex, totalMod, stack);
  }

  spellPctDamageModsDone(victim: SpellUnit, info: SpellInfo, damageType: number): number {
    return unitMath().spellPctDamageModsDone(this, victim, info, damageType);
  }

  spellPctHealingModsDone(victim: SpellUnit, info: SpellInfo, damageType: number, includeHealingDonePct = true): number {
    return unitMath().spellPctHealingModsDone(this, victim, info, damageType, includeHealingDonePct);
  }

  calcPeriodicCritChance(effect: AuraEffect, target: SpellUnit | null): number {
    return unitMath().calcPeriodicCritChance(this, effect, target);
  }
}

/** Stat modifier API (`Unit::HandleStatFlatModifier` and friends) each host implements over its stat model. */
export interface UnitStatHost {
  readonly castSpeed: number;
  /** `Unit::HandleStatFlatModifier` (`BASE_VALUE` or `TOTAL_VALUE`) then `UpdateUnitMod`. */
  handleStatFlatModifier(unitMod: number, modifierType: number, amount: number, apply: boolean): void;
  /** `Unit::ApplyStatPctModifier` */
  applyStatPctModifier(unitMod: number, modifierType: number, pct: number): void;
  /** `Unit::SetStatPctModifier` */
  setStatPctModifier(unitMod: number, modifierType: number, value: number): void;
  /** `Unit::SetStatFlatModifier` then `UpdateUnitMod`. */
  setStatFlatModifier(unitMod: number, modifierType: number, value: number): void;
  /** `ApplyModInt32Value(PLAYER_FIELD_MOD_DAMAGE_DONE_POS/NEG + school, amount, apply)` (players). */
  applyModDamageDoneField(baseField: number, school: number, amount: number, apply: boolean): void;
  /** `SetFloatValue(PLAYER_FIELD_MOD_DAMAGE_DONE_PCT + school, value)` (players). */
  setModDamageDonePctField(school: number, value: number): void;
  getPctModifierValue(unitMod: number, modifierType: number): number;
  getFlatModifierValue(unitMod: number, modifierType: number): number;
  /** `Unit::UpdateStatBuffMod` (players and pets). */
  updateStatBuffMod(stat: number, positive: number, negative: number): void;
  /** `Unit::UpdateResistanceBuffModsMod` (players and pets). */
  updateResistanceBuffModsMod(school: number, positive: number, negative: number): void;
  /** `Player::UpdateSpellDamageAndHealingBonus` */
  updateSpellDamageAndHealingBonus(): void;
  getStat(stat: number): number;
  getArmor(): number;
  getResistance(school: number): number;
  getTotalAttackPowerValue(attType: number): number;
  /** `PLAYER_FIELD_MOD_TARGET_RESISTANCE` / `..._PHYSICAL_RESISTANCE` */
  applyTargetResistanceField(physical: boolean, amount: number, apply: boolean): void;
  /** `Player::GetBaseSpellPowerBonus` + `GetBaseSpellDamageBonus` / `GetBaseSpellHealingBonus` (0 for creatures). */
  baseSpellDamageBonus(): number;
  baseSpellHealingBonus(): number;
  spellPenetrationItemMod(): number;
  /** `PLAYER_SPELL_CRIT_PERCENTAGE1 + school` for players, `m_baseSpellCritChance` otherwise. */
  spellCritChance(school: number): number | null;
  /** `PLAYER_CRIT_PERCENTAGE` / offhand / ranged for players (null for creatures). */
  weaponCritChance(attType: number): number | null;
  modSpellHitChance: number;
  modMeleeHitChance: number;
  modRangedHitChance: number;
  ratingBonus(rating: number): number;
  /** `Unit::GetMaxSkillValueForLevel` */
  maxSkillValueForLevel(target: SpellUnit | null): number;
  weaponSkillValue(attType: number, target: SpellUnit | null): number;
  defenseSkillValue(target: SpellUnit | null): number;
  /** `GetUnitDodgeChance`, `GetUnitParryChance`, `GetUnitBlockChance`, `GetUnitMissChance` without aura parts (the unit adds those). */
  dodgeChance(): number;
  parryChance(): number;
  blockChance(): number;
  missFromDefense(): number;
  expertiseDodgeOrParryReduction(attType: number): number;
  shieldBlockValue(): number;
  /** `Unit::CalculateDamage(attType, normalized, addTotalPct)` */
  weaponDamage(attType: number, normalized: boolean, addTotalPct: boolean): number;
  attackTime(attType: number): number;
  hasOffhandWeapon(): boolean;
  /** `Unit::m_modAttackSpeedPct` */
  applyAttackTimePercentMod(attType: number, pct: number, apply: boolean): void;
  applyCastTimePercentMod(pct: number, apply: boolean): void;
  /** `Player::GetWeaponForAttack(att)` item and subclass, or null. */
  weaponForAttack(attType: number): { inventoryType: number; subClass: number } | null;
  canParry(): boolean;
  canBlock(): boolean;
  canDualWield(): boolean;
  setCanParry(on: boolean): void;
  setCanBlock(on: boolean): void;
  setCanDualWield(on: boolean): void;
  /** `UNIT_FIELD_POWER_REGEN*` refresh after regen auras change. */
  updateManaRegen(): void;
}

function isActionAllowedChannelSpell(info: SpellInfo): boolean {
  return hasAttribute(info, 5, 0x1) && (info.attributes[1] & 0x44) !== 0;
}

function isChannelledAuraWithMissingCaster(aura: Aura): boolean {
  return (aura.spellInfo.attributes[1] & 0x44) !== 0 && aura.casterGuid !== aura.owner.guid && !aura.owner.world.unit(aura.casterGuid);
}

function unitMath(): typeof UnitMath {
  return UnitMath;
}
