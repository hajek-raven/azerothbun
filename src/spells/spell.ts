import { irand, randNorm } from "../common/random.ts";
import { ByteWriter } from "../net/byte-buffer.ts";
import { packedGuid } from "../world/update-object.ts";
import { Aura, type AuraEffect } from "./aura.ts";
import { isAuraTypeSupported } from "./aura-effects.ts";
import * as D from "./defines.ts";
import * as E from "./enums.ts";
import {
  MSG_CHANNEL_START,
  MSG_CHANNEL_UPDATE,
  SMSG_CAST_FAILED,
  SMSG_SPELL_DELAYED,
  SMSG_SPELL_FAILED_OTHER,
  SMSG_SPELL_FAILURE,
  SMSG_SPELL_GO,
  SMSG_SPELL_START,
  castFailedPacket,
  channelStartPacket,
  channelUpdatePacket,
  emptyTargets,
  spellDelayedPacket,
  spellFailurePacket,
  writeTargets,
  type CastTargets,
  type Location,
} from "./packets.ts";
import { SCRIPTED_EFFECT_SPELLS, SPELL_EFFECT_HANDLERS, SMSG_SPELLLOGEXECUTE, classDamageBranch, isEffectSupported } from "./spell-effects.ts";
import {
  calcCastTime,
  calcPowerCost,
  calcRadius,
  canBeUsedInCombat,
  checkShapeshift,
  directionAngle,
  effectIsTargetingArea,
  effectIsAura,
  hasAttribute,
  hasAura,
  hasCustomAttribute,
  hasEffect,
  hasInitialAggro,
  isAllowingDeadTarget,
  isAreaAuraEffect,
  isAuraEffect,
  isAutoRepeat,
  isChanneled,
  isActionAllowedChannel,
  isCooldownStartedOnEvent,
  isDeathPersistent,
  isNextMeleeSwingSpell,
  isPassive,
  isPositive,
  isPositiveEffect,
  isRequiringDeadTarget,
  maxRange,
  minRange,
  needsComboPoints,
  needsExplicitUnitTarget,
  spellDuration,
  targetFlagMask,
  dispelMask,
  allEffectsMechanicMask,
  type SpellInfo,
} from "./spell-info.ts";
import { EFFECT_TARGETS, IMPLICIT_TARGETS } from "./target-data.ts";
import type { SpellUnit } from "./unit.ts";
import * as math from "./unit-math.ts";

/** `TargetInfo` */
export type TargetInfo = {
  targetGuid: bigint;
  timeDelay: number;
  missCondition: number;
  reflectResult: number;
  effectMask: number;
  processed: boolean;
  alive: boolean;
  crit: boolean;
  scaleAura: boolean;
  damage: number;
  damageBeforeTakenMods: number;
};

/** `SpellValue` */
export type SpellValue = {
  basePoints: [number, number, number];
  maxAffectedTargets: number;
  radiusMod: number;
  auraStackAmount: number;
  auraDuration: number;
  forcedCritResult: boolean;
};

/** An item that casts the spell (`m_CastItem`): the session supplies its cooldown and charge handling. */
export type CastItem = {
  guid: bigint;
  entry: number;
  /** Item-template cooldown overrides for `AddSpellAndCategoryCooldowns`. */
  cooldownMs?: number;
  category?: number;
  categoryCooldownMs?: number;
  /** `TakeCastItem`: spends a charge or destroys the item. */
  take?: () => void;
  /** `ItemTemplate::IsPotion` (consumable class, potion subclass). */
  isPotion?: boolean;
};

type Destination = { map: number; x: number; y: number; z: number; o: number };

/** Results of `Spell::prepare`, and the spell id the session tracks. */
export type PrepareResult = number;

/** `Spell` */
export class Spell {
  state = E.SPELL_STATE_NULL;
  timer = 0;
  castTime = 0;
  channeledDuration = 0;
  powerCost = 0;
  readonly targets: CastTargets;
  readonly uniqueTargets: TargetInfo[] = [];
  readonly destTargets: (Destination | null)[] = [null, null, null];
  readonly spellValue: SpellValue;
  readonly originalCasterGuid: bigint;
  originalCaster: SpellUnit | null;
  readonly schoolMask: number;
  readonly attackType: number;
  delayStart = 0;
  delayMoment = 0;
  immediateHandled = false;
  autoRepeat = false;
  needComboPoints: boolean;
  comboTarget: SpellUnit | null = null;
  comboPointGain = 0;
  channelTargetEffectMask = 0;
  damageMultipliers: [number, number, number] = [1, 1, 1];
  applyMultiplierMask = 0;
  delayAtDamageCount = 0;
  executedCurrently = false;
  referencedFromCurrent = false;
  customError = 0;
  castItem: CastItem | null;
  spellAura: Aura | null = null;
  /** The effect handler context (`unitTarget`, `effectHandleMode`, `damage`, `destTarget`, `m_damage`, `m_healing`). */
  unitTarget: SpellUnit | null = null;
  effectHandleMode = E.SPELL_EFFECT_HANDLE_LAUNCH;
  effectDamage = 0;
  destTarget: Destination | null = null;
  damage = 0;
  healing = 0;
  damageBeforeTakenMods = 0;
  /** Event clock for `SpellEvent::Execute` (milliseconds since the event was created). */
  private eventClock = 0;
  private nextEventAt = 1;

  constructor(
    readonly caster: SpellUnit,
    readonly info: SpellInfo,
    readonly triggerFlags: number,
    options: { originalCaster?: bigint; castCount?: number; castItem?: CastItem | null; triggeredByAura?: AuraEffect | null; basePoints?: readonly (number | undefined)[]; targets?: CastTargets } = {},
  ) {
    this.originalCasterGuid = options.originalCaster || caster.guid;
    this.originalCaster = this.originalCasterGuid === caster.guid ? caster : caster.world.unit(this.originalCasterGuid);
    this.castCount = options.castCount ?? 0;
    this.castItem = options.castItem ?? null;
    this.triggeredByAura = options.triggeredByAura ?? null;
    this.schoolMask = info.schoolMask;
    this.attackType = info.dmgClass === E.SPELL_DAMAGE_CLASS_RANGED ? math.RANGED_ATTACK : math.BASE_ATTACK;
    this.spellValue = {
      basePoints: [info.effects[0].basePoints, info.effects[1].basePoints, info.effects[2].basePoints],
      maxAffectedTargets: info.maxAffectedTargets,
      radiusMod: 1,
      auraStackAmount: 1,
      auraDuration: 0,
      forcedCritResult: false,
    };
    for (let i = 0; i < 3; i++) {
      const value = options.basePoints?.[i];
      if (value !== undefined) this.spellValue.basePoints[i] = info.effects[i]!.dieSides === 0 ? value : value - 1;
    }
    this.needComboPoints = needsComboPoints(info);
    this.autoRepeat = isAutoRepeat(info);
    this.targets = options.targets ? { ...options.targets } : emptyTargets();
  }

  readonly castCount: number;
  readonly triggeredByAura: AuraEffect | null;

  isTriggered(): boolean {
    return (this.triggerFlags & E.TRIGGERED_FULL_MASK) !== 0;
  }

  hasTriggeredCastFlag(flag: number): boolean {
    return (this.triggerFlags & flag) !== 0;
  }

  /** `Spell::GetCurrentContainer` */
  currentContainer(): number {
    if (isNextMeleeSwingSpell(this.info)) return E.CURRENT_MELEE_SPELL;
    if (this.autoRepeat) return E.CURRENT_AUTOREPEAT_SPELL;
    if (isChanneled(this.info)) return E.CURRENT_CHANNELED_SPELL;
    return E.CURRENT_GENERIC_SPELL;
  }

  /** `m_targets.GetUnitTarget()` */
  unitTargetOf(): SpellUnit | null {
    if (!this.targets.object) return null;
    return this.targets.object === this.caster.guid ? this.caster : this.caster.world.unit(this.targets.object);
  }

  private setUnitTarget(unit: SpellUnit | null): void {
    if (!unit) return;
    this.targets.object = unit.guid;
    this.targets.mask |= E.TARGET_FLAG_UNIT;
  }

  private hasDst(): boolean {
    return (this.targets.mask & E.TARGET_FLAG_DEST_LOCATION) !== 0 && this.targets.dest !== null;
  }

  private setDst(pos: { x: number; y: number; z: number }): void {
    this.targets.dest = { transport: 0n, x: pos.x, y: pos.y, z: pos.z };
    this.targets.mask |= E.TARGET_FLAG_DEST_LOCATION;
  }

  private setSrc(pos: { x: number; y: number; z: number }): void {
    this.targets.source = { transport: 0n, x: pos.x, y: pos.y, z: pos.z };
    this.targets.mask |= E.TARGET_FLAG_SOURCE_LOCATION;
  }

  // ------------------------------------------------------------------ prepare / cast

  /** `Spell::InitExplicitTargets` */
  private initExplicitTargets(): void {
    const needed = this.info.explicitTargetMask;
    const target = this.unitTargetOf();
    if (target) {
      if (!(needed & (E.TARGET_FLAG_UNIT_MASK | E.TARGET_FLAG_CORPSE_MASK))) {
        this.targets.object = 0n;
        this.targets.mask &= ~(E.TARGET_FLAG_UNIT | E.TARGET_FLAG_UNIT_MINIPET | E.TARGET_FLAG_GAMEOBJECT | E.TARGET_FLAG_CORPSE_ENEMY | E.TARGET_FLAG_CORPSE_ALLY);
      }
    } else if (this.targets.object && !(needed & E.TARGET_FLAG_GAMEOBJECT_MASK)) {
      // An object guid that names no unit on the map (for example a corpse that despawned).
      this.targets.object = 0n;
    }
    if (!this.unitTargetOf() && needed & E.TARGET_FLAG_UNIT_MASK) {
      let unit: SpellUnit | null = null;
      if (this.caster.isPlayer) {
        const selected = this.caster.selectionGuid() ? this.caster.world.unit(this.caster.selectionGuid()) : null;
        if (selected && this.checkExplicitTarget(this.caster, selected) === D.SPELL_CAST_OK) unit = selected;
      } else if (needed & (E.TARGET_FLAG_UNIT_ENEMY | E.TARGET_FLAG_UNIT)) {
        unit = this.caster.victim();
      }
      if (!unit && needed & (E.TARGET_FLAG_UNIT_RAID | E.TARGET_FLAG_UNIT_PARTY | E.TARGET_FLAG_UNIT_ALLY)) unit = this.caster;
      this.setUnitTarget(unit);
    }
    if (needed & E.TARGET_FLAG_DEST_LOCATION) {
      if (!this.hasDst()) {
        const object = this.unitTargetOf();
        this.setDst((object ?? this.caster).position());
      }
    } else {
      this.targets.dest = null;
      this.targets.mask &= ~E.TARGET_FLAG_DEST_LOCATION;
    }
    if (needed & E.TARGET_FLAG_SOURCE_LOCATION) {
      if (!(this.targets.mask & E.TARGET_FLAG_SOURCE_LOCATION)) this.setSrc(this.caster.position());
    } else {
      this.targets.source = null;
      this.targets.mask &= ~E.TARGET_FLAG_SOURCE_LOCATION;
    }
  }

  /** `Spell::prepare` */
  prepare(): number {
    const caster = this.caster;
    this.initExplicitTargets();
    this.state = E.SPELL_STATE_PREPARING;
    caster.activeSpells.add(this);
    this.nextEventAt = 1;
    if (!this.hasTriggeredCastFlag(E.TRIGGERED_IGNORE_CAST_IN_PROGRESS) && caster.isNonMeleeSpellCast(false, true, true, this.info.id === 75) && this.castCount) {
      this.sendCastResult(D.SPELL_FAILED_SPELL_IN_PROGRESS);
      this.finish(false);
      return D.SPELL_FAILED_SPELL_IN_PROGRESS;
    }
    const unsupported = unsupportedReason(this.info, caster.world.spells);
    if (unsupported) {
      this.sendCastResult(D.SPELL_FAILED_ERROR);
      this.finish(false);
      return D.SPELL_FAILED_ERROR;
    }
    this.powerCost = this.castItem ? 0 : calcPowerCost(this.info, caster.powerCostCaster(), this.schoolMask);
    if (this.hasTriggeredCastFlag(E.TRIGGERED_IGNORE_COMBO_POINTS) || this.castItem) this.needComboPoints = false;
    const result = this.checkCast(true);
    if (result !== D.SPELL_CAST_OK && !this.autoRepeat) {
      if (caster.isPlayer && this.triggeredByAura && this.triggeredByAura.isPeriodic && !this.triggeredByAura.base.isPassive()) {
        this.sendChannelUpdate(0);
        this.triggeredByAura.base.setDuration(0);
      }
      if (!isNextMeleeSwingSpell(this.info) || result !== D.SPELL_FAILED_OUT_OF_RANGE) {
        this.sendCastResult(result);
        this.finish(false);
        return result;
      }
    }
    this.castTime = this.hasTriggeredCastFlag(E.TRIGGERED_CAST_DIRECTLY) ? 0 : calcCastTime(this.info, this.castTimeSpeed());
    if ((isChanneled(this.info) || this.castTime) && caster.isPlayer && caster.isMoving() && this.info.interruptFlags & E.SPELL_INTERRUPT_FLAG_MOVEMENT && !this.isTriggered()) {
      if (this.castTime || !isActionAllowedChannel(this.info)) {
        this.sendCastResult(D.SPELL_FAILED_MOVING);
        this.finish(false);
        return D.SPELL_FAILED_MOVING;
      }
    }
    this.timer = this.castTime > 0 ? this.castTime : 0;
    if (!this.isTriggered() && !(this.info.auraInterruptFlags & E.AURA_INTERRUPT_FLAG_NOT_SEATED) && !hasAttribute(this.info, 0, D.SPELL_ATTR0_ALLOW_WHILE_SITTING) && !this.triggeredByAura && caster.isSitState()) {
      caster.setStandState(E.UNIT_STAND_STATE_STAND);
    }
    if (this.hasTriggeredCastFlag(E.TRIGGERED_CAST_DIRECTLY) && (!isChanneled(this.info) || !spellMaxDurationOf(this.info))) {
      this.cast(true);
    } else {
      if (!this.hasTriggeredCastFlag(E.TRIGGERED_IGNORE_AURA_INTERRUPT_FLAGS) && !hasAttribute(this.info, 1, D.SPELL_ATTR1_ALLOW_WHILE_STEALTHED)) {
        caster.removeAurasWithInterruptFlags(E.AURA_INTERRUPT_FLAG_CAST, 0);
        caster.removeAurasWithInterruptFlags(E.AURA_INTERRUPT_FLAG_SPELL_ATTACK, 0);
      }
      caster.setCurrentCastedSpell(this);
      this.referencedFromCurrent = true;
      this.sendSpellStart();
      if (!this.castTime && this.currentContainer() === E.CURRENT_GENERIC_SPELL) this.cast(true);
      if (!this.hasTriggeredCastFlag(E.TRIGGERED_IGNORE_GCD)) this.triggerGlobalCooldown();
    }
    return D.SPELL_CAST_OK;
  }

  /** `WorldObject::ModSpellCastTime` resolved into the multiplier `calcCastTime` takes. */
  private castTimeSpeed(): number {
    switch (this.info.dmgClass) {
      case E.SPELL_DAMAGE_CLASS_NONE:
        return hasAttribute(this.info, 5, D.SPELL_ATTR5_SPELL_HASTE_AFFECTS_PERIODIC) ? this.caster.castSpeed : 1;
      case E.SPELL_DAMAGE_CLASS_MAGIC:
        return this.caster.castSpeed;
      case E.SPELL_DAMAGE_CLASS_RANGED:
        return this.caster.rangedAttackSpeedPct();
      default:
        return 1;
    }
  }

  /** `Spell::cancel` */
  cancel(bySelf = false): void {
    if (this.state === E.SPELL_STATE_FINISHED) return;
    const oldState = this.state;
    this.state = E.SPELL_STATE_FINISHED;
    this.autoRepeat = false;
    switch (oldState) {
      case E.SPELL_STATE_PREPARING:
        this.cancelGlobalCooldown();
        this.sendCastResult(D.SPELL_FAILED_INTERRUPTED);
        this.sendInterrupted(D.SPELL_FAILED_INTERRUPTED);
        break;
      case E.SPELL_STATE_DELAYED:
        this.sendInterrupted(D.SPELL_FAILED_INTERRUPTED);
        break;
      case E.SPELL_STATE_CASTING:
        if (!bySelf) {
          for (const target of this.uniqueTargets) {
            if (target.missCondition !== D.SPELL_MISS_NONE) continue;
            const unit = target.targetGuid === this.caster.guid ? this.caster : this.caster.world.unit(target.targetGuid);
            unit?.removeOwnedAuraBySpell(this.info.id, this.originalCasterGuid, 0, E.AURA_REMOVE_BY_CANCEL);
          }
          if (this.caster.isPlayer && isCooldownStartedOnEvent(this.info)) this.caster.removeSpellCooldown(this.info.id, true);
          this.sendChannelUpdate(0);
          this.sendInterrupted(D.SPELL_FAILED_INTERRUPTED);
        }
        break;
      default:
        break;
    }
    this.referencedFromCurrent = false;
    for (let type = 0; type < 4; type++) if (this.caster.currentSpells[type] === this) this.caster.currentSpells[type] = null;
    this.state = oldState;
    this.finish(false);
  }

  /** `Spell::cast` → `Spell::_cast` */
  cast(skipCheck = false): void {
    const caster = this.caster;
    if (!this.updatePointers()) {
      this.cancel();
      return;
    }
    if (this.targets.object && !this.unitTargetOf()) {
      this.cancel();
      return;
    }
    this.executedCurrently = true;
    if (!skipCheck) {
      const result = this.checkCast(false);
      if (result !== D.SPELL_CAST_OK) {
        this.sendCastResult(result);
        this.sendInterrupted(0);
        this.finish(false);
        this.executedCurrently = false;
        return;
      }
    }
    this.selectSpellTargets();
    if (this.state === E.SPELL_STATE_FINISHED) {
      this.sendInterrupted(0);
      this.finish(false);
      this.executedCurrently = false;
      return;
    }
    if (!this.hasTriggeredCastFlag(E.TRIGGERED_IGNORE_POWER_AND_REAGENT_COST)) {
      this.takePower();
      this.takeReagents();
    }
    this.sendSpellCooldown();
    this.handleLaunchPhase();
    this.sendSpellGo();
    let resetAttackTimers = this.isAutoActionResetSpell() && !hasAttribute(this.info, 2, D.SPELL_ATTR2_DO_NOT_RESET_COMBAT_TIMERS);
    if (resetAttackTimers) {
      for (const effect of caster.auraEffectsByType(D.SPELL_AURA_IGNORE_MELEE_RESET)) {
        if (effect.isAffectedOnSpell(this.info)) {
          resetAttackTimers = false;
          break;
        }
      }
    }
    if (this.info.speed > 0 && !isChanneled(this.info)) {
      this.takeCastItem();
      this.immediateHandled = false;
      this.state = E.SPELL_STATE_DELAYED;
      this.delayStart = 0;
      if (caster.hasUnitState(E.UNIT_STATE_CASTING) && !caster.isNonMeleeSpellCast(false, false, true)) caster.clearUnitState(E.UNIT_STATE_CASTING);
    } else {
      this.handleImmediate();
    }
    if (resetAttackTimers && !(this.castTime === 0 && calcCastTime(this.info))) caster.resetAttackTimers();
    for (const row of caster.world.spells.worldData.linkedSpells(this.info.id, 0 /* SPELL_LINK_CAST */)) {
      const id = row.spell_effect;
      if (id < 0) caster.removeAurasDueToSpell(-id);
      else caster.castSpell(this.unitTargetOf() ?? caster, id, { triggered: true });
    }
    if (hasAttribute(this.info, 7, D.SPELL_ATTR7_CAN_CAUSE_INTERRUPT)) {
      const target = this.unitTargetOf();
      if (target?.isCreature) caster.castSpell(target, 32747, { triggered: true });
    }
    this.executedCurrently = false;
  }

  /** `Spell::handle_immediate` */
  private handleImmediate(): void {
    const caster = this.caster;
    if (isChanneled(this.info)) {
      let duration = spellDuration(this.info);
      if (this.hasTriggeredCastFlag(E.TRIGGERED_IGNORE_EFFECTS)) duration = -1;
      if (duration > 0) {
        if (caster.hasAuraType(D.SPELL_AURA_PERIODIC_HASTE) || hasAttribute(this.info, 5, D.SPELL_ATTR5_SPELL_HASTE_AFFECTS_PERIODIC)) duration = Math.trunc(duration * caster.castSpeed);
        this.state = E.SPELL_STATE_CASTING;
        caster.interruptMask |= this.info.channelInterruptFlags;
        this.channeledDuration = duration;
        this.sendChannelStart(duration);
      } else if (duration === -1) {
        this.state = E.SPELL_STATE_CASTING;
        caster.interruptMask |= this.info.channelInterruptFlags;
        this.sendChannelStart(duration);
      }
    }
    this.prepareTargetProcessing();
    this.handleImmediatePhase();
    for (const target of this.uniqueTargets) this.doAllEffectOnTarget(target);
    this.finishTargetProcessing();
    this.handleFinishPhase();
    this.takeCastItem();
    if (this.state !== E.SPELL_STATE_CASTING) this.finish(true);
  }

  /** `Spell::handle_delayed` — returns the next event offset or 0 when done. */
  private handleDelayed(offset: number): number {
    if (!this.updatePointers()) {
      this.finish(false);
      return 0;
    }
    let nextTime = 0;
    this.prepareTargetProcessing();
    if (!this.immediateHandled) {
      this.handleImmediatePhase();
      this.immediateHandled = true;
    }
    const singleMissile = this.hasDst();
    for (const target of this.uniqueTargets) {
      if (target.processed) continue;
      if (singleMissile || target.timeDelay <= offset) {
        target.timeDelay = offset;
        this.doAllEffectOnTarget(target);
      } else if (nextTime === 0 || target.timeDelay < nextTime) {
        nextTime = target.timeDelay;
      }
    }
    this.finishTargetProcessing();
    if (nextTime === 0) {
      this.handleFinishPhase();
      this.finish(true);
      return 0;
    }
    return nextTime;
  }

  /** `Spell::_handle_immediate_phase` */
  private handleImmediatePhase(): void {
    this.spellAura = null;
    this.handleThreatSpells();
    for (let i = 0; i < 3; i++) {
      if (!this.info.effects[i]!.effect) continue;
      this.handleEffects(null, i, E.SPELL_EFFECT_HANDLE_HIT);
    }
  }

  /** `Spell::_handle_finish_phase` (proc triggers are outside the baseline). */
  private handleFinishPhase(): void {
    const caster = this.caster;
    if (this.needComboPoints) caster.clearComboPoints();
    if (this.comboTarget && this.comboPointGain) {
      if (!hasAura(this.info, D.SPELL_AURA_RETAIN_COMBO_POINTS)) caster.removeAurasByType(D.SPELL_AURA_RETAIN_COMBO_POINTS);
      caster.addComboPoints(this.comboTarget, this.comboPointGain);
    }
    if (!this.autoRepeat && !isNextMeleeSwingSpell(this.info) && caster.isPlayer) {
      for (const target of this.uniqueTargets) {
        if (target.targetGuid === caster.guid && target.missCondition !== D.SPELL_MISS_NONE && isCooldownStartedOnEvent(this.info)) caster.sendCooldownEvent(this.info);
      }
    }
  }

  /** `SpellEvent::Execute` for one world tick. */
  eventTick(diff: number): void {
    this.eventClock += diff;
    if (this.eventClock < this.nextEventAt) return;
    const now = this.eventClock;
    if (this.state !== E.SPELL_STATE_FINISHED) this.update(diff);
    switch (this.state) {
      case E.SPELL_STATE_FINISHED:
        if (this.isDeletable()) this.caster.activeSpells.delete(this);
        return;
      case E.SPELL_STATE_DELAYED:
        if (this.delayStart !== 0) {
          const next = this.handleDelayed(now - this.delayStart);
          if (next) {
            this.nextEventAt = this.delayStart + next;
            return;
          }
          if ((this.state as number) === E.SPELL_STATE_FINISHED && this.isDeletable()) this.caster.activeSpells.delete(this);
        } else {
          this.delayStart = now;
          this.nextEventAt = now + this.delayMoment;
          return;
        }
        break;
      default:
        break;
    }
    this.nextEventAt = now + 1;
  }

  isDeletable(): boolean {
    return !this.referencedFromCurrent && !this.executedCurrently;
  }

  /** `Spell::update` */
  update(diff: number): void {
    const caster = this.caster;
    if (!this.updatePointers()) {
      this.cancel();
      return;
    }
    if (this.targets.object && !this.unitTargetOf()) {
      this.cancel();
      return;
    }
    if (caster.isPlayer && this.timer !== 0 && caster.isMoving() && this.info.interruptFlags & E.SPELL_INTERRUPT_FLAG_MOVEMENT && this.state === E.SPELL_STATE_PREPARING) {
      if (!isNextMeleeSwingSpell(this.info) && !this.autoRepeat && !this.isTriggered()) this.cancel(true);
    }
    switch (this.state) {
      case E.SPELL_STATE_PREPARING:
        if (this.timer > 0) this.timer = diff >= this.timer ? 0 : this.timer - diff;
        if (this.timer === 0 && !isNextMeleeSwingSpell(this.info) && !this.autoRepeat) this.cast(!this.castTime);
        break;
      case E.SPELL_STATE_CASTING:
        if (this.timer) {
          if (this.timer > 0) this.timer = diff >= this.timer ? 0 : this.timer - diff;
        }
        if (this.timer === 0) {
          this.sendChannelUpdate(0);
          this.finish();
        } else if ((this.timer < 0 || this.timer > 300) && !this.updateChanneledTargetList()) {
          this.sendChannelUpdate(0);
          this.finish();
        }
        break;
      default:
        break;
    }
  }

  /** `Spell::finish` */
  finish(ok = true): void {
    if (this.state === E.SPELL_STATE_FINISHED) return;
    this.state = E.SPELL_STATE_FINISHED;
    const caster = this.caster;
    if (isChanneled(this.info)) caster.updateInterruptMask();
    for (let type = 0; type < 4; type++) {
      if (caster.currentSpells[type] === this) {
        caster.currentSpells[type] = null;
        this.referencedFromCurrent = false;
      }
    }
    if (caster.hasUnitState(E.UNIT_STATE_CASTING) && !caster.isNonMeleeSpellCast(false, false, true)) caster.clearUnitState(E.UNIT_STATE_CASTING);
    if (!this.executedCurrently && this.isDeletable() && this.delayStart === 0 && this.state === E.SPELL_STATE_FINISHED) caster.activeSpells.delete(this);
    if (ok) {
      if (caster.isPlayer && isChanneled(this.info) && isCooldownStartedOnEvent(this.info)) caster.removeSpellCooldown(this.info.id, true);
    } else {
      if (caster.isPlayer && isCooldownStartedOnEvent(this.info)) caster.sendCooldownEvent(this.info, false);
      return;
    }
    // Potions are disabled by the client until combat ends (`Player::UpdatePotionCooldown(spell)`).
    if (caster.isPlayer && !this.triggeredByAura) caster.updatePotionCooldown(this);
    if (this.info.casterAuraState === E.AURA_STATE_DEFENSE || this.info.casterAuraState === E.AURA_STATE_HUNTER_PARRY) caster.modifyAuraState(this.info.casterAuraState, false);
    if (hasAttribute(this.info, 0, D.SPELL_ATTR0_CANCELS_AUTO_ATTACK_COMBAT)) caster.attackStop();
  }

  private updatePointers(): boolean {
    this.originalCaster = this.originalCasterGuid === this.caster.guid ? this.caster : this.caster.world.unit(this.originalCasterGuid);
    if (this.castItem && this.caster.isPlayer && !this.caster.hasItem(this.castItem.guid)) return false;
    return true;
  }

  /** `Spell::Delayed` (pushback on damage). */
  delayed(): void {
    if (this.delayAtDamageCount >= 2) return;
    if (hasAttribute(this.info, 6, D.SPELL_ATTR6_NO_PUSHBACK)) return;
    let delayTime = 500;
    const delayReduce = 100 + this.caster.getTotalAuraModifier(D.SPELL_AURA_REDUCE_PUSHBACK) - 100;
    if (delayReduce >= 100) return;
    this.delayAtDamageCount++;
    delayTime = Math.trunc(delayTime + (delayTime * -delayReduce) / 100);
    if (this.timer + delayTime > this.castTime) {
      delayTime = this.castTime - this.timer;
      this.timer = this.castTime;
    } else {
      this.timer += delayTime;
    }
    this.caster.sendToSet(SMSG_SPELL_DELAYED, spellDelayedPacket(this.caster.guid, delayTime), true);
  }

  /** `Spell::DelayedChannel` */
  delayedChannel(): void {
    if (!this.caster.isPlayer || this.state !== E.SPELL_STATE_CASTING) return;
    if (this.delayAtDamageCount >= 2) return;
    if (hasAttribute(this.info, 6, D.SPELL_ATTR6_NO_PUSHBACK)) return;
    const duration = this.channeledDuration > 0 ? this.channeledDuration : spellDuration(this.info);
    let delayTime = Math.trunc((duration * 25) / 100);
    const delayReduce = 100 + this.caster.getTotalAuraModifier(D.SPELL_AURA_REDUCE_PUSHBACK) - 100;
    if (delayReduce >= 100) return;
    this.delayAtDamageCount++;
    delayTime = Math.trunc(delayTime + (delayTime * -delayReduce) / 100);
    if (this.timer <= delayTime) {
      delayTime = this.timer;
      this.timer = 0;
    } else {
      this.timer -= delayTime;
    }
    for (const target of this.uniqueTargets) {
      if (target.missCondition !== D.SPELL_MISS_NONE) continue;
      const unit = target.targetGuid === this.caster.guid ? this.caster : this.caster.world.unit(target.targetGuid);
      unit?.delayOwnedAuras(this.info.id, this.originalCasterGuid, delayTime);
    }
    this.sendChannelUpdate(this.timer);
  }

  /** `Spell::UpdateChanneledTargetList` */
  private updateChanneledTargetList(): boolean {
    if (this.channelTargetEffectMask === 0) return true;
    let channelTargetEffectMask = this.channelTargetEffectMask;
    let channelAuraMask = 0;
    for (const effect of this.info.effects) if (effect.effect === D.SPELL_EFFECT_APPLY_AURA) channelAuraMask |= 1 << effect.index;
    channelAuraMask &= channelTargetEffectMask;
    let range = 0;
    if (channelAuraMask) {
      range = maxRange(this.info, isPositive(this.info));
      if (range === 0) {
        for (const effect of this.info.effects) {
          if (channelAuraMask & (1 << effect.index) && effect.radius) {
            range = calcRadius(effect, null);
            break;
          }
        }
      }
      range += Math.min(3, range * 0.1);
    }
    for (const target of this.uniqueTargets) {
      if (target.missCondition !== D.SPELL_MISS_NONE || !(channelTargetEffectMask & target.effectMask)) continue;
      const unit = target.targetGuid === this.caster.guid ? this.caster : this.caster.world.unit(target.targetGuid);
      if (!unit) continue;
      if (this.isValidDeadOrAliveTarget(unit)) {
        if (channelAuraMask & target.effectMask) {
          const app = unit.getAuraApplication(this.info.id, this.originalCasterGuid);
          if (!app) continue;
          if (this.caster !== unit && !this.caster.isWithinDist(unit, range)) {
            target.effectMask &= ~app.effectMask;
            unit.removeAuraApplication(app);
            continue;
          }
        }
        channelTargetEffectMask &= ~target.effectMask;
      }
    }
    if (channelTargetEffectMask !== 0) {
      for (const target of this.uniqueTargets) {
        if (target.missCondition !== D.SPELL_MISS_NONE || !(channelAuraMask & target.effectMask)) continue;
        const unit = target.targetGuid === this.caster.guid ? this.caster : this.caster.world.unit(target.targetGuid);
        if (!unit || !this.isValidDeadOrAliveTarget(unit)) continue;
        const app = unit.getAuraApplication(this.info.id, this.originalCasterGuid);
        if (app) {
          target.effectMask &= ~app.effectMask;
          unit.removeAuraApplication(app);
        }
      }
    }
    return channelTargetEffectMask === 0;
  }

  private isValidDeadOrAliveTarget(target: SpellUnit): boolean {
    if (target.isAlive()) return !isRequiringDeadTarget(this.info);
    return isAllowingDeadTarget(this.info);
  }

  // ------------------------------------------------------------------ target selection

  /** `Spell::SelectSpellTargets` */
  private selectSpellTargets(): void {
    let processedAreaEffectsMask = { value: 0 };
    for (let i = 0; i < 3; i++) {
      const effect = this.info.effects[i]!;
      if (!effect.effect) continue;
      const implicitMask = targetFlagMask(IMPLICIT_TARGETS[effect.targetA]?.objectType ?? 0) | targetFlagMask(IMPLICIT_TARGETS[effect.targetB]?.objectType ?? 0);
      if (implicitMask & E.TARGET_FLAG_UNIT) this.targets.mask |= E.TARGET_FLAG_UNIT;
      if (implicitMask & (E.TARGET_FLAG_GAMEOBJECT | E.TARGET_FLAG_GAMEOBJECT_ITEM)) this.targets.mask |= E.TARGET_FLAG_GAMEOBJECT;
      this.selectEffectImplicitTargets(i, effect.targetA, processedAreaEffectsMask);
      this.selectEffectImplicitTargets(i, effect.targetB, processedAreaEffectsMask);
      this.selectEffectTypeImplicitTargets(i);
      if (this.hasDst()) this.destTargets[i] = { map: this.destMap ?? this.caster.position().map, ...this.targets.dest!, o: this.destOrientation ?? 0 };
      if (isChanneled(this.info)) {
        if (!this.uniqueTargets.length && !this.hasDst()) {
          this.sendCastResult(D.SPELL_FAILED_BAD_IMPLICIT_TARGETS);
          this.finish(false);
          return;
        }
        if (this.uniqueTargets.some((target) => target.effectMask & (1 << i))) this.channelTargetEffectMask |= 1 << i;
      }
    }
    processedAreaEffectsMask = { value: 0 };
    const dstDelay = this.calculateDelayMomentForDst();
    if (dstDelay) this.delayMoment = dstDelay;
  }

  /** `Spell::CalculateDelayMomentForDst` (trajectories are outside the baseline). */
  private calculateDelayMomentForDst(): number {
    if (this.hasDst() && this.info.speed > 0) {
      return Math.floor((this.caster.distanceTo(this.targets.dest!) / this.info.speed) * 1000);
    }
    return 0;
  }

  /** `Spell::SelectEffectImplicitTargets` */
  private selectEffectImplicitTargets(effIndex: number, target: number, processed: { value: number }): void {
    if (!target) return;
    const data = IMPLICIT_TARGETS[target];
    if (!data) return;
    let effectMask = 1 << effIndex;
    switch (data.selectionCategory) {
      case E.TARGET_SELECT_CATEGORY_NEARBY:
      case E.TARGET_SELECT_CATEGORY_CONE:
      case E.TARGET_SELECT_CATEGORY_AREA: {
        if (effectMask & processed.value) return;
        const effects = this.info.effects;
        const radius = calcRadius(effects[effIndex]!, this.caster.level);
        for (let j = effIndex + 1; j < 3; j++) {
          const other = effects[j]!;
          if (other.effect && effects[effIndex]!.targetA === other.targetA && effects[effIndex]!.targetB === other.targetB && radius === calcRadius(other, this.caster.level)) effectMask |= 1 << j;
        }
        processed.value |= effectMask;
        break;
      }
      default:
        break;
    }
    switch (data.selectionCategory) {
      case E.TARGET_SELECT_CATEGORY_CHANNEL:
        this.selectImplicitChannelTargets(effIndex, target);
        break;
      case E.TARGET_SELECT_CATEGORY_NEARBY:
        this.selectImplicitNearbyTargets(effIndex, target, effectMask);
        break;
      case E.TARGET_SELECT_CATEGORY_CONE:
        this.selectImplicitConeTargets(effIndex, target, effectMask);
        break;
      case E.TARGET_SELECT_CATEGORY_AREA:
        this.selectImplicitAreaTargets(effIndex, target, effectMask);
        break;
      case E.TARGET_SELECT_CATEGORY_TRAJ:
        // Trajectory spells are refused by the dispatcher; there is no missile path search yet.
        break;
      case E.TARGET_SELECT_CATEGORY_DEFAULT:
        switch (data.objectType) {
          case E.TARGET_OBJECT_TYPE_SRC:
            if (data.referenceType === E.TARGET_REFERENCE_TYPE_CASTER) this.setSrc(this.caster.position());
            break;
          case E.TARGET_OBJECT_TYPE_DEST:
            if (data.referenceType === E.TARGET_REFERENCE_TYPE_CASTER) this.selectImplicitCasterDestTargets(effIndex, target);
            else if (data.referenceType === E.TARGET_REFERENCE_TYPE_TARGET) this.selectImplicitTargetDestTargets(effIndex, target);
            else if (data.referenceType === E.TARGET_REFERENCE_TYPE_DEST) this.selectImplicitDestDestTargets(effIndex, target);
            break;
          default:
            if (data.referenceType === E.TARGET_REFERENCE_TYPE_CASTER) this.selectImplicitCasterObjectTargets(effIndex, target);
            else if (data.referenceType === E.TARGET_REFERENCE_TYPE_TARGET) this.selectImplicitTargetObjectTargets(effIndex, target);
            break;
        }
        break;
      default:
        break;
    }
  }

  /** `Spell::SelectImplicitChannelTargets` */
  private selectImplicitChannelTargets(effIndex: number, target: number): void {
    const channel = this.originalCaster?.currentSpells[E.CURRENT_CHANNELED_SPELL] ?? null;
    const channelData = this.channelTarget;
    switch (target) {
      case D.TARGET_UNIT_CHANNEL_TARGET: {
        const guid = channelData?.channelGuid ?? this.caster.channelObject;
        const unit = guid ? (guid === this.caster.guid ? this.caster : this.caster.world.unit(guid)) : null;
        if (unit) this.addUnitTarget(unit, 1 << effIndex);
        break;
      }
      case D.TARGET_DEST_CHANNEL_TARGET:
        if (channelData?.dest) this.setDst(channelData.dest);
        else {
          const guid = channelData?.channelGuid ?? this.caster.channelObject;
          const unit = guid ? this.caster.world.unit(guid) : null;
          if (unit) this.setDst(unit.position());
          else if (channel?.unitTargetOf()) this.setDst(channel.unitTargetOf()!.position());
        }
        break;
      case D.TARGET_DEST_CHANNEL_CASTER:
        if (this.originalCaster) this.setDst(this.originalCaster.position());
        break;
      default:
        break;
    }
  }

  /** Channel data carried from the triggering aura (`ChannelTargetData`). */
  channelTarget: { channelGuid: bigint; dest: { x: number; y: number; z: number } | null } | null = null;

  /** `Spell::SelectImplicitNearbyTargets` (entry-checked targets need `conditions`, which are outside the baseline). */
  private selectImplicitNearbyTargets(effIndex: number, target: number, effMask: number): void {
    const data = IMPLICIT_TARGETS[target]!;
    if (data.referenceType !== E.TARGET_REFERENCE_TYPE_CASTER) return;
    let range = 0;
    switch (data.checkType) {
      case E.TARGET_CHECK_ENEMY:
        range = maxRange(this.info, false);
        break;
      case E.TARGET_CHECK_ALLY:
      case E.TARGET_CHECK_PARTY:
      case E.TARGET_CHECK_RAID:
      case E.TARGET_CHECK_RAID_CLASS:
        range = maxRange(this.info, true);
        break;
      default:
        range = maxRange(this.info, isPositive(this.info));
        break;
    }
    const found = this.searchNearbyTarget(range, data.objectType, data.checkType);
    if (!found) return;
    switch (data.objectType) {
      case E.TARGET_OBJECT_TYPE_UNIT:
        this.addUnitTarget(found, effMask, true, false);
        if (!this.unitTargetOf()) this.setUnitTarget(found);
        break;
      case E.TARGET_OBJECT_TYPE_DEST:
        this.setDst(found.position());
        break;
      default:
        return;
    }
    this.selectImplicitChainTargets(effIndex, target, found, effMask);
  }

  /** `Spell::SelectImplicitConeTargets` */
  private selectImplicitConeTargets(effIndex: number, target: number, effMask: number): void {
    const data = IMPLICIT_TARGETS[target]!;
    if (data.referenceType !== E.TARGET_REFERENCE_TYPE_CASTER) return;
    let coneAngle = (60 * Math.PI) / 180;
    const cone = this.caster.world.spells.coneDegrees(this.info.id);
    if (cone !== null) coneAngle = (cone * Math.PI) / 180;
    else if (target === D.TARGET_UNIT_CONE_ENEMY_24) coneAngle = (24 * Math.PI) / 180;
    else if (target === D.TARGET_UNIT_CONE_ENEMY_54) coneAngle = (54 * Math.PI) / 180;
    else if (target === D.TARGET_UNIT_CONE_ENEMY_104) coneAngle = (104 * Math.PI) / 180;
    const radius = calcRadius(this.info.effects[effIndex]!, this.caster.level) * this.spellValue.radiusMod + this.caster.leewayBonusRadius();
    if (data.objectType !== E.TARGET_OBJECT_TYPE_UNIT) return;
    let targets = this.caster.world.unitsInRange(this.caster, radius).filter((unit) => {
      if (hasCustomAttribute(this.info, E.SPELL_ATTR0_CU_CONE_BACK)) {
        if (!this.caster.hasInArc(-Math.PI, unit)) return false;
      } else if (hasCustomAttribute(this.info, E.SPELL_ATTR0_CU_CONE_LINE)) {
        if (!this.isWithinCone(unit, coneAngle, true)) return false;
      } else if (!this.caster.isWithinBoundaryRadius(unit) && !this.caster.hasInArc(coneAngle, unit)) {
        return false;
      }
      return this.checkTargetForArea(unit, data.checkType, true);
    });
    targets = this.randomResize(targets);
    for (const unit of targets) this.addUnitTarget(unit, effMask, false);
  }

  private isWithinCone(unit: SpellUnit, angle: number, line: boolean): boolean {
    if (!line) return this.caster.hasInArc(angle, unit);
    const self = this.caster.position();
    const other = unit.position();
    const relative = Math.atan2(other.y - self.y, other.x - self.x) - self.o;
    const dist = Math.hypot(other.x - self.x, other.y - self.y);
    return Math.abs(Math.sin(relative) * dist) <= unit.combatReach && Math.cos(relative) >= 0;
  }

  /** `Acore::Containers::RandomResize` with `MOD_MAX_AFFECTED_TARGETS`. */
  private randomResize(targets: SpellUnit[]): SpellUnit[] {
    let maxTargets = this.spellValue.maxAffectedTargets;
    if (!maxTargets) return targets;
    maxTargets += this.caster.getTotalAuraModifierByAffectMask(D.SPELL_AURA_MOD_MAX_AFFECTED_TARGETS, this.info);
    const list = [...targets];
    while (list.length > maxTargets) list.splice(irand(0, list.length - 1), 1);
    return list;
  }

  /** `Spell::SelectImplicitAreaTargets` */
  private selectImplicitAreaTargets(effIndex: number, target: number, effMask: number): void {
    const data = IMPLICIT_TARGETS[target]!;
    let referer: SpellUnit | null = null;
    switch (data.referenceType) {
      case E.TARGET_REFERENCE_TYPE_SRC:
      case E.TARGET_REFERENCE_TYPE_DEST:
      case E.TARGET_REFERENCE_TYPE_CASTER:
        referer = this.caster;
        break;
      case E.TARGET_REFERENCE_TYPE_TARGET:
        referer = this.unitTargetOf();
        break;
      case E.TARGET_REFERENCE_TYPE_LAST:
        for (let i = this.uniqueTargets.length - 1; i >= 0; i--) {
          if (this.uniqueTargets[i]!.effectMask & (1 << effIndex)) {
            referer = this.caster.world.unit(this.uniqueTargets[i]!.targetGuid);
            break;
          }
        }
        break;
      default:
        return;
    }
    if (!referer) return;
    let center: { x: number; y: number; z: number } | null = null;
    switch (data.referenceType) {
      case E.TARGET_REFERENCE_TYPE_SRC:
        center = this.targets.source;
        break;
      case E.TARGET_REFERENCE_TYPE_DEST:
        center = this.targets.dest;
        break;
      default:
        center = referer.position();
        break;
    }
    if (!center) return;
    let radius = calcRadius(this.info.effects[effIndex]!, this.caster.level) * this.spellValue.radiusMod;
    if (target === D.TARGET_UNIT_SRC_AREA_ENEMY || target === D.TARGET_UNIT_CASTER_AREA_PARTY || target === D.TARGET_UNIT_CASTER_AREA_RAID) radius += this.caster.leewayBonusRadius();
    if (data.objectType !== E.TARGET_OBJECT_TYPE_UNIT) return;
    let targets = this.searchAreaTargets(radius, center, referer, data.checkType);
    targets = this.randomResize(targets);
    for (const unit of targets) this.addUnitTarget(unit, effMask, false);
  }

  /** `Spell::SearchAreaTargets` with `WorldObjectSpellAreaTargetCheck`. */
  private searchAreaTargets(radius: number, center: { x: number; y: number; z: number }, referer: SpellUnit, checkType: number, reason: "area" | "chain" = "area"): SpellUnit[] {
    return this.caster.world.unitsInRange(this.caster, radius + 0, center).filter((unit) => {
      if (unit.isCreature && (reason === "area" ? unit.immuneToAoE() : unit.immuneToChain())) return false;
      const pos = unit.position();
      const dist = Math.hypot(pos.x - center.x, pos.y - center.y, pos.z - center.z);
      if (dist > radius + unit.combatReach) return false;
      return this.checkTargetForArea(unit, checkType, true, referer);
    });
  }

  /** `WorldObjectSpellTargetCheck::operator()` */
  private checkTargetForArea(unit: SpellUnit, checkType: number, implicit: boolean, referer: SpellUnit = this.caster): boolean {
    if (this.checkTarget(this.caster, unit, implicit) !== D.SPELL_CAST_OK) return false;
    switch (checkType) {
      case E.TARGET_CHECK_ENEMY:
        if (unit.isTotem) return false;
        if (!this.caster.isValidAttackTarget(unit, this.info)) return false;
        break;
      case E.TARGET_CHECK_ALLY:
        if (unit.isTotem) return false;
        if (!this.caster.isValidAssistTarget(unit, this.info)) return false;
        break;
      case E.TARGET_CHECK_PARTY:
        if (unit.isTotem) return false;
        if (!this.caster.isValidAssistTarget(unit, this.info)) return false;
        if (!referer.isInPartyWith(unit, false) && unit !== referer) return false;
        break;
      case E.TARGET_CHECK_RAID_CLASS:
      case E.TARGET_CHECK_RAID:
        if (checkType === E.TARGET_CHECK_RAID_CLASS && referer.classId !== unit.classId) return false;
        if (unit.isTotem) return false;
        if (!this.caster.isValidAssistTarget(unit, this.info)) return false;
        if (!referer.isInPartyWith(unit, true) && unit !== referer) return false;
        break;
      case E.TARGET_CHECK_ENTRY:
        // Entry checks come from `conditions` rows, which are outside the baseline.
        return false;
      default:
        break;
    }
    return true;
  }

  /** `Spell::SearchNearbyTarget` — the closest unit passing the check. */
  private searchNearbyTarget(range: number, objectType: number, checkType: number): SpellUnit | null {
    if (objectType !== E.TARGET_OBJECT_TYPE_UNIT && objectType !== E.TARGET_OBJECT_TYPE_DEST) return null;
    let best: SpellUnit | null = null;
    let bestDist = Infinity;
    for (const unit of this.caster.world.unitsInRange(this.caster, range)) {
      if (!this.checkTargetForArea(unit, checkType, true)) continue;
      const dist = this.caster.distanceTo(unit);
      if (dist < bestDist) {
        best = unit;
        bestDist = dist;
      }
    }
    return best;
  }

  /** `Spell::SelectImplicitCasterDestTargets` (fishing and leap destinations need map heights and vmaps). */
  private selectImplicitCasterDestTargets(effIndex: number, target: number): void {
    const pos = this.caster.position();
    let dest: { x: number; y: number; z: number } = { x: pos.x, y: pos.y, z: pos.z };
    switch (target) {
      case D.TARGET_DEST_CASTER:
      case D.TARGET_DEST_CASTER_36:
        break;
      case D.TARGET_DEST_HOME: {
        const home = this.caster.homebind();
        if (home) {
          this.setDst(home);
          this.destMap = home.map;
          return;
        }
        break;
      }
      case D.TARGET_DEST_DB: {
        const row = this.caster.world.spells.worldData.targetPosition(this.info.id, effIndex);
        if (row) {
          if (hasEffect(this.info, D.SPELL_EFFECT_TELEPORT_UNITS) || hasEffect(this.info, D.SPELL_EFFECT_BIND)) {
            this.setDst({ x: row.PositionX, y: row.PositionY, z: row.PositionZ });
            this.destMap = row.MapID;
            this.destOrientation = row.Orientation;
            return;
          }
          if (row.MapID === pos.map) dest = { x: row.PositionX, y: row.PositionY, z: row.PositionZ };
        } else {
          const object = this.unitTargetOf();
          if (object) dest = object.position();
        }
        break;
      }
      case D.TARGET_DEST_CASTER_FISHING:
      case D.TARGET_DEST_CASTER_FRONT_LEAP:
        break;
      default: {
        let dist = calcRadius(this.info.effects[effIndex]!, this.caster.level);
        const angle = directionAngle(target);
        const objSize = this.caster.combatReach;
        switch (target) {
          case D.TARGET_DEST_CASTER_SUMMON:
            dist = 3; // PET_FOLLOW_DIST
            break;
          case D.TARGET_DEST_CASTER_RANDOM:
            if (dist > objSize) dist = objSize + (dist - objSize) * randNorm();
            break;
          case D.TARGET_DEST_CASTER_FRONT_LEFT:
          case D.TARGET_DEST_CASTER_BACK_LEFT:
          case D.TARGET_DEST_CASTER_FRONT_RIGHT:
          case D.TARGET_DEST_CASTER_BACK_RIGHT:
            if (!this.info.effects[effIndex]!.radius) dist = 3;
            break;
          default:
            break;
        }
        if (dist < objSize) dist = objSize;
        dest = { x: pos.x + dist * Math.cos(pos.o + angle), y: pos.y + dist * Math.sin(pos.o + angle), z: pos.z };
        break;
      }
    }
    this.setDst(dest);
  }

  /** Map and orientation of a DB or home destination (teleports cross maps). */
  destMap: number | null = null;
  destOrientation: number | null = null;

  /** `Spell::SelectImplicitTargetDestTargets` */
  private selectImplicitTargetDestTargets(effIndex: number, target: number): void {
    const object = this.unitTargetOf();
    if (!object) return;
    const pos = object.position();
    if (target === D.TARGET_DEST_TARGET_ENEMY || target === D.TARGET_DEST_TARGET_ANY) {
      this.setDst(pos);
      return;
    }
    const angle = directionAngle(target);
    let dist = calcRadius(this.info.effects[effIndex]!, null);
    if (target === D.TARGET_DEST_TARGET_RANDOM) dist *= randNorm();
    if (target === D.TARGET_DEST_TARGET_BACK) dist += object.boundingRadius;
    this.setDst({ x: pos.x + dist * Math.cos(pos.o + angle), y: pos.y + dist * Math.sin(pos.o + angle), z: pos.z });
  }

  /** `Spell::SelectImplicitDestDestTargets` */
  private selectImplicitDestDestTargets(effIndex: number, target: number): void {
    if (!this.hasDst()) this.setDst(this.caster.position());
    switch (target) {
      case D.TARGET_DEST_DYNOBJ_ENEMY:
      case D.TARGET_DEST_DYNOBJ_ALLY:
      case D.TARGET_DEST_DYNOBJ_NONE:
      case D.TARGET_DEST_DEST:
        return;
      default: {
        const angle = directionAngle(target);
        let dist = calcRadius(this.info.effects[effIndex]!, this.caster.level);
        if (target === D.TARGET_DEST_DEST_RANDOM) dist *= randNorm();
        const dest = this.targets.dest!;
        const o = this.caster.position().o;
        this.setDst({ x: dest.x + dist * Math.cos(o + angle), y: dest.y + dist * Math.sin(o + angle), z: dest.z });
      }
    }
  }

  /** `Spell::SelectImplicitCasterObjectTargets` */
  private selectImplicitCasterObjectTargets(effIndex: number, target: number): void {
    let unit: SpellUnit | null = null;
    let checkIfValid = true;
    switch (target) {
      case D.TARGET_UNIT_CASTER:
        unit = this.caster;
        checkIfValid = false;
        break;
      case D.TARGET_UNIT_MASTER:
        unit = this.caster.charmerOrOwner();
        break;
      default:
        // Pets, summoners, vehicles, and passengers are outside the baseline.
        break;
    }
    if (unit) this.addUnitTarget(unit, 1 << effIndex, checkIfValid);
  }

  /** `Spell::SelectImplicitTargetObjectTargets` */
  private selectImplicitTargetObjectTargets(effIndex: number, target: number): void {
    const object = this.unitTargetOf();
    if (!object) return;
    this.addUnitTarget(object, 1 << effIndex, true, false);
    this.selectImplicitChainTargets(effIndex, target, object, 1 << effIndex);
  }

  /** `Spell::SelectImplicitChainTargets` */
  private selectImplicitChainTargets(effIndex: number, target: number, first: SpellUnit, effMask: number): void {
    const maxTargets = this.info.effects[effIndex]!.chainTarget;
    if (maxTargets <= 1) return;
    for (let k = effIndex; k < 3; k++) if (effMask & (1 << k)) this.damageMultipliers[k] = 1;
    this.applyMultiplierMask |= effMask;
    const data = IMPLICIT_TARGETS[target]!;
    const targets = this.searchChainTargets(maxTargets - 1, first, data.checkType, target === D.TARGET_UNIT_TARGET_CHAINHEAL_ALLY);
    for (const unit of targets) this.addUnitTarget(unit, effMask, false);
  }

  /** `Spell::SearchChainTargets` (line-of-sight checks wait for vmaps). */
  private searchChainTargets(chainTargets: number, target: SpellUnit, checkType: number, isChainHeal: boolean): SpellUnit[] {
    let jumpRadius = 0;
    switch (this.info.dmgClass) {
      case E.SPELL_DAMAGE_CLASS_RANGED:
        jumpRadius = 7.5;
        break;
      case E.SPELL_DAMAGE_CLASS_MELEE:
        jumpRadius = 10;
        break;
      default:
        jumpRadius = isChainHeal ? 12.5 : 10;
        break;
    }
    if (this.info.jumpDistance > 0) jumpRadius = this.info.jumpDistance;
    const isBouncingFar = hasAttribute(this.info, 4, D.SPELL_ATTR4_BOUNCY_CHAIN_MISSILES) || this.info.dmgClass === E.SPELL_DAMAGE_CLASS_NONE || this.info.dmgClass === E.SPELL_DAMAGE_CLASS_MAGIC;
    let searchRadius = jumpRadius;
    if (isBouncingFar) searchRadius *= chainTargets;
    let chainSource: SpellUnit = hasAttribute(this.info, 2, D.SPELL_ATTR2_CHAIN_FROM_CASTER) ? this.caster : target;
    let temp = this.searchAreaTargets(searchRadius, chainSource.position(), this.caster, checkType, "chain").filter((unit) => unit !== target);
    if (!isBouncingFar) temp = temp.filter((unit) => this.caster.hasInArc(Math.PI, unit));
    const result: SpellUnit[] = [];
    while (chainTargets) {
      let found: SpellUnit | null = null;
      if (isChainHeal) {
        let maxDeficit = 0;
        for (const unit of temp) {
          const deficit = unit.maxHealth - unit.health;
          if (deficit > maxDeficit && chainSource.distanceTo(unit) <= jumpRadius) {
            found = unit;
            maxDeficit = deficit;
          }
        }
      } else {
        for (const unit of temp) {
          if (!found) {
            if (!isBouncingFar || chainSource.distanceTo(unit) <= jumpRadius) found = unit;
          } else if (chainSource.distanceTo(unit) < chainSource.distanceTo(found)) {
            found = unit;
          }
        }
      }
      if (!found) break;
      if (!hasAttribute(this.info, 2, D.SPELL_ATTR2_CHAIN_FROM_CASTER)) chainSource = found;
      result.push(found);
      temp = temp.filter((unit) => unit !== found);
      chainTargets--;
    }
    return result;
  }

  /** `Spell::SelectEffectTypeImplicitTargets` */
  private selectEffectTypeImplicitTargets(effIndex: number): void {
    const effect = this.info.effects[effIndex]!;
    const implicitType = EFFECT_TARGETS[effect.effect]?.implicitTargetType ?? 0;
    if (!implicitType) return;
    const provided = targetFlagMask(IMPLICIT_TARGETS[effect.targetA]?.objectType ?? 0) | targetFlagMask(IMPLICIT_TARGETS[effect.targetB]?.objectType ?? 0);
    let mask = targetFlagMask(EFFECT_TARGETS[effect.effect]?.usedTargetObjectType ?? 0);
    if (provided & E.TARGET_FLAG_UNIT_MASK) mask &= ~E.TARGET_FLAG_UNIT_MASK;
    if (provided & E.TARGET_FLAG_CORPSE_MASK) mask &= ~(E.TARGET_FLAG_UNIT_MASK | E.TARGET_FLAG_CORPSE_MASK);
    if (provided & E.TARGET_FLAG_DEST_LOCATION) mask &= ~E.TARGET_FLAG_DEST_LOCATION;
    if (provided & E.TARGET_FLAG_SOURCE_LOCATION) mask &= ~E.TARGET_FLAG_SOURCE_LOCATION;
    if (!mask) return;
    let unit: SpellUnit | null = null;
    if (implicitType === E.EFFECT_IMPLICIT_TARGET_EXPLICIT) {
      if (mask & (E.TARGET_FLAG_UNIT_MASK | E.TARGET_FLAG_CORPSE_MASK)) {
        const explicit = this.unitTargetOf();
        if (explicit) unit = explicit;
        else if (!(mask & E.TARGET_FLAG_CORPSE_MASK)) unit = this.caster;
      }
    } else if (implicitType === E.EFFECT_IMPLICIT_TARGET_CASTER) {
      if (mask & E.TARGET_FLAG_UNIT_MASK) unit = this.caster;
    }
    if (unit) this.addUnitTarget(unit, 1 << effIndex, false);
  }

  /** `Spell::AddUnitTarget` (reflect is outside the baseline, so the caster never takes a reflected spell). */
  addUnitTarget(target: SpellUnit, effectMask: number, checkIfValid = true, implicit = true): void {
    for (let i = 0; i < 3; i++) {
      if (!this.info.effects[i]!.effect || !this.checkEffectTarget(target, i)) effectMask &= ~(1 << i);
    }
    if (!effectMask) return;
    if (checkIfValid && this.checkTarget(this.caster, target, implicit) !== D.SPELL_CAST_OK) return;
    for (let i = 0; i < 3; i++) if (target.isImmunedToSpellEffect(this.info, i, this.caster)) effectMask &= ~(1 << i);
    const existing = this.uniqueTargets.find((info) => info.targetGuid === target.guid);
    if (existing) {
      existing.effectMask |= effectMask;
      return;
    }
    const info: TargetInfo = {
      targetGuid: target.guid, timeDelay: 0, missCondition: D.SPELL_MISS_NONE, reflectResult: D.SPELL_MISS_NONE,
      effectMask, processed: false, alive: target.isAlive(), crit: false, scaleAura: false, damage: 0, damageBeforeTakenMods: 0,
    };
    if (this.originalCaster) {
      info.missCondition = math.spellHitResult(this.originalCaster, target, this.info, false, this.schoolMask);
    } else {
      info.missCondition = D.SPELL_MISS_EVADE;
    }
    if (this.info.speed > 0 && this.caster !== target) {
      let dist = this.caster.distanceTo(target);
      if (dist < 5) dist = 5;
      info.timeDelay = Math.floor((dist / this.info.speed) * 1000);
      if (this.delayMoment === 0 || this.delayMoment > info.timeDelay) this.delayMoment = info.timeDelay;
    }
    this.uniqueTargets.push(info);
  }

  /** `Spell::CheckEffectTarget` (charm limits; line of sight waits for vmaps). */
  private checkEffectTarget(target: SpellUnit, effIndex: number): boolean {
    switch (this.info.effects[effIndex]!.applyAuraName) {
      case D.SPELL_AURA_MOD_POSSESS:
      case D.SPELL_AURA_MOD_CHARM:
      case D.SPELL_AURA_MOD_POSSESS_PET:
      case D.SPELL_AURA_AOE_CHARM: {
        if (target.isMounted() && this.info.effects[effIndex]!.applyAuraName !== D.SPELL_AURA_MOD_POSSESS) return false;
        const damage = this.caster.calculateSpellDamage(this.info, effIndex, this.spellValue.basePoints[effIndex]);
        if (damage && target.level > damage) return false;
        break;
      }
      default:
        break;
    }
    return true;
  }

  // ------------------------------------------------------------------ hit processing

  /** `Spell::HandleLaunchPhase` (ammo is outside the baseline). */
  private handleLaunchPhase(): void {
    for (let i = 0; i < 3; i++) {
      if (!this.info.effects[i]!.effect) continue;
      this.handleEffects(null, i, E.SPELL_EFFECT_HANDLE_LAUNCH);
    }
    const multiplier: number[] = [1, 1, 1];
    for (let i = 0; i < 3; i++) if (this.applyMultiplierMask & (1 << i)) multiplier[i] = this.info.effects[i]!.damageMultiplier;
    this.prepareTargetProcessing();
    for (const target of this.uniqueTargets) {
      if (!target.effectMask) continue;
      if (this.originalCaster && target.missCondition !== D.SPELL_MISS_EVADE) {
        const unit = target.targetGuid === this.caster.guid ? this.caster : this.caster.world.unit(target.targetGuid);
        if (unit && !this.originalCaster.isFriendlyTo(unit) && (!isPositive(this.info) || hasEffect(this.info, D.SPELL_EFFECT_DISPEL)) && (hasInitialAggro(this.info) || unit.isInCombat())) {
          this.originalCaster.setInCombatWith(unit);
        }
      }
      this.doAllEffectOnLaunchTarget(target, multiplier);
    }
    this.finishTargetProcessing();
  }

  /** `Spell::DoAllEffectOnLaunchTarget` */
  private doAllEffectOnLaunchTarget(target: TargetInfo, multiplier: number[]): void {
    let unit: SpellUnit | null = null;
    if (target.missCondition === D.SPELL_MISS_NONE) unit = target.targetGuid === this.caster.guid ? this.caster : this.caster.world.unit(target.targetGuid);
    if (!unit) return;
    for (let i = 0; i < 3; i++) {
      if (!(target.effectMask & (1 << i))) continue;
      this.damage = 0;
      this.healing = 0;
      this.damageBeforeTakenMods = 0;
      this.handleEffects(unit, i, E.SPELL_EFFECT_HANDLE_LAUNCH_TARGET);
      if (this.damage > 0) {
        const effect = this.info.effects[i]!;
        if (isAreaAuraEffect(effect.effect) || effectIsTargetingArea(effect) || (effect.chainTarget > 1 && this.info.dmgClass !== E.SPELL_DAMAGE_CLASS_MAGIC)) {
          const npcCaster = !this.caster.isControlledByPlayer() || hasAttribute(this.info, 7, D.SPELL_ATTR7_TREAT_AS_NPC_AOE);
          this.damage = math.calculateAOEDamageReduction(unit, this.damage, this.info.schoolMask, npcCaster);
          if (this.caster.isPlayer && this.uniqueTargets.length > 10) this.damage = Math.trunc((this.damage * 10) / this.uniqueTargets.length);
        }
      }
      if (this.applyMultiplierMask & (1 << i)) {
        this.damage = Math.trunc(this.damage * this.damageMultipliers[i]!);
        this.damageMultipliers[i] = this.damageMultipliers[i]! * multiplier[i]!;
      }
      target.damage += this.damage;
      target.damageBeforeTakenMods += this.damageBeforeTakenMods;
    }
    const caster = this.originalCaster ?? this.caster;
    let critChance = math.spellDoneCritChance(caster, this.info, this.schoolMask, this.attackType, false);
    critChance = math.spellTakenCritChance(unit, caster, this.info, this.schoolMask, critChance, this.attackType, false);
    target.crit = Math.random() * 100 < Math.max(0, critChance);
  }

  /** `Spell::DoAllEffectOnTarget` (procs and far-target effects are outside the baseline). */
  private doAllEffectOnTarget(target: TargetInfo): void {
    if (target.processed) return;
    target.processed = true;
    const mask = target.effectMask;
    const effectUnit = target.targetGuid === this.caster.guid ? this.caster : this.caster.world.unit(target.targetGuid);
    if (!effectUnit) return;
    if (effectUnit.isAlive() !== target.alive) return;
    const now = this.caster.world.now();
    if (this.state === E.SPELL_STATE_DELAYED && !isPositive(this.info) && now - target.timeDelay <= effectUnit.lastSanctuaryTime) return;
    if (this.state !== E.SPELL_STATE_DELAYED && !isPositive(this.info) && effectUnit.lastSanctuaryTime && now <= effectUnit.lastSanctuaryTime + 400) return;
    const caster = this.originalCaster ?? this.caster;
    let missInfo = target.missCondition;
    this.unitTarget = effectUnit;
    this.damage = target.damage;
    this.healing = -target.damage;
    this.spellAura = null;
    if (this.originalCaster && missInfo !== D.SPELL_MISS_EVADE && !this.originalCaster.isFriendlyTo(effectUnit) && (!isPositive(this.info) || hasEffect(this.info, D.SPELL_EFFECT_DISPEL)) && (hasInitialAggro(this.info) || effectUnit.isInCombat())) {
      effectUnit.setInCombatWith(this.originalCaster);
    }
    let spellHitTarget: SpellUnit | null = null;
    if (missInfo === D.SPELL_MISS_NONE) spellHitTarget = effectUnit;
    if (spellHitTarget) {
      const missInfo2 = this.doSpellHitOnUnit(spellHitTarget, mask, target.scaleAura);
      if (missInfo2 !== D.SPELL_MISS_NONE) {
        if (missInfo2 !== D.SPELL_MISS_MISS) math.sendSpellMiss(this.caster, spellHitTarget, this.info.id, missInfo2);
        this.damage = 0;
        spellHitTarget = null;
        if (missInfo2 === D.SPELL_MISS_EVADE) missInfo = D.SPELL_MISS_EVADE;
      }
    }
    if (missInfo !== D.SPELL_MISS_NONE && this.needComboPoints && this.targets.object === target.targetGuid) this.needComboPoints = false;
    if (this.healing > 0) {
      let addHealth = this.healing;
      if (target.crit) addHealth = math.spellCriticalHealingBonus(caster, this.info, addHealth, null);
      const gain = math.healBySpell(caster, this.unitTarget!, this.info, addHealth, target.crit || this.spellValue.forcedCritResult);
      let threat = gain * 0.5;
      if (caster.classId === 2 /* CLASS_PALADIN */) threat *= 0.5;
      this.unitTarget!.forwardThreatForAssistingMe(caster, threat);
      this.healing = gain;
    } else if (this.damage > 0) {
      const victim = this.unitTarget!;
      caster.lastDamagedTarget = victim.guid;
      if (victim.isImmunedToDamage(caster, this.info)) {
        this.damage = 0;
      } else {
        const damageInfo: math.SpellNonMeleeDamage = { attacker: caster, target: victim, spell: this.info, schoolMask: this.schoolMask, damage: 0, absorb: 0, resist: 0, blocked: 0, hitInfo: 0, cleanDamage: 0, physicalLog: this.info.schoolMask === E.SPELL_SCHOOL_MASK_NORMAL };
        math.calculateSpellDamageTaken(caster, damageInfo, this.damage, this.info, this.attackType, target.crit);
        if (this.spellValue.forcedCritResult) damageInfo.hitInfo |= 0x2;
        const dealt = { value: damageInfo.damage };
        const absorb = { value: damageInfo.absorb };
        math.dealDamageMods(victim, dealt, absorb);
        damageInfo.damage = dealt.value;
        damageInfo.absorb = absorb.value;
        if (hasEffect(this.info, D.SPELL_EFFECT_HEALTH_LEECH)) {
          const effIndex = this.info.effects.findIndex((effect) => effect.effect === D.SPELL_EFFECT_HEALTH_LEECH);
          const healMultiplier = this.info.effects[effIndex]!.valueMultiplier;
          let healthGain = Math.trunc(-victim.healthGain(-damageInfo.damage) * healMultiplier);
          if (this.caster.isAlive()) {
            healthGain = math.spellHealingBonusDone(this.caster, this.caster, this.info, healthGain, E.HEAL, effIndex);
            healthGain = math.spellHealingBonusTaken(this.caster, this.caster, this.info, healthGain, E.HEAL);
            math.healBySpell(this.caster, this.caster, this.info, healthGain, false);
          }
        }
        math.sendSpellNonMeleeDamageLog(damageInfo);
        math.dealSpellDamage(damageInfo);
        this.damage = damageInfo.damage;
      }
    }
    if (missInfo !== D.SPELL_MISS_EVADE && !this.caster.isFriendlyTo(effectUnit) && (!isPositive(this.info) || hasEffect(this.info, D.SPELL_EFFECT_DISPEL))) {
      this.caster.atTargetAttacked(effectUnit, !(hasAttribute(this.info, 1, D.SPELL_ATTR1_NO_THREAT) || hasAttribute(this.info, 3, D.SPELL_ATTR3_SUPPRESS_TARGET_PROCS)));
      if (hasInitialAggro(this.info) && !effectUnit.isStandState()) effectUnit.setStandState(E.UNIT_STAND_STATE_STAND);
    }
    if (missInfo !== D.SPELL_MISS_EVADE && effectUnit !== this.caster && this.caster.isFriendlyTo(effectUnit) && isPositive(this.info) && effectUnit.isInCombat() && !hasAttribute(this.info, 1, D.SPELL_ATTR1_NO_THREAT)) {
      this.caster.setInCombatWith(effectUnit);
    }
    if (hasAttribute(this.info, 7, D.SPELL_ATTR7_CAN_CAUSE_INTERRUPT) && !effectUnit.isPlayer) caster.castSpell(effectUnit, 32747, { triggered: true });
    if (spellHitTarget) this.doTriggersOnSpellHit(spellHitTarget);
  }

  /** `Spell::DoSpellHitOnUnit` (diminishing returns and aura rank scaling are outside the baseline). */
  private doSpellHitOnUnit(unit: SpellUnit, effectMask: number, _scaleAura: boolean): number {
    if (!effectMask) return D.SPELL_MISS_EVADE;
    if (this.info.speed && ((this.damage > 0 && unit.isImmunedToDamage(this.caster, this.info)) || unit.isImmunedToSpell(this.info, this.caster, this.schoolMask))) return D.SPELL_MISS_IMMUNE;
    for (let i = 0; i < 3; i++) {
      if (effectMask & (1 << i) && unit.isImmunedToSpellEffect(this.info, i, this.caster)) effectMask &= ~(1 << i);
    }
    if (!effectMask) return D.SPELL_MISS_IMMUNE;
    if (this.caster !== unit) {
      if (this.info.speed > 0) {
        if (unit.isCreature && unit.isEvading()) return D.SPELL_MISS_EVADE;
        if (unit.hasUnitFlag(E.UNIT_FLAG_NON_ATTACKABLE) && unit.charmerOrOwner()?.guid !== this.caster.guid) return D.SPELL_MISS_EVADE;
      }
      if (this.caster.isValidAttackTarget(unit, this.info)) {
        unit.removeAurasWithInterruptFlags(E.AURA_INTERRUPT_FLAG_HITBYSPELL, 0);
      } else if (this.caster.isFriendlyTo(unit)) {
        if (!this.isTriggered() && this.info.speed > 0 && unit.isPlayer && !isPositive(this.info)) return D.SPELL_MISS_EVADE;
        if (this.originalCaster && unit.isInCombat() && !hasAttribute(this.info, 3, D.SPELL_ATTR3_SUPPRESS_TARGET_PROCS) && !this.triggeredByAura) {
          unit.forwardThreatForAssistingMe(this.originalCaster, 0);
        }
      }
    }
    let auraEffMask = 0;
    for (let i = 0; i < 3; i++) if (effectMask & (1 << i) && isAuraEffect(this.info.effects[i]!.effect)) auraEffMask |= 1 << i;
    if (this.caster !== unit && this.caster.isHostileTo(unit) && !isPositive(this.info) && !this.triggeredByAura && !hasCustomAttribute(this.info, E.SPELL_ATTR0_CU_DONT_BREAK_STEALTH)) {
      unit.removeAurasByType(D.SPELL_AURA_MOD_STEALTH);
    }
    if (auraEffMask && this.originalCaster) {
      const refreshPeriodic = this.info.stackAmount < 2 && !this.hasTriggeredCastFlag(E.TRIGGERED_NO_PERIODIC_RESET);
      const { aura, refresh } = Aura.tryRefreshStackOrCreate(this.info, effectMask, unit, this.originalCaster, {
        baseAmount: this.spellValue.basePoints,
        castItemGuid: this.castItem?.guid ?? 0n,
        castItemEntry: this.castItem?.entry ?? 0,
        periodicReset: refreshPeriodic,
      });
      this.spellAura = aura;
      if (aura) {
        if (this.spellValue.auraStackAmount > 1) {
          if (!refresh) aura.setStackAmount(this.spellValue.auraStackAmount);
          else aura.modStackAmount(this.spellValue.auraStackAmount);
        }
        let duration = aura.maxDuration;
        const positive = aura.getApplicationOfTarget(this.originalCaster.guid)?.isPositive() ?? isPositive(aura.spellInfo);
        duration = this.originalCaster.modSpellDuration(this.info, unit, duration, positive, effectMask);
        if (this.originalCaster.hasAuraType(D.SPELL_AURA_PERIODIC_HASTE) || hasAttribute(this.info, 5, D.SPELL_ATTR5_SPELL_HASTE_AFFECTS_PERIODIC)) duration = Math.trunc(duration * this.originalCaster.castSpeed);
        if (this.spellValue.auraDuration !== 0) {
          if (aura.maxDuration !== -1) aura.maxDuration = this.spellValue.auraDuration;
          aura.setDuration(this.spellValue.auraDuration);
        } else if (duration !== aura.maxDuration) {
          aura.maxDuration = duration;
          aura.setDuration(duration);
        }
        aura.registerForTargets();
      }
    }
    for (let i = 0; i < 3; i++) {
      if (this.info.effects[i]!.effect === D.SPELL_EFFECT_SANCTUARY) continue;
      if (effectMask & (1 << i)) this.handleEffects(unit, i, E.SPELL_EFFECT_HANDLE_HIT_TARGET);
    }
    return D.SPELL_MISS_NONE;
  }

  /** `Spell::DoTriggersOnSpellHit` — the `spell_linked_spell` hit links (`ADD_TARGET_TRIGGER` is the proc layer). */
  private doTriggersOnSpellHit(unit: SpellUnit): void {
    for (const row of this.caster.world.spells.worldData.linkedSpells(this.info.id, 1 /* SPELL_LINK_HIT */)) {
      if (row.spell_effect < 0) unit.removeAurasDueToSpell(-row.spell_effect);
      else unit.castSpell(unit, row.spell_effect, { triggered: true, originalCaster: this.caster.guid });
    }
  }

  /** `Spell::HandleEffects` */
  handleEffects(unit: SpellUnit | null, effIndex: number, mode: number): void {
    if (this.hasTriggeredCastFlag(E.TRIGGERED_IGNORE_EFFECTS)) return;
    this.effectHandleMode = mode;
    this.unitTarget = unit;
    const dest = this.destTargets[effIndex];
    this.destTarget = dest ?? (this.targets.dest ? { map: this.destMap ?? this.caster.position().map, ...this.targets.dest, o: this.destOrientation ?? this.caster.position().o } : null);
    this.effectDamage = this.caster.calculateSpellDamage(this.info, effIndex, this.spellValue.basePoints[effIndex]);
    SPELL_EFFECT_HANDLERS[this.info.effects[effIndex]!.effect]?.(this, effIndex);
  }

  /** `Spell::HandleThreatSpells` */
  private handleThreatSpells(): void {
    if (!this.uniqueTargets.length) return;
    if (hasAttribute(this.info, 1, D.SPELL_ATTR1_NO_THREAT) || hasAttribute(this.info, 3, D.SPELL_ATTR3_SUPPRESS_TARGET_PROCS)) return;
    const caster = this.originalCaster ?? this.caster;
    let threat = 0;
    const entry = caster.world.spells.threatEntry(this.info.id);
    if (entry) {
      if (entry.apPctMod !== 0) threat += entry.apPctMod * caster.stats.getTotalAttackPowerValue(math.BASE_ATTACK);
      threat += entry.flatMod;
    } else if (!hasCustomAttribute(this.info, E.SPELL_ATTR0_CU_NO_INITIAL_THREAT)) {
      threat += this.info.spellLevel;
    }
    if (threat === 0) return;
    threat /= this.uniqueTargets.length;
    for (const target of this.uniqueTargets) {
      const amount = target.missCondition !== D.SPELL_MISS_NONE ? 0 : threat;
      const unit = caster.world.unit(target.targetGuid);
      if (!unit) continue;
      if (isPositiveSpellDeep(this.info, caster)) unit.forwardThreatForAssistingMe(caster, amount);
      else if (unit.isCreature) unit.addThreat(caster, amount);
    }
  }

  // ------------------------------------------------------------------ costs

  /** `Spell::TakePower` */
  private takePower(): void {
    const caster = this.caster;
    if (this.castItem || this.triggeredByAura) return;
    const powerType = this.info.powerType;
    let hit = true;
    if (caster.isPlayer && (powerType === E.POWER_RAGE || powerType === E.POWER_ENERGY || powerType === E.POWER_RUNE || powerType === E.POWER_RUNIC_POWER) && this.targets.object) {
      const info = this.uniqueTargets.find((target) => target.targetGuid === this.targets.object);
      if (info && info.missCondition !== D.SPELL_MISS_NONE && info.missCondition !== D.SPELL_MISS_BLOCK && info.missCondition !== D.SPELL_MISS_ABSORB && info.missCondition !== D.SPELL_MISS_REFLECT) hit = false;
    }
    if (powerType === E.POWER_RUNE) return;
    if (!this.powerCost) return;
    if (powerType === E.POWER_HEALTH) {
      caster.modifyHealth(-this.powerCost);
      return;
    }
    if (powerType >= E.MAX_POWERS) return;
    if (hit) caster.modifyPower(powerType, -this.powerCost);
    else caster.modifyPower(powerType, -irand(0, Math.trunc(this.powerCost / 4)));
    if (powerType === E.POWER_MANA && this.powerCost > 0) caster.setLastManaUse(caster.world.now());
  }

  /** `Spell::TakeReagents` */
  private takeReagents(): void {
    const caster = this.caster;
    if (!caster.isPlayer) return;
    if (caster.canNoReagentCast(this.info)) return;
    for (const reagent of this.info.reagents) {
      let count = reagent.count;
      if (this.castItem && this.castItem.entry === reagent.item) {
        count++;
        this.castItem = null;
      }
      caster.destroyItemCount(reagent.item, count);
    }
  }

  /** `Spell::TakeCastItem` */
  private takeCastItem(): void {
    if (!this.castItem || !this.caster.isPlayer) return;
    if (this.hasTriggeredCastFlag(E.TRIGGERED_IGNORE_CAST_ITEM)) return;
    this.castItem.take?.();
    this.castItem = null;
  }

  /** `Spell::SendSpellCooldown` */
  private sendSpellCooldown(): void {
    const caster = this.caster;
    if (!caster.isPlayer) return;
    // Potions and cooldown-on-event items start their cooldown when the player leaves combat (`SetLastPotionId`).
    if (this.castItem && (this.castItem.isPotion || isCooldownStartedOnEvent(this.info))) {
      caster.lastPotion = { info: this.info, castItem: this.castItem };
      return;
    }
    if (isCooldownStartedOnEvent(this.info) || isPassive(this.info) || (this.hasTriggeredCastFlag(E.TRIGGERED_IGNORE_SPELL_AND_CATEGORY_CD) && !this.castItem) || this.hasTriggeredCastFlag(E.TRIGGERED_IGNORE_EFFECTS)) return;
    caster.addSpellAndCategoryCooldowns(this.info, this.castItem);
  }

  /** `Spell::TriggerGlobalCooldown` */
  private triggerGlobalCooldown(): void {
    let gcd = this.info.startRecoveryTime;
    if (!gcd) return;
    if (this.info.startRecoveryTime >= 1000 && this.info.startRecoveryTime <= 1500) {
      if (this.info.startRecoveryCategory === 133 && this.info.startRecoveryTime === 1500 && this.info.dmgClass !== E.SPELL_DAMAGE_CLASS_MELEE && this.info.dmgClass !== E.SPELL_DAMAGE_CLASS_RANGED && !hasAttribute(this.info, 0, D.SPELL_ATTR0_USES_RANGED_SLOT) && !hasAttribute(this.info, 0, D.SPELL_ATTR0_IS_ABILITY)) {
        gcd = Math.trunc(gcd * this.caster.castSpeed);
      }
      gcd = Math.min(1500, Math.max(1000, gcd));
    }
    if (this.caster.isPlayer) this.caster.addGlobalCooldown(this.info, gcd);
  }

  /** `Spell::CancelGlobalCooldown` */
  private cancelGlobalCooldown(): void {
    if (!this.info.startRecoveryTime) return;
    if (this.caster.currentSpells[E.CURRENT_GENERIC_SPELL] !== this) return;
    if (this.caster.isPlayer) this.caster.cancelGlobalCooldown(this.info);
  }

  /** `Spell::HasGlobalCooldown` */
  private hasGlobalCooldown(): boolean {
    return this.caster.isPlayer && this.caster.hasGlobalCooldown(this.info);
  }

  /** `Spell::IsAutoActionResetSpell` */
  private isAutoActionResetSpell(): boolean {
    if (this.isTriggered() || !(this.info.interruptFlags & E.SPELL_INTERRUPT_FLAG_INTERRUPT)) return false;
    if (!this.castTime && hasAttribute(this.info, 6, D.SPELL_ATTR6_DOESNT_RESET_SWING_TIMER_IF_INSTANT)) return false;
    return true;
  }

  /** `Spell::AddComboPointGain` */
  addComboPointGain(target: SpellUnit, amount: number): void {
    if (target !== this.comboTarget) {
      this.comboTarget = target;
      this.comboPointGain = amount;
    } else {
      this.comboPointGain += amount;
    }
  }

  /** `m_effectExecuteData`: per effect, a target counter and the entries `SMSG_SPELLLOGEXECUTE` carries. */
  private readonly executeData: ({ count: number; body: ByteWriter } | null)[] = [null, null, null];

  private initEffectExecuteData(effIndex: number): ByteWriter {
    const data = this.executeData[effIndex];
    if (data) {
      data.count++;
      return data.body;
    }
    const created = { count: 1, body: new ByteWriter() };
    this.executeData[effIndex] = created;
    return created.body;
  }

  /** `Spell::ExecuteLogEffectTakeTargetPower` */
  logTakeTargetPower(effIndex: number, target: SpellUnit, powerType: number, powerTaken: number, gainMultiplier: number): void {
    this.initEffectExecuteData(effIndex).writeBytes(packedGuid(target.guid)).writeU32(powerTaken >>> 0).writeU32(powerType).writeF32(gainMultiplier);
  }

  /** `Spell::ExecuteLogEffectInterruptCast` */
  logInterruptCast(effIndex: number, victim: SpellUnit, spellId: number): void {
    this.initEffectExecuteData(effIndex).writeBytes(packedGuid(victim.guid)).writeU32(spellId);
  }

  /** `Spell::PrepareTargetProcessing` (`CheckEffectExecuteData`) */
  private prepareTargetProcessing(): void {
    this.executeData.fill(null);
  }

  /** `Spell::FinishTargetProcessing` → `SendLogExecute` */
  private finishTargetProcessing(): void {
    const used = this.executeData.map((data, index) => ({ data, index })).filter((row) => row.data);
    if (!used.length) return;
    const body = new ByteWriter().writeBytes(packedGuid(this.caster.guid)).writeU32(this.info.id).writeU32(used.length);
    for (const { data, index } of used) {
      body.writeU32(this.info.effects[index]!.effect).writeU32(data!.count).writeBytes(data!.body.toUint8Array());
    }
    this.executeData.fill(null);
    this.caster.sendToSet(SMSG_SPELLLOGEXECUTE, body.toUint8Array(), true);
  }

  // ------------------------------------------------------------------ checks

  /** `SpellInfo::CheckTarget` (visibility and phases wait for the stealth and phase layers). */
  checkTarget(caster: SpellUnit, target: SpellUnit, implicit: boolean): number {
    const info = this.info;
    if (hasAttribute(info, 1, D.SPELL_ATTR1_EXCLUDE_CASTER) && caster === target) return D.SPELL_FAILED_BAD_TARGETS;
    if (hasAttribute(info, 1, D.SPELL_ATTR1_ONLY_PEACEFUL_TARGETS) && target.isInCombat()) return D.SPELL_FAILED_TARGET_AFFECTING_COMBAT;
    if (hasAttribute(info, 3, D.SPELL_ATTR3_NOT_ON_AOE_IMMUNE) && target.immuneToAoE()) return D.SPELL_FAILED_BAD_TARGETS;
    if (isRequiringDeadTarget(info)) {
      if (!target.hasAuraType(D.SPELL_AURA_GHOST)) return D.SPELL_FAILED_TARGET_NOT_GHOST;
      if (!isDeathPersistent(info) && !isAllowingDeadTarget(info)) return D.SPELL_FAILED_BAD_TARGETS;
    }
    if (caster !== target && caster.isPlayer) {
      if (hasAttribute(info, 2, D.SPELL_ATTR2_CANNOT_CAST_ON_TAPPED) && target.isCreature && !target.isTappedBy(caster)) return D.SPELL_FAILED_CANT_CAST_ON_TAPPED;
      if (hasCustomAttribute(info, E.SPELL_ATTR0_CU_PICKPOCKET) && !target.isCreature) return D.SPELL_FAILED_BAD_TARGETS;
    }
    if (target.isPlayer) {
      if (hasAttribute(info, 5, D.SPELL_ATTR5_NOT_ON_PLAYER)) return D.SPELL_FAILED_TARGET_IS_PLAYER;
    } else {
      if (hasAttribute(info, 3, D.SPELL_ATTR3_ONLY_ON_PLAYER)) return D.SPELL_FAILED_TARGET_NOT_PLAYER;
      if (hasAttribute(info, 5, D.SPELL_ATTR5_NOT_ON_PLAYER_CONTROLLED_NPC) && target.isControlledByPlayer()) return D.SPELL_FAILED_TARGET_IS_PLAYER_CONTROLLED;
    }
    if (!isAllowingDeadTarget(info) && !target.isAlive()) return D.SPELL_FAILED_TARGETS_DEAD;
    if (implicit && hasAttribute(info, 6, D.SPELL_ATTR6_DO_NOT_CHAIN_TO_CROWD_CONTROLLED_TARGETS) && target.hasUnitState(E.UNIT_STATE_CONTROLLED)) return D.SPELL_FAILED_BAD_TARGETS;
    if (!this.checkTargetCreatureType(target)) return target.isPlayer ? D.SPELL_FAILED_TARGET_IS_PLAYER : D.SPELL_FAILED_BAD_TARGETS;
    if (target !== caster && (caster.isControlledByPlayer() || !isPositive(info)) && target.isPlayer && target.isGameMaster()) return D.SPELL_FAILED_BM_OR_INVISGOD;
    if (target.isInFlight() && !hasCustomAttribute(info, E.SPELL_ATTR0_CU_ALLOW_INFLIGHT_TARGET)) return D.SPELL_FAILED_BAD_TARGETS;
    if (caster.charmerOrOwner() !== target) {
      if (info.targetAuraState && !target.hasAuraState(info.targetAuraState, info, caster)) return D.SPELL_FAILED_TARGET_AURASTATE;
      if (info.targetAuraStateNot && target.hasAuraState(info.targetAuraStateNot, info, caster)) return D.SPELL_FAILED_TARGET_AURASTATE;
    }
    if (info.targetAuraSpell && !target.hasAura(info.targetAuraSpell)) return D.SPELL_FAILED_TARGET_AURASTATE;
    if (info.excludeTargetAuraSpell && target.hasAura(info.excludeTargetAuraSpell)) return D.SPELL_FAILED_TARGET_AURASTATE;
    if (target.hasAuraType(D.SPELL_AURA_PREVENT_RESURRECTION) && !hasAttribute(info, 7, D.SPELL_ATTR7_BYPASS_NO_RESURRECTION_AURA)) {
      if (hasEffect(info, D.SPELL_EFFECT_SELF_RESURRECT) || hasEffect(info, D.SPELL_EFFECT_RESURRECT) || hasEffect(info, D.SPELL_EFFECT_RESURRECT_NEW)) return D.SPELL_FAILED_TARGET_CANNOT_BE_RESURRECTED;
    }
    return D.SPELL_CAST_OK;
  }

  /** `SpellInfo::CheckTargetCreatureType` */
  private checkTargetCreatureType(target: SpellUnit): boolean {
    if (this.info.spellFamilyName === E.SPELLFAMILY_WARLOCK && this.info.category === 1179) return !target.isPlayer;
    const creatureType = target.creatureTypeMask();
    return !this.info.targetCreatureType || !creatureType || (creatureType & this.info.targetCreatureType) !== 0;
  }

  /** `SpellInfo::CheckExplicitTarget` */
  checkExplicitTarget(caster: SpellUnit, target: SpellUnit | null): number {
    const needed = this.info.explicitTargetMask;
    if (!target) {
      if (needed & (E.TARGET_FLAG_UNIT_MASK | E.TARGET_FLAG_GAMEOBJECT_MASK | E.TARGET_FLAG_CORPSE_MASK)) return D.SPELL_FAILED_BAD_TARGETS;
      return D.SPELL_CAST_OK;
    }
    if (needed & (E.TARGET_FLAG_UNIT_ENEMY | E.TARGET_FLAG_UNIT_ALLY | E.TARGET_FLAG_UNIT_RAID | E.TARGET_FLAG_UNIT_PARTY | E.TARGET_FLAG_UNIT_MINIPET | E.TARGET_FLAG_UNIT_PASSENGER)) {
      if (needed & E.TARGET_FLAG_UNIT_ENEMY && caster.isValidAttackTarget(target, this.info)) return D.SPELL_CAST_OK;
      if (needed & E.TARGET_FLAG_UNIT_ALLY || (needed & E.TARGET_FLAG_UNIT_PARTY && caster.isInPartyWith(target, false)) || (needed & E.TARGET_FLAG_UNIT_RAID && caster.isInPartyWith(target, true))) {
        if (caster.isValidAssistTarget(target, this.info)) return D.SPELL_CAST_OK;
      }
      return D.SPELL_FAILED_BAD_TARGETS;
    }
    return D.SPELL_CAST_OK;
  }

  /** `Spell::CheckCast` (conditions, battlegrounds, arenas, vehicles, glyphs, pets, charges, and totems are outside the baseline). */
  checkCast(strict: boolean): number {
    const caster = this.caster;
    const info = this.info;
    if (!caster.isAlive() && !isPassive(info) && !(hasAttribute(info, 0, D.SPELL_ATTR0_ALLOW_CAST_WHILE_DEAD) || (this.isTriggered() && !this.triggeredByAura))) return D.SPELL_FAILED_CASTER_DEAD;
    if (!isPassive(info) && caster.isPlayer) {
      if (!this.hasTriggeredCastFlag(E.TRIGGERED_IGNORE_SPELL_AND_CATEGORY_CD) && caster.hasSpellCooldown(info.id, this.castItem)) return this.triggeredByAura ? D.SPELL_FAILED_DONT_REPORT : D.SPELL_FAILED_NOT_READY;
    }
    if (strict && !this.hasTriggeredCastFlag(E.TRIGGERED_IGNORE_GCD) && this.hasGlobalCooldown()) return D.SPELL_FAILED_NOT_READY;
    if (strict && !this.hasTriggeredCastFlag(E.TRIGGERED_IGNORE_SHAPESHIFT)) {
      const shapeError = checkShapeshift(info, caster.shapeshiftForm, (form) => caster.world.spells.shapeshift(form));
      if (shapeError !== D.SPELL_CAST_OK) return shapeError;
      if (hasAttribute(info, 0, D.SPELL_ATTR0_ONLY_STEALTHED) && !caster.hasAuraType(D.SPELL_AURA_MOD_STEALTH)) return D.SPELL_FAILED_ONLY_STEALTHED;
    }
    let reqCombat = true;
    for (const effect of caster.auraEffectsByType(D.SPELL_AURA_ABILITY_IGNORE_AURASTATE)) {
      if (effect.isAffectedOnSpell(info)) {
        this.needComboPoints = false;
        if (effect.miscValue === 1) {
          reqCombat = false;
          break;
        }
      }
    }
    if (!this.hasTriggeredCastFlag(E.TRIGGERED_IGNORE_CASTER_AURASTATE)) {
      if (info.casterAuraState && !caster.hasAuraState(info.casterAuraState, info, caster)) return D.SPELL_FAILED_CASTER_AURASTATE;
      if (info.casterAuraStateNot && caster.hasAuraState(info.casterAuraStateNot, info, caster)) return D.SPELL_FAILED_CASTER_AURASTATE;
      if (info.casterAuraSpell && !caster.hasAura(info.casterAuraSpell)) return D.SPELL_FAILED_CASTER_AURASTATE;
      if (info.excludeCasterAuraSpell && caster.hasAura(info.excludeCasterAuraSpell)) return D.SPELL_FAILED_CASTER_AURASTATE;
      if (reqCombat && caster.isInCombat() && !canBeUsedInCombat(info)) return D.SPELL_FAILED_AFFECTING_COMBAT;
    }
    if (caster.isPlayer && caster.isMoving() && !this.isTriggered() && (this.autoRepeat || (info.auraInterruptFlags & E.AURA_INTERRUPT_FLAG_NOT_SEATED) !== 0)) return D.SPELL_FAILED_MOVING;
    if (!(isPassive(info) && (!this.unitTargetOf() || this.unitTargetOf() === caster))) {
      if (!this.triggeredByAura || this.unitTargetOf() !== caster || !(info.explicitTargetMask & E.TARGET_FLAG_UNIT_ENEMY)) {
        const result = this.checkExplicitTarget(this.originalCaster ?? caster, this.unitTargetOf());
        if (result !== D.SPELL_CAST_OK) return result;
      }
    }
    const target = this.unitTargetOf();
    if (target) {
      const result = this.checkTarget(caster, target, false);
      if (result !== D.SPELL_CAST_OK) return result;
      if (target !== caster) {
        if (hasCustomAttribute(info, E.SPELL_ATTR0_CU_REQ_CASTER_BEHIND_TARGET) && target.hasInArc(Math.PI, caster)) return D.SPELL_FAILED_NOT_BEHIND;
        if (hasCustomAttribute(info, E.SPELL_ATTR0_CU_REQ_TARGET_FACING_CASTER) && !target.hasInArc(Math.PI, caster)) return D.SPELL_FAILED_NOT_INFRONT;
      }
    }
    for (const effect of info.effects) {
      if (effect.targetA === D.TARGET_UNIT_PET) return this.triggeredByAura ? D.SPELL_FAILED_DONT_REPORT : D.SPELL_FAILED_NO_PET;
    }
    if (caster.isMounted() && caster.isPlayer && !this.hasTriggeredCastFlag(E.TRIGGERED_IGNORE_CASTER_MOUNTED_OR_ON_VEHICLE) && !isPassive(info) && !hasAttribute(info, 0, D.SPELL_ATTR0_ALLOW_WHILE_MOUNTED)) {
      return caster.isInFlight() ? D.SPELL_FAILED_NOT_ON_TAXI : D.SPELL_FAILED_NOT_MOUNTED;
    }
    if (!isPassive(info)) {
      if (info.requiresSpellFocus) return D.SPELL_FAILED_REQUIRES_SPELL_FOCUS;
      const items = this.checkItems();
      if (items !== D.SPELL_CAST_OK) return items;
    }
    const range = this.checkRange(strict);
    if (range !== D.SPELL_CAST_OK) return range;
    if (!this.hasTriggeredCastFlag(E.TRIGGERED_IGNORE_POWER_AND_REAGENT_COST)) {
      const power = this.checkPower();
      if (power !== D.SPELL_CAST_OK) return power;
    }
    if (this.hasTriggeredCastFlag(E.TRIGGERED_IGNORE_EFFECTS)) return D.SPELL_CAST_OK;
    if (!this.hasTriggeredCastFlag(E.TRIGGERED_IGNORE_CASTER_AURAS) || (info.preventionType > 0 && this.triggeredByAura && isPositive(this.triggeredByAura.spellInfo))) {
      const auras = this.checkCasterAuras(this.hasTriggeredCastFlag(E.TRIGGERED_IGNORE_CASTER_AURAS));
      if (auras !== D.SPELL_CAST_OK) return auras;
    }
    let hasDispellableAura = false;
    let hasNonDispelEffect = false;
    let mask = 0;
    for (const effect of info.effects) {
      if (effect.effect === D.SPELL_EFFECT_DISPEL) {
        if (effectIsTargetingArea(effect) || hasAttribute(info, 1, D.SPELL_ATTR1_INITIATE_COMBAT)) {
          hasDispellableAura = true;
          break;
        }
        mask |= dispelMask(effect.miscValue);
      } else if (effect.effect) {
        hasNonDispelEffect = true;
        break;
      }
    }
    if (!hasNonDispelEffect && !hasDispellableAura && mask && !this.isTriggered() && target) {
      if (!target.getDispellableAuraList(caster, mask, info).length) return D.SPELL_FAILED_NOTHING_TO_DISPEL;
    }
    for (const effect of info.effects) {
      switch (effect.effect) {
        case D.SPELL_EFFECT_LEARN_SPELL:
          if (!caster.isPlayer) return D.SPELL_FAILED_BAD_TARGETS;
          break;
        case D.SPELL_EFFECT_POWER_BURN:
        case D.SPELL_EFFECT_POWER_DRAIN:
          if (caster.isPlayer && target && target !== caster && !target.hasActivePowerType(effect.miscValue)) return D.SPELL_FAILED_BAD_TARGETS;
          break;
        default:
          break;
      }
    }
    return D.SPELL_CAST_OK;
  }

  /** `Spell::CheckItems` for reagents and the equipped weapon or armor requirement. */
  private checkItems(): number {
    const caster = this.caster;
    if (!caster.isPlayer) return D.SPELL_CAST_OK;
    if (!this.castItem && !caster.canNoReagentCast(this.info)) {
      for (const reagent of this.info.reagents) {
        let count = reagent.count;
        if (this.castItem && (this.castItem as CastItem).entry === reagent.item) count++;
        if (!caster.hasItemCount(reagent.item, count)) return D.SPELL_FAILED_REAGENTS;
      }
    }
    if (!this.hasTriggeredCastFlag(E.TRIGGERED_IGNORE_EQUIPPED_ITEM_REQUIREMENT) && this.info.equippedItemClass >= 0 && !caster.hasItemFitToSpellRequirements(this.info)) return D.SPELL_FAILED_EQUIPPED_ITEM_CLASS;
    return D.SPELL_CAST_OK;
  }

  /** `Spell::CheckRange` */
  private checkRange(strict: boolean): number {
    const caster = this.caster;
    if (!strict && this.castTime === 0) return D.SPELL_CAST_OK;
    let rangeType = 0;
    if (this.info.range) {
      if (this.info.range.id === 1) return D.SPELL_CAST_OK;
      rangeType = this.info.range.flags;
    }
    const target = this.unitTargetOf();
    let maxRangeValue = caster.spellMaxRangeForTarget(target, this.info);
    const minRangeValue = caster.spellMinRangeForTarget(target, this.info);
    if (minRangeValue && caster.isCreature && minRangeValue <= 6) rangeType = E.SPELL_RANGE_RANGED;
    if (rangeType !== E.SPELL_RANGE_MELEE && !strict) maxRangeValue += Math.min(3, maxRangeValue * 0.1);
    if (target) {
      if (target !== caster) {
        if (rangeType === E.SPELL_RANGE_MELEE) {
          let realMax = maxRangeValue;
          if (caster.leewayBonusRange(target) > 0) realMax -= 4 / 3;
          else realMax -= 2 * (4 / 3);
          if (!caster.isWithinMeleeRange(target, Math.max(realMax, 0))) return D.SPELL_FAILED_OUT_OF_RANGE;
        } else if (!caster.isWithinCombatRange(target, maxRangeValue)) {
          return D.SPELL_FAILED_OUT_OF_RANGE;
        }
        if (caster.isPlayer && this.info.facingCasterFlags & E.SPELL_FACING_FLAG_INFRONT && !caster.hasInArc(Math.PI, target) && !caster.isWithinBoundaryRadius(target)) return D.SPELL_FAILED_UNIT_NOT_INFRONT;
      }
      if (rangeType === E.SPELL_RANGE_RANGED) {
        if (caster.distanceTo(target) <= minRangeValue + caster.meleeRange(target)) return D.SPELL_FAILED_TOO_CLOSE;
      } else if (minRangeValue > 0 && caster.isWithinCombatRange(target, minRangeValue)) {
        return D.SPELL_FAILED_TOO_CLOSE;
      }
    }
    if (this.hasDst()) {
      const dest = this.targets.dest!;
      if (caster.distanceTo(dest) > maxRangeValue + caster.leewayBonusRadius()) return D.SPELL_FAILED_OUT_OF_RANGE;
      if (minRangeValue && caster.distanceTo(dest) <= minRangeValue) return D.SPELL_FAILED_TOO_CLOSE;
    }
    return D.SPELL_CAST_OK;
  }

  /** `Spell::CheckPower` (rune costs are outside the baseline). */
  private checkPower(): number {
    const caster = this.caster;
    if (this.castItem) return D.SPELL_CAST_OK;
    if (this.info.powerType === E.POWER_HEALTH) return caster.health <= this.powerCost ? D.SPELL_FAILED_CASTER_AURASTATE : D.SPELL_CAST_OK;
    if (this.info.powerType >= E.MAX_POWERS) return D.SPELL_FAILED_UNKNOWN;
    // `CheckRuneCost`: only death knights pay runes, and the rune system is outside the baseline.
    if (this.info.powerType === E.POWER_RUNE) return this.info.runeCostId && this.caster.isPlayer && this.caster.classId === CLASS_DEATH_KNIGHT ? D.SPELL_FAILED_ERROR : D.SPELL_CAST_OK;
    return caster.power(this.info.powerType) < this.powerCost ? D.SPELL_FAILED_NO_POWER : D.SPELL_CAST_OK;
  }

  /** `Spell::CheckCasterAuras` */
  private checkCasterAuras(preventionOnly: boolean): number {
    const caster = this.caster;
    const info = this.info;
    if (hasAttribute(info, 6, D.SPELL_ATTR6_NOT_AN_ATTACK)) return D.SPELL_CAST_OK;
    let schoolImmune = 0;
    let mechanicImmune = 0n;
    let dispelImmune = 0;
    if (hasAttribute(info, 1, D.SPELL_ATTR1_IMMUNITY_PURGES_EFFECT)) {
      for (const effect of info.effects) {
        if (effect.applyAuraName === D.SPELL_AURA_SCHOOL_IMMUNITY) schoolImmune |= effect.miscValue;
        else if (effect.applyAuraName === D.SPELL_AURA_MECHANIC_IMMUNITY) mechanicImmune |= 1n << BigInt(effect.miscValue);
        else if (effect.applyAuraName === D.SPELL_AURA_DISPEL_IMMUNITY) dispelImmune |= dispelMask(effect.miscValue);
      }
    }
    const usableInStun = hasAttribute(info, 5, D.SPELL_ATTR5_ALLOW_WHILE_STUNNED) && !(info.id === 33206 && !caster.hasAura(63248));
    let prevented = D.SPELL_CAST_OK;
    const flags = caster.unitFlags;
    if (!preventionOnly) {
      if (flags & E.UNIT_FLAG_STUNNED) {
        if (usableInStun) {
          let mask = (1n << BigInt(E.MECHANIC_STUN)) | (1n << BigInt(E.MECHANIC_FREEZE)) | (1n << BigInt(E.MECHANIC_HORROR));
          if (info.id === 22812) mask |= (1n << BigInt(E.MECHANIC_SAPPED)) | (1n << BigInt(E.MECHANIC_HORROR)) | (1n << BigInt(E.MECHANIC_SLEEP));
          if (info.id === 1044) mask |= (1n << BigInt(E.MECHANIC_SAPPED)) | (1n << BigInt(E.MECHANIC_FEAR));
          for (const effect of caster.auraEffectsByType(D.SPELL_AURA_MOD_STUN)) {
            const auraMask = allEffectsMechanicMask(effect.spellInfo);
            if (auraMask && !(auraMask & mask)) {
              prevented = D.SPELL_FAILED_STUNNED;
              break;
            }
          }
        } else {
          prevented = D.SPELL_FAILED_STUNNED;
        }
      } else if (flags & E.UNIT_FLAG_CONFUSED && !hasAttribute(info, 5, D.SPELL_ATTR5_ALLOW_WHILE_CONFUSED)) {
        prevented = D.SPELL_FAILED_CONFUSED;
      } else if (flags & E.UNIT_FLAG_FLEEING && !hasAttribute(info, 5, D.SPELL_ATTR5_ALLOW_WHILE_FLEEING)) {
        prevented = D.SPELL_FAILED_FLEEING;
      }
    }
    if (prevented === D.SPELL_CAST_OK) {
      if (flags & E.UNIT_FLAG_SILENCED && info.preventionType === E.SPELL_PREVENTION_TYPE_SILENCE) prevented = D.SPELL_FAILED_SILENCED;
      else if (flags & E.UNIT_FLAG_PACIFIED && info.preventionType === E.SPELL_PREVENTION_TYPE_PACIFY) prevented = D.SPELL_FAILED_PACIFIED;
    }
    if (prevented === D.SPELL_CAST_OK) return D.SPELL_CAST_OK;
    if (!(schoolImmune || mechanicImmune || dispelImmune)) return prevented;
    for (const app of caster.appliedAuras) {
      const auraInfo = app.base.spellInfo;
      if (allEffectsMechanicMask(auraInfo) & mechanicImmune) continue;
      if (auraInfo.schoolMask & schoolImmune && !hasAttribute(auraInfo, 1, D.SPELL_ATTR1_IMMUNITY_TO_HOSTILE_AND_FRIENDLY_EFFECTS)) continue;
      if (dispelMask(auraInfo.dispel) & dispelImmune) continue;
      for (const part of app.base.effects) {
        if (!part) continue;
        switch (part.auraType) {
          case D.SPELL_AURA_MOD_STUN: {
            let mask = 1n << BigInt(E.MECHANIC_STUN);
            if (info.id === 22812) mask |= (1n << BigInt(E.MECHANIC_SAPPED)) | (1n << BigInt(E.MECHANIC_HORROR)) | (1n << BigInt(E.MECHANIC_SLEEP));
            if (info.id === 1044) mask |= (1n << BigInt(E.MECHANIC_SAPPED)) | (1n << BigInt(E.MECHANIC_FEAR));
            if (!usableInStun || !(allEffectsMechanicMask(auraInfo) & mask)) return D.SPELL_FAILED_STUNNED;
            break;
          }
          case D.SPELL_AURA_MOD_CONFUSE:
            if (!hasAttribute(info, 5, D.SPELL_ATTR5_ALLOW_WHILE_CONFUSED)) return D.SPELL_FAILED_CONFUSED;
            break;
          case D.SPELL_AURA_MOD_FEAR:
            if (!hasAttribute(info, 5, D.SPELL_ATTR5_ALLOW_WHILE_FLEEING)) return D.SPELL_FAILED_FLEEING;
            break;
          case D.SPELL_AURA_MOD_SILENCE:
          case D.SPELL_AURA_MOD_PACIFY:
          case D.SPELL_AURA_MOD_PACIFY_SILENCE:
            if (info.preventionType === E.SPELL_PREVENTION_TYPE_PACIFY) return D.SPELL_FAILED_PACIFIED;
            if (info.preventionType === E.SPELL_PREVENTION_TYPE_SILENCE) return D.SPELL_FAILED_SILENCED;
            break;
          default:
            break;
        }
      }
    }
    return D.SPELL_CAST_OK;
  }

  // ------------------------------------------------------------------ packets

  /** `Spell::SendCastResult` */
  sendCastResult(result: number): void {
    if (result === D.SPELL_CAST_OK || !this.caster.isPlayer) return;
    if (this.hasTriggeredCastFlag(E.TRIGGERED_DONT_REPORT_CAST_ERROR) && result !== D.SPELL_FAILED_BM_OR_INVISGOD) result = D.SPELL_FAILED_DONT_REPORT;
    const extra: number[] = [];
    switch (result) {
      case D.SPELL_FAILED_REQUIRES_SPELL_FOCUS:
        extra.push(this.info.requiresSpellFocus);
        break;
      case D.SPELL_FAILED_EQUIPPED_ITEM_CLASS:
        extra.push(this.info.equippedItemClass, this.info.equippedItemSubClassMask);
        break;
      case D.SPELL_FAILED_REAGENTS: {
        const missing = this.info.reagents.find((reagent) => !this.caster.hasItemCount(reagent.item, reagent.count));
        extra.push(missing?.item ?? 0);
        break;
      }
      case D.SPELL_FAILED_PREVENTED_BY_MECHANIC:
        extra.push(this.info.mechanic);
        break;
      case D.SPELL_FAILED_CUSTOM_ERROR:
        extra.push(this.customError);
        break;
      default:
        break;
    }
    this.caster.sendToSelf(SMSG_CAST_FAILED, castFailedPacket(this.castCount, this.info.id, result, extra));
  }

  /** `Spell::IsNeedSendToClient` */
  private isNeedSendToClient(go: boolean): boolean {
    if (this.hasTriggeredCastFlag(E.TRIGGERED_IGNORE_EFFECTS)) return false;
    return !!this.info.spellVisual[0] || !!this.info.spellVisual[1] || isChanneled(this.info) || this.info.speed > 0 || (!this.triggeredByAura && !this.isTriggered()) || (go && !!this.triggeredByAura && isChanneled(this.triggeredByAura.spellInfo));
  }

  private powerLeftFlag(): number {
    if (!this.caster.isPlayer && !this.caster.isPet()) return 0;
    if (this.info.powerType === E.POWER_HEALTH) return 0;
    if (this.info.powerType === E.POWER_RUNE) return E.CAST_FLAG_POWER_LEFT_SELF;
    return this.powerCost !== 0 ? E.CAST_FLAG_POWER_LEFT_SELF : 0;
  }

  private pendingFlag(): number {
    return ((this.isTriggered() && !isAutoRepeat(this.info)) || this.triggeredByAura) && !this.castCount && !(isChanneled(this.info) || this.info.castTime > 0) ? E.CAST_FLAG_PENDING : 0;
  }

  /** `Spell::SendSpellStart` */
  private sendSpellStart(): void {
    if (!this.isNeedSendToClient(false)) return;
    let castFlags = E.CAST_FLAG_HAS_TRAJECTORY | this.pendingFlag() | this.powerLeftFlag();
    if (hasAttribute(this.info, 0, D.SPELL_ATTR0_USES_RANGED_SLOT) || hasCustomAttribute(this.info, E.SPELL_ATTR0_CU_NEEDS_AMMO_DATA)) castFlags |= E.CAST_FLAG_PROJECTILE;
    if (this.info.runeCostId && this.info.powerType === E.POWER_RUNE) castFlags |= E.CAST_FLAG_NO_GCD;
    const body = new ByteWriter()
      .writeBytes(packedGuid(this.castItem?.guid || this.caster.guid))
      .writeBytes(packedGuid(this.caster.guid))
      .writeU8(this.castCount)
      .writeU32(this.info.id)
      .writeU32(castFlags >>> 0)
      .writeU32(this.timer >>> 0);
    writeTargets(body, this.targets);
    if (castFlags & E.CAST_FLAG_POWER_LEFT_SELF) body.writeU32(this.caster.power(this.info.powerType) >>> 0);
    if (castFlags & E.CAST_FLAG_PROJECTILE) body.writeU32(0).writeU32(0);
    this.caster.sendToSet(SMSG_SPELL_START, body.toUint8Array(), true);
  }

  /** `Spell::SendSpellGo` with `WriteSpellGoTargets`. */
  private sendSpellGo(): void {
    if (!this.isNeedSendToClient(true)) return;
    let castFlags = E.CAST_FLAG_UNKNOWN_9 | this.pendingFlag() | this.powerLeftFlag();
    if (hasAttribute(this.info, 0, D.SPELL_ATTR0_USES_RANGED_SLOT) || hasCustomAttribute(this.info, E.SPELL_ATTR0_CU_NEEDS_AMMO_DATA)) castFlags |= E.CAST_FLAG_PROJECTILE;
    if (!this.info.startRecoveryTime) castFlags |= E.CAST_FLAG_NO_GCD;
    for (const target of this.uniqueTargets) if (target.effectMask === 0) target.missCondition = D.SPELL_MISS_IMMUNE2;
    const body = new ByteWriter()
      .writeBytes(packedGuid(this.castItem?.guid || this.caster.guid))
      .writeBytes(packedGuid(this.caster.guid))
      .writeU8(this.castCount)
      .writeU32(this.info.id)
      .writeU32(castFlags >>> 0)
      .writeU32(this.caster.world.now() >>> 0);
    const hits = this.uniqueTargets.filter((target) => target.missCondition === D.SPELL_MISS_NONE).slice(0, 255);
    body.writeU8(hits.length);
    for (const hit of hits) body.writeU64(hit.targetGuid);
    const misses = this.uniqueTargets.filter((target) => target.missCondition !== D.SPELL_MISS_NONE).slice(0, 255);
    body.writeU8(misses.length);
    for (const miss of misses) {
      body.writeU64(miss.targetGuid).writeU8(miss.missCondition);
      if (miss.missCondition === D.SPELL_MISS_REFLECT) body.writeU8(miss.reflectResult);
    }
    writeTargets(body, this.targets);
    if (castFlags & E.CAST_FLAG_POWER_LEFT_SELF) body.writeU32(this.caster.power(this.info.powerType) >>> 0);
    if (castFlags & E.CAST_FLAG_PROJECTILE) body.writeU32(0).writeU32(0);
    if (this.targets.mask & E.TARGET_FLAG_DEST_LOCATION) body.writeU8(0);
    this.caster.sendToSet(SMSG_SPELL_GO, body.toUint8Array(), true);
  }

  /** `Spell::SendInterrupted` */
  private sendInterrupted(result: number): void {
    const body = spellFailurePacket(this.caster.guid, this.castCount, this.info.id, result);
    this.caster.sendToSet(SMSG_SPELL_FAILURE, body, true);
    this.caster.sendToSet(SMSG_SPELL_FAILED_OTHER, body, true);
  }

  /** `Spell::SendChannelUpdate` */
  sendChannelUpdate(time: number): void {
    if (time === 0) {
      this.caster.setChannel(0n, 0);
    }
    this.caster.sendToSet(MSG_CHANNEL_UPDATE, channelUpdatePacket(this.caster.guid, time), true);
  }

  /** `Spell::SendChannelStart` */
  private sendChannelStart(duration: number): void {
    let channelTarget = this.targets.object;
    if (!channelTarget && !needsExplicitUnitTarget(this.info) && this.uniqueTargets.length === 1) channelTarget = this.uniqueTargets[0]!.targetGuid;
    this.caster.sendToSet(MSG_CHANNEL_START, channelStartPacket(this.caster.guid, this.info.id, duration), true);
    this.timer = duration;
    this.caster.setChannel(channelTarget, this.info.id);
  }
}

const CLASS_DEATH_KNIGHT = 6;

function spellMaxDurationOf(info: SpellInfo): number {
  const max = info.duration[2];
  return max === -1 ? -1 : Math.abs(max);
}

/** `SpellInfo::_IsPositiveSpell` (every effect positive, deep). */
function isPositiveSpellDeep(info: SpellInfo, _caster: SpellUnit): boolean {
  return info.effects.every((_, i) => isPositiveEffect(info, i));
}

/**
 * Why the baseline cannot run this spell yet, or null. The whole trigger chain is checked so a cast never spends
 * power, cooldown, or an item charge on a child that would do nothing.
 */
export function unsupportedReason(info: SpellInfo, spells: import("./spell-info.ts").SpellStore, visiting = new Set<number>()): string | null {
  if (visiting.has(info.id)) return null;
  visiting.add(info.id);
  const world = spells.worldData;
  for (const effect of info.effects) {
    if (!effect.effect) continue;
    if (!isEffectSupported(effect.effect)) return `effect ${effect.effect}`;
    if ((effect.effect === D.SPELL_EFFECT_DUMMY || effect.effect === D.SPELL_EFFECT_SCRIPT_EFFECT) && (world.hasScriptName(info.id) || world.hasSpellScripts(info.id, effect.index))) return `script effect ${effect.effect}`;
    for (const target of [effect.targetA, effect.targetB]) {
      const category = IMPLICIT_TARGETS[target]?.selectionCategory;
      if (target && (category === E.TARGET_SELECT_CATEGORY_TRAJ || category === E.TARGET_SELECT_CATEGORY_NYI)) return `target ${target}`;
      const objectType = IMPLICIT_TARGETS[target]?.objectType;
      if (target && (objectType === E.TARGET_OBJECT_TYPE_GOBJ || objectType === E.TARGET_OBJECT_TYPE_GOBJ_ITEM || objectType === E.TARGET_OBJECT_TYPE_CORPSE || objectType === E.TARGET_OBJECT_TYPE_ITEM)) return `target ${target}`;
      if (target && IMPLICIT_TARGETS[target]?.checkType === E.TARGET_CHECK_ENTRY) return `target ${target}`;
      if (target === D.TARGET_UNIT_PET || target === D.TARGET_UNIT_SUMMONER || target === D.TARGET_UNIT_VEHICLE || (target >= D.TARGET_UNIT_PASSENGER_0 && target <= D.TARGET_UNIT_PASSENGER_7)) return `target ${target}`;
    }
    if (effectIsAura(effect)) {
      if (!isAuraTypeSupported(effect.applyAuraName)) return `aura ${effect.applyAuraName}`;
      if ((effect.applyAuraName === D.SPELL_AURA_DUMMY || effect.applyAuraName === D.SPELL_AURA_PERIODIC_DUMMY) && world.hasScriptName(info.id)) return `script aura ${effect.applyAuraName}`;
      if (effect.applyAuraName === D.SPELL_AURA_PERIODIC_TRIGGER_SPELL || effect.applyAuraName === D.SPELL_AURA_PERIODIC_TRIGGER_SPELL_WITH_VALUE) {
        const child = spells.get(effect.triggerSpell);
        if (child) {
          const reason = unsupportedReason(child, spells, visiting);
          if (reason) return `trigger ${child.id}: ${reason}`;
        }
      }
    }
    if (effect.effect === D.SPELL_EFFECT_TRIGGER_SPELL || effect.effect === D.SPELL_EFFECT_TRIGGER_SPELL_WITH_VALUE) {
      if ([58832, 54437, 23770, 29284, 29286, 35729].includes(effect.triggerSpell)) return `scripted trigger ${effect.triggerSpell}`;
      const child = spells.get(effect.triggerSpell);
      if (child) {
        const reason = unsupportedReason(child, spells, visiting);
        if (reason) return `trigger ${child.id}: ${reason}`;
      }
    }
  }
  if (world.hasScriptName(info.id)) return "spell script";
  if (SCRIPTED_EFFECT_SPELLS.has(info.id)) return "scripted effect branch";
  if (classDamageBranch(info)) return "class damage branch";
  if (info.effects.some((effect) => effect.effect === D.SPELL_EFFECT_DUMMY && world.hasPetAura(info.id, effect.index))) return "pet aura";
  if (isAutoRepeat(info)) return "auto repeat";
  return null;
}

export type { Location };
