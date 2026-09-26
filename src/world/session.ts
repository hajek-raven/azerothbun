import type { Database } from "bun:sqlite";
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
import { saveCharacterState } from "../characters/persist.ts";
import { characterStartFromDbc } from "../characters/dbc-start.ts";
import { deleteCharacter, loadCharacterKit, type CharacterLoginKit } from "../characters/store.ts";
import { CLIENT_BUILD, findAccount, findCharacter, findCharacterById, listCharacters, type Character } from "../db.ts";
import { hexOpcode, log } from "../log.ts";
import { ByteReader } from "../net/byte-buffer.ts";
import { fallDamage, farTeleportPackets, forceSpeedPacket, movementKind, movingOrTurning, nearTeleportPacket, readMoveInfo, shouldResetFall, speedVerdict, transportTooFar, writeMoveInfo } from "./movement.ts";
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
import { healthUpdateBlock, standStateUpdateBlock, type PlayerFieldStats } from "./update-object.ts";
import { CMSG_PLAYER_LOGIN, worldOpcodeName } from "./opcodes.ts";
import { creatureQueryPayload, diffVisible, gameObjectQueryPayload, indexSpawns, itemQueryPayload, spawnUpdatePayloads, type SpawnIndex } from "./spawn.ts";
import { Talk, talkDataFor } from "./talk.ts";
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
  LOGIN_PACKET_NAMES,
  SMSG_CREATURE_QUERY_RESPONSE,
  SMSG_GAMEOBJECT_QUERY_RESPONSE,
  SMSG_ITEM_QUERY_SINGLE_RESPONSE,
  SMSG_STANDSTATE_UPDATE,
  SMSG_UPDATE_OBJECT,
  encodeServerPacket,
  loginPackets,
  type LoginCharacterState,
  logoutPackets,
  nameQueryResponse,
  parseAuthSession,
  pongPacket,
  environmentalDamagePacket,
  queryTimeResponse,
  realmSplitPacket,
  relocationPackets,
  sessionDigest,
  timeSyncRequest,
  worldStateTimer,
} from "./packets.ts";

export type WorldResult = { packets: Uint8Array[]; sent: string[]; close: boolean; quiet?: boolean };

const HEARTBEAT = 0x0ee;
const TIME_SYNC_INTERVAL_MS = 10_000;

export class WorldSession {
  crypt: WorldCrypt | null = null;
  private readonly seed = crypto.getRandomValues(new Uint8Array(4));
  private accountId = 0;
  private character: Character | null = null;
  private kit: CharacterLoginKit | null = null;
  private timeSyncCounter = 0;
  private pendingTimeSync: number | null = 0;
  private lastTimeSync = Date.now();
  private orderCounter = 1;
  private clientMoveTime = 0;
  private health = 60;
  private standState = -1;
  private readonly maxHealth = 60;
  private lastFallZ = 0;
  private lastFallTime = 0;
  private clockDelta = 0;
  private syncSentAt = 0;
  private pendingTeleport: { map: number; x: number; y: number; z: number; orientation: number; far: boolean } | null = null;
  private readonly knownSpawns = new Set<bigint>();
  private readonly spawns: SpawnIndex | null;
  private seen: OnlinePlayer | null = null;
  private deliver: ((packet: Uint8Array) => void) | null = null;
  private readonly talk: Talk | null;
  readonly greeting: Uint8Array;

  constructor(
    private readonly db: Database,
    private readonly world: WorldData | null = null,
    spawns: SpawnIndex | null = null,
    private readonly players: PlayerView = new PlayerView(),
    private readonly dbc: DbcStores | null = null,
    private readonly party: QuestParty = new QuestParty(),
  ) {
    this.spawns = spawns ?? (world ? indexSpawns(world) : null);
    this.talk = world ? new Talk(talkDataFor(world).gossip, talkDataFor(world).quests, world, this.party) : null;
    this.greeting = authChallengePacket(this.seed);
  }

  /** `CMSG_AUTH_SESSION` passed. AzerothCore creates the `WorldSession` at this point. */
  get authenticated(): boolean {
    return this.accountId !== 0;
  }

  /** `GetPlayer()` is set. */
  get inWorld(): boolean {
    return this.character !== null;
  }

  attach(deliver: (packet: Uint8Array) => void): void {
    this.deliver = deliver;
  }

  /** Socket closed. The player is saved and removed, same as `LogoutPlayer(true)` from `~WorldSession`. */
  disconnect(): void {
    if (this.character) {
      this.character.health = this.health;
      this.saveLoggedInCharacter(this.character);
    }
    this.leaveWorld();
  }

  handle(opcode: number, payload: Uint8Array): WorldResult {
    const talked = this.handleTalk(opcode, payload);
    if (talked) {
      return talked;
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
      case CMSG_STANDSTATECHANGE:
        return this.handleStandState(payload);
      default: {
        const kind = movementKind(opcode);
        if (kind) {
          return this.handleMovement(opcode, kind, payload);
        }
        return { packets: [], sent: [], close: false };
      }
    }
  }

  private handleCharEnum(): WorldResult {
    if (!this.crypt) {
      return { packets: [], sent: [], close: true };
    }
    const characters = listCharacters(this.db, this.accountId);
    log("world", `sending SMSG_CHAR_ENUM with ${characters.length} character(s)`);
    return { packets: [charEnumPacket(this.crypt, characters)], sent: ["SMSG_CHAR_ENUM"], close: false };
  }

  private handleAuthSession(payload: Uint8Array): WorldResult {
    if (this.crypt) {
      log("world", "duplicate CMSG_AUTH_SESSION, closing");
      return { packets: [], sent: [], close: true };
    }
    const packet = parseAuthSession(payload);
    if (!packet) {
      log("world", "malformed CMSG_AUTH_SESSION, closing");
      return { packets: [], sent: [], close: true };
    }
    const account = findAccount(this.db, upperLatin(packet.account));
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
    return { packets, sent, close: false };
  }

  private handlePlayerLogin(payload: Uint8Array): WorldResult {
    if (!this.crypt || payload.length < 8) {
      return { packets: [], sent: [], close: true };
    }
    const guid = new ByteReader(payload).readU64();
    const character = findCharacter(this.db, this.accountId, Number(guid & 0xffffffffn));
    if (!character) {
      log("world", `CMSG_PLAYER_LOGIN rejected, guid ${guid} is not on this account`);
      return { packets: [], sent: [], close: true };
    }
    const playing = { ...character };
    this.character = playing;
    this.timeSyncCounter = 0;
    this.pendingTimeSync = 0;
    this.lastTimeSync = Date.now();
    this.syncSentAt = performance.now();
    const login = this.prepareLogin(playing);
    this.health = login.stats?.health ?? playing.health;
    this.standState = -1;
    this.lastFallZ = playing.position_z;
    this.lastFallTime = 0;
    this.clockDelta = 0;
    this.pendingTeleport = null;
    this.knownSpawns.clear();
    log("world", `${playing.name} entering map ${playing.map}`);
    this.talk?.login(this.db, playing);
    const entered = this.withSpawns(loginPackets(this.crypt, playing, login), [...LOGIN_PACKET_NAMES]);
    for (const extra of this.talk?.loginUpdate(playing) ?? []) {
      entered.packets.push(encodeServerPacket(extra.opcode, extra.body, this.crypt));
      entered.sent.push(extra.name);
    }
    return entered;
  }

  private prepareLogin(character: Character): LoginCharacterState {
    const start = this.world?.playerStart(character.race, character.class, character.level) ?? null;
    let kit = loadCharacterKit(this.db, character.guid);
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
        ensureStartingKit(
          this.db,
          character.guid,
          { ...seeded, homebind: seeded.homebind },
          start.stats.health,
        );
      }
      character.health = start.stats.health;
      kit = loadCharacterKit(this.db, character.guid);
    }
    const enriched = this.applyDbc(kit, character.race, character.class, character.gender, character.level, knownSkills);
    kit = enriched.kit;
    this.kit = kit;
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
    return { spells: kit.spells, actions: kit.actions, homebind, factions: enriched.slots, stats };
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

  private saveLoggedInCharacter(character: Character): void {
    const kit = this.kit ?? loadCharacterKit(this.db, character.guid);
    this.talk?.save(this.db, character.guid);
    saveCharacterState(this.db, character, kit);
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
      packets: packets.map((row) => encodeServerPacket(row.opcode, row.body, this.crypt)),
      sent: packets.map((row) => row.name),
      close: false,
      quiet: packets.length === 0,
    };
  }

  private handleCharCreate(payload: Uint8Array): WorldResult {
    if (!this.crypt) {
      return { packets: [], sent: [], close: true };
    }
    const draft = parseCharCreate(payload);
    if (!draft) {
      return { packets: [charCreatePacket(this.crypt, CHAR_CREATE_FAILED)], sent: ["SMSG_CHAR_CREATE"], close: false };
    }
    const nameCode = characterCreateNameCode(this.db, draft.name);
    if (nameCode !== null) {
      return { packets: [charCreatePacket(this.crypt, nameCode)], sent: ["SMSG_CHAR_CREATE"], close: false };
    }
    if (listCharacters(this.db, this.accountId).length >= MAX_CHARACTERS_PER_ACCOUNT) {
      return { packets: [charCreatePacket(this.crypt, CHAR_CREATE_ACCOUNT_LIMIT)], sent: ["SMSG_CHAR_CREATE"], close: false };
    }
    const start = this.world?.playerStart(draft.race, draft.classId, 1) ?? null;
    if (!start || (draft.gender !== 0 && draft.gender !== 1)) {
      return { packets: [charCreatePacket(this.crypt, CHAR_CREATE_FAILED)], sent: ["SMSG_CHAR_CREATE"], close: false };
    }
    const kit = this.applyDbc(kitFromStart(start), draft.race, draft.classId, draft.gender, 1, start.skills).kit;
    try {
      createPlayableCharacter(
        this.db,
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
        kit,
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

  private handleCharDelete(payload: Uint8Array): WorldResult {
    if (!this.crypt || payload.length < 8) {
      return { packets: [], sent: [], close: true };
    }
    const guid = Number(new ByteReader(payload).readU64() & 0xffffffffn);
    if (this.character?.guid === guid) {
      return { packets: [charDeletePacket(this.crypt, CHAR_DELETE_FAILED)], sent: ["SMSG_CHAR_DELETE"], close: false };
    }
    const removed = deleteCharacter(this.db, this.accountId, guid);
    if (removed) {
      refreshRealmCharacterCount(this.db, this.accountId);
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
    character.position_x = info.x;
    character.position_y = info.y;
    character.position_z = info.z;
    character.orientation = info.orientation;
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
      }
    }
    if (shouldResetFall(this.lastFallTime, this.lastFallZ, info.fallTime, info.z, opcode === 0x0c9)) {
      this.lastFallZ = info.z;
      this.lastFallTime = info.fallTime;
    }
    if (kind === "speed" && info.speed !== null) {
      const verdict = speedVerdict(opcode, info.speed);
      if (verdict === "kick") {
        log("world", `${character.name} kicked for speed ${info.speed}`);
        return { packets: [], sent: [], close: true };
      }
      if (verdict === "correct") {
        const packet = forceSpeedPacket(this.crypt, opcode, info.guid, this.orderCounter);
        this.orderCounter += 1;
        if (packet) {
          packets.push(packet);
          sent.push("SMSG_FORCE_SPEED_CHANGE");
        }
      }
    }
    if (kind === "move") {
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
      packets: [encodeServerPacket(SMSG_CREATURE_QUERY_RESPONSE, creatureQueryPayload(this.world, entry), this.crypt)],
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
      packets: [encodeServerPacket(SMSG_GAMEOBJECT_QUERY_RESPONSE, gameObjectQueryPayload(this.world, entry), this.crypt)],
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
      packets: [encodeServerPacket(SMSG_ITEM_QUERY_SINGLE_RESPONSE, itemQueryPayload(this.world, entry), this.crypt)],
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
    );
    return spawnUpdatePayloads(diff.creates, diff.gone).map((payload) => encodeServerPacket(SMSG_UPDATE_OBJECT, payload, this.crypt));
  }

  private playerPackets(): Uint8Array[] {
    const seen = this.ensureSeen();
    if (!this.crypt || !seen) {
      return [];
    }
    const diff = this.players.sync(seen);
    return spawnUpdatePayloads(diff.creates, diff.gone).map((payload) => encodeServerPacket(SMSG_UPDATE_OBJECT, payload, this.crypt));
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
      send: (opcode, payload) => {
        if (!this.crypt) {
          return;
        }
        this.deliver?.(encodeServerPacket(opcode, payload, this.crypt));
      },
    };
    this.seen = seen;
    this.players.bind(seen);
    this.bindShare(character);
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
          this.deliver?.(encodeServerPacket(row.opcode, row.body, this.crypt));
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
    this.talk?.setDivider(0n);
    this.players.leave(this.character.guid);
    this.seen = null;
    this.character = null;
    this.kit = null;
    this.knownSpawns.clear();
  }

  private handleNameQuery(payload: Uint8Array): WorldResult {
    if (!this.crypt || payload.length < 8) {
      return { packets: [], sent: [], close: false };
    }
    const guid = new ByteReader(payload).readU64();
    const character = findCharacterById(this.db, Number(guid & 0xffffffffn));
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
    const packets = [encodeServerPacket(SMSG_STANDSTATE_UPDATE, Uint8Array.of(state & 0xff), this.crypt)];
    const sent = ["SMSG_STANDSTATE_UPDATE"];
    if (changed) {
      this.standState = state;
      const block = standStateUpdateBlock(this.character.guid, state);
      this.players.broadcast(this.character.guid, SMSG_UPDATE_OBJECT, block);
      packets.push(encodeServerPacket(SMSG_UPDATE_OBJECT, block, this.crypt));
      sent.push("SMSG_UPDATE_OBJECT");
    }
    return { packets, sent, changed };
  }

  private handleLogout(): WorldResult {
    if (!this.crypt || !this.character) {
      return { packets: [], sent: [], close: true };
    }
    this.character.health = this.health;
    this.saveLoggedInCharacter(this.character);
    log("world", `${this.character.name} logged out at ${this.character.position_x}, ${this.character.position_y}, ${this.character.position_z}`);
    const crypt = this.crypt;
    this.leaveWorld();
    return { packets: logoutPackets(crypt), sent: ["SMSG_LOGOUT_RESPONSE", "SMSG_LOGOUT_COMPLETE"], close: false };
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

function clientStandState(state: number): boolean {
  return state === 0 || state === 1 || state === 3 || state === 8;
}

function isSitState(state: number): boolean {
  return state === 1 || state === 2 || state === 4 || state === 5 || state === 6;
}

function encodeHealth(crypt: WorldCrypt, characterId: number, health: number): Uint8Array {
  return encodeServerPacket(0x0a9, healthUpdateBlock(characterId, health), crypt);
}
