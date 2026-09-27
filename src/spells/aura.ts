import { ByteWriter } from "../net/byte-buffer.ts";
import { packedGuid } from "../world/update-object.ts";
import { AURA_EFFECT_HANDLERS, periodicTick, updatePeriodic } from "./aura-effects.ts";
import {
  SPELL_ATTR0_DO_NOT_DISPLAY,
  SPELL_ATTR1_AURA_UNIQUE,
  SPELL_ATTR2_NO_TARGET_PER_SECOND_COST,
  SPELL_ATTR3_DOT_STACKING_RULE,
  SPELL_ATTR5_DO_NOT_DISPLAY_DURATION,
  SPELL_ATTR5_EXTRA_INITIAL_PERIOD,
  SPELL_ATTR5_SPELL_HASTE_AFFECTS_PERIODIC,
  SPELL_ATTR7_DISPEL_REMOVES_CHARGES,
  SPELL_AURA_ABILITY_IGNORE_AURASTATE,
  SPELL_AURA_CONTROL_VEHICLE,
  SPELL_AURA_DAMAGE_SHIELD,
  SPELL_AURA_MANA_SHIELD,
  SPELL_AURA_MOD_CONFUSE,
  SPELL_AURA_MOD_DISPEL_RESIST,
  SPELL_AURA_MOD_FEAR,
  SPELL_AURA_MOD_ROOT,
  SPELL_AURA_MOD_STUN,
  SPELL_AURA_OBS_MOD_HEALTH,
  SPELL_AURA_OBS_MOD_POWER,
  SPELL_AURA_PERIODIC_DAMAGE,
  SPELL_AURA_PERIODIC_DAMAGE_PERCENT,
  SPELL_AURA_PERIODIC_DUMMY,
  SPELL_AURA_PERIODIC_ENERGIZE,
  SPELL_AURA_PERIODIC_HASTE,
  SPELL_AURA_PERIODIC_HEAL,
  SPELL_AURA_PERIODIC_HEALTH_FUNNEL,
  SPELL_AURA_PERIODIC_LEECH,
  SPELL_AURA_PERIODIC_MANA_LEECH,
  SPELL_AURA_PERIODIC_TRIGGER_SPELL,
  SPELL_AURA_PERIODIC_TRIGGER_SPELL_FROM_CLIENT,
  SPELL_AURA_PERIODIC_TRIGGER_SPELL_WITH_VALUE,
  SPELL_AURA_POWER_BURN,
  SPELL_AURA_PROC_TRIGGER_SPELL,
  SPELL_AURA_SCHOOL_ABSORB,
  SPELL_AURA_TRANSFORM,
  SPELL_EFFECT_APPLY_AURA,
  SPELL_EFFECT_APPLY_AREA_AURA_ENEMY,
  SPELL_EFFECT_APPLY_AREA_AURA_FRIEND,
  SPELL_EFFECT_APPLY_AREA_AURA_OWNER,
  SPELL_EFFECT_APPLY_AREA_AURA_PARTY,
  SPELL_EFFECT_APPLY_AREA_AURA_PET,
  SPELL_EFFECT_APPLY_AREA_AURA_RAID,
  SPELL_AURA_MOD_DECREASE_SPEED,
} from "./defines.ts";
import {
  AFLAG_CASTER,
  AFLAG_DURATION,
  AFLAG_NEGATIVE,
  AFLAG_NONE,
  AFLAG_POSITIVE,
  AFLAG_EFF_INDEX_0,
  AFLAG_EFF_INDEX_1,
  AFLAG_EFF_INDEX_2,
  AURA_EFFECT_HANDLE_CHANGE_AMOUNT,
  AURA_EFFECT_HANDLE_CHANGE_AMOUNT_MASK,
  AURA_EFFECT_HANDLE_REAL,
  AURA_EFFECT_HANDLE_REAPPLY,
  AURA_REMOVE_BY_DEFAULT,
  AURA_REMOVE_BY_ENEMY_SPELL,
  AURA_REMOVE_NONE,
  AURA_STATE_BANISHED,
  SPELL_ATTR0_CU_AURA_CANNOT_BE_SAVED,
  SPELL_ATTR0_CU_ENCHANT_PROC,
  SPELL_ATTR0_CU_FORCE_AURA_SAVING,
  SPELL_GROUP_STACK_RULE_EXCLUSIVE,
  SPELL_GROUP_STACK_RULE_EXCLUSIVE_FROM_SAME_CASTER,
  SPELL_GROUP_STACK_RULE_EXCLUSIVE_HIGHEST,
  SPELL_SPECIFIC_AURA,
  SPELL_SPECIFIC_JUDGEMENT,
  SPELL_SPECIFIC_MAGE_POLYMORPH,
  SPELLFAMILY_HUNTER,
} from "./enums.ts";
import { SMSG_AURA_UPDATE, writeAuraSlot, type AuraSlotUpdate } from "./packets.ts";
import {
  calcEffectValue,
  calcRadius,
  calcSpellDuration,
  effectIsTargetingArea,
  hasAttribute,
  hasAura,
  hasCustomAttribute,
  isAreaAuraEffect,
  isAuraEffect,
  isAuraExclusiveBySpecificPerCasterWith,
  isAuraExclusiveBySpecificWith,
  isCooldownStartedOnEvent,
  isChanneled,
  isDeathPersistent,
  isMultiSlotAura,
  isPassive,
  isPositiveEffect,
  isSingleTarget,
  spellMaxDuration,
  type SpellInfo,
} from "./spell-info.ts";
import type { SpellUnit } from "./unit.ts";

/** WotLK `MAX_AURAS` (the aura slot is a uint8 in update packets). */
export const MAX_AURAS = 255;
const UPDATE_TARGET_MAP_INTERVAL = 500;
const EXPANSION_WRATH_OF_THE_LICH_KING = 2;

/** `AuraApplication` */
export class AuraApplication {
  removeMode = AURA_REMOVE_NONE;
  slot = MAX_AURAS;
  flags = AFLAG_NONE;
  needClientUpdate = false;
  disableMask = 0;

  constructor(
    readonly target: SpellUnit,
    caster: SpellUnit | null,
    readonly base: Aura,
    readonly effectsToApply: number,
  ) {
    if (base.canBeSentToClient()) {
      let slot = MAX_AURAS;
      const found = target.getAuraApplication(base.id, base.casterGuid, base.castItemGuid);
      if (found) {
        slot = found.slot;
      } else {
        for (let free = 0; free < MAX_AURAS; free++) {
          if (!target.visibleAuras.has(free)) {
            slot = free;
            break;
          }
        }
      }
      if (slot < MAX_AURAS) {
        this.slot = slot;
        target.visibleAuras.set(slot, this);
        this.needClientUpdate = true;
      }
    }
    this.initFlags(caster, effectsToApply);
  }

  get effectMask(): number {
    return this.flags & (AFLAG_EFF_INDEX_0 | AFLAG_EFF_INDEX_1 | AFLAG_EFF_INDEX_2);
  }

  hasEffect(effIndex: number): boolean {
    return (this.flags & (1 << effIndex)) !== 0;
  }

  isPositive(): boolean {
    return (this.flags & AFLAG_POSITIVE) !== 0;
  }

  isSelfcasted(): boolean {
    return (this.flags & AFLAG_CASTER) !== 0;
  }

  isActive(effIndex: number): boolean {
    return ((1 << effIndex) & this.disableMask) === 0;
  }

  /** `AuraApplication::_Remove` */
  remove(): void {
    let slot = this.slot;
    if (slot >= MAX_AURAS) return;
    const found = this.target.getAuraApplication(this.base.id, this.base.casterGuid, this.base.castItemGuid);
    if (found && slot === found.slot) {
      if (this.target.visibleAuras.get(slot) === this) {
        this.target.visibleAuras.set(slot, found);
        found.needClientUpdate = true;
      }
      slot = MAX_AURAS;
    }
    if (slot < MAX_AURAS) {
      this.target.visibleAuras.delete(slot);
      this.clientUpdate(true);
    }
  }

  private initFlags(caster: SpellUnit | null, effMask: number): void {
    this.flags |= this.base.casterGuid === this.target.guid ? AFLAG_CASTER : AFLAG_NONE;
    const info = this.base.spellInfo;
    if (this.isSelfcasted() || !caster || !caster.isFriendlyTo(this.target)) {
      let negativeFound = false;
      for (let i = 0; i < 3; i++) {
        if ((1 << i) & effMask && !isPositiveEffect(info, i)) {
          negativeFound = true;
          break;
        }
      }
      this.flags |= negativeFound ? AFLAG_NEGATIVE : AFLAG_POSITIVE;
    } else {
      let positiveFound = false;
      for (let i = 0; i < 3; i++) {
        if ((1 << i) & effMask && isPositiveEffect(info, i)) {
          positiveFound = true;
          break;
        }
      }
      this.flags |= positiveFound ? AFLAG_POSITIVE : AFLAG_NEGATIVE;
    }
  }

  /** `AuraApplication::_HandleEffect` */
  handleEffect(effIndex: number, apply: boolean): void {
    const aurEff = this.base.effects[effIndex];
    if (!aurEff) return;
    if (apply) {
      this.flags |= 1 << effIndex;
      aurEff.handleEffect(this, AURA_EFFECT_HANDLE_REAL, true);
    } else {
      this.flags &= ~(1 << effIndex);
      aurEff.handleEffect(this, AURA_EFFECT_HANDLE_REAL, false);
    }
    this.needClientUpdate = true;
  }

  /** `AuraApplication::BuildUpdatePacket` as the slot update the packet writer takes. */
  slotUpdate(remove: boolean): AuraSlotUpdate {
    if (remove) return { slot: this.slot, spellId: 0, flags: 0, casterLevel: 0, stack: 0, caster: 0n, maxDuration: 0, duration: 0 };
    const aura = this.base;
    let flags = this.flags;
    if (aura.maxDuration > 0 && !hasAttribute(aura.spellInfo, 5, SPELL_ATTR5_DO_NOT_DISPLAY_DURATION)) flags |= AFLAG_DURATION;
    if (!this.isSelfcasted() && aura.spellInfo.spellSpecific === SPELL_SPECIFIC_AURA) flags &= ~AFLAG_POSITIVE;
    return {
      slot: this.slot,
      spellId: aura.id,
      flags,
      casterLevel: aura.casterLevel,
      stack: aura.spellInfo.stackAmount ? aura.stackAmount : aura.procCharges,
      caster: aura.casterGuid,
      maxDuration: aura.maxDuration,
      duration: aura.duration,
    };
  }

  /** `AuraApplication::ClientUpdate` → `SMSG_AURA_UPDATE` to the target and everyone who sees it. */
  clientUpdate(remove = false): void {
    this.needClientUpdate = false;
    const body = new ByteWriter().writeBytes(packedGuid(this.target.guid));
    writeAuraSlot(body, this.slotUpdate(remove));
    this.target.sendToSet(SMSG_AURA_UPDATE, body.toUint8Array(), true);
  }
}

/** `Aura` / `UnitAura`. Dynamic object auras are outside the baseline. */
export class Aura {
  readonly applications = new Map<bigint, AuraApplication>();
  readonly effects: [AuraEffect | null, AuraEffect | null, AuraEffect | null] = [null, null, null];
  readonly applyTime: number;
  readonly casterLevel: number;
  maxDuration: number;
  duration: number;
  timeCla = 0;
  updateTargetMapInterval = 0;
  procCharges: number;
  stackAmount = 1;
  isRemoved = false;
  isSingleTarget = false;
  isUsingCharges: boolean;
  castItemGuid: bigint;

  private constructor(
    readonly spellInfo: SpellInfo,
    readonly owner: SpellUnit,
    caster: SpellUnit | null,
    readonly casterGuid: bigint,
    castItemGuid: bigint,
    readonly castItemEntry: number,
  ) {
    this.castItemGuid = castItemGuid;
    this.applyTime = Math.floor(owner.world.now() / 1000);
    this.casterLevel = caster ? caster.level : spellInfo.spellLevel;
    if ((spellInfo.manaPerSecond || spellInfo.manaPerSecondPerLevel) && !hasAttribute(spellInfo, 2, SPELL_ATTR2_NO_TARGET_PER_SECOND_COST)) this.timeCla = 1000;
    this.maxDuration = this.calcMaxDuration(caster);
    this.duration = this.maxDuration;
    this.procCharges = this.calcMaxCharges();
    this.isUsingCharges = this.procCharges !== 0;
  }

  get id(): number {
    return this.spellInfo.id;
  }

  /** `Aura::BuildEffectMaskForOwner` for unit owners. */
  static buildEffectMaskForOwner(info: SpellInfo, available: number): number {
    let effMask = 0;
    for (const effect of info.effects) if (isAuraEffect(effect.effect)) effMask |= 1 << effect.index;
    return effMask & available;
  }

  /** `Aura::TryRefreshStackOrCreate` */
  static tryRefreshStackOrCreate(
    info: SpellInfo, tryEffMask: number, owner: SpellUnit, caster: SpellUnit | null,
    options: { baseAmount?: readonly number[]; castItemGuid?: bigint; castItemEntry?: number; casterGuid?: bigint; periodicReset?: boolean } = {},
  ): { aura: Aura | null; refresh: boolean } {
    const effMask = Aura.buildEffectMaskForOwner(info, tryEffMask);
    if (!effMask) return { aura: null, refresh: false };
    const found = owner.tryStackingOrRefreshingExistingAura(info, effMask, caster, options.baseAmount, options.castItemGuid ?? 0n, options.casterGuid ?? 0n, options.periodicReset ?? false);
    if (found) return { aura: found.isRemoved ? null : found, refresh: !found.isRemoved };
    return { aura: Aura.create(info, effMask, owner, caster, options), refresh: false };
  }

  /** `Aura::TryCreate` */
  static tryCreate(info: SpellInfo, tryEffMask: number, owner: SpellUnit, caster: SpellUnit | null, options: { baseAmount?: readonly number[]; castItemGuid?: bigint; castItemEntry?: number; casterGuid?: bigint } = {}): Aura | null {
    const effMask = Aura.buildEffectMaskForOwner(info, tryEffMask);
    if (!effMask) return null;
    return Aura.create(info, effMask, owner, caster, options);
  }

  /** `Aura::Create` → `UnitAura::UnitAura` (`_InitEffects`, `_AddAura`). */
  static create(info: SpellInfo, effMask: number, owner: SpellUnit, caster: SpellUnit | null, options: { baseAmount?: readonly number[]; castItemGuid?: bigint; castItemEntry?: number; casterGuid?: bigint } = {}): Aura | null {
    let casterGuid = options.casterGuid ?? 0n;
    if (casterGuid) caster = owner.guid === casterGuid ? owner : owner.world.unit(casterGuid);
    else if (caster) casterGuid = caster.guid;
    else return null;
    if (!owner.inWorld && casterGuid !== owner.guid && isSingleTarget(info)) return null;
    const aura = new Aura(info, owner, caster, casterGuid, options.castItemGuid ?? 0n, options.castItemEntry ?? 0);
    for (let i = 0; i < 3; i++) {
      if (effMask & (1 << i)) aura.effects[i] = new AuraEffect(aura, i, options.baseAmount?.[i], caster);
    }
    owner.addOwnedAura(aura, caster);
    return aura.isRemoved ? null : aura;
  }

  get effectMask(): number {
    let mask = 0;
    for (let i = 0; i < 3; i++) if (this.effects[i]) mask |= 1 << i;
    return mask;
  }

  hasEffect(index: number): boolean {
    return this.effects[index] !== null;
  }

  hasEffectType(type: number): boolean {
    return this.effects.some((effect) => effect !== null && effect.auraType === type);
  }

  /** `Aura::HasMoreThanOneEffectForType` */
  hasMoreThanOneEffectForType(type: number): boolean {
    return this.effects.filter((effect) => effect !== null && effect.auraType === type).length > 1;
  }

  /** `Aura::GetCaster` */
  getCaster(): SpellUnit | null {
    if (this.owner.guid === this.casterGuid) return this.owner;
    const app = this.applications.get(this.casterGuid);
    if (app) return app.target;
    return this.owner.world.unit(this.casterGuid);
  }

  isArea(): boolean {
    return this.effects.some((effect, i) => effect !== null && isAreaAuraEffect(this.spellInfo.effects[i]!.effect));
  }

  isPassive(): boolean {
    return isPassive(this.spellInfo);
  }

  isDeathPersistent(): boolean {
    return isDeathPersistent(this.spellInfo);
  }

  isPermanent(): boolean {
    return this.maxDuration === -1;
  }

  isExpired(): boolean {
    return this.duration === 0;
  }

  /** `Aura::CanBeSaved` */
  canBeSaved(): boolean {
    const info = this.spellInfo;
    if (hasCustomAttribute(info, SPELL_ATTR0_CU_FORCE_AURA_SAVING)) return true;
    if (hasCustomAttribute(info, SPELL_ATTR0_CU_AURA_CANNOT_BE_SAVED)) return false;
    if (this.isPassive() || (hasAttribute(info, 0, SPELL_ATTR0_DO_NOT_DISPLAY) && info.stances)) return false;
    if (isChanneled(info)) return false;
    if (this.casterGuid !== this.owner.guid && (isSingleTarget(info) || this.isSingleTarget)) return false;
    if (this.isUsingCharges && !this.procCharges) return false;
    return true;
  }

  /** `Aura::CanBeSentToClient` */
  canBeSentToClient(): boolean {
    return !this.isPassive() || this.spellInfo.effects.some((effect) => isAreaAuraEffect(effect.effect)) || this.hasEffectType(SPELL_AURA_ABILITY_IGNORE_AURASTATE);
  }

  /** `Aura::IsSingleTargetWith` */
  isSingleTargetWith(other: Aura): boolean {
    if (this.owner.world.spells.isRankOf(this.spellInfo, other.spellInfo)) return true;
    const spec = this.spellInfo.spellSpecific;
    if ((spec === SPELL_SPECIFIC_JUDGEMENT || spec === SPELL_SPECIFIC_MAGE_POLYMORPH) && other.spellInfo.spellSpecific === spec) return true;
    return this.hasEffectType(SPELL_AURA_CONTROL_VEHICLE) && other.hasEffectType(SPELL_AURA_CONTROL_VEHICLE);
  }

  /** `Aura::CalcMaxDuration` */
  calcMaxDuration(caster: SpellUnit | null = this.getCaster()): number {
    let maxDuration = caster ? calcSpellDuration(this.spellInfo, caster.comboPoints) : this.spellInfo.duration[0] === -1 ? -1 : Math.abs(this.spellInfo.duration[0]);
    if (this.isPassive() && !this.spellInfo.durationEntry) maxDuration = -1;
    return maxDuration;
  }

  /** `Aura::CalcMaxCharges` */
  calcMaxCharges(): number {
    return this.owner.world.spells.procEntryCharges(this.id) ?? this.spellInfo.procCharges;
  }

  setDuration(duration: number): void {
    this.duration = duration;
    this.setNeedClientUpdateForTargets();
  }

  /** `Aura::RefreshDuration` */
  refreshDuration(withMods = false): void {
    const caster = this.getCaster();
    if (!caster) return;
    if (withMods) {
      let duration = spellMaxDuration(this.spellInfo);
      if (caster.hasAuraType(SPELL_AURA_PERIODIC_HASTE) || hasAttribute(this.spellInfo, 5, SPELL_ATTR5_SPELL_HASTE_AFFECTS_PERIODIC)) duration = Math.trunc(duration * caster.castSpeed);
      this.maxDuration = duration;
      this.setDuration(duration);
    } else {
      this.setDuration(this.maxDuration);
    }
    if ((this.spellInfo.manaPerSecond || this.spellInfo.manaPerSecondPerLevel) && !hasAttribute(this.spellInfo, 2, SPELL_ATTR2_NO_TARGET_PER_SECOND_COST)) this.timeCla = 1000;
    for (const effect of this.effects) effect?.resetTicks();
  }

  /** `Aura::RefreshTimers` */
  refreshTimers(periodicReset = false): void {
    this.maxDuration = this.calcMaxDuration();
    this.refreshDuration();
    const caster = this.getCaster();
    if (!caster) return;
    for (const effect of this.effects) {
      if (!effect) continue;
      effect.calculatePeriodic(caster, periodicReset, false);
      effect.calculatePeriodicData();
    }
  }

  setCharges(charges: number): void {
    if (this.procCharges === charges) return;
    this.procCharges = charges;
    this.isUsingCharges = charges !== 0;
    this.setNeedClientUpdateForTargets();
  }

  /** `Aura::ModCharges` — true when the aura was removed. */
  modCharges(num: number, removeMode = AURA_REMOVE_BY_DEFAULT): boolean {
    if (!this.isUsingCharges) return false;
    let charges = this.procCharges + num;
    const maxCharges = this.calcMaxCharges();
    if (num > 0 && charges > maxCharges) charges = maxCharges;
    else if (charges <= 0) {
      this.remove(removeMode);
      return true;
    }
    this.setCharges(charges);
    return false;
  }

  /** `Aura::SetStackAmount` */
  setStackAmount(stackAmount: number): void {
    this.stackAmount = stackAmount;
    const caster = this.getCaster();
    if (!caster) return;
    const applications = [...this.applications.values()].filter((app) => app.effectMask);
    for (const app of applications) if (!app.removeMode) this.handleAuraSpecificMods(app, caster, false, true);
    for (const effect of this.effects) effect?.changeAmount(effect.calculateAmount(caster), false, true);
    for (const app of applications) if (!app.removeMode) this.handleAuraSpecificMods(app, caster, true, true);
    this.setNeedClientUpdateForTargets();
  }

  /** `Aura::ModStackAmount` — true when the aura was removed. */
  modStackAmount(num: number, removeMode = AURA_REMOVE_BY_DEFAULT, periodicReset = false): boolean {
    let stackAmount = this.stackAmount + num;
    if (num > 0 && stackAmount > this.spellInfo.stackAmount) {
      stackAmount = this.spellInfo.stackAmount ? this.spellInfo.stackAmount : 1;
    } else if (stackAmount <= 0) {
      this.remove(removeMode);
      return true;
    }
    const refresh = stackAmount >= this.stackAmount && (this.spellInfo.stackAmount !== 0 || !hasAttribute(this.spellInfo, 1, SPELL_ATTR1_AURA_UNIQUE));
    if (refresh) {
      this.refreshTimers(periodicReset);
      this.setCharges(this.calcMaxCharges());
    }
    this.setStackAmount(stackAmount);
    this.setNeedClientUpdateForTargets();
    return false;
  }

  /** `Aura::CalcDispelChance` */
  calcDispelChance(auraTarget: SpellUnit | null, offensive: boolean): number {
    let resistChance = 0;
    if (offensive && auraTarget) resistChance += auraTarget.getTotalAuraModifier(SPELL_AURA_MOD_DISPEL_RESIST);
    resistChance = Math.min(100, Math.max(0, resistChance));
    return 100 - resistChance;
  }

  /** `Aura::SetLoadedState` */
  setLoadedState(maxDuration: number, duration: number, charges: number, stackAmount: number, recalculateMask: number, amounts: readonly number[]): void {
    this.maxDuration = maxDuration;
    this.duration = duration;
    this.procCharges = charges;
    this.isUsingCharges = charges !== 0;
    this.stackAmount = stackAmount;
    const caster = this.getCaster();
    for (let i = 0; i < 3; i++) {
      const effect = this.effects[i];
      if (!effect) continue;
      effect.amount = amounts[i] ?? 0;
      effect.canBeRecalculated = (recalculateMask & (1 << i)) !== 0;
      effect.calculatePeriodic(caster, false, true);
      if (caster) effect.recalculateAmount(caster);
    }
  }

  recalculateAmountOfEffects(): void {
    const caster = this.getCaster();
    for (const effect of this.effects) effect?.recalculateAmount(caster);
  }

  /** `Aura::HandleAllEffects` */
  handleAllEffects(app: AuraApplication, mode: number, apply: boolean): void {
    for (const effect of this.effects) if (effect && !this.isRemoved) effect.handleEffect(app, mode, apply);
  }

  applicationList(): AuraApplication[] {
    return [...this.applications.values()].filter((app) => app.effectMask);
  }

  setNeedClientUpdateForTargets(): void {
    for (const app of this.applications.values()) app.needClientUpdate = true;
  }

  getApplicationOfTarget(guid: bigint): AuraApplication | null {
    return this.applications.get(guid) ?? null;
  }

  /** `Aura::_ApplyForTarget` */
  applyForTarget(target: SpellUnit, caster: SpellUnit | null, app: AuraApplication): void {
    this.applications.set(target.guid, app);
    if (isCooldownStartedOnEvent(this.spellInfo) && !this.castItemGuid && caster) caster.startCooldownOnEvent(this.spellInfo, true);
  }

  /** `Aura::_UnapplyForTarget` */
  unapplyForTarget(target: SpellUnit, caster: SpellUnit | null, _app: AuraApplication): void {
    this.applications.delete(target.guid);
    if (isCooldownStartedOnEvent(this.spellInfo) && !this.castItemGuid && caster) caster.startCooldownOnEvent(this.spellInfo, false);
  }

  /** `Aura::_Remove` */
  removeFromApplications(removeMode: number): void {
    this.isRemoved = true;
    for (const app of [...this.applications.values()]) app.target.unapplyAura(app, removeMode);
  }

  /** `UnitAura::Remove` */
  remove(removeMode = AURA_REMOVE_BY_DEFAULT): void {
    if (this.isRemoved) return;
    this.owner.removeOwnedAura(this, removeMode);
  }

  /** `UnitAura::FillTargetMap` */
  fillTargetMap(caster: SpellUnit | null): Map<SpellUnit, number> {
    const targets = new Map<SpellUnit, number>();
    const owner = this.owner;
    for (let effIndex = 0; effIndex < 3; effIndex++) {
      if (!this.hasEffect(effIndex)) continue;
      const effect = this.spellInfo.effects[effIndex]!;
      const list: SpellUnit[] = [];
      if (effect.effect === SPELL_EFFECT_APPLY_AURA) {
        list.push(owner);
      } else {
        const radius = calcRadius(effect, caster ? caster.level : null);
        if (!owner.hasAuraState(AURA_STATE_BANISHED, this.spellInfo, caster)) {
          switch (effect.effect) {
            case SPELL_EFFECT_APPLY_AREA_AURA_PARTY:
            case SPELL_EFFECT_APPLY_AREA_AURA_RAID:
              list.push(owner);
              for (const unit of owner.world.unitsInRange(owner, radius)) {
                if (unit !== owner && unit.isAlive() && owner.isInPartyWith(unit, effect.effect === SPELL_EFFECT_APPLY_AREA_AURA_RAID)) list.push(unit);
              }
              break;
            case SPELL_EFFECT_APPLY_AREA_AURA_FRIEND:
              list.push(owner);
              for (const unit of owner.world.unitsInRange(owner, radius)) {
                if (unit !== owner && unit.isAlive() && owner.isFriendlyTo(unit)) list.push(unit);
              }
              break;
            case SPELL_EFFECT_APPLY_AREA_AURA_ENEMY:
              for (const unit of owner.world.unitsInRange(owner, radius)) {
                if (unit !== owner && unit.isAlive() && owner.isValidAttackTarget(unit, null)) list.push(unit);
              }
              break;
            case SPELL_EFFECT_APPLY_AREA_AURA_PET:
            case SPELL_EFFECT_APPLY_AREA_AURA_OWNER: {
              if (effect.effect === SPELL_EFFECT_APPLY_AREA_AURA_PET) list.push(owner);
              const ownerUnit = owner.charmerOrOwner();
              if (ownerUnit && owner.isWithinDist(ownerUnit, radius)) list.push(ownerUnit);
              break;
            }
            default:
              break;
          }
        }
      }
      for (const unit of list) targets.set(unit, (targets.get(unit) ?? 0) | (1 << effIndex));
    }
    return targets;
  }

  /** `Aura::UpdateTargetMap` (paladin aura dominance is part of the class layer). */
  updateTargetMap(caster: SpellUnit | null, apply = true): void {
    if (this.isRemoved) return;
    this.updateTargetMapInterval = UPDATE_TARGET_MAP_INTERVAL;
    const targets = this.fillTargetMap(caster);
    const targetsToRemove: SpellUnit[] = [];
    for (const app of this.applications.values()) {
      const existing = targets.get(app.target);
      if (existing === undefined) {
        targetsToRemove.push(app.target);
        continue;
      }
      let mask = existing;
      if (this.isArea()) {
        for (let effIndex = 0; effIndex < 3; effIndex++) {
          if (mask & (1 << effIndex) && app.target.isImmunedToSpellEffect(this.spellInfo, effIndex, this.getCaster())) mask &= ~(1 << effIndex);
        }
      }
      if (app.effectMask !== mask) targetsToRemove.push(app.target);
      targets.delete(app.target);
    }
    for (const [unit, mask] of [...targets]) {
      if (this.getApplicationOfTarget(unit.guid)) {
        targets.delete(unit);
        continue;
      }
      let effMask = mask;
      for (let effIndex = 0; effIndex < 3; effIndex++) {
        if (effMask & (1 << effIndex) && unit.isImmunedToSpellEffect(this.spellInfo, effIndex, this.getCaster())) effMask &= ~(1 << effIndex);
      }
      let addUnit = effMask !== 0 && !unit.isImmunedToSpell(this.spellInfo, this.getCaster());
      if (addUnit && !unit.isHighestExclusiveAura(this, true)) addUnit = false;
      if (addUnit && unit !== this.owner) {
        for (const other of [...unit.appliedAuras]) {
          if (!this.canStackWith(other.base)) {
            addUnit = false;
            break;
          }
        }
      }
      if (!addUnit) {
        targets.delete(unit);
        continue;
      }
      targets.set(unit, effMask);
      unit.createAuraApplication(this, effMask);
    }
    for (const unit of targetsToRemove) {
      const app = this.getApplicationOfTarget(unit.guid);
      if (app) unit.unapplyAura(app, AURA_REMOVE_BY_DEFAULT);
    }
    if (!apply) return;
    for (const [unit, mask] of targets) {
      const app = this.getApplicationOfTarget(unit.guid);
      if (app) unit.applyAura(app, mask);
    }
  }

  /** `Aura::_RegisterForTargets` */
  registerForTargets(): void {
    this.updateTargetMap(this.getCaster(), false);
  }

  /** `Aura::ApplyForTargets` */
  applyForTargetsNow(): void {
    this.updateTargetMap(this.getCaster(), true);
  }

  /** `Aura::_ApplyEffectForTargets` */
  applyEffectForTargets(effIndex: number): void {
    for (const app of [...this.applications.values()]) {
      if (app.effectsToApply & (1 << effIndex) && !app.hasEffect(effIndex)) app.target.applyAuraEffect(this, effIndex);
    }
  }

  /** `Aura::UpdateOwner` */
  updateOwner(diff: number): void {
    const caster = this.getCaster();
    this.update(diff, caster);
    if (this.isRemoved) return;
    if (this.updateTargetMapInterval <= diff) this.updateTargetMap(caster);
    else this.updateTargetMapInterval -= diff;
    for (const effect of this.effects) if (effect && !this.isRemoved) effect.update(diff, caster);
  }

  /** `Aura::Update` — duration and mana-per-second upkeep. */
  update(diff: number, caster: SpellUnit | null): void {
    if (this.duration <= 0) return;
    this.duration -= diff;
    if (this.duration < 0) this.duration = 0;
    if (!this.timeCla) return;
    if (this.timeCla > diff) {
      this.timeCla -= diff;
      return;
    }
    if (!caster) return;
    const manaPerSecond = this.spellInfo.manaPerSecond + this.spellInfo.manaPerSecondPerLevel * caster.level;
    if (!manaPerSecond) return;
    this.timeCla += 1000 - diff;
    const powerType = this.spellInfo.powerType;
    if (powerType === 0xfffffffe) {
      if (caster.health > manaPerSecond) caster.modifyHealth(-manaPerSecond);
      else this.remove();
    } else if (caster.power(powerType) >= manaPerSecond) {
      caster.modifyPower(powerType, -manaPerSecond);
    } else {
      this.remove();
    }
  }

  /** `Aura::IsAuraStronger` */
  isAuraStronger(newAura: Aura): boolean {
    for (const thisEffect of this.effects) {
      if (!thisEffect) continue;
      for (const newEffect of newAura.effects) {
        if (!newEffect || thisEffect.auraType !== newEffect.auraType || thisEffect.miscValue !== newEffect.miscValue) continue;
        const curValue = Math.abs(thisEffect.amount);
        if (curValue < Math.abs(newEffect.amount)) return true;
        if (curValue === Math.abs(newEffect.amount) && !this.isPassive() && !this.isPermanent() && this.duration < newAura.duration) return true;
      }
    }
    return false;
  }

  /** `Aura::CanStackWith` */
  canStackWith(existing: Aura): boolean {
    if (this === existing) return true;
    const existingInfo = existing.spellInfo;
    const info = this.spellInfo;
    const spells = this.owner.world.spells;
    const sameCaster = this.casterGuid === existing.casterGuid;
    if (this.isPassive() && sameCaster && (spells.isDifferentRankOf(info, existingInfo) || (info.id === existingInfo.id && !this.castItemGuid))) {
      if (!(this.castItemGuid && existing.castItemGuid && this.castItemGuid !== existing.castItemGuid)) return false;
    }
    for (let i = 0; i < 3; i++) {
      if (existingInfo.effects[i]!.triggerSpell === this.id || info.effects[i]!.triggerSpell === existing.id) return true;
    }
    if (isAuraExclusiveBySpecificWith(info, existingInfo) || (sameCaster && isAuraExclusiveBySpecificPerCasterWith(info, existingInfo))) return false;
    switch (spells.worldData.checkSpellGroupStackRules(info.id, existingInfo.id)) {
      case SPELL_GROUP_STACK_RULE_EXCLUSIVE:
      case SPELL_GROUP_STACK_RULE_EXCLUSIVE_HIGHEST:
        return false;
      case SPELL_GROUP_STACK_RULE_EXCLUSIVE_FROM_SAME_CASTER:
        if (sameCaster) return false;
        break;
      default:
        break;
    }
    if (info.spellFamilyName !== existingInfo.spellFamilyName) return true;
    if (!sameCaster) {
      if (isChanneled(existingInfo)) return true;
      if (hasAttribute(info, 3, SPELL_ATTR3_DOT_STACKING_RULE)) return true;
      for (let i = 0; i < 3; i++) {
        switch (info.effects[i]!.applyAuraName) {
          case SPELL_AURA_PERIODIC_DAMAGE:
          case SPELL_AURA_PERIODIC_DUMMY:
          case SPELL_AURA_PERIODIC_HEAL:
          case SPELL_AURA_PERIODIC_TRIGGER_SPELL:
          case SPELL_AURA_PERIODIC_ENERGIZE:
          case SPELL_AURA_PERIODIC_MANA_LEECH:
          case SPELL_AURA_PERIODIC_LEECH:
          case SPELL_AURA_POWER_BURN:
          case SPELL_AURA_OBS_MOD_POWER:
          case SPELL_AURA_OBS_MOD_HEALTH:
          case SPELL_AURA_PERIODIC_TRIGGER_SPELL_WITH_VALUE:
            if (effectIsTargetingArea(info.effects[i]!) || effectIsTargetingArea(existingInfo.effects[i]!)) break;
            return true;
          default:
            break;
        }
      }
    }
    const vehicle1 = info.effects.findIndex((effect) => effect.applyAuraName === SPELL_AURA_CONTROL_VEHICLE);
    const vehicle2 = existingInfo.effects.findIndex((effect) => effect.applyAuraName === SPELL_AURA_CONTROL_VEHICLE);
    if (vehicle1 >= 0 && vehicle2 >= 0) return true;
    if (spells.isRankOf(info, existingInfo) && !(info.spellFamilyName === SPELLFAMILY_HUNTER && info.spellFamilyFlags[1] & 0x80000000)) {
      if (!sameCaster && info.spellSpecific === SPELL_SPECIFIC_AURA) return true;
      if (isMultiSlotAura(info) && !this.isArea()) return true;
      if ((this.isPassive() || hasCustomAttribute(info, SPELL_ATTR0_CU_ENCHANT_PROC)) && this.castItemGuid && existing.castItemGuid && this.castItemGuid !== existing.castItemGuid) return true;
      return false;
    }
    return true;
  }

  /** The `spell_linked_spell` part of `Aura::HandleAuraSpecificMods` (the per-spell family switch is the class layer). */
  handleAuraSpecificMods(app: AuraApplication, caster: SpellUnit | null, apply: boolean, onReapply: boolean): void {
    const target = app.target;
    const world = this.owner.world.spells.worldData;
    const SPELL_LINK_AURA = 2;
    const linked = (trigger: number, type: number): number[] => world.linkedSpells(trigger, type).map((row) => row.spell_effect);
    if (!onReapply) {
      if (apply) {
        for (const id of linked(this.id, SPELL_LINK_AURA)) {
          if (id < 0) target.applySpellImmune(this.id, 6 /* IMMUNITY_ID */, -id, true);
          else if (caster) caster.addAura(id, target);
        }
      } else {
        for (const id of linked(-this.id, 0)) {
          if (id < 0) target.removeAurasDueToSpell(-id);
          else if (app.removeMode !== 5 /* AURA_REMOVE_BY_DEATH */) target.castSpell(target, id, { triggered: true, originalCaster: this.casterGuid });
        }
        for (const id of linked(this.id, SPELL_LINK_AURA)) {
          if (id < 0) target.applySpellImmune(this.id, 6, -id, false);
          else target.removeAurasDueToSpell(id, this.casterGuid, 0, app.removeMode);
        }
      }
    } else if (apply) {
      for (const id of linked(this.id, SPELL_LINK_AURA)) {
        if (id > 0) target.getAura(id, this.casterGuid)?.modStackAmount(this.stackAmount - (target.getAura(id, this.casterGuid)?.stackAmount ?? 0));
      }
    }
  }

  /** `AuraEffect::IsAffectedOnSpell` family mask check shared by effects. */
  static isAffected(info: SpellInfo, familyName: number, familyFlags: readonly number[]): boolean {
    if (!familyName) return true;
    if (familyName !== info.spellFamilyName) return false;
    if ((familyFlags[0]! | familyFlags[1]! | familyFlags[2]!) && !((familyFlags[0]! & info.spellFamilyFlags[0]) | (familyFlags[1]! & info.spellFamilyFlags[1]) | (familyFlags[2]! & info.spellFamilyFlags[2]))) return false;
    return true;
  }

  /** Removal by dispel: charges or stacks (`RemoveAurasDueToSpellByDispel`). */
  dispelStacks(charges: number): void {
    if (hasAttribute(this.spellInfo, 7, SPELL_ATTR7_DISPEL_REMOVES_CHARGES)) this.modCharges(-charges, AURA_REMOVE_BY_ENEMY_SPELL);
    else this.modStackAmount(-charges, AURA_REMOVE_BY_ENEMY_SPELL);
  }
}

/** `AuraEffect` */
export class AuraEffect {
  baseAmount: number;
  amount = 0;
  critChance = 0;
  pctMods = 1;
  oldAmount = 0;
  periodicTimer = 0;
  amplitude = 0;
  tickNumber = 0;
  canBeRecalculated = true;
  isPeriodic = false;
  casterLevel: number;
  /** `ChannelTargetData` captured when a channel applied the aura. */
  channelData: { channelGuid: bigint; dest: { map: number; x: number; y: number; z: number } | null } | null = null;

  constructor(readonly base: Aura, readonly effIndex: number, baseAmount: number | undefined, caster: SpellUnit | null) {
    this.baseAmount = baseAmount ?? base.spellInfo.effects[effIndex]!.basePoints;
    this.calculatePeriodic(caster, true, false);
    this.calculatePeriodicData();
    this.amount = this.calculateAmount(caster);
    this.casterLevel = caster ? caster.level : 0;
    const channel = caster?.currentSpells[2 /* CURRENT_CHANNELED_SPELL */];
    if (channel) this.channelData = { channelGuid: caster!.channelObject, dest: channel.targets.dest ? { map: caster!.position().map, ...channel.targets.dest } : null };
  }

  get spellInfo(): SpellInfo {
    return this.base.spellInfo;
  }

  get id(): number {
    return this.base.id;
  }

  get auraType(): number {
    return this.spellInfo.effects[this.effIndex]!.applyAuraName;
  }

  get miscValue(): number {
    return this.spellInfo.effects[this.effIndex]!.miscValue;
  }

  get miscValueB(): number {
    return this.spellInfo.effects[this.effIndex]!.miscValueB;
  }

  get casterGuid(): bigint {
    return this.base.casterGuid;
  }

  getCaster(): SpellUnit | null {
    return this.base.getCaster();
  }

  /** `AuraEffect::IsAffectedOnSpell` */
  isAffectedOnSpell(spell: SpellInfo | null): boolean {
    if (!spell) return false;
    return Aura.isAffected(spell, this.spellInfo.spellFamilyName, this.spellInfo.effects[this.effIndex]!.spellClassMask);
  }

  hasSpellClassMask(): boolean {
    const mask = this.spellInfo.effects[this.effIndex]!.spellClassMask;
    return (mask[0] | mask[1] | mask[2]) !== 0;
  }

  /** `AuraEffect::CalculateAmount` (item random suffix amounts are part of the item layer). */
  calculateAmount(caster: SpellUnit | null): number {
    const info = this.spellInfo;
    const effect = info.effects[this.effIndex]!;
    let amount = caster ? caster.calculateSpellDamage(info, this.effIndex, this.baseAmount) : calcEffectValue(info, effect, null, 0, undefined, this.baseAmount);
    switch (this.auraType) {
      case SPELL_AURA_MOD_CONFUSE:
      case SPELL_AURA_MOD_FEAR:
      case SPELL_AURA_MOD_STUN:
      case SPELL_AURA_MOD_ROOT:
      case SPELL_AURA_TRANSFORM: {
        this.canBeRecalculated = false;
        if (!info.procFlags || hasAura(info, SPELL_AURA_PROC_TRIGGER_SPELL)) break;
        if (!caster) break;
        const stats = this.base.owner.world.spells.creatureBaseStats(caster.level, 1 /* CLASS_WARRIOR */);
        if (stats) amount = Math.trunc(stats.baseHealth[EXPANSION_WRATH_OF_THE_LICH_KING] / 4.75);
        break;
      }
      case SPELL_AURA_SCHOOL_ABSORB:
      case SPELL_AURA_MANA_SHIELD:
        this.canBeRecalculated = false;
        break;
      default:
        break;
    }
    this.oldAmount = amount * this.base.stackAmount;
    if (caster) {
      switch (this.auraType) {
        case SPELL_AURA_PERIODIC_DAMAGE:
        case SPELL_AURA_PERIODIC_LEECH:
          amount = caster.spellDamageBonusDone(this.base.owner, info, amount, 2 /* DOT */, this.effIndex, this.pctMods, 1);
          break;
        case SPELL_AURA_PERIODIC_HEAL:
          amount = caster.spellHealingBonusDone(this.base.owner, info, amount, 2, this.effIndex, this.pctMods, 1);
          break;
        case SPELL_AURA_DAMAGE_SHIELD:
          amount = caster.spellDamageBonusDone(this.base.owner, info, amount, 1 /* SPELL_DIRECT_DAMAGE */, 0, 0, 1);
          break;
        default:
          break;
      }
    }
    return amount * this.base.stackAmount;
  }

  /** `AuraEffect::CalculatePeriodicData` */
  calculatePeriodicData(): void {
    const caster = this.getCaster();
    if (caster) {
      if (hasAura(this.spellInfo, SPELL_AURA_PERIODIC_HEAL)) this.pctMods = caster.spellPctHealingModsDone(this.base.owner, this.spellInfo, 2, false);
      else if (hasAura(this.spellInfo, SPELL_AURA_PERIODIC_DAMAGE) || hasAura(this.spellInfo, SPELL_AURA_PERIODIC_LEECH)) this.pctMods = caster.spellPctDamageModsDone(this.base.owner, this.spellInfo, 2);
      this.critChance = caster.calcPeriodicCritChance(this, this.base.owner);
    }
  }

  /** `AuraEffect::CalculatePeriodic` */
  calculatePeriodic(caster: SpellUnit | null, create: boolean, load: boolean): void {
    this.amplitude = this.spellInfo.effects[this.effIndex]!.amplitude;
    if (this.auraType === SPELL_AURA_OBS_MOD_POWER && !this.amplitude) this.amplitude = 1000;
    switch (this.auraType) {
      case SPELL_AURA_OBS_MOD_POWER:
      case SPELL_AURA_PERIODIC_DAMAGE:
      case SPELL_AURA_PERIODIC_HEAL:
      case SPELL_AURA_OBS_MOD_HEALTH:
      case SPELL_AURA_PERIODIC_TRIGGER_SPELL:
      case SPELL_AURA_PERIODIC_TRIGGER_SPELL_FROM_CLIENT:
      case SPELL_AURA_PERIODIC_ENERGIZE:
      case SPELL_AURA_PERIODIC_LEECH:
      case SPELL_AURA_PERIODIC_HEALTH_FUNNEL:
      case SPELL_AURA_PERIODIC_MANA_LEECH:
      case SPELL_AURA_PERIODIC_DAMAGE_PERCENT:
      case SPELL_AURA_POWER_BURN:
      case SPELL_AURA_PERIODIC_DUMMY:
      case SPELL_AURA_PERIODIC_TRIGGER_SPELL_WITH_VALUE:
        this.isPeriodic = true;
        break;
      default:
        break;
    }
    if (!this.isPeriodic) return;
    if (this.amplitude <= 0) this.amplitude = 1000;
    if (caster && (caster.hasAuraType(SPELL_AURA_PERIODIC_HASTE) || hasAttribute(this.spellInfo, 5, SPELL_ATTR5_SPELL_HASTE_AFFECTS_PERIODIC))) {
      this.amplitude = Math.trunc(this.amplitude * caster.castSpeed);
    }
    if (load) {
      this.tickNumber = this.amplitude ? Math.trunc(this.base.duration / this.amplitude) : 0;
      this.periodicTimer = this.amplitude ? this.base.duration % this.amplitude : 0;
      if (hasAttribute(this.spellInfo, 5, SPELL_ATTR5_EXTRA_INITIAL_PERIOD)) this.tickNumber++;
      return;
    }
    this.tickNumber = 0;
    const resetPeriodicTimer = create || (this.auraType !== SPELL_AURA_PERIODIC_DAMAGE && this.auraType !== SPELL_AURA_PERIODIC_DAMAGE_PERCENT);
    if (resetPeriodicTimer) {
      this.periodicTimer = 0;
      if (this.amplitude) {
        if (!hasAttribute(this.spellInfo, 5, SPELL_ATTR5_EXTRA_INITIAL_PERIOD)) this.periodicTimer += this.amplitude;
        else if (caster?.isTotem) {
          this.periodicTimer = 100;
          if (!this.base.isPassive()) this.base.setDuration(this.base.duration + 100);
        }
      }
    }
  }

  resetTicks(): void {
    this.tickNumber = 0;
  }

  /** `AuraEffect::GetTotalTicks` */
  totalTicks(): number {
    let totalTicks = 1;
    if (this.amplitude) {
      totalTicks = Math.trunc(this.base.maxDuration / this.amplitude);
      if (hasAttribute(this.spellInfo, 5, SPELL_ATTR5_EXTRA_INITIAL_PERIOD)) totalTicks++;
    }
    return totalTicks;
  }

  /** `AuraEffect::RecalculateAmount` */
  recalculateAmount(caster: SpellUnit | null = this.getCaster()): void {
    if (!this.canBeRecalculated) return;
    this.changeAmount(this.calculateAmount(caster), false);
  }

  /** `AuraEffect::SetAmount` with the change handler (`ChangeAmount(amount, mark=true)`). */
  setAmount(amount: number): void {
    this.amount = amount;
    this.canBeRecalculated = false;
  }

  /** `AuraEffect::ChangeAmount` */
  changeAmount(newAmount: number, mark = true, onStackOrReapply = false): void {
    let handleMask = 0;
    if (newAmount !== this.amount) handleMask |= AURA_EFFECT_HANDLE_CHANGE_AMOUNT;
    if (onStackOrReapply) handleMask |= AURA_EFFECT_HANDLE_REAPPLY;
    if (!handleMask) return;
    const apps = this.base.applicationList().filter((app) => app.hasEffect(this.effIndex));
    for (const app of apps) {
      app.target.registerAuraEffect(this, false);
      this.handleEffect(app, handleMask, false);
    }
    if (handleMask & AURA_EFFECT_HANDLE_CHANGE_AMOUNT) {
      if (!mark) this.amount = newAmount;
      else this.setAmount(newAmount);
    }
    for (const app of apps) {
      if (app.removeMode !== AURA_REMOVE_NONE) continue;
      app.target.registerAuraEffect(this, true);
      this.handleEffect(app, handleMask, true);
    }
  }

  /** `AuraEffect::HandleEffect` */
  handleEffect(app: AuraApplication, mode: number, apply: boolean): void {
    if (mode & AURA_EFFECT_HANDLE_REAL) app.target.registerAuraEffect(this, apply);
    if (!app.isActive(this.effIndex)) return;
    if (apply && app.removeMode) return;
    const handler = AURA_EFFECT_HANDLERS[this.auraType];
    handler?.(this, app, mode, apply);
  }

  /** `AuraEffect::Update` */
  update(diff: number, caster: SpellUnit | null): void {
    if (!this.isPeriodic || !(this.base.duration >= 0 || this.base.isPassive() || this.base.isPermanent())) return;
    const totalTicks = this.totalTicks();
    this.periodicTimer -= diff;
    while (this.periodicTimer <= 0) {
      if (!this.base.isPermanent() && this.tickNumber + 1 > totalTicks) break;
      this.tickNumber++;
      this.periodicTimer += this.amplitude;
      updatePeriodic(this, caster);
      for (const app of this.base.applicationList()) {
        if (app.hasEffect(this.effIndex)) periodicTick(this, app, caster);
      }
      if (this.base.isRemoved) break;
    }
  }

  /** `SpellInfo::Effects[i].CalcValueMultiplier` without spell mods. */
  valueMultiplier(): number {
    return this.spellInfo.effects[this.effIndex]!.valueMultiplier;
  }

  /** Whether the effect scales with `SPELL_ATTR5_SPELL_HASTE_AFFECTS_PERIODIC` — kept for handlers that read it. */
  get stackAmount(): number {
    return this.base.stackAmount;
  }

}
