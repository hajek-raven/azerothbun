/**
 * `cs_quest.cpp`: `.quest add|complete|remove|reward|status`. Mail is not ported, so the offline paths that mail the
 * required or reward items to the character skip the items.
 */
import { commitTransaction, executeStatementAsync, queryFields, type StatementTransaction } from "../../database/database.ts";
import { CharacterDatabase } from "../../database/DatabaseEnv.ts";
import * as C from "../../gen/CharacterDatabase.gen.ts";
import * as R from "../../game/Accounts/RBACDefines.ts";
import { sCharacterCache } from "../../game/Cache/CharacterCache.ts";
import type { ChatHandler } from "../../game/Chat/Chat.ts";
import { ChatCommand, Console, registerCommandScript, SubCommands, type ChatCommandTable } from "../../game/Chat/ChatCommands/ChatCommand.ts";
import { Optional, QuestArg } from "../../game/Chat/ChatCommands/ChatCommandArgs.ts";
import { PlayerIdentifier, PlayerIdentifierArg } from "../../game/Chat/ChatCommands/ChatCommandTags.ts";
import { sFactionStore } from "../../game/DataStores/DBCStores.ts";
import { sObjectMgr } from "../../game/Globals/ObjectMgr.ts";
import * as L from "../../game/Miscellaneous/Language.ts";
import { ServerConfig } from "../../game/world/world-config.ts";
import { sWorld } from "../../game/world/world.ts";
import {
  getRewOrReqMoney,
  isDaily,
  isMonthly,
  isRepeatable,
  isSeasonal,
  isWeekly,
  questXPValue,
  QUEST_STATUS_COMPLETE,
  QUEST_STATUS_FAILED,
  QUEST_STATUS_INCOMPLETE,
  QUEST_STATUS_NONE,
  QUEST_STATUS_REWARDED,
  type QuestTemplate,
} from "../../world/quests.ts";
import type { WorldSession } from "../../world/session.ts";

const QUEST_FLAGS_EXPLORATION = 0x00000004;
const QUEST_FLAGS_NO_MONEY_FROM_XP = 0x00000100;
const QUEST_FLAGS_DAILY = 0x00001000;

/** @ac scripts/Commands/cs_quest.cpp quest_commandscript::GetCommands */
function GetCommands(): ChatCommandTable {
  const questCommandTable: ChatCommandTable = [
    ChatCommand("add", [QuestArg, Optional(PlayerIdentifierArg)], HandleQuestAdd, R.RBAC_PERM_COMMAND_QUEST_ADD, Console.Yes),
    ChatCommand("complete", [QuestArg, Optional(PlayerIdentifierArg)], HandleQuestComplete, R.RBAC_PERM_COMMAND_QUEST_COMPLETE, Console.Yes),
    ChatCommand("remove", [QuestArg, Optional(PlayerIdentifierArg)], HandleQuestRemove, R.RBAC_PERM_COMMAND_QUEST_REMOVE, Console.Yes),
    ChatCommand("reward", [QuestArg, Optional(PlayerIdentifierArg)], HandleQuestReward, R.RBAC_PERM_COMMAND_QUEST_REWARD, Console.Yes),
    ChatCommand("status", [QuestArg, Optional(PlayerIdentifierArg)], HandleQuestStatus, R.RBAC_PERM_COMMAND_QUEST, Console.Yes),
  ];
  return [SubCommands("quest", questCommandTable)];
}

/** Sends the quest log update after a command changed the online player's log, and saves the log. */
function sendQuestLog(session: WorldSession): void {
  const talk = session.talk;
  const character = session.character;
  if (!talk || !character) return;
  const update = talk.questLogUpdate(character);
  session.sendPacket(update.opcode, update.body);
  void talk.save(session.db.characters, character.guid);
}

/** @ac scripts/Commands/cs_quest.cpp quest_commandscript::HandleQuestAdd */
async function HandleQuestAdd(handler: ChatHandler, quest: QuestTemplate, playerArg: PlayerIdentifier | null): Promise<boolean> {
  const playerTarget = playerArg ?? PlayerIdentifier.fromTargetOrSelf(handler);
  if (!playerTarget) {
    handler.sendErrorMessage(L.LANG_PLAYER_NOT_FOUND);
    return false;
  }
  const entry = quest.id;
  // check item starting quest (it can work incorrectly if added without item in inventory)
  for (const itemTemplate of sObjectMgr.getItemTemplateStore().values()) {
    if (itemTemplate.startQuest === entry) {
      handler.sendErrorMessage(L.LANG_COMMAND_QUEST_STARTFROMITEM, entry, itemTemplate.entry);
      return false;
    }
  }
  const player = playerTarget.getConnectedPlayer();
  if (player) {
    const talk = player.getSession().talk;
    if (talk?.quests.active().has(entry)) {
      handler.sendErrorMessage(L.LANG_COMMAND_QUEST_ACTIVE, quest.logTitle, entry);
      return false;
    }
    // ok, normal (creature/GO starting) quest
    if (talk && talk.quests.addQuest(entry) === "ok") sendQuestLog(player.getSession());
  } else {
    const guid = playerTarget.getGUID();
    if ((await queryFields(CharacterDatabase(), "SELECT 1 FROM character_queststatus WHERE guid = ? AND quest = ?", guid, entry)).length > 0) {
      handler.sendErrorMessage(L.LANG_COMMAND_QUEST_ACTIVE, quest.logTitle, entry);
      return false;
    }
    executeStatementAsync(CharacterDatabase(), C.CHAR_REP_CHAR_QUESTSTATUS, guid, entry, 1, false, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  }
  handler.pSendSysMessage(L.LANG_COMMAND_QUEST_ADD, quest.logTitle, entry);
  handler.setSentErrorMessage(false);
  return true;
}

/** @ac scripts/Commands/cs_quest.cpp quest_commandscript::HandleQuestRemove */
async function HandleQuestRemove(handler: ChatHandler, quest: QuestTemplate, playerArg: PlayerIdentifier | null): Promise<boolean> {
  const playerTarget = playerArg ?? PlayerIdentifier.fromTargetOrSelf(handler);
  if (!playerTarget) {
    handler.sendErrorMessage(L.LANG_PLAYER_NOT_FOUND);
    return false;
  }
  const entry = quest.id;
  const player = playerTarget.getConnectedPlayer();
  if (player) {
    // remove all quest entries for 'entry' from quest log, the rewarded state, and the source item
    const talk = player.getSession().talk;
    talk?.quests.removeQuest(entry);
    if (quest.startItem) await player.destroyItemCount(quest.startItem, player.getItemCount(quest.startItem, false));
    sendQuestLog(player.getSession());
  } else {
    const guid = playerTarget.getGUID();
    const trans: StatementTransaction = [
      [C.CHAR_DEL_CHAR_QUESTSTATUS_REWARDED_BY_QUEST, guid, entry],
      [C.CHAR_DEL_CHAR_QUESTSTATUS_BY_QUEST, guid, entry],
    ];
    for (const requiredItem of quest.requiredItemId) {
      const [fields] = await queryFields(CharacterDatabase(), C.CHAR_SEL_CHAR_INVENTORY_ITEM_BY_ENTRY_AND_OWNER, requiredItem, guid);
      if (fields) trans.push([C.CHAR_DEL_CHAR_INVENTORY_BY_ITEM, Number(fields[0])], [C.CHAR_DEL_ITEM_INSTANCE, Number(fields[0])]);
    }
    await commitTransaction(CharacterDatabase(), trans);
  }
  handler.pSendSysMessage(L.LANG_COMMAND_QUEST_REMOVED, quest.logTitle, entry);
  handler.setSentErrorMessage(false);
  return true;
}

/** @ac scripts/Commands/cs_quest.cpp quest_commandscript::HandleQuestComplete */
async function HandleQuestComplete(handler: ChatHandler, quest: QuestTemplate, playerArg: PlayerIdentifier | null): Promise<boolean> {
  const playerTarget = playerArg ?? PlayerIdentifier.fromTargetOrSelf(handler);
  if (!playerTarget) {
    handler.sendErrorMessage(L.LANG_PLAYER_NOT_FOUND);
    return false;
  }
  const entry = quest.id;
  const player = playerTarget.getConnectedPlayer();
  if (player) {
    // If player doesn't have the quest
    if (player.getQuestStatus(entry) === QUEST_STATUS_NONE) {
      handler.sendErrorMessage(L.LANG_COMMAND_QUEST_NOTFOUND, entry);
      return false;
    }
    // Add quest items for quests that require items
    for (let x = 0; x < 6; ++x) {
      const id = quest.requiredItemId[x] ?? 0;
      const count = quest.requiredItemCount[x] ?? 0;
      if (!id || !count) continue;
      const curItemCount = player.getItemCount(id, true);
      if (count > curItemCount) await player.addItem(id, count - curItemCount, null);
    }
    // If the quest requires reputation to complete
    for (let i = 0; i < 2; i++) {
      const repFaction = quest.requiredFactionId[i] ?? 0;
      const repValue = quest.requiredFactionValue[i] ?? 0;
      if (repFaction && player.getReputationOf(repFaction) < repValue && sFactionStore.lookupEntry(repFaction)) player.setOneFactionReputation(repFaction, repValue);
    }
    // If the quest requires money
    const ReqOrRewMoney = getRewOrReqMoney(quest, player.getLevel(), sessionCatalogMoney(player.getSession()));
    if (ReqOrRewMoney < 0) player.modifyMoney(-ReqOrRewMoney);
    // All creature/GO slain/casted, the items, and the exploration: Player::CompleteQuest
    player.getSession().talk?.quests.forceComplete(entry);
    sendQuestLog(player.getSession());
  } else {
    const guid = playerTarget.getGUID();
    if ((await queryFields(CharacterDatabase(), "SELECT 1 FROM character_queststatus WHERE guid = ? AND quest = ?", guid, entry)).length === 0) {
      handler.sendErrorMessage(L.LANG_COMMAND_QUEST_NOT_FOUND_IN_LOG, quest.logTitle, entry);
      return false;
    }
    const trans: StatementTransaction = [
      [C.CHAR_REP_CHAR_QUESTSTATUS, guid, entry, 1, (quest.flags & QUEST_FLAGS_EXPLORATION) !== 0, 0, ...quest.requiredNpcOrGoCount, 0, 0, 0, 0, 0, 0, 0],
    ];
    // If the quest requires reputation to complete, set the player rep to the required amount.
    const repObjectives: [number, number][] = [
      [quest.requiredFactionId[0], quest.requiredFactionValue[0]],
      // AzerothCore reads GetRepObjectiveValue() for the second faction too.
      [quest.requiredFactionId[1], quest.requiredFactionValue[0]],
    ];
    for (const [repFaction, repValue] of repObjectives) {
      if (!repFaction) continue;
      const [fields] = await queryFields(CharacterDatabase(), C.CHAR_SEL_CHAR_REP_BY_FACTION, repFaction, guid);
      if (fields && Number(fields[0]) < repValue && sFactionStore.lookupEntry(repFaction)) trans.push([C.CHAR_UPD_CHAR_REP_FACTION_CHANGE, repFaction, repValue, repFaction, guid]);
    }
    await commitTransaction(CharacterDatabase(), trans);
  }
  // check if Quest Tracker is enabled
  if (sWorld().getBoolConfig(ServerConfig.CONFIG_QUEST_ENABLE_QUEST_TRACKER)) executeStatementAsync(CharacterDatabase(), C.CHAR_UPD_QUEST_TRACK_GM_COMPLETE, entry, playerTarget.getGUID());
  handler.pSendSysMessage(L.LANG_COMMAND_QUEST_COMPLETE, quest.logTitle, entry);
  handler.setSentErrorMessage(false);
  return true;
}

function sessionCatalogMoney(session: WorldSession): Map<number, number[]> {
  return session.talk?.quests.source().moneyByLevel ?? new Map();
}

/** @ac scripts/Commands/cs_quest.cpp quest_commandscript::HandleQuestReward */
async function HandleQuestReward(handler: ChatHandler, quest: QuestTemplate, playerArg: PlayerIdentifier | null): Promise<boolean> {
  const playerTarget = playerArg ?? PlayerIdentifier.fromTargetOrSelf(handler);
  if (!playerTarget) {
    handler.sendErrorMessage(L.LANG_PLAYER_NOT_FOUND);
    return false;
  }
  const entry = quest.id;
  const player = playerTarget.getConnectedPlayer();
  if (player) {
    // If player doesn't have the quest
    if (player.getQuestStatus(entry) !== QUEST_STATUS_COMPLETE) {
      handler.sendErrorMessage(L.LANG_COMMAND_QUEST_NOTFOUND, entry);
      return false;
    }
    const session = player.getSession();
    const packets = session.talk && session.character && session.kit ? session.talk.rewardByCommand(session.character, session.kit, entry) : null;
    for (const packet of packets ?? []) session.sendPacket(packet.opcode, packet.body);
    if (session.talk && session.character) void session.talk.save(session.db.characters, session.character.guid);
  } else {
    // Achievement criteria, titles, talent points, spells, and reputation are granted on login or not at all, as in AzerothCore.
    const guid = playerTarget.getGUID();
    const charLevel = sCharacterCache.getCharacterLevelByGuid(guid);
    if ((await queryFields(CharacterDatabase(), "SELECT 1 FROM character_queststatus WHERE guid = ? AND quest = ? AND status = 1", guid, entry)).length === 0) {
      handler.sendErrorMessage(L.LANG_COMMAND_QUEST_NOT_COMPLETE);
      return false;
    }
    const trans: StatementTransaction = [];
    for (const itemId of [...quest.requiredItemId, ...quest.itemDrop]) {
      const [fields] = await queryFields(CharacterDatabase(), C.CHAR_SEL_CHAR_INVENTORY_ITEM_BY_ENTRY_AND_OWNER, itemId, guid);
      if (fields) trans.push([C.CHAR_DEL_CHAR_INVENTORY_BY_ITEM, Number(fields[0])], [C.CHAR_DEL_ITEM_INSTANCE, Number(fields[0])]);
    }
    // The reward items are mailed in AzerothCore; mail is not ported.
    const now = Math.floor(Date.now() / 1000);
    if (isDaily(quest) || (quest.flags & QUEST_FLAGS_DAILY) !== 0) trans.push([C.CHAR_INS_CHARACTER_DAILYQUESTSTATUS, guid, entry, now]);
    else if (isWeekly(quest)) trans.push([C.CHAR_INS_CHARACTER_WEEKLYQUESTSTATUS, guid, entry]);
    else if (isMonthly(quest)) trans.push([C.CHAR_INS_CHARACTER_MONTHLYQUESTSTATUS, guid, entry]);
    else if (isSeasonal(quest)) {
      // We can't know which event is the quest linked to, so we can't do anything about this.
    }
    // Quest::CalculateHonorGain
    const honor = quest.rewardHonor > 0 || quest.rewardKillHonor > 0 ? Math.ceil(charLevel * 1.55 * quest.rewardKillHonor) + quest.rewardHonor : 0;
    if (honor) trans.push([C.CHAR_UDP_CHAR_HONOR_POINTS_ACCUMULATIVE, honor, guid]);
    if (quest.rewardArenaPoints) trans.push([C.CHAR_UDP_CHAR_ARENA_POINTS_ACCUMULATIVE, quest.rewardArenaPoints, guid]);
    const catalog = sObjectMgr.questCatalog();
    let rewMoney = 0;
    const maxLevel = sWorld().getIntConfig(ServerConfig.CONFIG_MAX_PLAYER_LEVEL);
    if (charLevel >= maxLevel) {
      // Quest::GetRewMoneyMaxLevel
      rewMoney = quest.flags & QUEST_FLAGS_NO_MONEY_FROM_XP ? 0 : questXPValue(quest, maxLevel, catalog?.xpByLevel ?? new Map()) * 6;
    } else {
      // Some experience might get lost on level up.
      const xp = Math.trunc(questXPValue(quest, charLevel, catalog?.xpByLevel ?? new Map()) * sWorld().getRate(ServerConfig.RATE_XP_QUEST));
      trans.push([C.CHAR_UPD_XP_ACCUMULATIVE, xp, guid]);
    }
    const rewOrReqMoney = getRewOrReqMoney(quest, charLevel, catalog?.moneyByLevel ?? new Map());
    if (rewOrReqMoney) rewMoney += rewOrReqMoney;
    // Only reward money, don't subtract, let's not cause an overflow...
    if (rewMoney > 0) trans.push([C.CHAR_UDP_CHAR_MONEY_ACCUMULATIVE, rewMoney, guid]);
    trans.push([C.CHAR_INS_CHAR_QUESTSTATUS_REWARDED, guid, entry], [C.CHAR_DEL_CHAR_QUESTSTATUS_BY_QUEST, guid, entry]);
    await commitTransaction(CharacterDatabase(), trans);
  }
  handler.pSendSysMessage(L.LANG_COMMAND_QUEST_REWARDED, quest.logTitle, entry);
  handler.setSentErrorMessage(false);
  return true;
}

/** @ac scripts/Commands/cs_quest.cpp quest_commandscript::QuestStatusToString */
function QuestStatusToString(status: number): string {
  switch (status) {
    case QUEST_STATUS_NONE:
      return "Not Taken";
    case QUEST_STATUS_COMPLETE:
      return "Complete";
    case QUEST_STATUS_INCOMPLETE:
      return "Incomplete";
    case QUEST_STATUS_FAILED:
      return "Failed";
    case QUEST_STATUS_REWARDED:
      return "Rewarded";
    default:
      return "Unknown";
  }
}

/** @ac scripts/Commands/cs_quest.cpp quest_commandscript::HandleQuestStatus */
async function HandleQuestStatus(handler: ChatHandler, quest: QuestTemplate, playerArg: PlayerIdentifier | null): Promise<boolean> {
  const playerTarget = playerArg ?? PlayerIdentifier.fromTargetOrSelf(handler);
  if (!playerTarget) {
    handler.sendErrorMessage(L.LANG_PLAYER_NOT_FOUND);
    return false;
  }
  const entry = quest.id;
  const player = playerTarget.getConnectedPlayer();
  if (player) {
    handler.pSendSysMessage(L.LANG_CMD_QUEST_STATUS, quest.logTitle, entry, QuestStatusToString(player.getQuestStatus(entry)));
    const quests = player.getSession().talk?.quests;
    const speaker = { race: player.getRace(), classId: player.getClass(), level: player.getLevel() };
    if (quests && !quests.canTake(entry, speaker)) {
      handler.pSendSysMessage(L.LANG_CMD_QUEST_UNAVAILABLE, entry);
      // The reasons `QuestLog::canTake` checks (conditions, skills, reputation, and breadcrumbs are not ported there).
      const status = player.getQuestStatus(entry);
      if (status !== QUEST_STATUS_NONE && !(status === QUEST_STATUS_REWARDED && isRepeatable(quest))) handler.sendSysMessage(L.LANG_CMD_QUEST_STATUS_ALREADY_DONE);
      if (!player.satisfyQuestClass(quest)) handler.sendSysMessage(L.LANG_CMD_QUEST_STATUS_CLASS);
      if (quest.allowableRaces !== 0 && (quest.allowableRaces & player.getRaceMask()) === 0) handler.sendSysMessage(L.LANG_CMD_QUEST_STATUS_RACE);
      if (player.getLevel() < quest.minLevel) handler.pSendSysMessage(L.LANG_CMD_QUEST_STATUS_LOW_LEVEL, quest.minLevel);
      if (quest.maxLevel > 0 && player.getLevel() > quest.maxLevel) handler.pSendSysMessage(L.LANG_CMD_QUEST_STATUS_HIGH_LEVEL, quest.maxLevel);
      if (quest.prevQuestId > 0 && !quests.rewarded(quest.prevQuestId)) handler.sendSysMessage(L.LANG_CMD_QUEST_STATUS_PREV_QUEST);
      if (quests.logFull()) handler.sendSysMessage(L.LANG_CMD_QUEST_STATUS_LOG_FULL);
    }
  } else {
    const guid = playerTarget.getGUID();
    let status: string;
    const [result] = await queryFields(CharacterDatabase(), C.CHAR_SEL_CHAR_QUESTSTATUS_BY_QUEST, guid, entry);
    if (result) status = QuestStatusToString(Number(result[0]));
    else if (isSeasonal(quest)) status = "Not Taken"; // `GetEventIdForQuest` needs the game event quests, which are not ported
    // rewarded repeatable quests report Not Taken, matching Player::GetQuestStatus
    else if (!isRepeatable(quest)) status = (await queryFields(CharacterDatabase(), C.CHAR_SEL_CHAR_QUESTSTATUS_REWARDED_BY_QUEST, guid, entry)).length > 0 ? "Rewarded" : "Not Taken";
    else status = "Not Taken";
    handler.pSendSysMessage(L.LANG_CMD_QUEST_STATUS, quest.logTitle, entry, status);
  }
  return true;
}

/** @ac scripts/Commands/cs_quest.cpp AddSC_quest_commandscript */
export function AddSC_quest_commandscript(): void {
  registerCommandScript(GetCommands);
}
