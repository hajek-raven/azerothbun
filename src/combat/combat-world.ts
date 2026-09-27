import type { WorldTables } from "../database/world-tables.ts";
import type { DbcStores } from "../data/dbc.ts";
import type { CreatureSpawn, WorldData } from "../data/world.ts";
import type { SpellStore } from "../spells/spell-info.ts";
import { AURA_INTERRUPT_FLAG_MELEE_ATTACK, CURRENT_MELEE_SPELL, UNIT_STATE_CASTING, UNIT_STATE_CONTROLLED, UNIT_STATE_LOST_CONTROL, UNIT_STATE_NOT_MOVE } from "../spells/enums.ts";
import type { SpellUnit } from "../spells/unit.ts";
import * as spellMath from "../spells/unit-math.ts";
import { CreatureSpellUnit, type CreatureWorld } from "./creature-spell-unit.ts";
import { ServerConfig, type WorldConfig } from "../game/world/world-config.ts";
import { log } from "../log.ts";
import { creaturesNear, visibilityDistance, type SpawnIndex } from "../world/spawn.ts";
import { LootType, type Loot } from "../loot/loot.ts";
import { haveLootFor, lootStores } from "../loot/templates.ts";
import type { LootCreature } from "../world/loot-play.ts";
import {
  AI_REACTION_HOSTILE,
  ATTACK_DISPLAY_DELAY,
  BASE_ATTACK,
  CREATURE_FLAG_EXTRA_CANNOT_ENTER_COMBAT,
  CREATURE_FLAG_EXTRA_CIVILIAN,
  CREATURE_FLAG_EXTRA_DONT_CALL_ASSISTANCE,
  CREATURE_FLAG_EXTRA_IGNORE_ALL_ASSISTANCE_CALLS,
  CREATURE_FLAG_EXTRA_NO_BLOCK,
  CREATURE_FLAG_EXTRA_NO_CRIT,
  CREATURE_FLAG_EXTRA_NO_CRUSHING_BLOWS,
  CREATURE_FLAG_EXTRA_NO_DODGE,
  CREATURE_FLAG_EXTRA_NO_PARRY,
  CREATURE_FLAG_EXTRA_NO_PARRY_HASTEN,
  CREATURE_FLAG_EXTRA_NO_PLAYER_DAMAGE_REQ,
  CREATURE_FLAG_EXTRA_NO_XP,
  CREATURE_FLAG_EXTRA_TRIGGER,
  CREATURE_REGEN_INTERVAL,
  CREATURE_TYPE_CRITTER,
  CREATURE_TYPE_HUMANOID,
  CREATURE_TYPE_NON_COMBAT_PET,
  CREATURE_TYPE_TOTEM,
  CREATURE_Z_ATTACK_RANGE,
  DEFAULT_COMBAT_REACH,
  INTERACTION_DISTANCE,
  DEFAULT_PLAYER_BOUNDING_RADIUS,
  EMOTE_ONESHOT_PARRY_SHIELD,
  EMOTE_ONESHOT_WOUND_CRITICAL,
  HITINFO_AFFECTS_VICTIM,
  HITINFO_BLOCK,
  HITINFO_CRITICALHIT,
  HITINFO_CRUSHING,
  HITINFO_GLANCING,
  HITINFO_MISS,
  HITINFO_NORMALSWING,
  HITINFO_OFFHAND,
  HITINFO_SWINGNOHITSOUND,
  MELEE_HIT_BLOCK,
  MELEE_HIT_CRIT,
  MELEE_HIT_CRUSHING,
  MELEE_HIT_DODGE,
  MELEE_HIT_EVADE,
  MELEE_HIT_GLANCING,
  MELEE_HIT_MISS,
  MELEE_HIT_NORMAL,
  MELEE_HIT_PARRY,
  OFF_ATTACK,
  REP_FRIENDLY,
  REP_HOSTILE,
  RESPAWN_AGGRO_GRACE_SECONDS,
  SMSG_AI_REACTION,
  SMSG_ATTACKERSTATEUPDATE,
  SMSG_ATTACKSTART,
  SMSG_ATTACKSTOP,
  SMSG_ATTACKSWING_BADFACING,
  SMSG_ATTACKSWING_NOTINRANGE,
  SMSG_CANCEL_COMBAT,
  SMSG_EMOTE,
  SMSG_LOOT_LIST,
  SMSG_MONSTER_MOVE,
  SMSG_PARTYKILLLOG,
  SMSG_UPDATE_OBJECT,
  UNIT_DYNFLAG_LOOTABLE,
  UNIT_DYNFLAG_TAPPED,
  UNIT_DYNFLAG_TAPPED_BY_PLAYER,
  UNIT_FLAG_IMMUNE_TO_PC,
  UNIT_FLAG_IN_COMBAT,
  UNIT_FLAG_NON_ATTACKABLE,
  UNIT_FLAG_NOT_SELECTABLE,
  UNIT_FLAG_PACIFIED,
  UNIT_FLAG_SKINNABLE,
  VICTIMSTATE_BLOCKS,
  VICTIMSTATE_DODGE,
  VICTIMSTATE_EVADES,
  VICTIMSTATE_HIT,
  VICTIMSTATE_INTACT,
  VICTIMSTATE_PARRY,
  type MeleeHitOutcome,
} from "./constants.ts";
import { CreatureInfoStore, isElite, isWorldBoss, type CreatureInfo } from "./creature.ts";
import { FactionStore, hasHostility, isNeutralToAll, respondsToCallForHelp, type PlayerReputation } from "./faction.ts";
import {
  aggroRange,
  angleTo,
  armorReducedDamage,
  corpseDelaySeconds,
  critChanceAgainst,
  distance2d,
  distanceSq,
  glancingDamage,
  hasInArc,
  killXp,
  leashTimerSeconds,
  meleeMissChance,
  meleeRange,
  rageReward,
  rageWeaponSpeedHitFactor,
  rollDamage,
  rollMeleeOutcome,
  withinBoundaryRadius,
  withinMeleeRange,
  type CorpseDecay,
  type Point,
} from "./formulas.ts";
import {
  aiReactionPacket,
  attackerStateUpdate,
  attackStartPacket,
  attackStopPacket,
  emotePacket,
  lootListPacket,
  monsterMovePacket,
  partyKillLogPacket,
  unitValuesUpdate,
  UNIT_DYNAMIC_FLAGS,
  UNIT_FIELD_FLAGS,
  UNIT_FIELD_HEALTH,
  UNIT_FIELD_TARGET,
  UNIT_NPC_FLAGS,
  type SubDamage,
} from "./packets.ts";

export type CombatRates = {
  aggro: number;
  xpKill: number;
  rageIncome: number;
  leashRadius: number;
  assistanceRadius: number;
  assistanceDelay: number;
  corpseDecay: CorpseDecay;
  corpseDecayLooted: number;
};

/** World config defaults (`Rate.Creature.Aggro`, `CreatureLeashRadius`, `Corpse.Decay.*`, and the rest). */
export const DEFAULT_COMBAT_RATES: CombatRates = {
  aggro: 1,
  xpKill: 1,
  rageIncome: 1,
  leashRadius: 30,
  assistanceRadius: 10,
  assistanceDelay: 2000,
  corpseDecay: { normal: 60, rare: 300, elite: 300, rareElite: 300, worldBoss: 3600 },
  corpseDecayLooted: 0.5,
};

let configuredRates: CombatRates = DEFAULT_COMBAT_RATES;

/** Reads the combat rates from `worldserver.conf` for every `CombatWorld` created afterwards and the ones alive now. */
export function configureCombatRates(settings: WorldConfig): CombatRates {
  configuredRates = {
    aggro: settings.getFloat(ServerConfig.RATE_CREATURE_AGGRO),
    xpKill: settings.getFloat(ServerConfig.RATE_XP_KILL),
    rageIncome: settings.getFloat(ServerConfig.RATE_POWER_RAGE_INCOME),
    leashRadius: settings.getFloat(ServerConfig.CONFIG_CREATURE_LEASH_RADIUS),
    assistanceRadius: settings.getFloat(ServerConfig.CONFIG_CREATURE_FAMILY_ASSISTANCE_RADIUS),
    assistanceDelay: settings.getUInt(ServerConfig.CONFIG_CREATURE_FAMILY_ASSISTANCE_DELAY),
    corpseDecay: {
      normal: settings.getUInt(ServerConfig.CONFIG_CORPSE_DECAY_NORMAL),
      rare: settings.getUInt(ServerConfig.CONFIG_CORPSE_DECAY_RARE),
      elite: settings.getUInt(ServerConfig.CONFIG_CORPSE_DECAY_ELITE),
      rareElite: settings.getUInt(ServerConfig.CONFIG_CORPSE_DECAY_RAREELITE),
      worldBoss: settings.getUInt(ServerConfig.CONFIG_CORPSE_DECAY_WORLDBOSS),
    },
    corpseDecayLooted: settings.getFloat(ServerConfig.RATE_CORPSE_DECAY_LOOTED),
  };
  for (const combat of live) {
    combat.rates = configuredRates;
  }
  return configuredRates;
}

const live = new Set<CombatWorld>();

/** What `Player` exposes to the melee code. The session fills it from `PlayerStats`. */
export type PlayerMelee = {
  attackTime: (attType: number) => number;
  hasOffhand: boolean;
  /** `CalculateMinMaxDamage(att, false, true, index)` and the weapon's damage school for that index. */
  damage: (attType: number, index: number) => { min: number; max: number; school: number };
  /** `PLAYER_CRIT_PERCENTAGE` / `PLAYER_OFFHAND_CRIT_PERCENTAGE` */
  crit: (attType: number) => number;
  weaponSkill: (attType: number) => number;
  maxSkill: number;
  defenseSkill: number;
  /** `GetExpertiseDodgeOrParryReduction(att)` in percent. */
  expertiseReduction: (attType: number) => number;
  modMeleeHitChance: number;
  armorPenetrationPct: number;
  dodge: number;
  parry: number;
  block: number;
  blockValue: number;
  armor: number;
  missFromDefense: number;
  critTakenReduction: number;
  canParry: boolean;
  canBlock: boolean;
  usesRage: boolean;
};

export type CreatureKill = {
  guid: bigint;
  entry: number;
  killCredit: [number, number];
  lootId: number;
  minGold: number;
  maxGold: number;
  xp: number;
};

/** The player side of `Unit` / `Player` for melee. */
export type CombatPlayer = {
  guid: number;
  name: () => string;
  position: () => { map: number; x: number; y: number; z: number; o: number };
  level: () => number;
  race: () => number;
  classId: () => number;
  factionTemplate: () => number;
  reputation: (faction: number) => PlayerReputation | null;
  /** Alive and not a ghost. */
  alive: () => boolean;
  gameMaster: () => boolean;
  sitting: () => boolean;
  standUp: () => void;
  /** Moving forward, strafing, or falling while not walking (`GetLeewayBonusRangeForTargets`). */
  moving: () => boolean;
  mounted: () => boolean;
  knows: (guid: bigint) => boolean;
  send: (opcode: number, body: Uint8Array) => void;
  /** To the players that see this player. */
  broadcast: (opcode: number, body: Uint8Array) => void;
  health: () => number;
  melee: () => PlayerMelee | null;
  /** Lowers health. Returns true when the player died from it. */
  takeDamage: (amount: number, attacker: bigint) => boolean;
  addRage: (points: number) => void;
  setInCombat: (on: boolean) => void;
  /** `KillRewarder` for this player, and the kill-time loot it fills (`Loot::FillLoot`, `generateMoneyLoot`). */
  killedCreature: (kill: CreatureKill) => Loot | null;
  /** `Player::UpdateCombatSkills` */
  combatSkill: (attType: number, victimLevel: number, defence: boolean) => void;
  /** Recompute which spawns the player sees (after a corpse is removed or a creature respawns). */
  refreshSpawns: () => void;
  /** The player's `Unit` for the spell and aura code, when the session has a spell store. */
  spellUnit?: () => SpellUnit | null;
};

type DeathState = "alive" | "corpse" | "dead";

type Move = { from: Point; to: Point; startMs: number; durationMs: number; home: boolean };

/** `Creature` runtime state. A spawn without one is alive at home at full health. */
export type CreatureUnit = {
  info: CreatureInfo;
  /** The creature's `Unit` for spells and auras (created on first use). */
  spell: CreatureSpellUnit | null;
  /** `ThreatManager` taunt stack (player guids, last is active). */
  taunts: number[];
  health: number;
  deathState: DeathState;
  pos: Point & { o: number };
  move: Move | null;
  threat: Map<number, number>;
  victim: number | null;
  attackTimer: number;
  regenTimer: number;
  evading: boolean;
  lootRecipient: number | null;
  playerDamageReq: number;
  damagedByPlayer: boolean;
  /** `Creature::loot`, filled at the kill; null when cleared. */
  loot: Loot | null;
  /** `UNIT_DYNFLAG_LOOTABLE` */
  lootable: boolean;
  skinnable: boolean;
  corpseRemoveTime: number;
  respawnTime: number;
  respawnedTime: number;
  lastLeashExtension: number;
  splineId: number;
  lastChaseMs: number;
  lastFacingMs: number;
  alreadyCalledAssistance: boolean;
};

type PlayerState = {
  player: CombatPlayer;
  victim: number | null;
  meleeAttacking: boolean;
  attackTimer: [number, number];
  swingError: number;
  inCombat: boolean;
  lastAggroScanMs: number;
};

type AssistEvent = { atMs: number; victim: number; assistants: number[] };

/** What the create block shows for a creature that is not alive at home at full health. */
export type LiveCreature = {
  hidden: boolean;
  health: number;
  x: number;
  y: number;
  z: number;
  o: number;
  unitFlags: number;
  dynamicFlags: number;
  npcFlags: number;
  target: bigint;
};

const AGGRO_SCAN_INTERVAL_MS = 250;
const CHASE_REPATH_MS = 250;
const FACING_INTERVAL_MS = 400;
const FACING_TOLERANCE = 0.35;

export function highGuidIsCreature(guid: bigint): boolean {
  return guid >> 48n === 0xf130n;
}

export function spawnGuidOf(guid: bigint): number {
  return Number(guid & 0xffffffn);
}

export class CombatWorld implements CreatureWorld {
  readonly factions: FactionStore;
  readonly infos: CreatureInfoStore;
  rates: CombatRates = configuredRates;
  private readonly units = new Map<number, CreatureUnit>();
  private readonly players = new Map<number, PlayerState>();
  private readonly assists: AssistEvent[] = [];
  private lastUpdateMs: number | null = null;
  private nextSplineId = 1;
  private spellStore: SpellStore | null = null;

  constructor(
    world: WorldData,
    private readonly spawns: SpawnIndex,
    private readonly db: WorldTables | null,
    dbc: DbcStores | null = null,
    factions?: FactionStore,
    spellStore?: SpellStore | null,
  ) {
    this.spellStore = spellStore ?? null;
    this.infos = new CreatureInfoStore(world, db);
    this.factions = factions ?? FactionStore.load(db, dbc?.factions ?? []);
    live.add(this);
  }

  setSpellStore(spells: SpellStore): void {
    this.spellStore = spells;
  }

  // ------------------------------------------------------------------ players

  addPlayer(player: CombatPlayer): void {
    this.players.set(player.guid, {
      player,
      victim: null,
      meleeAttacking: false,
      attackTimer: [0, 0],
      swingError: 0,
      inCombat: false,
      lastAggroScanMs: 0,
    });
  }

  /** The player left the world: `CombatStop` and removal from every threat list. */
  removePlayer(guid: number): void {
    const state = this.players.get(guid);
    if (!state) {
      return;
    }
    this.players.delete(guid);
    for (const unit of this.units.values()) {
      if (unit.threat.delete(guid) && unit.victim === guid) {
        unit.victim = null;
      }
    }
  }

  inCombat(guid: number): boolean {
    return this.players.get(guid)?.inCombat ?? false;
  }

  victimOf(guid: number): bigint | null {
    const state = this.players.get(guid);
    if (!state || state.victim === null) {
      return null;
    }
    return this.liveUnit(state.victim)?.info.guid ?? null;
  }

  /** `WorldSession::HandleAttackSwingOpcode` */
  attackSwing(playerGuid: number, target: bigint): void {
    const state = this.players.get(playerGuid);
    if (!state) {
      return;
    }
    const self = BigInt(playerGuid);
    const unit = highGuidIsCreature(target) ? this.liveUnit(spawnGuidOf(target)) : null;
    if (!unit || unit.info.guid !== target) {
      this.sendToSelfAndSet(state.player, SMSG_ATTACKSTOP, attackStopPacket(self, null, false));
      return;
    }
    if (!this.isValidAttackTarget(state.player, unit)) {
      this.sendToSelfAndSet(state.player, SMSG_ATTACKSTOP, attackStopPacket(self, target, false));
      return;
    }
    this.attack(state, unit);
  }

  /** `WorldSession::HandleAttackStopOpcode` → `Unit::AttackStop` */
  attackStop(playerGuid: number): void {
    const state = this.players.get(playerGuid);
    if (state) {
      this.playerAttackStop(state);
    }
  }

  /** The player died: `Unit::setDeathState(JustDied)` → `CombatStop`, and every creature drops them. */
  playerDied(playerGuid: number): void {
    const state = this.players.get(playerGuid);
    if (!state) {
      return;
    }
    this.playerAttackStop(state);
    state.player.send(SMSG_CANCEL_COMBAT, new Uint8Array());
    for (const unit of this.units.values()) {
      if (unit.threat.delete(playerGuid) && unit.victim === playerGuid) {
        unit.victim = null;
      }
    }
    this.refreshPlayerCombat(state);
  }

  /** `Player::isAllowedToLoot` for a creature corpse. */
  canLoot(playerGuid: number, creature: bigint): boolean {
    if (!highGuidIsCreature(creature)) {
      return true;
    }
    const unit = this.units.get(spawnGuidOf(creature));
    if (!unit || unit.info.guid !== creature) {
      return false;
    }
    return this.isAllowedToLoot(unit, playerGuid);
  }

  /**
   * `Player::isAllowedToLoot`: a dead creature with loot left for everyone or for this player, looted by its recipient.
   * The damage requirement (`IsDamageEnoughForLootingAndReward`) cleared the recipient at the kill.
   */
  private isAllowedToLoot(unit: CreatureUnit, playerGuid: number): boolean {
    if (unit.deathState === "alive" || unit.lootRecipient === null) {
      return false;
    }
    const loot = unit.loot;
    // nothing to loot or everything looted.
    if (!loot || loot.isLooted()) {
      return false;
    }
    // no loot in creature for this player
    if (!loot.hasItemForAll() && !loot.hasItemFor({ guid: BigInt(playerGuid) })) {
      return false;
    }
    if (loot.loot_type === LootType.SKINNING) {
      return unit.lootRecipient === playerGuid;
    }
    // Without a group only the recipient loots.
    return unit.lootRecipient === playerGuid;
  }

  /** The creature behind a loot guid (`Map::GetCreature`) as the loot handlers see it. */
  lootCreature(guid: bigint, playerGuid: number): LootCreature | null {
    if (!highGuidIsCreature(guid)) {
      return null;
    }
    const unit = this.units.get(spawnGuidOf(guid));
    if (!unit || unit.info.guid !== guid) {
      return null;
    }
    const place = this.players.get(playerGuid)?.player.position();
    return {
      guid,
      alive: unit.deathState === "alive",
      lootable: unit.lootable,
      lootRecipient: unit.lootRecipient,
      loot: unit.loot,
      withinInteractionDistance: !!place && this.isWithinDistInMap(unit, place, INTERACTION_DISTANCE),
    };
  }

  /** `WorldObject::IsWithinDistInMap` from a player: 3D distance within `dist` plus both object sizes (`GetObjectSize`). */
  private isWithinDistInMap(unit: CreatureUnit, place: { map: number; x: number; y: number; z: number }, dist: number): boolean {
    if (place.map !== unit.info.map) {
      return false;
    }
    const maxdist = dist + unit.info.combatReach + DEFAULT_COMBAT_REACH;
    const dx = unit.pos.x - place.x;
    const dy = unit.pos.y - place.y;
    const dz = unit.pos.z - place.z;
    return dx * dx + dy * dy + dz * dz < maxdist * maxdist;
  }

  /** `WorldSession::DoLootRelease` for a creature, after the looter checks passed. */
  releaseLoot(creature: bigint, playerGuid: number): void {
    const unit = highGuidIsCreature(creature) ? this.units.get(spawnGuidOf(creature)) : undefined;
    if (!unit || unit.info.guid !== creature || !unit.loot) {
      return;
    }
    const loot = unit.loot;
    if (loot.isLooted()) {
      // skip pickpocketing loot for speed, skinning timer reduction is no-op in fact
      if (unit.deathState !== "alive") {
        this.allLootRemovedFromCorpse(unit, this.nowSeconds());
      }
      unit.lootable = false;
      loot.clear();
      this.sendCorpseUpdate(unit);
    } else {
      // if the round robin player release, reset it.
      if (loot.roundRobinPlayer === BigInt(playerGuid)) {
        loot.roundRobinPlayer = 0n;
      }
      // force dynflag update to update looter and lootable info
      this.sendDynamicFlags(unit);
    }
  }


  /** The create block overrides for a spawn, as `viewer` sees it. Null means the spawn row as stored. */
  liveView(spawnGuid: number, viewer: number): LiveCreature | null {
    const unit = this.units.get(spawnGuid);
    if (!unit) {
      return null;
    }
    const pos = this.position(unit, this.clockMs());
    return {
      hidden: unit.deathState === "dead",
      health: unit.health,
      x: pos.x,
      y: pos.y,
      z: pos.z,
      o: pos.o,
      unitFlags: this.unitFlags(unit),
      dynamicFlags: this.dynamicFlagsFor(unit, viewer),
      npcFlags: unit.deathState === "alive" ? unit.info.npcFlags : 0,
      target: unit.victim !== null ? BigInt(unit.victim) : 0n,
    };
  }

  // ------------------------------------------------------------------ tick

  /** One `Map::Update` step. Safe to call from every session: only the first call per millisecond advances. */
  update(nowMs: number): void {
    if (this.lastUpdateMs === null) {
      this.lastUpdateMs = nowMs;
      return;
    }
    const diff = nowMs - this.lastUpdateMs;
    if (diff <= 0) {
      return;
    }
    this.lastUpdateMs = nowMs;
    const nowSec = Math.floor(nowMs / 1000);
    this.runAssists(nowMs);
    for (const state of this.players.values()) {
      this.updatePlayer(state, diff, nowMs);
    }
    for (const unit of [...this.units.values()]) {
      this.updateCreature(unit, diff, nowMs, nowSec);
    }
    for (const state of this.players.values()) {
      this.refreshPlayerCombat(state);
    }
  }

  private clockMs(): number {
    return this.lastUpdateMs ?? Date.now();
  }

  private nowSeconds(): number {
    return Math.floor(this.clockMs() / 1000);
  }

  // ------------------------------------------------------------------ player melee

  private updatePlayer(state: PlayerState, diff: number, nowMs: number): void {
    state.attackTimer[0] = Math.max(0, state.attackTimer[0] - diff);
    state.attackTimer[1] = Math.max(0, state.attackTimer[1] - diff);
    const player = state.player;
    if (!player.alive()) {
      if (state.victim !== null) {
        this.playerAttackStop(state);
      }
      return;
    }
    if (nowMs - state.lastAggroScanMs >= AGGRO_SCAN_INTERVAL_MS) {
      state.lastAggroScanMs = nowMs;
      this.moveInLineOfSight(player, nowMs);
    }
    if (!state.meleeAttacking || state.victim === null) {
      return;
    }
    // `Player::Update` skips the melee block while casting (`UNIT_STATE_CASTING | UNIT_STATE_CHARGING`).
    if (player.spellUnit?.()?.hasUnitState(UNIT_STATE_CASTING)) {
      return;
    }
    const unit = this.units.get(state.victim);
    if (!unit || unit.deathState !== "alive") {
      this.playerAttackStop(state);
      return;
    }
    const melee = player.melee();
    if (!melee) {
      return;
    }
    const place = player.position();
    const unitPos = this.position(unit, nowMs);
    const leeway = player.moving() && unit.move !== null && !unit.move.home;
    if (state.attackTimer[BASE_ATTACK] === 0) {
      if (place.map !== unit.info.map || !withinMeleeRange(place, DEFAULT_COMBAT_REACH, unitPos, unit.info.combatReach, leeway)) {
        state.attackTimer[BASE_ATTACK] = 100;
        if (state.swingError !== 1) {
          player.send(SMSG_ATTACKSWING_NOTINRANGE, new Uint8Array());
          state.swingError = 1;
        }
      } else if (!withinBoundaryRadius(place, unitPos, unit.info.boundingRadius) && !hasInArc(place, unitPos, (2 * Math.PI) / 3)) {
        state.attackTimer[BASE_ATTACK] = 100;
        if (state.swingError !== 2) {
          player.send(SMSG_ATTACKSWING_BADFACING, new Uint8Array());
          state.swingError = 2;
        }
      } else {
        state.swingError = 0;
        if (melee.hasOffhand && state.attackTimer[OFF_ATTACK] < ATTACK_DISPLAY_DELAY) {
          state.attackTimer[OFF_ATTACK] = ATTACK_DISPLAY_DELAY;
        }
        this.playerSwing(state, unit, melee, BASE_ATTACK, nowMs);
        state.attackTimer[BASE_ATTACK] = melee.attackTime(BASE_ATTACK);
      }
    }
    if (melee.hasOffhand && state.attackTimer[OFF_ATTACK] === 0 && state.victim !== null && unit.deathState === "alive") {
      if (place.map !== unit.info.map || !withinMeleeRange(place, DEFAULT_COMBAT_REACH, unitPos, unit.info.combatReach, leeway)) {
        state.attackTimer[OFF_ATTACK] = 100;
      } else if (!withinBoundaryRadius(place, unitPos, unit.info.boundingRadius) && !hasInArc(place, unitPos, (2 * Math.PI) / 3)) {
        state.attackTimer[BASE_ATTACK] = 100;
      } else {
        if (state.attackTimer[BASE_ATTACK] < ATTACK_DISPLAY_DELAY) {
          state.attackTimer[BASE_ATTACK] = ATTACK_DISPLAY_DELAY;
        }
        this.playerSwing(state, unit, melee, OFF_ATTACK, nowMs);
        state.attackTimer[OFF_ATTACK] = melee.attackTime(OFF_ATTACK);
      }
    }
  }

  /** `Unit::Attack(victim, true)` for a player. */
  private attack(state: PlayerState, unit: CreatureUnit): void {
    const player = state.player;
    const self = BigInt(player.guid);
    if (!player.alive() || unit.deathState !== "alive" || player.mounted()) {
      return;
    }
    if (unit.evading) {
      return;
    }
    if (state.victim === unit.info.spawnGuid) {
      if (!state.meleeAttacking) {
        state.meleeAttacking = true;
        this.sendToSelfAndSet(player, SMSG_ATTACKSTART, attackStartPacket(self, unit.info.guid));
      }
      return;
    }
    state.victim = unit.info.spawnGuid;
    state.meleeAttacking = true;
    state.swingError = 0;
    unit.lastLeashExtension = this.nowSeconds();
    const melee = player.melee();
    if (melee?.hasOffhand && state.attackTimer[OFF_ATTACK] === 0) {
      state.attackTimer[OFF_ATTACK] = Math.max(state.attackTimer[OFF_ATTACK], state.attackTimer[BASE_ATTACK] + melee.attackTime(BASE_ATTACK) * 0.5);
    }
    this.sendToSelfAndSet(player, SMSG_ATTACKSTART, attackStartPacket(self, unit.info.guid));
  }

  private playerAttackStop(state: PlayerState): void {
    if (state.victim === null) {
      return;
    }
    const unit = this.units.get(state.victim);
    state.victim = null;
    state.meleeAttacking = false;
    const victim = unit?.info.guid ?? null;
    this.sendToSelfAndSet(state.player, SMSG_ATTACKSTOP, attackStopPacket(BigInt(state.player.guid), victim, !state.player.alive()));
  }

  /** `Unit::_IsValidAttackTarget` for a player hitting a creature. */
  private isValidAttackTarget(player: CombatPlayer, unit: CreatureUnit): boolean {
    if (unit.deathState !== "alive" || !player.alive()) {
      return false;
    }
    const place = player.position();
    if (place.map !== unit.info.map) {
      return false;
    }
    const flags = unit.info.unitFlags;
    if (flags & (UNIT_FLAG_NON_ATTACKABLE | UNIT_FLAG_NOT_SELECTABLE | UNIT_FLAG_IMMUNE_TO_PC)) {
      return false;
    }
    if (unit.evading) {
      return false;
    }
    const reactionPlayer = this.reactionPlayer(player);
    if (this.factions.playerToCreature(reactionPlayer, unit.info.factionTemplate) >= REP_FRIENDLY) {
      return false;
    }
    if (this.factions.creatureToPlayer(unit.info.factionTemplate, reactionPlayer) >= REP_FRIENDLY) {
      return false;
    }
    return true;
  }

  /** `Unit::AttackerStateUpdate` → `CalculateMeleeDamage` → `DealMeleeDamage` for a player swing. */
  private playerSwing(state: PlayerState, unit: CreatureUnit, melee: PlayerMelee, attType: number, nowMs: number): void {
    const player = state.player;
    const info = unit.info;
    const level = player.level();
    const attacker = player.spellUnit?.() ?? null;
    const victimUnit = attacker && this.spellStore ? this.spellUnitOf(unit) : null;
    if (attacker) {
      if (attacker.hasUnitFlag(UNIT_FLAG_PACIFIED) || attacker.hasUnitState(UNIT_STATE_LOST_CONTROL)) {
        return;
      }
    }
    this.atTargetAttacked(player, unit, nowMs);
    if (attacker) {
      attacker.removeAurasWithInterruptFlags(AURA_INTERRUPT_FLAG_MELEE_ATTACK);
      // Melee attack spells cast on the main-hand swing instead of the normal hit.
      const meleeSpell = attType === BASE_ATTACK ? attacker.currentSpells[CURRENT_MELEE_SPELL] : null;
      if (meleeSpell) {
        meleeSpell.cast();
        return;
      }
    }

    const damages: [SubDamage, SubDamage] = [emptyDamage(), emptyDamage()];
    let cleanDamage = 0;
    for (let index = 0; index < 2; index++) {
      const range = melee.damage(attType, index);
      damages[index]!.schoolMask = 1 << range.school;
      if (range.max <= 0 && index > 0) {
        continue;
      }
      let raw = rollDamage(range.min, range.max);
      if (attacker && victimUnit) {
        raw = spellMath.meleeDamageBonusDone(attacker, victimUnit, raw, attType, null, 1 << range.school);
        raw = spellMath.meleeDamageBonusTaken(victimUnit, attacker, raw, attType, null, 1 << range.school);
      }
      if (range.school === 0) {
        const reduced = armorReducedDamage(raw, this.armorOf(unit), level, melee.armorPenetrationPct, info.level);
        damages[index]!.damage = reduced;
        cleanDamage += raw - reduced;
      } else {
        damages[index]!.damage = raw;
      }
    }

    const creatureSkill = info.level * 5;
    const weaponSkill = melee.weaponSkill(attType);
    const unitPos = this.position(unit, nowMs);
    const place = player.position();
    const inFront = hasInArc(unitPos, place, Math.PI);
    const worldBoss = isWorldBoss(info.typeFlags);
    const outcome = rollMeleeOutcome({
      attackerIsPlayer: true,
      victimIsPlayer: false,
      victimEvading: unit.evading,
      attackerLevel: level,
      victimLevel: info.level,
      attackerMaxSkillValueForLevel: melee.maxSkill,
      victimMaxSkillValueForLevel: creatureSkill,
      attackerWeaponSkill: weaponSkill,
      victimDefenseSkill: creatureSkill,
      miss: Math.trunc(
        meleeMissChance({
          victimMissChance: 5,
          victimIsPlayer: false,
          skillDiff: weaponSkill - creatureSkill,
          dualWield: melee.hasOffhand,
          modMeleeHitChance: melee.modMeleeHitChance,
        }) * 100,
      ),
      crit: Math.trunc(critChanceAgainst(melee.crit(attType), melee.maxSkill, creatureSkill) * 100),
      dodge: info.type === CREATURE_TYPE_TOTEM ? 0 : Math.trunc((worldBoss ? 5.85 : 5) * 100),
      parry: Math.trunc((worldBoss ? 13.4 : info.type === CREATURE_TYPE_HUMANOID ? 5 : 0) * 100),
      block: info.type === CREATURE_TYPE_TOTEM ? 0 : 500,
      expertiseReduction: Math.trunc(melee.expertiseReduction(attType) * 100),
      attackerInFront: inFront,
      victimCanDodge: (info.flagsExtra & CREATURE_FLAG_EXTRA_NO_DODGE) === 0,
      victimCanParry: (info.flagsExtra & CREATURE_FLAG_EXTRA_NO_PARRY) === 0,
      victimCanBlock: (info.flagsExtra & CREATURE_FLAG_EXTRA_NO_BLOCK) === 0,
      victimControlled: victimUnit?.hasUnitState(UNIT_STATE_CONTROLLED) ?? false,
      noCrushing: true,
      noCrit: false,
    });

    const swing = applyOutcome(outcome, damages, cleanDamage, level, info.level, Math.trunc(info.level / 2), attType);
    if (attacker && victimUnit) absorbMeleeDamages(attacker, victimUnit, damages);
    this.sendToSelfAndSet(
      player,
      SMSG_ATTACKERSTATEUPDATE,
      attackerStateUpdate({
        hitInfo: swing.hitInfo,
        attacker: BigInt(player.guid),
        target: info.guid,
        damages,
        targetHealth: unit.health,
        targetState: swing.targetState,
        blocked: swing.blocked,
      }),
    );

    // DealMeleeDamage
    if (unit.deathState !== "alive" || unit.evading) {
      return;
    }
    if (swing.hitInfo & HITINFO_CRITICALHIT) {
      this.sendToViewers(unit, SMSG_EMOTE, emotePacket(info.guid, EMOTE_ONESHOT_WOUND_CRITICAL));
    }
    if (swing.blocked && swing.targetState !== VICTIMSTATE_BLOCKS) {
      this.sendToViewers(unit, SMSG_EMOTE, emotePacket(info.guid, EMOTE_ONESHOT_PARRY_SHIELD));
    }
    if (swing.targetState === VICTIMSTATE_PARRY && (info.flagsExtra & CREATURE_FLAG_EXTRA_NO_PARRY_HASTEN) === 0) {
      unit.attackTimer = parryHaste(unit.attackTimer, info.attackTime);
    }
    const total = damages[0].damage + damages[1].damage;
    if (melee.usesRage) {
      const factor = rageWeaponSpeedHitFactor(melee.attackTime(attType), attType === OFF_ATTACK);
      if (total > 0) {
        player.addRage(rageReward(level, total, outcome === MELEE_HIT_CRIT ? factor * 2 : factor, true, this.rates.rageIncome));
      } else if (swing.targetState === VICTIMSTATE_BLOCKS || swing.targetState === VICTIMSTATE_DODGE || swing.targetState === VICTIMSTATE_PARRY) {
        player.addRage(rageReward(level, swing.cleanDamage, factor, true, this.rates.rageIncome));
      }
    }
    if (skillOutcome(outcome, false)) {
      player.combatSkill(attType, info.level, false);
    }
    for (const damage of damages) {
      if (damage.damage > 0 && unit.deathState === "alive") {
        if (attacker && victimUnit) spellMath.dealDamage(attacker, victimUnit, damage.damage, damage.absorb, DIRECT_DAMAGE, damage.schoolMask, null);
        else this.damageCreature(unit, damage.damage, player, nowMs);
      }
    }
  }

  // ------------------------------------------------------------------ creature damage and death

  // ------------------------------------------------------------------ spell map (`Map` for the spell system)

  get spells(): SpellStore {
    if (!this.spellStore) throw new Error("CombatWorld has no spell store");
    return this.spellStore;
  }

  /** Whether spells can run here (a `SpellStore` is attached). */
  get hasSpells(): boolean {
    return this.spellStore !== null;
  }

  now(): number {
    return this.clockMs();
  }

  /** `ObjectAccessor::GetUnit`: a player in this world or a live creature spawn. */
  unit(guid: bigint): SpellUnit | null {
    if (highGuidIsCreature(guid)) {
      const unit = this.creatureUnit(spawnGuidOf(guid));
      if (!unit || unit.info.guid !== guid || unit.deathState === "dead") return null;
      return this.spellUnitOf(unit);
    }
    const state = this.players.get(Number(guid & 0xffffffffn));
    return state?.player.spellUnit?.() ?? null;
  }

  /** Units on the reference's map within `radius` of `center` (grid search for spell targets). */
  unitsInRange(reference: SpellUnit, radius: number, center?: { x: number; y: number; z: number }): SpellUnit[] {
    const origin = reference.position();
    const at = center ?? origin;
    const result: SpellUnit[] = [];
    for (const state of this.players.values()) {
      const unit = state.player.spellUnit?.();
      if (!unit) continue;
      const pos = unit.position();
      if (pos.map !== origin.map) continue;
      if ((pos.x - at.x) ** 2 + (pos.y - at.y) ** 2 + (pos.z - at.z) ** 2 > (radius + unit.combatReach) ** 2) continue;
      result.push(unit);
    }
    for (const spawn of creaturesNear(this.spawns, { map: origin.map, x: at.x, y: at.y, z: at.z }, radius + 10)) {
      const unit = this.creatureUnit(spawn.guid);
      if (!unit || unit.deathState === "dead") continue;
      const pos = this.position(unit, this.clockMs());
      if ((pos.x - at.x) ** 2 + (pos.y - at.y) ** 2 + (pos.z - at.z) ** 2 > (radius + unit.info.combatReach) ** 2) continue;
      result.push(this.spellUnitOf(unit));
    }
    return result;
  }

  threatenedBy(target: SpellUnit): SpellUnit[] {
    if (!target.isPlayer) return [];
    const guid = Number(target.guid & 0xffffffffn);
    const result: SpellUnit[] = [];
    for (const unit of this.units.values()) if (unit.deathState === "alive" && unit.threat.has(guid)) result.push(this.spellUnitOf(unit));
    return result;
  }

  /** The creature's spell unit (created with the live state on first use). */
  spellUnitOf(unit: CreatureUnit): CreatureSpellUnit {
    unit.spell ??= new CreatureSpellUnit(this, unit);
    return unit.spell;
  }

  /** A spawn's live state, created at home at full health the first time something touches it. */
  creatureUnit(spawnGuid: number): CreatureUnit | null {
    return this.liveUnit(spawnGuid);
  }

  // ------------------------------------------------------------------ creature host for the spell system

  creaturePosition(unit: CreatureUnit): Point & { o: number } {
    return this.position(unit, this.clockMs());
  }

  creatureSendToViewers(unit: CreatureUnit, opcode: number, body: Uint8Array): void {
    this.sendToViewers(unit, opcode, body);
  }

  creatureTakeDamage(unit: CreatureUnit, attacker: SpellUnit | null, damage: number): boolean {
    if (unit.deathState !== "alive" || damage <= 0) return false;
    const player = attacker?.isPlayer ? this.players.get(Number(attacker.guid & 0xffffffffn))?.player ?? null : null;
    this.damageCreature(unit, damage, player, this.clockMs());
    return unit.deathState !== "alive";
  }

  creatureEngage(unit: CreatureUnit, enemy: SpellUnit): void {
    if (!enemy.isPlayer) return;
    const player = this.players.get(Number(enemy.guid & 0xffffffffn))?.player;
    if (player) this.engagePlayer(unit, player, this.clockMs());
  }

  creatureAddThreat(unit: CreatureUnit, attacker: SpellUnit, amount: number): void {
    if (!attacker.isPlayer || unit.deathState !== "alive" || unit.evading) return;
    const player = this.players.get(Number(attacker.guid & 0xffffffffn))?.player;
    if (!player) return;
    this.engagePlayer(unit, player, this.clockMs());
    unit.threat.set(player.guid, Math.max(0, (unit.threat.get(player.guid) ?? 0) + amount));
  }

  creatureFieldsChanged(unit: CreatureUnit, fields: { index: number; value: number }[]): void {
    this.sendToViewers(unit, SMSG_UPDATE_OBJECT, unitValuesUpdate(unit.info.guid, fields));
  }

  creatureAttackStop(unit: CreatureUnit): void {
    this.stopCreatureAttack(unit, false);
  }

  creatureStopMoving(unit: CreatureUnit): void {
    if (!unit.move) return;
    const pos = this.position(unit, this.clockMs());
    unit.pos = pos;
    unit.move = null;
    this.sendToViewers(unit, SMSG_MONSTER_MOVE, monsterMovePacket({ guid: unit.info.guid, splineId: this.splineId(unit), from: pos, stop: true }));
  }

  creatureNearTeleport(unit: CreatureUnit, position: { x: number; y: number; z: number; o: number }): void {
    unit.move = null;
    unit.pos = { ...position };
    this.sendToViewers(unit, SMSG_MONSTER_MOVE, monsterMovePacket({ guid: unit.info.guid, splineId: this.splineId(unit), from: unit.pos, stop: true }));
  }

  creatureVictim(unit: CreatureUnit): SpellUnit | null {
    return unit.victim === null ? null : (this.players.get(unit.victim)?.player.spellUnit?.() ?? null);
  }

  creatureUnitFlags(unit: CreatureUnit): number {
    return this.unitFlags(unit);
  }

  /** `UNIT_FIELD_ARMOR` with aura modifiers once the creature has a spell unit. */
  private armorOf(unit: CreatureUnit): number {
    return unit.spell ? unit.spell.stats.getArmor() : unit.info.armor;
  }

  private maxHealthOf(unit: CreatureUnit): number {
    return unit.spell ? unit.spell.maxHealth : unit.info.maxHealth;
  }

  /** `Unit::DealDamage` with a creature victim (a player attacker taps it and adds threat). */
  private damageCreature(unit: CreatureUnit, damage: number, attacker: CombatPlayer | null, nowMs: number): void {
    const info = unit.info;
    if (!attacker) {
      if (unit.health <= damage) {
        this.killCreature(unit, null, nowMs);
        return;
      }
      unit.health -= damage;
      this.sendToViewers(unit, SMSG_UPDATE_OBJECT, unitValuesUpdate(info.guid, [{ index: UNIT_FIELD_HEALTH, value: unit.health }]));
      return;
    }
    if (unit.lootRecipient === null) {
      unit.lootRecipient = attacker.guid;
      this.sendDynamicFlags(unit);
    }
    const unDamage = Math.min(unit.health, damage);
    if (unit.playerDamageReq) {
      unit.playerDamageReq = unit.playerDamageReq > unDamage ? unit.playerDamageReq - unDamage : 0;
    }
    if (unDamage > 0) {
      unit.damagedByPlayer = true;
    }
    if (unit.health <= damage) {
      this.killCreature(unit, attacker, nowMs);
      return;
    }
    unit.health -= damage;
    unit.lastLeashExtension = this.nowSeconds();
    unit.threat.set(attacker.guid, (unit.threat.get(attacker.guid) ?? 0) + damage);
    this.sendToViewers(unit, SMSG_UPDATE_OBJECT, unitValuesUpdate(info.guid, [{ index: UNIT_FIELD_HEALTH, value: unit.health }]));
  }

  /** `Unit::Kill` with a creature victim. */
  private killCreature(unit: CreatureUnit, killer: CombatPlayer | null, nowMs: number): void {
    const info = unit.info;
    const nowSec = Math.floor(nowMs / 1000);
    const rewardAllowed = (info.flagsExtra & CREATURE_FLAG_EXTRA_NO_PLAYER_DAMAGE_REQ) !== 0 || (unit.playerDamageReq === 0 && unit.damagedByPlayer);
    let rewarded: CombatPlayer | null = killer;
    if (!rewardAllowed) {
      unit.lootRecipient = null;
    } else if (unit.lootRecipient !== null) {
      const recipient = this.players.get(unit.lootRecipient)?.player;
      if (recipient && recipient.position().map === info.map) {
        rewarded = recipient;
      }
    }

    // setDeathState(JustDied) → Corpse
    const pos = this.position(unit, nowMs);
    const wasMoving = unit.move !== null;
    unit.pos = pos;
    unit.move = null;
    unit.health = 0;
    unit.deathState = "corpse";
    if (unit.spell) {
      // `Unit::setDeathState(JustDied)`: `InterruptNonMeleeSpells`, `RemoveAllAurasOnDeath`, `UnsummonAllTotems`.
      unit.spell.interruptNonMeleeSpells(false);
      unit.spell.removeAllAurasOnDeath();
    }
    unit.evading = false;
    const corpseDelay = corpseDelaySeconds(info.rank, this.rates.corpseDecay);
    unit.corpseRemoveTime = nowSec + corpseDelay;
    unit.respawnTime = nowSec + info.respawnDelay + corpseDelay;
    if (wasMoving) {
      this.sendToViewers(unit, SMSG_MONSTER_MOVE, monsterMovePacket({ guid: info.guid, splineId: this.splineId(unit), from: pos, stop: true }));
    }
    this.stopCreatureAttack(unit, true);
    unit.threat.clear();
    unit.victim = null;
    for (const state of this.players.values()) {
      if (state.victim === info.spawnGuid) {
        this.playerAttackStop(state);
      }
    }

    if (rewardAllowed && rewarded) {
      rewarded.send(SMSG_PARTYKILLLOG, partyKillLogPacket(BigInt(rewarded.guid), info.guid));
      this.sendToSelfAndSet(rewarded, SMSG_LOOT_LIST, lootListPacket(info.guid));
      const xp = killXp({
        playerLevel: rewarded.level(),
        mobLevel: info.level,
        mapId: info.map,
        elite: isElite(info.rank),
        experienceModifier: info.experienceModifier,
        healthModifier: info.healthModifier,
        noXp: (info.flagsExtra & CREATURE_FLAG_EXTRA_NO_XP) !== 0,
        critterOrTotem: info.type === CREATURE_TYPE_CRITTER || info.type === CREATURE_TYPE_TOTEM,
        rateXpKill: this.rates.xpKill,
        playerDamageReq: unit.playerDamageReq,
        maxHealth: info.maxHealth,
      });
      // Generate loot before updating looter
      unit.loot = rewarded.killedCreature({
        guid: info.guid,
        entry: info.entry,
        killCredit: info.killCredit,
        lootId: info.lootId,
        minGold: info.minGold,
        maxGold: info.maxGold,
        xp: rewarded.alive() ? xp : 0,
      });
    }
    // must be after setDeathState which resets dynamic flags
    unit.lootable = !!unit.loot && !unit.loot.isLooted();
    if (!unit.lootable) {
      this.allLootRemovedFromCorpse(unit, nowSec);
    }
    log("world", `${info.entry} (${info.spawnGuid}) killed by ${killer?.name() ?? "a spell"}${unit.lootable ? ", lootable" : ""}`);
    this.sendCorpseUpdate(unit);
  }

  /** `Creature::AllLootRemovedFromCorpse` */
  private allLootRemovedFromCorpse(unit: CreatureUnit, nowSec: number): void {
    const skinned = unit.loot?.loot_type === LootType.SKINNING;
    if (!skinned && unit.info.skinLoot && unit.lootRecipient !== null) {
      if (!this.db || haveLootFor(lootStores(this.db).skinning, unit.info.skinLoot)) {
        unit.skinnable = true;
      }
    }
    if (unit.corpseRemoveTime <= nowSec) {
      return;
    }
    const diff = Math.trunc((unit.corpseRemoveTime - nowSec) * this.rates.corpseDecayLooted) >>> 0;
    unit.respawnTime -= diff;
    // corpse skinnable, but without skinning flag, and then skinned, corpse will despawn next update
    if (skinned) {
      unit.corpseRemoveTime = nowSec;
    } else {
      unit.corpseRemoveTime -= diff;
    }
  }

  // ------------------------------------------------------------------ creature AI

  private updateCreature(unit: CreatureUnit, diff: number, nowMs: number, nowSec: number): void {
    if (unit.deathState === "dead") {
      if (unit.respawnTime <= nowSec) {
        this.respawn(unit, nowSec);
      }
      return;
    }
    if (unit.deathState === "corpse") {
      if (unit.corpseRemoveTime <= nowSec) {
        unit.deathState = "dead";
        // `Creature::RemoveCorpse` → `loot.clear()`
        unit.loot = null;
        unit.lootable = false;
        unit.skinnable = false;
        unit.pos = { ...unit.info.home };
        this.refreshViewers(unit);
      }
      return;
    }
    // `Unit::Update` → `m_Events.Update` (spell events) and `_UpdateSpells` (current spells and auras).
    unit.spell?.updateSpellsAndAuras(diff);
    if (unit.deathState !== "alive") {
      return;
    }
    unit.attackTimer = Math.max(0, unit.attackTimer - diff);
    if (unit.move && nowMs - unit.move.startMs >= unit.move.durationMs) {
      this.finishMove(unit, nowMs);
    }
    if (unit.evading) {
      return;
    }
    if (unit.threat.size > 0) {
      this.updateEngaged(unit, nowMs, nowSec);
    }
    if (unit.deathState !== "alive") {
      return;
    }
    unit.regenTimer -= diff;
    if (unit.regenTimer <= 0) {
      unit.regenTimer += CREATURE_REGEN_INTERVAL;
      const maxHealth = this.maxHealthOf(unit);
      if (unit.threat.size === 0 && !unit.evading && unit.info.regenHealth && unit.health < maxHealth) {
        unit.health = Math.min(maxHealth, unit.health + Math.trunc(maxHealth / 3));
        this.sendToViewers(unit, SMSG_UPDATE_OBJECT, unitValuesUpdate(unit.info.guid, [{ index: UNIT_FIELD_HEALTH, value: unit.health }]));
      }
    }
    const idleSpells = !unit.spell || (unit.spell.ownedAuras.length === 0 && unit.spell.appliedAuras.length === 0 && unit.spell.activeSpells.size === 0);
    if (idleSpells && unit.threat.size === 0 && unit.move === null && unit.health >= this.maxHealthOf(unit) && unit.lootRecipient === null && !this.targeted(unit)) {
      this.units.delete(unit.info.spawnGuid);
    }
  }

  /** `CreatureAI::UpdateVictim` + chase + `DoMeleeAttackIfReady`. */
  private updateEngaged(unit: CreatureUnit, nowMs: number, nowSec: number): void {
    const victimGuid = this.reselectVictim(unit, nowMs, nowSec);
    if (victimGuid === null) {
      this.enterEvadeMode(unit, nowMs);
      return;
    }
    const state = this.players.get(victimGuid)!;
    if (unit.victim !== victimGuid) {
      unit.victim = victimGuid;
      this.sendToViewers(unit, SMSG_ATTACKSTART, attackStartPacket(unit.info.guid, BigInt(victimGuid)));
      this.sendToViewers(unit, SMSG_UPDATE_OBJECT, unitValuesUpdate(unit.info.guid, [
        { index: UNIT_FIELD_TARGET, value: victimGuid },
        { index: UNIT_FIELD_TARGET + 1, value: 0 },
        { index: UNIT_FIELD_FLAGS, value: this.unitFlags(unit) },
      ]));
    }
    if (this.passive(unit.info)) {
      return;
    }
    const player = state.player;
    const place = player.position();
    const pos = this.position(unit, nowMs);
    const leeway = player.moving() && unit.move !== null;
    const inRange = withinMeleeRange(pos, unit.info.combatReach, place, DEFAULT_COMBAT_REACH, leeway);
    const controlled = unit.spell?.unitState ?? 0;
    if (!inRange) {
      if (!(controlled & UNIT_STATE_NOT_MOVE)) this.chase(unit, player, nowMs);
    } else if (unit.move === null && !(controlled & UNIT_STATE_LOST_CONTROL)) {
      this.faceVictim(unit, player, nowMs);
    }
    // `Unit::AttackerStateUpdate` returns early while pacified, out of control, or casting.
    if (inRange && unit.attackTimer === 0 && (this.unitFlags(unit) & UNIT_FLAG_PACIFIED) === 0 && !(controlled & (UNIT_STATE_LOST_CONTROL | UNIT_STATE_CASTING))) {
      this.creatureSwing(unit, state, nowMs);
      unit.attackTimer = unit.spell ? unit.spell.stats.attackTime(BASE_ATTACK) : unit.info.attackTime;
    }
  }

  private targeted(unit: CreatureUnit): boolean {
    for (const state of this.players.values()) {
      if (state.victim === unit.info.spawnGuid) {
        return true;
      }
    }
    return false;
  }

  /** `ThreatManager::ReselectVictim` with `ThreatReference::ShouldBeOffline` as the availability test. */
  private reselectVictim(unit: CreatureUnit, nowMs: number, nowSec: number): number | null {
    const available: { guid: number; threat: number }[] = [];
    for (const [guid, threat] of unit.threat) {
      const state = this.players.get(guid);
      if (!state || !this.canCreatureAttack(unit, state.player, nowMs, nowSec)) {
        continue;
      }
      available.push({ guid, threat });
    }
    if (available.length === 0) {
      return null;
    }
    // A taunt fixates the creature on the most recent taunter that is still available (`ThreatManager::TauntUpdate`).
    for (let index = unit.taunts.length - 1; index >= 0; index--) {
      const taunter = unit.taunts[index]!;
      if (available.some((row) => row.guid === taunter)) return taunter;
    }
    available.sort((left, right) => right.threat - left.threat);
    const highest = available[0]!;
    const old = unit.victim !== null ? available.find((row) => row.guid === unit.victim) : undefined;
    if (!old || highest.guid === old.guid) {
      return highest.guid;
    }
    if (!(highest.threat > old.threat * 1.1)) {
      return old.guid;
    }
    if (highest.threat > old.threat * 1.3) {
      return highest.guid;
    }
    const pos = this.position(unit, nowMs);
    for (const row of available) {
      if (row.guid === old.guid) {
        return old.guid;
      }
      if (!(row.threat > old.threat * 1.1)) {
        return old.guid;
      }
      const place = this.players.get(row.guid)!.player.position();
      if (withinMeleeRange(pos, unit.info.combatReach, place, DEFAULT_COMBAT_REACH)) {
        return row.guid;
      }
    }
    return old.guid;
  }

  /** `Creature::CanCreatureAttack` (and the victim-state checks of `_IsTargetAcceptable`). */
  private canCreatureAttack(unit: CreatureUnit, player: CombatPlayer, nowMs: number, nowSec: number, skipDistCheck = false): boolean {
    if (!player.alive() || player.gameMaster()) {
      return false;
    }
    const place = player.position();
    if (place.map !== unit.info.map) {
      return false;
    }
    if (unit.info.unitFlags & UNIT_FLAG_IMMUNE_TO_PC) {
      return false;
    }
    if (unit.evading) {
      return false;
    }
    if (unit.respawnedTime && nowSec - unit.respawnedTime < RESPAWN_AGGRO_GRACE_SECONDS && !unit.threat.has(player.guid)) {
      return false;
    }
    const pos = this.position(unit, nowMs);
    const visibility = visibilityDistance(unit.info.map);
    if (distanceSq(pos, place) > visibility * visibility) {
      return false;
    }
    if (!isWorldBoss(unit.info.typeFlags) && unit.lastLeashExtension + leashTimerSeconds(unit.info.minLevel) > nowSec) {
      return true;
    }
    if (skipDistCheck) {
      return true;
    }
    const leash = this.rates.leashRadius;
    if (!leash) {
      return true;
    }
    return distance2d(pos, unit.info.home) <= leash;
  }

  /** `CreatureAI::EnterEvadeMode` → `MoveTargetedHome`. */
  private enterEvadeMode(unit: CreatureUnit, nowMs: number): void {
    const info = unit.info;
    unit.evading = true;
    unit.spell?.removeEvadeAuras();
    unit.taunts.length = 0;
    this.stopCreatureAttack(unit, false);
    unit.threat.clear();
    unit.victim = null;
    unit.lootRecipient = null;
    unit.playerDamageReq = Math.trunc(unit.health / 2);
    unit.damagedByPlayer = false;
    unit.alreadyCalledAssistance = false;
    for (const state of this.players.values()) {
      if (state.victim === info.spawnGuid) {
        this.playerAttackStop(state);
      }
    }
    this.sendToViewers(unit, SMSG_UPDATE_OBJECT, unitValuesUpdate(info.guid, [
      { index: UNIT_FIELD_FLAGS, value: this.unitFlags(unit) },
      { index: UNIT_FIELD_TARGET, value: 0 },
      { index: UNIT_FIELD_TARGET + 1, value: 0 },
    ]));
    this.sendDynamicFlags(unit);
    const from = this.position(unit, nowMs);
    const to = { x: info.home.x, y: info.home.y, z: info.home.z };
    const distance = Math.sqrt(distanceSq(from, to));
    if (distance < 0.1) {
      unit.move = null;
      unit.evading = false;
      unit.pos = { ...info.home };
      return;
    }
    this.startMove(unit, from, to, distance, nowMs, true);
    this.sendToViewers(
      unit,
      SMSG_MONSTER_MOVE,
      monsterMovePacket({ guid: info.guid, splineId: this.splineId(unit), from, to, durationMs: unit.move!.durationMs, facingAngle: info.home.o }),
    );
  }

  private stopCreatureAttack(unit: CreatureUnit, nowDead: boolean): void {
    if (unit.victim === null) {
      return;
    }
    this.sendToViewers(unit, SMSG_ATTACKSTOP, attackStopPacket(unit.info.guid, BigInt(unit.victim), nowDead));
  }

  /** `Creature::Respawn` */
  private respawn(unit: CreatureUnit, nowSec: number): void {
    const info = unit.info;
    this.units.delete(info.spawnGuid);
    const fresh = this.createUnit(info);
    fresh.respawnedTime = nowSec;
    this.units.set(info.spawnGuid, fresh);
    log("world", `${info.entry} (${info.spawnGuid}) respawned`);
    this.refreshViewers(fresh);
  }

  /** `ChaseMovementGenerator`: run straight at the victim and stop in melee reach. */
  private chase(unit: CreatureUnit, player: CombatPlayer, nowMs: number): void {
    if (nowMs - unit.lastChaseMs < CHASE_REPATH_MS && unit.move !== null) {
      return;
    }
    const place = player.position();
    const reach = meleeRange(unit.info.combatReach, DEFAULT_COMBAT_REACH);
    if (unit.move) {
      const dest = unit.move.to;
      if (withinMeleeRange(dest, unit.info.combatReach, place, DEFAULT_COMBAT_REACH) && distanceSq(dest, place) < (reach - 1) * (reach - 1)) {
        return;
      }
    }
    unit.lastChaseMs = nowMs;
    const from = this.position(unit, nowMs);
    const total = Math.sqrt(distanceSq(from, place));
    const stop = Math.min(total, Math.max(0.5, Math.min(reach - 1.5, unit.info.combatReach + DEFAULT_PLAYER_BOUNDING_RADIUS)));
    const ratio = total > 0 ? (total - stop) / total : 0;
    const to = { x: from.x + (place.x - from.x) * ratio, y: from.y + (place.y - from.y) * ratio, z: from.z + (place.z - from.z) * ratio };
    const distance = total - stop;
    if (distance <= 0.05) {
      return;
    }
    this.startMove(unit, from, to, distance, nowMs, false);
    this.sendToViewers(
      unit,
      SMSG_MONSTER_MOVE,
      monsterMovePacket({ guid: unit.info.guid, splineId: this.splineId(unit), from, to, durationMs: unit.move!.durationMs, facingTarget: BigInt(player.guid) }),
    );
  }

  private faceVictim(unit: CreatureUnit, player: CombatPlayer, nowMs: number): void {
    const place = player.position();
    const wanted = angleTo(unit.pos, place);
    let delta = Math.abs(wanted - unit.pos.o);
    if (delta > Math.PI) {
      delta = Math.PI * 2 - delta;
    }
    if (delta < FACING_TOLERANCE || nowMs - unit.lastFacingMs < FACING_INTERVAL_MS) {
      return;
    }
    unit.lastFacingMs = nowMs;
    unit.pos.o = wanted;
    this.sendToViewers(
      unit,
      SMSG_MONSTER_MOVE,
      monsterMovePacket({ guid: unit.info.guid, splineId: this.splineId(unit), from: unit.pos, facingTarget: BigInt(player.guid) }),
    );
  }

  private startMove(unit: CreatureUnit, from: Point, to: Point, distance: number, nowMs: number, home: boolean): void {
    // `Unit::GetSpeed(MOVE_RUN)`: aura speed rates live on the spell unit.
    const speed = unit.spell ? unit.spell.speed(1 /* MOVE_RUN */) : unit.info.runSpeed > 0 ? unit.info.runSpeed : 7;
    unit.pos = { ...from, o: angleTo(from, to) };
    unit.move = { from, to, startMs: nowMs, durationMs: Math.max(1, (distance / speed) * 1000), home };
  }

  private finishMove(unit: CreatureUnit, _nowMs: number): void {
    const move = unit.move!;
    unit.pos = { ...move.to, o: move.home ? unit.info.home.o : angleTo(move.from, move.to) };
    unit.move = null;
    if (move.home) {
      unit.evading = false;
      unit.pos = { ...unit.info.home };
    }
  }

  /** Where the creature is now, along its spline. */
  private position(unit: CreatureUnit, nowMs: number): Point & { o: number } {
    const move = unit.move;
    if (!move) {
      return unit.pos;
    }
    const t = Math.min(1, Math.max(0, (nowMs - move.startMs) / move.durationMs));
    return {
      x: move.from.x + (move.to.x - move.from.x) * t,
      y: move.from.y + (move.to.y - move.from.y) * t,
      z: move.from.z + (move.to.z - move.from.z) * t,
      o: unit.pos.o,
    };
  }

  private splineId(unit: CreatureUnit): number {
    unit.splineId = this.nextSplineId++;
    return unit.splineId;
  }

  /** `Unit::AttackerStateUpdate` for a creature hitting a player. */
  private creatureSwing(unit: CreatureUnit, state: PlayerState, nowMs: number): void {
    const player = state.player;
    const info = unit.info;
    const melee = player.melee();
    if (!melee || !player.alive()) {
      return;
    }
    const sitting = player.sitting();
    this.engagePlayer(unit, player, nowMs);
    if (sitting) {
      player.standUp();
    }
    const playerLevel = player.level();
    const attacker = this.spellStore ? this.spellUnitOf(unit) : null;
    const victim = attacker ? (player.spellUnit?.() ?? null) : null;
    const damages: [SubDamage, SubDamage] = [emptyDamage(), emptyDamage()];
    damages[0].schoolMask = 1 << info.dmgSchool;
    let cleanDamage = 0;
    let raw: number;
    if (attacker && victim) {
      attacker.removeAurasWithInterruptFlags(AURA_INTERRUPT_FLAG_MELEE_ATTACK);
      const range = attacker.stats.minMaxDamage(BASE_ATTACK, false, true);
      raw = rollDamage(range.min, range.max);
      raw = spellMath.meleeDamageBonusDone(attacker, victim, raw, BASE_ATTACK, null, damages[0].schoolMask);
      raw = spellMath.meleeDamageBonusTaken(victim, attacker, raw, BASE_ATTACK, null, damages[0].schoolMask);
    } else {
      raw = rollDamage(info.minDamage, info.maxDamage);
    }
    if (info.dmgSchool === 0) {
      damages[0].damage = armorReducedDamage(raw, melee.armor, info.level);
      cleanDamage += raw - damages[0].damage;
    } else {
      damages[0].damage = raw;
    }
    const creatureSkill = info.level * 5;
    const place = player.position();
    const pos = this.position(unit, nowMs);
    const inFront = hasInArc(place, pos, Math.PI);
    let outcome = rollMeleeOutcome({
      attackerIsPlayer: false,
      victimIsPlayer: true,
      victimEvading: false,
      attackerLevel: info.level,
      victimLevel: playerLevel,
      attackerMaxSkillValueForLevel: creatureSkill,
      victimMaxSkillValueForLevel: melee.maxSkill,
      attackerWeaponSkill: creatureSkill,
      victimDefenseSkill: melee.defenseSkill,
      miss: Math.trunc(
        meleeMissChance({
          victimMissChance: 5 + melee.missFromDefense,
          victimIsPlayer: true,
          skillDiff: creatureSkill - melee.maxSkill,
          dualWield: false,
          modMeleeHitChance: 0,
        }) * 100,
      ),
      crit: Math.trunc(critChanceAgainst(5, creatureSkill, melee.defenseSkill, melee.critTakenReduction) * 100),
      dodge: Math.trunc(melee.dodge * 100),
      parry: melee.canParry ? Math.trunc(melee.parry * 100) : 0,
      block: melee.canBlock ? Math.trunc(melee.block * 100) : 0,
      expertiseReduction: 0,
      attackerInFront: inFront,
      victimCanDodge: true,
      victimCanParry: melee.canParry,
      victimCanBlock: melee.canBlock,
      victimControlled: victim?.hasUnitState(UNIT_STATE_CONTROLLED) ?? false,
      noCrushing: (info.flagsExtra & CREATURE_FLAG_EXTRA_NO_CRUSHING_BLOWS) !== 0,
      noCrit: (info.flagsExtra & CREATURE_FLAG_EXTRA_NO_CRIT) !== 0,
    });
    if (sitting && outcome !== MELEE_HIT_MISS) {
      outcome = MELEE_HIT_CRIT;
    }
    const swing = applyOutcome(outcome, damages, cleanDamage, info.level, playerLevel, melee.blockValue, BASE_ATTACK);
    if (attacker && victim) absorbMeleeDamages(attacker, victim, damages);
    this.sendToViewers(
      unit,
      SMSG_ATTACKERSTATEUPDATE,
      attackerStateUpdate({
        hitInfo: swing.hitInfo,
        attacker: info.guid,
        target: BigInt(player.guid),
        damages,
        targetHealth: player.health(),
        targetState: swing.targetState,
        blocked: swing.blocked,
      }),
      player,
    );
    if (!player.alive()) {
      return;
    }
    const self = BigInt(player.guid);
    if (swing.hitInfo & HITINFO_CRITICALHIT) {
      this.sendToSelfAndSet(player, SMSG_EMOTE, emotePacket(self, EMOTE_ONESHOT_WOUND_CRITICAL));
    }
    if (swing.blocked && swing.targetState !== VICTIMSTATE_BLOCKS) {
      this.sendToSelfAndSet(player, SMSG_EMOTE, emotePacket(self, EMOTE_ONESHOT_PARRY_SHIELD));
    }
    if (swing.targetState === VICTIMSTATE_PARRY) {
      if (melee.hasOffhand && state.attackTimer[OFF_ATTACK] < state.attackTimer[BASE_ATTACK]) {
        state.attackTimer[OFF_ATTACK] = parryHaste(state.attackTimer[OFF_ATTACK], melee.attackTime(OFF_ATTACK));
      } else {
        state.attackTimer[BASE_ATTACK] = parryHaste(state.attackTimer[BASE_ATTACK], melee.attackTime(BASE_ATTACK));
      }
    }
    if (skillOutcome(outcome, true)) {
      player.combatSkill(BASE_ATTACK, info.level, true);
    }
    const damage = damages[0].damage;
    if (damage <= 0) {
      return;
    }
    if (attacker && victim) {
      // `DealMeleeDamage` → `Unit::DealDamage`: victim rage, pushback, interrupts, and `Unit::Kill`.
      spellMath.dealDamage(attacker, victim, damage, damages[0].absorb, DIRECT_DAMAGE, damages[0].schoolMask, null);
      return;
    }
    if (melee.usesRage) {
      player.addRage(rageReward(playerLevel, damage, 0, false, this.rates.rageIncome));
    }
    if (player.takeDamage(damage, info.guid)) {
      log("world", `${player.name()} killed by ${info.entry} (${info.spawnGuid})`);
      this.playerDied(player.guid);
    }
  }

  /** `Creature::CallAssistance` → `AssistDelayEvent` after `CreatureFamilyAssistanceDelay`. */
  private callAssistance(unit: CreatureUnit, victim: number, nowMs: number): void {
    if (unit.alreadyCalledAssistance || (unit.info.flagsExtra & CREATURE_FLAG_EXTRA_DONT_CALL_ASSISTANCE)) {
      return;
    }
    unit.alreadyCalledAssistance = true;
    const radius = this.rates.assistanceRadius;
    if (radius <= 0) {
      return;
    }
    const player = this.players.get(victim)?.player;
    if (!player) {
      return;
    }
    const pos = this.position(unit, nowMs);
    const assistants: number[] = [];
    for (const spawn of creaturesNear(this.spawns, { map: unit.info.map, x: pos.x, y: pos.y, z: pos.z }, radius)) {
      if (spawn.guid === unit.info.spawnGuid) {
        continue;
      }
      const other = this.infos.info(spawn.guid);
      if (!other || !this.canAssistTo(other, unit.info, player)) {
        continue;
      }
      const otherUnit = this.units.get(spawn.guid);
      const otherPos = otherUnit ? this.position(otherUnit, nowMs) : other.home;
      if (distanceSq(otherPos, pos) > radius * radius) {
        continue;
      }
      assistants.push(spawn.guid);
    }
    if (assistants.length > 0) {
      this.assists.push({ atMs: nowMs + this.rates.assistanceDelay, victim, assistants });
    }
  }

  /** `Creature::CanAssistTo(u, enemy, checkfaction = true)` */
  private canAssistTo(self: CreatureInfo, caller: CreatureInfo, enemy: CombatPlayer): boolean {
    const unit = this.units.get(self.spawnGuid);
    if (unit && (unit.deathState !== "alive" || unit.evading || unit.threat.size > 0)) {
      return false;
    }
    if (this.passive(self) || (self.flagsExtra & CREATURE_FLAG_EXTRA_CIVILIAN)) {
      return false;
    }
    if (self.unitFlags & (UNIT_FLAG_NON_ATTACKABLE | UNIT_FLAG_NOT_SELECTABLE)) {
      return false;
    }
    if (self.flagsExtra & CREATURE_FLAG_EXTRA_IGNORE_ALL_ASSISTANCE_CALLS) {
      return false;
    }
    if (self.factionTemplate !== caller.factionTemplate) {
      return false;
    }
    const template = this.factions.template(self.factionTemplate);
    if (!template || !respondsToCallForHelp(template)) {
      return false;
    }
    return this.factions.creatureToPlayer(self.factionTemplate, this.reactionPlayer(enemy)) <= REP_HOSTILE;
  }

  private runAssists(nowMs: number): void {
    for (let index = this.assists.length - 1; index >= 0; index--) {
      const event = this.assists[index]!;
      if (event.atMs > nowMs) {
        continue;
      }
      this.assists.splice(index, 1);
      const state = this.players.get(event.victim);
      if (!state || !state.player.alive()) {
        continue;
      }
      for (const spawnGuid of event.assistants) {
        const unit = this.liveUnit(spawnGuid);
        if (!unit || unit.deathState !== "alive" || unit.evading || unit.threat.size > 0) {
          continue;
        }
        unit.alreadyCalledAssistance = true;
        this.engagePlayer(unit, state.player, nowMs);
      }
    }
  }

  // ------------------------------------------------------------------ engagement

  /** `Unit::AtTargetAttacked` from a player swing: the creature and the player enter combat. */
  private atTargetAttacked(player: CombatPlayer, unit: CreatureUnit, nowMs: number): void {
    this.engagePlayer(unit, player, nowMs);
  }

  /** `Unit::EngageWithTarget` / `CreatureAI::AttackStart` for a creature. */
  private engagePlayer(unit: CreatureUnit, player: CombatPlayer, nowMs: number): void {
    if (unit.deathState !== "alive" || unit.evading) {
      return;
    }
    if (unit.info.flagsExtra & CREATURE_FLAG_EXTRA_CANNOT_ENTER_COMBAT) {
      return;
    }
    const fresh = unit.threat.size === 0;
    if (!unit.threat.has(player.guid)) {
      unit.threat.set(player.guid, 0);
    }
    if (fresh) {
      unit.lastLeashExtension = Math.floor(nowMs / 1000);
      if (!this.passive(unit.info)) {
        this.sendToViewers(unit, SMSG_AI_REACTION, aiReactionPacket(unit.info.guid, AI_REACTION_HOSTILE));
        this.callAssistance(unit, player.guid, nowMs);
      }
    }
    const state = this.players.get(player.guid);
    if (state) {
      this.refreshPlayerCombat(state);
    }
  }

  /** `CreatureAI::MoveInLineOfSight` → `AssistPlayerInCombatAgainst` / `CanStartAttack` for the creatures around a player. */
  private moveInLineOfSight(player: CombatPlayer, nowMs: number): void {
    if (!player.alive() || player.gameMaster()) {
      return;
    }
    const place = player.position();
    const nowSec = Math.floor(nowMs / 1000);
    const reaction = this.reactionPlayer(player);
    for (const spawn of creaturesNear(this.spawns, place, 45 * this.rates.aggro + 10)) {
      const info = this.infos.info(spawn.guid);
      if (!info || !this.canStartAttack(info, player, reaction, spawn)) {
        continue;
      }
      const unit = this.units.get(spawn.guid);
      if (unit && (unit.deathState !== "alive" || unit.evading || unit.threat.has(player.guid))) {
        continue;
      }
      if (unit && unit.threat.size > 0) {
        continue;
      }
      const pos = unit ? this.position(unit, nowMs) : info.home;
      if (Math.abs(pos.z - place.z) > CREATURE_Z_ATTACK_RANGE) {
        continue;
      }
      const range = aggroRange({ creatureLevel: info.level, playerLevel: player.level(), detectionRange: info.detectionRange, aggroRate: this.rates.aggro });
      if (distanceSq(pos, place) > range * range) {
        continue;
      }
      const live = this.liveUnit(spawn.guid)!;
      if (!this.canCreatureAttack(live, player, nowMs, nowSec)) {
        continue;
      }
      this.engagePlayer(live, player, nowMs);
    }
  }

  /** The template-level half of `Creature::CanStartAttack` plus `UpdateMoveInLineOfSightState`. */
  private canStartAttack(info: CreatureInfo, player: CombatPlayer, reaction: ReturnType<CombatWorld["reactionPlayer"]>, spawn: CreatureSpawn): boolean {
    if (spawn.map !== player.position().map || (spawn.phaseMask & 1) === 0 || (spawn.spawnMask & 1) === 0) {
      return false;
    }
    if (info.flagsExtra & (CREATURE_FLAG_EXTRA_CIVILIAN | CREATURE_FLAG_EXTRA_TRIGGER)) {
      return false;
    }
    if (info.type === CREATURE_TYPE_CRITTER || info.type === CREATURE_TYPE_NON_COMBAT_PET || info.type === CREATURE_TYPE_TOTEM) {
      return false;
    }
    if (this.passive(info) || info.aiName === "ReactorAI") {
      return false;
    }
    if (info.unitFlags & (UNIT_FLAG_IMMUNE_TO_PC | UNIT_FLAG_NON_ATTACKABLE | UNIT_FLAG_NOT_SELECTABLE)) {
      return false;
    }
    const template = this.factions.template(info.factionTemplate);
    if (!template || !hasHostility(template) || isNeutralToAll(template)) {
      return false;
    }
    return this.factions.creatureToPlayer(info.factionTemplate, reaction) <= REP_HOSTILE;
  }

  /** AIs that never fight back: `NullCreatureAI`, `PassiveAI`, `CritterAI`, `TotemAI`, and critters without an AI name. */
  private passive(info: CreatureInfo): boolean {
    if (info.aiName === "NullCreatureAI" || info.aiName === "PassiveAI" || info.aiName === "CritterAI" || info.aiName === "TotemAI") {
      return true;
    }
    return info.aiName === "" && (info.type === CREATURE_TYPE_CRITTER || info.type === CREATURE_TYPE_TOTEM);
  }

  private refreshPlayerCombat(state: PlayerState): void {
    let engaged = false;
    for (const unit of this.units.values()) {
      if (unit.deathState === "alive" && unit.threat.has(state.player.guid)) {
        engaged = true;
        break;
      }
    }
    if (engaged !== state.inCombat) {
      state.inCombat = engaged;
      state.player.setInCombat(engaged);
    }
  }

  // ------------------------------------------------------------------ units and views

  private liveUnit(spawnGuid: number): CreatureUnit | null {
    const existing = this.units.get(spawnGuid);
    if (existing) {
      return existing;
    }
    const info = this.infos.info(spawnGuid);
    if (!info) {
      return null;
    }
    const created = this.createUnit(info);
    this.units.set(spawnGuid, created);
    return created;
  }

  private createUnit(info: CreatureInfo): CreatureUnit {
    return {
      info,
      health: info.maxHealth,
      deathState: "alive",
      pos: { ...info.home },
      move: null,
      threat: new Map(),
      victim: null,
      attackTimer: 0,
      regenTimer: CREATURE_REGEN_INTERVAL,
      evading: false,
      lootRecipient: null,
      playerDamageReq: Math.trunc(info.maxHealth / 2),
      damagedByPlayer: false,
      loot: null,
      lootable: false,
      skinnable: false,
      corpseRemoveTime: 0,
      respawnTime: 0,
      respawnedTime: 0,
      lastLeashExtension: 0,
      splineId: 0,
      lastChaseMs: 0,
      lastFacingMs: 0,
      alreadyCalledAssistance: false,
      spell: null,
      taunts: [],
    };
  }

  /** Runtime state for a spawn, if it has any (tests and the session's loot checks). */
  creature(spawnGuid: number): Readonly<CreatureUnit> | null {
    return this.units.get(spawnGuid) ?? null;
  }

  private unitFlags(unit: CreatureUnit): number {
    let flags = unit.info.unitFlags | (unit.spell?.auraUnitFlags ?? 0);
    if (unit.deathState === "alive" && unit.threat.size > 0) {
      flags |= UNIT_FLAG_IN_COMBAT;
    }
    if (unit.skinnable) {
      flags |= UNIT_FLAG_SKINNABLE;
    }
    return flags >>> 0;
  }

  /**
   * `Unit::BuildValuesUpdate` patch of `UNIT_DYNAMIC_FLAGS` for one receiver.
   * A corpse is dead by `UNIT_FIELD_HEALTH` 0. `UNIT_DYNFLAG_DEAD` is only feign death (`HandleFeignDeath`):
   * the client clears its target and right-click attacks instead of looting.
   */
  private dynamicFlagsFor(unit: CreatureUnit, viewer: number): number {
    let flags = unit.info.dynamicFlags & ~(UNIT_DYNFLAG_TAPPED | UNIT_DYNFLAG_TAPPED_BY_PLAYER | UNIT_DYNFLAG_LOOTABLE);
    if (unit.lootable) {
      flags |= UNIT_DYNFLAG_LOOTABLE;
    }
    if (unit.lootRecipient !== null) {
      flags |= UNIT_DYNFLAG_TAPPED;
      if (unit.lootRecipient === viewer) {
        flags |= UNIT_DYNFLAG_TAPPED_BY_PLAYER;
      }
    }
    if (!this.isAllowedToLoot(unit, viewer)) {
      flags &= ~UNIT_DYNFLAG_LOOTABLE;
    }
    return flags >>> 0;
  }

  /** Health, flags, and this viewer's dynamic flags in one values update (`Unit::Kill`). */
  private corpseFields(unit: CreatureUnit, viewer: number): { index: number; value: number }[] {
    return [
      { index: UNIT_FIELD_HEALTH, value: unit.health },
      { index: UNIT_FIELD_FLAGS, value: this.unitFlags(unit) },
      { index: UNIT_NPC_FLAGS, value: unit.deathState === "alive" ? unit.info.npcFlags : 0 },
      { index: UNIT_FIELD_TARGET, value: 0 },
      { index: UNIT_FIELD_TARGET + 1, value: 0 },
      { index: UNIT_DYNAMIC_FLAGS, value: this.dynamicFlagsFor(unit, viewer) },
    ];
  }

  private sendCorpseUpdate(unit: CreatureUnit): void {
    for (const state of this.players.values()) {
      if (state.player.knows(unit.info.guid) || unit.lootRecipient === state.player.guid) {
        state.player.send(SMSG_UPDATE_OBJECT, unitValuesUpdate(unit.info.guid, this.corpseFields(unit, state.player.guid)));
      }
    }
  }

  private sendDynamicFlags(unit: CreatureUnit): void {
    for (const state of this.players.values()) {
      if (state.player.knows(unit.info.guid)) {
        state.player.send(
          SMSG_UPDATE_OBJECT,
          unitValuesUpdate(unit.info.guid, [{ index: UNIT_DYNAMIC_FLAGS, value: this.dynamicFlagsFor(unit, state.player.guid) }]),
        );
      }
    }
  }

  private refreshViewers(unit: CreatureUnit): void {
    for (const state of this.players.values()) {
      if (state.player.position().map === unit.info.map) {
        state.player.refreshSpawns();
      }
    }
  }

  /** `WorldObject::SendMessageToSet` from a creature. `also` gets it even before its client knows the creature. */
  private sendToViewers(unit: CreatureUnit, opcode: number, body: Uint8Array, also?: CombatPlayer): void {
    for (const state of this.players.values()) {
      if (state.player === also || state.player.knows(unit.info.guid)) {
        state.player.send(opcode, body);
      }
    }
  }

  private sendToSelfAndSet(player: CombatPlayer, opcode: number, body: Uint8Array): void {
    player.send(opcode, body);
    player.broadcast(opcode, body);
  }

  private reactionPlayer(player: CombatPlayer): { race: number; classId: number; factionTemplate: number; reputation: (faction: number) => PlayerReputation | null } {
    return { race: player.race(), classId: player.classId(), factionTemplate: player.factionTemplate(), reputation: player.reputation };
  }
}

/** `Unit::CalcAbsorbResist` for each melee sub-damage (`CalculateMeleeDamage`). */
function absorbMeleeDamages(attacker: SpellUnit, victim: SpellUnit, damages: [SubDamage, SubDamage]): void {
  for (const damage of damages) {
    if (damage.damage <= 0) continue;
    const info = { attacker, victim, damage: damage.damage, absorb: 0, resist: 0, schoolMask: damage.schoolMask, spell: null, damageType: DIRECT_DAMAGE };
    spellMath.calcAbsorbResist(info);
    damage.damage = info.damage;
    damage.absorb = info.absorb;
    damage.resist = info.resist;
  }
}

/** `DamageEffectType::DIRECT_DAMAGE` */
const DIRECT_DAMAGE = 0;

function emptyDamage(): SubDamage {
  return { schoolMask: 1, damage: 0, absorb: 0, resist: 0 };
}

/** The outcome switch of `Unit::CalculateMeleeDamage`. Mutates `damages`. */
export function applyOutcome(
  outcome: MeleeHitOutcome,
  damages: [SubDamage, SubDamage],
  cleanDamageIn: number,
  attackerLevel: number,
  victimLevel: number,
  blockValue: number,
  attType: number,
): { hitInfo: number; targetState: number; blocked: number; cleanDamage: number } {
  let hitInfo = attType === OFF_ATTACK ? HITINFO_OFFHAND : HITINFO_NORMALSWING;
  let targetState = VICTIMSTATE_INTACT;
  let cleanDamage = cleanDamageIn;
  let blocked = 0;
  switch (outcome) {
    case MELEE_HIT_EVADE:
      hitInfo |= HITINFO_MISS | HITINFO_SWINGNOHITSOUND;
      targetState = VICTIMSTATE_EVADES;
      damages[0].damage = 0;
      damages[1].damage = 0;
      return { hitInfo, targetState, blocked: 0, cleanDamage: 0 };
    case MELEE_HIT_MISS:
      hitInfo |= HITINFO_MISS;
      targetState = VICTIMSTATE_INTACT;
      damages[0].damage = 0;
      damages[1].damage = 0;
      cleanDamage = 0;
      break;
    case MELEE_HIT_NORMAL:
      targetState = VICTIMSTATE_HIT;
      break;
    case MELEE_HIT_CRIT:
      hitInfo |= HITINFO_CRITICALHIT;
      targetState = VICTIMSTATE_HIT;
      damages[0].damage *= 2;
      damages[1].damage *= 2;
      break;
    case MELEE_HIT_PARRY:
    case MELEE_HIT_DODGE:
      targetState = outcome === MELEE_HIT_PARRY ? VICTIMSTATE_PARRY : VICTIMSTATE_DODGE;
      cleanDamage = damages[0].damage + damages[1].damage;
      damages[0].damage = 0;
      damages[1].damage = 0;
      break;
    case MELEE_HIT_BLOCK: {
      targetState = VICTIMSTATE_HIT;
      hitInfo |= HITINFO_BLOCK;
      blocked = blockValue;
      let remaining = blocked;
      let fullMask = 0;
      for (let index = 0; index < 2; index++) {
        const damage = damages[index]!;
        if (remaining && remaining >= damage.damage) {
          fullMask |= 1 << index;
          remaining -= damage.damage;
          cleanDamage += damage.damage;
          damage.damage = 0;
        } else {
          cleanDamage += remaining;
          damage.damage -= remaining;
          remaining = 0;
        }
      }
      if (fullMask === 3) {
        targetState = VICTIMSTATE_BLOCKS;
        blocked -= remaining;
      }
      break;
    }
    case MELEE_HIT_GLANCING:
      hitInfo |= HITINFO_GLANCING;
      targetState = VICTIMSTATE_HIT;
      for (const damage of damages) {
        const reduced = glancingDamage(damage.damage, attackerLevel, victimLevel);
        cleanDamage += damage.damage - reduced;
        damage.damage = reduced;
      }
      break;
    case MELEE_HIT_CRUSHING:
      hitInfo |= HITINFO_CRUSHING;
      targetState = VICTIMSTATE_HIT;
      for (const damage of damages) {
        damage.damage += Math.trunc(damage.damage / 2);
      }
      break;
  }
  if (!(hitInfo & HITINFO_MISS)) {
    hitInfo |= HITINFO_AFFECTS_VICTIM;
  }
  damages[0].damage = Math.max(0, damages[0].damage);
  damages[1].damage = Math.max(0, damages[1].damage);
  return { hitInfo, targetState, blocked, cleanDamage: Math.max(0, cleanDamage) };
}

/** `Unit::DealMeleeDamage` parry haste on the victim's swing timer. */
export function parryHaste(timer: number, attackTime: number): number {
  const percent20 = attackTime * 0.2;
  const percent60 = 3 * percent20;
  if (timer > percent20 && timer <= percent60) {
    return Math.trunc(percent20);
  }
  if (timer > percent60) {
    return Math.trunc(timer - 2 * percent20);
  }
  return timer;
}

/** `ProcSkillsAndReactives`: which outcomes may raise weapon (attacker) or defense (victim) skill. */
function skillOutcome(outcome: MeleeHitOutcome, victim: boolean): boolean {
  switch (outcome) {
    case MELEE_HIT_NORMAL:
    case MELEE_HIT_GLANCING:
    case MELEE_HIT_CRUSHING:
    case MELEE_HIT_MISS:
    case MELEE_HIT_PARRY:
    case MELEE_HIT_DODGE:
      return true;
    case MELEE_HIT_BLOCK:
      return victim;
    default:
      return false;
  }
}

const shared = new WeakMap<SpawnIndex, CombatWorld>();

/** One `CombatWorld` per spawn index, so every session on the server shares creature state. */
export function combatWorldFor(world: WorldData, spawns: SpawnIndex, db: WorldTables | null, dbc: DbcStores | null): CombatWorld {
  const found = shared.get(spawns);
  if (found) {
    return found;
  }
  const created = new CombatWorld(world, spawns, db, dbc);
  shared.set(spawns, created);
  return created;
}
