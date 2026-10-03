/**
 * `ChatHandler` (`Chat.h` / `Chat.cpp`): system messages to one session, command parsing, and the selection and
 * link helpers commands share. `CliHandler` prints to the console instead; `AddonChannelCommandHandler` answers
 * commands sent over the addon channel.
 */
import { ByteWriter } from "../../net/byte-buffer.ts";
import { log } from "../../log.ts";
import { StringFormat, type FormatArg } from "../../common/Utilities/StringFormat.ts";
import { tokenize as splitTokens } from "../../common/util.ts";
import {
  CHAT_MSG_ACHIEVEMENT,
  CHAT_MSG_BATTLENET,
  CHAT_MSG_BG_SYSTEM_ALLIANCE,
  CHAT_MSG_BG_SYSTEM_HORDE,
  CHAT_MSG_BG_SYSTEM_NEUTRAL,
  CHAT_MSG_CHANNEL,
  CHAT_MSG_GUILD_ACHIEVEMENT,
  CHAT_MSG_MONSTER_EMOTE,
  CHAT_MSG_MONSTER_PARTY,
  CHAT_MSG_MONSTER_SAY,
  CHAT_MSG_MONSTER_WHISPER,
  CHAT_MSG_MONSTER_YELL,
  CHAT_MSG_RAID_BOSS_EMOTE,
  CHAT_MSG_RAID_BOSS_WHISPER,
  CHAT_MSG_SYSTEM,
  CHAT_MSG_WHISPER,
  CHAT_MSG_WHISPER_FOREIGN,
  LANG_ADDON,
  LANG_UNIVERSAL,
  SEC_PLAYER,
} from "../../shared/SharedDefines.ts";
import {
  LANG_CMD_INVALID,
  LANG_CONSOLE_COMMAND,
  LANG_PLAYER_NOT_FOUND,
  LANG_WRONG_LINK_TYPE,
  LANG_YOURS_SECURITY_IS_LOW,
} from "../Miscellaneous/Language.ts";
import {
  RBAC_PERM_CAN_IGNORE_LOWER_SECURITY_CHECK,
  RBAC_PERM_COMMANDS_NOTIFY_COMMAND_NOT_FOUND_ERROR,
  RBAC_PERM_RECEIVE_GLOBAL_GM_TEXTMESSAGE,
} from "../Accounts/RBACDefines.ts";
import { getSecurity, isPlayerAccount } from "../Accounts/AccountMgr.ts";
import { hasLoginDatabase, LoginDatabase } from "../../database/DatabaseEnv.ts";
import { sCharacterCache } from "../Cache/CharacterCache.ts";
import { ObjectAccessor } from "../Globals/ObjectAccessor.ts";
import { normalizePlayerName, sObjectMgr } from "../Globals/ObjectMgr.ts";
import { sAreaTableStore, sGlyphPropertiesStore, sMapStore, sTalentStore } from "../DataStores/DBCStores.ts";
import type { Player, CommandCreature, CommandUnit, CommandGameObject } from "../Entities/Player/Player.ts";
import { sWorldSessionMgr } from "../Server/WorldSessionMgr.ts";
import type { WorldSession } from "../../world/session.ts";
import { ServerConfig } from "../world/world-config.ts";
import { sWorld } from "../world/world.ts";
import { realm } from "../../shared/Realms/Realm.ts";
import { COMMAND_DELIMITER } from "./ChatCommands/ChatCommandHelpers.ts";
import { TryExecuteCommand } from "./ChatCommands/ChatCommand.ts";
import { MAX_TALENT_RANK } from "./Hyperlinks.ts";

export const SMSG_MESSAGECHAT = 0x096;
export const SMSG_GM_MESSAGECHAT = 0x3b3;
export const SMSG_NOTIFICATION = 0x1cb;

/** Who a chat packet is from or to (`WorldObject` for `BuildChatPacket`). */
export type ChatParty = {
  guid: bigint;
  name: string;
  /** Players: `GetChatTag()` and whether the session has `RBAC_PERM_COMMAND_GM_CHAT`. */
  chatTag?: number;
  gmMessage?: boolean;
  isPlayer?: boolean;
  isPet?: boolean;
};

function guidIsPlayer(guid: bigint): boolean {
  return guid !== 0n && ((guid >> 48n) & 0xffffn) === 0n;
}

function guidIsPet(guid: bigint): boolean {
  return ((guid >> 48n) & 0xffffn) === 0xf140n;
}

/** @ac game/Chat/Chat.cpp ChatHandler::BuildChatPacket */
export function BuildChatPacket(
  chatType: number,
  language: number,
  senderGUID: bigint,
  receiverGUID: bigint,
  message: string,
  chatTag: number,
  senderName = "",
  receiverName = "",
  achievementId = 0,
  gmMessage = false,
  channelName = "",
): { opcode: number; body: Uint8Array } {
  const data = new ByteWriter();
  data.writeU8(chatType);
  data.writeU32(language >>> 0);
  data.writeU64(senderGUID);
  data.writeU32(0); // some flags
  const nameLength = (name: string): number => new TextEncoder().encode(name).length + 1;
  switch (chatType) {
    case CHAT_MSG_MONSTER_SAY:
    case CHAT_MSG_MONSTER_PARTY:
    case CHAT_MSG_MONSTER_YELL:
    case CHAT_MSG_MONSTER_WHISPER:
    case CHAT_MSG_MONSTER_EMOTE:
    case CHAT_MSG_RAID_BOSS_EMOTE:
    case CHAT_MSG_RAID_BOSS_WHISPER:
    case CHAT_MSG_BATTLENET:
      data.writeU32(nameLength(senderName));
      data.writeCString(senderName);
      data.writeU64(receiverGUID);
      if (receiverGUID && !guidIsPlayer(receiverGUID) && !guidIsPet(receiverGUID)) {
        data.writeU32(nameLength(receiverName));
        data.writeCString(receiverName);
      }
      break;
    case CHAT_MSG_WHISPER_FOREIGN:
      data.writeU32(nameLength(senderName));
      data.writeCString(senderName);
      data.writeU64(receiverGUID);
      break;
    case CHAT_MSG_BG_SYSTEM_NEUTRAL:
    case CHAT_MSG_BG_SYSTEM_ALLIANCE:
    case CHAT_MSG_BG_SYSTEM_HORDE:
      data.writeU64(receiverGUID);
      if (receiverGUID && !guidIsPlayer(receiverGUID)) {
        data.writeU32(nameLength(receiverName));
        data.writeCString(receiverName);
      }
      break;
    case CHAT_MSG_ACHIEVEMENT:
    case CHAT_MSG_GUILD_ACHIEVEMENT:
      data.writeU64(receiverGUID);
      break;
    default:
      if (gmMessage) {
        data.writeU32(nameLength(senderName));
        data.writeCString(senderName);
      }
      if (chatType === CHAT_MSG_CHANNEL) {
        if (channelName.length === 0) throw new Error("channel chat without a channel name");
        data.writeCString(channelName);
      }
      data.writeU64(receiverGUID);
      break;
  }
  data.writeU32(nameLength(message));
  data.writeCString(message);
  data.writeU8(chatTag);
  if (chatType === CHAT_MSG_ACHIEVEMENT || chatType === CHAT_MSG_GUILD_ACHIEVEMENT) data.writeU32(achievementId);
  return { opcode: gmMessage ? SMSG_GM_MESSAGECHAT : SMSG_MESSAGECHAT, body: data.toUint8Array() };
}

/** @ac game/Chat/Chat.cpp ChatHandler::BuildChatPacket (WorldObject overload) */
export function BuildChatPacketFor(
  chatType: number,
  language: number,
  sender: ChatParty | null,
  receiver: ChatParty | null,
  message: string,
  achievementId = 0,
  channelName = "",
): { opcode: number; body: Uint8Array } {
  return BuildChatPacket(
    chatType,
    language,
    sender?.guid ?? 0n,
    receiver?.guid ?? 0n,
    message,
    sender?.chatTag ?? 0,
    sender?.name ?? "",
    receiver?.name ?? "",
    achievementId,
    sender?.gmMessage ?? false,
    channelName,
  );
}

/** `SMSG_NOTIFICATION` body. */
export function notificationPacket(line: string): Uint8Array {
  return new ByteWriter().writeCString(line).toUint8Array();
}

function lines(str: string): string[] {
  return splitTokens(str, "\n", true);
}

/** @ac game/Chat/Chat.h ChatHandler */
export class ChatHandler {
  private sentErrorMessage = false;

  constructor(protected session: WorldSession | null) {}

  /** @ac game/Chat/Chat.cpp ChatHandler::GetPlayer */
  getPlayer(): Player | null {
    return this.session?.getPlayer() ?? null;
  }

  getSession(): WorldSession | null {
    return this.session;
  }

  /** @ac game/Chat/Chat.cpp ChatHandler::GetAcoreString */
  getAcoreString(entry: number): string {
    return sObjectMgr.getAcoreString(entry, this.session?.getSessionDbLocaleIndex() ?? 0);
  }

  /** @ac game/Chat/Chat.cpp ChatHandler::IsAvailable */
  isAvailable(securityLevel: number): boolean {
    return this.isConsole() ? true : (this.session?.getSecurity() ?? SEC_PLAYER) >= securityLevel;
  }

  /** @ac game/Chat/Chat.cpp ChatHandler::HasPermission */
  hasPermission(permissionId: number): boolean {
    if (this.isConsole()) return true;
    return this.session?.hasPermission(permissionId) ?? false;
  }

  /** @ac game/Chat/Chat.cpp ChatHandler::HasLowerSecurity */
  async hasLowerSecurity(target: Player | null, guid = 0, strong = false): Promise<boolean> {
    let targetSession: WorldSession | null = null;
    let targetAccount = 0;
    if (target) targetSession = target.getSession();
    else if (guid) targetAccount = sCharacterCache.getCharacterAccountIdByGuid(guid);
    if (!targetSession && !targetAccount) {
      this.sendErrorMessage(LANG_PLAYER_NOT_FOUND);
      return true;
    }
    return this.hasLowerSecurityAccount(targetSession, targetAccount, strong);
  }

  /** @ac game/Chat/Chat.cpp ChatHandler::HasLowerSecurityAccount */
  async hasLowerSecurityAccount(target: WorldSession | null, targetAccount: number, strong = false): Promise<boolean> {
    const session = this.session;
    // allow everything from console and RA console
    if (!session) return false;
    // ignore only for non-players for non strong checks (when allow apply command at least to same sec level)
    if (session.hasPermission(RBAC_PERM_CAN_IGNORE_LOWER_SECURITY_CHECK) && !strong && sWorld().getBoolConfig(ServerConfig.CONFIG_GM_LOWER_SECURITY)) return false;
    let targetSec: number;
    if (target) targetSec = target.getSecurity();
    else if (targetAccount) targetSec = hasLoginDatabase() ? await getSecurity(LoginDatabase(), targetAccount, realm.Id.Realm) : SEC_PLAYER;
    else return true;
    if (session.getSecurity() < targetSec || (strong && session.getSecurity() <= targetSec)) {
      this.sendErrorMessage(LANG_YOURS_SECURITY_IS_LOW);
      return true;
    }
    return false;
  }

  /** @ac game/Chat/Chat.cpp ChatHandler::SendNotification */
  sendNotification(str: string | number, ...args: FormatArg[]): void {
    if (!this.hasSession()) return;
    const text = typeof str === "number" ? StringFormat(this.getAcoreString(str), ...args) : args.length ? StringFormat(str, ...args) : str;
    for (const line of lines(text)) this.session?.sendPacket(SMSG_NOTIFICATION, notificationPacket(line));
  }

  /** @ac game/Chat/Chat.cpp ChatHandler::SendGMText */
  sendGMText(str: string | number, ...args: FormatArg[]): void {
    this.doForAllValidSessions((player) => {
      const session = player.getSession();
      if (!session.hasPermission(RBAC_PERM_RECEIVE_GLOBAL_GM_TEXTMESSAGE)) return;
      const text = typeof str === "number" ? StringFormat(sObjectMgr.getAcoreString(str, session.getSessionDbLocaleIndex()), ...args) : args.length ? StringFormat(str, ...args) : str;
      for (const line of lines(text)) {
        const packet = BuildChatPacketFor(CHAT_MSG_SYSTEM, LANG_UNIVERSAL, null, null, line);
        session.sendPacket(packet.opcode, packet.body);
      }
    });
  }

  /** @ac game/Chat/Chat.cpp ChatHandler::SendWorldText */
  sendWorldText(str: string | number, ...args: FormatArg[]): void {
    this.doForAllValidSessions((player) => {
      const session = player.getSession();
      const text = typeof str === "number" ? StringFormat(sObjectMgr.getAcoreString(str, session.getSessionDbLocaleIndex()), ...args) : args.length ? StringFormat(str, ...args) : str;
      for (const line of lines(text)) {
        const packet = BuildChatPacketFor(CHAT_MSG_SYSTEM, LANG_UNIVERSAL, null, null, line);
        session.sendPacket(packet.opcode, packet.body);
      }
    });
  }

  /** @ac game/Chat/Chat.cpp ChatHandler::SendWorldTextOptional (player settings are not ported, so nothing is filtered) */
  sendWorldTextOptional(str: string | number, _flag: number, ...args: FormatArg[]): void {
    this.sendWorldText(str, ...args);
  }

  /** @ac game/Chat/Chat.cpp ChatHandler::SendSysMessage */
  sendSysMessage(str: string | number, escapeCharacters = false): void {
    if (typeof str === "number") {
      this.sendSysMessage(this.getAcoreString(str));
      return;
    }
    // `msg` with `|` doubled is built and, as in the C++, the original `str` is what gets sent.
    void escapeCharacters;
    for (const line of lines(str)) {
      const packet = BuildChatPacketFor(CHAT_MSG_SYSTEM, LANG_UNIVERSAL, null, null, line);
      this.session?.sendPacket(packet.opcode, packet.body);
    }
  }

  /** @ac game/Chat/Chat.h ChatHandler::PSendSysMessage */
  pSendSysMessage(str: string | number, ...args: FormatArg[]): void {
    if (!this.hasSession()) return;
    if (typeof str === "number") this.sendSysMessage(this.pGetParseString(str, ...args));
    else this.sendSysMessage(args.length ? StringFormat(str, ...args) : str);
  }

  /** @ac game/Chat/Chat.h ChatHandler::PGetParseString */
  pGetParseString(entry: number, ...args: FormatArg[]): string {
    return StringFormat(this.getAcoreString(entry), ...args);
  }

  /** @ac game/Chat/Chat.cpp ChatHandler::SendErrorMessage */
  sendErrorMessage(str: string | number, ...args: FormatArg[]): void {
    if (typeof str === "number" && args.length === 0) this.sendSysMessage(str);
    else this.pSendSysMessage(str, ...args);
    this.setSentErrorMessage(true);
  }

  /** @ac game/Chat/Chat.cpp ChatHandler::SendGlobalSysMessage */
  sendGlobalSysMessage(str: string): void {
    for (const line of lines(str)) {
      const packet = BuildChatPacketFor(CHAT_MSG_SYSTEM, LANG_UNIVERSAL, null, null, line);
      sWorldSessionMgr.SendGlobalMessage(packet.opcode, packet.body);
    }
  }

  /** @ac game/Chat/Chat.cpp ChatHandler::SendGlobalGMSysMessage */
  sendGlobalGMSysMessage(str: string): void {
    for (const line of lines(str)) {
      const packet = BuildChatPacketFor(CHAT_MSG_SYSTEM, LANG_UNIVERSAL, null, null, line);
      sWorldSessionMgr.SendGlobalGMMessage(packet.opcode, packet.body);
    }
  }

  /** @ac game/Chat/Chat.cpp ChatHandler::_ParseCommands */
  async _parseCommands(text: string): Promise<boolean> {
    if (await TryExecuteCommand(this, text)) return true;
    // Pretend commands don't exist for regular players
    if (this.session && !this.session.hasPermission(RBAC_PERM_COMMANDS_NOTIFY_COMMAND_NOT_FOUND_ERROR) && !sWorld().getBoolConfig(ServerConfig.CONFIG_ALLOW_PLAYER_COMMANDS)) {
      return false;
    }
    // Send error message for GMs
    this.sendErrorMessage(LANG_CMD_INVALID, text);
    return true;
  }

  /** @ac game/Chat/Chat.cpp ChatHandler::ParseCommands */
  async parseCommands(text: string): Promise<boolean> {
    if (text.length === 0) throw new Error("ParseCommands on an empty line");
    // chat case (.command or !command format)
    if (text[0] !== "!" && text[0] !== ".") return false;
    // ignore single . and ! in line
    if (text.length < 2) return false;
    // ignore messages staring from many dots.
    if (text[1] === text[0]) return false;
    // ignore messages with separator after .
    if (text[1] === COMMAND_DELIMITER) return false;
    return this._parseCommands(text.slice(1));
  }

  /** @ac game/Chat/ChatCommands/ChatCommand.cpp LogCommandUsage */
  logCommandUsage(cmdStr: string): void {
    const session = this.session;
    if (!session || isPlayerAccount(session.getSecurity())) return;
    const player = session.getPlayer();
    if (!player) return;
    const areaId = player.getAreaId();
    const zoneId = player.getZoneId();
    const areaName = sAreaTableStore.lookupEntry(areaId)?.area_name[0] ?? "Unknown";
    const zoneName = sAreaTableStore.lookupEntry(zoneId)?.area_name[0] ?? "Unknown";
    const mapName = sMapStore.lookupEntry(player.getMapId())?.name[0] ?? "Unknown";
    const selected = player.getSelectedUnit();
    log(
      "gm",
      StringFormat(
        "Command: {} [Player: {} ({}) (Account: {}) X: {} Y: {} Z: {} Map: {} ({}) Area: {} ({}) Zone: {} ({}) Selected: {} ({})]",
        cmdStr,
        player.getName(),
        guidString(BigInt(player.getGUIDLow())),
        session.getAccountId(),
        player.getPositionX(),
        player.getPositionY(),
        player.getPositionZ(),
        player.getMapId(),
        mapName,
        areaId,
        areaName,
        zoneId,
        zoneName,
        selected?.getName() ?? "",
        guidString(player.getTarget()),
      ),
    );
  }

  isHumanReadable(): boolean {
    return true;
  }

  /** @ac game/Chat/Chat.h ChatHandler::GetNameLink */
  getNameLink(chr?: Player): string {
    if (chr) return this.playerLink(chr.getName());
    const player = this.session?.getPlayer();
    return player ? this.playerLink(player.getName()) : "";
  }

  /** @ac game/Chat/Chat.cpp ChatHandler::needReportToTarget */
  needReportToTarget(chr: Player): boolean {
    const pl = this.session?.getPlayer();
    return !!pl && pl !== chr && pl.isVisibleGloballyFor(chr);
  }

  getSessionDbcLocale(): number {
    return this.session?.getSessionDbcLocale() ?? 0;
  }

  getSessionDbLocaleIndex(): number {
    return this.session?.getSessionDbLocaleIndex() ?? 0;
  }

  /** @ac game/Chat/Chat.cpp ChatHandler::HasSession */
  hasSession(): boolean {
    return this.session !== null;
  }

  /** @ac game/Chat/Chat.cpp ChatHandler::DoForAllValidSessions */
  doForAllValidSessions(exec: (player: Player) => void): void {
    for (const session of sWorldSessionMgr.GetAllSessions()) {
      const player = session.getPlayer();
      if (player && player.isInWorld()) exec(player);
    }
  }

  /** @ac game/Chat/Chat.h ChatHandler::playerLink */
  playerLink(name: string): string {
    return this.session ? `|cffffffff|Hplayer:${name}|h[${name}]|h|r` : name;
  }

  hasSentErrorMessage(): boolean {
    return this.sentErrorMessage;
  }

  setSentErrorMessage(val: boolean): void {
    this.sentErrorMessage = val;
  }

  isConsole(): boolean {
    return this.session === null;
  }

  /** @ac game/Chat/Chat.cpp ChatHandler::getSelectedPlayer */
  getSelectedPlayer(): Player | null {
    const player = this.session?.getPlayer();
    if (!player) return null;
    const selected = player.getTarget();
    if (!selected) return player;
    return ObjectAccessor.FindConnectedPlayer(selected);
  }

  /** @ac game/Chat/Chat.cpp ChatHandler::getSelectedUnit */
  getSelectedUnit(): CommandUnit | null {
    const player = this.session?.getPlayer();
    if (!player) return null;
    return player.getSelectedUnit() ?? player;
  }

  /** @ac game/Chat/Chat.cpp ChatHandler::getSelectedObject */
  getSelectedObject(): CommandUnit | CommandGameObject | null {
    const player = this.session?.getPlayer();
    if (!player) return null;
    if (!player.getTarget()) return this.GetNearbyGameObject();
    return player.getSelectedUnit();
  }

  /** @ac game/Chat/Chat.cpp ChatHandler::getSelectedCreature */
  getSelectedCreature(): CommandCreature | null {
    const unit = this.session?.getPlayer()?.getSelectedUnit() ?? null;
    return unit && unit.isCreature() ? (unit as CommandCreature) : null;
  }

  /** @ac game/Chat/Chat.cpp ChatHandler::getSelectedPlayerOrSelf */
  getSelectedPlayerOrSelf(): Player | null {
    const player = this.session?.getPlayer();
    if (!player) return null;
    const selected = player.getTarget();
    if (!selected) return player;
    return ObjectAccessor.FindConnectedPlayer(selected) ?? player;
  }

  /** @ac game/Chat/Chat.cpp ChatHandler::GetNearbyGameObject */
  GetNearbyGameObject(): CommandGameObject | null {
    const player = this.session?.getPlayer();
    return player ? player.findNearestGameObject(533.3333) : null;
  }

  /** @ac game/Chat/Chat.cpp ChatHandler::GetCreatureFromPlayerMapByDbGuid */
  GetCreatureFromPlayerMapByDbGuid(lowguid: number): CommandUnit | null {
    return this.session?.getPlayer()?.getCreatureBySpawnId(lowguid) ?? null;
  }

  /** @ac game/Chat/Chat.cpp ChatHandler::GetObjectFromPlayerMapByDbGuid */
  GetObjectFromPlayerMapByDbGuid(lowguid: number): CommandGameObject | null {
    return this.session?.getPlayer()?.getGameObjectBySpawnId(lowguid) ?? null;
  }

  /**
   * @ac game/Chat/Chat.cpp ChatHandler::extractKeyFromLink
   * The key of a `|c…|H<type>:key…|h[…]|h|r` link (or the first word), and the text after it.
   */
  extractKeyFromLink(text: string, linkTypes: readonly string[]): { key: string; index: number; something1: string | null; rest: string } | null {
    const trimmed = text.replace(/^[ \t\b]+/, "");
    if (trimmed.length === 0) return null;
    if (trimmed[0] !== "|") {
      const space = trimmed.indexOf(" ");
      return { key: space < 0 ? trimmed : trimmed.slice(0, space), index: 0, something1: null, rest: space < 0 ? "" : trimmed.slice(space + 1) };
    }
    const tail = trimmed[1] === "c" ? trimmed.slice(trimmed.indexOf("|", 1) + 1) : trimmed.slice(1);
    const colon = tail.indexOf(":");
    if (colon < 0) return null;
    const linkType = tail.slice(0, colon);
    const index = linkTypes.indexOf(linkType);
    const endOfLink = (() => {
      const close = tail.indexOf("]", colon);
      if (close < 0) return "";
      const space = tail.indexOf(" ", close);
      return space < 0 ? "" : tail.slice(space + 1);
    })();
    if (index < 0) {
      this.sendSysMessage(LANG_WRONG_LINK_TYPE);
      return null;
    }
    const keys = tail.slice(colon + 1, tail.indexOf("|", colon) < 0 ? undefined : tail.indexOf("|", colon)).split(/[:|]/);
    return { key: keys[0] ?? "", index, something1: keys[1] ?? null, rest: endOfLink };
  }

  /** @ac game/Chat/Chat.cpp ChatHandler::extractSpellIdFromLink */
  extractSpellIdFromLink(text: string): number {
    const found = this.extractKeyFromLink(text, ["Hspell", "Htalent", "Henchant", "Htrade", "Hglyph"]);
    if (!found) return 0;
    const id = Number.parseInt(found.key, 10) >>> 0;
    switch (found.index) {
      case 0:
        return id;
      case 1: {
        const talentEntry = sTalentStore.lookupEntry(id);
        if (!talentEntry) return 0;
        let rank = found.something1 ? Number.parseInt(found.something1, 10) : 0;
        if (rank >= MAX_TALENT_RANK) return 0;
        if (rank < 0) rank = 0;
        return talentEntry.RankID[rank] ?? 0;
      }
      case 2:
      case 3:
        return id;
      case 4: {
        const glyphPropId = found.something1 ? Number.parseInt(found.something1, 10) >>> 0 : 0;
        return sGlyphPropertiesStore.lookupEntry(glyphPropId)?.SpellId ?? 0;
      }
    }
    return 0;
  }

  /** @ac game/Chat/Chat.cpp ChatHandler::extractPlayerNameFromLink */
  extractPlayerNameFromLink(text: string): string {
    const found = this.extractKeyFromLink(text, ["Hplayer"]);
    if (!found) return "";
    return normalizePlayerName(found.key) ?? "";
  }

  /** @ac game/Chat/Chat.cpp ChatHandler::extractPlayerTarget */
  extractPlayerTarget(args: string): { player: Player | null; guid: number; name: string } | null {
    let player: Player | null;
    let guid = 0;
    let name = "";
    if (args.length > 0) {
      const found = this.extractPlayerNameFromLink(args);
      if (!found) {
        this.sendErrorMessage(LANG_PLAYER_NOT_FOUND);
        return null;
      }
      player = ObjectAccessor.FindPlayerByName(found, false);
      const dbGuid = player ? 0 : sCharacterCache.getCharacterGuidByName(found);
      guid = player ? player.getGUIDLow() : dbGuid;
      name = player || dbGuid ? found : "";
    } else {
      player = this.getSelectedPlayer();
      guid = player ? player.getGUIDLow() : 0;
      name = player ? player.getName() : "";
    }
    if (!player && !guid && !name) {
      this.sendErrorMessage(LANG_PLAYER_NOT_FOUND);
      return null;
    }
    return { player, guid, name };
  }

  /** @ac game/Chat/Chat.cpp ChatHandler::extractQuotedArg */
  extractQuotedArg(args: string): { value: string; rest: string } | null {
    if (args.length === 0) return null;
    let rest = args;
    if (rest[0] !== '"') {
      rest = rest.replace(/^ +/, "");
      if (rest.length === 0 || rest[0] !== '"') return null;
      if (rest[1] === '"') {
        const space = rest.indexOf(" ");
        return { value: "", rest: space < 0 ? "" : rest.slice(space + 1) };
      }
    }
    const close = rest.indexOf('"', 1);
    return close < 0 ? { value: rest.slice(1), rest: "" } : { value: rest.slice(1, close), rest: rest.slice(close + 1) };
  }
}

/** `ObjectGuid::ToString` (`GUID Full: 0x… Type: … Low: …`). */
export function guidString(guid: bigint): string {
  const high = Number((guid >> 48n) & 0xffffn);
  const low = Number(guid & 0xffffffffn);
  const entry = Number((guid >> 24n) & 0xffffffn);
  const typeName =
    high === 0 ? "Player" : high === 0xf130 ? "Creature" : high === 0xf140 ? "Pet" : high === 0xf150 ? "Vehicle" : high === 0xf110 ? "GameObject" : high === 0x4000 ? "Item" : high === 0xf100 ? "DynamicObject" : high === 0xf101 ? "Corpse" : "<unknown>";
  const full = `GUID Full: 0x${guid.toString(16).padStart(16, "0")} Type: ${typeName}`;
  if (high === 0 || high === 0x4000) return `${full} Low: ${low}`;
  return `${full} Entry: ${entry} Low: ${Number(guid & 0xffffffn)}`;
}

/** @ac game/Chat/Chat.h CliHandler */
export class CliHandler extends ChatHandler {
  constructor(private readonly print: (text: string) => void) {
    super(null);
  }

  /** @ac game/Chat/Chat.cpp CliHandler::GetAcoreString */
  override getAcoreString(entry: number): string {
    return sObjectMgr.getAcoreStringForDBCLocale(entry);
  }

  /** @ac game/Chat/Chat.cpp CliHandler::SendSysMessage */
  override sendSysMessage(str: string | number, _escapeCharacters = false): void {
    this.print(typeof str === "number" ? this.getAcoreString(str) : str);
  }

  /** @ac game/Chat/Chat.cpp CliHandler::ParseCommands */
  override async parseCommands(str: string): Promise<boolean> {
    if (str.length === 0) return false;
    // Console allows using commands both with and without leading indicator
    const text = str[0] === "." || str[0] === "!" ? str.slice(1) : str;
    return this._parseCommands(text);
  }

  /** @ac game/Chat/Chat.cpp CliHandler::GetNameLink */
  override getNameLink(chr?: Player): string {
    if (chr) return this.playerLink(chr.getName());
    return this.getAcoreString(LANG_CONSOLE_COMMAND);
  }

  /** @ac game/Chat/Chat.cpp CliHandler::needReportToTarget */
  override needReportToTarget(_chr: Player): boolean {
    return true;
  }

  override getSessionDbcLocale(): number {
    return sObjectMgr.getDBCLocaleIndex();
  }

  override getSessionDbLocaleIndex(): number {
    return sObjectMgr.getDBCLocaleIndex();
  }

  /** CLI does not have a session, but prints `SendNotification` and `PSendSysMessage` to the console. */
  override hasSession(): boolean {
    return true;
  }

  override sendNotification(str: string | number, ...args: FormatArg[]): void {
    const text = typeof str === "number" ? StringFormat(this.getAcoreString(str), ...args) : args.length ? StringFormat(str, ...args) : str;
    this.print(text);
  }
}

/** @ac game/Chat/Chat.h AddonChannelCommandHandler */
export class AddonChannelCommandHandler extends ChatHandler {
  private echo = "";
  private hadAck = false;
  private humanReadable = false;

  override isHumanReadable(): boolean {
    return this.humanReadable;
  }

  /** @ac game/Chat/Chat.cpp AddonChannelCommandHandler::ParseCommands */
  override async parseCommands(str: string): Promise<boolean> {
    if (!str.startsWith("AzerothCore\t")) return false;
    const opcode = str[12];
    if (!opcode) return false;
    if (str.length < 17) return false;
    this.echo = str.slice(13);
    switch (opcode) {
      case "p":
        this.sendAck();
        return true;
      case "h":
      case "i":
        if (str.length < 18) return false;
        this.humanReadable = opcode === "h";
        if (await this._parseCommands(str.slice(17))) {
          if (!this.hadAck) this.sendAck();
          if (this.hasSentErrorMessage()) this.sendFailed();
          else this.sendOK();
        } else {
          this.sendSysMessage(LANG_CMD_INVALID);
          this.sendFailed();
        }
        return true;
      default:
        return false;
    }
  }

  /** @ac game/Chat/Chat.cpp AddonChannelCommandHandler::Send */
  private send(msg: string): void {
    const player = this.getPlayer();
    const session = this.getSession();
    if (!player || !session) return;
    const self = player.chatParty();
    const packet = BuildChatPacketFor(CHAT_MSG_WHISPER, LANG_ADDON, self, self, msg);
    session.sendPacket(packet.opcode, packet.body);
  }

  private reply(kind: string): string {
    return `AzerothCore\t${kind}${this.echo.slice(0, 4)}`;
  }

  /** @ac game/Chat/Chat.cpp AddonChannelCommandHandler::SendAck */
  private sendAck(): void {
    this.send(this.reply("a"));
    this.hadAck = true;
  }

  /** @ac game/Chat/Chat.cpp AddonChannelCommandHandler::SendOK */
  private sendOK(): void {
    this.send(this.reply("o"));
  }

  /** @ac game/Chat/Chat.cpp AddonChannelCommandHandler::SendFailed */
  private sendFailed(): void {
    this.send(this.reply("f"));
  }

  /** @ac game/Chat/Chat.cpp AddonChannelCommandHandler::SendSysMessage */
  override sendSysMessage(str: string | number, escapeCharacters = false): void {
    if (!this.hadAck) this.sendAck();
    const msg = `AzerothCore\tm${this.echo.slice(0, 4)}`;
    let body = typeof str === "number" ? this.getAcoreString(str) : str;
    if (escapeCharacters) body = body.replaceAll("|", "||");
    for (const line of body.split("\n")) this.send(msg + line);
  }
}
