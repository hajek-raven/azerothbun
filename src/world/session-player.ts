/**
 * `SessionPlayer`: the `Player` the chat and command code acts on, over the state `WorldSession` keeps for the
 * logged-in character. `CreatureFacade` is a selected creature (`Creature`) over the shared `CombatWorld`.
 */
import type { SpellUnit } from "../spells/unit.ts";
import { AURA_REMOVE_BY_DEFAULT } from "../spells/enums.ts";
import { SPELL_AURA_MOUNTED } from "../spells/defines.ts";
import { ByteWriter } from "../net/byte-buffer.ts";
import { executeStatementAsync } from "../database/database.ts";
import { CHAR_UPD_CHARACTER_POSITION } from "../gen/CharacterDatabase.gen.ts";
import { log } from "../log.ts";
import {
  OBJECT_FIELD_SCALE_X,
  PLAYER__FIELD_KNOWN_TITLES,
  PLAYER_BYTES_3,
  PLAYER_CHARACTER_POINTS1,
  PLAYER_CHARACTER_POINTS2,
  PLAYER_CHOSEN_TITLE,
  PLAYER_FIELD_ARENA_CURRENCY,
  PLAYER_FIELD_COINAGE,
  PLAYER_FIELD_HONOR_CURRENCY,
  PLAYER_FLAGS,
  UNIT_DYNAMIC_FLAGS,
  UNIT_FIELD_COMBATREACH,
  UNIT_FIELD_DISPLAYID,
  UNIT_FIELD_FACTIONTEMPLATE,
  UNIT_FIELD_FLAGS,
  UNIT_FIELD_FLAGS_2,
  UNIT_FIELD_HEALTH,
  UNIT_FIELD_MAXHEALTH,
  UNIT_FIELD_MOUNTDISPLAYID,
  UNIT_FIELD_NATIVEDISPLAYID,
  UNIT_NPC_FLAGS,
  PLAYER_XP,
  PLAYER_EXPLORED_ZONES_1,
  GAMEOBJECT_BYTES_1,
  PLAYER_END,
  PLAYER_FIELD_BUYBACK_PRICE_1,
  PLAYER_FIELD_BUYBACK_TIMESTAMP_1,
  PLAYER_FIELD_VENDORBUYBACK_SLOT_1,
  PLAYER_FIELD_BYTES,
  PLAYER_FIELD_KILLS,
  PLAYER_FIELD_LIFETIME_HONORABLE_KILLS,
  PLAYER_FIELD_TODAY_CONTRIBUTION,
  PLAYER_FIELD_YESTERDAY_CONTRIBUTION,
  UNIT_END,
  UNIT_FIELD_BYTES_0,
} from "../gen/UpdateFields.gen.ts";
import { unitValuesUpdate } from "../combat/packets.ts";
import { sWorldSessionMgr } from "../game/Server/WorldSessionMgr.ts";
import { SMSG_UPDATE_OBJECT } from "./packets.ts";
import { PLAYER_EXPLORED_ZONES_SIZE } from "./session.ts";
import {
  CHAT_MSG_EMOTE,
  CHAT_MSG_SAY,
  CHAT_MSG_WHISPER,
  CHAT_MSG_WHISPER_INFORM,
  CHAT_MSG_YELL,
  FACTION_FRIENDLY,
  LANG_ADDON,
  LANG_UNIVERSAL,
  SEC_PLAYER,
  TEAM_ALLIANCE,
} from "../shared/SharedDefines.ts";
import {
  CHAT_TAG_AFK,
  CHAT_TAG_COM,
  CHAT_TAG_DEV,
  CHAT_TAG_DND,
  CHAT_TAG_GM,
  CHEAT_WATERWALK,
  PLAYER_EXTRA_ACCEPT_WHISPERS,
  PLAYER_EXTRA_GM_CHAT,
  PLAYER_EXTRA_GM_INVISIBLE,
  PLAYER_EXTRA_GM_ON,
  PLAYER_EXTRA_GM_SPECTATOR,
  PLAYER_EXTRA_TAXICHEAT,
  PLAYER_FLAGS_AFK,
  PLAYER_FLAGS_COMMENTATOR2,
  PLAYER_FLAGS_DEVELOPER,
  PLAYER_FLAGS_DND,
  PLAYER_FLAGS_GHOST,
  PLAYER_FLAGS_GM,
  PLAYER_FLAGS_IS_OUT_OF_BOUNDS,
  PLAYER_FLAGS_RESTING,
} from "../game/Entities/Player/PlayerDefines.ts";
import { LANG_COMMAND_WHISPERON, LANG_PLAYER_AFK, LANG_PLAYER_DND } from "../game/Miscellaneous/Language.ts";
import { RBAC_PERM_TWO_SIDE_INTERACTION_CHAT } from "../game/Accounts/RBACDefines.ts";
import { isGMAccount, isPlayerAccount } from "../game/Accounts/AccountMgr.ts";
import type { CommandCreature, CommandGameObject, CommandUnit, Player, WorldPosition } from "../game/Entities/Player/Player.ts";
import { BuildChatPacketFor, ChatHandler, type ChatParty } from "../game/Chat/Chat.ts";
import { ObjectAccessor } from "../game/Globals/ObjectAccessor.ts";
import { ServerConfig } from "../game/world/world-config.ts";
import { sWorld } from "../game/world/world.ts";
import { sCharacterCache } from "../game/Cache/CharacterCache.ts";
import { isValidMapCoord } from "../game/Maps/MapMgr.ts";
import { highGuidIsCreature, spawnGuidOf } from "../combat/combat-world.ts";
import { RACE_FACTION_TEMPLATE } from "../combat/faction.ts";
import { applyResurrect, buildDeathReleaseLoc, deleteCorpse, SMSG_DEATH_RELEASE_LOC } from "../characters/death.ts";
import { getClosestGraveyard, graveyardTeleport, teamIdFromRace } from "../characters/graveyard.ts";
import { giveLevel, initTalentForLevel } from "../characters/level-up.ts";
import { canStoreNewItem, EQUIP_ERR_OK, getItemCount, NULL_BAG, NULL_SLOT } from "../items/bags.ts";
import { lookupTemplate } from "./bags-play.ts";
import { storeNewItem } from "./loot-play.ts";
import { creatureModel } from "../data/world.ts";
import { creatureGuid, gameObjectGuid } from "./spawn.ts";
import { visibilityDistance } from "./visibility.ts";
import { encodeServerPacket } from "./packets.ts";
import { fieldUpdateBlock, packedGuid, powerType, raceAppearance } from "./update-object.ts";
import type { WorldSession } from "./session.ts";
import { SMSG_LEARNED_SPELL } from "../spells/packets.ts";
import { GetPlayerSetting, UpdatePlayerSetting, type PlayerSettingMap } from "../game/Entities/Player/PlayerSettings.ts";
import { durabilityRepairAllFree } from "./vendor-play.ts";
import { BUYBACK_SLOT_START, getItemFromBuyBackSlot, removeItemFromBuyBackSlot } from "../items/vendor.ts";
import { getSkillRaceClassInfo, playerCreateSkillsFor } from "../characters/skills.ts";
import { playercreateinfo_spell_custom } from "../database/schema/world.ts";
import { sObjectMgr } from "../game/Globals/ObjectMgr.ts";
import { sSpellMgr } from "../game/Spells/SpellMgr.ts";
import { SPELL_EFFECT_LEARN_SPELL, SPELL_EFFECT_TRADE_SKILL } from "../spells/defines.ts";
import type { QuestTemplate } from "./quests.ts";
import { sAreaTableStore, sFactionStore } from "../game/DataStores/DBCStores.ts";
import { isBelowMap } from "./session-terrain.ts";

/** @ac shared/DataStores/DBCEnums.h AREA_FLAG_NEED_FLY (respawn alive at the graveyard without corpse) */
const AREA_FLAG_NEED_FLY = 0x00001000;
import type { FactionEntry } from "../gen/DBCStructure.gen.ts";

const SMSG_MOVE_SET_CAN_FLY = 0x343;
const SMSG_MOVE_UNSET_CAN_FLY = 0x344;
const SMSG_MOVE_WATER_WALK = 0x0de;
const SMSG_MOVE_LAND_WALK = 0x0df;
const SMSG_REMOVED_SPELL = 0x203;
const SMSG_CLEAR_COOLDOWN = 0x1de;
const SMSG_TITLE_EARNED = 0x373;
const UNIT_FLAG2_ALLOW_CHEAT_SPELLS = 0x00040000;
const UNIT_FLAG_NON_ATTACKABLE = 0x00000002;
const UNIT_FLAG_MOUNT = 0x08000000;
const SMSG_TALENTS_INFO = 0x4c0;
const SMSG_PVP_CREDIT = 0x28c;
const INVENTORY_SLOT_BAG_0 = 255;
const INVENTORY_SLOT_BAG_START = 19;
const INVENTORY_SLOT_BAG_END = 23;
const BANK_SLOT_BAG_START = 67;
const BANK_SLOT_BAG_END = 74;
const DAY = 86400;
/** `SPELL_AURA_PLAYER_INACTIVE` (the "Inactive" spell) */
const SPELL_AURA_PLAYER_INACTIVE = 43681;
const SPELL_AURA_MOD_HONOR_GAIN_PCT = 229;
const SPELL_AURA_NO_PVP_CREDIT = 227;

/** @ac game/Miscellaneous/Formulas.h Acore::XP::GetGrayLevel */
function getGrayLevel(pl_level: number): number {
  if (pl_level <= 5) return 0;
  if (pl_level <= 39) return pl_level - 5 - Math.trunc(pl_level / 10);
  if (pl_level <= 59) return pl_level - 1 - Math.trunc(pl_level / 5);
  return pl_level - 9;
}
/** `ReputationMgr::Reputation_Cap` / `Reputation_Bottom` */
const REPUTATION_CAP = 42999;
const REPUTATION_BOTTOM = -42000;

/** @ac game/Reputation/ReputationMgr.cpp ReputationMgr::GetBaseReputation */
export function getBaseReputation(factionEntry: FactionEntry, race: number, playerClass: number): number {
  const raceMask = 1 << (race - 1);
  const classMask = 1 << (playerClass - 1);
  for (let i = 0; i < 4; i++) {
    if (
      (factionEntry.BaseRepRaceMask[i]! & raceMask || (factionEntry.BaseRepRaceMask[i] === 0 && factionEntry.BaseRepClassMask[i] !== 0)) &&
      (factionEntry.BaseRepClassMask[i]! & classMask || factionEntry.BaseRepClassMask[i] === 0)
    ) {
      return factionEntry.BaseRepValue[i]!;
    }
  }
  // in faction.dbc exist factions with (RepListId >=0, listed in character reputation list) with all BaseRepRaceMask[i] == 0
  return 0;
}
const DEFAULT_PLAYER_COMBAT_REACH = 1.5;
const MAX_MONEY_AMOUNT = 0x7fffffff;
const CONFIG_MAX_HONOR_POINTS = ServerConfig.CONFIG_MAX_HONOR_POINTS;
const CONFIG_MAX_ARENA_POINTS = ServerConfig.CONFIG_MAX_ARENA_POINTS;

/** `Player` state the character row does not hold (`_activeCheats`, recall position, whisper white list, …). */
export class PlayerCommandState {
  activeCheats = 0;
  recall: WorldPosition | null = null;
  readonly whisperWhiteList = new Set<bigint>();
  autoReplyMsg = "";
  canFly = false;
  waterWalking = false;
  loginTime = Math.floor(Date.now() / 1000);
  chatFlood = { time: 0, count: 0 };
  /** When the character was last saved (`Player::m_nextSave` counts down from `CONFIG_INTERVAL_SAVE` after a save). */
  lastSaveMs = Date.now();
  /** `WorldObject::m_phaseMask` set by `.modify phase` (`PHASEMASK_NORMAL` until then). */
  phaseMask = 1;
  /** `Player::m_lastHonorUpdateTime` (the logout time at load) */
  lastHonorUpdateTime = 0;
  /** `Player::m_charSettingsMap` */
  charSettingsMap: PlayerSettingMap = new Map();
}

export class SessionPlayer implements Player {
  constructor(readonly session: WorldSession) {}

  private get character() {
    const character = this.session.character;
    if (!character) throw new Error("SessionPlayer used without a character in world");
    return character;
  }

  private get state(): PlayerCommandState {
    return this.session.commandState;
  }

  private setPlayerFlag(flag: number, on: boolean): void {
    const character = this.character;
    character.playerFlags = (on ? character.playerFlags | flag : character.playerFlags & ~flag) >>> 0;
    this.session.stats?.setUInt32(PLAYER_FLAGS, character.playerFlags);
  }

  /** `Player::SetPlayerFlag` */
  setPlayerFlagOn(flag: number): void {
    this.setPlayerFlag(flag, true);
  }

  /** `Player::RemovePlayerFlag` */
  removePlayerFlag(flag: number): void {
    this.setPlayerFlag(flag, false);
  }

  /** `Player::SetRestFlag` / `RemoveRestFlag`: `PLAYER_FLAGS_RESTING` follows the rest flag mask. */
  setRestingFlag(resting: boolean): void {
    this.setPlayerFlag(PLAYER_FLAGS_RESTING, resting);
  }

  private hasPlayerFlag(flag: number): boolean {
    return (this.character.playerFlags & flag) !== 0;
  }

  private setExtraFlag(flag: number, on: boolean): void {
    const character = this.character;
    character.extra_flags = on ? character.extra_flags | flag : character.extra_flags & ~flag;
  }

  private hasExtraFlag(flag: number): boolean {
    return (this.character.extra_flags & flag) !== 0;
  }

  private sendSelf(opcode: number, body: Uint8Array): void {
    this.session.sendPacket(opcode, body);
  }

  /** @ac game/Entities/Player/Player.cpp Player::SendMessageToSet */
  sendMessageToSet(opcode: number, body: Uint8Array, self: boolean): void {
    if (self) this.sendSelf(opcode, body);
    this.session.players.sendInRange(this.character.guid, visibilityDistance(this.getMapId()), opcode, body);
  }

  // ------------------------------------------------------------------ identity

  getSession(): WorldSession {
    return this.session;
  }

  getName(): string {
    return this.character.name;
  }

  /** @ac game/Entities/Object/Object.h WorldObject::SetName */
  setName(name: string): void {
    this.character.name = name;
  }

  getGUIDLow(): number {
    return this.character.guid;
  }

  getGUID(): bigint {
    return BigInt(this.character.guid);
  }

  getEntry(): number {
    return 0;
  }

  isPlayer(): boolean {
    return true;
  }

  isCreature(): boolean {
    return false;
  }

  isPet(): boolean {
    return false;
  }

  toPlayer(): Player {
    return this;
  }

  isInWorld(): boolean {
    return this.session.character !== null && this.session.pendingTeleport?.far !== true;
  }

  getRace(): number {
    return this.character.race;
  }

  getClass(): number {
    return this.character.class;
  }

  getGender(): number {
    return this.character.gender;
  }

  /** @ac game/Entities/Player/Player.h Player::GetTeamId */
  getTeamId(): number {
    return teamIdFromRace(this.character.race);
  }

  getLevel(): number {
    return this.character.level;
  }

  getMapId(): number {
    return this.character.map;
  }

  getZoneId(): number {
    return this.character.zone;
  }

  /** The area `Player::UpdateArea` last saw (`m_areaUpdateId`), the zone until the first update. */
  getAreaId(): number {
    return this.session.area?.areaUpdateId || this.character.zone;
  }

  getInstanceId(): number {
    return 0;
  }

  getPositionX(): number {
    return this.character.position_x;
  }

  getPositionY(): number {
    return this.character.position_y;
  }

  getPositionZ(): number {
    return this.character.position_z;
  }

  getOrientation(): number {
    return this.character.orientation;
  }

  /** The phase mask (`PHASEMASK_NORMAL` unless a command set it); a GM in GM mode is in every phase (`PHASEMASK_ANYWHERE`). */
  getPhaseMask(): number {
    return this.isGameMaster() ? 0xffffffff : this.state.phaseMask;
  }

  /** @ac game/Entities/Unit/Unit.cpp Unit::SetPhaseMask */
  setPhaseMask(newPhaseMask: number, _update: boolean): void {
    this.state.phaseMask = newPhaseMask >>> 0;
    this.updateObjectVisibility();
  }

  /** `Object::GetValuesCount` */
  getValuesCount(): number {
    return PLAYER_END;
  }

  getTotalPlayedTime(): number {
    return this.character.totaltime + (Math.floor(Date.now() / 1000) - this.state.loginTime);
  }

  getLevelPlayedTime(): number {
    return this.character.leveltime + (Math.floor(Date.now() / 1000) - this.state.loginTime);
  }

  getLoginTime(): number {
    return this.state.loginTime;
  }

  getXP(): number {
    return this.session.stats?.getUInt32(PLAYER_XP) ?? this.character.xp;
  }

  chatParty(): ChatParty {
    return {
      guid: this.getGUID(),
      name: this.getName(),
      chatTag: this.getChatTag(),
      gmMessage: false,
      isPlayer: true,
    };
  }

  /** @ac game/Entities/Player/Player.cpp Player::GetChatTag */
  getChatTag(): number {
    let tag = 0;
    if (this.isGMChat()) tag |= CHAT_TAG_GM;
    if (this.isDND()) tag |= CHAT_TAG_DND;
    if (this.isAFK()) tag |= CHAT_TAG_AFK;
    if (this.isCommentator()) tag |= CHAT_TAG_COM;
    if (this.isDeveloper()) tag |= CHAT_TAG_DEV;
    return tag;
  }

  // ------------------------------------------------------------------ unit fields

  isAlive(): boolean {
    return this.session.deathState === "alive" && this.session.health > 0;
  }

  isInCombat(): boolean {
    return this.session.inCombat;
  }

  getHealth(): number {
    return this.session.health;
  }

  getMaxHealth(): number {
    return this.session.maxHealth;
  }

  setHealth(value: number): void {
    this.session.health = value;
  }

  setMaxHealth(value: number): void {
    this.session.stats?.setMaxHealth(value);
  }

  getPower(power: number): number {
    return this.session.stats?.power(power) ?? 0;
  }

  getMaxPower(power: number): number {
    return this.session.stats?.maxPower(power) ?? 0;
  }

  setPower(power: number, value: number): void {
    this.session.stats?.setPower(power, value);
  }

  setMaxPower(power: number, value: number): void {
    this.session.stats?.setMaxPower(power, value);
  }

  getUInt32Value(index: number): number {
    return this.session.stats?.getUInt32(index) ?? 0;
  }

  setUInt32Value(index: number, value: number): void {
    this.session.stats?.setUInt32(index, value);
    // `Player::_SaveCharacter` writes the known title fields to `characters.knownTitles`.
    if (index >= PLAYER__FIELD_KNOWN_TITLES && index < PLAYER__FIELD_KNOWN_TITLES + 6) {
      const titles = this.knownTitles();
      titles[index - PLAYER__FIELD_KNOWN_TITLES] = value >>> 0;
      this.character.knownTitles = `${titles.join(" ")} `;
    }
    // `Player::_SaveCharacter` writes the honor fields to `todayHonorPoints` .. `yesterdayKills`.
    const character = this.character;
    if (index === PLAYER_FIELD_TODAY_CONTRIBUTION) character.todayHonorPoints = value >>> 0;
    else if (index === PLAYER_FIELD_YESTERDAY_CONTRIBUTION) character.yesterdayHonorPoints = value >>> 0;
    else if (index === PLAYER_FIELD_LIFETIME_HONORABLE_KILLS) character.totalKills = value >>> 0;
    else if (index === PLAYER_FIELD_KILLS) {
      character.todayKills = value & 0xffff;
      character.yesterdayKills = (value >>> 16) & 0xffff;
    }
    // `Player::_SaveCharacter` writes the explored zone fields to `characters.exploredZones`.
    if (index >= PLAYER_EXPLORED_ZONES_1 && index < PLAYER_EXPLORED_ZONES_1 + PLAYER_EXPLORED_ZONES_SIZE) {
      const fields = Array.from({ length: PLAYER_EXPLORED_ZONES_SIZE }, (_, i) => this.getUInt32Value(PLAYER_EXPLORED_ZONES_1 + i));
      this.character.exploredZones = `${fields.join(" ")} `;
    }
  }

  getFaction(): number {
    return this.getUInt32Value(UNIT_FIELD_FACTIONTEMPLATE) || (RACE_FACTION_TEMPLATE.get(this.character.race) ?? 0);
  }

  setFaction(faction: number): void {
    this.setUInt32Value(UNIT_FIELD_FACTIONTEMPLATE, faction);
  }

  /** @ac game/Entities/Player/Player.cpp Player::SetFactionForRace */
  setFactionForRace(): void {
    this.setFaction(raceAppearance(this.character.race, this.character.gender).faction);
  }

  getDisplayId(): number {
    return this.getUInt32Value(UNIT_FIELD_DISPLAYID);
  }

  getNativeDisplayId(): number {
    return this.getUInt32Value(UNIT_FIELD_NATIVEDISPLAYID);
  }

  setDisplayId(displayId: number): void {
    this.setUInt32Value(UNIT_FIELD_DISPLAYID, displayId);
  }

  /** @ac game/Entities/Unit/Unit.cpp Unit::DeMorph */
  deMorph(): void {
    this.setDisplayId(this.getNativeDisplayId());
  }

  /** @ac game/Entities/Unit/Unit.cpp Unit::Mount */
  mount(mount: number): void {
    if (mount) this.setUInt32Value(UNIT_FIELD_MOUNTDISPLAYID, mount);
    this.setUInt32Value(UNIT_FIELD_FLAGS, (this.getUInt32Value(UNIT_FIELD_FLAGS) | UNIT_FLAG_MOUNT) >>> 0);
  }

  /** `.modify gender`: `UNIT_FIELD_BYTES_0` byte 2, `PLAYER_BYTES_3` byte 0, then `Player::InitDisplayIds`. */
  setGender(gender: number): void {
    const character = this.character;
    character.gender = gender;
    const bytes0 = this.getUInt32Value(UNIT_FIELD_BYTES_0) || (character.race | (character.class << 8) | (powerType(character.class) << 24));
    this.setUInt32Value(UNIT_FIELD_BYTES_0, ((bytes0 & 0xff00ffff) | ((gender & 0xff) << 16)) >>> 0);
    const bytes3 = this.getUInt32Value(PLAYER_BYTES_3);
    this.setUInt32Value(PLAYER_BYTES_3, ((bytes3 & 0xffff0000) | ((character.drunk & 0xff) << 8) | (gender & 0xff)) >>> 0);
    // Player::InitDisplayIds
    const display = raceAppearance(character.race, gender).display;
    this.setUInt32Value(UNIT_FIELD_DISPLAYID, display);
    this.setUInt32Value(UNIT_FIELD_NATIVEDISPLAYID, display);
  }

  getObjectScale(): number {
    return this.session.stats?.getFloat(OBJECT_FIELD_SCALE_X) ?? 1;
  }

  setObjectScale(scale: number): void {
    this.session.stats?.setFloat(OBJECT_FIELD_SCALE_X, scale);
    this.session.stats?.setFloat(UNIT_FIELD_COMBATREACH, DEFAULT_PLAYER_COMBAT_REACH * scale);
  }

  getUnitFlags(): number {
    return this.getUInt32Value(UNIT_FIELD_FLAGS);
  }

  replaceAllUnitFlags(flags: number): void {
    this.setUInt32Value(UNIT_FIELD_FLAGS, flags);
  }

  getNpcFlags(): number {
    return this.getUInt32Value(UNIT_NPC_FLAGS);
  }

  replaceAllNpcFlags(flags: number): void {
    this.setUInt32Value(UNIT_NPC_FLAGS, flags);
  }

  getDynamicFlags(): number {
    return this.getUInt32Value(UNIT_DYNAMIC_FLAGS);
  }

  replaceAllDynamicFlags(flags: number): void {
    this.setUInt32Value(UNIT_DYNAMIC_FLAGS, flags);
  }

  getSpeedRate(moveType: number): number {
    return this.session.unit?.speedRate[moveType] ?? 1;
  }

  /** @ac game/Entities/Unit/Unit.cpp Unit::SetSpeedRate (the forced speed change goes to the client) */
  setSpeedRate(moveType: number, rate: number): void {
    this.session.unit?.setSpeedRate(moveType, rate);
  }

  spellUnit(): SpellUnit | null {
    return this.session.unit;
  }

  /** @ac game/Entities/Unit/Unit.cpp Unit::Kill (the victim is this player) */
  kill(_killer: Player): void {
    if (!this.isAlive()) return;
    this.session.killPlayer();
  }

  /** @ac game/Entities/Unit/Unit.cpp Unit::DealDamage (the victim is this player) */
  dealDamage(_attacker: Player, damage: number): void {
    const died = this.session.takeCombatDamage(damage);
    if (died) this.session.combat?.playerDied(this.character.guid);
  }

  /** @ac game/Entities/Unit/Unit.cpp Unit::CombatStop */
  combatStop(): void {
    this.session.combat?.attackStop(this.character.guid);
    this.session.combat?.playerDied(this.character.guid);
  }

  // ------------------------------------------------------------------ selection

  getTarget(): bigint {
    return this.session.selection;
  }

  /** @ac game/Entities/Player/Player.cpp Player::GetSelectedPlayer */
  getSelectedPlayer(): Player | null {
    const selectionGUID = this.getTarget();
    return selectionGUID ? ObjectAccessor.FindConnectedPlayer(selectionGUID) : null;
  }

  /** @ac game/Entities/Player/Player.cpp Player::GetSelectedUnit */
  getSelectedUnit(): CommandUnit | null {
    const selection = this.getTarget();
    if (!selection) return null;
    if (highGuidIsCreature(selection)) return this.getCreatureBySpawnId(spawnGuidOf(selection));
    const player = ObjectAccessor.FindPlayer(selection);
    return player && player.getMapId() === this.getMapId() ? player : null;
  }

  /** @ac game/Entities/Player/Player.cpp Player::IsVisibleGloballyFor */
  isVisibleGloballyFor(u: Player): boolean {
    if (u === this) return true;
    if (this.isGMVisible()) return true;
    if (!isPlayerAccount(u.getSession().getSecurity())) return this.session.getSecurity() <= u.getSession().getSecurity();
    return false;
  }

  findNearestGameObject(range: number, goType?: number): CommandGameObject | null {
    const world = this.session.world;
    if (!world) return null;
    let best: CommandGameObject | null = null;
    let bestDist = range;
    for (const spawn of world.gameObjects(this.getMapId())) {
      const template = world.gameObjectTemplate(spawn.entry);
      if (!template || (goType !== undefined && template.type !== goType)) continue;
      const dist = Math.hypot(spawn.x - this.getPositionX(), spawn.y - this.getPositionY(), spawn.z - this.getPositionZ());
      if (dist <= bestDist) {
        bestDist = dist;
        best = new GameObjectFacade(this.session, spawn.guid);
      }
    }
    return best;
  }

  getCreatureBySpawnId(spawnId: number): CommandCreature | null {
    const spawn = this.session.world?.creatureSpawn(spawnId);
    if (!spawn || spawn.map !== this.getMapId() || !this.session.combat) return null;
    return new CreatureFacade(this.session, spawnId);
  }

  getGameObjectBySpawnId(spawnId: number): CommandGameObject | null {
    const spawn = this.session.world?.gameObjectSpawn(spawnId);
    if (!spawn || spawn.map !== this.getMapId()) return null;
    return new GameObjectFacade(this.session, spawnId);
  }

  getMapCreatures(): CommandCreature[] {
    const world = this.session.world;
    if (!world || !this.session.combat) return [];
    return world.creatures(this.getMapId()).map((spawn) => new CreatureFacade(this.session, spawn.guid));
  }

  getDistance(other: { getPositionX(): number; getPositionY(): number; getPositionZ(): number }): number {
    return Math.hypot(other.getPositionX() - this.getPositionX(), other.getPositionY() - this.getPositionY(), other.getPositionZ() - this.getPositionZ());
  }

  // ------------------------------------------------------------------ GM state

  isGameMaster(): boolean {
    return this.hasExtraFlag(PLAYER_EXTRA_GM_ON);
  }

  /** @ac game/Entities/Player/Player.cpp Player::SetGameMaster */
  setGameMaster(on: boolean): void {
    const stats = this.session.stats;
    if (on) {
      this.setExtraFlag(PLAYER_EXTRA_GM_ON, true);
      if (isGMAccount(this.session.getSecurity())) this.setFaction(FACTION_FRIENDLY);
      this.setPlayerFlag(PLAYER_FLAGS_GM, true);
      stats?.setFlag(UNIT_FIELD_FLAGS_2, UNIT_FLAG2_ALLOW_CHEAT_SPELLS, true);
      this.session.combat?.attackStop(this.character.guid);
    } else {
      this.setExtraFlag(PLAYER_EXTRA_GM_ON, false);
      this.setFactionForRace();
      this.setPlayerFlag(PLAYER_FLAGS_GM, false);
      stats?.setFlag(UNIT_FIELD_FLAGS_2, UNIT_FLAG2_ALLOW_CHEAT_SPELLS, false);
    }
    this.updateObjectVisibility();
  }

  isGMChat(): boolean {
    return this.hasExtraFlag(PLAYER_EXTRA_GM_CHAT);
  }

  setGMChat(on: boolean): void {
    this.setExtraFlag(PLAYER_EXTRA_GM_CHAT, on);
  }

  isGMVisible(): boolean {
    return !this.hasExtraFlag(PLAYER_EXTRA_GM_INVISIBLE);
  }

  /** @ac game/Entities/Player/Player.cpp Player::SetGMVisible */
  setGMVisible(on: boolean): void {
    const VISUAL_AURA = 37800;
    if (on) {
      this.removeAurasDueToSpell(VISUAL_AURA);
      this.setExtraFlag(PLAYER_EXTRA_GM_INVISIBLE, false);
      this.session.combat?.attackStop(this.character.guid);
    } else {
      this.session.unit?.addAura(VISUAL_AURA, this.session.unit);
      this.setExtraFlag(PLAYER_EXTRA_GM_INVISIBLE, true);
    }
  }

  /** `SERVERSIDE_VISIBILITY_GM` value of this player (0 = seen by everyone). */
  gmVisibilityLevel(): number {
    return this.isGMVisible() ? SEC_PLAYER : this.session.getSecurity();
  }

  /** `SERVERSIDE_VISIBILITY_GM` detection of this player (its security while in GM mode). */
  gmDetectLevel(): number {
    return this.isGameMaster() ? this.session.getSecurity() : SEC_PLAYER;
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::UpdateObjectVisibility */
  updateObjectVisibility(): void {
    this.session.refreshVisibility();
  }

  isGMSpectator(): boolean {
    return this.hasExtraFlag(PLAYER_EXTRA_GM_SPECTATOR);
  }

  setGMSpectator(on: boolean): void {
    this.setExtraFlag(PLAYER_EXTRA_GM_SPECTATOR, on);
  }

  isAcceptWhispers(): boolean {
    return this.hasExtraFlag(PLAYER_EXTRA_ACCEPT_WHISPERS);
  }

  setAcceptWhispers(on: boolean): void {
    this.setExtraFlag(PLAYER_EXTRA_ACCEPT_WHISPERS, on);
  }

  isDeveloper(): boolean {
    return this.hasPlayerFlag(PLAYER_FLAGS_DEVELOPER);
  }

  setDeveloper(on: boolean): void {
    this.setPlayerFlag(PLAYER_FLAGS_DEVELOPER, on);
  }

  isCommentator(): boolean {
    return this.hasPlayerFlag(PLAYER_FLAGS_COMMENTATOR2);
  }

  setCommentator(on: boolean): void {
    this.setPlayerFlag(PLAYER_FLAGS_COMMENTATOR2, on);
  }

  /** @ac game/Entities/Player/Player.h Player::SetBeastMaster */
  setBeastMaster(on: boolean): void {
    this.session.stats?.setFlag(UNIT_FIELD_FLAGS, UNIT_FLAG_NON_ATTACKABLE, on);
  }

  isTaxiCheater(): boolean {
    return this.hasExtraFlag(PLAYER_EXTRA_TAXICHEAT);
  }

  setTaxiCheater(on: boolean): void {
    this.setExtraFlag(PLAYER_EXTRA_TAXICHEAT, on);
  }

  getCommandStatus(command: number): boolean {
    return (this.state.activeCheats & command) !== 0;
  }

  setCommandStatusOn(command: number): void {
    this.state.activeCheats |= command;
  }

  setCommandStatusOff(command: number): void {
    this.state.activeCheats &= ~command;
  }

  canFly(): boolean {
    return this.state.canFly;
  }

  /** @ac game/Entities/Player/Player.cpp Player::SetCanFly (`SMSG_MOVE_SET_CAN_FLY` / `UNSET`) */
  setCanFly(on: boolean): void {
    this.state.canFly = on;
    const body = new ByteWriter().writeBytes(packedGuid(this.getGUID())).writeU32(0).toUint8Array();
    this.sendSelf(on ? SMSG_MOVE_SET_CAN_FLY : SMSG_MOVE_UNSET_CAN_FLY, body);
  }

  /** @ac game/Entities/Player/Player.cpp Player::SetWaterWalking (`SMSG_MOVE_WATER_WALK` / `LAND_WALK`) */
  setWaterWalking(on: boolean): void {
    if (!on && this.getCommandStatus(CHEAT_WATERWALK)) return;
    this.state.waterWalking = on;
    const body = new ByteWriter().writeBytes(packedGuid(this.getGUID())).writeU32(0).toUint8Array();
    this.sendSelf(on ? SMSG_MOVE_WATER_WALK : SMSG_MOVE_LAND_WALK, body);
  }

  getExtraFlags(): number {
    return this.character.extra_flags;
  }

  // ------------------------------------------------------------------ chat

  isAFK(): boolean {
    return this.hasPlayerFlag(PLAYER_FLAGS_AFK);
  }

  isDND(): boolean {
    return this.hasPlayerFlag(PLAYER_FLAGS_DND);
  }

  /** @ac game/Entities/Player/Player.cpp Player::ToggleAFK */
  toggleAFK(): void {
    this.setPlayerFlag(PLAYER_FLAGS_AFK, !this.isAFK());
  }

  /** @ac game/Entities/Player/Player.cpp Player::ToggleDND */
  toggleDND(): void {
    this.setPlayerFlag(PLAYER_FLAGS_DND, !this.isDND());
  }

  getAutoReplyMsg(): string {
    return this.state.autoReplyMsg;
  }

  setAutoReplyMsg(msg: string): void {
    this.state.autoReplyMsg = msg;
  }

  /** @ac game/Entities/Player/PlayerMisc.cpp Player::CanSpeak */
  canSpeak(): boolean {
    return this.session.muteTime <= Math.floor(Date.now() / 1000);
  }

  addWhisperWhiteList(guid: bigint): void {
    this.state.whisperWhiteList.add(guid);
  }

  isInWhisperWhiteList(guid: bigint): boolean {
    return this.state.whisperWhiteList.has(guid);
  }

  removeFromWhisperWhiteList(guid: bigint): void {
    this.state.whisperWhiteList.delete(guid);
  }

  clearWhisperWhiteList(): void {
    this.state.whisperWhiteList.clear();
  }

  /** @ac game/Entities/Player/Player.cpp Player::Say */
  say(text: string, language: number): void {
    const packet = BuildChatPacketFor(CHAT_MSG_SAY, language, this.chatPartyForSend(), this.chatPartyForSend(), text);
    this.sendSelf(packet.opcode, packet.body);
    this.session.players.sendInRange(this.character.guid, sWorld().getFloatConfig(ServerConfig.CONFIG_LISTEN_RANGE_SAY), packet.opcode, packet.body);
  }

  /** @ac game/Entities/Player/Player.cpp Player::Yell */
  yell(text: string, language: number): void {
    const packet = BuildChatPacketFor(CHAT_MSG_YELL, language, this.chatPartyForSend(), this.chatPartyForSend(), text);
    this.sendSelf(packet.opcode, packet.body);
    this.session.players.sendInRange(this.character.guid, sWorld().getFloatConfig(ServerConfig.CONFIG_LISTEN_RANGE_YELL), packet.opcode, packet.body);
  }

  /** @ac game/Entities/Player/Player.cpp Player::TextEmote */
  textEmote(text: string): void {
    const self = this.chatPartyForSend();
    const packet = BuildChatPacketFor(CHAT_MSG_EMOTE, LANG_UNIVERSAL, self, self, text);
    this.sendSelf(packet.opcode, packet.body);
    const range = sWorld().getFloatConfig(ServerConfig.CONFIG_LISTEN_RANGE_TEXTEMOTE);
    if (this.session.hasPermission(RBAC_PERM_TWO_SIDE_INTERACTION_CHAT)) {
      this.session.players.sendInRange(this.character.guid, range, packet.opcode, packet.body);
      return;
    }
    const team = this.getTeamId();
    const sameTeam = (guid: number): boolean => teamIdFromRace(this.session.players.get(guid)?.character().race ?? 0) === team;
    this.session.players.sendInRange(this.character.guid, range, packet.opcode, packet.body, (other) => sameTeam(other.guid));
    const empty = BuildChatPacketFor(CHAT_MSG_EMOTE, LANG_UNIVERSAL, self, self, "");
    this.session.players.sendInRange(this.character.guid, range, empty.opcode, empty.body, (other) => !sameTeam(other.guid));
  }

  /** @ac game/Entities/Player/Player.cpp Player::Whisper */
  whisper(text: string, languageIn: number, target: Player): void {
    const isAddonMessage = languageIn >>> 0 === LANG_ADDON >>> 0;
    const language = isAddonMessage ? languageIn : LANG_UNIVERSAL;
    const packet = BuildChatPacketFor(CHAT_MSG_WHISPER, language, this.chatPartyForSend(), this.chatPartyForSend(), text);
    target.getSession().sendPacket(packet.opcode, packet.body);
    if (isAddonMessage) return;
    const inform = BuildChatPacketFor(CHAT_MSG_WHISPER_INFORM, language, target.chatParty(), target.chatParty(), text);
    this.sendSelf(inform.opcode, inform.body);
    if (!this.isAcceptWhispers() && !this.isGameMaster() && !target.isGameMaster()) {
      this.setAcceptWhispers(true);
      new ChatHandler(this.session).sendSysMessage(LANG_COMMAND_WHISPERON);
    }
    if (target.isAFK()) new ChatHandler(this.session).pSendSysMessage(LANG_PLAYER_AFK, target.getName(), target.getAutoReplyMsg());
    else if (target.isDND()) new ChatHandler(this.session).pSendSysMessage(LANG_PLAYER_DND, target.getName(), target.getAutoReplyMsg());
  }

  /** `BuildChatPacket(…, this, …)` for a player sender: its chat tag, and the GM header when it has `RBAC_PERM_COMMAND_GM_CHAT`. */
  private chatPartyForSend(): ChatParty {
    return { ...this.chatParty(), gmMessage: this.session.hasPermission(372 /* RBAC_PERM_COMMAND_GM_CHAT */) };
  }

  // ------------------------------------------------------------------ movement

  /** @ac game/Entities/Player/Player.cpp Player::TeleportTo */
  teleportTo(mapId: number, x: number, y: number, z: number, orientation: number, _options = 0): boolean {
    if (!isValidMapCoord(mapId, x, y, z, orientation)) {
      log("world", `TeleportTo: invalid map (${mapId}) or invalid coordinates (X: ${x}, Y: ${y}, Z: ${z}, O: ${orientation}) given when teleporting player (${this.getName()}).`);
      return false;
    }
    const moved = this.session.teleportTo(mapId, x, y, z, orientation);
    for (const packet of moved.packets) this.session.sendRaw(packet);
    return true;
  }

  isBeingTeleported(): boolean {
    return this.session.pendingTeleport !== null;
  }

  /** Taxi flights are instant teleports in this port, so a player is never in flight. */
  isInFlight(): boolean {
    return false;
  }

  isMounted(): boolean {
    return this.getUInt32Value(UNIT_FIELD_MOUNTDISPLAYID) !== 0;
  }

  /** @ac game/Entities/Unit/Unit.cpp Unit::Dismount */
  dismount(): void {
    this.setUInt32Value(UNIT_FIELD_MOUNTDISPLAYID, 0);
    this.session.unit?.removeAurasByType(SPELL_AURA_MOUNTED);
  }

  /** @ac game/Entities/Player/Player.cpp Player::SaveRecallPosition */
  saveRecallPosition(): void {
    this.state.recall = { mapId: this.getMapId(), x: this.getPositionX(), y: this.getPositionY(), z: this.getPositionZ(), o: this.getOrientation() };
  }

  getRecallPosition(): WorldPosition {
    return this.state.recall ?? { mapId: this.getMapId(), x: this.getPositionX(), y: this.getPositionY(), z: this.getPositionZ(), o: this.getOrientation() };
  }

  getHomebind(): WorldPosition | null {
    const home = this.session.kit?.homebind;
    return home ? { mapId: home.mapId, x: home.posX, y: home.posY, z: home.posZ, o: this.getOrientation() } : null;
  }

  /** @ac game/Entities/Player/Player.cpp Player::GetStartPosition */
  getStartPosition(): WorldPosition | null {
    const start = this.session.world?.playerStart(this.getRace(), this.getClass(), 1);
    return start ? { mapId: start.info.map, x: start.info.positionX, y: start.info.positionY, z: start.info.positionZ, o: 0 } : null;
  }

  /**
   * @ac game/Entities/Player/Player.cpp Player::RepopAtGraveyard
   * Note: this can be called also when the player is alive (a ghost that fell below the map). A zone that needs flying, or a
   * position below the map, resurrects the player at half health first; the closest graveyard is the destination, the
   * homebind when there is none and the player is below the map.
   * @ac-skip Battleground / Battlefield graveyards (`GetClosestGraveyard` of the bg or the battlefield).
   */
  async repopAtGraveyard(): Promise<void> {
    const zone = sAreaTableStore.lookupEntry(this.getAreaId());
    const belowMap = isBelowMap(this.session);

    // Such zones are considered unreachable as a ghost and the player must be automatically revived
    if ((!this.isAlive() && zone && (zone.flags & AREA_FLAG_NEED_FLY) !== 0) || belowMap) {
      await this.resurrectPlayer(0.5);
      await this.spawnCorpseBones();
    }

    const store = this.session.graveyardStore();
    const grave = getClosestGraveyard(store, {
      mapId: this.getMapId(),
      x: this.getPositionX(),
      y: this.getPositionY(),
      z: this.getPositionZ(),
      teamId: this.getTeamId() as 0 | 1 | 2,
      areaId: this.getAreaId(),
      zoneId: this.getZoneId(),
      isDeathKnight: this.getClass() === 6,
    });
    // if no grave found, stay at the current location and don't show spirit healer location
    if (grave) {
      const place = graveyardTeleport(grave, this.getOrientation());
      this.teleportTo(place.map, place.x, place.y, place.z, place.o);
      if (!this.isAlive()) {
        // not send if alive, because it used in TeleportTo()
        this.session.sendPacket(SMSG_DEATH_RELEASE_LOC, buildDeathReleaseLoc(grave.Map, grave.x, grave.y, grave.z));
      }
    } else if (belowMap) {
      const home = this.getHomebind();
      if (home) this.teleportTo(home.mapId, home.x, home.y, home.z, this.getOrientation());
    }

    this.removePlayerFlag(PLAYER_FLAGS_IS_OUT_OF_BOUNDS);
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::GetClosePoint (distance = size + own size, in front) */
  getClosePoint(size: number): { x: number; y: number; z: number } {
    const distance = size + this.getObjectSize();
    const angle = this.getOrientation();
    return { x: this.getPositionX() + distance * Math.cos(angle), y: this.getPositionY() + distance * Math.sin(angle), z: this.getPositionZ() };
  }

  /** @ac game/Entities/Object/Object.cpp WorldObject::GetObjectSize */
  getObjectSize(): number {
    return this.session.stats?.getFloat(UNIT_FIELD_COMBATREACH) || DEFAULT_PLAYER_COMBAT_REACH;
  }

  /** Groups are not ported; no player is in one. */
  getGroup(): null {
    return null;
  }

  // ------------------------------------------------------------------ money and progression

  getMoney(): number {
    return this.character.money;
  }

  /** @ac game/Entities/Player/Player.h Player::SetMoney */
  setMoney(value: number): void {
    const money = Math.max(0, Math.min(MAX_MONEY_AMOUNT, Math.trunc(value)));
    this.character.money = money;
    this.setUInt32Value(PLAYER_FIELD_COINAGE, money);
  }

  /** @ac game/Entities/Player/Player.cpp Player::ModifyMoney */
  modifyMoney(amount: number): boolean {
    if (!amount) return true;
    if (amount < 0) this.setMoney(this.getMoney() > -amount ? this.getMoney() + amount : 0);
    else if (this.getMoney() <= MAX_MONEY_AMOUNT - amount) this.setMoney(this.getMoney() + amount);
    else return false;
    return true;
  }

  /** @ac game/Entities/Player/Player.cpp Player::GiveLevel */
  giveLevel(level: number): void {
    const ctx = this.session.progressContext();
    if (!ctx) return;
    for (const packet of giveLevel(ctx, level)) this.sendSelf(packet.opcode, packet.body);
    sCharacterCache.updateCharacterLevel(this.character.guid, level);
    this.session.talk?.syncSpeaker(this.character);
  }

  /** @ac game/Entities/Player/Player.cpp Player::SetLevel (`Unit::SetLevel`) */
  setLevel(level: number): void {
    this.character.level = level;
    const stats = this.session.stats;
    if (stats) {
      stats.level = level;
      stats.setUInt32(0x36 /* UNIT_FIELD_LEVEL */, level);
    }
    sCharacterCache.updateCharacterLevel(this.character.guid, level);
  }

  /** @ac game/Entities/Player/Player.cpp Player::InitStatsForLevel */
  initStatsForLevel(): void {
    const ctx = this.session.progressContext();
    const stats = this.session.stats;
    if (!ctx || !stats) return;
    const info = ctx.levelStats(this.character.level);
    if (!info) return;
    stats.applyLevel(this.character.level, info);
    stats.updateAllStats();
    stats.setHealth(stats.maxHealth);
  }

  setFreeTalentPoints(points: number): void {
    this.setUInt32Value(PLAYER_CHARACTER_POINTS1, points);
  }

  getFreeTalentPoints(): number {
    return this.getUInt32Value(PLAYER_CHARACTER_POINTS1);
  }

  /** @ac game/Entities/Player/Player.cpp Player::SendTalentsInfoData (the talent spec tree is not ported: no talents and empty glyphs) */
  sendTalentsInfoData(pet: boolean): void {
    if (pet) return;
    const body = new ByteWriter().writeU8(0).writeU32(this.getFreeTalentPoints()).writeU8(1).writeU8(0).writeU8(0).writeU8(6);
    for (let glyph = 0; glyph < 6; glyph++) body.writeU16(0);
    this.sendSelf(SMSG_TALENTS_INFO, body.toUint8Array());
  }

  /** @ac game/Entities/Player/Player.cpp Player::InitTalentForLevel */
  initTalentForLevel(): void {
    const ctx = this.session.progressContext();
    if (ctx) initTalentForLevel(ctx);
  }

  getHonorPoints(): number {
    return this.character.totalHonorPoints;
  }

  /** @ac game/Entities/Player/Player.cpp Player::SetHonorPoints */
  setHonorPoints(value: number): void {
    const points = Math.min(Math.max(0, value), sWorld().getIntConfig(CONFIG_MAX_HONOR_POINTS));
    this.character.totalHonorPoints = points;
    this.setUInt32Value(PLAYER_FIELD_HONOR_CURRENCY, points);
  }

  /** @ac game/Entities/Player/Player.cpp Player::ModifyHonorPoints */
  modifyHonorPoints(value: number): void {
    const newValue = this.getHonorPoints() + value;
    this.setHonorPoints(newValue < 0 ? 0 : newValue);
  }

  getArenaPoints(): number {
    return this.character.arenaPoints;
  }

  /** @ac game/Entities/Player/Player.cpp Player::SetArenaPoints */
  setArenaPoints(value: number): void {
    const points = Math.min(Math.max(0, value), sWorld().getIntConfig(CONFIG_MAX_ARENA_POINTS));
    this.character.arenaPoints = points;
    this.setUInt32Value(PLAYER_FIELD_ARENA_CURRENCY, points);
  }

  /** @ac game/Entities/Player/Player.cpp Player::ModifyArenaPoints */
  modifyArenaPoints(value: number): void {
    const newValue = this.getArenaPoints() + value;
    this.setArenaPoints(newValue < 0 ? 0 : newValue);
  }

  private knownTitles(): number[] {
    const parts = (this.character.knownTitles ?? "").trim().split(/\s+/).filter(Boolean).map((part) => Number(part) >>> 0);
    while (parts.length < 6) parts.push(0);
    return parts.slice(0, 6);
  }

  /** @ac game/Entities/Player/Player.cpp Player::HasTitle */
  /** @ac game/Entities/Player/PlayerUpdates.cpp Player::UpdateHonorFields */
  updateHonorFields(): void {
    // called when rewarding honor and at each save
    const now = Math.floor(Date.now() / 1000);
    const today = Math.floor(now / DAY) * DAY;
    if (this.state.lastHonorUpdateTime < today) {
      const yesterday = today - DAY;
      const kills_today = this.getUInt32Value(PLAYER_FIELD_KILLS) & 0xffff;
      // update yesterday's contribution
      if (this.state.lastHonorUpdateTime >= yesterday) {
        this.setUInt32Value(PLAYER_FIELD_YESTERDAY_CONTRIBUTION, this.getUInt32Value(PLAYER_FIELD_TODAY_CONTRIBUTION));
        // this is the first update today, reset today's contribution
        this.setUInt32Value(PLAYER_FIELD_TODAY_CONTRIBUTION, 0);
        this.setUInt32Value(PLAYER_FIELD_KILLS, (kills_today << 16) >>> 0);
      } else {
        // no honor/kills yesterday or today, reset
        this.setUInt32Value(PLAYER_FIELD_YESTERDAY_CONTRIBUTION, 0);
        this.setUInt32Value(PLAYER_FIELD_KILLS, 0);
      }
    }
    this.state.lastHonorUpdateTime = now;
  }

  /** @ac game/Entities/Player/Player.cpp Player::RewardHonor (arenas and battlegrounds are not ported) */
  async rewardHonor(uVictim: CommandUnit | null, groupsize: number, honorArg = 0): Promise<boolean> {
    // 'Inactive' this aura prevents the player from gaining honor points and battleground tokens
    if (this.hasAura(SPELL_AURA_PLAYER_INACTIVE)) return false;
    let victim_guid = 0n;
    let victim_rank = 0;
    // need call before fields update to have chance move yesterday data to appropriate fields before today data change.
    this.updateHonorFields();
    // Promote to float for calculations
    let honor_f = honorArg;
    const noPvPCredit = (unit: CommandUnit): boolean => unit.spellUnit()?.hasAuraType(SPELL_AURA_NO_PVP_CREDIT) ?? false;
    if (honor_f <= 0) {
      if (!uVictim || uVictim === this || uVictim.getGUID() === this.getGUID() || noPvPCredit(uVictim)) return false;
      victim_guid = uVictim.getGUID();
      const victim = uVictim.toPlayer();
      if (victim) {
        if (this.getTeamId() === victim.getTeamId() && !sWorld().isFFAPvPRealm()) return false;
        const k_level = this.getLevel();
        const k_grey = getGrayLevel(k_level);
        const v_level = victim.getLevel();
        if (v_level <= k_grey) return false;
        victim_rank = (victim.getUInt32Value(PLAYER_FIELD_BYTES) >>> 24) & 0xff; // PLAYER_FIELD_BYTES_OFFSET_LIFETIME_MAX_PVP_RANK
        honor_f = Math.ceil((k_level * 1.55 * (v_level - k_grey)) / (k_level - k_grey));
        // count the number of playerkills in one day
        this.setUInt32Value(PLAYER_FIELD_KILLS, (this.getUInt32Value(PLAYER_FIELD_KILLS) + 1) >>> 0);
        // and those in a lifetime
        this.setUInt32Value(PLAYER_FIELD_LIFETIME_HONORABLE_KILLS, (this.getUInt32Value(PLAYER_FIELD_LIFETIME_HONORABLE_KILLS) + 1) >>> 0);
      } else {
        const template = this.session.world?.creatureTemplate(uVictim.getEntry());
        if (!template?.racialLeader) return false;
        honor_f = 100.0; // ??? need more info
        victim_rank = 19; // HK: Leader
      }
    }
    if (uVictim) {
      if (groupsize > 1) honor_f /= groupsize;
      // apply honor multiplier from aura (not stacking-get highest)
      honor_f += (honor_f * (this.spellUnit()?.getMaxPositiveAuraModifier(SPELL_AURA_MOD_HONOR_GAIN_PCT) ?? 0)) / 100;
    }
    honor_f *= sWorld().getRate(ServerConfig.RATE_HONOR);
    // Back to int now
    const honor = Math.trunc(honor_f);
    // Xinef: non quest case, quest honor obtain is send in quest reward packet
    if (uVictim || groupsize > 0) {
      this.sendSelf(SMSG_PVP_CREDIT, new ByteWriter().writeU32(honor >>> 0).writeU64(victim_guid).writeU32(victim_rank >>> 0).toUint8Array());
    }
    // add honor points
    this.modifyHonorPoints(honor);
    this.setUInt32Value(PLAYER_FIELD_TODAY_CONTRIBUTION, (this.getUInt32Value(PLAYER_FIELD_TODAY_CONTRIBUTION) + honor) >>> 0);
    if (sWorld().getBoolConfig(ServerConfig.CONFIG_PVP_TOKEN_ENABLE)) {
      if (!uVictim || uVictim.getGUID() === this.getGUID() || noPvPCredit(uVictim)) return true;
      if (uVictim.toPlayer()) {
        // Check if allowed to receive it in current map (no battlegrounds, and no FFA PvP areas without area data)
        const MapType = sWorld().getIntConfig(ServerConfig.CONFIG_PVP_TOKEN_MAP_TYPE);
        if (MapType === 1 || MapType === 2 || MapType === 3) return true;
        const itemID = sWorld().getIntConfig(ServerConfig.CONFIG_PVP_TOKEN_ID);
        const count = sWorld().getIntConfig(ServerConfig.CONFIG_PVP_TOKEN_COUNT);
        if ((await this.addItem(itemID, count, null)).stored) new ChatHandler(this.session).pSendSysMessage("You have been awarded a token for slaying another player.");
      }
    }
    return true;
  }

  hasTitle(bitIndex: number): boolean {
    if (bitIndex >= 6 * 32) return false;
    return ((this.knownTitles()[bitIndex >> 5]! >>> (bitIndex & 31)) & 1) !== 0;
  }

  /** @ac game/Entities/Player/Player.cpp Player::SetTitle */
  setTitle(bitIndex: number, lost: boolean): void {
    const titles = this.knownTitles();
    const field = bitIndex >> 5;
    const flag = (1 << (bitIndex & 31)) >>> 0;
    if (lost) {
      if (!(titles[field]! & flag)) return;
      titles[field] = (titles[field]! & ~flag) >>> 0;
    } else {
      if (titles[field]! & flag) return;
      titles[field] = (titles[field]! | flag) >>> 0;
    }
    this.character.knownTitles = `${titles.join(" ")} `;
    this.setUInt32Value(PLAYER__FIELD_KNOWN_TITLES + field, titles[field]!);
    this.sendSelf(SMSG_TITLE_EARNED, new ByteWriter().writeU32(bitIndex).writeU32(lost ? 0 : 1).toUint8Array());
  }

  getChosenTitle(): number {
    return this.character.chosenTitle;
  }

  setChosenTitle(bitIndex: number): void {
    this.character.chosenTitle = bitIndex;
    this.setUInt32Value(PLAYER_CHOSEN_TITLE, bitIndex);
  }

  /** @ac game/Entities/Player/Player.h Player::SetAtLoginFlag */
  setAtLoginFlag(flag: number): void {
    this.character.at_login |= flag;
  }

  /** `ReputationMgr::GetReputation` over the stored standing (`character_reputation.standing`). */
  /** @ac game/Reputation/ReputationMgr.cpp ReputationMgr::GetReputation (the base value for the race and class plus the stored standing) */
  getReputationOf(factionId: number): number {
    const entry = sFactionStore.lookupEntry(factionId);
    if (!entry) return 0;
    return getBaseReputation(entry, this.getRace(), this.getClass()) + (this.getReputation(factionId) ?? 0);
  }

  /** @ac game/Reputation/ReputationMgr.cpp ReputationMgr::SetOneFactionReputation (not incremental), then `SendState` */
  setOneFactionReputation(factionId: number, standing: number): boolean {
    const entry = sFactionStore.lookupEntry(factionId);
    if (!entry) return false;
    const BaseRep = getBaseReputation(entry, this.getRace(), this.getClass());
    const clamped = Math.min(Math.max(standing, REPUTATION_BOTTOM), REPUTATION_CAP);
    return this.setReputation(factionId, Math.trunc(clamped - BaseRep));
  }

  getReputation(factionId: number): number | null {
    return this.session.kit?.factions.find((row) => row.faction === factionId)?.standing ?? null;
  }

  /** `ReputationMgr::SetOneFactionReputation` over the stored standing; `SMSG_SET_FACTION_STANDING` for its list slot. */
  setReputation(factionId: number, standing: number): boolean {
    return this.session.setFactionStanding(factionId, standing);
  }

  /** @ac game/Entities/Player/Player.cpp Player::SetDrunkValue */
  setDrunkValue(value: number): void {
    const drunk = Math.min(Math.max(0, value), 100);
    this.character.drunk = drunk;
    const bytes3 = this.getUInt32Value(PLAYER_BYTES_3);
    // byte 0 is the gender (`SetByteValue(PLAYER_BYTES_3, 0, gender)` at load)
    this.setUInt32Value(PLAYER_BYTES_3, ((bytes3 & 0xffff0000) | (this.character.gender & 0xff) | ((drunk << 8) & 0xff00)) >>> 0);
  }

  // ------------------------------------------------------------------ spells

  hasSpell(spellId: number): boolean {
    return this.session.kit?.spells.includes(spellId) ?? false;
  }

  getSpells(): readonly number[] {
    return this.session.kit?.spells ?? [];
  }

  /** @ac game/Entities/Player/Player.cpp Player::learnSpell */
  learnSpell(spellId: number): void {
    const kit = this.session.kit;
    if (!kit || !spellId || kit.spells.includes(spellId)) return;
    kit.spells.push(spellId);
    kit.spells.sort((a, b) => a - b);
    this.sendSelf(SMSG_LEARNED_SPELL, new ByteWriter().writeU32(spellId).writeU16(0).toUint8Array());
  }

  /** @ac game/Entities/Player/Player.cpp Player::removeSpell */
  removeSpell(spellId: number): void {
    const kit = this.session.kit;
    if (!kit) return;
    const index = kit.spells.indexOf(spellId);
    if (index < 0) return;
    kit.spells.splice(index, 1);
    this.session.unit?.removeOwnedAuraBySpell(spellId, this.getGUID());
    this.sendSelf(SMSG_REMOVED_SPELL, new ByteWriter().writeU16(spellId).toUint8Array());
  }

  /** @ac game/Entities/Player/PlayerQuest.cpp Player::GetQuestStatus */
  getQuestStatus(questId: number): number {
    return this.session.talk?.quests.status(questId) ?? 0;
  }

  /** @ac game/Entities/Player/Player.cpp Player::GetSkillPermBonusValue */
  getSkillPermBonusValue(skillId: number): number {
    return this.session.skills?.getSkillPermBonusValue(skillId) ?? 0;
  }

  /** @ac game/Entities/Player/Player.cpp Player::GetSkillTempBonusValue */
  getSkillTempBonusValue(skillId: number): number {
    return this.session.skills?.getSkillTempBonusValue(skillId) ?? 0;
  }

  /** @ac game/Entities/Player/Player.cpp Player::InitDisplayIds */
  initDisplayIds(): void {
    const display = raceAppearance(this.character.race, this.character.gender).display;
    this.setUInt32Value(UNIT_FIELD_DISPLAYID, display);
    this.setUInt32Value(UNIT_FIELD_NATIVEDISPLAYID, display);
  }

  /** @ac game/Entities/Player/Player.cpp Player::resetSpells */
  resetSpells(): void {
    // make full copy of map (spells removed and marked as deleted at another spell remove)
    for (const spellId of [...this.getSpells()]) this.removeSpell(spellId);
    this.learnDefaultSkills();
    this.learnCustomSpells();
    this.learnQuestRewardedSpells();
  }

  /**
   * @ac game/Entities/Player/Player.cpp Player::resetTalents
   * The talent map is not ported, so no talent is ever used: the free points become the points for the level.
   */
  resetTalents(_noResetCost: boolean): boolean {
    this.initTalentForLevel();
    return false;
  }

  /** @ac game/Entities/Player/Player.cpp Player::GetItemFromBuyBackSlot */
  getItemFromBuyBackSlot(slot: number): { entry: number } | null {
    return getItemFromBuyBackSlot(this.session.vendorSession.buyback, slot);
  }

  /** @ac game/Entities/Player/Player.cpp Player::RemoveItemFromBuyBackSlot (and its `PLAYER_FIELD_VENDORBUYBACK_SLOT_1` fields) */
  removeItemFromBuyBackSlot(slot: number, _del: boolean): void {
    removeItemFromBuyBackSlot(this.session.vendorSession.buyback, slot, true);
    const eslot = slot - BUYBACK_SLOT_START;
    const fields = [
      { index: PLAYER_FIELD_VENDORBUYBACK_SLOT_1 + eslot * 2, value: 0 },
      { index: PLAYER_FIELD_VENDORBUYBACK_SLOT_1 + eslot * 2 + 1, value: 0 },
      { index: PLAYER_FIELD_BUYBACK_PRICE_1 + eslot, value: 0 },
      { index: PLAYER_FIELD_BUYBACK_TIMESTAMP_1 + eslot, value: 0 },
    ];
    this.sendSelf(SMSG_UPDATE_OBJECT, fieldUpdateBlock(this.character.guid, fields));
  }

  /** @ac game/Entities/Player/PlayerStorage.cpp Player::DurabilityRepairAll (`.gear repair`: `cost` false) */
  async durabilityRepairAll(_cost: boolean, _discountMod: number, _guildBank: boolean): Promise<void> {
    const world = this.session.worldTables();
    const inventory = this.session.inventory;
    if (!world || !inventory) return;
    for (const packet of await durabilityRepairAllFree(this.session.db.characters, world, inventory)) this.sendSelf(packet.opcode, packet.body);
    await this.session.refreshItemDurability();
  }

  /** @ac game/Entities/Player/Player.cpp Player::GetAverageItemLevel */
  getAverageItemLevel(): number {
    let sum = 0;
    let count = 0;
    const level = this.getLevel();
    for (let i = 0; i < 19; ++i) {
      // don't check tabard, ranged, offhand or shirt
      if (i === 18 || i === 17 || i === 16 || i === 3) continue;
      const item = this.getItemByPos(INVENTORY_SLOT_BAG_0, i);
      const template = item ? this.session.world?.itemTemplate(item.entry) : undefined;
      if (template) {
        // ItemTemplate::GetItemLevelIncludingQuality
        let itemLevel = template.itemLevel;
        if (template.quality <= 2) itemLevel -= 26;
        else if (template.quality === 3) itemLevel -= 13;
        else if (template.quality === 7) itemLevel = level * 2.33;
        sum += itemLevel;
      }
      ++count;
    }
    return Math.max(0, sum / count);
  }

  /** @ac game/Entities/Player/PlayerSettings.cpp Player::GetPlayerSetting */
  getPlayerSetting(source: string, index: number): number {
    return GetPlayerSetting(this.state.charSettingsMap, source, index);
  }

  /** @ac game/Entities/Player/PlayerSettings.cpp Player::UpdatePlayerSetting */
  updatePlayerSetting(source: string, index: number, value: number): void {
    UpdatePlayerSetting(this.state.charSettingsMap, source, index, value);
  }

  /** @ac game/Entities/Player/Player.h Player::getRaceMask */
  getRaceMask(): number {
    return 1 << (this.getRace() - 1);
  }

  /** @ac game/Entities/Player/Player.h Player::getClassMask */
  getClassMask(): number {
    return 1 << (this.getClass() - 1);
  }

  /** @ac game/Entities/Player/Player.cpp Player::IsSpellFitByClassAndRace */
  isSpellFitByClassAndRace(spell_id: number): boolean {
    const racemask = this.getRaceMask();
    const classmask = this.getClassMask();
    const bounds = sSpellMgr.getSkillLineAbilityMapBounds(spell_id);
    if (bounds.length === 0) return true;
    for (const entry of bounds) {
      // skip wrong race skills
      if (entry.RaceMask && (entry.RaceMask & racemask) === 0) continue;
      // skip wrong class skills
      if (entry.ClassMask && (entry.ClassMask & classmask) === 0) continue;
      // skip wrong class and race skill saved in SkillRaceClassInfo.dbc
      if (!getSkillRaceClassInfo(this.session.env.skillData, entry.SkillLine, this.getRace(), this.getClass())) continue;
      return true;
    }
    return false;
  }

  /** @ac game/Entities/Player/Player.h Player::GetFreePrimaryProfessionPoints */
  getFreePrimaryProfessionPoints(): number {
    return this.getUInt32Value(PLAYER_CHARACTER_POINTS2);
  }

  /** @ac game/Entities/Player/Player.cpp Player::LearnDefaultSkills */
  learnDefaultSkills(): void {
    const skills = this.session.skills;
    if (!skills) return;
    skills.learnDefaultSkills(playerCreateSkillsFor(this.session.env.createSkills, this.getRace(), this.getClass()));
    this.session.applySkillEvents();
  }

  /** @ac game/Entities/Player/Player.cpp Player::LearnCustomSpells */
  learnCustomSpells(): void {
    if (!sWorld().getBoolConfig(ServerConfig.CONFIG_START_CUSTOM_SPELLS)) return;
    // learn default race/class spells
    const masks = (mask: number, id: number): boolean => mask === 0 || (mask & (1 << (id - 1))) !== 0;
    for (const row of this.session.worldTables()?.all(playercreateinfo_spell_custom) ?? []) {
      if (masks(row.racemask, this.getRace()) && masks(row.classmask, this.getClass())) this.learnSpell(row.Spell);
    }
  }

  /** @ac game/Entities/Player/Player.cpp Player::SatisfyQuestClass */
  satisfyQuestClass(quest: QuestTemplate): boolean {
    const reqClass = quest.allowableClasses;
    return reqClass === 0 || (reqClass & this.getClassMask()) !== 0;
  }

  /** @ac game/Entities/Player/Player.cpp Player::learnQuestRewardedSpells (one quest, or every rewarded quest) */
  learnQuestRewardedSpells(quest?: QuestTemplate): void {
    if (!quest) {
      // learn spells received from quest completing
      const quests = this.session.talk?.quests;
      for (const template of sObjectMgr.getQuestTemplates().values()) if (quests?.rewarded(template.id)) this.learnQuestRewardedSpells(template);
      return;
    }
    // xinef: quest does not learn anything
    const spellId = quest.rewardSpell;
    if (!spellId) return;
    const spellInfo = sSpellMgr.getSpellInfo(spellId);
    if (!spellInfo) return;
    // xinef: find effect with learn spell and check if we have this spell
    let found = false;
    for (const effect of spellInfo.effects) {
      if (effect.effect === SPELL_EFFECT_LEARN_SPELL && effect.triggerSpell && !this.hasSpell(effect.triggerSpell)) {
        // pusywizard: don't re-add profession specialties!
        const triggeredInfo = sSpellMgr.getSpellInfo(effect.triggerSpell);
        if (triggeredInfo && triggeredInfo.effects[0]?.effect === SPELL_EFFECT_TRADE_SKILL) break;
        found = true;
        break;
      }
    }
    // xinef: we know the spell, return
    if (!found) return;
    this.castSpell(this, spellId, true);
  }

  /** @ac game/Entities/Unit/Unit.cpp Unit::CastSpell */
  castSpell(target: CommandUnit | null, spellId: number, triggered: boolean): void {
    const unit = this.session.unit;
    if (!unit) return;
    unit.castSpell(target?.spellUnit() ?? null, spellId, { triggered });
    for (const packet of this.session.drainSpellOutbox().packets) this.session.sendRaw(packet);
  }

  /** @ac game/Entities/Player/Player.cpp Player::RemoveSpellCooldown */
  removeSpellCooldown(spellId: number, update: boolean): void {
    this.session.unit?.removeSpellCooldown(spellId, update);
  }

  /** @ac game/Entities/Player/Player.cpp Player::RemoveAllSpellCooldown */
  removeAllSpellCooldown(): void {
    const unit = this.session.unit;
    if (!unit) return;
    for (const spellId of [...unit.spellCooldowns.keys()]) unit.removeSpellCooldown(spellId, true);
  }

  hasAura(spellId: number): boolean {
    return this.session.unit?.hasAura(spellId) ?? false;
  }

  removeAurasDueToSpell(spellId: number): void {
    this.session.unit?.removeAurasDueToSpell(spellId, 0n, 0, AURA_REMOVE_BY_DEFAULT);
  }

  // ------------------------------------------------------------------ skills

  hasSkill(skillId: number): boolean {
    return this.session.skills?.hasSkill(skillId) ?? false;
  }

  getSkillValue(skillId: number): number {
    return this.session.skills?.getSkillValue(skillId) ?? 0;
  }

  getPureSkillValue(skillId: number): number {
    return this.session.skills?.getPureSkillValue(skillId) ?? 0;
  }

  getMaxSkillValue(skillId: number): number {
    return this.session.skills?.getMaxSkillValue(skillId) ?? 0;
  }

  getPureMaxSkillValue(skillId: number): number {
    return this.session.skills?.getPureMaxSkillValue(skillId) ?? 0;
  }

  getSkillStep(skillId: number): number {
    return this.session.skills?.getSkillStep(skillId) ?? 0;
  }

  /** @ac game/Entities/Player/Player.cpp Player::SetSkill */
  setSkill(skillId: number, step: number, value: number, max: number): void {
    const skills = this.session.skills;
    if (!skills) return;
    skills.setSkill(skillId, step, value, max);
    this.session.applySkillEvents();
  }

  /** @ac game/Entities/Player/Player.cpp Player::UpdateSkillsToMaxSkillsForLevel */
  updateSkillsToMaxSkillsForLevel(): void {
    this.session.skills?.updateSkillsToMaxSkillsForLevel();
  }

  // ------------------------------------------------------------------ items

  hasItemCount(entry: number, count: number, inBankAlso = false): boolean {
    return this.getItemCount(entry, inBankAlso) >= count;
  }

  getItemCount(entry: number, inBankAlso = false): number {
    const inventory = this.session.inventory;
    return inventory ? getItemCount(inventory, entry, inBankAlso) : 0;
  }

  /** @ac game/Entities/Player/PlayerStorage.cpp Player::GetItemByPos (`INVENTORY_SLOT_BAG_0` is the player's own slots) */
  getItemByPos(bag: number, slot: number): { entry: number; count: number } | null {
    const inventory = this.session.inventory;
    if (!inventory) return null;
    if (bag === INVENTORY_SLOT_BAG_0) return inventory.slots.get(0)?.get(slot) ?? null;
    const bagItem = inventory.slots.get(0)?.get(bag);
    return bagItem ? (inventory.slots.get(bagItem.guid)?.get(slot) ?? null) : null;
  }

  /** @ac game/Entities/Player/PlayerStorage.cpp Player::GetBagByPos (the bag size is `ContainerSlots`) */
  getBagByPos(bag: number): { size: number; entry: number; freeSlots: number } | null {
    if (!((bag >= INVENTORY_SLOT_BAG_START && bag < INVENTORY_SLOT_BAG_END) || (bag >= BANK_SLOT_BAG_START && bag < BANK_SLOT_BAG_END))) return null;
    const inventory = this.session.inventory;
    const bagItem = inventory?.slots.get(0)?.get(bag);
    if (!inventory || !bagItem || bagItem.template.ContainerSlots <= 0) return null;
    const size = bagItem.template.ContainerSlots;
    // Bag::GetFreeSlots
    const used = inventory.slots.get(bagItem.guid)?.size ?? 0;
    return { size, entry: bagItem.entry, freeSlots: size - used };
  }

  /** @ac game/Entities/Player/PlayerStorage.cpp Player::DestroyItemCount */
  async destroyItemCount(entry: number, count: number): Promise<void> {
    await this.session.destroyItemCountByCommand(entry, count);
  }

  /** @ac game/Entities/Player/PlayerStorage.cpp Player::DestroyItem */
  destroyItem(bag: number, slot: number): Promise<boolean> {
    return this.session.destroyItemAt(bag, slot, 0);
  }

  /** `.additem`: `CanStoreNewItem`, `StoreNewItem`, then `SendNewItem` to the target and the giving GM. */
  async addItem(entry: number, count: number, notify: Player | null): Promise<{ stored: number; noSpaceForCount: number; error: number }> {
    const session = this.session;
    const inventory = session.inventory;
    const character = session.character;
    if (!inventory || !character) return { stored: 0, noSpaceForCount: count, error: 1 };
    const world = session.worldTables();
    const proto = lookupTemplate(world, entry);
    const can = canStoreNewItem(inventory, NULL_BAG, NULL_SLOT, proto, count, (id) => session.itemDbc.limitCategory(id));
    let storeCount = count;
    let noSpaceForCount = 0;
    if (can.result !== EQUIP_ERR_OK) {
      noSpaceForCount = can.noSpaceCount;
      storeCount -= noSpaceForCount;
    }
    if (!storeCount || can.dest.length === 0 || !proto) return { stored: 0, noSpaceForCount, error: can.result };
    const ctx = session.lootContext(character, inventory);
    const stored = await storeNewItem(can.dest, entry, 0, proto, ctx);
    for (const packet of stored.packets) session.sendPacket(packet.opcode, packet.body);
    session.sendItemPushResult(stored.last, stored.lastInstance, storeCount, notify === this, notify);
    session.saveLoggedInCharacter(character);
    return { stored: storeCount, noSpaceForCount, error: can.result };
  }

  // ------------------------------------------------------------------ death

  /** @ac game/Entities/Player/Player.cpp Player::ResurrectPlayer */
  async resurrectPlayer(restorePercent: number): Promise<void> {
    const session = this.session;
    if (session.deathState === "alive" && (this.character.playerFlags & PLAYER_FLAGS_GHOST) === 0) return;
    const result = applyResurrect(session.deathFields(), restorePercent, false);
    const applied = session.applyResurrect(result);
    for (const packet of applied.packets) session.sendRaw(packet);
  }

  /** @ac game/Entities/Player/Player.cpp Player::SpawnCorpseBones (the corpse row is removed) */
  async spawnCorpseBones(): Promise<void> {
    await deleteCorpse(this.session.db.characters, this.character.guid);
  }

  // ------------------------------------------------------------------ persistence

  /** @ac game/Entities/Player/Player.h Player::GetSaveTimer */
  getSaveTimer(): number {
    return Math.max(0, sWorld().getIntConfig(ServerConfig.CONFIG_INTERVAL_SAVE) - (Date.now() - this.state.lastSaveMs));
  }

  /** @ac game/Entities/Player/PlayerStorage.cpp Player::SaveToDB */
  async saveToDB(): Promise<void> {
    this.state.lastSaveMs = Date.now();
    this.character.health = this.session.health;
    this.session.saveLoggedInCharacter(this.character);
    await this.session.flushSaves();
  }
}

/** A creature spawn as a command target (`Creature*`). */
export class CreatureFacade implements CommandCreature {
  constructor(
    private readonly session: WorldSession,
    private readonly spawnId: number,
  ) {}

  private get spawn() {
    const spawn = this.session.world?.creatureSpawn(this.spawnId);
    if (!spawn) throw new Error(`creature spawn ${this.spawnId} is gone`);
    return spawn;
  }

  private get template() {
    const template = this.session.world?.creatureTemplate(this.spawn.entry);
    if (!template) throw new Error(`creature template ${this.spawn.entry} is gone`);
    return template;
  }

  private unit() {
    return this.session.combat?.creatureUnit(this.spawnId) ?? null;
  }

  private override(index: number): number | null {
    return this.session.combat?.creatureFieldOverride(this.spawnId, index) ?? null;
  }

  private set(index: number, value: number): void {
    this.session.combat?.setCreatureField(this.spawnId, index, value);
  }

  getSpawnId(): number {
    return this.spawnId;
  }

  getName(): string {
    return this.template.name;
  }

  getGUID(): bigint {
    return creatureGuid(this.spawn.entry, this.spawnId);
  }

  getEntry(): number {
    return this.spawn.entry;
  }

  isPlayer(): boolean {
    return false;
  }

  isCreature(): boolean {
    return true;
  }

  isPet(): boolean {
    return false;
  }

  toPlayer(): null {
    return null;
  }

  isAlive(): boolean {
    return (this.unit()?.deathState ?? "alive") === "alive";
  }

  isDead(): boolean {
    return !this.isAlive();
  }

  isInCombat(): boolean {
    return (this.unit()?.threat.size ?? 0) > 0;
  }

  getLevel(): number {
    return this.unit()?.info.level ?? this.template.minLevel;
  }

  getHealth(): number {
    return this.unit()?.health ?? 0;
  }

  getMaxHealth(): number {
    return this.session.combat?.maxHealthOfSpawn(this.spawnId) ?? 0;
  }

  setHealth(value: number): void {
    this.session.combat?.setCreatureHealth(this.spawnId, value);
  }

  setMaxHealth(value: number): void {
    this.set(UNIT_FIELD_MAXHEALTH, value);
  }

  getPower(_power: number): number {
    return this.unit()?.spell?.power(_power) ?? 0;
  }

  getMaxPower(power: number): number {
    return this.unit()?.spell?.maxPower(power) ?? 0;
  }

  setPower(power: number, value: number): void {
    this.set(0x19 + power, value);
  }

  setMaxPower(power: number, value: number): void {
    this.set(0x21 + power, value);
  }

  getMapId(): number {
    return this.spawn.map;
  }

  getPositionX(): number {
    return this.unit()?.pos.x ?? this.spawn.x;
  }

  getPositionY(): number {
    return this.unit()?.pos.y ?? this.spawn.y;
  }

  getPositionZ(): number {
    return this.unit()?.pos.z ?? this.spawn.z;
  }

  getOrientation(): number {
    return this.unit()?.pos.o ?? this.spawn.orientation;
  }

  getPhaseMask(): number {
    return this.spawn.phaseMask || 1;
  }

  getFaction(): number {
    return this.override(UNIT_FIELD_FACTIONTEMPLATE) ?? this.template.faction;
  }

  setFaction(faction: number): void {
    this.set(UNIT_FIELD_FACTIONTEMPLATE, faction);
  }

  getDisplayId(): number {
    return this.override(UNIT_FIELD_DISPLAYID) ?? creatureModel(this.template).displayId;
  }

  getNativeDisplayId(): number {
    return this.override(UNIT_FIELD_NATIVEDISPLAYID) ?? creatureModel(this.template).displayId;
  }

  /** @ac game/Entities/Unit/Unit.cpp Unit::DeMorph */
  deMorph(): void {
    this.setDisplayId(this.getNativeDisplayId());
  }

  getValuesCount(): number {
    return UNIT_END;
  }

  /** Creature phases are not ported: every spawn is in `PHASEMASK_NORMAL`. */
  setPhaseMask(_newPhaseMask: number, _update: boolean): void {}

  setDisplayId(displayId: number): void {
    this.set(UNIT_FIELD_DISPLAYID, displayId);
  }

  getObjectScale(): number {
    const raw = this.override(OBJECT_FIELD_SCALE_X);
    if (raw === null) return creatureModel(this.template).scale || 1;
    return new Float32Array(new Uint32Array([raw]).buffer)[0]!;
  }

  setObjectScale(scale: number): void {
    this.set(OBJECT_FIELD_SCALE_X, new Uint32Array(new Float32Array([scale]).buffer)[0]!);
  }

  getUnitFlags(): number {
    const unit = this.unit();
    return this.override(UNIT_FIELD_FLAGS) ?? (unit ? (this.session.combat?.creatureUnitFlags(unit) ?? 0) : this.template.unitFlags);
  }

  replaceAllUnitFlags(flags: number): void {
    this.set(UNIT_FIELD_FLAGS, flags);
  }

  getNpcFlags(): number {
    return this.override(UNIT_NPC_FLAGS) ?? this.template.npcFlags;
  }

  replaceAllNpcFlags(flags: number): void {
    this.set(UNIT_NPC_FLAGS, flags);
  }

  getDynamicFlags(): number {
    return this.override(UNIT_DYNAMIC_FLAGS) ?? this.template.dynamicFlags;
  }

  replaceAllDynamicFlags(flags: number): void {
    this.set(UNIT_DYNAMIC_FLAGS, flags);
  }

  getUInt32Value(index: number): number {
    return this.override(index) ?? 0;
  }

  setUInt32Value(index: number, value: number): void {
    this.set(index, value);
  }

  getSpeedRate(moveType: number): number {
    return this.spellUnit()?.speedRate[moveType] ?? 1;
  }

  setSpeedRate(moveType: number, rate: number): void {
    this.spellUnit()?.setSpeedRate(moveType, rate);
  }

  spellUnit(): SpellUnit | null {
    const unit = this.unit();
    return unit && this.session.combat ? this.session.combat.spellUnitOf(unit) : null;
  }

  kill(killer: Player): void {
    this.session.combat?.commandKillCreature(this.spawnId, killer.getGUIDLow());
  }

  dealDamage(attacker: Player, damage: number): void {
    this.session.combat?.commandDamageCreature(this.spawnId, damage, attacker.getGUIDLow());
  }

  lowerPlayerDamageReq(unDamage: number): void {
    this.session.combat?.lowerPlayerDamageReq(this.spawnId, unDamage);
  }

  combatStop(): void {
    this.session.combat?.creatureCombatStop(this.spawnId);
  }

  respawn(): void {
    this.session.combat?.commandRespawnCreature(this.spawnId);
  }

  /** When a dead creature respawns (`Map::GetCreatureRespawnTime`, unix seconds), or 0 while it lives. */
  getRespawnTime(): number {
    const unit = this.unit();
    return unit && unit.deathState !== "alive" ? unit.respawnTime : 0;
  }

  movePoint(_id: number, x: number, y: number, z: number): void {
    this.session.combat?.commandMovePoint(this.spawnId, { x, y, z });
  }

  motion(): { victim: number | null; evading: boolean; moving: boolean; home: boolean; destination: { x: number; y: number; z: number } | null } | null {
    return this.session.combat?.creatureMotion(this.spawnId) ?? null;
  }
}

/** A gameobject spawn as a command target (`GameObject*`). */
export class GameObjectFacade implements CommandGameObject {
  constructor(
    private readonly session: WorldSession,
    private readonly spawnId: number,
  ) {}

  private get spawn() {
    const spawn = this.session.world?.gameObjectSpawn(this.spawnId);
    if (!spawn) throw new Error(`gameobject spawn ${this.spawnId} is gone`);
    return spawn;
  }

  getSpawnId(): number {
    return this.spawnId;
  }

  getName(): string {
    return this.session.world?.gameObjectTemplate(this.spawn.entry)?.name ?? "";
  }

  getGUID(): bigint {
    return gameObjectGuid(this.spawn.entry, this.spawnId);
  }

  getEntry(): number {
    return this.spawn.entry;
  }

  getMapId(): number {
    return this.spawn.map;
  }

  getPositionX(): number {
    return this.spawn.x;
  }

  getPositionY(): number {
    return this.spawn.y;
  }

  getPositionZ(): number {
    return this.spawn.z;
  }

  getOrientation(): number {
    return this.spawn.orientation;
  }

  getGoType(): number {
    return this.session.world?.gameObjectTemplate(this.spawn.entry)?.type ?? 0;
  }

  getGoState(): number {
    return this.spawn.state;
  }

  /** @ac game/Entities/GameObject/GameObject.cpp GameObject::SetGoState (`GAMEOBJECT_BYTES_1` byte 0, to every player on the map) */
  setGoState(state: number): void {
    const spawn = this.spawn;
    spawn.state = state;
    const template = this.session.world?.gameObjectTemplate(spawn.entry);
    const value = (state & 0xff) | (((template?.type ?? 0) & 0xff) << 8) | ((spawn.animProgress & 0xff) << 24);
    const body = unitValuesUpdate(this.getGUID(), [{ index: GAMEOBJECT_BYTES_1, value }]);
    for (const session of sWorldSessionMgr.GetAllSessions()) {
      if (session.getPlayer()?.getMapId() === spawn.map) session.sendPacket(SMSG_UPDATE_OBJECT, body);
    }
  }

  getPhaseMask(): number {
    return this.spawn.phaseMask || 1;
  }
}
