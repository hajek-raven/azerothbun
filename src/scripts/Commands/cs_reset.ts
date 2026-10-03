/** `cs_reset.cpp`: `.reset achievements|honor|level|spells|stats|talents|items …|all`. */
import { commitTransaction, executeStatementAsync } from "../../database/database.ts";
import { CharacterDatabase } from "../../database/DatabaseEnv.ts";
import {
  CHAR_DEL_CHAR_ACHIEVEMENT,
  CHAR_DEL_CHAR_ACHIEVEMENT_OFFLINE_UPDATES,
  CHAR_DEL_CHAR_ACHIEVEMENT_PROGRESS,
  CHAR_UPD_ADD_AT_LOGIN_FLAG,
  CHAR_UPD_ALL_ARENA_POINTS,
  CHAR_UPD_ALL_AT_LOGIN_FLAGS,
  CHAR_UPD_ALL_HONOR_POINTS,
} from "../../gen/CharacterDatabase.gen.ts";
import {
  PLAYER_FIELD_KILLS,
  PLAYER_FIELD_LIFETIME_HONORABLE_KILLS,
  PLAYER_FIELD_TODAY_CONTRIBUTION,
  PLAYER_FIELD_WATCHED_FACTION_INDEX,
  PLAYER_FIELD_YESTERDAY_CONTRIBUTION,
  PLAYER_XP,
  UNIT_FIELD_BYTES_0,
  UNIT_FIELD_BYTES_2,
} from "../../gen/UpdateFields.gen.ts";
import * as R from "../../game/Accounts/RBACDefines.ts";
import { ChatHandler } from "../../game/Chat/Chat.ts";
import { ChatCommand, Console, registerCommandScript, SubCommands, type ChatCommandTable } from "../../game/Chat/ChatCommands/ChatCommand.ts";
import { Optional, stringViewArg } from "../../game/Chat/ChatCommands/ChatCommandArgs.ts";
import { PlayerIdentifier, PlayerIdentifierArg } from "../../game/Chat/ChatCommands/ChatCommandTags.ts";
import { sChrClassesStore } from "../../game/DataStores/DBCStores.ts";
import type { Player } from "../../game/Entities/Player/Player.ts";
import { AT_LOGIN_RESET_PET_TALENTS, AT_LOGIN_RESET_SPELLS, AT_LOGIN_RESET_TALENTS } from "../../game/Entities/Player/PlayerDefines.ts";
import { ObjectAccessor } from "../../game/Globals/ObjectAccessor.ts";
import * as L from "../../game/Miscellaneous/Language.ts";
import { ServerConfig } from "../../game/world/world-config.ts";
import { sWorld } from "../../game/world/world.ts";
import { logError } from "../../log.ts";

const INVENTORY_SLOT_BAG_0 = 255;
const EQUIPMENT_SLOT_START = 0;
const EQUIPMENT_SLOT_END = 19;
const INVENTORY_SLOT_BAG_START = 19;
const INVENTORY_SLOT_BAG_END = 23;
const INVENTORY_SLOT_ITEM_START = 23;
const INVENTORY_SLOT_ITEM_END = 39;
const BANK_SLOT_ITEM_START = 39;
const BANK_SLOT_ITEM_END = 67;
const BANK_SLOT_BAG_START = 67;
const BANK_SLOT_BAG_END = 74;
const BUYBACK_SLOT_START = 74;
const BUYBACK_SLOT_END = 86;
const KEYRING_SLOT_START = 86;
const KEYRING_SLOT_END = 118;
const CURRENCYTOKEN_SLOT_START = 118;
const CURRENCYTOKEN_SLOT_END = 150;
const UNIT_BYTE2_FLAG_PVP = 0x01;
const UNIT_FLAG_PLAYER_CONTROLLED = 0x00000008;
const CLASS_DEATH_KNIGHT = 6;
const SPELL_AURA_MOD_SHAPESHIFT = 36;

/** @ac scripts/Commands/cs_reset.cpp reset_commandscript::GetCommands */
function GetCommands(): ChatCommandTable {
  const target = [Optional(PlayerIdentifierArg)] as const;
  const resetItemsCommandTable: ChatCommandTable = [
    ChatCommand("equipped", target, HandleResetItemsEquippedCommand, R.RBAC_PERM_COMMAND_RESET, Console.Yes),
    ChatCommand("bags", target, HandleResetItemsInBagsCommand, R.RBAC_PERM_COMMAND_RESET, Console.Yes),
    ChatCommand("bank", target, HandleResetItemsInBankCommand, R.RBAC_PERM_COMMAND_RESET, Console.Yes),
    ChatCommand("keyring", target, HandleResetItemsKeyringCommand, R.RBAC_PERM_COMMAND_RESET, Console.Yes),
    ChatCommand("currency", target, HandleResetItemsInCurrenciesListCommand, R.RBAC_PERM_COMMAND_RESET, Console.Yes),
    ChatCommand("vendor_buyback", target, HandleResetItemsInVendorBuyBackTabCommand, R.RBAC_PERM_COMMAND_RESET, Console.Yes),
    ChatCommand("all", target, HandleResetItemsAllCommand, R.RBAC_PERM_COMMAND_RESET, Console.Yes),
    ChatCommand("allbags", target, HandleResetItemsAllAndDeleteBagsCommand, R.RBAC_PERM_COMMAND_RESET, Console.Yes),
  ];
  const resetCommandTable: ChatCommandTable = [
    ChatCommand("achievements", target, HandleResetAchievementsCommand, R.RBAC_PERM_COMMAND_RESET_ACHIEVEMENTS, Console.Yes),
    ChatCommand("honor", target, HandleResetHonorCommand, R.RBAC_PERM_COMMAND_RESET_HONOR, Console.Yes),
    ChatCommand("level", target, HandleResetLevelCommand, R.RBAC_PERM_COMMAND_RESET_LEVEL, Console.Yes),
    ChatCommand("spells", target, HandleResetSpellsCommand, R.RBAC_PERM_COMMAND_RESET_SPELLS, Console.Yes),
    ChatCommand("stats", target, HandleResetStatsCommand, R.RBAC_PERM_COMMAND_RESET_STATS, Console.Yes),
    ChatCommand("talents", target, HandleResetTalentsCommand, R.RBAC_PERM_COMMAND_RESET_TALENTS, Console.Yes),
    SubCommands("items", resetItemsCommandTable),
    ChatCommand("all", [stringViewArg], HandleResetAllCommand, R.RBAC_PERM_COMMAND_RESET_ALL, Console.Yes),
  ];
  return [SubCommands("reset", resetCommandTable)];
}

/** @ac scripts/Commands/cs_reset.cpp reset_commandscript::HandleResetAchievementsCommand (the achievement system is not ported: its rows are deleted either way) */
async function HandleResetAchievementsCommand(_handler: ChatHandler, target: PlayerIdentifier | null): Promise<boolean> {
  if (!target) return false;
  // AchievementMgr::DeleteFromDB
  const guid = target.getGUID();
  await commitTransaction(CharacterDatabase(), [
    [CHAR_DEL_CHAR_ACHIEVEMENT, guid],
    [CHAR_DEL_CHAR_ACHIEVEMENT_PROGRESS, guid],
    [CHAR_DEL_CHAR_ACHIEVEMENT_OFFLINE_UPDATES, guid],
  ]);
  return true;
}

/** @ac scripts/Commands/cs_reset.cpp reset_commandscript::HandleResetHonorCommand */
function HandleResetHonorCommand(_handler: ChatHandler, target: PlayerIdentifier | null): boolean {
  const playerTarget = target?.getConnectedPlayer() ?? null;
  if (!playerTarget) return false;
  playerTarget.setHonorPoints(0);
  playerTarget.setUInt32Value(PLAYER_FIELD_KILLS, 0);
  playerTarget.setUInt32Value(PLAYER_FIELD_LIFETIME_HONORABLE_KILLS, 0);
  playerTarget.setUInt32Value(PLAYER_FIELD_TODAY_CONTRIBUTION, 0);
  playerTarget.setUInt32Value(PLAYER_FIELD_YESTERDAY_CONTRIBUTION, 0);
  return true;
}

/** @ac scripts/Commands/cs_reset.cpp reset_commandscript::HandleResetStatsOrLevelHelper */
function HandleResetStatsOrLevelHelper(player: Player): boolean {
  const classEntry = sChrClassesStore.lookupEntry(player.getClass());
  if (!classEntry) {
    logError("server", `Class ${player.getClass()} not found in DBC (Wrong DBC files?)`);
    return false;
  }
  const powerType = classEntry.powerType;
  // reset m_form if no aura (shapeshift forms are auras here)
  const shapeshifted = player.spellUnit()?.hasAuraType(SPELL_AURA_MOD_SHAPESHIFT) ?? false;
  player.setFactionForRace();
  player.setUInt32Value(UNIT_FIELD_BYTES_0, (player.getRace() | (player.getClass() << 8) | (player.getGender() << 16) | (powerType << 24)) >>> 0);
  // reset only if player not in some form;
  if (!shapeshifted) player.initDisplayIds();
  const bytes2 = player.getUInt32Value(UNIT_FIELD_BYTES_2);
  player.setUInt32Value(UNIT_FIELD_BYTES_2, ((bytes2 & 0xffff00ff) | (UNIT_BYTE2_FLAG_PVP << 8)) >>> 0);
  player.replaceAllUnitFlags(UNIT_FLAG_PLAYER_CONTROLLED);
  //-1 is default value
  player.setUInt32Value(PLAYER_FIELD_WATCHED_FACTION_INDEX, 0xffffffff);
  return true;
}

/** @ac scripts/Commands/cs_reset.cpp reset_commandscript::HandleResetLevelCommand */
function HandleResetLevelCommand(_handler: ChatHandler, target: PlayerIdentifier | null): boolean {
  const playerTarget = target?.getConnectedPlayer() ?? null;
  if (!playerTarget) return false;
  if (!HandleResetStatsOrLevelHelper(playerTarget)) return false;
  // set starting level
  const startLevel =
    playerTarget.getClass() !== CLASS_DEATH_KNIGHT ? sWorld().getIntConfig(ServerConfig.CONFIG_START_PLAYER_LEVEL) : sWorld().getIntConfig(ServerConfig.CONFIG_START_HEROIC_PLAYER_LEVEL);
  playerTarget.setLevel(startLevel);
  playerTarget.initStatsForLevel();
  playerTarget.initTalentForLevel();
  playerTarget.setUInt32Value(PLAYER_XP, 0);
  return true;
}

/** @ac scripts/Commands/cs_reset.cpp reset_commandscript::HandleResetSpellsCommand */
function HandleResetSpellsCommand(handler: ChatHandler, targetArg: PlayerIdentifier | null): boolean {
  const target = targetArg ?? PlayerIdentifier.fromTargetOrSelf(handler);
  if (!target) return false;
  const playerTarget = target.getConnectedPlayer();
  if (playerTarget) {
    playerTarget.resetSpells();
    new ChatHandler(playerTarget.getSession()).sendSysMessage(L.LANG_RESET_SPELLS);
    if (!handler.getSession() || handler.getSession()!.getPlayer() !== playerTarget) handler.pSendSysMessage(L.LANG_RESET_SPELLS_ONLINE, handler.getNameLink(playerTarget));
  } else {
    executeStatementAsync(CharacterDatabase(), CHAR_UPD_ADD_AT_LOGIN_FLAG, AT_LOGIN_RESET_SPELLS, target.getGUID());
    handler.pSendSysMessage(L.LANG_RESET_SPELLS_OFFLINE, target.getName());
  }
  return true;
}

/** @ac scripts/Commands/cs_reset.cpp reset_commandscript::HandleResetStatsCommand */
function HandleResetStatsCommand(_handler: ChatHandler, target: PlayerIdentifier | null): boolean {
  const playerTarget = target?.getConnectedPlayer() ?? null;
  if (!playerTarget) return false;
  if (!HandleResetStatsOrLevelHelper(playerTarget)) return false;
  playerTarget.initStatsForLevel();
  playerTarget.initTalentForLevel();
  return true;
}

/** @ac scripts/Commands/cs_reset.cpp reset_commandscript::HandleResetTalentsCommand */
function HandleResetTalentsCommand(handler: ChatHandler, target: PlayerIdentifier | null): boolean {
  if (!target) {
    handler.sendErrorMessage(L.LANG_NO_CHAR_SELECTED);
    return false;
  }
  const targetPlayer = target.getConnectedPlayer();
  if (targetPlayer) {
    targetPlayer.resetTalents(true);
    targetPlayer.sendTalentsInfoData(false);
    new ChatHandler(targetPlayer.getSession()).sendSysMessage(L.LANG_RESET_TALENTS);
    if (!handler.getSession() || handler.getSession()!.getPlayer() !== targetPlayer) handler.pSendSysMessage(L.LANG_RESET_TALENTS_ONLINE, handler.getNameLink(targetPlayer));
    // Pets are not ported (`Pet::resetTalentsForAllPetsOf`).
    return true;
  }
  executeStatementAsync(CharacterDatabase(), CHAR_UPD_ADD_AT_LOGIN_FLAG, AT_LOGIN_RESET_TALENTS | AT_LOGIN_RESET_PET_TALENTS, target.getGUID());
  handler.pSendSysMessage(L.LANG_RESET_TALENTS_OFFLINE, handler.playerLink(target.getName()));
  return true;
}

/** @ac scripts/Commands/cs_reset.cpp reset_commandscript::HandleResetAllCommand */
function HandleResetAllCommand(handler: ChatHandler, caseName: string): boolean {
  let atLogin: number;
  // Command specially created as single command to prevent using short case names
  if (caseName === "spells") {
    atLogin = AT_LOGIN_RESET_SPELLS;
    handler.sendWorldText(L.LANG_RESETALL_SPELLS);
    if (!handler.getSession()) handler.sendSysMessage(L.LANG_RESETALL_SPELLS);
  } else if (caseName === "talents") {
    atLogin = AT_LOGIN_RESET_TALENTS | AT_LOGIN_RESET_PET_TALENTS;
    handler.sendWorldText(L.LANG_RESETALL_TALENTS);
    if (!handler.getSession()) handler.sendSysMessage(L.LANG_RESETALL_TALENTS);
  } else if (caseName === "honor") {
    executeStatementAsync(CharacterDatabase(), CHAR_UPD_ALL_HONOR_POINTS);
    for (const player of ObjectAccessor.GetPlayers()) player.setHonorPoints(0);
    handler.sendWorldText(L.LANG_RESETALL_HONOR);
    if (!handler.getSession()) handler.sendSysMessage(L.LANG_RESETALL_HONOR);
    return true;
  } else if (caseName === "arena") {
    executeStatementAsync(CharacterDatabase(), CHAR_UPD_ALL_ARENA_POINTS);
    for (const player of ObjectAccessor.GetPlayers()) player.setArenaPoints(0);
    handler.sendWorldText(L.LANG_RESETALL_ARENA);
    if (!handler.getSession()) handler.sendSysMessage(L.LANG_RESETALL_ARENA);
    return true;
  } else {
    handler.sendErrorMessage(L.LANG_RESETALL_UNKNOWN_CASE, caseName);
    return false;
  }
  executeStatementAsync(CharacterDatabase(), CHAR_UPD_ALL_AT_LOGIN_FLAGS, atLogin);
  for (const player of ObjectAccessor.GetPlayers()) player.setAtLoginFlag(atLogin);
  return true;
}

/** @ac scripts/Commands/cs_reset.cpp reset_commandscript::GetPlayerFromIdentifierOrSelectedTarget */
function GetPlayerFromIdentifierOrSelectedTarget(handler: ChatHandler, targetArg: PlayerIdentifier | null): Player | null {
  // Do not use TargetOrSelf, we must be sure to select ourself
  if (!targetArg) {
    // No optional target, so try to get selected target
    const target = PlayerIdentifier.fromTarget(handler);
    if (!target) {
      // No character selected
      handler.sendSysMessage(L.LANG_NO_CHAR_SELECTED);
      return null;
    }
    return target.getConnectedPlayer();
  }
  const targetPlayer = targetArg.getConnectedPlayer();
  if (!targetPlayer) handler.sendSysMessage(L.LANG_PLAYER_NOT_EXIST_OR_OFFLINE);
  return targetPlayer;
}

/** Destroys every item in `[start, end)` of the player's own slots; the count destroyed. */
async function destroyRange(player: Player, start: number, end: number): Promise<number> {
  let count = 0;
  for (let i = start; i < end; ++i) {
    if (player.getItemByPos(INVENTORY_SLOT_BAG_0, i)) {
      await player.destroyItem(INVENTORY_SLOT_BAG_0, i);
      ++count;
    }
  }
  return count;
}

/** Destroys the contents of the bags in bag slots `[start, end)`; the count destroyed. */
async function destroyBagContents(player: Player, start: number, end: number): Promise<number> {
  let count = 0;
  for (let i = start; i < end; ++i) {
    const pBag = player.getBagByPos(i);
    if (!pBag) continue;
    for (let j = 0; j < pBag.size; ++j) {
      if (player.getItemByPos(i, j)) {
        await player.destroyItem(i, j);
        ++count;
      }
    }
  }
  return count;
}

/** @ac scripts/Commands/cs_reset.cpp reset_commandscript::ResetItemsEquipped */
function ResetItemsEquipped(player: Player): Promise<number> {
  return destroyRange(player, EQUIPMENT_SLOT_START, EQUIPMENT_SLOT_END);
}

/** @ac scripts/Commands/cs_reset.cpp reset_commandscript::ResetItemsInBags */
async function ResetItemsInBags(player: Player): Promise<number> {
  // Default bagpack, then the bag slots
  return (await destroyRange(player, INVENTORY_SLOT_ITEM_START, INVENTORY_SLOT_ITEM_END)) + (await destroyBagContents(player, INVENTORY_SLOT_BAG_START, INVENTORY_SLOT_BAG_END));
}

/** @ac scripts/Commands/cs_reset.cpp reset_commandscript::ResetItemsInBank */
async function ResetItemsInBank(player: Player): Promise<number> {
  // Normal bank slot, then the bank bagslots
  return (await destroyRange(player, BANK_SLOT_ITEM_START, BANK_SLOT_ITEM_END)) + (await destroyBagContents(player, BANK_SLOT_BAG_START, BANK_SLOT_BAG_END));
}

/** @ac scripts/Commands/cs_reset.cpp reset_commandscript::ResetItemsInKeyring */
function ResetItemsInKeyring(player: Player): Promise<number> {
  return destroyRange(player, KEYRING_SLOT_START, KEYRING_SLOT_END);
}

/** @ac scripts/Commands/cs_reset.cpp reset_commandscript::ResetItemsInCurrenciesList */
function ResetItemsInCurrenciesList(player: Player): Promise<number> {
  return destroyRange(player, CURRENCYTOKEN_SLOT_START, CURRENCYTOKEN_SLOT_END);
}

/** @ac scripts/Commands/cs_reset.cpp reset_commandscript::ResetItemsInVendorBuyBackTab */
function ResetItemsInVendorBuyBackTab(player: Player): number {
  let count = 0;
  for (let i = BUYBACK_SLOT_START; i < BUYBACK_SLOT_END; ++i) {
    if (player.getItemFromBuyBackSlot(i)) {
      player.removeItemFromBuyBackSlot(i, true);
      ++count;
    }
  }
  return count;
}

/** @ac scripts/Commands/cs_reset.cpp reset_commandscript::ResetItemsDeleteStandardBags */
function ResetItemsDeleteStandardBags(player: Player): Promise<number> {
  return destroyRange(player, INVENTORY_SLOT_BAG_START, INVENTORY_SLOT_BAG_END);
}

/** @ac scripts/Commands/cs_reset.cpp reset_commandscript::ResetItemsDeleteBankBags */
function ResetItemsDeleteBankBags(player: Player): Promise<number> {
  return destroyRange(player, BANK_SLOT_BAG_START, BANK_SLOT_BAG_END);
}

/** One `.reset items …` handler: the reset, then its message with the count. */
async function resetItems(handler: ChatHandler, target: PlayerIdentifier | null, reset: (player: Player) => Promise<number> | number, message: number): Promise<boolean> {
  const targetPlayer = GetPlayerFromIdentifierOrSelectedTarget(handler, target);
  if (!targetPlayer) return false;
  handler.pSendSysMessage(message, await reset(targetPlayer), handler.getNameLink(targetPlayer));
  return true;
}

/** @ac scripts/Commands/cs_reset.cpp reset_commandscript::HandleResetItemsEquippedCommand */
function HandleResetItemsEquippedCommand(handler: ChatHandler, target: PlayerIdentifier | null): Promise<boolean> {
  return resetItems(handler, target, ResetItemsEquipped, L.LANG_COMMAND_RESET_ITEMS_EQUIPPED);
}

/** @ac scripts/Commands/cs_reset.cpp reset_commandscript::HandleResetItemsInBagsCommand */
function HandleResetItemsInBagsCommand(handler: ChatHandler, target: PlayerIdentifier | null): Promise<boolean> {
  return resetItems(handler, target, ResetItemsInBags, L.LANG_COMMAND_RESET_ITEMS_BAGS);
}

/** @ac scripts/Commands/cs_reset.cpp reset_commandscript::HandleResetItemsKeyringCommand */
function HandleResetItemsKeyringCommand(handler: ChatHandler, target: PlayerIdentifier | null): Promise<boolean> {
  return resetItems(handler, target, ResetItemsInKeyring, L.LANG_COMMAND_RESET_ITEMS_KEYRING);
}

/** @ac scripts/Commands/cs_reset.cpp reset_commandscript::HandleResetItemsInCurrenciesListCommand */
function HandleResetItemsInCurrenciesListCommand(handler: ChatHandler, target: PlayerIdentifier | null): Promise<boolean> {
  return resetItems(handler, target, ResetItemsInCurrenciesList, L.LANG_COMMAND_RESET_ITEMS_CURRENCY);
}

/** @ac scripts/Commands/cs_reset.cpp reset_commandscript::HandleResetItemsInBankCommand */
function HandleResetItemsInBankCommand(handler: ChatHandler, target: PlayerIdentifier | null): Promise<boolean> {
  return resetItems(handler, target, ResetItemsInBank, L.LANG_COMMAND_RESET_ITEMS_BANK);
}

/** @ac scripts/Commands/cs_reset.cpp reset_commandscript::HandleResetItemsInVendorBuyBackTabCommand */
function HandleResetItemsInVendorBuyBackTabCommand(handler: ChatHandler, target: PlayerIdentifier | null): Promise<boolean> {
  return resetItems(handler, target, ResetItemsInVendorBuyBackTab, L.LANG_COMMAND_RESET_ITEMS_BUYBACK);
}

/** @ac scripts/Commands/cs_reset.cpp reset_commandscript::HandleResetItemsAllCommand */
async function HandleResetItemsAllCommand(handler: ChatHandler, target: PlayerIdentifier | null): Promise<boolean> {
  const targetPlayer = GetPlayerFromIdentifierOrSelectedTarget(handler, target);
  if (!targetPlayer) return false;
  // Delete all items destinations
  const equipped = await ResetItemsEquipped(targetPlayer);
  const bags = await ResetItemsInBags(targetPlayer);
  const bank = await ResetItemsInBank(targetPlayer);
  const keyring = await ResetItemsInKeyring(targetPlayer);
  const currencies = await ResetItemsInCurrenciesList(targetPlayer);
  const buyback = ResetItemsInVendorBuyBackTab(targetPlayer);
  handler.pSendSysMessage(L.LANG_COMMAND_RESET_ITEMS_ALL, handler.getNameLink(targetPlayer), equipped, bags, bank, keyring, currencies, buyback);
  return true;
}

/** @ac scripts/Commands/cs_reset.cpp reset_commandscript::HandleResetItemsAllAndDeleteBagsCommand */
async function HandleResetItemsAllAndDeleteBagsCommand(handler: ChatHandler, target: PlayerIdentifier | null): Promise<boolean> {
  const targetPlayer = GetPlayerFromIdentifierOrSelectedTarget(handler, target);
  if (!targetPlayer) return false;
  // Delete all items destinations
  const equipped = await ResetItemsEquipped(targetPlayer);
  const bags = await ResetItemsInBags(targetPlayer);
  const bank = await ResetItemsInBank(targetPlayer);
  const keyring = await ResetItemsInKeyring(targetPlayer);
  const currencies = await ResetItemsInCurrenciesList(targetPlayer);
  const buyback = ResetItemsInVendorBuyBackTab(targetPlayer);
  const standardBags = await ResetItemsDeleteStandardBags(targetPlayer);
  const bankBags = await ResetItemsDeleteBankBags(targetPlayer);
  handler.pSendSysMessage(L.LANG_COMMAND_RESET_ITEMS_ALL_BAGS, handler.getNameLink(targetPlayer), equipped, bags, bank, keyring, currencies, buyback, standardBags, bankBags);
  return true;
}

/** @ac scripts/Commands/cs_reset.cpp AddSC_reset_commandscript */
export function AddSC_reset_commandscript(): void {
  registerCommandScript(GetCommands);
}
