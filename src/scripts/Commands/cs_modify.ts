/** `cs_modify.cpp`: `.modify hp|mana|…|speed …` and `.morph`. */
import * as R from "../../game/Accounts/RBACDefines.ts";
import { ChatHandler } from "../../game/Chat/Chat.ts";
import { ChatCommand, Console, registerCommandScript, SubCommands, type ChatCommandTable } from "../../game/Chat/ChatCommands/ChatCommand.ts";
import { floatArg, int32Arg, Optional, stringArg, uint16Arg, uint32Arg, uint8Arg } from "../../game/Chat/ChatCommands/ChatCommandArgs.ts";
import { Tail, Variant, type VariantValue } from "../../game/Chat/ChatCommands/ChatCommandTags.ts";
import { sCreatureDisplayInfoStore, sFactionStore, sFactionTemplateStore } from "../../game/DataStores/DBCStores.ts";
import type { CommandUnit, Player } from "../../game/Entities/Player/Player.ts";
import * as L from "../../game/Miscellaneous/Language.ts";
import type { FormatArg } from "../../common/Utilities/StringFormat.ts";
import { moneyStringToMoney, stringEqualI, wstrToLower } from "../../common/util.ts";
import { OBJECT_END, UNIT_FIELD_MOUNTDISPLAYID, UNIT_NPC_EMOTESTATE } from "../../gen/UpdateFields.gen.ts";
import { guidString } from "../../game/Chat/Chat.ts";

const POWER_MANA = 0;
const POWER_RAGE = 1;
const POWER_ENERGY = 3;
const POWER_RUNIC_POWER = 6;
const MOVE_WALK = 0;
const MOVE_RUN = 1;
const MOVE_RUN_BACK = 2;
const MOVE_SWIM = 3;
const MOVE_FLIGHT = 6;
const MAX_MONEY_AMOUNT = 0x7fffffff;
const GENDER_MALE = 0;
const GENDER_FEMALE = 1;
const SMSG_SET_FLAT_SPELL_MODIFIER = 0x266;
const SPELL_AURA_MOUNTED = 78;

/** @ac game/Reputation/ReputationMgr.h ReputationMgr::PointsInRank */
const PointsInRank = [36000, 3000, 3000, 3000, 6000, 12000, 21000, 1000] as const;
const MAX_REPUTATION_RANK = 8;
/** @ac game/Reputation/ReputationMgr.cpp ReputationRankStrIndex */
const ReputationRankStrIndex = [L.LANG_REP_HATED, L.LANG_REP_HOSTILE, L.LANG_REP_UNFRIENDLY, L.LANG_REP_NEUTRAL, L.LANG_REP_FRIENDLY, L.LANG_REP_HONORED, L.LANG_REP_REVERED, L.LANG_REP_EXALTED] as const;

/** @ac scripts/Commands/cs_modify.cpp modify_commandscript::GetCommands */
function GetCommands(): ChatCommandTable {
  const modifyspeedCommandTable: ChatCommandTable = [
    ChatCommand("fly", [floatArg], HandleModifyFlyCommand, R.RBAC_PERM_COMMAND_MODIFY_SPEED_FLY, Console.No),
    ChatCommand("all", [floatArg], HandleModifyASpeedCommand, R.RBAC_PERM_COMMAND_MODIFY_SPEED_ALL, Console.No),
    ChatCommand("walk", [floatArg], HandleModifySpeedCommand, R.RBAC_PERM_COMMAND_MODIFY_SPEED_WALK, Console.No),
    ChatCommand("backwalk", [floatArg], HandleModifyBWalkCommand, R.RBAC_PERM_COMMAND_MODIFY_SPEED_BACKWALK, Console.No),
    ChatCommand("swim", [floatArg], HandleModifySwimCommand, R.RBAC_PERM_COMMAND_MODIFY_SPEED_SWIM, Console.No),
    ChatCommand("", [floatArg], HandleModifyASpeedCommand, R.RBAC_PERM_COMMAND_MODIFY_SPEED, Console.No),
  ];
  const modifyCommandTable: ChatCommandTable = [
    ChatCommand("hp", [int32Arg], HandleModifyHPCommand, R.RBAC_PERM_COMMAND_MODIFY_HP, Console.No),
    ChatCommand("mana", [int32Arg], HandleModifyManaCommand, R.RBAC_PERM_COMMAND_MODIFY_MANA, Console.No),
    ChatCommand("rage", [int32Arg], HandleModifyRageCommand, R.RBAC_PERM_COMMAND_MODIFY_RAGE, Console.No),
    ChatCommand("runicpower", [int32Arg], HandleModifyRunicPowerCommand, R.RBAC_PERM_COMMAND_MODIFY_RUNICPOWER, Console.No),
    ChatCommand("energy", [int32Arg], HandleModifyEnergyCommand, R.RBAC_PERM_COMMAND_MODIFY_ENERGY, Console.No),
    ChatCommand("money", [Tail], HandleModifyMoneyCommand, R.RBAC_PERM_COMMAND_MODIFY_MONEY, Console.No),
    ChatCommand("scale", [floatArg], HandleModifyScaleCommand, R.RBAC_PERM_COMMAND_MODIFY_SCALE, Console.No),
    ChatCommand("bit", [uint16Arg, uint32Arg], HandleModifyBitCommand, R.RBAC_PERM_COMMAND_MODIFY_BIT, Console.No),
    ChatCommand("faction", [Optional(uint32Arg), Optional(uint32Arg), Optional(uint32Arg), Optional(uint32Arg)], HandleModifyFactionCommand, R.RBAC_PERM_COMMAND_MODIFY_FACTION, Console.No),
    ChatCommand("spell", [uint8Arg, uint8Arg, uint16Arg, Optional(uint16Arg)], HandleModifySpellCommand, R.RBAC_PERM_COMMAND_MODIFY_SPELL, Console.No),
    ChatCommand("talentpoints", [uint32Arg], HandleModifyTalentCommand, R.RBAC_PERM_COMMAND_MODIFY_TALENTPOINTS, Console.No),
    ChatCommand("mount", [uint32Arg, Optional(floatArg)], HandleModifyMountCommand, R.RBAC_PERM_COMMAND_MODIFY_MOUNT, Console.No),
    ChatCommand("honor", [int32Arg], HandleModifyHonorCommand, R.RBAC_PERM_COMMAND_MODIFY_HONOR, Console.No),
    ChatCommand("reputation", [uint32Arg, Variant(int32Arg, stringArg), Optional(int32Arg)], HandleModifyRepCommand, R.RBAC_PERM_COMMAND_MODIFY_REPUTATION, Console.No),
    ChatCommand("arenapoints", [int32Arg], HandleModifyArenaCommand, R.RBAC_PERM_COMMAND_MODIFY_ARENAPOINTS, Console.No),
    ChatCommand("drunk", [uint8Arg], HandleModifyDrunkCommand, R.RBAC_PERM_COMMAND_MODIFY_DRUNK, Console.No),
    ChatCommand("standstate", [uint32Arg], HandleModifyStandStateCommand, R.RBAC_PERM_COMMAND_MODIFY_STANDSTATE, Console.No),
    ChatCommand("phase", [uint32Arg], HandleModifyPhaseCommand, R.RBAC_PERM_COMMAND_MODIFY_PHASE, Console.No),
    ChatCommand("gender", [Tail], HandleModifyGenderCommand, R.RBAC_PERM_COMMAND_MODIFY_GENDER, Console.No),
    SubCommands("speed", modifyspeedCommandTable),
  ];
  const morphCommandTable: ChatCommandTable = [
    ChatCommand("reset", [], HandleMorphResetCommand, R.RBAC_PERM_COMMAND_DEMORPH, Console.No),
    ChatCommand("target", [uint32Arg], HandleMorphTargetCommand, R.RBAC_PERM_COMMAND_MORPH, Console.No),
    ChatCommand("mount", [uint32Arg], HandleMorphMountCommand, R.RBAC_PERM_COMMAND_MORPH, Console.No),
  ];
  return [SubCommands("morph", morphCommandTable), SubCommands("modify", modifyCommandTable)];
}

/** @ac scripts/Commands/cs_modify.cpp modify_commandscript::NotifyModification */
function NotifyModification(handler: ChatHandler, target: CommandUnit, resourceMessage: number, resourceReportMessage: number, ...args: FormatArg[]): void {
  const player = target.toPlayer();
  if (player) {
    handler.pSendSysMessage(resourceMessage, ...args, handler.getNameLink(player));
    if (handler.needReportToTarget(player)) new ChatHandler(player.getSession()).pSendSysMessage(resourceReportMessage, handler.getNameLink(), ...args);
  }
}

/** @ac scripts/Commands/cs_modify.cpp modify_commandscript::CheckModifyInt32 */
async function CheckModifyInt32(handler: ChatHandler, target: Player | null, modifyValue: number): Promise<boolean> {
  if (modifyValue < 1) {
    handler.sendErrorMessage(L.LANG_BAD_VALUE);
    return false;
  }
  if (!target) {
    handler.sendErrorMessage(L.LANG_NO_CHAR_SELECTED);
    return false;
  }
  if (await handler.hasLowerSecurity(target)) return false;
  return true;
}

/** @ac scripts/Commands/cs_modify.cpp modify_commandscript::HandleModifyHPCommand */
async function HandleModifyHPCommand(handler: ChatHandler, healthPoints: number): Promise<boolean> {
  const target = handler.getSelectedPlayer();
  if (!(await CheckModifyInt32(handler, target, healthPoints))) return false;
  handler.pSendSysMessage(L.LANG_YOU_CHANGE_HP, handler.getNameLink(target!), healthPoints, healthPoints);
  if (handler.needReportToTarget(target!)) new ChatHandler(target!.getSession()).pSendSysMessage(L.LANG_YOURS_HP_CHANGED, handler.getNameLink(), healthPoints, healthPoints);
  target!.setMaxHealth(healthPoints);
  target!.setHealth(healthPoints);
  return true;
}

/** `.modify mana|energy|rage|runicpower`: max power and power (energy, rage, and runic power are stored ×10). */
async function modifyPower(handler: ChatHandler, points: number, power: number, scale: number, message: number, report: number): Promise<boolean> {
  const target = handler.getSelectedPlayer();
  if (!(await CheckModifyInt32(handler, target, points))) return false;
  const value = points * scale;
  handler.pSendSysMessage(message, handler.getNameLink(target!), value / scale, value / scale);
  if (handler.needReportToTarget(target!)) new ChatHandler(target!.getSession()).pSendSysMessage(report, handler.getNameLink(), value / scale, value / scale);
  target!.setMaxPower(power, value);
  target!.setPower(power, value);
  return true;
}

/** @ac scripts/Commands/cs_modify.cpp modify_commandscript::HandleModifyManaCommand */
function HandleModifyManaCommand(handler: ChatHandler, manaPoints: number): Promise<boolean> {
  return modifyPower(handler, manaPoints, POWER_MANA, 1, L.LANG_YOU_CHANGE_MANA, L.LANG_YOURS_MANA_CHANGED);
}

/** @ac scripts/Commands/cs_modify.cpp modify_commandscript::HandleModifyEnergyCommand */
function HandleModifyEnergyCommand(handler: ChatHandler, energyPoints: number): Promise<boolean> {
  return modifyPower(handler, energyPoints, POWER_ENERGY, 10, L.LANG_YOU_CHANGE_ENERGY, L.LANG_YOURS_ENERGY_CHANGED);
}

/** @ac scripts/Commands/cs_modify.cpp modify_commandscript::HandleModifyRageCommand */
function HandleModifyRageCommand(handler: ChatHandler, ragePoints: number): Promise<boolean> {
  return modifyPower(handler, ragePoints, POWER_RAGE, 10, L.LANG_YOU_CHANGE_RAGE, L.LANG_YOURS_RAGE_CHANGED);
}

/** @ac scripts/Commands/cs_modify.cpp modify_commandscript::HandleModifyRunicPowerCommand */
function HandleModifyRunicPowerCommand(handler: ChatHandler, runePoints: number): Promise<boolean> {
  return modifyPower(handler, runePoints, POWER_RUNIC_POWER, 10, L.LANG_YOU_CHANGE_RUNIC_POWER, L.LANG_YOURS_RUNIC_POWER_CHANGED);
}

/** @ac scripts/Commands/cs_modify.cpp modify_commandscript::HandleModifyFactionCommand */
function HandleModifyFactionCommand(handler: ChatHandler, factionID: number | null, flagID: number | null, npcFlagID: number | null, dynamicFlagID: number | null): boolean {
  const target = handler.getSelectedCreature();
  if (!target) {
    handler.sendErrorMessage(L.LANG_SELECT_CREATURE);
    return false;
  }
  if (factionID === null) {
    handler.pSendSysMessage(L.LANG_CURRENT_FACTION, guidString(target.getGUID()), target.getFaction(), target.getUnitFlags(), target.getNpcFlags(), target.getDynamicFlags());
    return true;
  }
  const factionid = factionID;
  const flag = flagID ?? target.getUnitFlags();
  const npcflag = npcFlagID ?? target.getNpcFlags();
  const dyflag = dynamicFlagID ?? target.getDynamicFlags();
  if (!sFactionTemplateStore.lookupEntry(factionid)) {
    handler.sendErrorMessage(L.LANG_WRONG_FACTION, factionid);
    return false;
  }
  handler.pSendSysMessage(L.LANG_YOU_CHANGE_FACTION, guidString(target.getGUID()), factionid, flag, npcflag, dyflag);
  target.setFaction(factionid);
  target.replaceAllUnitFlags(flag);
  target.replaceAllNpcFlags(npcflag);
  target.replaceAllDynamicFlags(dyflag);
  return true;
}

/** @ac scripts/Commands/cs_modify.cpp modify_commandscript::HandleModifySpellCommand */
async function HandleModifySpellCommand(handler: ChatHandler, spellFlatID: number, op: number, val: number, mark: number | null): Promise<boolean> {
  const target = handler.getSelectedPlayer();
  if (!target) {
    handler.sendErrorMessage(L.LANG_NO_CHAR_SELECTED);
    return false;
  }
  // check online security
  if (await handler.hasLowerSecurity(target)) return false;
  handler.pSendSysMessage(L.LANG_YOU_CHANGE_SPELLFLATID, spellFlatID, val, mark ?? 65535, handler.getNameLink(target));
  if (handler.needReportToTarget(target)) new ChatHandler(target.getSession()).pSendSysMessage(L.LANG_YOURS_SPELLFLATID_CHANGED, handler.getNameLink(), spellFlatID, val, mark ?? 65535);
  const data = new Uint8Array(6);
  const view = new DataView(data.buffer);
  view.setUint8(0, spellFlatID);
  view.setUint8(1, op);
  view.setUint16(2, val, true);
  view.setUint16(4, mark ?? 65535, true);
  target.getSession().sendPacket(SMSG_SET_FLAT_SPELL_MODIFIER, data);
  return true;
}

/** @ac scripts/Commands/cs_modify.cpp modify_commandscript::HandleModifyTalentCommand */
async function HandleModifyTalentCommand(handler: ChatHandler, talentPoints: number): Promise<boolean> {
  if (!talentPoints) return false;
  const target = handler.getSelectedUnit();
  if (!target) {
    handler.sendErrorMessage(L.LANG_NO_CHAR_SELECTED);
    return false;
  }
  const player = target.toPlayer();
  if (player) {
    // check online security
    if (await handler.hasLowerSecurity(player)) return false;
    player.setFreeTalentPoints(talentPoints);
    player.sendTalentsInfoData(false);
    return true;
  }
  // Pets are not ported, so a selected creature is never a permanent pet.
  handler.sendErrorMessage(L.LANG_NO_CHAR_SELECTED);
  return false;
}

/** @ac scripts/Commands/cs_modify.cpp modify_commandscript::CheckModifySpeed */
async function CheckModifySpeed(handler: ChatHandler, target: CommandUnit | null, speed: number, minimumBound: number, maximumBound: number, checkInFlight = true): Promise<boolean> {
  if (speed > maximumBound || speed < minimumBound) {
    handler.sendErrorMessage(L.LANG_BAD_VALUE);
    return false;
  }
  if (!target) {
    handler.sendErrorMessage(L.LANG_NO_CHAR_SELECTED);
    return false;
  }
  const player = target.toPlayer();
  if (player) {
    // check online security
    if (await handler.hasLowerSecurity(player)) return false;
    if (player.isInFlight() && checkInFlight) {
      handler.sendErrorMessage(L.LANG_CHAR_IN_FLIGHT, handler.getNameLink(player));
      return false;
    }
  }
  return true;
}

/** @ac scripts/Commands/cs_modify.cpp modify_commandscript::HandleModifyASpeedCommand */
async function HandleModifyASpeedCommand(handler: ChatHandler, allSpeed: number): Promise<boolean> {
  const target = handler.getSelectedPlayerOrSelf();
  if (await CheckModifySpeed(handler, target, allSpeed, 0.1, 50.0)) {
    NotifyModification(handler, target!, L.LANG_YOU_CHANGE_ASPEED, L.LANG_YOURS_ASPEED_CHANGED, allSpeed);
    target!.setSpeedRate(MOVE_WALK, allSpeed);
    target!.setSpeedRate(MOVE_RUN, allSpeed);
    target!.setSpeedRate(MOVE_SWIM, allSpeed);
    target!.setSpeedRate(MOVE_FLIGHT, allSpeed);
    return true;
  }
  return false;
}

/** One `.modify speed <type>` handler. */
async function modifyOneSpeed(handler: ChatHandler, speed: number, moveType: number, message: number, report: number, checkInFlight = true): Promise<boolean> {
  const target = handler.getSelectedPlayerOrSelf();
  if (await CheckModifySpeed(handler, target, speed, 0.1, 50.0, checkInFlight)) {
    NotifyModification(handler, target!, message, report, speed);
    target!.setSpeedRate(moveType, speed);
    return true;
  }
  return false;
}

/** @ac scripts/Commands/cs_modify.cpp modify_commandscript::HandleModifySpeedCommand */
function HandleModifySpeedCommand(handler: ChatHandler, speed: number): Promise<boolean> {
  return modifyOneSpeed(handler, speed, MOVE_RUN, L.LANG_YOU_CHANGE_SPEED, L.LANG_YOURS_SPEED_CHANGED);
}

/** @ac scripts/Commands/cs_modify.cpp modify_commandscript::HandleModifySwimCommand */
function HandleModifySwimCommand(handler: ChatHandler, swimSpeed: number): Promise<boolean> {
  return modifyOneSpeed(handler, swimSpeed, MOVE_SWIM, L.LANG_YOU_CHANGE_SWIM_SPEED, L.LANG_YOURS_SWIM_SPEED_CHANGED);
}

/** @ac scripts/Commands/cs_modify.cpp modify_commandscript::HandleModifyBWalkCommand */
function HandleModifyBWalkCommand(handler: ChatHandler, backSpeed: number): Promise<boolean> {
  return modifyOneSpeed(handler, backSpeed, MOVE_RUN_BACK, L.LANG_YOU_CHANGE_BACK_SPEED, L.LANG_YOURS_BACK_SPEED_CHANGED);
}

/** @ac scripts/Commands/cs_modify.cpp modify_commandscript::HandleModifyFlyCommand */
function HandleModifyFlyCommand(handler: ChatHandler, flySpeed: number): Promise<boolean> {
  return modifyOneSpeed(handler, flySpeed, MOVE_FLIGHT, L.LANG_YOU_CHANGE_FLY_SPEED, L.LANG_YOURS_FLY_SPEED_CHANGED, false);
}

/** @ac scripts/Commands/cs_modify.cpp modify_commandscript::HandleModifyScaleCommand */
async function HandleModifyScaleCommand(handler: ChatHandler, scale: number): Promise<boolean> {
  if (scale > 10.0 || scale < 0.1) {
    handler.sendErrorMessage(L.LANG_BAD_VALUE);
    return false;
  }
  const target = handler.getSelectedUnit();
  if (!target) {
    handler.sendErrorMessage(L.LANG_SELECT_CHAR_OR_CREATURE);
    return false;
  }
  const player = target.toPlayer();
  if (player) {
    // check online security
    if (await handler.hasLowerSecurity(player)) return false;
    handler.pSendSysMessage(L.LANG_YOU_CHANGE_SIZE, scale, handler.getNameLink(player));
    if (handler.needReportToTarget(player)) new ChatHandler(player.getSession()).pSendSysMessage(L.LANG_YOURS_SIZE_CHANGED, handler.getNameLink(), scale);
  }
  target.setObjectScale(scale);
  return true;
}

/** @ac scripts/Commands/cs_modify.cpp modify_commandscript::HandleModifyMountCommand */
async function HandleModifyMountCommand(handler: ChatHandler, creatureDisplayID: number, speed: number | null): Promise<boolean> {
  if (!sCreatureDisplayInfoStore.lookupEntry(creatureDisplayID)) {
    handler.sendErrorMessage(L.LANG_NO_MOUNT);
    return false;
  }
  const target = handler.getSelectedPlayerOrSelf();
  if (!target) {
    handler.sendErrorMessage(L.LANG_NO_CHAR_SELECTED);
    return false;
  }
  // check online security
  if (await handler.hasLowerSecurity(target, 0)) return false;
  const _speed = speed ?? 1.0;
  if (!(await CheckModifySpeed(handler, target, _speed, 0.1, 50.0))) return false;
  NotifyModification(handler, target, L.LANG_YOU_GIVE_MOUNT, L.LANG_MOUNT_GIVED);
  target.mount(creatureDisplayID);
  target.setSpeedRate(MOVE_RUN, _speed);
  target.setSpeedRate(MOVE_FLIGHT, _speed);
  return true;
}

/** `Acore::StringTo<int32>` */
function stringToInt32(str: string): number | null {
  if (!/^[+-]?\d+$/.test(str)) return null;
  const value = Number.parseInt(str, 10);
  return value >= -0x80000000 && value <= 0x7fffffff ? value : null;
}

/** @ac scripts/Commands/cs_modify.cpp modify_commandscript::HandleModifyMoneyCommand */
async function HandleModifyMoneyCommand(handler: ChatHandler, money: string): Promise<boolean> {
  if (!money) return false;
  const target = handler.getSelectedPlayer();
  if (!target) {
    handler.sendErrorMessage(L.LANG_NO_CHAR_SELECTED);
    return false;
  }
  // check online security
  if (await handler.hasLowerSecurity(target)) return false;
  const IsExistWord = (line: string, words: string[]): boolean => words.some((word) => line.includes(word));
  const moneyToAddO = IsExistWord(money, ["g", "s", "c"]) ? moneyStringToMoney(money) : stringToInt32(money);
  if (moneyToAddO === null) return false;
  let moneyToAdd = moneyToAddO;
  const targetMoney = target.getMoney();
  if (moneyToAdd < 0) {
    let newmoney = targetMoney + moneyToAdd;
    if (newmoney <= 0) {
      handler.pSendSysMessage(L.LANG_YOU_TAKE_ALL_MONEY, handler.getNameLink(target));
      if (handler.needReportToTarget(target)) new ChatHandler(target.getSession()).pSendSysMessage(L.LANG_YOURS_ALL_MONEY_GONE, handler.getNameLink());
      target.setMoney(0);
    } else {
      if (newmoney > MAX_MONEY_AMOUNT) newmoney = MAX_MONEY_AMOUNT;
      handler.pSendSysMessage(L.LANG_YOU_TAKE_MONEY, Math.abs(moneyToAdd), handler.getNameLink(target));
      if (handler.needReportToTarget(target)) new ChatHandler(target.getSession()).pSendSysMessage(L.LANG_YOURS_MONEY_TAKEN, handler.getNameLink(), Math.abs(moneyToAdd));
      target.setMoney(newmoney);
    }
  } else {
    handler.pSendSysMessage(L.LANG_YOU_GIVE_MONEY, moneyToAdd, handler.getNameLink(target));
    if (handler.needReportToTarget(target)) new ChatHandler(target.getSession()).pSendSysMessage(L.LANG_YOURS_MONEY_GIVEN, handler.getNameLink(), moneyToAdd);
    if (moneyToAdd >= MAX_MONEY_AMOUNT) moneyToAdd = MAX_MONEY_AMOUNT;
    if (targetMoney >= MAX_MONEY_AMOUNT - moneyToAdd) moneyToAdd -= targetMoney;
    target.modifyMoney(moneyToAdd);
  }
  return true;
}

/** @ac scripts/Commands/cs_modify.cpp modify_commandscript::HandleModifyBitCommand */
async function HandleModifyBitCommand(handler: ChatHandler, field: number, bit: number): Promise<boolean> {
  const target = handler.getSelectedUnit();
  if (!target) {
    handler.sendErrorMessage(L.LANG_NO_CHAR_SELECTED);
    return false;
  }
  // check online security
  const player = target.toPlayer();
  if (player && (await handler.hasLowerSecurity(player))) return false;
  if (field < OBJECT_END || field >= target.getValuesCount()) {
    handler.sendErrorMessage(L.LANG_BAD_VALUE);
    return false;
  }
  if (bit < 1 || bit > 32) {
    handler.sendErrorMessage(L.LANG_BAD_VALUE);
    return false;
  }
  const flag = (1 << (bit - 1)) >>> 0;
  const current = target.getUInt32Value(field);
  if (current & flag) {
    target.setUInt32Value(field, (current & ~flag) >>> 0);
    handler.pSendSysMessage(L.LANG_REMOVE_BIT, bit, field);
  } else {
    target.setUInt32Value(field, (current | flag) >>> 0);
    handler.pSendSysMessage(L.LANG_SET_BIT, bit, field);
  }
  return true;
}

/** @ac scripts/Commands/cs_modify.cpp modify_commandscript::HandleModifyHonorCommand */
async function HandleModifyHonorCommand(handler: ChatHandler, amount: number): Promise<boolean> {
  const target = handler.getSelectedPlayer();
  if (!target) {
    handler.sendErrorMessage(L.LANG_PLAYER_NOT_FOUND);
    return false;
  }
  // check online security
  if (await handler.hasLowerSecurity(target)) return false;
  target.modifyHonorPoints(amount);
  handler.pSendSysMessage(L.LANG_COMMAND_MODIFY_HONOR, handler.getNameLink(target), target.getHonorPoints());
  return true;
}

/** @ac scripts/Commands/cs_modify.cpp modify_commandscript::HandleModifyDrunkCommand */
function HandleModifyDrunkCommand(handler: ChatHandler, drunklevelArg: number): boolean {
  const drunklevel = Math.min(drunklevelArg, 100);
  handler.getSelectedPlayer()?.setDrunkValue(drunklevel);
  return true;
}

/** @ac scripts/Commands/cs_modify.cpp modify_commandscript::HandleModifyRepCommand */
async function HandleModifyRepCommand(handler: ChatHandler, factionId: number, rank: VariantValue<number | string>, delta: number | null): Promise<boolean> {
  const target = handler.getSelectedPlayer();
  if (!target) {
    handler.sendErrorMessage(L.LANG_PLAYER_NOT_FOUND);
    return false;
  }
  // check online security
  if (await handler.hasLowerSecurity(target)) return false;
  let amount = 0;
  if (rank.index === 1) {
    const rankStr = rank.value as string;
    const wrankStr = wstrToLower(rankStr);
    let r = 0;
    amount = -42000;
    for (; r < MAX_REPUTATION_RANK; ++r) {
      const rankName = handler.getAcoreString(ReputationRankStrIndex[r]!);
      if (!rankName) continue;
      const wrank = wstrToLower(rankName);
      if (wrank.substring(0, wrankStr.length) === wrankStr) {
        if (delta !== null) {
          if (delta < 0 || delta > PointsInRank[r]! - 1) {
            handler.sendErrorMessage(L.LANG_COMMAND_FACTION_DELTA, PointsInRank[r]! - 1);
            return false;
          }
          amount += delta;
        }
        break;
      }
      amount += PointsInRank[r]!;
    }
    if (r >= MAX_REPUTATION_RANK) {
      handler.sendErrorMessage(L.LANG_COMMAND_FACTION_INVPARAM, rankStr);
      return false;
    }
  } else {
    amount = rank.value as number;
  }
  if (!amount) return false;
  const factionEntry = sFactionStore.lookupEntry(factionId);
  if (!factionEntry) {
    handler.sendErrorMessage(L.LANG_COMMAND_FACTION_UNKNOWN, factionId);
    return false;
  }
  const locale = handler.getSessionDbcLocale();
  if (factionEntry.reputationListID < 0) {
    handler.sendErrorMessage(L.LANG_COMMAND_FACTION_NOREP_ERROR, factionEntry.name[locale] ?? "", factionId);
    return false;
  }
  target.setOneFactionReputation(factionId, amount);
  handler.pSendSysMessage(L.LANG_COMMAND_MODIFY_REP, factionEntry.name[locale] ?? "", factionId, handler.getNameLink(target), target.getReputationOf(factionId));
  return true;
}

/** @ac scripts/Commands/cs_modify.cpp modify_commandscript::HandleMorphTargetCommand */
async function HandleMorphTargetCommand(handler: ChatHandler, displayID: number): Promise<boolean> {
  let target = handler.getSelectedUnit();
  if (!target) target = handler.getSession()!.getPlayer()!;
  else if (target.toPlayer() && (await handler.hasLowerSecurity(target.toPlayer()))) return false; // check online security
  target.setDisplayId(displayID);
  return true;
}

/** @ac scripts/Commands/cs_modify.cpp modify_commandscript::HandleMorphResetCommand */
async function HandleMorphResetCommand(handler: ChatHandler): Promise<boolean> {
  let target = handler.getSelectedUnit();
  if (!target) target = handler.getSession()!.getPlayer()!;
  else if (target.toPlayer() && (await handler.hasLowerSecurity(target.toPlayer()))) return false; // check online security
  target.deMorph();
  return true;
}

/** @ac scripts/Commands/cs_modify.cpp modify_commandscript::HandleMorphMountCommand */
async function HandleMorphMountCommand(handler: ChatHandler, displayID: number): Promise<boolean> {
  const target = handler.getSelectedPlayerOrSelf()!;
  if (await handler.hasLowerSecurity(target)) return false; // check online security
  if (!target.spellUnit()?.hasAuraType(SPELL_AURA_MOUNTED)) return false;
  target.setUInt32Value(UNIT_FIELD_MOUNTDISPLAYID, displayID);
  return true;
}

/** @ac scripts/Commands/cs_modify.cpp modify_commandscript::HandleModifyPhaseCommand */
async function HandleModifyPhaseCommand(handler: ChatHandler, phaseMask: number): Promise<boolean> {
  let target = handler.getSelectedUnit();
  if (!target) target = handler.getSession()!.getPlayer()!;
  else if (target.toPlayer() && (await handler.hasLowerSecurity(target.toPlayer()))) return false; // check online security
  target.setPhaseMask(phaseMask, true);
  return true;
}

/** @ac scripts/Commands/cs_modify.cpp modify_commandscript::HandleModifyStandStateCommand */
function HandleModifyStandStateCommand(handler: ChatHandler, anim: number): boolean {
  handler.getSession()!.getPlayer()!.setUInt32Value(UNIT_NPC_EMOTESTATE, anim);
  return true;
}

/** @ac scripts/Commands/cs_modify.cpp modify_commandscript::HandleModifyArenaCommand */
function HandleModifyArenaCommand(handler: ChatHandler, amount: number): boolean {
  const target = handler.getSelectedPlayer();
  if (!target) {
    handler.sendErrorMessage(L.LANG_PLAYER_NOT_FOUND);
    return false;
  }
  target.modifyArenaPoints(amount);
  handler.pSendSysMessage(L.LANG_COMMAND_MODIFY_ARENA, handler.getNameLink(target), target.getArenaPoints());
  return true;
}

/** @ac scripts/Commands/cs_modify.cpp modify_commandscript::HandleModifyGenderCommand */
function HandleModifyGenderCommand(handler: ChatHandler, genderString: string): boolean {
  if (!genderString) return false;
  const target = handler.getSelectedPlayer();
  if (!target) {
    handler.sendErrorMessage(L.LANG_PLAYER_NOT_FOUND);
    return false;
  }
  // `sObjectMgr->GetPlayerInfo(race, class)`: the race and class have a `playercreateinfo` row.
  if (!target.getStartPosition()) return false;
  let gender: number;
  if (stringEqualI(genderString, "male")) {
    // MALE
    if (target.getGender() === GENDER_MALE) return true;
    gender = GENDER_MALE;
  } else if (stringEqualI(genderString, "female")) {
    // FEMALE
    if (target.getGender() === GENDER_FEMALE) return true;
    gender = GENDER_FEMALE;
  } else {
    handler.sendErrorMessage(L.LANG_MUST_MALE_OR_FEMALE);
    return false;
  }
  // Set gender, change display ID
  target.setGender(gender);
  const gender_full = gender ? "female" : "male";
  handler.pSendSysMessage(L.LANG_YOU_CHANGE_GENDER, handler.getNameLink(target), gender_full);
  if (handler.needReportToTarget(target)) new ChatHandler(target.getSession()).pSendSysMessage(L.LANG_YOUR_GENDER_CHANGED, gender_full, handler.getNameLink());
  return true;
}

/** @ac scripts/Commands/cs_modify.cpp AddSC_modify_commandscript */
export function AddSC_modify_commandscript(): void {
  registerCommandScript(GetCommands);
}
