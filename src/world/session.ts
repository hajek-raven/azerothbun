import { inArray } from "drizzle-orm";
import { queryFields, executeStatementAsync } from "../database/database.ts";
import { LOGIN_SEL_ACCOUNT_INFO_BY_NAME, LOGIN_UPD_MUTE_TIME_LOGIN, LOGIN_UPD_SET_ACCOUNT_FLAG } from "../gen/LoginDatabase.gen.ts";
import { RBACData } from "../game/Accounts/RBAC.ts";
import { sAccountMgr } from "../game/Accounts/AccountMgr.ts";
import { RBAC_PERM_RESTORE_SAVED_GM_STATE } from "../game/Accounts/RBACDefines.ts";
import { ACCOUNT_FLAG_GM, LOCALE_enUS, SEC_GAMEMASTER, SEC_PLAYER, TOTAL_LOCALES } from "../shared/SharedDefines.ts";
import { realm } from "../shared/Realms/Realm.ts";
import { sObjectMgr } from "../game/Globals/ObjectMgr.ts";
import { sGraveyard } from "../game/Misc/GameGraveyard.ts";
import { SMSG_MOTD, sMotdMgr } from "../game/Motd/MotdMgr.ts";
import { sFactionStore } from "../game/DataStores/DBCStores.ts";
import { sCharacterCache } from "../game/Cache/CharacterCache.ts";
import { ServerConfig } from "../game/world/world-config.ts";
import { sWorld } from "../game/world/world.ts";
import { CHAT_OPCODES, CMSG_CHAT_IGNORED, CMSG_EMOTE, CMSG_MESSAGECHAT, CMSG_TEXT_EMOTE, HandleChatIgnoredOpcode, HandleEmoteOpcode, HandleMessagechatOpcode, HandleTextEmoteOpcode } from "../game/Handlers/ChatHandler.ts";
import { PlayerCommandState, SessionPlayer } from "./session-player.ts";
import { OBJECT_FIELD_SCALE_X, PLAYER_EXPLORED_ZONES_1, PLAYER__FIELD_KNOWN_TITLES, PLAYER_CHOSEN_TITLE, PLAYER_FIELD_ARENA_CURRENCY, PLAYER_FIELD_HONOR_CURRENCY, PLAYER_FIELD_KILLS, PLAYER_FIELD_LIFETIME_HONORABLE_KILLS, PLAYER_FIELD_TODAY_CONTRIBUTION, PLAYER_FIELD_YESTERDAY_CONTRIBUTION, PLAYER_FLAGS as PLAYER_FLAGS_FIELD, UNIT_FIELD_COMBATREACH, UNIT_FIELD_DISPLAYID, UNIT_FIELD_FACTIONTEMPLATE, UNIT_FIELD_MOUNTDISPLAYID, UNIT_FIELD_NATIVEDISPLAYID } from "../gen/UpdateFields.gen.ts";
import { DeleteFromDB } from "../game/Entities/Player/PlayerMisc.ts";
import { LoadCharacterSettings, SavePlayerSettings } from "../game/Entities/Player/PlayerSettings.ts";
import { AT_LOGIN_RESURRECT, CHEAT_GOD, PLAYER_EXTRA_ACCEPT_WHISPERS, PLAYER_EXTRA_GM_CHAT, PLAYER_EXTRA_GM_INVISIBLE, PLAYER_EXTRA_GM_ON, PLAYER_FLAGS_IS_OUT_OF_BOUNDS } from "../game/Entities/Player/PlayerDefines.ts";
import { PlayerAreaUpdates } from "../game/Entities/Player/PlayerUpdates.ts";
import { MAP_THE_OCULUS } from "../game/Maps/AreaDefines.ts";
import { createAreaHost, isBelowMap, terrainStatusOf } from "./session-terrain.ts";
import { buildItemPushResult, getItemPos } from "../items/bags.ts";
import { bagSlotOf } from "./loot-play.ts";
import type { ItemInstance } from "../items/instance.ts";
import type { InventoryItem } from "../items/bags.ts";
import { logError } from "../log.ts";
import type { Db } from "../database/database.ts";
import { item_instance } from "../database/schema/characters.ts";
import { item_template } from "../database/schema/world.ts";
import type { WorldTables } from "../database/world-tables.ts";
import { equalBytes } from "../crypto/equal-bytes.ts";
import { WorldCrypt } from "../crypto/world-crypt.ts";
import { upperLatin } from "../crypto/srp6.ts";
import type { DbcStores } from "../data/dbc.ts";
import type { WorldData } from "../data/world.ts";
import {
  characterCreateNameCode,
  createPlayableCharacter,
  ensureStartingKit,
  kitFromStart,
  MAX_CHARACTERS_PER_ACCOUNT,
  refreshRealmCharacterCount,
} from "../characters/live.ts";
import { loadCharEnumGear } from "../characters/char-enum-gear.ts";
import {
  CMSG_RECLAIM_CORPSE,
  CMSG_REPOP_REQUEST,
  CMSG_RESURRECT_RESPONSE,
  CMSG_SPIRIT_HEALER_ACTIVATE,
  MSG_CORPSE_QUERY,
  PLAYER_FLAGS_GHOST,
  buildCorpseQueryResponse,
  handleResurrectResponse,
  loadCorpse,
  onDeath,
  reclaimCorpse,
  releaseSpirit,
  spiritHealerResurrect,
  type DeathState,
  type PlayerDeathFields,
  type ResurrectRequestData,
} from "../characters/death.ts";
import { loadGraveyardStore, teamIdFromRace, type GraveyardStore } from "../characters/graveyard.ts";
import { xpForLevel } from "../characters/experience.ts";
import { giveXp, initXpFields, levelStatsFor, type ProgressContext } from "../characters/level-up.ts";
import { defaultPlayerEnvironment, type PlayerEnvironment } from "../characters/player-env.ts";
import {
  CR_ARMOR_PENETRATION,
  CR_CRIT_TAKEN_MELEE,
  PLAYER_BLOCK_PERCENTAGE,
  PLAYER_CRIT_PERCENTAGE,
  PLAYER_EXPERTISE,
  PLAYER_OFFHAND_CRIT_PERCENTAGE,
  PLAYER_OFFHAND_EXPERTISE,
  PLAYER_SHIELD_BLOCK,
  PlayerStats,
  PUBLIC_STAT_FIELDS,
  statItemFromRow,
  UNIT_FIELD_FLAGS,
  type EquippedStatItem,
} from "../characters/player-stats.ts";
import { isStandState, PlayerRegen, powerUpdatePacket, SMSG_POWER_UPDATE } from "../characters/regen.ts";
import { PLAYER_SKILL_INFO_1_1, PlayerSkills, playerCreateSkillsFor, spellChangesFromEvents } from "../characters/skills.ts";
import { cancel, complete, request, type LogoutPacket } from "../characters/logout.ts";
import { saveCharacterState } from "../characters/persist.ts";
import { AccountTutorials, loadTutorials, saveTutorials } from "../characters/tutorials.ts";
import { applyOfflineRest, isResting, logoutRestSnapshot } from "../characters/rest.ts";
import { characterStartFromDbc } from "../characters/dbc-start.ts";
import { loadCharacterKit, type CharacterLoginKit } from "../characters/store.ts";
import { CLIENT_BUILD, findAccount, findCharacter, findCharacterById, listCharacters, type Character } from "../db.ts";
import { hexOpcode, log } from "../log.ts";
import { ByteReader, ByteWriter } from "../net/byte-buffer.ts";
import { fallDamage, farTeleportPackets, forceSpeedChangePacket, forceSpeedPacket, movementFlagsAllowed, movementKind, speedMoveType, movingOrTurning, nearTeleportPacket, readMoveInfo, shouldResetFall, speedVerdict, transportTooFar, writeMoveInfo } from "./movement.ts";
import { hearthTeleport, parseActivateTaxi, parseActivateTaxiExpress, spellTeleport, taxiTeleport } from "./teleport-start.ts";
import {
  CMSG_DELETEEQUIPMENT_SET,
  CMSG_EQUIPMENT_SET_SAVE,
  deleteSet,
  equipmentSetListPacket,
  loadSets,
  parseEquipmentSetDelete,
  parseEquipmentSetSave,
  saveSet,
} from "../items/equipment-sets.ts";
import { CMSG_DESTROYITEM, CMSG_SWAP_INV_ITEM, destroyItem, type Inventory } from "../items/bags.ts";
import { itemGuidRaw } from "../items/equipment-sets.ts";
import { spellRecoveryFromRecord, type SpellRecovery } from "../items/use-item.ts";
import { isChanneled, isPassive, isPositive, hasAttribute, type SpellStore } from "../spells/spell-info.ts";
import { readCastRequest, CMSG_CANCEL_AURA, CMSG_CANCEL_CAST, CMSG_CANCEL_CHANNELLING, SMSG_LEARNED_SPELL, type CastTargets } from "../spells/packets.ts";
import { SPELL_ATTR0_NO_AURA_CANCEL } from "../spells/defines.ts";
import { AURA_REMOVE_BY_CANCEL, CURRENT_CHANNELED_SPELL, MOVE_RUN } from "../spells/enums.ts";
import { loadSpellState, saveSpellState, type SavedAura, type SavedSpellCooldown } from "../spells/persist.ts";
import { auraUpdateAllPacket, SMSG_AURA_UPDATE_ALL } from "../spells/packets.ts";
import type { SpellMap, SpellUnit, UnitPosition } from "../spells/unit.ts";
import { CreatureSpellUnit } from "../combat/creature-spell-unit.ts";
import { PlayerSpellUnit } from "./player-spell-unit.ts";
import { loadPlayerAuras, loadPlayerCooldowns, savePlayerAuras, savePlayerCooldowns } from "./player-spell-state.ts";
import {
  BAG_OPCODES,
  handleBags,
  loadPlayInventory,
  loginItemPackets,
  savePlayInventory,
} from "./bags-play.ts";
import { EQUIP_OPCODES, handleEquip, visibleGearPacket } from "./equip-play.ts";
import { handleLoot, LOOT_OPCODES, lootItemProto, storeLootItem, type LootPlayCtx } from "./loot-play.ts";
import { createUseCooldowns, handleUseItem, USE_ITEM_OPCODES, type ItemCast, type UseCooldowns } from "./use-item-play.ts";
import { createVendorSession, handleVendor, VENDOR_OPCODES, type VendorSession } from "./vendor-play.ts";
import { QuestParty } from "./party.ts";
import { PlayerView } from "./players.ts";
import {
  CHAR_CREATE_ACCOUNT_LIMIT,
  CHAR_CREATE_FAILED,
  CHAR_CREATE_SUCCESS,
  CHAR_DELETE_FAILED,
  CHAR_DELETE_SUCCESS,
  charCreatePacket,
  charDeletePacket,
  type FactionSlot,
} from "./character-packets.ts";
import { fieldUpdateBlock, healthUpdateBlock, packedGuid as packedGuidOf, raceAppearance, standStateUpdateBlock, type PlayerFieldStats } from "./update-object.ts";
import { CMSG_PLAYER_LOGIN, worldOpcodeName } from "./opcodes.ts";
import { creatureQueryPayload, gameObjectQueryPayload, itemQueryPayload } from "./spawn.ts";
import { mapCreatureLocator, type CreatureLocator } from "./map-world.ts";
import { SessionMapPlayer } from "./session-map-player.ts";
import type { MovementOwner } from "../game/Movement/MovementOwner.ts";
import { addToMap, relocateOnMap, removeFromMap, showWorld } from "./session-map.ts";
import { creditKillPackets, fullQuestLog, Talk, talkDataFor } from "./talk.ts";
import { combatWorldFor, highGuidIsCreature, type CombatPlayer, type CombatWorld, type CreatureKill, type PlayerMelee } from "../combat/combat-world.ts";
import { CMSG_SET_SELECTION, CMSG_SETSHEATHED, POWER_RAGE, UNIT_FLAG_IN_COMBAT } from "../combat/constants.ts";
import { UNIT_FIELD_TARGET } from "../combat/packets.ts";
import { RACE_FACTION_TEMPLATE } from "../combat/faction.ts";
import { fillLoot, lootRates, lootStores } from "../loot/templates.ts";
import { Loot, type LootEnv, type LootPlayer } from "../loot/loot.ts";
import { ItemDbc, generateEnchSuffixFactorFor, generateItemRandomPropertyId } from "../items/item-dbc.ts";
import { getItemCount } from "../items/bags.ts";
import { meets } from "./gossip.ts";
import { urand } from "../common/random.ts";
import { SPELL_AURA_FEIGN_DEATH, SPELL_AURA_MOD_INVISIBILITY, SPELL_AURA_MOD_STEALTH } from "../spells/defines.ts";
import { UNIT_FLAG_LOOTING } from "../spells/enums.ts";
import {
  AUTH_FAILED,
  AUTH_BANNED,
  AUTH_OK,
  addonInfoPacket,
  accountDataTimesPacket,
  authChallengePacket,
  authResponsePacket,
  charEnumPacket,
  clientCacheVersionPacket,
  CMSG_AUTH_SESSION,
  CMSG_CHAR_CREATE,
  CMSG_CHAR_DELETE,
  CMSG_CHAR_ENUM,
  CMSG_ATTACKSTOP,
  CMSG_ATTACKSWING,
  CMSG_ACTIVATETAXI,
  CMSG_ACTIVATETAXIEXPRESS,
  CMSG_CAST_SPELL,
  CMSG_LOGOUT_CANCEL,
  CMSG_LOGOUT_REQUEST,
  CMSG_NAME_QUERY,
  CMSG_PING,
  CMSG_QUERY_TIME,
  CMSG_READY_FOR_ACCOUNT_DATA_TIMES,
  CMSG_REALM_SPLIT,
  CMSG_TIME_SYNC_RESP,
  CMSG_WORLD_STATE_UI_TIMER_UPDATE,
  CMSG_ZONEUPDATE,
  CMSG_CREATURE_QUERY,
  CMSG_GAMEOBJECT_QUERY,
  CMSG_ITEM_QUERY_SINGLE,
  CMSG_STANDSTATECHANGE,
  CMSG_TUTORIAL_CLEAR,
  CMSG_TUTORIAL_FLAG,
  CMSG_TUTORIAL_RESET,
  LOGIN_PACKET_NAMES,
  SMSG_CREATURE_QUERY_RESPONSE,
  SMSG_GAMEOBJECT_QUERY_RESPONSE,
  SMSG_ITEM_QUERY_SINGLE_RESPONSE,
  SMSG_STANDSTATE_UPDATE,
  SMSG_UPDATE_OBJECT,
  encodeServerPacket,
  loginPackets,
  type LoginCharacterState,
  nameQueryResponse,
  parseAuthSession,
  pongPacket,
  environmentalDamagePacket,
  queryTimeResponse,
  realmSplitPacket,
  relocationPackets,
  sessionDigest,
  timeSyncRequest,
  tutorialFlagsPacket,
  worldStateTimer,
} from "./packets.ts";

export type WorldResult = { packets: Uint8Array[]; sent: string[]; close: boolean; quiet?: boolean };

/** `LoginDatabase` for the account, `CharacterDatabase` for everything the player owns. */
export type SessionDatabases = { login: Db; characters: Db };

const HEARTBEAT = 0x0ee;
const TIME_SYNC_INTERVAL_MS = 10_000;

const INVENTORY_SLOT_BAG_0 = 255;

export class WorldSession {
  crypt: WorldCrypt | null = null;
  readonly seed = crypto.getRandomValues(new Uint8Array(4));
  accountId = 0;
  /** `WorldSession::_accountName` */
  accountName = "";
  /** `WorldSession::_security` (`account_access.gmlevel` for this realm). */
  security = SEC_PLAYER;
  /** `WorldSession::_RBACData` */
  rbacData: RBACData | null = null;
  /** `WorldSession::m_muteTime` */
  muteTime = 0;
  /** `WorldSession::m_sessionDbcLocale` / `m_sessionDbLocaleIndex` */
  locale = LOCALE_enUS;
  /** `WorldSession::_accountFlags` */
  accountFlags = 0;
  /** `WorldSession::m_expansion` */
  expansion = 2;
  /** `WorldSession::m_latency` */
  latency = 0;
  /** `WorldSession::_player` as the command code sees it. */
  playerFacade: SessionPlayer | null = null;
  /** `Player` state kept outside the character row (cheats, recall, whisper white list, AFK text). */
  commandState = new PlayerCommandState();
  /** Closes the socket (`KickPlayer`). */
  closeSocket: (() => void) | null = null;
  /** `WorldSession::_packetLogging` */
  packetLogging = false;
  /** `WorldSession::GetRemoteAddress` */
  remoteAddress = "";
  /** `WorldSession::m_Tutorials`, loaded at `CMSG_AUTH_SESSION` and saved with the character. */
  tutorials = new AccountTutorials();
  character: Character | null = null;
  kit: CharacterLoginKit | null = null;
  timeSyncCounter = 0;
  pendingTimeSync: number | null = 0;
  lastTimeSync = Date.now();
  orderCounter = 1;
  clientMoveTime = 0;
  fallbackHealth = 60;
  standState = -1;
  /** The player's unit/player update fields and stat modifiers (`Player` stat system). */
  stats: PlayerStats | null = null;
  skills: PlayerSkills | null = null;
  regen: PlayerRegen | null = null;
  /** `UNIT_FIELD_BYTES_0` display power from `ChrClasses.DisplayPower`. */
  powerType = 0;
  readonly env: PlayerEnvironment;
  lastFallZ = 0;
  lastFallTime = 0;
  clockDelta = 0;
  syncSentAt = 0;
  pendingTeleport: { map: number; x: number; y: number; z: number; orientation: number; far: boolean } | null = null;
  logoutTimer: ReturnType<typeof setTimeout> | null = null;
  inCombat = false;
  falling = false;
  deathState: DeathState = "alive";
  graveyards: GraveyardStore | null = null;
  resurrectRequest: ResurrectRequestData | null = null;
  /** The player on its map (the grid object the visibility notifiers work with); null while on no map. */
  mapPlayer: SessionMapPlayer | null = null;
  /** The zone and area state of the player (`m_zoneUpdateId`, the exploration check, the rest flags); null out of world. */
  area: PlayerAreaUpdates | null = null;
  /** Packets a map or area update queued while a handler runs (they go into its result, in order). */
  private captured: Uint8Array[] | null = null;
  inventory: Inventory | null = null;
  useCooldowns: UseCooldowns = createUseCooldowns();
  savedSpellCooldowns: SavedSpellCooldown[] = [];
  savedAuras: SavedAura[] = [];
  /** The player's `Unit` for spells and auras (null without a spell store or before the stats load). */
  unit: PlayerSpellUnit | null = null;
  /** Spell packets produced while no socket is attached (returned from the handler instead). */
  spellOutbox: Uint8Array[] = [];
  /** `Player::GetSelection` */
  selection = 0n;
  /** The spell map when there is no combat world (no spawns loaded): only this player. */
  soloMap: SpellMap | null = null;
  vendorSession: VendorSession = createVendorSession();
  /** `Player::m_lootGuid`: the corpse whose loot window is open. */
  lootGuid = 0n;
  readonly spellRecovery: ReadonlyMap<number, SpellRecovery>;
  /** The creatures of the loaded grids, for the combat code. */
  readonly spawns: CreatureLocator | null;
  deliver: ((packet: Uint8Array) => void) | null = null;
  readonly talk: Talk | null;
  /** Creature combat shared by every session on this spawn index (`Map` units, threat, and swing timers). */
  readonly combat: CombatWorld | null;
  /** Last `MovementInfo.flags` from the client, for the melee leeway range. */
  moveFlags = 0;
  readonly greeting: Uint8Array;

  /** `Player::SaveToDB` runs queued; the next save and the next packet wait for the previous one. */
  pendingSave: Promise<void> = Promise.resolve();
  /** `item_instance.durability` of the carried items, for `Item::IsBroken` in the stat system. */
  readonly itemDurability = new Map<number, number>();

  constructor(
    readonly db: SessionDatabases,
    readonly world: WorldData | null = null,
    spawns: CreatureLocator | null = null,
    readonly players: PlayerView = new PlayerView(),
    readonly dbc: DbcStores | null = null,
    readonly party: QuestParty = new QuestParty(),
    spellRecovery?: ReadonlyMap<number, SpellRecovery>,
    env?: PlayerEnvironment,
    readonly spellStore: SpellStore | null = null,
    readonly itemDbc: ItemDbc = ItemDbc.empty(),
  ) {
    this.env = env ?? defaultPlayerEnvironment();
    this.spawns = spawns ?? (world ? mapCreatureLocator : null);
    this.talk = world ? new Talk(talkDataFor(world).gossip, talkDataFor(world).quests, world, this.party) : null;
    this.spellRecovery = spellRecovery ?? spellRecoveryFromStores(dbc);
    this.combat = world && this.spawns ? combatWorldFor(world, this.spawns, worldDatabase(world), dbc) : null;
    if (this.combat && spellStore) this.combat.setSpellStore(spellStore);
    this.greeting = authChallengePacket(this.seed);
  }

  /** `CMSG_AUTH_SESSION` passed. AzerothCore creates the `WorldSession` at this point. */
  get authenticated(): boolean {
    return this.accountId !== 0;
  }

  /** Who this session is, for log lines: the character in world, else the account. */
  get label(): string {
    if (this.character) {
      return `[${this.character.name}]`;
    }
    return this.accountId ? `[account ${this.accountId}]` : "[unauthenticated]";
  }

  /** `GetPlayer()` is set. */
  get inWorld(): boolean {
    return this.character !== null;
  }

  attach(deliver: (packet: Uint8Array) => void): void {
    this.deliver = deliver;
  }

  /** `UNIT_FIELD_HEALTH`. Writes clamp to max health and reach the client with the next field flush. */
  get health(): number {
    return this.stats ? this.stats.health : this.fallbackHealth;
  }

  set health(value: number) {
    if (this.stats) {
      this.stats.setHealth(value);
    } else {
      this.fallbackHealth = Math.max(0, Math.trunc(value));
    }
  }

  get maxHealth(): number {
    return this.stats ? this.stats.maxHealth : 60;
  }

  /**
   * The session's part of `Map::Update` → `Player::Update`: regeneration, then the combat tick, then the
   * changed update fields go out to the player and to everyone who sees them.
   */
  update(diff: number): void {
    if (!this.crypt || !this.character) {
      return;
    }
    this.updateRegen(diff);
    // `Unit::Update`: spell events, current spells, and auras.
    this.unit?.updateSpellsAndAuras(diff);
    this.updateCombat(diff);
    this.area?.update(diff);
    this.flushFields();
  }

  updateRegen(diff: number): void {
    const stats = this.stats;
    const regen = this.regen;
    const character = this.character;
    if (!stats || !regen || !character || !this.crypt) {
      return;
    }
    const updates = regen.update(diff, this.deathState === "alive", {
      inCombat: this.inCombat,
      standing: isStandState(this.standState < 0 ? 0 : this.standState),
      recentManaUse: false,
    });
    for (const update of updates) {
      const body = powerUpdatePacket(character.guid, update.power, update.value);
      this.deliver?.(encodeServerPacket(SMSG_POWER_UPDATE, body));
      this.players.broadcast(character.guid, SMSG_POWER_UPDATE, body);
    }
  }

  /** Values updates for the fields `PlayerStats` and `PlayerSkills` changed since the last flush. */
  fieldUpdates(): { self: Uint8Array | null; others: Uint8Array | null } {
    const character = this.character;
    if (!character) {
      return { self: null, others: null };
    }
    const fields: { index: number; value: number }[] = [];
    if (this.stats) {
      for (const index of this.stats.takeChanged()) {
        fields.push({ index, value: this.stats.getUInt32(index) });
      }
    }
    if (this.skills) {
      const values = this.skills.fieldValues();
      for (const offset of this.skills.flushChangedFields()) {
        fields.push({ index: PLAYER_SKILL_INFO_1_1 + offset, value: values[offset] ?? 0 });
      }
    }
    if (fields.length === 0) {
      return { self: null, others: null };
    }
    const visible = fields.filter((field) => PUBLIC_STAT_FIELDS.has(field.index));
    return {
      self: fieldUpdateBlock(character.guid, fields),
      others: visible.length > 0 ? fieldUpdateBlock(character.guid, visible) : null,
    };
  }

  /** Sends the pending field changes now (tick path). */
  flushFields(): void {
    const character = this.character;
    if (!character || !this.crypt) {
      return;
    }
    const updates = this.fieldUpdates();
    if (updates.self) {
      this.deliver?.(encodeServerPacket(SMSG_UPDATE_OBJECT, updates.self));
    }
    if (updates.others) {
      this.players.broadcast(character.guid, SMSG_UPDATE_OBJECT, updates.others);
    }
  }

  /** What other players' create block carries for this player: the PUBLIC unit fields only. */
  publicFieldStats(): PlayerFieldStats | undefined {
    const stats = this.stats;
    const character = this.character;
    if (!stats || !character) {
      return undefined;
    }
    const powerType = this.powerType;
    return {
      health: stats.health,
      maxHealth: stats.maxHealth,
      powerType,
      power: stats.power(powerType),
      maxPower: stats.maxPower(powerType),
      fields: stats.fieldEntries(PUBLIC_STAT_FIELDS),
    };
  }

  /** Kill, quest, and exploration XP (`Player::GiveXP`). Returns the packets for the player. */
  grantXp(amount: number, victim: bigint | null): { opcode: number; name: string; body: Uint8Array }[] {
    const ctx = this.progressContext();
    if (!ctx) {
      return [];
    }
    const before = ctx.character.level;
    const packets = giveXp(ctx, amount, victim);
    if (this.character && this.character.level !== before) {
      this.talk?.syncSpeaker(this.character);
      sCharacterCache.updateCharacterLevel(this.character.guid, this.character.level);
    }
    return packets;
  }

  progressContext(): ProgressContext | null {
    const character = this.character;
    const stats = this.stats;
    const worldDb = worldDatabase(this.world);
    if (!character || !stats || !worldDb) {
      return null;
    }
    const skills = this.skills;
    return {
      stats,
      character,
      maxLevel: this.env.maxLevel,
      xpForLevel: (level) => xpForLevel(worldDb, level),
      levelStats: (level) => levelStatsFor(worldDb, character.race, character.class, level),
      alive: this.deathState === "alive",
      talentRate: this.env.talentRate,
      updateSkillsForLevel: skills ? (level) => {
        skills.level = level;
        skills.updateSkillsForLevel(level);
      } : undefined,
      updateSkillsToMaxSkillsForLevel:
        skills && this.env.skillConfig.alwaysMaxWeaponSkill ? () => skills.updateSkillsToMaxSkillsForLevel() : undefined,
    };
  }

  /** Socket closed. The player is saved and removed, same as `LogoutPlayer(true)` from `~WorldSession`. */
  disconnect(): Promise<void> {
    this.clearLogoutTimer();
    if (this.character) {
      this.character.health = this.health;
      this.applyLogoutRest(this.character);
      this.saveLoggedInCharacter(this.character);
    }
    this.leaveWorld();
    return this.pendingSave;
  }

  /** Resolves once every queued character save has reached the database. */
  flushSaves(): Promise<void> {
    return this.pendingSave;
  }

  async handle(opcode: number, payload: Uint8Array): Promise<WorldResult> {
    const result = await this.handleOpcode(opcode, payload);
    await this.pendingSave;
    if (!this.stats || !this.character || !this.crypt) {
      return result;
    }
    if (BAG_OPCODES.has(opcode) || EQUIP_OPCODES.has(opcode) || VENDOR_OPCODES.has(opcode) || LOOT_OPCODES.has(opcode) || USE_ITEM_OPCODES.has(opcode)) {
      await this.refreshItemDurability();
      this.syncEquipmentStats();
    }
    const updates = this.fieldUpdates();
    if (updates.self) {
      result.packets.push(encodeServerPacket(SMSG_UPDATE_OBJECT, updates.self));
      result.sent.push("SMSG_UPDATE_OBJECT");
      result.quiet = false;
    }
    if (updates.others) {
      this.players.broadcast(this.character.guid, SMSG_UPDATE_OBJECT, updates.others);
    }
    return result;
  }

  async handleOpcode(opcode: number, payload: Uint8Array): Promise<WorldResult> {
    if (CHAT_OPCODES.has(opcode)) {
      return this.handleChat(opcode, payload);
    }
    const talked = this.handleTalk(opcode, payload);
    if (talked) {
      return talked;
    }
    const played = await this.handlePlay(opcode, payload);
    if (played) {
      return played;
    }
    switch (opcode) {
      case CMSG_AUTH_SESSION:
        return this.handleAuthSession(payload);
      case CMSG_CHAR_ENUM:
        return this.handleCharEnum();
      case CMSG_CHAR_CREATE:
        return this.handleCharCreate(payload);
      case CMSG_CHAR_DELETE:
        return this.handleCharDelete(payload);
      case CMSG_PING:
        return this.handlePing(payload);
      case CMSG_PLAYER_LOGIN:
        return this.handlePlayerLogin(payload);
      case CMSG_REALM_SPLIT:
        return this.handleRealmSplit(payload);
      case CMSG_READY_FOR_ACCOUNT_DATA_TIMES:
        return this.handleAccountDataTimes();
      case CMSG_NAME_QUERY:
        return this.handleNameQuery(payload);
      case CMSG_CREATURE_QUERY:
        return this.handleCreatureQuery(payload);
      case CMSG_GAMEOBJECT_QUERY:
        return this.handleGameObjectQuery(payload);
      case CMSG_ITEM_QUERY_SINGLE:
        return this.handleItemQuery(payload);
      case CMSG_QUERY_TIME:
        return this.handleQueryTime();
      case CMSG_ZONEUPDATE:
        return this.handleZoneUpdate(payload);
      case CMSG_WORLD_STATE_UI_TIMER_UPDATE:
        return this.handleWorldStateTimer();
      case CMSG_TIME_SYNC_RESP:
        return this.handleTimeSync(payload);
      case CMSG_LOGOUT_REQUEST:
        return this.handleLogout();
      case CMSG_LOGOUT_CANCEL:
        return this.handleLogoutCancel();
      case CMSG_SET_SELECTION:
        return this.handleSetSelection(payload);
      case CMSG_ATTACKSWING:
        return this.handleAttackSwing(payload);
      case CMSG_ATTACKSTOP:
        return this.handleAttackStop();
      case CMSG_SETSHEATHED:
        return this.handleSetSheathed(payload);
      case CMSG_REPOP_REQUEST:
        return this.handleRepop();
      case CMSG_RECLAIM_CORPSE:
        return this.handleReclaimCorpse();
      case CMSG_RESURRECT_RESPONSE:
        return this.handleResurrect(payload);
      case CMSG_SPIRIT_HEALER_ACTIVATE:
        return this.handleSpiritHealer();
      case MSG_CORPSE_QUERY:
        return this.handleCorpseQuery();
      case CMSG_EQUIPMENT_SET_SAVE:
        return this.handleEquipmentSetSave(payload);
      case CMSG_DELETEEQUIPMENT_SET:
        return this.handleEquipmentSetDelete(payload);
      case CMSG_CAST_SPELL:
        return this.handleCastSpell(payload);
      case CMSG_CANCEL_CAST:
      case CMSG_CANCEL_CHANNELLING:
        return this.handleCancelCast(payload, opcode === CMSG_CANCEL_CAST);
      case CMSG_CANCEL_AURA:
        return this.handleCancelAura(payload);
      case CMSG_ACTIVATETAXI:
        return this.handleActivateTaxi(payload, false);
      case CMSG_ACTIVATETAXIEXPRESS:
        return this.handleActivateTaxi(payload, true);
      case CMSG_STANDSTATECHANGE:
        return this.handleStandState(payload);
      case CMSG_TUTORIAL_FLAG:
      case CMSG_TUTORIAL_CLEAR:
      case CMSG_TUTORIAL_RESET:
        return this.handleTutorial(opcode, payload);
      default: {
        const kind = movementKind(opcode);
        if (kind) {
          return this.handleMovement(opcode, kind, payload);
        }
        return { packets: [], sent: [], close: false };
      }
    }
  }

  async handleCharEnum(): Promise<WorldResult> {
    if (!this.crypt) {
      return { packets: [], sent: [], close: true };
    }
    const characters = await listCharacters(this.db.characters, this.accountId);
    const worldDb = worldDatabase(this.world);
    const gearByGuid = new Map<number, Awaited<ReturnType<typeof loadCharEnumGear>>>();
    if (worldDb) {
      for (const character of characters) {
        gearByGuid.set(character.guid, await loadCharEnumGear(this.db.characters, worldDb, character.guid));
      }
    }
    // `CHAR_SEL_ENUM` joins the active `character_banned` rows (`CHARACTER_FLAG_LOCKED_BY_BILLING`).
    const banned = new Set<number>();
    for (const character of characters) {
      const [row] = await queryFields(this.db.characters, "SELECT guid FROM character_banned WHERE guid = ? AND active = 1", character.guid);
      if (row) banned.add(character.guid);
    }
    log("world", `sending SMSG_CHAR_ENUM with ${characters.length} character(s)`);
    const declinedNames = sWorld().getBoolConfig(ServerConfig.CONFIG_DECLINED_NAMES_USED);
    return { packets: [charEnumPacket(this.crypt, characters, gearByGuid, banned, declinedNames)], sent: ["SMSG_CHAR_ENUM"], close: false };
  }

  async handleAuthSession(payload: Uint8Array): Promise<WorldResult> {
    if (this.crypt) {
      log("world", "duplicate CMSG_AUTH_SESSION, closing");
      return { packets: [], sent: [], close: true };
    }
    const packet = parseAuthSession(payload);
    if (!packet) {
      log("world", "malformed CMSG_AUTH_SESSION, closing");
      return { packets: [], sent: [], close: true };
    }
    const account = await findAccount(this.db.login, upperLatin(packet.account));
    if (!account?.session_key || packet.build !== CLIENT_BUILD || packet.realmId !== 1) {
      log(
        "world",
        `rejecting ${packet.account}: build=${packet.build} realm=${packet.realmId} account=${account ? "found" : "missing"} sessionKey=${account?.session_key ? "yes" : "no"}`,
      );
      return { packets: [], sent: [], close: true };
    }
    this.crypt = new WorldCrypt(account.session_key);
    const digest = sessionDigest(packet.account, packet.clientSeed, this.seed, account.session_key);
    if (!equalBytes(digest, packet.digest)) {
      log("world", `bad session digest for ${packet.account}, closing`);
      return { packets: [authResponsePacket(this.crypt, AUTH_FAILED)], sent: ["SMSG_AUTH_RESPONSE"], close: true };
    }
    const info = await this.loadAccountInfo(packet.account);
    if (info.banned) {
      log("world", "WorldSocket::HandleAuthSession: Sent Auth Response (Account banned).");
      return { packets: [authResponsePacket(this.crypt, AUTH_BANNED)], sent: ["SMSG_AUTH_RESPONSE"], close: true };
    }
    this.accountId = account.id;
    this.accountName = packet.account;
    await this.loadPermissions();
    this.validateAccountFlags();
    log("world", `${packet.account} authenticated, account id ${account.id}`);
    const packets = [authResponsePacket(this.crypt, AUTH_OK)];
    const sent = ["SMSG_AUTH_RESPONSE"];
    const addons = addonInfoPacket(this.crypt, packet.addonInfo);
    if (addons) {
      packets.push(addons);
      sent.push("SMSG_ADDON_INFO");
    }
    packets.push(clientCacheVersionPacket(this.crypt));
    sent.push("SMSG_CLIENTCACHE_VERSION");
    this.tutorials = await loadTutorials(this.db.characters, this.accountId);
    packets.push(tutorialFlagsPacket(this.crypt, this.tutorials.values));
    sent.push("SMSG_TUTORIAL_FLAGS");
    return { packets, sent, close: false };
  }

  async handlePlayerLogin(payload: Uint8Array): Promise<WorldResult> {
    if (!this.crypt || payload.length < 8) {
      return { packets: [], sent: [], close: true };
    }
    const guid = new ByteReader(payload).readU64();
    const character = await findCharacter(this.db.characters, this.accountId, Number(guid & 0xffffffffn));
    if (!character) {
      log("world", `CMSG_PLAYER_LOGIN rejected, guid ${guid} is not on this account`);
      return { packets: [], sent: [], close: true };
    }
    const playing = { ...character };
    this.applyOfflineRestOnLogin(playing);
    // `Player::LoadCorpse`: a character revived offline (`Player::OfflineResurrect`) comes back at half health.
    if (playing.at_login & AT_LOGIN_RESURRECT) {
      playing.at_login &= ~AT_LOGIN_RESURRECT;
      if ((playing.playerFlags & PLAYER_FLAGS_GHOST) !== 0 || playing.health <= 0) {
        playing.playerFlags &= ~PLAYER_FLAGS_GHOST;
        const maxHealth = this.world?.playerStart(playing.race, playing.class, playing.level)?.stats.health ?? 2;
        playing.health = Math.max(1, Math.floor(maxHealth * 0.5));
      }
    }
    this.deathState = (playing.playerFlags & PLAYER_FLAGS_GHOST) !== 0 ? "dead" : playing.health <= 0 ? "corpse" : "alive";
    this.character = playing;
    this.timeSyncCounter = 0;
    this.pendingTimeSync = 0;
    this.lastTimeSync = Date.now();
    this.syncSentAt = performance.now();
    const login = await this.prepareLogin(playing);
    this.health = login.stats?.health ?? playing.health;
    this.standState = -1;
    this.lastFallZ = playing.position_z;
    this.lastFallTime = 0;
    this.clockDelta = 0;
    this.pendingTeleport = null;
    log("world", `${playing.name} entering map ${playing.map}`);
    await this.talk?.login(this.db.characters, playing);
    const worldDb = worldDatabase(this.world);
    this.inventory = await loadPlayInventory(this.db.characters, playing.guid, worldDb);
    await this.refreshItemDurability();
    this.useCooldowns = createUseCooldowns();
    this.vendorSession = createVendorSession();
    this.lootGuid = 0n;
    await this.loadPlayerUnit(playing, login);
    this.commandState = new PlayerCommandState();
    this.commandState.charSettingsMap = await LoadCharacterSettings(this.db.characters, playing.guid);
    this.playerFacade = new SessionPlayer(this);
    this.area = new PlayerAreaUpdates(createAreaHost(this));
    this.initCommandFields(playing);
    this.restoreGmState(playing);
    if (this.stats && login.stats) {
      // The login create block carries the fields the GM state and `InitDisplayIds` just set.
      const fresh = this.stats.fieldEntries();
      const freshIndexes = new Set(fresh.map((field) => field.index));
      login.stats.fields = [...(login.stats.fields ?? []).filter((field) => !freshIndexes.has(field.index)), ...fresh];
      this.stats.takeChanged();
    }
    const burst = loginPackets(this.crypt, playing, login);
    const names = [...LOGIN_PACKET_NAMES];
    // `HandlePlayerLoginFromDB`: Send MOTD, after SMSG_FEATURE_SYSTEM_STATUS.
    const motdAt = names.indexOf("SMSG_FEATURE_SYSTEM_STATUS") + 1;
    burst.splice(motdAt, 0, encodeServerPacket(SMSG_MOTD, sMotdMgr.GetMotdPacket(this.getSessionDbLocaleIndex())));
    names.splice(motdAt, 0, "SMSG_MOTD");
    // `Map::AddPlayerToMap`: the player is on the map and sees what is near (`SendInitialPacketsAfterAddToMap`)
    this.registerOnline(playing);
    addToMap(this);
    const entered = this.withVisible(burst, names);
    // `Player::SendInitialPacketsAfterAddToMap`: update zone (the world states, the area flags)
    this.appendCaptured(entered, () => this.area?.updateZoneAfterAddToMap());
    for (const extra of this.talk?.loginUpdate(playing) ?? []) {
      entered.packets.push(encodeServerPacket(extra.opcode, extra.body));
      entered.sent.push(extra.name);
    }
    this.appendPlay(entered, loginItemPackets(playing.guid, this.inventory, worldDb));
    const visibleAuras = this.unit?.visibleAuraUpdates() ?? [];
    if (visibleAuras.length) {
      const body = auraUpdateAllPacket(BigInt(playing.guid), visibleAuras);
      this.appendPlay(entered, [{ opcode: SMSG_AURA_UPDATE_ALL, name: "SMSG_AURA_UPDATE_ALL", body }]);
    }
    if (hasEquippedItem(this.inventory)) {
      const gear = visibleGearPacket(playing.guid, this.inventory, worldDb);
      if (gear) {
        this.appendPlay(entered, [gear]);
      }
    }
    return entered;
  }

  /**
   * The stat and skill part of `Player::LoadFromDB`: `_LoadSkills`, `InitStatsForLevel`, `LearnDefaultSkills`,
   * the equipped items' `_ApplyItemMods`, `UpdateAllStats`, then the saved health and power clamped to the new max.
   */
  async loadPlayerUnit(character: Character, login: LoginCharacterState): Promise<void> {
    this.stats = null;
    this.skills = null;
    this.regen = null;
    this.unit = null;
    if (this.talk) {
      this.talk.giveXp = null;
    }
    const worldDb = worldDatabase(this.world);
    if (!worldDb) {
      return;
    }
    const levelStats = levelStatsFor(worldDb, character.race, character.class, character.level);
    if (!levelStats) {
      return;
    }
    const skills = new PlayerSkills(
      { race: character.race, classId: character.class, level: character.level },
      { data: this.env.skillData, config: this.env.skillConfig },
    );
    await skills.loadFromDb(this.db.characters, character.guid);
    skills.updateSkillsForLevel(character.level);
    skills.learnDefaultSkills(playerCreateSkillsFor(this.env.createSkills, character.race, character.class));
    const learned = spellChangesFromEvents(skills.drainEvents()).learn;
    if (learned.length > 0) {
      login.spells = [...new Set([...login.spells, ...learned])].sort((left, right) => left - right);
    }
    const effects = learnedSpellEffects(this.dbc, login.spells);
    const savedHealth = this.health;
    const stats = new PlayerStats({
      race: character.race,
      classId: character.class,
      level: character.level,
      maxLevel: this.env.maxLevel,
      levelStats,
      stores: this.env.statStores,
      skills: { skillValue: (id) => skills.getSkillValue(id), maxSkillValue: (id) => skills.getMaxSkillValue(id) },
      limits: this.env.limits,
      canParry: effects.has(SPELL_EFFECT_PARRY),
      canBlock: effects.has(SPELL_EFFECT_BLOCK),
      canDualWield: effects.has(SPELL_EFFECT_DUAL_WIELD),
    });
    stats.loadEquipment(this.equippedStatItems());
    stats.setHealth(savedHealth);
    const saved = [character.power1, character.power2, character.power3, character.power4, character.power5, character.power6, character.power7];
    saved.forEach((value, power) => stats.setPower(power, value));
    this.stats = stats;
    this.skills = skills;
    this.regen = new PlayerRegen(stats, this.env.regenRates);
    if (this.spellStore) {
      const unit = new PlayerSpellUnit(BigInt(character.guid), this.playerHost(character), stats);
      this.unit = unit;
      const nowSeconds = Math.floor(Date.now() / 1000);
      loadPlayerCooldowns(unit, this.savedSpellCooldowns, nowSeconds);
      loadPlayerAuras(unit, this.savedAuras, Math.max(0, nowSeconds - (character.logout_time ?? nowSeconds)));
      this.savedAuras = [];
    }
    const ctx = this.progressContext();
    if (ctx) {
      initXpFields(ctx);
    }
    const skillValues = skills.fieldValues();
    const fields = stats.fieldEntries();
    skillValues.forEach((value, offset) => {
      if (value !== 0) {
        fields.push({ index: PLAYER_SKILL_INFO_1_1 + offset, value });
      }
    });
    const powerType = login.stats?.powerType ?? 0;
    this.powerType = powerType;
    login.stats = {
      health: stats.health,
      maxHealth: stats.maxHealth,
      powerType,
      power: stats.power(powerType),
      maxPower: stats.maxPower(powerType),
      fields,
    };
    stats.takeChanged();
    skills.flushChangedFields();
    skills.inWorld = true;
    if (this.talk) {
      this.talk.giveXp = (amount) => this.grantXp(Math.trunc(amount * this.env.xpRates.quest), null);
    }
  }

  /** Equipment slots 0-18 of the backpack bag, with their `item_template` rows and broken state. */
  equippedStatItems(): Map<number, EquippedStatItem> {
    const out = new Map<number, EquippedStatItem>();
    const worldDb = worldDatabase(this.world);
    const equipment = this.inventory?.slots.get(0);
    if (!worldDb || !equipment) {
      return out;
    }
    for (const [slot, item] of equipment) {
      if (slot >= 19) {
        continue;
      }
      const row = worldDb.first(item_template, "entry", item.entry);
      if (!row) {
        continue;
      }
      out.set(slot, {
        guid: item.guid,
        template: statItemFromRow(row as unknown as Record<string, unknown>),
        broken: this.itemBroken(item.guid, row.MaxDurability),
      });
    }
    return out;
  }

  /** `Item::IsBroken` from the saved `item_instance.durability`. */
  itemBroken(itemGuid: number, maxDurability: number): boolean {
    if (maxDurability <= 0) {
      return false;
    }
    return this.itemDurability.get(itemGuid) === 0;
  }

  /** Reloads `item_instance.durability` for everything in the inventory. */
  async refreshItemDurability(): Promise<void> {
    this.itemDurability.clear();
    const guids = this.inventory ? [...this.inventory.byGuid.keys()] : [];
    if (guids.length === 0) {
      return;
    }
    const rows = await this.db.characters
      .select({ guid: item_instance.guid, durability: item_instance.durability })
      .from(item_instance)
      .where(inArray(item_instance.guid, guids));
    for (const row of rows) {
      this.itemDurability.set(row.guid, row.durability);
    }
  }

  /**
   * After a bag, equip, vendor, or loot packet: equipment slots whose item or broken state changed go through
   * `_ApplyItemMods` (remove, then apply), like `EquipItem` / `RemoveItem` / `DurabilityPointsLoss`.
   */
  syncEquipmentStats(): void {
    const stats = this.stats;
    if (!stats) {
      return;
    }
    const now = this.equippedStatItems();
    for (let slot = 0; slot < 19; slot++) {
      const before = stats.equippedItem(slot);
      const after = now.get(slot);
      if (!before && !after) {
        continue;
      }
      if (before && after && before.guid === after.guid && before.template.entry === after.template.entry) {
        if (before.broken !== after.broken) {
          stats.setBroken(slot, after.broken);
        }
        continue;
      }
      if (before) {
        stats.unequip(slot);
      }
      if (after) {
        stats.equip(slot, after);
      }
    }
  }

  async prepareLogin(character: Character): Promise<LoginCharacterState> {
    const start = this.world?.playerStart(character.race, character.class, character.level) ?? null;
    let kit = await loadCharacterKit(this.db.characters, character.guid);
    const fresh = Boolean(start && !kit.homebind);
    const knownSkills = start?.skills ?? kit.skills;
    if (fresh && start) {
      const seeded = this.applyDbc(
        kitFromStart(start),
        character.race,
        character.class,
        character.gender,
        character.level,
        knownSkills,
      ).kit;
      if (seeded.homebind) {
        await ensureStartingKit(
          this.db.characters,
          character.guid,
          { ...seeded, homebind: seeded.homebind },
          start.stats.health,
        );
      }
      character.health = start.stats.health;
      kit = await loadCharacterKit(this.db.characters, character.guid);
    }
    const enriched = this.applyDbc(kit, character.race, character.class, character.gender, character.level, knownSkills);
    kit = enriched.kit;
    this.kit = kit;
    const spellState = await loadSpellState(this.db.characters, character.guid);
    this.savedAuras = spellState.auras;
    this.savedSpellCooldowns = spellState.cooldowns.filter((cooldown) => cooldown.time * 1000 > Date.now());
    const stats: PlayerFieldStats | undefined = start
      ? {
          health: character.health > 0 ? character.health : start.stats.health,
          maxHealth: start.stats.health,
          powerType: start.stats.powerType,
          power: fresh ? start.stats.power : storedPower(character, start.stats.powerType),
          maxPower: start.stats.maxPower,
          attributes: {
            strength: start.stats.strength,
            agility: start.stats.agility,
            stamina: start.stats.stamina,
            intellect: start.stats.intellect,
            spirit: start.stats.spirit,
          },
          skills: kit.skills,
        }
      : undefined;
    if (stats && fresh) {
      character.power1 = 0;
      character.power2 = 0;
      character.power3 = 0;
      character.power4 = 0;
      character.power5 = 0;
      character.power6 = 0;
      character.power7 = 0;
      const powerSlot = stats.powerType + 1;
      if (powerSlot === 1) {
        character.power1 = stats.power;
      } else if (powerSlot === 2) {
        character.power2 = stats.power;
      } else if (powerSlot === 3) {
        character.power3 = stats.power;
      } else if (powerSlot === 4) {
        character.power4 = stats.power;
      } else if (powerSlot === 5) {
        character.power5 = stats.power;
      } else if (powerSlot === 6) {
        character.power6 = stats.power;
      } else if (powerSlot === 7) {
        character.power7 = stats.power;
      }
    }
    const homebind = kit.homebind
      ? { mapId: kit.homebind.mapId, zoneId: kit.homebind.zoneId, x: kit.homebind.posX, y: kit.homebind.posY, z: kit.homebind.posZ }
      : null;
    return {
      spells: kit.spells,
      cooldowns: this.savedSpellCooldowns.filter((row) => row.needSend !== 0).map((row) => ({
        spell: row.spell,
        item: row.item,
        category: row.category,
        remaining: Math.max(0, row.time * 1000 - Date.now()),
      })),
      actions: kit.actions,
      homebind,
      factions: enriched.slots,
      stats,
      equipmentSetList: await this.equipmentSetList(character.guid),
    };
  }

  applyDbc(
    kit: CharacterLoginKit,
    race: number,
    classId: number,
    gender: number,
    level: number,
    knownSkills: readonly { skill: number; value: number; max: number }[],
  ): { kit: CharacterLoginKit; slots: FactionSlot[] } {
    if (!this.dbc) {
      return { kit, slots: [] };
    }
    const fromDbc = characterStartFromDbc(this.dbc, race, classId, gender, level, knownSkills);
    const spells = [...new Set([...kit.spells, ...fromDbc.spells])].sort((left, right) => left - right);
    const skills = fromDbc.skills.length > 0 ? fromDbc.skills : kit.skills;
    const listByFaction = new Map(fromDbc.factions.map((row) => [row.faction, row.listId]));
    const factions =
      kit.factions.length > 0
        ? kit.factions
        : fromDbc.factions.map((row) => ({ faction: row.faction, standing: row.standing, flags: row.flags }));
    const slots: FactionSlot[] = [];
    for (const row of factions) {
      const index = listByFaction.get(row.faction);
      if (index === undefined || index < 0 || index >= 128) {
        continue;
      }
      slots.push({ index, flags: row.flags, standing: row.standing });
    }
    return {
      kit: { spells, actions: kit.actions, skills, factions, homebind: kit.homebind },
      slots,
    };
  }

  /**
   * `Player::SaveToDB`: the row, kit, quests, auras, cooldowns, and inventory as they are now, queued behind the
   * previous save. Callers in the world tick do not wait; `handle` waits before it answers the packet.
   */
  saveLoggedInCharacter(character: Character): void {
    const current = this.character?.guid === character.guid;
    // Player::_SavePlayerSettings
    if (current && this.commandState) SavePlayerSettings(this.db.characters, character.guid, this.commandState.charSettingsMap);
    const kit = this.kit ? { ...this.kit, skills: [...this.kit.skills] } : null;
    if (current && kit) {
      this.syncUnitToCharacter(character, kit);
    }
    const row = { ...character };
    const unit = current ? this.unit : null;
    const auras = unit ? savePlayerAuras(unit, row.guid) : [...this.savedAuras];
    const cooldowns = unit ? savePlayerCooldowns(unit, row.guid, Math.floor(Date.now() / 1000)) : [...this.savedSpellCooldowns];
    const inventory = current ? this.inventory : null;
    const talk = this.talk;
    const db = this.db.characters;
    const tutorials = this.tutorials;
    const accountId = this.accountId;
    this.pendingSave = this.pendingSave
      .then(async () => {
        await talk?.save(db, row.guid);
        await saveCharacterState(db, row, kit ?? (await loadCharacterKit(db, row.guid)));
        await saveSpellState(db, row.guid, auras, cooldowns);
        if (inventory) {
          await savePlayInventory(db, row.guid, inventory);
        }
        // `Player::SaveToDB` -> `WorldSession::SaveTutorialsData` (changed only while the character is in game).
        await saveTutorials(db, accountId, tutorials);
      })
      .catch((error: unknown) => logError("world", `saving ${row.name} failed`, error));
  }

  /** `_SaveToDB` reads health, `power1..7`, and the skill rows off the live unit. */
  syncUnitToCharacter(character: Character, kit: CharacterLoginKit): void {
    const stats = this.stats;
    if (stats) {
      character.health = stats.health;
      character.power1 = stats.power(0);
      character.power2 = stats.power(1);
      character.power3 = stats.power(2);
      character.power4 = stats.power(3);
      character.power5 = stats.power(4);
      character.power6 = stats.power(5);
      character.power7 = stats.power(6);
    }
    if (this.skills) {
      kit.skills = this.skills.rows();
    }
  }

  appendPlay(
    entered: { packets: Uint8Array[]; sent: string[] },
    rows: { opcode: number; name: string; body: Uint8Array }[],
  ): void {
    if (!this.crypt) {
      return;
    }
    for (const row of rows) {
      entered.packets.push(encodeServerPacket(row.opcode, row.body));
      entered.sent.push(row.name);
    }
  }

  /** Bags, equip, item use, vendor, and loot. Bodies stay unencrypted until here. */
  async handlePlay(opcode: number, payload: Uint8Array): Promise<WorldResult | null> {
    const character = this.character;
    const inventory = this.inventory;
    if (!this.crypt || !character || !inventory) {
      return null;
    }
    const world = worldDatabase(this.world);
    let result: { packets: { opcode: number; name: string; body: Uint8Array }[]; money?: number; cast?: ItemCast } | null = null;
    if (BAG_OPCODES.has(opcode)) {
      result = await handleBags(opcode, payload, {
        db: this.db.characters,
        world,
        playerGuid: character.guid,
        money: character.money,
        inventory,
      });
    } else if (EQUIP_OPCODES.has(opcode)) {
      result = await handleEquip(opcode, payload, {
        db: this.db.characters,
        world,
        playerGuid: character.guid,
        race: character.race,
        classId: character.class,
        level: character.level,
        inventory,
      });
    } else if (USE_ITEM_OPCODES.has(opcode)) {
      result = await handleUseItem(opcode, payload, {
        db: this.db.characters,
        world,
        playerGuid: character.guid,
        nowMs: Date.now(),
        inventory,
        spellRecovery: this.spellRecovery,
        spellStore: this.spellStore,
        cooldowns: this.useCooldowns,
        deferCast: !!this.spellStore,
      });
      if (result?.cast) return this.castSpellRequest(result.cast.castCount, result.cast.spellId, result.cast.targets, result.cast);
    } else if (VENDOR_OPCODES.has(opcode)) {
      result = await handleVendor(
        opcode,
        payload,
        {
          db: this.db.characters,
          world,
          playerGuid: character.guid,
          money: character.money,
          inventory,
        },
        this.vendorSession,
      );
    } else if (LOOT_OPCODES.has(opcode)) {
      const ctx = this.lootContext(character, inventory);
      const packets = await handleLoot(opcode, payload, ctx);
      this.lootGuid = ctx.lootGuid;
      result = packets ? { packets, money: ctx.money } : null;
    } else {
      return null;
    }
    if (!result) {
      return null;
    }
    if (result.money !== undefined) {
      character.money = result.money;
    }
    this.saveLoggedInCharacter(character);
    return {
      packets: result.packets.map((row) => encodeServerPacket(row.opcode, row.body)),
      sent: result.packets.map((row) => row.name),
      close: false,
      quiet: result.packets.length === 0,
    };
  }

  /** `Map::Update` for creatures and the melee swing timers. The first session to tick advances the shared world. */
  updateCombat(_diff: number): void {
    this.combat?.update(Date.now());
  }

  /** `WorldSession::HandleSetSelectionOpcode` → `Player::SetSelection` (`UNIT_FIELD_TARGET`). */
  handleSetSelection(payload: Uint8Array): WorldResult {
    const quiet = { packets: [] as Uint8Array[], sent: [] as string[], close: false, quiet: true };
    const character = this.character;
    if (!character || !this.crypt || payload.length < 8) {
      return quiet;
    }
    const guid = new ByteReader(payload).readU64();
    this.selection = guid;
    const block = fieldUpdateBlock(character.guid, [
      { index: UNIT_FIELD_TARGET, value: Number(guid & 0xffffffffn) },
      { index: UNIT_FIELD_TARGET + 1, value: Number((guid >> 32n) & 0xffffffffn) },
    ]);
    this.players.broadcast(character.guid, SMSG_UPDATE_OBJECT, block);
    return { packets: [encodeServerPacket(SMSG_UPDATE_OBJECT, block)], sent: ["SMSG_UPDATE_OBJECT"], close: false };
  }

  /** `WorldSession::HandleAttackSwingOpcode` */
  handleAttackSwing(payload: Uint8Array): WorldResult {
    const quiet = { packets: [] as Uint8Array[], sent: [] as string[], close: false, quiet: true };
    if (!this.character || !this.combat || payload.length < 8) {
      return quiet;
    }
    this.combat.attackSwing(this.character.guid, new ByteReader(payload).readU64());
    return quiet;
  }

  /** `WorldSession::HandleAttackStopOpcode` */
  handleAttackStop(): WorldResult {
    if (this.character) {
      this.combat?.attackStop(this.character.guid);
    }
    return { packets: [], sent: [], close: false, quiet: true };
  }

  /** `WorldSession::HandleSetSheathedOpcode` → `Unit::SetSheath` (`UNIT_FIELD_BYTES_2` byte 0). */
  handleSetSheathed(payload: Uint8Array): WorldResult {
    const quiet = { packets: [] as Uint8Array[], sent: [] as string[], close: false, quiet: true };
    const character = this.character;
    if (!character || !this.stats || payload.length < 4) {
      return quiet;
    }
    const sheath = new ByteReader(payload).readU32();
    if (sheath >= MAX_SHEATH_STATE) {
      return quiet;
    }
    const bytes2 = (this.stats.getUInt32(UNIT_FIELD_BYTES_2) & ~0xff) | sheath;
    this.stats.setUInt32(UNIT_FIELD_BYTES_2, bytes2);
    this.players.broadcast(character.guid, SMSG_UPDATE_OBJECT, fieldUpdateBlock(character.guid, [{ index: UNIT_FIELD_BYTES_2, value: bytes2 }]));
    return quiet;
  }

  /** The loot handlers' view of this player (`LootHandler.cpp` works on `GetPlayer()`). */
  lootContext(character: Character, inventory: Inventory): LootPlayCtx {
    const combat = this.combat;
    return {
      db: this.db.characters,
      world: worldDatabase(this.world),
      itemDbc: this.itemDbc,
      player: this.lootPlayer(character),
      playerGuid: character.guid,
      alive: this.deathState === "alive",
      money: character.money,
      lootGuid: this.lootGuid,
      inventory,
      creatures: combat
        ? {
            creature: (guid) => combat.lootCreature(guid, character.guid),
            releaseLoot: (guid, playerGuid) => combat.releaseLoot(guid, playerGuid),
          }
        : null,
      sendToPlayer: (guid, packet) => this.players.send(Number(guid & 0xffffffffn), packet.opcode, packet.body),
      itemAdded: (entry, count) => {
        const quests = this.talk?.quests;
        if (!quests?.itemAddedQuestCheck(entry, count)) {
          return [];
        }
        return [{ opcode: SMSG_UPDATE_OBJECT, name: "SMSG_UPDATE_OBJECT", body: fieldUpdateBlock(character.guid, fullQuestLog(quests)) }];
      },
      interruptNonMeleeSpells: () => {
        if (this.unit?.isNonMeleeSpellCast(false)) {
          this.unit.interruptNonMeleeSpells(false);
        }
      },
      removeLootAuras: (removeStealth) => {
        this.unit?.removeAurasByType(SPELL_AURA_MOD_INVISIBILITY);
        this.unit?.removeAurasByType(SPELL_AURA_FEIGN_DEATH);
        if (removeStealth) {
          this.unit?.removeAurasByType(SPELL_AURA_MOD_STEALTH);
        }
      },
      setLooting: (on) => this.stats?.setFlag(UNIT_FIELD_FLAGS, UNIT_FLAG_LOOTING, on),
    };
  }

  /** `Player` as `Loot` asks about it (`LootItem::AllowedForPlayer`, `Player::HasQuestForItem`, conditions). */
  lootPlayer(character: Character): LootPlayer {
    const quests = this.talk?.quests ?? null;
    const world = worldDatabase(this.world);
    const inventory = (): Inventory | null => (this.character === character ? this.inventory : null);
    const ownedCount = (itemId: number): number => {
      const inv = inventory();
      return inv ? getItemCount(inv, itemId, true) : 0;
    };
    return {
      guid: BigInt(character.guid),
      teamId: teamIdFromRace(character.race),
      hasSkill: (skill) => this.skills?.hasSkill(skill) ?? false,
      hasSpell: (spell) => this.kit?.spells.includes(spell) ?? false,
      meetsConditions: (conditions) =>
        !quests ||
        meets([...conditions], { race: character.race, classId: character.class, gender: character.gender, level: character.level, zone: character.zone, map: character.map }, quests),
      hasQuestForItem: (itemId, showInLoot) =>
        quests?.hasQuestForItem(itemId, {
          ownedCount,
          itemProto: (id) => {
            const proto = lootItemProto(world, id);
            return proto ? { maxcount: proto.maxcount, maxStackSize: proto.stackable === 2147483647 || proto.stackable <= 0 ? 0x7ffffffe : proto.stackable } : null;
          },
          showInLoot,
        }) ?? false,
      questStatus: (questId) => quests?.status(questId) ?? 0,
      questRewarded: (questId) => quests?.rewarded(questId) ?? false,
      prevQuestId: (questId) => quests?.source().quest(questId)?.prevQuestId ?? 0,
      hasItemCount: (itemId, count, inBankAlso) => {
        const inv = inventory();
        return !!inv && getItemCount(inv, itemId, inBankAlso) >= count;
      },
      isMasterLooter: false,
    };
  }

  /** `Player::StoreLootItem` for a currency token at the kill, queued behind the saves so it does not race the bags. */
  storeCurrencyLoot(character: Character, loot: Loot, lootSlot: number): void {
    const inventory = this.inventory;
    if (!inventory || this.character !== character) {
      return;
    }
    this.pendingSave = this.pendingSave
      .then(async () => {
        const packets = await storeLootItem(lootSlot, loot, this.lootContext(character, inventory));
        for (const row of packets) {
          this.deliver?.(encodeServerPacket(row.opcode, row.body));
        }
      })
      .catch((error: unknown) => logError("world", `storing currency loot for ${character.name} failed`, error));
  }

  /** The world lookups a `Loot` makes: item templates and the random enchant rolls of `LootItem`. */
  lootEnv(): LootEnv {
    const world = worldDatabase(this.world);
    return {
      itemProto: (entry) => lootItemProto(world, entry),
      enchSuffixFactor: (entry) => generateEnchSuffixFactorFor(world, this.itemDbc, entry),
      randomPropertyId: (entry) => generateItemRandomPropertyId(world, this.itemDbc, entry),
    };
  }

  /** `Player` as the melee code sees it. */
  combatPlayer(character: Character): CombatPlayer {
    const self = (): boolean => this.character === character;
    return {
      guid: character.guid,
      name: () => character.name,
      position: () => ({ map: character.map, x: character.position_x, y: character.position_y, z: character.position_z, o: character.orientation }),
      level: () => character.level,
      race: () => character.race,
      classId: () => character.class,
      factionTemplate: () => RACE_FACTION_TEMPLATE.get(character.race) ?? 0,
      reputation: (faction) => {
        const row = this.kit?.factions.find((entry) => entry.faction === faction);
        return row ? { standing: row.standing, flags: row.flags } : null;
      },
      alive: () => self() && this.deathState === "alive" && this.health > 0,
      gameMaster: () => this.playerFacade?.isGameMaster() ?? false,
      sitting: () => isSitState(this.standState),
      standUp: () => {
        const stood = this.applyStandState(0);
        for (const packet of stood.packets) {
          this.deliver?.(packet);
        }
      },
      moving: () => (this.moveFlags & LEEWAY_MOVE_FLAGS) !== 0 && (this.moveFlags & MOVEMENTFLAG_WALKING) === 0,
      mounted: () => false,
      knows: (guid) => this.mapPlayer?.haveAtClient(guid) ?? false,
      mapObject: () => (this.mapPlayer?.isInWorld() ? (this.mapPlayer as unknown as MovementOwner) : null),
      send: (opcode, body) => {
        if (self() && this.crypt) {
          this.deliver?.(encodeServerPacket(opcode, body));
        }
      },
      broadcast: (opcode, body) => this.players.broadcast(character.guid, opcode, body),
      health: () => this.health,
      melee: () => this.playerMelee(),
      spellUnit: () => (self() ? this.unit : null),
      takeDamage: (amount) => this.takeCombatDamage(amount),
      addRage: (points) => this.addRage(points),
      setInCombat: (on) => {
        this.inCombat = on;
        this.stats?.setFlag(UNIT_FIELD_FLAGS, UNIT_FLAG_IN_COMBAT, on);
        // `Unit::ClearInCombat` → `Player::UpdatePotionCooldown`
        if (!on) this.unit?.updatePotionCooldown();
      },
      killedCreature: (kill) => this.rewardKill(kill),
      combatSkill: (attType, victimLevel, defence) => {
        const stats = this.stats;
        const skills = this.skills;
        if (!stats || !skills) {
          return;
        }
        const weapon = stats.weaponForAttack(attType);
        skills.updateCombatSkills({
          attackType: attType,
          weapon: weapon ? { itemClass: weapon.template.class, subClass: weapon.template.subclass, broken: weapon.broken } : null,
          victimLevel,
          defence,
          intellect: stats.getStat(3),
        });
      },
    };
  }

  /** The `PlayerStats` values `Unit::CalculateMeleeDamage` and `RollMeleeOutcomeAgainst` read. */
  playerMelee(): PlayerMelee | null {
    const stats = this.stats;
    if (!stats) {
      return null;
    }
    const offhand = stats.canDualWield && stats.weaponForAttack(1) !== null;
    const shield = stats.equippedItem(16);
    const hasShield = Boolean(shield && !shield.broken && shield.template.block > 0);
    const hasWeapon = stats.weaponForAttack(0) !== null || stats.weaponForAttack(1) !== null;
    return {
      attackTime: (att) => stats.getAttackTime(att),
      hasOffhand: offhand,
      damage: (att, index) => {
        const range = stats.calculateMinMaxDamage(att, index);
        return { ...range, school: this.weaponDamageSchool(stats.weaponForAttack(att)?.template.entry ?? 0, index) };
      },
      crit: (att) => stats.getFloat(att === 1 ? PLAYER_OFFHAND_CRIT_PERCENTAGE : PLAYER_CRIT_PERCENTAGE),
      weaponSkill: (att) => stats.getWeaponSkillValue(att),
      maxSkill: stats.getMaxSkillValueForLevel(),
      defenseSkill: stats.getDefenseSkillValue(),
      expertiseReduction: (att) => stats.getUInt32(att === 1 ? PLAYER_OFFHAND_EXPERTISE : PLAYER_EXPERTISE) / 4,
      modMeleeHitChance: stats.modMeleeHitChance,
      armorPenetrationPct: stats.getRatingBonusValue(CR_ARMOR_PENETRATION),
      dodge: stats.realDodge,
      parry: stats.realParry,
      block: stats.getFloat(PLAYER_BLOCK_PERCENTAGE),
      blockValue: stats.getUInt32(PLAYER_SHIELD_BLOCK),
      armor: stats.getArmor(),
      missFromDefense: stats.getMissPercentageFromDefence(),
      critTakenReduction: stats.getRatingBonusValue(CR_CRIT_TAKEN_MELEE),
      canParry: stats.canParry && hasWeapon,
      canBlock: stats.canBlock && hasShield,
      usesRage: this.powerType === POWER_RAGE,
    };
  }

  readonly weaponSchools = new Map<number, [number, number]>();

  /** `item_template.dmg_type1` / `dmg_type2` for the weapon's damage entries. */
  weaponDamageSchool(entry: number, index: number): number {
    if (entry === 0) {
      return 0;
    }
    let schools = this.weaponSchools.get(entry);
    if (!schools) {
      schools = [0, 0];
      const row = worldDatabase(this.world)?.first(item_template, "entry", entry);
      if (row) {
        schools = [row.dmg_type1, row.dmg_type2];
      }
      this.weaponSchools.set(entry, schools);
    }
    return schools[index] ?? 0;
  }

  /** `Unit::DealDamage` on this player. Returns true when it killed them (`Unit::Kill` → `setDeathState(JustDied)`). */
  takeCombatDamage(amount: number): boolean {
    const character = this.character;
    if (!character || !this.crypt || this.deathState !== "alive") {
      return false;
    }
    this.health = Math.max(0, this.health - amount);
    if (this.health > 0) {
      return false;
    }
    const died = this.applyDeath(onDeath(this.deathFields()));
    for (const packet of died.packets) {
      this.deliver?.(packet);
    }
    this.saveLoggedInCharacter(character);
    return true;
  }

  /** `Unit::ModifyPower(POWER_RAGE)` from `RewardRage`, with its `SMSG_POWER_UPDATE`. */
  addRage(points: number): void {
    const stats = this.stats;
    const character = this.character;
    if (!stats || !character || !this.crypt || points <= 0) {
      return;
    }
    const current = stats.power(POWER_RAGE);
    const next = Math.min(stats.maxPower(POWER_RAGE), current + points);
    if (next === current) {
      return;
    }
    stats.setPower(POWER_RAGE, next);
    const body = powerUpdatePacket(character.guid, POWER_RAGE, next);
    this.deliver?.(encodeServerPacket(SMSG_POWER_UPDATE, body));
    this.players.broadcast(character.guid, SMSG_POWER_UPDATE, body);
  }

  /**
   * `KillRewarder::Reward` for a solo player plus the kill-time loot (`Unit::Kill`: `Loot::FillLoot`, `generateMoneyLoot`).
   * Returns the creature's new loot.
   */
  rewardKill(kill: CreatureKill): Loot | null {
    const character = this.character;
    if (!character || !this.crypt) {
      return null;
    }
    const worldDb = worldDatabase(this.world);
    const quests = this.talk?.quests ?? null;
    const loot = new Loot(this.lootEnv());
    loot.sourceWorldObjectGUID = kill.guid;
    if (worldDb && kill.lootId) {
      const stores = lootStores(worldDb);
      fillLoot(loot, kill.lootId, stores, stores.creature, this.lootPlayer(character), false, {
        rates: lootRates(),
        // `Loot::FillNotNormalLootFor`: currency tokens go straight to the bags.
        storeCurrency: (_player, lootSlot) => this.storeCurrencyLoot(character, loot, lootSlot),
      });
    }
    // `creature->GetLootMode()` is `LOOT_MODE_DEFAULT`.
    loot.generateMoneyLoot(kill.minGold, kill.maxGold, lootRates().money, urand);
    const rows: { opcode: number; name: string; body: Uint8Array }[] = [];
    if (kill.xp > 0) {
      rows.push(...this.grantXp(kill.xp, kill.guid));
    }
    if (quests) {
      rows.push(...creditKillPackets(quests, kill.entry, kill.guid, character));
      for (const credit of kill.killCredit) {
        if (credit) {
          rows.push(...creditKillPackets(quests, credit, 0n, character));
        }
      }
    }
    for (const row of rows) {
      this.deliver?.(encodeServerPacket(row.opcode, row.body));
    }
    this.saveLoggedInCharacter(character);
    return loot;
  }

  handleTalk(opcode: number, payload: Uint8Array): WorldResult | null {
    const character = this.character;
    const kit = this.kit;
    if (!this.talk || !this.crypt || !character || !kit) {
      return null;
    }
    const packets = this.talk.handle(opcode, payload, character, kit, this.mapPlayer?.getObjectVisibilityContainer().getVisibleWorldObjectsMap()?.keys() ?? []);
    if (!packets) {
      return null;
    }
    if (opcode === 0x17b || opcode === 0x17c || opcode === 0x184 || opcode === 0x0b1 || opcode === 0x186 || opcode === 0x189 || opcode === 0x18c || opcode === 0x18e || opcode === 0x194 || opcode === 0x19b || opcode === 0x1b5) {
      this.saveLoggedInCharacter(character);
    }
    return {
      packets: packets.map((row) => encodeServerPacket(row.opcode, row.body)),
      sent: packets.map((row) => row.name),
      close: false,
      quiet: packets.length === 0,
    };
  }

  async handleCharCreate(payload: Uint8Array): Promise<WorldResult> {
    if (!this.crypt) {
      return { packets: [], sent: [], close: true };
    }
    const draft = parseCharCreate(payload);
    if (!draft) {
      return { packets: [charCreatePacket(this.crypt, CHAR_CREATE_FAILED)], sent: ["SMSG_CHAR_CREATE"], close: false };
    }
    const nameCode = await characterCreateNameCode(this.db.characters, draft.name);
    if (nameCode !== null) {
      return { packets: [charCreatePacket(this.crypt, nameCode)], sent: ["SMSG_CHAR_CREATE"], close: false };
    }
    if ((await listCharacters(this.db.characters, this.accountId)).length >= MAX_CHARACTERS_PER_ACCOUNT) {
      return { packets: [charCreatePacket(this.crypt, CHAR_CREATE_ACCOUNT_LIMIT)], sent: ["SMSG_CHAR_CREATE"], close: false };
    }
    const start = this.world?.playerStart(draft.race, draft.classId, 1) ?? null;
    if (!start || (draft.gender !== 0 && draft.gender !== 1)) {
      return { packets: [charCreatePacket(this.crypt, CHAR_CREATE_FAILED)], sent: ["SMSG_CHAR_CREATE"], close: false };
    }
    const kit = this.applyDbc(kitFromStart(start), draft.race, draft.classId, draft.gender, 1, start.skills).kit;
    try {
      await createPlayableCharacter(
        this.db.characters,
        this.db.login,
        {
          accountId: this.accountId,
          name: draft.name,
          race: draft.race,
          classId: draft.classId,
          gender: draft.gender,
          skin: draft.skin,
          face: draft.face,
          hairStyle: draft.hairStyle,
          hairColor: draft.hairColor,
          facialStyle: draft.facialStyle,
          level: 1,
          map: start.info.map,
          zone: start.info.zone,
          x: start.info.positionX,
          y: start.info.positionY,
          z: start.info.positionZ,
          orientation: start.info.orientation,
          health: start.stats.health,
        },
        { ...kit, homebind: kit.homebind ?? kitFromStart(start).homebind },
      );
    } catch (error) {
      const code = error instanceof Error ? Number(error.message) : CHAR_CREATE_FAILED;
      return {
        packets: [charCreatePacket(this.crypt, Number.isFinite(code) ? code : CHAR_CREATE_FAILED)],
        sent: ["SMSG_CHAR_CREATE"],
        close: false,
      };
    }
    await sCharacterCache.refreshCacheEntry(this.db.characters, await createdGuid(this.db.characters, draft.name));
    log("world", `created ${draft.name} race ${draft.race} class ${draft.classId}`);
    return { packets: [charCreatePacket(this.crypt, CHAR_CREATE_SUCCESS)], sent: ["SMSG_CHAR_CREATE"], close: false };
  }

  async handleCharDelete(payload: Uint8Array): Promise<WorldResult> {
    if (!this.crypt || payload.length < 8) {
      return { packets: [], sent: [], close: true };
    }
    const guid = Number(new ByteReader(payload).readU64() & 0xffffffffn);
    if (this.character?.guid === guid) {
      return { packets: [charDeletePacket(this.crypt, CHAR_DELETE_FAILED)], sent: ["SMSG_CHAR_DELETE"], close: false };
    }
    // `WorldSession::HandleCharDeleteOpcode`: the character must belong to this account, then `Player::DeleteFromDB`.
    const removed = (await findCharacter(this.db.characters, this.accountId, guid)) !== null;
    if (removed) {
      await DeleteFromDB({ characters: this.db.characters, login: this.db.login }, guid, this.accountId, true, false);
      log("world", `deleted character ${guid}`);
    }
    return {
      packets: [charDeletePacket(this.crypt, removed ? CHAR_DELETE_SUCCESS : CHAR_DELETE_FAILED)],
      sent: ["SMSG_CHAR_DELETE"],
      close: false,
    };
  }

  handleMovement(opcode: number, kind: NonNullable<ReturnType<typeof movementKind>>, payload: Uint8Array): WorldResult {
    const character = this.character;
    const quiet = { packets: [] as Uint8Array[], sent: [] as string[], close: false, quiet: true };
    if (!this.crypt || !character) {
      return quiet;
    }
    if (kind === "worldport") {
      return this.finishFarTeleport();
    }
    if (kind === "teleport") {
      if (this.pendingTeleport && !this.pendingTeleport.far) {
        this.pendingTeleport = null;
      }
      return quiet;
    }
    const unit = this.unit;
    const allowed = movementFlagsAllowed(
      {
        hover: unit?.hasAuraType(106 /* SPELL_AURA_HOVER */) ?? false,
        waterWalk: unit?.hasAuraType(104 /* SPELL_AURA_WATER_WALK */) ?? false,
        ghost: unit?.hasAuraType(95 /* SPELL_AURA_GHOST */) ?? false,
        featherFall: unit?.hasAuraType(144 /* SPELL_AURA_FEATHER_FALL */) ?? false,
        fly: (unit?.hasAuraType(201 /* SPELL_AURA_FLY */) ?? false) || (unit?.hasAuraType(207 /* SPELL_AURA_MOD_INCREASE_MOUNTED_FLIGHT_SPEED */) ?? false),
      },
      this.security,
    );
    const info = readMoveInfo(kind, payload, allowed);
    if (!info || (info.guid & 0xffffffffn) !== BigInt(character.guid)) {
      return quiet;
    }
    if (kind === "active") {
      return quiet;
    }
    if (kind === "skip") {
      this.clientMoveTime += info.timeSkipped ?? 0;
      return quiet;
    }
    if (transportTooFar(info, { x: character.position_x, y: character.position_y })) {
      return quiet;
    }
    if (this.clockDelta !== 0) {
      const adjusted = info.time + this.clockDelta;
      if (adjusted >= 0 && adjusted <= 0xffffffff) {
        info.time = adjusted;
      }
    }
    const relocated = character.position_x !== info.x || character.position_y !== info.y || character.position_z !== info.z;
    const turned = character.orientation !== info.orientation;
    character.position_x = info.x;
    character.position_y = info.y;
    character.position_z = info.z;
    character.orientation = info.orientation;
    // `Unit::UpdatePosition` → `Map::PlayerRelocation`: the player moves between cells, its zone and area are read again, and
    // the players and creatures that see it or are seen are updated after the visibility delay (`Map::Update`)
    relocateOnMap(this);
    this.falling = (info.flags & 0x00001000) !== 0 || (info.flags & 0x00002000) !== 0;
    this.moveFlags = info.flags;
    this.clientMoveTime = info.time;
    const packets: Uint8Array[] = [];
    const sent: string[] = [];
    if (opcode === 0x0c9) {
      const damage = fallDamage(this.lastFallZ - info.z, this.maxHealth);
      if (damage > 0 && this.health > 0) {
        this.health = Math.max(0, this.health - damage);
        packets.push(environmentalDamagePacket(this.crypt, info.guid, damage));
        packets.push(encodeHealth(this.crypt, character.guid, this.health));
        sent.push("SMSG_ENVIRONMENTAL_DAMAGE_LOG", "SMSG_UPDATE_OBJECT");
        log("world", `${character.name} fall damage ${damage}, health ${this.health}`);
        if (this.health === 0) {
          const died = this.applyDeath(onDeath(this.deathFields()));
          packets.push(...died.packets);
          sent.push(...died.sent);
          this.combat?.playerDied(character.guid);
        }
      }
    }
    if (shouldResetFall(this.lastFallTime, this.lastFallZ, info.fallTime, info.z, opcode === 0x0c9)) {
      this.lastFallZ = info.z;
      this.lastFallTime = info.fallTime;
    }
    if (kind === "move") {
      // `Player::UpdatePosition`: a pending zone update, then the exploration check
      this.appendCaptured({ packets, sent, close: false }, () => this.area?.updatePosition());
      this.fallBelowMap(packets, sent);
    }
    if (kind === "speed" && info.speed !== null) {
      const moveType = speedMoveType(opcode);
      const expected = this.unit && moveType !== null ? this.unit.speed(moveType) : undefined;
      const verdict = speedVerdict(opcode, info.speed, expected);
      if (verdict === "kick") {
        log("world", `${character.name} kicked for speed ${info.speed}`);
        return { packets: [], sent: [], close: true };
      }
      if (verdict === "correct") {
        const packet = forceSpeedPacket(this.crypt, opcode, info.guid, this.orderCounter, expected);
        this.orderCounter += 1;
        if (packet) {
          packets.push(packet);
          sent.push("SMSG_FORCE_SPEED_CHANGE");
        }
      }
    }
    if (this.logoutTimer && (kind === "move" || kind === "speed")) {
      this.clearLogoutTimer();
      const aborted = this.encodeLogout(cancel().packets);
      packets.push(...aborted.packets);
      sent.push(...aborted.sent);
    }
    if (kind === "move") {
      // `Unit::UpdatePosition`: moving or turning removes the auras that break on it; `Spell::update` then
      // interrupts a cast in progress from the moving flags.
      this.unit?.movedOrTurned(turned, relocated);
      this.players.broadcast(character.guid, opcode, writeMoveInfo(info));
      if (isSitState(this.standState) && movingOrTurning(info.flags)) {
        const stood = this.applyStandState(0);
        packets.push(...stood.packets);
        sent.push(...stood.sent);
      }
    }
    if (opcode === 0x0c9 && this.health !== this.maxHealth) {
      this.players.broadcast(character.guid, SMSG_UPDATE_OBJECT, healthUpdateBlock(character.guid, this.health));
    }
    if (opcode === HEARTBEAT) {
      character.health = this.health;
      this.saveLoggedInCharacter(character);
      const now = Date.now();
      if (this.pendingTimeSync === null && now - this.lastTimeSync >= TIME_SYNC_INTERVAL_MS) {
        this.timeSyncCounter += 1;
        this.pendingTimeSync = this.timeSyncCounter;
        this.lastTimeSync = now;
        this.syncSentAt = performance.now();
        packets.push(timeSyncRequest(this.crypt, this.timeSyncCounter));
        sent.push("SMSG_TIME_SYNC_REQ");
      }
    }
    return { packets, sent, close: false, quiet: true };
  }

  /**
   * @ac game/Handlers/MovementHandler.cpp WorldSession::HandleMovementOpcodes (the min height check)
   * A player below the minimum height of the map falls to the void: an alive one takes `DAMAGE_FALL_TO_VOID` (the whole health
   * bar, logged as fall damage, ignoring immunities), a god mode GM is killed anyway; a released ghost that was not flagged out
   * of bounds is repopped at the graveyard.
   * @ac-skip Battleground::HandlePlayerUnderMap (battlegrounds are not ported)
   */
  fallBelowMap(packets: Uint8Array[], sent: string[]): void {
    const character = this.character;
    const crypt = this.crypt;
    if (!character || !crypt || !isBelowMap(this)) return;

    if (this.deathState === "alive") {
      // The Oculus under map case is handled by areatrigger (5001) and should not kill the player
      if (character.map === MAP_THE_OCULUS) return;

      this.playerFacade?.setPlayerFlagOn(PLAYER_FLAGS_IS_OUT_OF_BOUNDS);
      const damage = this.maxHealth;
      packets.push(environmentalDamagePacket(crypt, BigInt(character.guid), damage));
      sent.push("SMSG_ENVIRONMENTAL_DAMAGE_LOG");
      if (!this.playerFacade?.getCommandStatus(CHEAT_GOD)) this.health = Math.max(0, this.health - damage);
      // player can be alive if GM: Player::KillPlayer
      this.health = 0;
      packets.push(encodeHealth(crypt, character.guid, 0));
      sent.push("SMSG_UPDATE_OBJECT");
      const died = this.applyDeath(onDeath(this.deathFields()));
      packets.push(...died.packets);
      sent.push(...died.sent);
      this.combat?.playerDied(character.guid);
      log("world", `${character.name} fell below the map`);
    } else if ((character.playerFlags & PLAYER_FLAGS_GHOST) !== 0 && (character.playerFlags & PLAYER_FLAGS_IS_OUT_OF_BOUNDS) === 0) {
      // Rescue only released ghosts: teleporting an unreleased body would move the corpse out of instances
      void this.playerFacade?.repopAtGraveyard().catch((error: unknown) => logError("world", `${character.name} repop below the map failed`, error));
    }
  }

  teleportTo(map: number, x: number, y: number, z: number, orientation: number): WorldResult {
    const character = this.character;
    if (!this.crypt || !character) {
      return { packets: [], sent: [], close: false };
    }
    const place = { map, x, y, z, orientation, far: map !== character.map };
    this.pendingTeleport = place;
    if (!place.far) {
      character.position_x = x;
      character.position_y = y;
      character.position_z = z;
      character.orientation = orientation;
      this.lastFallZ = z;
      const packet = nearTeleportPacket(this.crypt, BigInt(character.guid), this.orderCounter, place);
      this.orderCounter += 1;
      relocateOnMap(this);
      const near = this.withVisible([packet], ["MSG_MOVE_TELEPORT_ACK"]);
      // `Player::TeleportTo`: update zone immediately
      this.appendCaptured(near, () => this.area?.updateZoneAfterAddToMap());
      return near;
    }
    // `Player::TeleportTo`: remove from the old map now (the others see it go)
    removeFromMap(this, false);
    return { packets: farTeleportPackets(this.crypt, map, place), sent: ["SMSG_TRANSFER_PENDING", "SMSG_NEW_WORLD"], close: false };
  }

  finishFarTeleport(): WorldResult {
    const character = this.character;
    const pending = this.pendingTeleport;
    if (!this.crypt || !character || !pending?.far) {
      return { packets: [], sent: [], close: false, quiet: true };
    }
    character.map = pending.map;
    character.position_x = pending.x;
    character.position_y = pending.y;
    character.position_z = pending.z;
    character.orientation = pending.orientation;
    this.lastFallZ = pending.z;
    this.pendingTeleport = null;
    character.health = this.health;
    this.saveLoggedInCharacter(character);
    log("world", `${character.name} entered map ${character.map}`);
    // `HandleMoveWorldportAckOpcode`: `Map::AddPlayerToMap` on the new map
    addToMap(this);
    const entered = this.withVisible(relocationPackets(this.crypt, character), ["SMSG_LOGIN_VERIFY_WORLD", "SMSG_UPDATE_OBJECT"]);
    // `Player::SendInitialPacketsAfterAddToMap`: update zone
    this.appendCaptured(entered, () => this.area?.updateZoneAfterAddToMap());
    return entered;
  }

  handleCreatureQuery(payload: Uint8Array): WorldResult {
    if (!this.crypt || !this.world || payload.length < 4) {
      return { packets: [], sent: [], close: false };
    }
    const entry = new ByteReader(payload).readU32();
    return {
      packets: [encodeServerPacket(SMSG_CREATURE_QUERY_RESPONSE, creatureQueryPayload(this.world, entry))],
      sent: ["SMSG_CREATURE_QUERY_RESPONSE"],
      close: false,
    };
  }

  handleGameObjectQuery(payload: Uint8Array): WorldResult {
    if (!this.crypt || !this.world || payload.length < 4) {
      return { packets: [], sent: [], close: false };
    }
    const entry = new ByteReader(payload).readU32();
    return {
      packets: [encodeServerPacket(SMSG_GAMEOBJECT_QUERY_RESPONSE, gameObjectQueryPayload(this.world, entry))],
      sent: ["SMSG_GAMEOBJECT_QUERY_RESPONSE"],
      close: false,
    };
  }

  handleItemQuery(payload: Uint8Array): WorldResult {
    if (!this.crypt || !this.world || payload.length < 4) {
      return { packets: [], sent: [], close: false };
    }
    const entry = new ByteReader(payload).readU32();
    return {
      packets: [encodeServerPacket(SMSG_ITEM_QUERY_SINGLE_RESPONSE, itemQueryPayload(this.world, entry))],
      sent: ["SMSG_ITEM_QUERY_SINGLE_RESPONSE"],
      close: false,
    };
  }

  /** The packets `work` sends to this player, appended to a handler result (named by their opcode). */
  appendCaptured(result: WorldResult, work: () => void): void {
    for (const packet of this.capturePackets(work)) {
      result.packets.push(packet);
      result.sent.push(describePacketOpcode(packet));
    }
  }

  /**
   * The result of a handler that put the player on a map or moved it across it: its packets, then what the player sees of the
   * map (`Player::UpdateVisibilityForPlayer(true)` and the relocation notifier, run now instead of after the visibility delay so
   * the creatures and players arrive with the loading screen, as before).
   */
  withVisible(packets: Uint8Array[], sent: string[]): WorldResult {
    const result: WorldResult = { packets, sent, close: false };
    this.appendCaptured(result, () => showWorld(this));
    return result;
  }

  /** The player is in the world for the rest of the server: chat addressing, the party, and the combat world. */
  registerOnline(character: Character): void {
    if (!this.crypt) return;
    this.players.bind({
      guid: character.guid,
      character: () => character,
      mapPlayer: () => this.mapPlayer,
      send: (opcode, payload) => {
        if (!this.crypt) return;
        this.deliver?.(encodeServerPacket(opcode, payload));
      },
    });
    this.bindShare(character);
    this.combat?.addPlayer(this.combatPlayer(character));
  }

  bindShare(character: Character): void {
    const talk = this.talk;
    if (!talk) {
      return;
    }
    this.party.bind({
      guid: character.guid,
      divider: () => talk.dividerGuid(),
      setDivider: (guid) => talk.setDivider(guid),
      place: () => ({ map: character.map, x: character.position_x, y: character.position_y, z: character.position_z }),
      level: () => character.level,
      status: (questId) => talk.quests.status(questId),
      canTake: (questId) => {
        talk.syncSpeaker(character);
        return talk.quests.canTake(questId, talk.quests.speaker);
      },
      canShare: (questId) => talk.quests.canShare(questId),
      logFull: () => talk.quests.logFull(),
      acceptShared: (questId) => talk.acceptShared(character, questId),
      deliver: (packets) => {
        if (!this.crypt) {
          return;
        }
        for (const row of packets) {
          this.deliver?.(encodeServerPacket(row.opcode, row.body));
        }
        this.saveLoggedInCharacter(character);
      },
    });
  }

  leaveWorld(): void {
    if (!this.character) {
      return;
    }
    this.party.unbind(this.character.guid);
    this.combat?.removePlayer(this.character.guid);
    this.inCombat = false;
    this.talk?.setDivider(0n);
    // `LogoutPlayer`: `Map::RemovePlayerFromMap(player, true)` (the players that see it get a destroy)
    removeFromMap(this, true);
    this.players.leave(this.character.guid);
    this.mapPlayer = null;
    this.playerFacade = null;
    this.area = null;
    this.character = null;
    this.kit = null;
    if (this.unit) {
      // `Unit::RemoveFromWorld`: interrupt casts and drop the auras (they were saved with the character).
      this.unit.interruptNonMeleeSpells(false);
      this.unit.removeAllAuras();
    }
    this.unit = null;
    this.savedAuras = [];
    this.savedSpellCooldowns = [];
    this.inventory = null;
    this.stats = null;
    this.skills = null;
    this.regen = null;
  }

  async handleNameQuery(payload: Uint8Array): Promise<WorldResult> {
    if (!this.crypt || payload.length < 8) {
      return { packets: [], sent: [], close: false };
    }
    const guid = new ByteReader(payload).readU64();
    const character = await findCharacterById(this.db.characters, Number(guid & 0xffffffffn));
    if (!character) {
      return { packets: [], sent: [], close: false };
    }
    return { packets: [nameQueryResponse(this.crypt, character)], sent: ["SMSG_NAME_QUERY_RESPONSE"], close: false };
  }

  handleQueryTime(): WorldResult {
    if (!this.crypt) {
      return { packets: [], sent: [], close: true };
    }
    return { packets: [queryTimeResponse(this.crypt)], sent: ["SMSG_QUERY_TIME_RESPONSE"], close: false };
  }

  handleZoneUpdate(payload: Uint8Array): WorldResult {
    if (!this.character || payload.length < 4) {
      return { packets: [], sent: [], close: false };
    }
    const reported = new ByteReader(payload).readU32();
    // use server side data, but only after update the player position (`Player::UpdatePosition`)
    if (this.area) this.area.needZoneUpdate = true;
    // The map files of this place are not extracted, so the server has no zone for it: keep the client's.
    if (!terrainStatusOf(this)?.zoneid) this.character.zone = reported;
    this.character.health = this.health;
    this.saveLoggedInCharacter(this.character);
    log("world", `${this.character.name} zone ${this.character.zone}`);
    return { packets: [], sent: [], close: false, quiet: true };
  }

  handleWorldStateTimer(): WorldResult {
    if (!this.crypt) {
      return { packets: [], sent: [], close: true };
    }
    return { packets: [worldStateTimer(this.crypt)], sent: ["SMSG_WORLD_STATE_UI_TIMER_UPDATE"], close: false };
  }

  handleTimeSync(payload: Uint8Array): WorldResult {
    if (payload.length < 4) {
      return { packets: [], sent: [], close: false };
    }
    const reader = new ByteReader(payload);
    const counter = reader.readU32();
    if (counter === this.pendingTimeSync) {
      if (reader.remaining >= 4) {
        const clientTime = reader.readU32();
        const lag = (performance.now() - this.syncSentAt) / 2;
        this.clockDelta = Math.round(this.syncSentAt + lag - clientTime);
      }
      this.pendingTimeSync = null;
    }
    return { packets: [], sent: [], close: false, quiet: true };
  }

  handleStandState(payload: Uint8Array): WorldResult {
    if (!this.crypt || !this.character || payload.length < 4) {
      return { packets: [], sent: [], close: false };
    }
    const state = new ByteReader(payload).readU32();
    if (!clientStandState(state)) {
      return { packets: [], sent: [], close: false };
    }
    const applied = this.applyStandState(state);
    return { packets: applied.packets, sent: applied.sent, close: false, quiet: !applied.changed };
  }

  applyStandState(state: number): { packets: Uint8Array[]; sent: string[]; changed: boolean } {
    if (!this.crypt || !this.character) {
      return { packets: [], sent: [], changed: false };
    }
    const changed = state !== this.standState;
    const packets = [encodeServerPacket(SMSG_STANDSTATE_UPDATE, Uint8Array.of(state & 0xff))];
    const sent = ["SMSG_STANDSTATE_UPDATE"];
    if (changed) {
      this.standState = state;
      this.unit?.standStateChanged();
      const block = standStateUpdateBlock(this.character.guid, state);
      this.players.broadcast(this.character.guid, SMSG_UPDATE_OBJECT, block);
      packets.push(encodeServerPacket(SMSG_UPDATE_OBJECT, block));
      sent.push("SMSG_UPDATE_OBJECT");
    }
    return { packets, sent, changed };
  }

  deathFields(): PlayerDeathFields {
    const character = this.character;
    if (!character) {
      throw new Error("death fields require a logged-in character");
    }
    return {
      guid: character.guid,
      race: character.race,
      class: character.class,
      gender: character.gender,
      skin: character.skin,
      face: character.face,
      hairStyle: character.hairStyle,
      hairColor: character.hairColor,
      facialStyle: character.facialStyle,
      health: this.health,
      maxHealth: this.maxHealth,
      power1: character.power1,
      maxPower1: character.power1,
      playerFlags: character.playerFlags,
      extraFlags: character.extra_flags,
      deathExpireTime: character.death_expire_time,
      deathState: this.deathState,
      map: character.map,
      zone: character.zone,
      position_x: character.position_x,
      position_y: character.position_y,
      position_z: character.position_z,
      orientation: character.orientation,
    };
  }

  graveyardStore(): GraveyardStore {
    if (this.graveyards) {
      return this.graveyards;
    }
    // The shared `sGraveyard` store once the server set it up; a session built without it loads its own.
    if (sGraveyard.hasWorld()) {
      return sGraveyard.graveyardStore();
    }
    const worldDb = worldDatabase(this.world);
    if (!worldDb) {
      this.graveyards = { byId: new Map(), byZone: new Map() };
      return this.graveyards;
    }
    try {
      this.graveyards = loadGraveyardStore(worldDb);
    } catch {
      this.graveyards = { byId: new Map(), byZone: new Map() };
    }
    return this.graveyards;
  }

  encodeBodies(packets: readonly { opcode: number; body: Uint8Array }[]): { packets: Uint8Array[]; sent: string[] } {
    if (!this.crypt) {
      return { packets: [], sent: [] };
    }
    return {
      packets: packets.map((packet) => encodeServerPacket(packet.opcode, packet.body)),
      sent: packets.map((packet) => worldOpcodeName(packet.opcode)),
    };
  }

  applyDeath(died: ReturnType<typeof onDeath>): { packets: Uint8Array[]; sent: string[] } {
    const character = this.character;
    if (!character) {
      return { packets: [], sent: [] };
    }
    this.health = died.health;
    character.health = died.health;
    character.playerFlags = died.playerFlags;
    character.death_expire_time = died.deathExpireTime;
    character.extra_flags = died.extraFlags;
    const wasAlive = this.deathState === "alive";
    this.deathState = died.deathState;
    if (wasAlive && died.deathState !== "alive" && this.unit) {
      // `Unit::setDeathState(JustDied)`: interrupt casts and remove the auras that do not persist through death.
      this.unit.interruptNonMeleeSpells(false);
      this.unit.removeAllAurasOnDeath();
    }
    return this.encodeBodies(died.packets);
  }

  applyResurrect(result: {
    health: number;
    power1: number;
    playerFlags: number;
    deathState: DeathState;
    teleport: { map: number; x: number; y: number; z: number; o: number } | null;
    packets: { opcode: number; body: Uint8Array }[];
  }): WorldResult {
    const character = this.character;
    if (!character) {
      return { packets: [], sent: [], close: false };
    }
    this.health = result.health;
    character.health = result.health;
    character.power1 = result.power1;
    character.playerFlags = result.playerFlags;
    this.deathState = result.deathState;
    this.resurrectRequest = null;
    const encoded = this.encodeBodies(result.packets);
    if (!result.teleport) {
      return { ...encoded, close: false };
    }
    const moved = this.teleportTo(result.teleport.map, result.teleport.x, result.teleport.y, result.teleport.z, result.teleport.o);
    return { packets: [...encoded.packets, ...moved.packets], sent: [...encoded.sent, ...moved.sent], close: false };
  }

  async handleRepop(): Promise<WorldResult> {
    const character = this.character;
    if (!this.crypt || !character || this.deathState === "alive") {
      return { packets: [], sent: [], close: false, quiet: true };
    }
    const released = await releaseSpirit(this.db.characters, this.deathFields(), this.graveyardStore());
    this.health = released.health;
    character.health = released.health;
    character.playerFlags = released.playerFlags;
    this.deathState = released.deathState;
    const encoded = this.encodeBodies(released.packets);
    if (!released.teleport) {
      return { ...encoded, close: false };
    }
    const moved = this.teleportTo(
      released.teleport.map,
      released.teleport.x,
      released.teleport.y,
      released.teleport.z,
      released.teleport.o,
    );
    return { packets: [...encoded.packets, ...moved.packets], sent: [...encoded.sent, ...moved.sent], close: false };
  }

  async handleReclaimCorpse(): Promise<WorldResult> {
    if (!this.crypt || !this.character) {
      return { packets: [], sent: [], close: false, quiet: true };
    }
    const result = await reclaimCorpse(this.db.characters, this.deathFields());
    if (!result) {
      return { packets: [], sent: [], close: false, quiet: true };
    }
    return this.applyResurrect(result);
  }

  async handleSpiritHealer(): Promise<WorldResult> {
    if (!this.crypt || !this.character) {
      return { packets: [], sent: [], close: false, quiet: true };
    }
    return this.applyResurrect(await spiritHealerResurrect(this.db.characters, this.deathFields(), this.graveyardStore()));
  }

  async handleResurrect(payload: Uint8Array): Promise<WorldResult> {
    if (!this.crypt || !this.character || payload.length < 1) {
      return { packets: [], sent: [], close: false, quiet: true };
    }
    const reader = new ByteReader(payload);
    const status = payload.length >= 9 ? (reader.readU64(), reader.readU8()) : reader.readU8();
    const result = await handleResurrectResponse(this.db.characters, this.deathFields(), this.resurrectRequest, status);
    if (!result || "declined" in result) {
      this.resurrectRequest = null;
      return { packets: [], sent: [], close: false, quiet: true };
    }
    return this.applyResurrect(result);
  }

  async handleCorpseQuery(): Promise<WorldResult> {
    const character = this.character;
    if (!this.crypt || !character) {
      return { packets: [], sent: [], close: false, quiet: true };
    }
    const body = buildCorpseQueryResponse(await loadCorpse(this.db.characters, character.guid), { playerMapId: character.map });
    return {
      packets: [encodeServerPacket(MSG_CORPSE_QUERY, body)],
      sent: ["MSG_CORPSE_QUERY"],
      close: false,
    };
  }

  async equipmentSetList(guid: number): Promise<Uint8Array> {
    return equipmentSetListPacket(await loadSets(this.db.characters, guid));
  }

  async handleEquipmentSetSave(payload: Uint8Array): Promise<WorldResult> {
    const quiet = { packets: [] as Uint8Array[], sent: [] as string[], close: false, quiet: true };
    if (!this.character) {
      return quiet;
    }
    try {
      const set = parseEquipmentSetSave(payload);
      if (!set) {
        return quiet;
      }
      await saveSet(this.db.characters, this.character.guid, set);
    } catch {
      return quiet;
    }
    return quiet;
  }

  async handleEquipmentSetDelete(payload: Uint8Array): Promise<WorldResult> {
    const quiet = { packets: [] as Uint8Array[], sent: [] as string[], close: false, quiet: true };
    if (!this.character) {
      return quiet;
    }
    try {
      await deleteSet(this.db.characters, parseEquipmentSetDelete(payload));
    } catch {
      return quiet;
    }
    return quiet;
  }

  handleLogout(): WorldResult {
    if (!this.crypt || !this.character) {
      return { packets: [], sent: [], close: true };
    }
    this.clearLogoutTimer();
    const decision = request({
      inCombat: this.inCombat,
      resting: isResting(this.character.playerFlags),
      falling: this.falling,
      nowMs: Date.now(),
    });
    if (decision.accepted && decision.instant) {
      return this.finishLogout(decision.packets);
    }
    if (decision.completeAtMs !== null) {
      const wait = Math.max(0, decision.completeAtMs - Date.now());
      this.logoutTimer = setTimeout(() => {
        this.logoutTimer = null;
        if (!this.character || !this.crypt || !this.deliver) {
          return;
        }
        const finished = this.finishLogout([]);
        for (const packet of finished.packets) {
          this.deliver(packet);
        }
      }, wait);
    }
    return this.encodeLogout(decision.packets);
  }

  handleLogoutCancel(): WorldResult {
    if (!this.crypt || !this.character) {
      return { packets: [], sent: [], close: false };
    }
    this.clearLogoutTimer();
    return this.encodeLogout(cancel().packets);
  }

  handleCastSpell(payload: Uint8Array): WorldResult {
    const character = this.character;
    const quiet = { packets: [] as Uint8Array[], sent: [] as string[], close: false, quiet: true };
    if (!this.crypt || !character || payload.length < 10) {
      return quiet;
    }
    let request: ReturnType<typeof readCastRequest>;
    try {
      request = readCastRequest(payload);
    } catch {
      return quiet;
    }
    return this.castSpellRequest(request.castCount, request.spellId, request.targets);
  }

  /**
   * `WorldSession::HandleCastSpellOpcode` / `Player::CastItemUseSpell`: a known, non-passive spell (or the used
   * item's spell) goes to `Spell::prepare`. Every check, cost, cooldown, and packet after that is the spell engine's.
   */
  castSpellRequest(castCount: number, spellId: number, targets: CastTargets, itemCast?: ItemCast): WorldResult {
    const character = this.character;
    const quiet = { packets: [] as Uint8Array[], sent: [] as string[], close: false, quiet: true };
    if (!this.crypt || !character) return quiet;
    const unit = this.unit;
    const info = this.spellStore?.get(spellId);
    if (this.spellStore) {
      if (!unit || !info) return quiet;
      if (!itemCast && (!this.kit?.spells.includes(spellId) || isPassive(info))) return quiet;
      const castItem = itemCast
        ? {
            guid: itemGuidRaw(itemCast.itemGuid),
            entry: itemCast.itemEntry,
            cooldownMs: itemCast.cooldownMs,
            category: itemCast.category,
            categoryCooldownMs: itemCast.categoryCooldownMs,
            isPotion: this.itemIsPotion(itemCast.itemGuid),
            take: () => {
              for (const packet of itemCast.commit(Date.now())) this.sendSpellPacket(encodeServerPacket(packet.opcode, packet.body));
            },
          }
        : null;
      unit.castSpellInfo(null, info, { castCount, targets, castItem });
      return this.drainSpellOutbox();
    }
    // Older tests and installations without DBC data retain the existing teleport behavior.
    if (spellId === 8690 && this.kit?.homebind) {
      const start = hearthTeleport(this.kit.homebind, character.map);
      return this.teleportTo(start.map, start.x, start.y, start.z, character.orientation);
    }
    const worldDb = worldDatabase(this.world);
    if (!worldDb) {
      return quiet;
    }
    let start;
    try {
      start = spellTeleport(worldDb, spellId, character);
    } catch {
      return quiet;
    }
    if (!start) {
      return quiet;
    }
    return this.teleportTo(start.map, start.x, start.y, start.z, start.orientation);
  }

  /** `ItemTemplate::IsPotion` for an item in the player's inventory. */
  itemIsPotion(itemGuid: number): boolean {
    const pos = this.inventory?.byGuid.get(itemGuid);
    const item = pos ? this.inventory?.slots.get(pos.bag)?.get(pos.slot) : undefined;
    return !!item && item.template.class === 0 && item.template.subclass === 1;
  }

  /** A spell-system packet for this player: straight to the socket, or into the handler's result. */
  sendSpellPacket(packet: Uint8Array): void {
    if (this.captured) this.captured.push(packet);
    else if (this.deliver) this.deliver(packet);
    else this.spellOutbox.push(packet);
  }

  /**
   * Runs `work` and returns the packets it sent to this player instead of sending them: a handler puts them into its result,
   * after the packets it already built (the world sends them in that order).
   */
  capturePackets(work: () => void): Uint8Array[] {
    const outer = this.captured;
    const own: Uint8Array[] = [];
    this.captured = own;
    try {
      work();
    } finally {
      this.captured = outer;
    }
    return own;
  }

  drainSpellOutbox(): WorldResult {
    const packets = this.spellOutbox;
    this.spellOutbox = [];
    return { packets, sent: packets.map(() => "SPELL"), close: false, quiet: packets.length === 0 };
  }

  /** `WorldSession::HandleCancelCastOpcode` / `HandleCancelChanneling` */
  handleCancelCast(payload: Uint8Array, hasCounter: boolean): WorldResult {
    const quiet = { packets: [] as Uint8Array[], sent: [] as string[], close: false, quiet: true };
    const unit = this.unit;
    if (!this.character || !this.crypt || !unit || payload.length < (hasCounter ? 5 : 4)) return quiet;
    const reader = new ByteReader(payload);
    if (hasCounter) reader.readU8();
    const spellId = reader.readU32();
    if (hasCounter) {
      if (unit.isNonMeleeSpellCast(false)) unit.interruptNonMeleeSpells(false, spellId, false);
    } else {
      const channel = unit.currentSpells[CURRENT_CHANNELED_SPELL];
      if (channel && channel.info.id === spellId) unit.interruptSpell(CURRENT_CHANNELED_SPELL);
    }
    return this.drainSpellOutbox();
  }

  /** `WorldSession::HandleCancelAuraOpcode` */
  handleCancelAura(payload: Uint8Array): WorldResult {
    const quiet = { packets: [] as Uint8Array[], sent: [] as string[], close: false, quiet: true };
    const unit = this.unit;
    if (!this.character || !this.crypt || !unit || payload.length < 4) return quiet;
    const spellId = new ByteReader(payload).readU32();
    const info = this.spellStore?.get(spellId);
    if (!info || hasAttribute(info, 0, SPELL_ATTR0_NO_AURA_CANCEL)) return quiet;
    if (isChanneled(info)) {
      const channel = unit.currentSpells[CURRENT_CHANNELED_SPELL];
      if (channel && channel.info.id === spellId) unit.interruptSpell(CURRENT_CHANNELED_SPELL);
      return this.drainSpellOutbox();
    }
    if (!isPositive(info) || isPassive(info)) return quiet;
    unit.removeOwnedAuraBySpell(spellId, 0n, 0, AURA_REMOVE_BY_CANCEL);
    return this.drainSpellOutbox();
  }

  /** The `Player` side the spell unit reads and writes through (`WorldSession` owns the player state). */
  playerHost(character: Character): import("./player-spell-unit.ts").PlayerHost {
    const self = (): boolean => this.character === character;
    return {
      map: () => {
        if (this.combat?.hasSpells) return this.combat;
        this.soloMap ??= soloSpellMap(this.spellStore!, () => this.unit);
        return this.soloMap;
      },
      position: () => ({ map: character.map, x: character.position_x, y: character.position_y, z: character.position_z, o: character.orientation }),
      collisionState: () => ({
        scale: this.playerFacade?.getObjectScale() ?? 1,
        nativeDisplayId: this.playerFacade?.getNativeDisplayId() ?? 0,
        mountDisplayId: this.playerFacade?.isMounted() ? this.playerFacade.getUInt32Value(UNIT_FIELD_MOUNTDISPLAYID) : 0,
      }),
      phaseMask: () => this.playerFacade?.getPhaseMask() ?? 1,
      level: () => character.level,
      race: () => character.race,
      classId: () => character.class,
      powerType: () => this.powerType,
      reactionPlayer: () => ({
        race: character.race,
        classId: character.class,
        factionTemplate: RACE_FACTION_TEMPLATE.get(character.race) ?? 0,
        reputation: (faction) => {
          const row = this.kit?.factions.find((entry) => entry.faction === faction);
          return row ? { standing: row.standing, flags: row.flags } : null;
        },
      }),
      alive: () => self() && this.deathState === "alive" && this.health > 0,
      inCombat: () => this.inCombat,
      engage: (enemy) => {
        if (enemy instanceof CreatureSpellUnit && this.unit) this.combat?.creatureEngage(enemy.unit, this.unit);
      },
      standState: () => (this.standState < 0 ? 0 : this.standState),
      setStandState: (state) => {
        const applied = this.applyStandState(state);
        for (const packet of applied.packets) this.sendSpellPacket(packet);
      },
      moveFlags: () => this.moveFlags,
      gameMaster: () => this.playerFacade?.isGameMaster() ?? false,
      commandStatus: (command) => this.playerFacade?.getCommandStatus(command) ?? false,
      selection: () => this.selection,
      victim: () => {
        const guid = this.combat?.victimOf(character.guid);
        return guid ? (this.combat?.unit(guid) ?? null) : null;
      },
      attackStop: () => this.combat?.attackStop(character.guid),
      send: (opcode, body) => {
        if (self() && this.crypt) this.sendSpellPacket(encodeServerPacket(opcode, body));
      },
      broadcast: (opcode, body) => this.players.broadcast(character.guid, opcode, body),
      knows: (guid) => !highGuidIsCreature(guid) || (this.mapPlayer?.haveAtClient(guid) ?? false),
      takeDamage: (amount) => {
        const died = this.takeCombatDamage(amount);
        if (died) this.combat?.playerDied(character.guid);
        return died;
      },
      setHealth: (value) => {
        this.health = value;
      },
      addRage: (points) => this.addRage(points),
      rageRate: () => this.combat?.rates.rageIncome ?? 1,
      learnSpell: (spellId) => {
        if (!this.kit || !spellId || this.kit.spells.includes(spellId)) return;
        this.kit.spells.push(spellId);
        this.kit.spells.sort((a, b) => a - b);
        if (this.crypt) this.sendSpellPacket(encodeServerPacket(SMSG_LEARNED_SPELL, new ByteWriter().writeU32(spellId).writeU16(0).toUint8Array()));
      },
      knowsSpell: (spellId) => this.kit?.spells.includes(spellId) ?? false,
      teleport: (map, x, y, z, orientation) => {
        const moved = this.teleportTo(map, x, y, z, orientation);
        for (const packet of moved.packets) this.sendSpellPacket(packet);
      },
      homebind: () => {
        const home = this.kit?.homebind;
        return home ? { map: home.mapId, x: home.posX, y: home.posY, z: home.posZ, o: character.orientation } : null;
      },
      hasItem: (guid) => this.inventory?.byGuid.has(Number(guid & 0xffffffffn)) ?? false,
      hasItemCount: (entry, count) => inventoryCount(this.inventory, entry) >= count,
      destroyItemCount: (entry, count) => destroyInventoryCount(this.inventory, entry, count),
      speedChanged: (moveType, speed) => {
        if (!this.crypt) return;
        const packet = forceSpeedChangePacket(this.crypt, moveType, BigInt(character.guid), this.orderCounter, speed);
        this.orderCounter += 1;
        if (packet) this.sendSpellPacket(packet);
      },
      rootChanged: (rooted) => {
        if (!this.crypt) return;
        const body = new ByteWriter().writeBytes(packedGuidOf(BigInt(character.guid))).writeU32(this.orderCounter++).toUint8Array();
        const opcode = rooted ? 0x0e8 /* SMSG_FORCE_MOVE_ROOT */ : 0x0ea; /* SMSG_FORCE_MOVE_UNROOT */
        this.sendSpellPacket(encodeServerPacket(opcode, body));
        this.players.broadcast(character.guid, opcode, body);
      },
      cooldownsChanged: () => {},
      fieldChanged: () => {},
      partyWith: () => false,
      factions: () => this.combat?.factions ?? null,
    };
  }

  handleActivateTaxi(payload: Uint8Array, express: boolean): WorldResult {
    const character = this.character;
    const quiet = { packets: [] as Uint8Array[], sent: [] as string[], close: false, quiet: true };
    const worldDb = worldDatabase(this.world);
    if (!this.crypt || !character || !worldDb) {
      return quiet;
    }
    let parsed;
    try {
      parsed = express ? parseActivateTaxiExpress(payload) : parseActivateTaxi(payload);
    } catch {
      return quiet;
    }
    const source = parsed.nodes[0];
    const dest = parsed.nodes[parsed.nodes.length - 1];
    if (source === undefined || dest === undefined) {
      return quiet;
    }
    let start;
    try {
      start = taxiTeleport(worldDb, source, dest, character);
    } catch {
      return quiet;
    }
    if (!start || character.money < start.cost) {
      return quiet;
    }
    character.money -= start.cost;
    return this.teleportTo(start.map, start.x, start.y, start.z, start.orientation);
  }

  applyOfflineRestOnLogin(character: Character): void {
    const worldDb = worldDatabase(this.world);
    let nextLevelXp = 0;
    if (worldDb) {
      try {
        nextLevelXp = xpForLevel(worldDb, character.level);
      } catch {
        nextLevelXp = 0;
      }
    }
    const rested = applyOfflineRest(character, Math.floor(Date.now() / 1000), nextLevelXp);
    character.rest_bonus = rested.rest_bonus;
    character.restState = rested.restState;
    character.is_logout_resting = rested.is_logout_resting;
    character.playerFlags = rested.playerFlags;
  }

  applyLogoutRest(character: Character): void {
    const snapshot = logoutRestSnapshot(character, Math.floor(Date.now() / 1000));
    character.rest_bonus = snapshot.rest_bonus;
    character.restState = snapshot.restState;
    character.logout_time = snapshot.logout_time;
    character.is_logout_resting = snapshot.is_logout_resting;
    character.playerFlags = snapshot.playerFlags;
  }

  finishLogout(already: readonly LogoutPacket[]): WorldResult {
    const character = this.character;
    const crypt = this.crypt;
    if (!character || !crypt) {
      return { packets: [], sent: [], close: false };
    }
    this.clearLogoutTimer();
    character.health = this.health;
    this.applyLogoutRest(character);
    this.saveLoggedInCharacter(character);
    log("world", `${character.name} logged out at ${character.position_x}, ${character.position_y}, ${character.position_z}`);
    this.leaveWorld();
    const packets = already.length > 0 ? already : complete().packets;
    return this.encodeLogout(packets);
  }

  encodeLogout(packets: readonly LogoutPacket[]): WorldResult {
    if (!this.crypt) {
      return { packets: [], sent: [], close: false };
    }
    return {
      packets: packets.map((packet) => encodeServerPacket(packet.opcode, packet.body)),
      sent: packets.map((packet) => packet.name),
      close: false,
    };
  }

  clearLogoutTimer(): void {
    if (this.logoutTimer) {
      clearTimeout(this.logoutTimer);
      this.logoutTimer = null;
    }
  }

  /** `HandleTutorialFlag`, `HandleTutorialClear`, `HandleTutorialReset` (`STATUS_LOGGEDIN`). */
  handleTutorial(opcode: number, payload: Uint8Array): WorldResult {
    const result: WorldResult = { packets: [], sent: [], close: false };
    if (!this.character) {
      return result;
    }
    if (opcode === CMSG_TUTORIAL_FLAG) {
      if (payload.length >= 4) {
        this.tutorials.flag(new ByteReader(payload).readU32());
      }
    } else if (opcode === CMSG_TUTORIAL_CLEAR) {
      this.tutorials.clear();
    } else {
      this.tutorials.reset();
    }
    return result;
  }

  handleRealmSplit(payload: Uint8Array): WorldResult {
    if (!this.crypt || payload.length < 4) {
      return { packets: [], sent: [], close: true };
    }
    const unk = new ByteReader(payload).readU32();
    return { packets: [realmSplitPacket(this.crypt, unk)], sent: ["SMSG_REALM_SPLIT"], close: false };
  }

  handleAccountDataTimes(): WorldResult {
    if (!this.crypt) {
      return { packets: [], sent: [], close: true };
    }
    return { packets: [accountDataTimesPacket(this.crypt)], sent: ["SMSG_ACCOUNT_DATA_TIMES"], close: false };
  }

  // ------------------------------------------------------------------ account, security, and chat

  /**
   * `LOGIN_SEL_ACCOUNT_INFO_BY_NAME` (`WorldSocket::HandleAuthSession`): security for this realm, mute time, locale,
   * flags, expansion, and whether the account is banned.
   */
  async loadAccountInfo(username: string): Promise<{ banned: boolean }> {
    const [fields] = await queryFields(this.db.login, LOGIN_SEL_ACCOUNT_INFO_BY_NAME, realm.Id.Realm, upperLatin(username));
    if (!fields) return { banned: false };
    const worldExpansion = sWorld().getIntConfig(ServerConfig.CONFIG_EXPANSION);
    this.expansion = Math.min(Number(fields[5] ?? 0), worldExpansion);
    this.accountFlags = Number(fields[6] ?? 0) >>> 0;
    let muteTime = Number(fields[7] ?? 0);
    const locale = Number(fields[8] ?? 0);
    this.locale = locale >= TOTAL_LOCALES ? LOCALE_enUS : locale;
    this.security = Number(fields[12] ?? 0);
    // Negative mutetime indicates amount of minutes to be muted effective on next login - which is now.
    if (muteTime < 0) {
      muteTime = Math.floor(Date.now() / 1000) + Math.abs(muteTime);
      executeStatementAsync(this.db.login, LOGIN_UPD_MUTE_TIME_LOGIN, muteTime, Number(fields[0]));
    }
    this.muteTime = muteTime;
    return { banned: Number(fields[13] ?? 0) !== 0 };
  }

  /** @ac game/Server/WorldSession.cpp WorldSession::LoadPermissions */
  async loadPermissions(): Promise<void> {
    this.rbacData = new RBACData(this.accountId, this.accountName, realm.Id.Realm, this.security, sAccountMgr, this.db.login);
    await this.rbacData.loadFromDB();
  }

  /** @ac game/Server/WorldSession.cpp WorldSession::HasPermission */
  hasPermission(permission: number): boolean {
    return this.rbacData?.hasPermission(permission) ?? false;
  }

  /** @ac game/Server/WorldSession.cpp WorldSession::GetRBACData */
  getRBACData(): RBACData | null {
    return this.rbacData;
  }

  /** @ac game/Server/WorldSession.cpp WorldSession::InvalidateRBACData (reloaded at once; the C++ reloads on next use) */
  async invalidateRBACData(): Promise<void> {
    await this.loadPermissions();
  }

  getSecurity(): number {
    return this.security;
  }

  /** @ac game/Server/WorldSession.h WorldSession::SetSecurity */
  setSecurity(security: number): void {
    this.security = security;
  }

  getAccountId(): number {
    return this.accountId;
  }

  getAccountName(): string {
    return this.accountName;
  }

  getAccountFlags(): number {
    return this.accountFlags;
  }

  hasAccountFlag(flag: number): boolean {
    return (this.accountFlags & flag) !== 0;
  }

  /** @ac game/Server/WorldSession.cpp WorldSession::UpdateAccountFlag */
  updateAccountFlag(flag: number, remove = false): void {
    if (remove) this.accountFlags = (this.accountFlags & ~flag) >>> 0;
    else this.accountFlags = (this.accountFlags | flag) >>> 0;
    executeStatementAsync(this.db.login, LOGIN_UPD_SET_ACCOUNT_FLAG, this.accountFlags, this.accountId);
  }

  /** @ac game/Server/WorldSession.cpp WorldSession::ValidateAccountFlags */
  validateAccountFlags(): void {
    const hasGMFlag = this.hasAccountFlag(ACCOUNT_FLAG_GM);
    if (this.isGMAccount() && !hasGMFlag) this.updateAccountFlag(ACCOUNT_FLAG_GM);
    else if (hasGMFlag && !this.isGMAccount()) this.updateAccountFlag(ACCOUNT_FLAG_GM, true);
  }

  /** @ac game/Server/WorldSession.cpp WorldSession::IsGMAccount */
  isGMAccount(): boolean {
    return this.security >= SEC_GAMEMASTER;
  }

  getRemoteAddress(): string {
    return this.remoteAddress;
  }

  getLatency(): number {
    return this.latency;
  }

  /** @ac game/Server/WorldSession.h WorldSession::GetPlayer */
  getPlayer(): SessionPlayer | null {
    return this.character ? this.playerFacade : null;
  }

  /** @ac game/Server/WorldSession.cpp WorldSession::GetPlayerName */
  getPlayerName(): string {
    return this.character?.name ?? "<none>";
  }

  getSessionDbcLocale(): number {
    return this.locale;
  }

  getSessionDbLocaleIndex(): number {
    return this.locale;
  }

  /** @ac game/Server/WorldSession.cpp WorldSession::GetAcoreString */
  getAcoreString(entry: number): string {
    return sObjectMgr.getAcoreString(entry, this.getSessionDbLocaleIndex());
  }

  /** @ac game/Server/WorldSession.cpp WorldSession::SendPacket */
  sendPacket(opcode: number, body: Uint8Array): void {
    if (!this.crypt) return;
    this.sendSpellPacket(encodeServerPacket(opcode, body));
  }

  /** An already encoded packet to this session (socket, or the handler's result when there is no socket). */
  sendRaw(packet: Uint8Array): void {
    this.sendSpellPacket(packet);
  }

  /** @ac game/Server/WorldSession.cpp WorldSession::KickPlayer */
  kickPlayer(reason: string): void {
    log("world", `Account: ${this.accountId} Character: '${this.getPlayerName()}' kicked with reason: ${reason}`);
    this.closeSocket?.();
  }

  attachClose(close: () => void): void {
    this.closeSocket = close;
  }

  /** `CMSG_MESSAGECHAT`, `CMSG_EMOTE`, `CMSG_TEXT_EMOTE`, `CMSG_CHAT_IGNORED` (`STATUS_LOGGEDIN`). */
  async handleChat(opcode: number, payload: Uint8Array): Promise<WorldResult> {
    if (!this.crypt || !this.character || !this.playerFacade) {
      return { packets: [], sent: [], close: false, quiet: true };
    }
    try {
      switch (opcode) {
        case CMSG_MESSAGECHAT:
          await HandleMessagechatOpcode(this, payload);
          break;
        case CMSG_EMOTE:
          HandleEmoteOpcode(this, payload);
          break;
        case CMSG_TEXT_EMOTE:
          HandleTextEmoteOpcode(this, payload);
          break;
        case CMSG_CHAT_IGNORED:
          HandleChatIgnoredOpcode(this, payload);
          break;
      }
    } catch (error) {
      logError("world", `${this.label} chat opcode failed`, error);
    }
    if (this.character) this.saveLoggedInCharacter(this.character);
    return this.drainSpellOutbox();
  }

  /** The world rows (`sObjectMgr` caches). */
  worldTables(): WorldTables | null {
    return worldDatabase(this.world);
  }

  /**
   * The fields `Player::LoadFromDB` / `InitDisplayIds` set that the command code changes: display, faction, scale,
   * player flags, titles, and the honor and arena currencies.
   */
  initCommandFields(character: Character): void {
    const stats = this.stats;
    if (!stats) return;
    const appearance = raceAppearance(character.race, character.gender);
    stats.setFloat(OBJECT_FIELD_SCALE_X, 1);
    stats.setFloat(UNIT_FIELD_COMBATREACH, 1.5);
    stats.setUInt32(UNIT_FIELD_DISPLAYID, appearance.display);
    stats.setUInt32(UNIT_FIELD_NATIVEDISPLAYID, appearance.display);
    stats.setUInt32(UNIT_FIELD_FACTIONTEMPLATE, appearance.faction);
    stats.setUInt32(PLAYER_FLAGS_FIELD, character.playerFlags);
    stats.setUInt32(PLAYER_CHOSEN_TITLE, character.chosenTitle);
    stats.setUInt32(PLAYER_FIELD_HONOR_CURRENCY, character.totalHonorPoints);
    stats.setUInt32(PLAYER_FIELD_ARENA_CURRENCY, character.arenaPoints);
    // `Player::_LoadExploredZones` (`PLAYER_EXPLORED_ZONES_1` .. +127)
    const explored = (character.exploredZones ?? "").trim().split(/\s+/).filter(Boolean).map((part) => Number(part) >>> 0);
    explored.slice(0, PLAYER_EXPLORED_ZONES_SIZE).forEach((value, index) => stats.setUInt32(PLAYER_EXPLORED_ZONES_1 + index, value));
    const titles = (character.knownTitles ?? "").trim().split(/\s+/).filter(Boolean).map((part) => Number(part) >>> 0);
    titles.slice(0, 6).forEach((value, index) => stats.setUInt32(PLAYER__FIELD_KNOWN_TITLES + index, value));
    // Honor system: the kill and contribution fields, then `UpdateHonorFields` from the logout time
    stats.setUInt32(PLAYER_FIELD_TODAY_CONTRIBUTION, character.todayHonorPoints);
    stats.setUInt32(PLAYER_FIELD_YESTERDAY_CONTRIBUTION, character.yesterdayHonorPoints);
    stats.setUInt32(PLAYER_FIELD_LIFETIME_HONORABLE_KILLS, character.totalKills);
    stats.setUInt32(PLAYER_FIELD_KILLS, ((character.todayKills & 0xffff) | ((character.yesterdayKills & 0xffff) << 16)) >>> 0);
    if (this.commandState) this.commandState.lastHonorUpdateTime = character.logout_time;
    this.playerFacade?.updateHonorFields();
  }

  /** The GM state part of `Player::LoadFromDB`. */
  restoreGmState(character: Character): void {
    const player = this.playerFacade;
    if (!player || !this.hasPermission(RBAC_PERM_RESTORE_SAVED_GM_STATE)) {
      if (player) character.extra_flags &= ~(PLAYER_EXTRA_GM_ON | PLAYER_EXTRA_GM_INVISIBLE | PLAYER_EXTRA_GM_CHAT);
      return;
    }
    const world = sWorld();
    const extraflags = character.extra_flags;
    character.extra_flags &= ~(PLAYER_EXTRA_GM_ON | PLAYER_EXTRA_GM_INVISIBLE | PLAYER_EXTRA_GM_CHAT | PLAYER_EXTRA_ACCEPT_WHISPERS);
    switch (world.getIntConfig(ServerConfig.CONFIG_GM_LOGIN_STATE)) {
      case 1:
        player.setGameMaster(true);
        break;
      case 2:
        if (extraflags & PLAYER_EXTRA_GM_ON) player.setGameMaster(true);
        break;
    }
    switch (world.getIntConfig(ServerConfig.CONFIG_GM_VISIBLE_STATE)) {
      case 0:
        player.setGMVisible(false);
        break;
      case 2:
        if (extraflags & PLAYER_EXTRA_GM_INVISIBLE) player.setGMVisible(false);
        break;
    }
    switch (world.getIntConfig(ServerConfig.CONFIG_GM_CHAT)) {
      case 1:
        player.setGMChat(true);
        break;
      case 2:
        if (extraflags & PLAYER_EXTRA_GM_CHAT) player.setGMChat(true);
        break;
    }
    switch (world.getIntConfig(ServerConfig.CONFIG_GM_WHISPERING_TO)) {
      case 1:
        player.setAcceptWhispers(true);
        break;
      case 2:
        if (extraflags & PLAYER_EXTRA_ACCEPT_WHISPERS) player.setAcceptWhispers(true);
        break;
    }
  }

  /** `WorldObject::UpdateObjectVisibility` for this player (others see or lose it, it sees or loses them). */
  refreshVisibility(): void {
    this.mapPlayer?.updateObjectVisibility(true);
  }

  /** `Unit::Kill(killer, player)`. */
  killPlayer(): void {
    const character = this.character;
    if (!character) return;
    const died = this.takeCombatDamage(this.health);
    if (died) this.combat?.playerDied(character.guid);
  }

  /** Skill changes from a command: learned and removed spells follow, and the fields go out with the next flush. */
  applySkillEvents(): void {
    const skills = this.skills;
    if (!skills) return;
    const changes = spellChangesFromEvents(skills.drainEvents());
    for (const spellId of changes.learn) this.playerFacade?.learnSpell(spellId);
    for (const spellId of changes.remove ?? []) this.playerFacade?.removeSpell(spellId);
  }

  /** `ReputationMgr::SetOneFactionReputation` over `character_reputation`, then `ReputationMgr::SendState`. */
  setFactionStanding(factionId: number, standing: number): boolean {
    const row = this.kit?.factions.find((entry) => entry.faction === factionId);
    const listId = sFactionStoreListId(factionId);
    if (!row || listId < 0) return false;
    row.standing = standing;
    const body = new ByteWriter().writeF32(0).writeU8(0).writeU32(1).writeU32(listId).writeU32(standing >>> 0).toUint8Array();
    this.sendPacket(0x124 /* SMSG_SET_FACTION_STANDING */, body);
    return true;
  }

  /** `Player::DestroyItemCount` from a command: each carried stack goes through `DestroyItem`, with the removal packets. */
  async destroyItemCountByCommand(entry: number, count: number): Promise<void> {
    const inventory = this.inventory;
    if (!inventory) return;
    let left = count;
    for (const row of carriedItems(inventory)) {
      if (left <= 0) break;
      if (row.entry !== entry) continue;
      const take = Math.min(left, row.count);
      const packetBag = row.bag === 0 ? INVENTORY_SLOT_BAG_0 : (inventory.byGuid.get(row.bag)?.slot ?? INVENTORY_SLOT_BAG_0);
      await this.destroyItemAt(packetBag, row.slot, take >= row.count ? 0 : take);
      left -= take;
    }
  }

  /** @ac game/Entities/Player/PlayerStorage.cpp Player::SwapItem for two of the player's own slots (the `CMSG_SWAP_INV_ITEM` path). */
  async swapInvItem(srcSlot: number, dstSlot: number): Promise<void> {
    const result = await this.handlePlay(CMSG_SWAP_INV_ITEM, Uint8Array.from([srcSlot & 0xff, dstSlot & 0xff]));
    for (const packet of result?.packets ?? []) this.sendRaw(packet);
  }

  /**
   * @ac game/Entities/Player/PlayerStorage.cpp Player::DestroyItem (`bag` is `INVENTORY_SLOT_BAG_0` or a bag slot, as in the
   * client packets; `count` 0 destroys the stack). The `CMSG_DESTROYITEM` path sends the removal and saves the inventory.
   */
  async destroyItemAt(bag: number, slot: number, count = 0): Promise<boolean> {
    const result = await this.handlePlay(CMSG_DESTROYITEM, Uint8Array.from([bag & 0xff, slot & 0xff, count & 0xff]));
    for (const packet of result?.packets ?? []) this.sendRaw(packet);
    return result !== null;
  }

  /** `Player::SendNewItem` to this player and, when a GM gave it, to the GM (`received` for the target). */
  sendItemPushResult(last: InventoryItem, lastInstance: ItemInstance | null, count: number, selfGiven: boolean, giver: SessionPlayer | { getSession(): WorldSession } | null): void {
    const character = this.character;
    const inventory = this.inventory;
    if (!character || !inventory) return;
    const pos = getItemPos(inventory, last.guid);
    if (!pos) return;
    const push = (received: boolean): Uint8Array =>
      buildItemPushResult({
        playerGuid: BigInt(character.guid),
        received,
        created: !received,
        sendChatMessage: true,
        bagSlot: bagSlotOf(inventory, pos.bag),
        slot: last.count === count ? pos.slot : -1,
        entry: last.entry,
        suffixFactor: lastInstance?.propertySeed ?? 0,
        randomPropertyId: lastInstance?.randomPropertyId ?? 0,
        count,
        inventoryCount: getItemCount(inventory, last.entry),
      });
    // `p->SendNewItem(item, count, false, true)` to the GM, then `playerTarget->SendNewItem(item, count, true, false)`.
    if (giver && !selfGiven) giver.getSession().sendPacket(0x166 /* SMSG_ITEM_PUSH_RESULT */, push(false));
    this.sendPacket(0x166 /* SMSG_ITEM_PUSH_RESULT */, push(!selfGiven));
  }

  handlePing(payload: Uint8Array): WorldResult {
    if (!this.crypt || payload.length < 4) {
      return { packets: [], sent: [], close: true };
    }
    const reader = new ByteReader(payload);
    const ping = reader.readU32();
    if (reader.remaining >= 4) {
      this.latency = reader.readU32();
    }
    return { packets: [pongPacket(this.crypt, ping)], sent: ["SMSG_PONG"], close: false };
  }
}

type CharCreateRequest = {
  name: string;
  race: number;
  classId: number;
  gender: number;
  skin: number;
  face: number;
  hairStyle: number;
  hairColor: number;
  facialStyle: number;
};

function storedPower(character: Character, powerType: number): number {
  switch (powerType) {
    case 0:
      return character.power1;
    case 1:
      return character.power2;
    case 2:
      return character.power3;
    case 3:
      return character.power4;
    case 4:
      return character.power5;
    case 5:
      return character.power6;
    case 6:
      return character.power7;
    default:
      return 0;
  }
}

function parseCharCreate(payload: Uint8Array): CharCreateRequest | null {
  const reader = new ByteReader(payload);
  try {
    const name = reader.readCString();
    if (reader.remaining < 9) {
      return null;
    }
    return {
      name,
      race: reader.readU8(),
      classId: reader.readU8(),
      gender: reader.readU8(),
      skin: reader.readU8(),
      face: reader.readU8(),
      hairStyle: reader.readU8(),
      hairColor: reader.readU8(),
      facialStyle: reader.readU8(),
    };
  } catch {
    return null;
  }
}

export function describeWorldOpcode(opcode: number): string {
  return `${worldOpcodeName(opcode)} (${hexOpcode(opcode)})`;
}

/** The opcode name of an encoded (not yet sealed) server packet. */
function describePacketOpcode(packet: Uint8Array): string {
  const at = (packet[0]! & 0x80) !== 0 ? 3 : 2;
  return worldOpcodeName(packet[at]! | (packet[at + 1]! << 8));
}

/** `MOVEMENTFLAG_FORWARD | STRAFE_LEFT | STRAFE_RIGHT | FALLING` for `GetLeewayBonusRangeForTargets`. */
const LEEWAY_MOVE_FLAGS = 0x00000001 | 0x00000004 | 0x00000008 | 0x00001000;
const MOVEMENTFLAG_WALKING = 0x00000100;
const MAX_SHEATH_STATE = 3;
const UNIT_FIELD_BYTES_2 = 0x0006 + 0x0074;

function clientStandState(state: number): boolean {
  return state === 0 || state === 1 || state === 3 || state === 8;
}

function isSitState(state: number): boolean {
  return state === 1 || state === 2 || state === 4 || state === 5 || state === 6;
}

function encodeHealth(crypt: WorldCrypt, characterId: number, health: number): Uint8Array {
  return encodeServerPacket(0x0a9, healthUpdateBlock(characterId, health));
}

export const PLAYER_EXPLORED_ZONES_SIZE = 128;

/** `FactionEntry::reputationListID` from `Faction.dbc` (-1 when the faction has no list slot). */
function sFactionStoreListId(factionId: number): number {
  return sFactionStore.lookupEntry(factionId)?.reputationListID ?? -1;
}

/** The guid of a character just created (`characters.name` is unique). */
async function createdGuid(db: Db, name: string): Promise<number> {
  const [row] = await queryFields(db, "SELECT guid FROM characters WHERE name = ?", name);
  return row ? Number(row[0]) : 0;
}

function worldDatabase(world: { tables?: () => WorldTables } | null): WorldTables | null {
  if (typeof world?.tables !== "function") {
    return null;
  }
  return world.tables();
}

function hasEquippedItem(inventory: Inventory): boolean {
  const bag = inventory.slots.get(0);
  if (!bag) {
    return false;
  }
  for (const slot of bag.keys()) {
    if (slot < 19) {
      return true;
    }
  }
  return false;
}

function spellRecoveryFromStores(dbc: DbcStores | null): Map<number, SpellRecovery> {
  const map = new Map<number, SpellRecovery>();
  if (!dbc) {
    return map;
  }
  for (const [id, record] of dbc.spells) {
    const recovery = spellRecoveryFromRecord(record);
    if (recovery) {
      map.set(id, recovery);
    }
  }
  return map;
}

const SPELL_EFFECT_PARRY = 22;
const SPELL_EFFECT_BLOCK = 23;
const SPELL_EFFECT_DUAL_WIELD = 40;

/** Effects of the known spells that set `m_canParry`, `m_canBlock`, and dual wield when learned. */
function learnedSpellEffects(dbc: DbcStores | null, spells: readonly number[]): Set<number> {
  const effects = new Set<number>();
  if (!dbc) {
    return effects;
  }
  for (const spellId of spells) {
    const spell = dbc.spells.get(spellId);
    if (!spell) {
      continue;
    }
    for (const key of ["Effect1", "Effect2", "Effect3"]) {
      const effect = Number(spell[key] ?? 0);
      if (effect) {
        effects.add(effect);
      }
    }
  }
  return effects;
}

/** The spell map of a session without a combat world: the player is the only unit. */
function soloSpellMap(spells: SpellStore, self: () => SpellUnit | null): SpellMap {
  return {
    spells,
    now: () => Date.now(),
    unit: (guid) => {
      const unit = self();
      return unit && unit.guid === guid ? unit : null;
    },
    unitsInRange: (reference, radius, center) => {
      const unit = self();
      if (!unit) return [];
      const at = center ?? reference.position();
      const pos: UnitPosition = unit.position();
      return (pos.x - at.x) ** 2 + (pos.y - at.y) ** 2 + (pos.z - at.z) ** 2 <= radius * radius ? [unit] : [];
    },
  };
}

/** `INVENTORY_SLOT_ITEM_START..END`, the keyring, and the currency slots, then the equipped bags (`Player::HasItemCount`). */
function carriedItems(inventory: Inventory | null): { bag: number; slot: number; entry: number; count: number }[] {
  if (!inventory) return [];
  const rows: { bag: number; slot: number; entry: number; count: number }[] = [];
  const backpack = inventory.slots.get(0);
  for (const [slot, item] of backpack ?? []) {
    if ((slot >= 23 && slot < 39) || (slot >= 86 && slot < 150)) rows.push({ bag: 0, slot, entry: item.entry, count: item.count });
  }
  for (let slot = 19; slot < 23; slot++) {
    const bag = backpack?.get(slot);
    if (!bag) continue;
    for (const [inner, item] of inventory.slots.get(bag.guid) ?? []) rows.push({ bag: bag.guid, slot: inner, entry: item.entry, count: item.count });
  }
  return rows;
}

function inventoryCount(inventory: Inventory | null, entry: number): number {
  return carriedItems(inventory).reduce((total, row) => (row.entry === entry ? total + row.count : total), 0);
}

/** `Player::DestroyItemCount` over the carried items (the inventory is written back at the next save). */
function destroyInventoryCount(inventory: Inventory | null, entry: number, count: number): void {
  if (!inventory) return;
  let left = count;
  for (const row of carriedItems(inventory)) {
    if (left <= 0) break;
    if (row.entry !== entry) continue;
    const take = Math.min(left, row.count);
    destroyItem(inventory, row.bag, row.slot, take >= row.count ? 0 : take);
    left -= take;
  }
}
