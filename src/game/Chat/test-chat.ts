/**
 * Test harness for the chat command system: the real `acore_world` (strings, `command`, `game_tele`), throwaway
 * `acore_test_*` auth and character databases, and in-world sessions for the seeded accounts.
 */
import { executeStatement } from "../../database/database.ts";
import { setDatabaseEnv } from "../../database/DatabaseEnv.ts";
import { seededTestDatabases } from "../../database/test-db.ts";
import { acoreWorldData } from "../../data/test-world-data.ts";
import type { WorldData } from "../../data/world.ts";
import { saveSessionKey, CLIENT_BUILD } from "../../db.ts";
import { ByteReader, ByteWriter } from "../../net/byte-buffer.ts";
import { SpellStore } from "../../spells/spell-info.ts";
import { AddCommandsScripts } from "../../scripts/Commands/cs_script_loader.ts";
import { CMSG_PLAYER_LOGIN } from "../../world/opcodes.ts";
import { authSeed, CMSG_AUTH_SESSION, sessionDigest } from "../../world/packets.ts";
import { QuestParty } from "../../world/party.ts";
import { PlayerView } from "../../world/players.ts";
import { WorldSession } from "../../world/session.ts";
import { mapCreatureLocator, type CreatureLocator } from "../../world/map-world.ts";
import { setUpTestMaps } from "../../world/map-world.test-util.ts";
import { sAccountMgr } from "../Accounts/AccountMgr.ts";
import { sCharacterCache } from "../Cache/CharacterCache.ts";
import { loadDBCStores } from "../DataStores/DBCStores.ts";
import { sGameEventMgr } from "../Events/GameEventMgr.ts";
import { sObjectMgr } from "../Globals/ObjectMgr.ts";
import { sGraveyard } from "../Misc/GameGraveyard.ts";
import { setMapMgrWorld } from "../Maps/MapMgr.ts";
import { sWorldSessionMgr } from "../Server/WorldSessionMgr.ts";
import { sSpellMgr } from "../Spells/SpellMgr.ts";
import { clearCommandScripts, LoadCommandMap, setCommandTableSource } from "./ChatCommands/ChatCommand.ts";
import { SMSG_MESSAGECHAT, SMSG_NOTIFICATION } from "./Chat.ts";
import type { Db } from "../../database/database.ts";

export type ChatTestEnv = {
  world: WorldData;
  db: { login: Db; characters: Db };
  spawns: CreatureLocator;
  players: PlayerView;
  party: QuestParty;
  spellStore: SpellStore;
};

let dbcLoaded: Promise<void> | null = null;
let spellStore: Promise<SpellStore> | null = null;

/** Fresh auth and character databases, the command map, and the managers the commands read. */
export async function chatTestEnv(): Promise<ChatTestEnv> {
  const world = await acoreWorldData();
  const db = await seededTestDatabases(world.tables());
  setDatabaseEnv({ login: db.login, characters: db.characters, world: null });
  dbcLoaded ??= loadDBCStores("data/dbc", world.tables());
  await dbcLoaded;
  spellStore ??= SpellStore.load("data/dbc", world.tables());
  const spells = await spellStore;
  setMapMgrWorld(world.tables());
  sObjectMgr.setWorld(world, world.tables(), null);
  sGraveyard.setWorld(world.tables(), null);
  sObjectMgr.loadAcoreStrings();
  sObjectMgr.loadGameTele();
  sGameEventMgr.loadFromDB(world.tables());
  await sObjectMgr.loadReservedPlayerNames(db.characters);
  await sObjectMgr.loadProfanityNames(db.characters);
  sSpellMgr.setStore(spells);
  await sAccountMgr.loadRBAC(db.login);
  await sCharacterCache.loadCharacterCacheStorage(db.characters);
  clearCommandScripts();
  AddCommandsScripts();
  setCommandTableSource(world.tables());
  LoadCommandMap();
  for (const session of [...sWorldSessionMgr.GetAllSessions()]) sWorldSessionMgr.delete(session);
  setUpTestMaps();
  return { world, db, spawns: mapCreatureLocator, players: new PlayerView(), party: new QuestParty(), spellStore: spells };
}

export type TestClient = {
  session: WorldSession;
  /** Every server packet so far (opcode and body). */
  received: { opcode: number; payload: Uint8Array }[];
  /** `CMSG_MESSAGECHAT` say with this text. */
  say(text: string): Promise<void>;
  /** The system chat lines and notifications received since the last call. */
  takeMessages(): string[];
};

/** Logs `account` in with `security` (`account_access`) and enters the world with its character. */
export async function loginClient(env: ChatTestEnv, account: string, characterGuid: number, security = 0): Promise<TestClient> {
  const sessionKey = crypto.getRandomValues(new Uint8Array(40));
  await saveSessionKey(env.db.login, account, sessionKey);
  if (security) {
    await executeStatement(env.db.login, "REPLACE INTO account_access (id, gmlevel, RealmID, comment) SELECT id, ?, -1, '' FROM account WHERE username = ?", security, account);
  }
  const session = new WorldSession(env.db, env.world, env.spawns, env.players, null, env.party, undefined, undefined, env.spellStore);
  const received: { opcode: number; payload: Uint8Array }[] = [];
  const decode = (packet: Uint8Array): void => {
    received.push({ opcode: packet[2]! | (packet[3]! << 8), payload: packet.slice(4) });
  };
  session.attach(decode);
  sWorldSessionMgr.add(session);
  const clientSeed = Uint8Array.from([1, 2, 3, 4]);
  const digest = sessionDigest(account, clientSeed, authSeed(session.greeting), sessionKey);
  (await session.handle(CMSG_AUTH_SESSION, authSession(account, clientSeed, digest))).packets.forEach(decode);
  (await session.handle(CMSG_PLAYER_LOGIN, new ByteWriter().writeU64(BigInt(characterGuid)).toUint8Array())).packets.forEach(decode);
  let seen = received.length;
  return {
    session,
    received,
    async say(text: string) {
      const body = new ByteWriter().writeU32(1 /* CHAT_MSG_SAY */).writeU32(7 /* LANG_COMMON */).writeCString(text).toUint8Array();
      (await session.handle(0x095, body)).packets.forEach(decode);
    },
    takeMessages() {
      const out: string[] = [];
      for (const packet of received.slice(seen)) {
        if (packet.opcode === SMSG_MESSAGECHAT) out.push(chatText(packet.payload));
        else if (packet.opcode === SMSG_NOTIFICATION) out.push(new ByteReader(packet.payload).readCString());
      }
      seen = received.length;
      return out;
    },
  };
}

/** The message text of an `SMSG_MESSAGECHAT` built by `BuildChatPacket` for system, say, and whisper types. */
export function chatText(payload: Uint8Array): string {
  const reader = new ByteReader(payload);
  reader.readU8();
  reader.readU32();
  reader.readU64();
  reader.readU32();
  reader.readU64();
  const length = reader.readU32();
  return new TextDecoder().decode(payload.subarray(payload.length - length - 1, payload.length - 2));
}

function authSession(account: string, clientSeed: Uint8Array, digest: Uint8Array): Uint8Array {
  return new ByteWriter()
    .writeU32(CLIENT_BUILD)
    .writeU32(0)
    .writeCString(account)
    .writeU32(0)
    .writeBytes(clientSeed)
    .writeU32(0)
    .writeU32(0)
    .writeU32(1)
    .writeU64(0n)
    .writeBytes(digest)
    .writeU32(0)
    .toUint8Array();
}
