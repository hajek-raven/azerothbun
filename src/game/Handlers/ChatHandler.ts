/**
 * `ChatHandler.cpp` (the opcode side): `CMSG_MESSAGECHAT`, `CMSG_EMOTE`, `CMSG_TEXT_EMOTE`, and `CMSG_CHAT_IGNORED`.
 * Party, raid, battleground, guild, and channel chat reach the same checks as in the C++; there are no groups, guilds,
 * or channels in the port yet, so those messages end where the C++ finds none.
 */
import { ByteReader, ByteWriter } from "../../net/byte-buffer.ts";
import { log, logError } from "../../log.ts";
import { languageDesc } from "../../characters/skills.ts";
import { SPELL_AURA_COMPREHEND_LANGUAGE, SPELL_AURA_MOD_LANGUAGE } from "../../spells/defines.ts";
import {
  CHAT_MSG_ADDON,
  CHAT_MSG_AFK,
  CHAT_MSG_BATTLEGROUND,
  CHAT_MSG_BATTLEGROUND_LEADER,
  CHAT_MSG_CHANNEL,
  CHAT_MSG_DND,
  CHAT_MSG_EMOTE,
  CHAT_MSG_GUILD,
  CHAT_MSG_IGNORED,
  CHAT_MSG_OFFICER,
  CHAT_MSG_PARTY,
  CHAT_MSG_PARTY_LEADER,
  CHAT_MSG_RAID,
  CHAT_MSG_RAID_LEADER,
  CHAT_MSG_RAID_WARNING,
  CHAT_MSG_RESTRICTED,
  CHAT_MSG_SAY,
  CHAT_MSG_TEXT_EMOTE,
  CHAT_MSG_WHISPER,
  CHAT_MSG_YELL,
  LANG_ADDON,
  LANG_UNIVERSAL,
  MAX_CHAT_MSG_TYPE,
  EMOTE_ONESHOT_NONE,
  EMOTE_ONESHOT_WAVE,
  EMOTE_STATE_DANCE,
  EMOTE_STATE_KNEEL,
  EMOTE_STATE_SIT,
  EMOTE_STATE_SLEEP,
} from "../../shared/SharedDefines.ts";
import {
  LANG_CHANNEL_REQ,
  LANG_GM_SILENCE,
  LANG_MUTED_PLAYER,
  LANG_NOT_LEARNED_LANGUAGE,
  LANG_PLAYER_AFK_DEFAULT,
  LANG_PLAYER_DND_DEFAULT,
  LANG_SAY_REQ,
  LANG_UNKNOWN_LANGUAGE,
  LANG_WAIT_BEFORE_SPEAKING,
  LANG_WHISPER_REQ,
} from "../Miscellaneous/Language.ts";
import {
  RBAC_PERM_CAN_FILTER_WHISPERS,
  RBAC_PERM_SKIP_CHECK_CHAT_CHANNEL_REQ,
  RBAC_PERM_SKIP_CHECK_CHAT_SPAM,
  RBAC_PERM_TWO_SIDE_INTERACTION_CHAT,
} from "../Accounts/RBACDefines.ts";
import { secsToTimeString } from "../time/timer.ts";
import { AddonChannelCommandHandler, BuildChatPacketFor, ChatHandler } from "../Chat/Chat.ts";
import { CheckAllLinks } from "../Chat/Hyperlinks.ts";
import { ObjectAccessor } from "../Globals/ObjectAccessor.ts";
import { normalizePlayerName } from "../Globals/ObjectMgr.ts";
import { sEmotesTextStore } from "../DataStores/DBCStores.ts";
import { ServerConfig } from "../world/world-config.ts";
import { sWorld } from "../world/world.ts";
import type { Player } from "../Entities/Player/Player.ts";
import type { WorldSession } from "../../world/session.ts";

export const CMSG_MESSAGECHAT = 0x095;
export const CMSG_EMOTE = 0x102;
export const SMSG_EMOTE = 0x103;
export const CMSG_TEXT_EMOTE = 0x104;
export const SMSG_TEXT_EMOTE = 0x105;
export const CMSG_CHAT_IGNORED = 0x225;
export const SMSG_CHAT_WRONG_FACTION = 0x219;
export const SMSG_CHAT_PLAYER_NOT_FOUND = 0x2a9;
export const SMSG_CHAT_PLAYER_AMBIGUOUS = 0x32d;
export const SMSG_CHAT_RESTRICTED = 0x2fd;

export const CHAT_OPCODES: ReadonlySet<number> = new Set([CMSG_MESSAGECHAT, CMSG_EMOTE, CMSG_TEXT_EMOTE, CMSG_CHAT_IGNORED]);

const UNIT_NPC_EMOTESTATE = 0x0053;

/** `Player::ChatFloodThrottle` */
const ChatFloodThrottle = { REGULAR: 0, ADDON: 1 } as const;

/** @ac game/Handlers/ChatHandler.cpp isNasty */
function isNasty(c: number): boolean {
  if (c === 0x09) return false;
  return c <= 0x1f;
}

/** `ByteBuffer::ReadCString`: up to the NUL or the end of the packet. */
function readCString(reader: ByteReader): string {
  const bytes: number[] = [];
  while (reader.remaining > 0) {
    const c = reader.readU8();
    if (c === 0) break;
    bytes.push(c);
  }
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

/** @ac game/Entities/Player/PlayerMisc.cpp Player::UpdateSpeakTime */
function updateSpeakTime(session: WorldSession, index: number): void {
  // ignore chat spam protection for GMs in any mode
  if (session.hasPermission(RBAC_PERM_SKIP_CHECK_CHAT_SPAM)) return;
  const world = sWorld();
  let limit: number;
  let delay: number;
  switch (index) {
    case ChatFloodThrottle.ADDON:
      limit = world.getIntConfig(ServerConfig.CONFIG_CHATFLOOD_ADDON_MESSAGE_COUNT);
      delay = world.getIntConfig(ServerConfig.CONFIG_CHATFLOOD_ADDON_MESSAGE_DELAY);
      break;
    default:
      // `REGULAR` falls through to `default: return` in the C++.
      return;
  }
  const flood = session.commandState.chatFlood;
  const current = Math.floor(Date.now() / 1000);
  if (flood.time > current) {
    ++flood.count;
    if (flood.count >= limit) {
      const newMute = current + world.getIntConfig(ServerConfig.CONFIG_CHATFLOOD_MUTE_TIME);
      if (session.muteTime < newMute) session.muteTime = newMute;
      flood.count = 0;
    }
  } else {
    flood.count = 1;
  }
  flood.time = current + delay;
}

/** @ac game/Handlers/ChatHandler.cpp WorldSession::HandleMessagechatOpcode */
export async function HandleMessagechatOpcode(session: WorldSession, payload: Uint8Array): Promise<void> {
  const sender = session.getPlayer();
  if (!sender) return;
  const recvData = new ByteReader(payload);
  const type = recvData.readU32();
  let lang = recvData.readU32();
  const world = sWorld();
  if (type >= MAX_CHAT_MSG_TYPE) {
    logError("world", `CHAT: Wrong message type received: ${type}`);
    return;
  }
  const chat = new ChatHandler(session);
  if (lang === LANG_UNIVERSAL && type !== CHAT_MSG_AFK && type !== CHAT_MSG_DND) {
    log("world", `CMSG_MESSAGECHAT: Possible hacking-attempt: ${sender.getName()} tried to send a message in universal language`);
    chat.sendNotification(LANG_UNKNOWN_LANGUAGE);
    return;
  }
  // prevent talking at unknown language (cheating)
  const langDesc = languageDesc(lang);
  if (!langDesc) {
    chat.sendNotification(LANG_UNKNOWN_LANGUAGE);
    return;
  }
  if (langDesc.skillId !== 0 && !sender.hasSkill(langDesc.skillId)) {
    // also check SPELL_AURA_COMPREHEND_LANGUAGE (client offers option to speak in that language)
    const auras = sender.spellUnit()?.auraEffectsByType(SPELL_AURA_COMPREHEND_LANGUAGE) ?? [];
    if (!auras.some((effect) => effect.miscValue >>> 0 === lang >>> 0)) {
      chat.sendNotification(LANG_NOT_LEARNED_LANGUAGE);
      return;
    }
  }
  const isAddonLang = lang >>> 0 === LANG_ADDON >>> 0;
  // Trial accounts are never created by this server (no `ACCOUNT_FLAG_TRIAL`), so the trial restriction never applies.
  // pussywizard: chatting on most chat types requires 2 hours played to prevent spam/abuse
  if (!session.hasPermission(RBAC_PERM_SKIP_CHECK_CHAT_CHANNEL_REQ)) {
    switch (type) {
      case CHAT_MSG_ADDON:
      case CHAT_MSG_PARTY:
      case CHAT_MSG_RAID:
      case CHAT_MSG_GUILD:
      case CHAT_MSG_OFFICER:
      case CHAT_MSG_AFK:
      case CHAT_MSG_DND:
      case CHAT_MSG_RAID_LEADER:
      case CHAT_MSG_RAID_WARNING:
      case CHAT_MSG_BATTLEGROUND:
      case CHAT_MSG_BATTLEGROUND_LEADER:
      case CHAT_MSG_PARTY_LEADER:
        break;
      default:
        if (world.getBoolConfig(ServerConfig.CONFIG_CHAT_MUTE_FIRST_LOGIN) && !isAddonLang) {
          const minutes = world.getIntConfig(ServerConfig.CONFIG_CHAT_TIME_MUTE_FIRST_LOGIN);
          if (sender.getTotalPlayedTime() < minutes * 60) {
            chat.sendNotification(LANG_MUTED_PLAYER, minutes);
            return;
          }
        }
    }
  }
  if (sender.hasAura(1852) && type !== CHAT_MSG_WHISPER) {
    chat.sendNotification(LANG_GM_SILENCE, sender.getName());
    return;
  }
  if (isAddonLang) {
    // LANG_ADDON is only valid for the following message types
    switch (type) {
      case CHAT_MSG_PARTY:
      case CHAT_MSG_RAID:
      case CHAT_MSG_GUILD:
      case CHAT_MSG_BATTLEGROUND:
      case CHAT_MSG_WHISPER:
        // check if addon messages are disabled
        if (!world.getBoolConfig(ServerConfig.CONFIG_ADDON_CHANNEL)) return;
        break;
      default:
        logError("world", `Player ${sender.getName()} sent a chatmessage with an invalid language/message type combination`);
        return;
    }
  } else {
    // send in universal language if player in .gmon mode (ignore spell effects)
    if (sender.isGameMaster()) {
      lang = LANG_UNIVERSAL;
    } else {
      // send in universal language in two side iteration allowed mode
      if (world.getBoolConfig(ServerConfig.CONFIG_ALLOW_TWO_SIDE_INTERACTION_CHAT)) {
        lang = LANG_UNIVERSAL;
      } else {
        switch (type) {
          case CHAT_MSG_PARTY:
          case CHAT_MSG_PARTY_LEADER:
          case CHAT_MSG_RAID:
          case CHAT_MSG_RAID_LEADER:
          case CHAT_MSG_RAID_WARNING:
            if (world.getBoolConfig(ServerConfig.CONFIG_ALLOW_TWO_SIDE_INTERACTION_GROUP)) lang = LANG_UNIVERSAL;
            break;
          case CHAT_MSG_GUILD:
          case CHAT_MSG_OFFICER:
            if (world.getBoolConfig(ServerConfig.CONFIG_ALLOW_TWO_SIDE_INTERACTION_GUILD)) lang = LANG_UNIVERSAL;
            break;
        }
      }
      // Overwritten by SPELL_AURA_MOD_LANGUAGE auras (Affects only Say and Yell)
      const modLangAuras = sender.spellUnit()?.auraEffectsByType(SPELL_AURA_MOD_LANGUAGE) ?? [];
      if (modLangAuras.length > 0 && (type === CHAT_MSG_SAY || type === CHAT_MSG_YELL)) lang = modLangAuras[0]!.miscValue;
    }
    if (type !== CHAT_MSG_AFK && type !== CHAT_MSG_DND) updateSpeakTime(session, isAddonLang ? ChatFloodThrottle.ADDON : ChatFloodThrottle.REGULAR);
  }

  let to = "";
  let channel = "";
  let msg = "";
  let ignoreChecks = false;
  switch (type) {
    case CHAT_MSG_SAY:
    case CHAT_MSG_EMOTE:
    case CHAT_MSG_YELL:
    case CHAT_MSG_PARTY:
    case CHAT_MSG_PARTY_LEADER:
    case CHAT_MSG_GUILD:
    case CHAT_MSG_OFFICER:
    case CHAT_MSG_RAID:
    case CHAT_MSG_RAID_LEADER:
    case CHAT_MSG_RAID_WARNING:
    case CHAT_MSG_BATTLEGROUND:
    case CHAT_MSG_BATTLEGROUND_LEADER:
      msg = readCString(recvData);
      break;
    case CHAT_MSG_WHISPER:
      to = readCString(recvData);
      msg = readCString(recvData);
      break;
    case CHAT_MSG_CHANNEL:
      channel = readCString(recvData);
      msg = readCString(recvData);
      break;
    case CHAT_MSG_AFK:
    case CHAT_MSG_DND:
      msg = readCString(recvData);
      ignoreChecks = true;
      break;
  }
  // pussywizard:
  if (new TextEncoder().encode(msg).length > 255 || (!isAddonLang && msg.includes("|0"))) return;

  if (!ignoreChecks) {
    if (msg.length === 0) return;
    if (isAddonLang) {
      if (await new AddonChannelCommandHandler(session).parseCommands(msg)) return;
    } else {
      if (await new ChatHandler(session).parseCommands(msg)) return;
      if (!sender.canSpeak()) {
        const timeStr = secsToTimeString(session.muteTime - Math.floor(Date.now() / 1000));
        chat.sendNotification(LANG_WAIT_BEFORE_SPEAKING, timeStr);
        return;
      }
    }
  }

  // do message validity checks
  if (!isAddonLang) {
    // cut at the first newline or carriage return
    const pos = msg.search(/[\n\r]/);
    if (pos === 0) return;
    if (pos > 0) msg = msg.slice(0, pos);
    // abort on any sort of nasty character
    for (const byte of new TextEncoder().encode(msg)) {
      if (isNasty(byte)) {
        logError("world", `Player ${sender.getName()} sent a message containing invalid character ${byte} - blocked`);
        return;
      }
    }
    // collapse multiple spaces into one
    if (world.getBoolConfig(ServerConfig.CONFIG_CHAT_FAKE_MESSAGE_PREVENTING)) msg = msg.replace(/ {2,}/g, " ");
    // Validate hyperlinks
    if (!ValidateHyperlinksAndMaybeKick(session, msg)) return;
  }

  switch (type) {
    case CHAT_MSG_SAY:
    case CHAT_MSG_EMOTE:
    case CHAT_MSG_YELL: {
      // Prevent cheating
      if (!sender.isAlive()) return;
      if (sender.getLevel() < world.getIntConfig(ServerConfig.CONFIG_CHAT_SAY_LEVEL_REQ)) {
        chat.sendNotification(LANG_SAY_REQ, world.getIntConfig(ServerConfig.CONFIG_CHAT_SAY_LEVEL_REQ));
        return;
      }
      if (type === CHAT_MSG_SAY) sender.say(msg, lang);
      else if (type === CHAT_MSG_EMOTE) sender.textEmote(msg);
      else sender.yell(msg, lang);
      break;
    }
    case CHAT_MSG_WHISPER: {
      const name = normalizePlayerName(to);
      if (name === null) {
        SendPlayerNotFoundNotice(session, to);
        break;
      }
      const receiver = ObjectAccessor.FindPlayerByName(name, false);
      const senderIsPlayer = !session.hasPermission(RBAC_PERM_TWO_SIDE_INTERACTION_CHAT);
      const receiverIsPlayer = receiver ? !receiver.getSession().hasPermission(RBAC_PERM_TWO_SIDE_INTERACTION_CHAT) : true;
      const whisperLevelReq = world.getIntConfig(ServerConfig.CONFIG_CHAT_WHISPER_LEVEL_REQ);
      if (sender.getLevel() < whisperLevelReq && receiver !== sender && receiver && !receiver.isGameMaster()) {
        chat.sendNotification(LANG_WHISPER_REQ, whisperLevelReq);
        return;
      }
      if (
        !receiver ||
        (!isAddonLang && !receiver.isAcceptWhispers() && receiver.getSession().hasPermission(RBAC_PERM_CAN_FILTER_WHISPERS) && !receiver.isInWhisperWhiteList(sender.getGUID()))
      ) {
        SendPlayerNotFoundNotice(session, to);
        return;
      }
      if (!world.getBoolConfig(ServerConfig.CONFIG_ALLOW_TWO_SIDE_INTERACTION_CHAT) && senderIsPlayer && receiverIsPlayer && sender.getTeamId() !== receiver.getTeamId()) {
        SendWrongFactionNotice(session);
        return;
      }
      if (sender.hasAura(1852) && !receiver.isGameMaster()) {
        chat.sendNotification(LANG_GM_SILENCE, sender.getName());
        return;
      }
      // If player is a Gamemaster and doesn't accept whisper, we auto-whitelist every player that the Gamemaster is talking to
      // We also do that if a player is under the required level for whispers.
      if (receiver.getLevel() < whisperLevelReq || (session.hasPermission(RBAC_PERM_CAN_FILTER_WHISPERS) && !sender.isAcceptWhispers() && !sender.isInWhisperWhiteList(receiver.getGUID()))) {
        sender.addWhisperWhiteList(receiver.getGUID());
      }
      sender.whisper(msg, lang, receiver);
      break;
    }
    case CHAT_MSG_PARTY:
    case CHAT_MSG_PARTY_LEADER:
    case CHAT_MSG_RAID:
    case CHAT_MSG_RAID_LEADER:
    case CHAT_MSG_RAID_WARNING:
    case CHAT_MSG_BATTLEGROUND:
    case CHAT_MSG_BATTLEGROUND_LEADER:
      // `GetOriginalGroup()` / `GetGroup()` is null: no group to broadcast to.
      if (sender.getGroup() === null) return;
      break;
    case CHAT_MSG_GUILD:
    case CHAT_MSG_OFFICER:
      // `GetGuildId()` is 0 until guilds are ported.
      return;
    case CHAT_MSG_CHANNEL: {
      if (!session.hasPermission(RBAC_PERM_SKIP_CHECK_CHAT_CHANNEL_REQ)) {
        const req = world.getIntConfig(ServerConfig.CONFIG_CHAT_CHANNEL_LEVEL_REQ);
        if (sender.getLevel() < req) {
          chat.sendNotification(LANG_CHANNEL_REQ, req);
          return;
        }
      }
      // `ChannelMgr::GetChannel` finds nothing: the player is in no channel until channels are ported.
      void channel;
      break;
    }
    case CHAT_MSG_AFK:
      if (!sender.isInCombat()) {
        if (sender.isAFK()) {
          if (msg.length === 0) sender.toggleAFK();
          else sender.setAutoReplyMsg(msg);
        } else {
          sender.setAutoReplyMsg(msg.length === 0 ? session.getAcoreString(LANG_PLAYER_AFK_DEFAULT) : msg);
          if (sender.isDND()) sender.toggleDND();
          sender.toggleAFK();
        }
      }
      break;
    case CHAT_MSG_DND:
      if (sender.isDND()) {
        if (msg.length === 0) sender.toggleDND();
        else sender.setAutoReplyMsg(msg);
      } else {
        sender.setAutoReplyMsg(msg.length === 0 ? session.getAcoreString(LANG_PLAYER_DND_DEFAULT) : msg);
        if (sender.isAFK()) sender.toggleAFK();
        sender.toggleDND();
      }
      break;
    default:
      logError("world", `CHAT: unknown message type ${type}, lang: ${lang}`);
  }
}

/** @ac game/Server/WorldSession.cpp WorldSession::ValidateHyperlinksAndMaybeKick */
export function ValidateHyperlinksAndMaybeKick(session: WorldSession, str: string): boolean {
  if (CheckAllLinks(str)) return true;
  logError("world", `Player ${session.getPlayer()?.getName() ?? ""} sent a message with an invalid link:\n${str}`);
  if (sWorld().getIntConfig(ServerConfig.CONFIG_CHAT_STRICT_LINK_CHECKING_KICK)) session.kickPlayer("WorldSession::ValidateHyperlinksAndMaybeKick Invalid chat link");
  return false;
}

/** @ac game/Handlers/ChatHandler.cpp WorldSession::HandleEmoteOpcode */
export function HandleEmoteOpcode(session: WorldSession, payload: Uint8Array): void {
  const player = session.getPlayer();
  if (!player || payload.length < 4) return;
  if (player.isGMSpectator()) return;
  const emoteId = new ByteReader(payload).readU32();
  // restrict to the only emotes hardcoded in client
  if (emoteId !== EMOTE_ONESHOT_NONE && emoteId !== EMOTE_ONESHOT_WAVE) return;
  if (!player.isAlive()) return;
  HandleEmoteCommand(session, player, emoteId);
}

/** @ac game/Entities/Unit/Unit.cpp Unit::HandleEmoteCommand */
export function HandleEmoteCommand(session: WorldSession, player: Player, emoteId: number): void {
  const body = new ByteWriter().writeU32(emoteId).writeU64(player.getGUID()).toUint8Array();
  session.sendPacket(SMSG_EMOTE, body);
  session.players.broadcast(player.getGUIDLow(), SMSG_EMOTE, body);
}

/** @ac game/Handlers/ChatHandler.cpp WorldSession::HandleTextEmoteOpcode */
export function HandleTextEmoteOpcode(session: WorldSession, payload: Uint8Array): void {
  const player = session.getPlayer();
  if (!player || payload.length < 16) return;
  const recvData = new ByteReader(payload);
  const textEmote = recvData.readU32();
  if (!player.isAlive()) return;
  updateSpeakTime(session, ChatFloodThrottle.REGULAR);
  if (!player.canSpeak()) {
    const timeStr = secsToTimeString(session.muteTime - Math.floor(Date.now() / 1000));
    new ChatHandler(session).sendNotification(LANG_WAIT_BEFORE_SPEAKING, timeStr);
    return;
  }
  if (player.isGMSpectator()) return;
  const emoteNum = recvData.readU32();
  const guid = recvData.readU64();
  const em = sEmotesTextStore.lookupEntry(textEmote);
  if (!em) return;
  const emoteAnim = em.textid;
  switch (emoteAnim) {
    case EMOTE_STATE_SLEEP:
    case EMOTE_STATE_SIT:
    case EMOTE_STATE_KNEEL:
    case EMOTE_ONESHOT_NONE:
      break;
    case EMOTE_STATE_DANCE:
      player.setUInt32Value(UNIT_NPC_EMOTESTATE, emoteAnim);
      break;
    default:
      HandleEmoteCommand(session, player, emoteAnim);
  }
  const unit = guid ? (player.getSelectedUnit()?.getGUID() === guid ? player.getSelectedUnit() : (ObjectAccessor.FindPlayer(guid) ?? null)) : null;
  const name = unit?.getName() ?? "";
  // `Acore::EmoteChatBuilder`
  const data = new ByteWriter().writeU64(player.getGUID()).writeU32(textEmote).writeU32(emoteNum).writeU32(name.length);
  if (name.length > 1) data.writeCString(name);
  else data.writeU8(0);
  const body = data.toUint8Array();
  session.sendPacket(SMSG_TEXT_EMOTE, body);
  session.players.sendInRange(player.getGUIDLow(), sWorld().getFloatConfig(ServerConfig.CONFIG_LISTEN_RANGE_TEXTEMOTE), SMSG_TEXT_EMOTE, body);
}

/** @ac game/Handlers/ChatHandler.cpp WorldSession::HandleChatIgnoredOpcode */
export function HandleChatIgnoredOpcode(session: WorldSession, payload: Uint8Array): void {
  const self = session.getPlayer();
  if (!self || payload.length < 9) return;
  const iguid = new ByteReader(payload).readU64();
  const player = ObjectAccessor.FindConnectedPlayer(iguid);
  if (!player) return;
  const packet = BuildChatPacketFor(CHAT_MSG_IGNORED, LANG_UNIVERSAL, self.chatParty(), self.chatParty(), self.getName());
  player.getSession().sendPacket(packet.opcode, packet.body);
}

/** @ac game/Handlers/ChatHandler.cpp WorldSession::SendPlayerNotFoundNotice */
export function SendPlayerNotFoundNotice(session: WorldSession, name: string): void {
  session.sendPacket(SMSG_CHAT_PLAYER_NOT_FOUND, new ByteWriter().writeCString(name).toUint8Array());
}

/** @ac game/Handlers/ChatHandler.cpp WorldSession::SendPlayerAmbiguousNotice */
export function SendPlayerAmbiguousNotice(session: WorldSession, name: string): void {
  session.sendPacket(SMSG_CHAT_PLAYER_AMBIGUOUS, new ByteWriter().writeCString(name).toUint8Array());
}

/** @ac game/Handlers/ChatHandler.cpp WorldSession::SendWrongFactionNotice */
export function SendWrongFactionNotice(session: WorldSession): void {
  session.sendPacket(SMSG_CHAT_WRONG_FACTION, new Uint8Array(0));
}

/** @ac game/Handlers/ChatHandler.cpp WorldSession::SendChatRestrictedNotice */
export function SendChatRestrictedNotice(session: WorldSession, restriction: number): void {
  session.sendPacket(SMSG_CHAT_RESTRICTED, Uint8Array.of(restriction));
}

export { CHAT_MSG_RESTRICTED, CHAT_MSG_TEXT_EMOTE };
