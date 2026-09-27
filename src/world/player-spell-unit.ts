import {
  CR_CRIT_TAKEN_MELEE,
  EQUIPMENT_SLOT_OFFHAND,
  PLAYER_BLOCK_PERCENTAGE,
  PLAYER_CRIT_PERCENTAGE,
  PLAYER_DODGE_PERCENTAGE,
  PLAYER_EXPERTISE,
  PLAYER_FIELD_MOD_TARGET_PHYSICAL_RESISTANCE,
  PLAYER_FIELD_MOD_TARGET_RESISTANCE,
  PLAYER_OFFHAND_CRIT_PERCENTAGE,
  PLAYER_OFFHAND_EXPERTISE,
  PLAYER_PARRY_PERCENTAGE,
  PLAYER_RANGED_CRIT_PERCENTAGE,
  PLAYER_SHIELD_BLOCK,
  PLAYER_SPELL_CRIT_PERCENTAGE1,
  UNIT_MOD_CAST_SPEED,
  type PlayerStats,
} from "../characters/player-stats.ts";
import { CreatureSpellUnit, type ReactionSource } from "../combat/creature-spell-unit.ts";
import { templateReaction, type FactionStore, type ReactionPlayer } from "../combat/faction.ts";
import { rageReward } from "../combat/formulas.ts";
import type { AuraEffect } from "../spells/aura.ts";
import { statBuffMods } from "../spells/aura-effects.ts";
import * as D from "../spells/defines.ts";
import * as E from "../spells/enums.ts";
import { comboPointsPacket, SMSG_UPDATE_COMBO_POINTS } from "../spells/packets.ts";
import type { SpellInfo } from "../spells/spell-info.ts";
import { SpellUnit, type SpellMap, type UnitPosition, type UnitStatHost } from "../spells/unit.ts";
import * as math from "../spells/unit-math.ts";

/** `MOVEMENTFLAG_MASK_MOVING` */
const MOVEMENTFLAG_MASK_MOVING = 0x04c030cf;
/** `MOVEMENTFLAG_FORWARD | STRAFE_LEFT | STRAFE_RIGHT | FALLING` (`GetLeewayBonusRangeForTargets`). */
const LEEWAY_MOVE_FLAGS = 0x00000001 | 0x00000004 | 0x00000008 | 0x00001000;
const MOVEMENTFLAG_WALKING = 0x00000100;
const MOVEMENTFLAG_FALLING = 0x00001000;
/** `LEEWAY_MIN_MOVE_SPEED` */
const LEEWAY_MIN_MOVE_SPEED = 4.97;
const OBJECT_END = 0x0006;
const UNIT_FIELD_CHANNEL_OBJECT = OBJECT_END + 0x000e;
const UNIT_CHANNEL_SPELL = OBJECT_END + 0x0010;
const UNIT_FIELD_FLAGS = OBJECT_END + 0x0035;
const UNIT_FIELD_AURASTATE = OBJECT_END + 0x0037;

/** What the session gives its player's spell unit (`Player` state that lives on `WorldSession`). */
export type PlayerHost = {
  map(): SpellMap;
  position(): UnitPosition;
  level(): number;
  race(): number;
  classId(): number;
  powerType(): number;
  reactionPlayer(): ReactionPlayer;
  /** Alive (not a corpse or ghost). */
  alive(): boolean;
  inCombat(): boolean;
  /** `Unit::SetInCombatWith` / `EngageWithTarget` against a creature. */
  engage(enemy: SpellUnit): void;
  standState(): number;
  setStandState(state: number): void;
  moveFlags(): number;
  gameMaster(): boolean;
  selection(): bigint;
  victim(): SpellUnit | null;
  attackStop(): void;
  /** `SendDirectMessage` */
  send(opcode: number, body: Uint8Array): void;
  /** To the players that see this player (not the player). */
  broadcast(opcode: number, body: Uint8Array): void;
  /** Whether this player's client knows `guid` (so `other`'s set messages reach it). */
  knows(guid: bigint): boolean;
  /** Lowers health; returns true when the player died (`Unit::Kill` → `setDeathState(JustDied)`). */
  takeDamage(amount: number, attacker: bigint): boolean;
  /** `Unit::SetHealth` without death handling (heals, `ModifyHealth`). */
  setHealth(value: number): void;
  addRage(points: number): void;
  rageRate(): number;
  learnSpell(spellId: number): void;
  knowsSpell(spellId: number): boolean;
  teleport(map: number, x: number, y: number, z: number, orientation: number): void;
  homebind(): UnitPosition | null;
  hasItem(guid: bigint): boolean;
  hasItemCount(entry: number, count: number): boolean;
  destroyItemCount(entry: number, count: number): void;
  /** A `SMSG_FORCE_*_SPEED_CHANGE` for the new aura-modified speed. */
  speedChanged(moveType: number, speed: number): void;
  /** `SMSG_FORCE_MOVE_ROOT` / `SMSG_FORCE_MOVE_UNROOT` */
  rootChanged(rooted: boolean): void;
  /** Cooldown rows changed (`character_spell_cooldown` is rewritten at save). */
  cooldownsChanged(): void;
  /** Values updates for the listed player fields go out with the next field flush. */
  fieldChanged(): void;
  partyWith(other: SpellUnit, raid: boolean): boolean;
  factions(): FactionStore | null;
};

/** `UnitStatHost` over `PlayerStats` (`Unit::HandleStatFlatModifier` → `UpdateUnitMod` on a player). */
export class PlayerStatHost implements UnitStatHost {
  constructor(readonly stats: PlayerStats) {}

  get castSpeed(): number {
    return this.stats.getFloat(UNIT_MOD_CAST_SPEED);
  }

  handleStatFlatModifier(unitMod: number, modifierType: number, amount: number, apply: boolean): void {
    this.stats.handleStatFlatModifier(unitMod, modifierType, amount, apply);
    this.stats.updateUnitMod(unitMod);
  }

  applyStatPctModifier(unitMod: number, modifierType: number, pct: number): void {
    this.stats.applyStatPctModifier(unitMod, modifierType, pct);
    this.stats.updateUnitMod(unitMod);
  }

  setStatPctModifier(unitMod: number, modifierType: number, value: number): void {
    this.stats.setStatPctModifier(unitMod, modifierType, value);
    this.stats.updateUnitMod(unitMod);
  }

  setStatFlatModifier(unitMod: number, modifierType: number, value: number): void {
    this.stats.setStatFlatModifier(unitMod, modifierType, value);
    this.stats.updateUnitMod(unitMod);
  }

  getPctModifierValue(unitMod: number, modifierType: number): number {
    return this.stats.getPctModifierValue(unitMod, modifierType);
  }

  getFlatModifierValue(unitMod: number, modifierType: number): number {
    return this.stats.getFlatModifierValue(unitMod, modifierType);
  }

  updateStatBuffMod(stat: number, positive: number, negative: number): void {
    this.stats.setStatBuffMods(stat, positive, negative);
  }

  updateResistanceBuffModsMod(school: number, positive: number, negative: number): void {
    this.stats.setResistanceBuffMods(school, positive, negative);
  }

  updateSpellDamageAndHealingBonus(): void {
    this.stats.updateSpellDamageAndHealingBonus();
  }

  applyModDamageDoneField(baseField: number, school: number, amount: number, apply: boolean): void {
    this.stats.applyModInt32(baseField + school, amount, apply);
  }

  setModDamageDonePctField(school: number, value: number): void {
    this.stats.setFloat(0x0006 + 0x0094 + 0x040d + school, value);
  }

  getStat(stat: number): number {
    return this.stats.getStat(stat);
  }

  getArmor(): number {
    return this.stats.getArmor();
  }

  getResistance(school: number): number {
    return this.stats.getResistance(school);
  }

  getTotalAttackPowerValue(attType: number): number {
    return this.stats.getTotalAttackPowerValue(attType);
  }

  applyTargetResistanceField(physical: boolean, amount: number, apply: boolean): void {
    this.stats.applyModInt32(physical ? PLAYER_FIELD_MOD_TARGET_PHYSICAL_RESISTANCE : PLAYER_FIELD_MOD_TARGET_RESISTANCE, amount, apply);
  }

  baseSpellDamageBonus(): number {
    return this.stats.itemSpellDamage();
  }

  baseSpellHealingBonus(): number {
    return this.stats.itemSpellHealing();
  }

  spellPenetrationItemMod(): number {
    return this.stats.itemSpellPenetration();
  }

  spellCritChance(school: number): number | null {
    return this.stats.getFloat(PLAYER_SPELL_CRIT_PERCENTAGE1 + school);
  }

  weaponCritChance(attType: number): number | null {
    return this.stats.getFloat(attType === 1 ? PLAYER_OFFHAND_CRIT_PERCENTAGE : attType === 2 ? PLAYER_RANGED_CRIT_PERCENTAGE : PLAYER_CRIT_PERCENTAGE);
  }

  get modSpellHitChance(): number {
    return this.stats.modSpellHitChance;
  }

  get modMeleeHitChance(): number {
    return this.stats.modMeleeHitChance;
  }

  get modRangedHitChance(): number {
    return this.stats.modRangedHitChance;
  }

  ratingBonus(rating: number): number {
    return this.stats.getRatingBonusValue(rating);
  }

  maxSkillValueForLevel(): number {
    return this.stats.getMaxSkillValueForLevel();
  }

  weaponSkillValue(attType: number): number {
    return this.stats.getWeaponSkillValue(attType);
  }

  defenseSkillValue(): number {
    return this.stats.getDefenseSkillValue();
  }

  /** `Unit::GetUnitDodgeChance` for a player. */
  dodgeChance(): number {
    return this.stats.getFloat(PLAYER_DODGE_PERCENTAGE);
  }

  /** `Unit::GetUnitParryChance` for a player: needs `CanParry` and a usable weapon. */
  parryChance(): number {
    if (!this.stats.canParry) return 0;
    if (!this.stats.weaponForAttack(0) && !this.stats.weaponForAttack(1)) return 0;
    return this.stats.getFloat(PLAYER_PARRY_PERCENTAGE);
  }

  /** `Unit::GetUnitBlockChance` for a player: needs `CanBlock` and a shield. */
  blockChance(): number {
    if (!this.stats.canBlock) return 0;
    const shield = this.stats.equippedItem(EQUIPMENT_SLOT_OFFHAND);
    if (!shield || shield.broken || !shield.template.block) return 0;
    return this.stats.getFloat(PLAYER_BLOCK_PERCENTAGE);
  }

  missFromDefense(): number {
    return this.stats.getMissPercentageFromDefence();
  }

  expertiseDodgeOrParryReduction(attType: number): number {
    return this.stats.getUInt32(attType === 1 ? PLAYER_OFFHAND_EXPERTISE : PLAYER_EXPERTISE) / 4;
  }

  shieldBlockValue(): number {
    return this.stats.getUInt32(PLAYER_SHIELD_BLOCK);
  }

  /** `Unit::CalculateDamage` → `Player::CalculateMinMaxDamage` summed over the weapon's damage entries. */
  weaponDamage(attType: number, normalized: boolean, addTotalPct: boolean): number {
    let min = 0;
    let max = 0;
    for (let index = 0; index < 2; index++) {
      const range = this.stats.calculateMinMaxDamage(attType, index, normalized, addTotalPct);
      min += range.min;
      max += range.max;
    }
    const low = Math.trunc(min);
    const high = Math.trunc(max);
    return high <= low ? low : low + Math.floor(Math.random() * (high - low + 1));
  }

  attackTime(attType: number): number {
    return this.stats.getAttackTime(attType);
  }

  hasOffhandWeapon(): boolean {
    return this.stats.canDualWield && this.stats.weaponForAttack(1) !== null;
  }

  applyAttackTimePercentMod(attType: number, pct: number, apply: boolean): void {
    this.stats.applyAttackTimePercentMod(attType, pct, apply);
  }

  applyCastTimePercentMod(pct: number, apply: boolean): void {
    this.stats.applyCastTimePercentMod(pct, apply);
  }

  weaponForAttack(attType: number): { inventoryType: number; subClass: number } | null {
    const weapon = this.stats.weaponForAttack(attType);
    return weapon ? { inventoryType: weapon.template.InventoryType, subClass: weapon.template.subclass } : null;
  }

  canParry(): boolean {
    return this.stats.canParry;
  }

  canBlock(): boolean {
    return this.stats.canBlock;
  }

  canDualWield(): boolean {
    return this.stats.canDualWield;
  }

  setCanParry(on: boolean): void {
    this.stats.canParry = on;
    this.stats.updateAllStats();
  }

  setCanBlock(on: boolean): void {
    this.stats.canBlock = on;
    this.stats.updateAllStats();
  }

  setCanDualWield(on: boolean): void {
    this.stats.canDualWield = on;
  }

  updateManaRegen(): void {
    this.stats.updateManaRegen();
  }

  /** `CR_CRIT_TAKEN_MELEE` rating bonus (for combat code that still reads the melee snapshot). */
  critTakenMelee(): number {
    return this.stats.getRatingBonusValue(CR_CRIT_TAKEN_MELEE);
  }
}

/** A player in the world as the spell and aura code sees it (`Player` : `Unit`). */
export class PlayerSpellUnit extends SpellUnit implements ReactionSource {
  readonly isPlayer = true;
  readonly stats: PlayerStatHost;
  private comboTargetGuid = 0n;
  private combo = 0;

  constructor(
    readonly guid: bigint,
    private readonly host: PlayerHost,
    readonly playerStats: PlayerStats,
  ) {
    super();
    this.stats = new PlayerStatHost(playerStats);
    playerStats.auraHooks = {
      statBuffMods: (stat) => statBuffMods(this, stat),
      spellDamageBonus: (school) => math.spellBaseDamageBonusDone(this, 1 << school),
      spellHealingBonus: () => math.spellBaseHealingBonusDone(this, 0x7f),
    };
  }

  get world(): SpellMap {
    return this.host.map();
  }

  reactionPlayer(): ReactionPlayer {
    return this.host.reactionPlayer();
  }

  get entry(): number {
    return 0;
  }

  get level(): number {
    return this.host.level();
  }

  get classId(): number {
    return this.host.classId();
  }

  get inWorld(): boolean {
    return true;
  }

  position(): UnitPosition {
    return this.host.position();
  }

  get combatReach(): number {
    return 1.5;
  }

  get boundingRadius(): number {
    return 0.389;
  }

  isAlive(): boolean {
    return this.host.alive();
  }

  get health(): number {
    return this.playerStats.health;
  }

  get maxHealth(): number {
    return this.playerStats.maxHealth;
  }

  setHealth(value: number): void {
    this.host.setHealth(value);
  }

  get createHealth(): number {
    return this.playerStats.getCreateHealth();
  }

  get createMana(): number {
    return this.playerStats.getCreateMana();
  }

  get powerType(): number {
    return this.host.powerType();
  }

  power(power: number): number {
    return this.playerStats.power(power);
  }

  maxPower(power: number): number {
    return this.playerStats.maxPower(power);
  }

  setPower(power: number, value: number): void {
    this.playerStats.setPower(power, value);
    this.host.fieldChanged();
  }

  get unitFlags(): number {
    return this.playerStats.getUInt32(UNIT_FIELD_FLAGS);
  }

  setUnitFlag(flag: number, on: boolean): void {
    this.playerStats.setFlag(UNIT_FIELD_FLAGS, flag, on);
    this.host.fieldChanged();
  }

  get auraStateField(): number {
    return this.playerStats.getUInt32(UNIT_FIELD_AURASTATE);
  }

  set auraStateField(value: number) {
    this.playerStats.setUInt32(UNIT_FIELD_AURASTATE, value);
    this.host.fieldChanged();
  }

  /**
   * `Unit::GetReactionTo` from a player: reputation with a creature's faction, and for another player the same
   * raid, then `GetFactionReactionTo` between the race faction templates (duels and FFA PvP are outside the baseline).
   */
  reactionTo(target: SpellUnit): number {
    if (target === this) return 4;
    const factions = this.host.factions();
    if (target instanceof CreatureSpellUnit) return target.world.factions.playerToCreature(this.reactionPlayer(), target.info.factionTemplate);
    if (target.isPlayer) {
      if (this.isInPartyWith(target, true)) return 4;
      if (!factions) return 4;
      const mine = factions.template(this.reactionPlayer().factionTemplate);
      const theirs = factions.template((target as PlayerSpellUnit).reactionPlayer().factionTemplate);
      return templateReaction(mine, theirs);
    }
    return 3;
  }

  isInCombat(): boolean {
    return this.host.inCombat();
  }

  setInCombatWith(enemy: SpellUnit): void {
    if (!enemy.isPlayer) this.host.engage(enemy);
  }

  get creatureType(): number {
    return 7 /* CREATURE_TYPE_HUMANOID */;
  }

  isGameMaster(): boolean {
    return this.host.gameMaster();
  }

  isInFlight(): boolean {
    return false;
  }

  isMounted(): boolean {
    return false;
  }

  /** `Unit::isMoving`: `MOVEMENTFLAG_MASK_MOVING` in the last movement info. */
  isMoving(): boolean {
    return (this.host.moveFlags() & MOVEMENTFLAG_MASK_MOVING) !== 0;
  }

  isEvading(): boolean {
    return false;
  }

  get shapeshiftForm(): number {
    return 0;
  }

  get standState(): number {
    return this.host.standState();
  }

  /** `Unit::SetStandState` */
  setStandState(state: number): void {
    this.host.setStandState(state);
    this.standStateChanged();
  }

  /** The stand state changed (from the client or `SetStandState`): standing drops `NOT_SEATED` auras. */
  standStateChanged(): void {
    if (this.isStandState()) this.removeAurasWithInterruptFlags(E.AURA_INTERRUPT_FLAG_NOT_SEATED);
  }

  /** `Unit::UpdatePosition` aura interrupts for a client movement. */
  movedOrTurned(turn: boolean, relocated: boolean): void {
    let mask = 0;
    if (turn) mask |= E.AURA_INTERRUPT_FLAG_TURNING;
    if (relocated) mask |= E.AURA_INTERRUPT_FLAG_MOVE;
    if (mask) this.removeAurasWithInterruptFlags(mask);
  }

  get isTotem(): boolean {
    return false;
  }

  sendToSelf(opcode: number, body: Uint8Array): void {
    this.host.send(opcode, body);
  }

  sendToSet(opcode: number, body: Uint8Array, self: boolean): void {
    if (self) this.host.send(opcode, body);
    this.host.broadcast(opcode, body);
  }

  receiveDamage(attacker: SpellUnit | null, damage: number): boolean {
    return this.host.takeDamage(damage, attacker?.guid ?? 0n);
  }

  addThreat(): void {}

  modifyThreatPercent(): void {}

  /** `ThreatManager::ForwardThreatForAssistingMe`: every creature fighting this player takes the assistant's threat. */
  forwardThreatForAssistingMe(assistant: SpellUnit, amount: number): void {
    const threatened = this.world.threatenedBy?.(this) ?? [];
    const free = threatened.filter((unit) => !unit.hasUnitState(E.UNIT_STATE_CONTROLLED));
    for (const unit of free) unit.addThreat(assistant, amount / free.length);
    for (const unit of threatened) if (unit.hasUnitState(E.UNIT_STATE_CONTROLLED)) unit.addThreat(assistant, 0);
  }

  taunt(): void {}

  attackStop(): void {
    this.host.attackStop();
  }

  sendSpeed(moveType: number, speed: number): void {
    this.host.speedChanged(moveType, speed);
  }

  sendRoot(rooted: boolean): void {
    this.host.rootChanged(rooted);
  }

  get comboPoints(): number {
    return this.combo;
  }

  get comboTarget(): bigint {
    return this.comboTargetGuid;
  }

  /** `Player::AddComboPoints` */
  addComboPoints(target: SpellUnit, count: number): void {
    if (!count) return;
    let points = this.combo;
    if (target.guid !== this.comboTargetGuid) {
      this.comboTargetGuid = target.guid;
      points = 0;
    }
    this.combo = Math.max(0, Math.min(5, points + count));
    this.sendComboPoints();
  }

  /** `Player::ClearComboPoints` */
  clearComboPoints(): void {
    if (!this.comboTargetGuid) return;
    this.removeAurasByType(D.SPELL_AURA_RETAIN_COMBO_POINTS);
    this.combo = 0;
    this.sendComboPoints();
    this.comboTargetGuid = 0n;
  }

  /** `Player::SendComboPoints` */
  private sendComboPoints(): void {
    this.host.send(SMSG_UPDATE_COMBO_POINTS, comboPointsPacket(this.comboTargetGuid, this.combo));
  }

  /** `Unit::SetInFront`-free `Aura::HandleAuraSpecificMods` cooldown start (`AddSpellAndCategoryCooldowns` with infinity). */
  startCooldownOnEvent(info: SpellInfo, apply: boolean): void {
    if (apply) this.addSpellAndCategoryCooldowns(info, null, true);
    else this.sendCooldownEvent(info);
  }

  isInPartyWith(other: SpellUnit, raid: boolean): boolean {
    return other === this || this.host.partyWith(other, raid);
  }

  charmerOrOwner(): SpellUnit | null {
    return null;
  }

  victim(): SpellUnit | null {
    return this.host.victim();
  }

  nearTeleportTo(x: number, y: number, z: number, orientation: number): void {
    const pos = this.position();
    this.host.teleport(pos.map, x, y, z, orientation);
  }

  override teleportTo(map: number, x: number, y: number, z: number, orientation: number): void {
    this.host.teleport(map, x, y, z, orientation);
  }

  // ---- Player overrides

  override selectionGuid(): bigint {
    return this.host.selection();
  }

  override homebind(): UnitPosition | null {
    return this.host.homebind();
  }

  override learnSpell(spellId: number): void {
    this.host.learnSpell(spellId);
  }

  override hasSpell(spellId: number): boolean {
    return this.host.knowsSpell(spellId);
  }

  override hasItem(guid: bigint): boolean {
    return this.host.hasItem(guid);
  }

  override hasItemCount(entry: number, count: number): boolean {
    return this.host.hasItemCount(entry, count);
  }

  override destroyItemCount(entry: number, count: number): void {
    this.host.destroyItemCount(entry, count);
  }

  /** `Player::HasItemFitToSpellRequirements` for the equipped weapon or armor class. */
  override hasItemFitToSpellRequirements(info: SpellInfo): boolean {
    if (info.equippedItemClass < 0) return true;
    for (let slot = 0; slot < 19; slot++) {
      const item = this.playerStats.equippedItem(slot);
      if (!item || item.broken || item.template.class !== info.equippedItemClass) continue;
      if (info.equippedItemSubClassMask && !((1 << item.template.subclass) & info.equippedItemSubClassMask)) continue;
      if (info.equippedItemInventoryTypeMask && !((1 << item.template.InventoryType) & info.equippedItemInventoryTypeMask)) continue;
      return true;
    }
    return false;
  }

  /** `Player::CheckAttackFitToAuraRequirement` */
  override checkAttackFitToAuraRequirement(attType: number, aurEff: AuraEffect): boolean {
    const info = aurEff.spellInfo;
    if (info.equippedItemClass === -1) return true;
    const weapon = this.playerStats.weaponForAttack(attType);
    if (!weapon) return false;
    if (weapon.template.class !== info.equippedItemClass) return false;
    return !info.equippedItemSubClassMask || ((1 << weapon.template.subclass) & info.equippedItemSubClassMask) !== 0;
  }

  /** `Player::RewardRage` */
  override rewardRage(damage: number, weaponSpeedHitFactor: number, attacker: boolean): void {
    let points = rageReward(this.level, damage, weaponSpeedHitFactor, attacker, this.host.rageRate());
    if (attacker) points = Math.trunc(points + (points * this.getTotalAuraModifier(D.SPELL_AURA_MOD_RAGE_FROM_DAMAGE_DEALT)) / 100);
    else if (this.hasAura(18499)) points *= 2;
    this.host.addRage(points);
  }

  override seesSetOf(other: SpellUnit): boolean {
    return other === this || this.host.knows(other.guid);
  }

  override isGodMode(): boolean {
    return false;
  }

  override leewayMoving(): boolean {
    const flags = this.host.moveFlags();
    return (flags & LEEWAY_MOVE_FLAGS) !== 0 && (flags & MOVEMENTFLAG_WALKING) === 0;
  }

  override hasLeewayMovement(): boolean {
    const flags = this.host.moveFlags();
    if (flags & MOVEMENTFLAG_FALLING) return true;
    if (!(flags & MOVEMENTFLAG_MASK_MOVING)) return false;
    return this.speed(flags & MOVEMENTFLAG_WALKING ? E.MOVE_WALK : E.MOVE_RUN) > LEEWAY_MIN_MOVE_SPEED;
  }

  override rangedAttackSpeedPct(): number {
    return this.playerStats.attackSpeedPct(2);
  }

  override canApplyResilience(): boolean {
    return true;
  }

  protected override onCooldownsChanged(): void {
    this.host.cooldownsChanged();
  }

  protected override onChannelChanged(): void {
    const guid = this.channelObject;
    this.playerStats.setUInt32(UNIT_FIELD_CHANNEL_OBJECT, Number(guid & 0xffffffffn));
    this.playerStats.setUInt32(UNIT_FIELD_CHANNEL_OBJECT + 1, Number((guid >> 32n) & 0xffffffffn));
    this.playerStats.setUInt32(UNIT_CHANNEL_SPELL, this.channelSpell);
    this.host.fieldChanged();
  }
}
