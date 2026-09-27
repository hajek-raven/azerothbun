import { inArray } from "drizzle-orm";
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
import { deleteCharacter, loadCharacterKit, type CharacterLoginKit } from "../characters/store.ts";
import { CLIENT_BUILD, findAccount, findCharacter, findCharacterById, listCharacters, type Character } from "../db.ts";
import { hexOpcode, log } from "../log.ts";
import { ByteReader, ByteWriter } from "../net/byte-buffer.ts";
import { fallDamage, farTeleportPackets, forceSpeedChangePacket, forceSpeedPacket, movementKind, speedMoveType, movingOrTurning, nearTeleportPacket, readMoveInfo, shouldResetFall, speedVerdict, transportTooFar, writeMoveInfo } from "./movement.ts";
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
import { destroyItem, type Inventory } from "../items/bags.ts";
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
import { PlayerView, type OnlinePlayer } from "./players.ts";
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
import { fieldUpdateBlock, healthUpdateBlock, packedGuid as packedGuidOf, standStateUpdateBlock, type PlayerFieldStats } from "./update-object.ts";
import { CMSG_PLAYER_LOGIN, worldOpcodeName } from "./opcodes.ts";
import { creatureQueryPayload, diffVisible, gameObjectQueryPayload, indexSpawns, itemQueryPayload, spawnUpdatePayloads, type SpawnIndex } from "./spawn.ts";
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

export class WorldSession {
  crypt: WorldCrypt | null = null;
  private readonly seed = crypto.getRandomValues(new Uint8Array(4));
  private accountId = 0;
  /** `WorldSession::m_Tutorials`, loaded at `CMSG_AUTH_SESSION` and saved with the character. */
  private tutorials = new AccountTutorials();
  private character: Character | null = null;
  private kit: CharacterLoginKit | null = null;
  private timeSyncCounter = 0;
  private pendingTimeSync: number | null = 0;
  private lastTimeSync = Date.now();
  private orderCounter = 1;
  private clientMoveTime = 0;
  private fallbackHealth = 60;
  private standState = -1;
  /** The player's unit/player update fields and stat modifiers (`Player` stat system). */
  stats: PlayerStats | null = null;
  skills: PlayerSkills | null = null;
  private regen: PlayerRegen | null = null;
  /** `UNIT_FIELD_BYTES_0` display power from `ChrClasses.DisplayPower`. */
  private powerType = 0;
  private readonly env: PlayerEnvironment;
  private lastFallZ = 0;
  private lastFallTime = 0;
  private clockDelta = 0;
  private syncSentAt = 0;
  private pendingTeleport: { map: number; x: number; y: number; z: number; orientation: number; far: boolean } | null = null;
  private logoutTimer: ReturnType<typeof setTimeout> | null = null;
  private inCombat = false;
  private falling = false;
  private deathState: DeathState = "alive";
  private graveyards: GraveyardStore | null = null;
  private resurrectRequest: ResurrectRequestData | null = null;
  private readonly knownSpawns = new Set<bigint>();
  private inventory: Inventory | null = null;
  private useCooldowns: UseCooldowns = createUseCooldowns();
  private savedSpellCooldowns: SavedSpellCooldown[] = [];
  private savedAuras: SavedAura[] = [];
  /** The player's `Unit` for spells and auras (null without a spell store or before the stats load). */
  unit: PlayerSpellUnit | null = null;
  /** Spell packets produced while no socket is attached (returned from the handler instead). */
  private spellOutbox: Uint8Array[] = [];
  /** `Player::GetSelection` */
  private selection = 0n;
  /** The spell map when there is no combat world (no spawns loaded): only this player. */
  private soloMap: SpellMap | null = null;
  private vendorSession: VendorSession = createVendorSession();
  /** `Player::m_lootGuid`: the corpse whose loot window is open. */
  private lootGuid = 0n;
  private readonly spellRecovery: ReadonlyMap<number, SpellRecovery>;
  private readonly spawns: SpawnIndex | null;
  private seen: OnlinePlayer | null = null;
  private deliver: ((packet: Uint8Array) => void) | null = null;
  private readonly talk: Talk | null;
  /** Creature combat shared by every session on this spawn index (`Map` units, threat, and swing timers). */
  private readonly combat: CombatWorld | null;
  /** Last `MovementInfo.flags` from the client, for the melee leeway range. */
  private moveFlags = 0;
  readonly greeting: Uint8Array;

  /** `Player::SaveToDB` runs queued; the next save and the next packet wait for the previous one. */
  private pendingSave: Promise<void> = Promise.resolve();
  /** `item_instance.durability` of the carried items, for `Item::IsBroken` in the stat system. */
  private readonly itemDurability = new Map<number, number>();

  constructor(
    private readonly db: SessionDatabases,
    private readonly world: WorldData | null = null,
    spawns: SpawnIndex | null = null,
    private readonly players: PlayerView = new PlayerView(),
    private readonly dbc: DbcStores | null = null,
    private readonly party: QuestParty = new QuestParty(),
    spellRecovery?: ReadonlyMap<number, SpellRecovery>,
    env?: PlayerEnvironment,
    private readonly spellStore: SpellStore | null = null,
    private readonly itemDbc: ItemDbc = ItemDbc.empty(),
  ) {
    this.env = env ?? defaultPlayerEnvironment();
    this.spawns = spawns ?? (world ? indexSpawns(world) : null);
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
  private get health(): number {
    return this.stats ? this.stats.health : this.fallbackHealth;
  }

  private set health(value: number) {
    if (this.stats) {
      this.stats.setHealth(value);
    } else {
      this.fallbackHealth = Math.max(0, Math.trunc(value));
    }
  }

  private get maxHealth(): number {
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
    this.flushFields();
  }

  private updateRegen(diff: number): void {
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
  private fieldUpdates(): { self: Uint8Array | null; others: Uint8Array | null } {
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
  private flushFields(): void {
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
  private publicFieldStats(): PlayerFieldStats | undefined {
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
    }
    return packets;
  }

  private progressContext(): ProgressContext | null {
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

  private async handleOpcode(opcode: number, payload: Uint8Array): Promise<WorldResult> {
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

  private async handleCharEnum(): Promise<WorldResult> {
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
    log("world", `sending SMSG_CHAR_ENUM with ${characters.length} character(s)`);
    return { packets: [charEnumPacket(this.crypt, characters, gearByGuid)], sent: ["SMSG_CHAR_ENUM"], close: false };
  }

  private async handleAuthSession(payload: Uint8Array): Promise<WorldResult> {
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
    this.accountId = account.id;
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

  private async handlePlayerLogin(payload: Uint8Array): Promise<WorldResult> {
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
    this.knownSpawns.clear();
    log("world", `${playing.name} entering map ${playing.map}`);
    await this.talk?.login(this.db.characters, playing);
    const worldDb = worldDatabase(this.world);
    this.inventory = await loadPlayInventory(this.db.characters, playing.guid, worldDb);
    await this.refreshItemDurability();
    this.useCooldowns = createUseCooldowns();
    this.vendorSession = createVendorSession();
    this.lootGuid = 0n;
    await this.loadPlayerUnit(playing, login);
    const entered = this.withSpawns(loginPackets(this.crypt, playing, login), [...LOGIN_PACKET_NAMES]);
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
  private async loadPlayerUnit(character: Character, login: LoginCharacterState): Promise<void> {
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
  private equippedStatItems(): Map<number, EquippedStatItem> {
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
  private itemBroken(itemGuid: number, maxDurability: number): boolean {
    if (maxDurability <= 0) {
      return false;
    }
    return this.itemDurability.get(itemGuid) === 0;
  }

  /** Reloads `item_instance.durability` for everything in the inventory. */
  private async refreshItemDurability(): Promise<void> {
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
  private syncEquipmentStats(): void {
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

  private async prepareLogin(character: Character): Promise<LoginCharacterState> {
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

  private applyDbc(
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
  private saveLoggedInCharacter(character: Character): void {
    const current = this.character?.guid === character.guid;
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
  private syncUnitToCharacter(character: Character, kit: CharacterLoginKit): void {
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

  private appendPlay(
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
  private async handlePlay(opcode: number, payload: Uint8Array): Promise<WorldResult | null> {
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
  private updateCombat(_diff: number): void {
    this.combat?.update(Date.now());
  }

  /** `WorldSession::HandleSetSelectionOpcode` → `Player::SetSelection` (`UNIT_FIELD_TARGET`). */
  private handleSetSelection(payload: Uint8Array): WorldResult {
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
  private handleAttackSwing(payload: Uint8Array): WorldResult {
    const quiet = { packets: [] as Uint8Array[], sent: [] as string[], close: false, quiet: true };
    if (!this.character || !this.combat || payload.length < 8) {
      return quiet;
    }
    this.combat.attackSwing(this.character.guid, new ByteReader(payload).readU64());
    return quiet;
  }

  /** `WorldSession::HandleAttackStopOpcode` */
  private handleAttackStop(): WorldResult {
    if (this.character) {
      this.combat?.attackStop(this.character.guid);
    }
    return { packets: [], sent: [], close: false, quiet: true };
  }

  /** `WorldSession::HandleSetSheathedOpcode` → `Unit::SetSheath` (`UNIT_FIELD_BYTES_2` byte 0). */
  private handleSetSheathed(payload: Uint8Array): WorldResult {
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
  private lootContext(character: Character, inventory: Inventory): LootPlayCtx {
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
  private lootPlayer(character: Character): LootPlayer {
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
  private storeCurrencyLoot(character: Character, loot: Loot, lootSlot: number): void {
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
  private lootEnv(): LootEnv {
    const world = worldDatabase(this.world);
    return {
      itemProto: (entry) => lootItemProto(world, entry),
      enchSuffixFactor: (entry) => generateEnchSuffixFactorFor(world, this.itemDbc, entry),
      randomPropertyId: (entry) => generateItemRandomPropertyId(world, this.itemDbc, entry),
    };
  }

  /** `Player` as the melee code sees it. */
  private combatPlayer(character: Character): CombatPlayer {
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
      gameMaster: () => false,
      sitting: () => isSitState(this.standState),
      standUp: () => {
        const stood = this.applyStandState(0);
        for (const packet of stood.packets) {
          this.deliver?.(packet);
        }
      },
      moving: () => (this.moveFlags & LEEWAY_MOVE_FLAGS) !== 0 && (this.moveFlags & MOVEMENTFLAG_WALKING) === 0,
      mounted: () => false,
      knows: (guid) => this.knownSpawns.has(guid),
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
      refreshSpawns: () => {
        if (!self()) {
          return;
        }
        for (const packet of this.spawnPackets()) {
          this.deliver?.(packet);
        }
      },
    };
  }

  /** The `PlayerStats` values `Unit::CalculateMeleeDamage` and `RollMeleeOutcomeAgainst` read. */
  private playerMelee(): PlayerMelee | null {
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

  private readonly weaponSchools = new Map<number, [number, number]>();

  /** `item_template.dmg_type1` / `dmg_type2` for the weapon's damage entries. */
  private weaponDamageSchool(entry: number, index: number): number {
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
  private takeCombatDamage(amount: number): boolean {
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
  private addRage(points: number): void {
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
  private rewardKill(kill: CreatureKill): Loot | null {
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

  private handleTalk(opcode: number, payload: Uint8Array): WorldResult | null {
    const character = this.character;
    const kit = this.kit;
    if (!this.talk || !this.crypt || !character || !kit) {
      return null;
    }
    const packets = this.talk.handle(opcode, payload, character, kit, this.knownSpawns);
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

  private async handleCharCreate(payload: Uint8Array): Promise<WorldResult> {
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
    log("world", `created ${draft.name} race ${draft.race} class ${draft.classId}`);
    return { packets: [charCreatePacket(this.crypt, CHAR_CREATE_SUCCESS)], sent: ["SMSG_CHAR_CREATE"], close: false };
  }

  private async handleCharDelete(payload: Uint8Array): Promise<WorldResult> {
    if (!this.crypt || payload.length < 8) {
      return { packets: [], sent: [], close: true };
    }
    const guid = Number(new ByteReader(payload).readU64() & 0xffffffffn);
    if (this.character?.guid === guid) {
      return { packets: [charDeletePacket(this.crypt, CHAR_DELETE_FAILED)], sent: ["SMSG_CHAR_DELETE"], close: false };
    }
    const removed = await deleteCharacter(this.db.characters, this.accountId, guid);
    if (removed) {
      await refreshRealmCharacterCount(this.db.characters, this.db.login, this.accountId);
      log("world", `deleted character ${guid}`);
    }
    return {
      packets: [charDeletePacket(this.crypt, removed ? CHAR_DELETE_SUCCESS : CHAR_DELETE_FAILED)],
      sent: ["SMSG_CHAR_DELETE"],
      close: false,
    };
  }

  private handleMovement(opcode: number, kind: NonNullable<ReturnType<typeof movementKind>>, payload: Uint8Array): WorldResult {
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
    const info = readMoveInfo(kind, payload);
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
    const spawned = this.spawnPackets();
    const visible = this.playerPackets();
    packets.push(...spawned, ...visible);
    sent.push(...spawned.map(() => "SMSG_UPDATE_OBJECT"), ...visible.map(() => "SMSG_UPDATE_OBJECT"));
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
      return this.withSpawns([packet], ["MSG_MOVE_TELEPORT_ACK"]);
    }
    return { packets: farTeleportPackets(this.crypt, map, place), sent: ["SMSG_TRANSFER_PENDING", "SMSG_NEW_WORLD"], close: false };
  }

  private finishFarTeleport(): WorldResult {
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
    this.knownSpawns.clear();
    character.health = this.health;
    this.saveLoggedInCharacter(character);
    log("world", `${character.name} entered map ${character.map}`);
    return this.withSpawns(relocationPackets(this.crypt, character), ["SMSG_LOGIN_VERIFY_WORLD", "SMSG_UPDATE_OBJECT"]);
  }

  private handleCreatureQuery(payload: Uint8Array): WorldResult {
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

  private handleGameObjectQuery(payload: Uint8Array): WorldResult {
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

  private handleItemQuery(payload: Uint8Array): WorldResult {
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

  private withSpawns(packets: Uint8Array[], sent: string[]): WorldResult {
    const spawned = this.spawnPackets();
    const visible = this.playerPackets();
    sent.push(...spawned.map(() => "SMSG_UPDATE_OBJECT"), ...visible.map(() => "SMSG_UPDATE_OBJECT"));
    return { packets: packets.concat(spawned, visible), sent, close: false };
  }

  private spawnPackets(): Uint8Array[] {
    const character = this.character;
    if (!this.crypt || !this.world || !this.spawns || !character) {
      return [];
    }
    const diff = diffVisible(
      this.spawns,
      this.world,
      { map: character.map, x: character.position_x, y: character.position_y, z: character.position_z },
      this.knownSpawns,
      this.combat ? (spawnGuid) => this.combat?.liveView(spawnGuid, character.guid) ?? null : undefined,
    );
    return spawnUpdatePayloads(diff.creates, diff.gone).map((payload) => encodeServerPacket(SMSG_UPDATE_OBJECT, payload));
  }

  private playerPackets(): Uint8Array[] {
    const seen = this.ensureSeen();
    if (!this.crypt || !seen) {
      return [];
    }
    const diff = this.players.sync(seen);
    return spawnUpdatePayloads(diff.creates, diff.gone).map((payload) => encodeServerPacket(SMSG_UPDATE_OBJECT, payload));
  }

  private ensureSeen(): OnlinePlayer | null {
    if (!this.crypt || !this.character) {
      return null;
    }
    if (this.seen) {
      return this.seen;
    }
    const character = this.character;
    const seen: OnlinePlayer = {
      guid: character.guid,
      known: new Set(),
      place: () => ({ map: character.map, x: character.position_x, y: character.position_y, z: character.position_z }),
      character: () => character,
      moveTime: () => this.clientMoveTime,
      standState: () => (this.standState < 0 ? 0 : this.standState),
      stats: () => this.publicFieldStats(),
      send: (opcode, payload) => {
        if (!this.crypt) {
          return;
        }
        this.deliver?.(encodeServerPacket(opcode, payload));
      },
    };
    this.seen = seen;
    this.players.bind(seen);
    this.bindShare(character);
    this.combat?.addPlayer(this.combatPlayer(character));
    return seen;
  }

  private bindShare(character: Character): void {
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

  private leaveWorld(): void {
    if (!this.character) {
      return;
    }
    this.party.unbind(this.character.guid);
    this.combat?.removePlayer(this.character.guid);
    this.inCombat = false;
    this.talk?.setDivider(0n);
    this.players.leave(this.character.guid);
    this.seen = null;
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
    this.knownSpawns.clear();
  }

  private async handleNameQuery(payload: Uint8Array): Promise<WorldResult> {
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

  private handleQueryTime(): WorldResult {
    if (!this.crypt) {
      return { packets: [], sent: [], close: true };
    }
    return { packets: [queryTimeResponse(this.crypt)], sent: ["SMSG_QUERY_TIME_RESPONSE"], close: false };
  }

  private handleZoneUpdate(payload: Uint8Array): WorldResult {
    if (!this.character || payload.length < 4) {
      return { packets: [], sent: [], close: false };
    }
    this.character.zone = new ByteReader(payload).readU32();
    this.character.health = this.health;
    this.saveLoggedInCharacter(this.character);
    log("world", `${this.character.name} zone ${this.character.zone}`);
    return { packets: [], sent: [], close: false, quiet: true };
  }

  private handleWorldStateTimer(): WorldResult {
    if (!this.crypt) {
      return { packets: [], sent: [], close: true };
    }
    return { packets: [worldStateTimer(this.crypt)], sent: ["SMSG_WORLD_STATE_UI_TIMER_UPDATE"], close: false };
  }

  private handleTimeSync(payload: Uint8Array): WorldResult {
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

  private handleStandState(payload: Uint8Array): WorldResult {
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

  private applyStandState(state: number): { packets: Uint8Array[]; sent: string[]; changed: boolean } {
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

  private deathFields(): PlayerDeathFields {
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

  private graveyardStore(): GraveyardStore {
    if (this.graveyards) {
      return this.graveyards;
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

  private encodeBodies(packets: readonly { opcode: number; body: Uint8Array }[]): { packets: Uint8Array[]; sent: string[] } {
    if (!this.crypt) {
      return { packets: [], sent: [] };
    }
    return {
      packets: packets.map((packet) => encodeServerPacket(packet.opcode, packet.body)),
      sent: packets.map((packet) => worldOpcodeName(packet.opcode)),
    };
  }

  private applyDeath(died: ReturnType<typeof onDeath>): { packets: Uint8Array[]; sent: string[] } {
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

  private applyResurrect(result: {
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

  private async handleRepop(): Promise<WorldResult> {
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

  private async handleReclaimCorpse(): Promise<WorldResult> {
    if (!this.crypt || !this.character) {
      return { packets: [], sent: [], close: false, quiet: true };
    }
    const result = await reclaimCorpse(this.db.characters, this.deathFields());
    if (!result) {
      return { packets: [], sent: [], close: false, quiet: true };
    }
    return this.applyResurrect(result);
  }

  private async handleSpiritHealer(): Promise<WorldResult> {
    if (!this.crypt || !this.character) {
      return { packets: [], sent: [], close: false, quiet: true };
    }
    return this.applyResurrect(await spiritHealerResurrect(this.db.characters, this.deathFields(), this.graveyardStore()));
  }

  private async handleResurrect(payload: Uint8Array): Promise<WorldResult> {
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

  private async handleCorpseQuery(): Promise<WorldResult> {
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

  private async equipmentSetList(guid: number): Promise<Uint8Array> {
    return equipmentSetListPacket(await loadSets(this.db.characters, guid));
  }

  private async handleEquipmentSetSave(payload: Uint8Array): Promise<WorldResult> {
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

  private async handleEquipmentSetDelete(payload: Uint8Array): Promise<WorldResult> {
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

  private handleLogout(): WorldResult {
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

  private handleLogoutCancel(): WorldResult {
    if (!this.crypt || !this.character) {
      return { packets: [], sent: [], close: false };
    }
    this.clearLogoutTimer();
    return this.encodeLogout(cancel().packets);
  }

  private handleCastSpell(payload: Uint8Array): WorldResult {
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
  private castSpellRequest(castCount: number, spellId: number, targets: CastTargets, itemCast?: ItemCast): WorldResult {
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
  private itemIsPotion(itemGuid: number): boolean {
    const pos = this.inventory?.byGuid.get(itemGuid);
    const item = pos ? this.inventory?.slots.get(pos.bag)?.get(pos.slot) : undefined;
    return !!item && item.template.class === 0 && item.template.subclass === 1;
  }

  /** A spell-system packet for this player: straight to the socket, or into the handler's result. */
  private sendSpellPacket(packet: Uint8Array): void {
    if (this.deliver) this.deliver(packet);
    else this.spellOutbox.push(packet);
  }

  private drainSpellOutbox(): WorldResult {
    const packets = this.spellOutbox;
    this.spellOutbox = [];
    return { packets, sent: packets.map(() => "SPELL"), close: false, quiet: packets.length === 0 };
  }

  /** `WorldSession::HandleCancelCastOpcode` / `HandleCancelChanneling` */
  private handleCancelCast(payload: Uint8Array, hasCounter: boolean): WorldResult {
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
  private handleCancelAura(payload: Uint8Array): WorldResult {
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
  private playerHost(character: Character): import("./player-spell-unit.ts").PlayerHost {
    const self = (): boolean => this.character === character;
    return {
      map: () => {
        if (this.combat?.hasSpells) return this.combat;
        this.soloMap ??= soloSpellMap(this.spellStore!, () => this.unit);
        return this.soloMap;
      },
      position: () => ({ map: character.map, x: character.position_x, y: character.position_y, z: character.position_z, o: character.orientation }),
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
      gameMaster: () => false,
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
      knows: (guid) => !highGuidIsCreature(guid) || this.knownSpawns.has(guid),
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

  private handleActivateTaxi(payload: Uint8Array, express: boolean): WorldResult {
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

  private applyOfflineRestOnLogin(character: Character): void {
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

  private applyLogoutRest(character: Character): void {
    const snapshot = logoutRestSnapshot(character, Math.floor(Date.now() / 1000));
    character.rest_bonus = snapshot.rest_bonus;
    character.restState = snapshot.restState;
    character.logout_time = snapshot.logout_time;
    character.is_logout_resting = snapshot.is_logout_resting;
    character.playerFlags = snapshot.playerFlags;
  }

  private finishLogout(already: readonly LogoutPacket[]): WorldResult {
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

  private encodeLogout(packets: readonly LogoutPacket[]): WorldResult {
    if (!this.crypt) {
      return { packets: [], sent: [], close: false };
    }
    return {
      packets: packets.map((packet) => encodeServerPacket(packet.opcode, packet.body)),
      sent: packets.map((packet) => packet.name),
      close: false,
    };
  }

  private clearLogoutTimer(): void {
    if (this.logoutTimer) {
      clearTimeout(this.logoutTimer);
      this.logoutTimer = null;
    }
  }

  /** `HandleTutorialFlag`, `HandleTutorialClear`, `HandleTutorialReset` (`STATUS_LOGGEDIN`). */
  private handleTutorial(opcode: number, payload: Uint8Array): WorldResult {
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

  private handleRealmSplit(payload: Uint8Array): WorldResult {
    if (!this.crypt || payload.length < 4) {
      return { packets: [], sent: [], close: true };
    }
    const unk = new ByteReader(payload).readU32();
    return { packets: [realmSplitPacket(this.crypt, unk)], sent: ["SMSG_REALM_SPLIT"], close: false };
  }

  private handleAccountDataTimes(): WorldResult {
    if (!this.crypt) {
      return { packets: [], sent: [], close: true };
    }
    return { packets: [accountDataTimesPacket(this.crypt)], sent: ["SMSG_ACCOUNT_DATA_TIMES"], close: false };
  }

  private handlePing(payload: Uint8Array): WorldResult {
    if (!this.crypt || payload.length < 4) {
      return { packets: [], sent: [], close: true };
    }
    const ping = new ByteReader(payload).readU32();
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
