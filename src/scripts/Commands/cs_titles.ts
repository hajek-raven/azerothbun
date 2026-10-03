/** `cs_titles.cpp`: `.titles add|current|remove|set mask`. */
import * as R from "../../game/Accounts/RBACDefines.ts";
import type { ChatHandler } from "../../game/Chat/Chat.ts";
import { ChatCommand, Console, registerCommandScript, SubCommands, type ChatCommandTable } from "../../game/Chat/ChatCommands/ChatCommand.ts";
import { uint16Arg, uint64Arg } from "../../game/Chat/ChatCommands/ChatCommandArgs.ts";
import { Hyperlink, Variant, type VariantValue } from "../../game/Chat/ChatCommands/ChatCommandTags.ts";
import { title } from "../../game/Chat/Hyperlinks.ts";
import { sCharTitlesStore } from "../../game/DataStores/DBCStores.ts";
import type { Player } from "../../game/Entities/Player/Player.ts";
import * as L from "../../game/Miscellaneous/Language.ts";
import { StringFormat } from "../../common/Utilities/StringFormat.ts";
import type { CharTitlesEntry } from "../../gen/DBCStructure.gen.ts";
import { PLAYER__FIELD_KNOWN_TITLES, PLAYER_CHOSEN_TITLE } from "../../gen/UpdateFields.gen.ts";

const GENDER_MALE = 0;
const TitleIdArg = Variant(Hyperlink(title), uint16Arg);

/** @ac scripts/Commands/cs_titles.cpp titles_commandscript::GetCommands */
function GetCommands(): ChatCommandTable {
  const titlesSetCommandTable: ChatCommandTable = [ChatCommand("mask", [uint64Arg], HandleTitlesSetMaskCommand, R.RBAC_PERM_COMMAND_TITLES_SET_MASK, Console.No)];
  const titlesCommandTable: ChatCommandTable = [
    ChatCommand("add", [TitleIdArg], HandleTitlesAddCommand, R.RBAC_PERM_COMMAND_TITLES_ADD, Console.No),
    ChatCommand("current", [TitleIdArg], HandleTitlesCurrentCommand, R.RBAC_PERM_COMMAND_TITLES_CURRENT, Console.No),
    ChatCommand("remove", [TitleIdArg], HandleTitlesRemoveCommand, R.RBAC_PERM_COMMAND_TITLES_REMOVE, Console.No),
    SubCommands("set", titlesSetCommandTable),
  ];
  return [SubCommands("titles", titlesCommandTable)];
}

/** The selected player (security checked) and the `CharTitles.dbc` row, or null after the error message. */
async function titleTarget(handler: ChatHandler, titleId: number): Promise<{ target: Player; titleInfo: CharTitlesEntry } | null> {
  const target = handler.getSelectedPlayer();
  if (!target) {
    handler.sendErrorMessage(L.LANG_NO_CHAR_SELECTED);
    return null;
  }
  // check online security
  if (await handler.hasLowerSecurity(target, 0)) return null;
  const titleInfo = sCharTitlesStore.lookupEntry(titleId);
  if (!titleInfo) {
    handler.sendErrorMessage(L.LANG_INVALID_TITLE_ID, titleId);
    return null;
  }
  return { target, titleInfo };
}

function titleName(handler: ChatHandler, target: Player, titleInfo: CharTitlesEntry): string {
  const locale = handler.getSessionDbcLocale();
  return StringFormat((target.getGender() === GENDER_MALE ? titleInfo.nameMale[locale] : titleInfo.nameFemale[locale]) ?? "", target.getName());
}

/** @ac scripts/Commands/cs_titles.cpp titles_commandscript::HandleTitlesCurrentCommand */
async function HandleTitlesCurrentCommand(handler: ChatHandler, titleIdArg: VariantValue<number>): Promise<boolean> {
  const titleId = titleIdArg.value;
  const found = await titleTarget(handler, titleId);
  if (!found) return false;
  const { target, titleInfo } = found;
  const tNameLink = handler.getNameLink(target);
  const titleNameStr = titleName(handler, target, titleInfo);
  target.setTitle(titleInfo.bit_index, false);
  target.setUInt32Value(PLAYER_CHOSEN_TITLE, titleInfo.bit_index);
  handler.pSendSysMessage(L.LANG_TITLE_CURRENT_RES, titleId, titleNameStr, tNameLink);
  return true;
}

/** @ac scripts/Commands/cs_titles.cpp titles_commandscript::HandleTitlesAddCommand */
async function HandleTitlesAddCommand(handler: ChatHandler, titleIdArg: VariantValue<number>): Promise<boolean> {
  const titleId = titleIdArg.value;
  const found = await titleTarget(handler, titleId);
  if (!found) return false;
  const { target, titleInfo } = found;
  const tNameLink = handler.getNameLink(target);
  const titleNameStr = titleName(handler, target, titleInfo);
  target.setTitle(titleInfo.bit_index, false);
  handler.pSendSysMessage(L.LANG_TITLE_ADD_RES, titleId, titleNameStr, tNameLink);
  return true;
}

/** @ac scripts/Commands/cs_titles.cpp titles_commandscript::HandleTitlesRemoveCommand */
async function HandleTitlesRemoveCommand(handler: ChatHandler, titleIdArg: VariantValue<number>): Promise<boolean> {
  const titleId = titleIdArg.value;
  const found = await titleTarget(handler, titleId);
  if (!found) return false;
  const { target, titleInfo } = found;
  target.setTitle(titleInfo.bit_index, true);
  const tNameLink = handler.getNameLink(target);
  const titleNameStr = titleName(handler, target, titleInfo);
  handler.pSendSysMessage(L.LANG_TITLE_REMOVE_RES, titleId, titleNameStr, tNameLink);
  if (!target.hasTitle(target.getUInt32Value(PLAYER_CHOSEN_TITLE) | 0)) {
    target.setUInt32Value(PLAYER_CHOSEN_TITLE, 0);
    handler.pSendSysMessage(L.LANG_CURRENT_TITLE_RESET, tNameLink);
  }
  return true;
}

/** @ac scripts/Commands/cs_titles.cpp titles_commandscript::HandleTitlesSetMaskCommand */
async function HandleTitlesSetMaskCommand(handler: ChatHandler, maskArg: bigint): Promise<boolean> {
  const target = handler.getSelectedPlayer();
  if (!target) {
    handler.sendErrorMessage(L.LANG_NO_CHAR_SELECTED);
    return false;
  }
  // check online security
  if (await handler.hasLowerSecurity(target, 0)) return false;
  let mask = maskArg;
  let titles2 = mask;
  for (let i = 1; i < sCharTitlesStore.getNumRows(); ++i) {
    const tEntry = sCharTitlesStore.lookupEntry(i);
    if (tEntry) titles2 &= ~(1n << BigInt(tEntry.bit_index));
  }
  mask &= ~titles2; // remove non-existing titles
  target.setUInt32Value(PLAYER__FIELD_KNOWN_TITLES, Number(mask & 0xffffffffn));
  target.setUInt32Value(PLAYER__FIELD_KNOWN_TITLES + 1, Number((mask >> 32n) & 0xffffffffn));
  handler.sendSysMessage(L.LANG_DONE);
  if (!target.hasTitle(target.getUInt32Value(PLAYER_CHOSEN_TITLE) | 0)) {
    target.setUInt32Value(PLAYER_CHOSEN_TITLE, 0);
    handler.pSendSysMessage(L.LANG_CURRENT_TITLE_RESET, handler.getNameLink(target));
  }
  return true;
}

/** @ac scripts/Commands/cs_titles.cpp AddSC_titles_commandscript */
export function AddSC_titles_commandscript(): void {
  registerCommandScript(GetCommands);
}
