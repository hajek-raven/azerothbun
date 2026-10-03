/** `cs_lookup.cpp`: `.lookup area|creature|event|faction|item|item set|map|object|quest|skill|spell|taxinode|teleport|title|player`. */
import { queryFields, type Fields } from "../../database/database.ts";
import { CharacterDatabase, LoginDatabase } from "../../database/DatabaseEnv.ts";
import { CHAR_SEL_CHAR_GUID_NAME_BY_ACC } from "../../gen/CharacterDatabase.gen.ts";
import { LOGIN_SEL_ACCOUNT_BY_IP, LOGIN_SEL_ACCOUNT_LIST_BY_EMAIL, LOGIN_SEL_ACCOUNT_LIST_BY_NAME } from "../../gen/LoginDatabase.gen.ts";
import { PLAYER_CHOSEN_TITLE } from "../../gen/UpdateFields.gen.ts";
import * as R from "../../game/Accounts/RBACDefines.ts";
import { sCharacterCache } from "../../game/Cache/CharacterCache.ts";
import type { ChatHandler } from "../../game/Chat/Chat.ts";
import { ChatCommand, Console, registerCommandScript, SubCommands, type ChatCommandTable } from "../../game/Chat/ChatCommands/ChatCommand.ts";
import { int32Arg, Optional, SpellInfoArg, stringArg } from "../../game/Chat/ChatCommands/ChatCommandArgs.ts";
import { Tail } from "../../game/Chat/ChatCommands/ChatCommandTags.ts";
import { ItemQualityColors } from "../../game/Chat/Hyperlinks.ts";
import {
  GetTalentSpellCost,
  sAreaTableStore,
  sCharTitlesStore,
  sFactionStore,
  sItemSetStore,
  sMapStore,
  sSkillLineStore,
  sTaxiNodesStore,
} from "../../game/DataStores/DBCStores.ts";
import type { Player } from "../../game/Entities/Player/Player.ts";
import { sGameEventMgr } from "../../game/Events/GameEventMgr.ts";
import { ObjectAccessor } from "../../game/Globals/ObjectAccessor.ts";
import { sObjectMgr } from "../../game/Globals/ObjectMgr.ts";
import * as L from "../../game/Miscellaneous/Language.ts";
import { sSpellMgr } from "../../game/Spells/SpellMgr.ts";
import { ServerConfig } from "../../game/world/world-config.ts";
import { sWorld } from "../../game/world/world.ts";
import { localeNames } from "../../common/Common.ts";
import { StringFormat } from "../../common/Utilities/StringFormat.ts";
import { utf8FitTo, utf8ToUpperOnlyLatin, wstrToLower } from "../../common/util.ts";
import { TOTAL_LOCALES } from "../../shared/SharedDefines.ts";
import { SPELL_EFFECT_LEARN_SPELL } from "../../spells/defines.ts";
import { isPassive, type SpellInfo } from "../../spells/spell-info.ts";
import { QUEST_STATUS_COMPLETE, QUEST_STATUS_INCOMPLETE, QUEST_STATUS_REWARDED } from "../../world/quests.ts";

const MAP_INSTANCE = 1;
const MAP_RAID = 2;
const MAP_BATTLEGROUND = 3;
const MAP_ARENA = 4;
/** `EnumUtils::ToTitle(Races)` / `(Classes)` */
const RACE_TITLES: Record<number, string> = { 1: "Human", 2: "Orc", 3: "Dwarf", 4: "Night Elf", 5: "Undead", 6: "Tauren", 7: "Gnome", 8: "Troll", 10: "Blood Elf", 11: "Draenei" };
const CLASS_TITLES: Record<number, string> = { 1: "Warrior", 2: "Paladin", 3: "Hunter", 4: "Rogue", 5: "Priest", 6: "Death Knight", 7: "Shaman", 8: "Mage", 9: "Warlock", 11: "Druid" };
const RACE_DRAENEI = 11;
const CLASS_DRUID = 11;

/** @ac scripts/Commands/cs_lookup.cpp lookup_commandscript::GetCommands */
function GetCommands(): ChatCommandTable {
  const lookupPlayerCommandTable: ChatCommandTable = [
    ChatCommand("ip", [Optional(Tail), Optional(int32Arg)], HandleLookupPlayerIpCommand, R.RBAC_PERM_COMMAND_LOOKUP_PLAYER_IP, Console.Yes),
    ChatCommand("account", [stringArg, Optional(int32Arg)], HandleLookupPlayerAccountCommand, R.RBAC_PERM_COMMAND_LOOKUP_PLAYER_ACCOUNT, Console.Yes),
    ChatCommand("email", [stringArg, Optional(int32Arg)], HandleLookupPlayerEmailCommand, R.RBAC_PERM_COMMAND_LOOKUP_PLAYER_EMAIL, Console.Yes),
  ];
  const lookupCommandTable: ChatCommandTable = [
    ChatCommand("area", [Tail], HandleLookupAreaCommand, R.RBAC_PERM_COMMAND_LOOKUP_AREA, Console.Yes),
    ChatCommand("creature", [Tail], HandleLookupCreatureCommand, R.RBAC_PERM_COMMAND_LOOKUP_CREATURE, Console.Yes),
    ChatCommand("event", [Tail], HandleLookupEventCommand, R.RBAC_PERM_COMMAND_LOOKUP_EVENT, Console.Yes),
    ChatCommand("faction", [Tail], HandleLookupFactionCommand, R.RBAC_PERM_COMMAND_LOOKUP_FACTION, Console.Yes),
    ChatCommand("item", [Tail], HandleLookupItemCommand, R.RBAC_PERM_COMMAND_LOOKUP_ITEM, Console.Yes),
    ChatCommand("item set", [Tail], HandleLookupItemSetCommand, R.RBAC_PERM_COMMAND_LOOKUP_ITEMSET, Console.Yes),
    ChatCommand("map", [Tail], HandleLookupMapCommand, R.RBAC_PERM_COMMAND_LOOKUP_MAP, Console.Yes),
    ChatCommand("object", [Tail], HandleLookupObjectCommand, R.RBAC_PERM_COMMAND_LOOKUP_OBJECT, Console.Yes),
    ChatCommand("gobject", [Tail], HandleLookupObjectCommand, R.RBAC_PERM_COMMAND_LOOKUP_OBJECT, Console.Yes),
    ChatCommand("quest", [Tail], HandleLookupQuestCommand, R.RBAC_PERM_COMMAND_LOOKUP_QUEST, Console.Yes),
    ChatCommand("skill", [Tail], HandleLookupSkillCommand, R.RBAC_PERM_COMMAND_LOOKUP_SKILL, Console.Yes),
    ChatCommand("taxinode", [Tail], HandleLookupTaxiNodeCommand, R.RBAC_PERM_COMMAND_LOOKUP_TAXINODE, Console.Yes),
    ChatCommand("teleport", [Tail], HandleLookupTeleCommand, R.RBAC_PERM_COMMAND_LOOKUP_TELE, Console.Yes),
    ChatCommand("title", [Tail], HandleLookupTitleCommand, R.RBAC_PERM_COMMAND_LOOKUP_TITLE, Console.Yes),
    ChatCommand("spell", [Tail], HandleLookupSpellCommand, R.RBAC_PERM_COMMAND_LOOKUP_SPELL, Console.Yes),
    ChatCommand("spell id", [SpellInfoArg], HandleLookupSpellIdCommand, R.RBAC_PERM_COMMAND_LOOKUP_SPELL_ID, Console.Yes),
    SubCommands("player", lookupPlayerCommandTable),
  ];
  return [SubCommands("lookup", lookupCommandTable)];
}

function maxResultsLookup(): number {
  return sWorld().getIntConfig(ServerConfig.CONFIG_MAX_RESULTS_LOOKUP_COMMANDS);
}

/**
 * The DBC name search every lookup shares: the session locale first, then every other locale. Returns the matching
 * locale and name, or null.
 */
function findLocalized(handler: ChatHandler, names: readonly (string | undefined)[], wNamePart: string): { locale: number; name: string } | null {
  const sessionLocale = handler.getSessionDbcLocale();
  const name = names[sessionLocale] ?? "";
  if (!name) return null;
  if (utf8FitTo(name, wNamePart)) return { locale: sessionLocale, name };
  for (let locale = 0; locale < TOTAL_LOCALES; ++locale) {
    if (locale === sessionLocale) continue;
    const other = names[locale] ?? "";
    if (!other) continue;
    if (utf8FitTo(other, wNamePart)) return { locale, name: other };
  }
  return null;
}

/** `maxResults && count++ == maxResults`: true (after `LANG_COMMAND_LOOKUP_MAX_RESULTS`) when the limit is hit. */
function limitHit(handler: ChatHandler, counter: { count: number }, maxResults: number): boolean {
  if (maxResults && counter.count++ === maxResults) {
    handler.pSendSysMessage(L.LANG_COMMAND_LOOKUP_MAX_RESULTS, maxResults);
    return true;
  }
  return false;
}

/** @ac scripts/Commands/cs_lookup.cpp lookup_commandscript::HandleLookupAreaCommand */
function HandleLookupAreaCommand(handler: ChatHandler, namePart: string): boolean {
  if (!namePart) return false;
  const wNamePart = wstrToLower(namePart);
  let found = false;
  const counter = { count: 0 };
  const maxResults = maxResultsLookup();
  // Search in AreaTable.dbc
  for (const areaEntry of sAreaTableStore) {
    const match = findLocalized(handler, areaEntry.area_name, wNamePart);
    if (!match) continue;
    if (limitHit(handler, counter, maxResults)) return true;
    // send area in "id - [name]" format
    const loc = localeNames[match.locale] ?? "";
    handler.sendSysMessage(handler.getSession() ? `${areaEntry.ID} - |cffffffff|Harea:${areaEntry.ID}|h[${match.name} ${loc}]|h|r` : `${areaEntry.ID} - ${match.name} ${loc}`);
    found = true;
  }
  if (!found) handler.sendSysMessage(L.LANG_COMMAND_NOAREAFOUND);
  return true;
}

/** @ac scripts/Commands/cs_lookup.cpp lookup_commandscript::HandleLookupCreatureCommand */
function HandleLookupCreatureCommand(handler: ChatHandler, namePart: string): boolean {
  if (!namePart) return false;
  const wNamePart = wstrToLower(namePart);
  let found = false;
  const counter = { count: 0 };
  const maxResults = maxResultsLookup();
  const localeIndex = handler.getSessionDbLocaleIndex();
  const send = (id: number, name: string): void => {
    if (handler.getSession()) handler.pSendSysMessage(L.LANG_CREATURE_ENTRY_LIST_CHAT, id, id, name);
    else handler.pSendSysMessage(L.LANG_CREATURE_ENTRY_LIST_CONSOLE, id, name);
    found = true;
  };
  for (const creatureTemplate of sObjectMgr.getCreatureTemplates().values()) {
    const id = creatureTemplate.entry;
    const localized = sObjectMgr.getCreatureLocale(id)?.Name[localeIndex];
    if (localized && utf8FitTo(localized, wNamePart)) {
      if (limitHit(handler, counter, maxResults)) return true;
      send(id, localized);
      continue;
    }
    const name = creatureTemplate.name;
    if (!name) continue;
    if (utf8FitTo(name, wNamePart)) {
      if (limitHit(handler, counter, maxResults)) return true;
      send(id, name);
    }
  }
  if (!found) handler.sendSysMessage(L.LANG_COMMAND_NOCREATUREFOUND);
  return true;
}

/** @ac scripts/Commands/cs_lookup.cpp lookup_commandscript::HandleLookupEventCommand */
function HandleLookupEventCommand(handler: ChatHandler, namePart: string): boolean {
  if (!namePart) return false;
  const wNamePart = wstrToLower(namePart);
  let found = false;
  const counter = { count: 0 };
  const maxResults = maxResultsLookup();
  const events = sGameEventMgr.GetEventMap();
  const activeEvents = sGameEventMgr.GetActiveEventList();
  for (let id = 0; id < events.length; ++id) {
    const descr = events[id]?.description ?? "";
    if (!descr) continue;
    if (utf8FitTo(descr, wNamePart)) {
      if (limitHit(handler, counter, maxResults)) return true;
      const active = activeEvents.has(id) ? handler.getAcoreString(L.LANG_ACTIVE) : "";
      if (handler.getSession()) handler.pSendSysMessage(L.LANG_EVENT_ENTRY_LIST_CHAT, id, id, descr, active);
      else handler.pSendSysMessage(L.LANG_EVENT_ENTRY_LIST_CONSOLE, id, descr, active);
      found = true;
    }
  }
  if (!found) handler.sendSysMessage(L.LANG_NOEVENTFOUND);
  return true;
}

/** @ac game/Reputation/ReputationMgr.cpp ReputationMgr::ReputationToRank */
function ReputationToRank(standing: number): number {
  const PointsInRank = [36000, 3000, 3000, 3000, 6000, 12000, 21000, 1000];
  let limit = 42999 + 1;
  for (let i = PointsInRank.length - 1; i >= 0; --i) {
    limit -= PointsInRank[i]!;
    if (standing >= limit) return i;
  }
  return 0;
}

/** @ac scripts/Commands/cs_lookup.cpp lookup_commandscript::HandleLookupFactionCommand */
function HandleLookupFactionCommand(handler: ChatHandler, namePart: string): boolean {
  if (!namePart) return false;
  // Can be nullptr at console call
  const target = handler.getSelectedPlayer();
  const wNamePart = wstrToLower(namePart);
  let found = false;
  const counter = { count: 0 };
  const maxResults = maxResultsLookup();
  for (const factionEntry of sFactionStore) {
    const factionState = target?.getSession().kit?.factions.find((row) => row.faction === factionEntry.ID) ?? null;
    const match = findLocalized(handler, factionEntry.name, wNamePart);
    if (!match) continue;
    if (limitHit(handler, counter, maxResults)) return true;
    const loc = localeNames[match.locale] ?? "";
    // send faction in "id - [faction] rank reputation [visible] [at war] [own team] [unknown] [invisible] [inactive]" format
    let ss = handler.getSession() ? `${factionEntry.ID} - |cffffffff|Hfaction:${factionEntry.ID}|h[${match.name} ${loc}]|h|r` : `${factionEntry.ID} - ${match.name} ${loc}`;
    if (factionState && target) {
      const reputation = target.getReputationOf(factionEntry.ID);
      const ranks = [L.LANG_REP_HATED, L.LANG_REP_HOSTILE, L.LANG_REP_UNFRIENDLY, L.LANG_REP_NEUTRAL, L.LANG_REP_FRIENDLY, L.LANG_REP_HONORED, L.LANG_REP_REVERED, L.LANG_REP_EXALTED];
      ss += ` ${handler.getAcoreString(ranks[ReputationToRank(reputation)]!)}|h|r (${reputation})`;
      const flags = factionState.flags;
      if (flags & 0x01) ss += handler.getAcoreString(L.LANG_FACTION_VISIBLE);
      if (flags & 0x02) ss += handler.getAcoreString(L.LANG_FACTION_ATWAR);
      if (flags & 0x10) ss += handler.getAcoreString(L.LANG_FACTION_PEACE_FORCED);
      if (flags & 0x04) ss += handler.getAcoreString(L.LANG_FACTION_HIDDEN);
      if (flags & 0x08) ss += handler.getAcoreString(L.LANG_FACTION_INVISIBLE_FORCED);
      if (flags & 0x20) ss += handler.getAcoreString(L.LANG_FACTION_INACTIVE);
    } else {
      ss += handler.getAcoreString(L.LANG_FACTION_NOREPUTATION);
    }
    handler.sendSysMessage(ss);
    found = true;
  }
  if (!found) handler.sendSysMessage(L.LANG_COMMAND_FACTION_NOTFOUND);
  return true;
}

/** @ac scripts/Commands/cs_lookup.cpp lookup_commandscript::HandleLookupItemCommand */
function HandleLookupItemCommand(handler: ChatHandler, namePart: string): boolean {
  if (!namePart) return false;
  const wNamePart = wstrToLower(namePart);
  let found = false;
  const counter = { count: 0 };
  const maxResults = maxResultsLookup();
  const localeIndex = handler.getSessionDbLocaleIndex();
  const send = (itemId: number, quality: number, name: string): void => {
    if (handler.getSession()) handler.pSendSysMessage(L.LANG_ITEM_LIST_CHAT, itemId, (ItemQualityColors[quality] ?? 0).toString(16), itemId, name);
    else handler.pSendSysMessage(L.LANG_ITEM_LIST_CONSOLE, itemId, name);
    found = true;
  };
  // Search in `item_template`
  for (const itemTemplate of sObjectMgr.getItemTemplateStore().values()) {
    const localized = localeIndex >= 0 ? sObjectMgr.getItemLocale(itemTemplate.entry)?.Name[localeIndex] : undefined;
    if (localized && utf8FitTo(localized, wNamePart)) {
      if (limitHit(handler, counter, maxResults)) return true;
      send(itemTemplate.entry, itemTemplate.quality, localized);
      continue;
    }
    const name = itemTemplate.name;
    if (!name) continue;
    if (utf8FitTo(name, wNamePart)) {
      if (limitHit(handler, counter, maxResults)) return true;
      send(itemTemplate.entry, itemTemplate.quality, name);
    }
  }
  if (!found) handler.sendSysMessage(L.LANG_COMMAND_NOITEMFOUND);
  return true;
}

/** @ac scripts/Commands/cs_lookup.cpp lookup_commandscript::HandleLookupItemSetCommand */
function HandleLookupItemSetCommand(handler: ChatHandler, namePart: string): boolean {
  if (!namePart) return false;
  const wNamePart = wstrToLower(namePart);
  let found = false;
  const counter = { count: 0 };
  const maxResults = maxResultsLookup();
  // Search in ItemSet.dbc
  for (let id = 0; id < sItemSetStore.getNumRows(); id++) {
    const set = sItemSetStore.lookupEntry(id);
    if (!set) continue;
    const match = findLocalized(handler, set.name, wNamePart);
    if (!match) continue;
    if (limitHit(handler, counter, maxResults)) return true;
    // send item set in "id - [namedlink locale]" format
    const loc = localeNames[match.locale] ?? "";
    if (handler.getSession()) handler.pSendSysMessage(L.LANG_ITEMSET_LIST_CHAT, id, id, match.name, loc);
    else handler.pSendSysMessage(L.LANG_ITEMSET_LIST_CONSOLE, id, match.name, loc);
    found = true;
  }
  if (!found) handler.sendSysMessage(L.LANG_COMMAND_NOITEMSETFOUND);
  return true;
}

/** @ac scripts/Commands/cs_lookup.cpp lookup_commandscript::HandleLookupObjectCommand */
function HandleLookupObjectCommand(handler: ChatHandler, namePart: string): boolean {
  if (!namePart) return false;
  const wNamePart = wstrToLower(namePart);
  let found = false;
  const counter = { count: 0 };
  const maxResults = maxResultsLookup();
  const localeIndex = handler.getSessionDbLocaleIndex();
  const send = (entry: number, name: string): void => {
    if (handler.getSession()) handler.pSendSysMessage(L.LANG_GO_ENTRY_LIST_CHAT, entry, entry, name);
    else handler.pSendSysMessage(L.LANG_GO_ENTRY_LIST_CONSOLE, entry, name);
    found = true;
  };
  for (const gameObjectTemplate of sObjectMgr.getGameObjectTemplates().values()) {
    const localized = sObjectMgr.getGameObjectLocale(gameObjectTemplate.entry)?.Name[localeIndex];
    if (localized && utf8FitTo(localized, wNamePart)) {
      if (limitHit(handler, counter, maxResults)) return true;
      send(gameObjectTemplate.entry, localized);
      continue;
    }
    const name = gameObjectTemplate.name;
    if (!name) continue;
    if (utf8FitTo(name, wNamePart)) {
      if (limitHit(handler, counter, maxResults)) return true;
      send(gameObjectTemplate.entry, name);
    }
  }
  if (!found) handler.sendSysMessage(L.LANG_COMMAND_NOGAMEOBJECTFOUND);
  return true;
}

/** The `.lookup quest` status suffix for the selected player. */
function questStatusStr(handler: ChatHandler, target: Player | null, questId: number): string {
  if (!target) return "";
  switch (target.getQuestStatus(questId)) {
    case QUEST_STATUS_COMPLETE:
      return handler.getAcoreString(L.LANG_COMPLETE);
    case QUEST_STATUS_INCOMPLETE:
      return handler.getAcoreString(L.LANG_ACTIVE);
    case QUEST_STATUS_REWARDED:
      return handler.getAcoreString(L.LANG_REWARDED);
    default:
      return "";
  }
}

/** @ac scripts/Commands/cs_lookup.cpp lookup_commandscript::HandleLookupQuestCommand */
function HandleLookupQuestCommand(handler: ChatHandler, namePart: string): boolean {
  if (!namePart) return false;
  // can be nullptr at console call
  const target = handler.getSelectedPlayer();
  const wNamePart = wstrToLower(namePart);
  let found = false;
  const counter = { count: 0 };
  const maxResults = maxResultsLookup();
  const localeIndex = handler.getSessionDbLocaleIndex();
  const send = (id: number, level: number, title: string): void => {
    const statusStr = questStatusStr(handler, target, id);
    if (handler.getSession()) handler.pSendSysMessage(L.LANG_QUEST_LIST_CHAT, id, id, level, title, statusStr);
    else handler.pSendSysMessage(L.LANG_QUEST_LIST_CONSOLE, id, title, statusStr);
    found = true;
  };
  for (const qInfo of sObjectMgr.getQuestTemplates().values()) {
    const localized = localeIndex >= 0 ? sObjectMgr.getQuestLocale(qInfo.id)?.Title[localeIndex] : undefined;
    if (localized && utf8FitTo(localized, wNamePart)) {
      if (limitHit(handler, counter, maxResults)) return true;
      send(qInfo.id, qInfo.questLevel, localized);
      continue;
    }
    const title = qInfo.logTitle;
    if (!title) continue;
    if (utf8FitTo(title, wNamePart)) {
      if (limitHit(handler, counter, maxResults)) return true;
      send(qInfo.id, qInfo.questLevel, title);
    }
  }
  if (!found) handler.sendSysMessage(L.LANG_COMMAND_NOQUESTFOUND);
  return true;
}

/** @ac scripts/Commands/cs_lookup.cpp lookup_commandscript::HandleLookupSkillCommand */
function HandleLookupSkillCommand(handler: ChatHandler, namePart: string): boolean {
  if (!namePart) return false;
  // can be nullptr in console call
  const target = handler.getSelectedPlayer();
  const wNamePart = wstrToLower(namePart);
  let found = false;
  const counter = { count: 0 };
  const maxResults = maxResultsLookup();
  // Search in SkillLine.dbc
  for (const skillInfo of sSkillLineStore) {
    const match = findLocalized(handler, skillInfo.name, wNamePart);
    if (!match) continue;
    if (limitHit(handler, counter, maxResults)) return true;
    let valStr = "";
    let knownStr = "";
    if (target && target.hasSkill(skillInfo.id)) {
      knownStr = handler.getAcoreString(L.LANG_KNOWN);
      valStr = StringFormat(
        handler.getAcoreString(L.LANG_SKILL_VALUES),
        target.getPureSkillValue(skillInfo.id),
        target.getPureMaxSkillValue(skillInfo.id),
        target.getSkillPermBonusValue(skillInfo.id),
        target.getSkillTempBonusValue(skillInfo.id),
      );
    }
    // send skill in "id - [namedlink locale]" format
    const loc = localeNames[match.locale] ?? "";
    if (handler.getSession()) handler.pSendSysMessage(L.LANG_SKILL_LIST_CHAT, skillInfo.id, skillInfo.id, match.name, loc, knownStr, valStr);
    else handler.pSendSysMessage(L.LANG_SKILL_LIST_CONSOLE, skillInfo.id, match.name, loc, knownStr, valStr);
    found = true;
  }
  if (!found) handler.sendSysMessage(L.LANG_COMMAND_NOSKILLFOUND);
  return true;
}

/** `SpellInfo::SpellName[locale]`: `SpellStore` keeps the enUS name only. */
function spellNames(info: SpellInfo): string[] {
  return [info.name];
}

/** `SpellInfo::GetRank` (1 for a spell without a chain) */
function spellRank(spellId: number): number {
  return sSpellMgr.getSpellRank(spellId) || 1;
}

/** The `.lookup spell` / `.lookup spell id` line for one spell. */
function spellLine(handler: ChatHandler, target: Player | null, spellInfo: SpellInfo, name: string, locale: number): string {
  const id = spellInfo.id;
  const known = target !== null && target.hasSpell(id);
  const firstEffect = spellInfo.effects[0];
  const learn = firstEffect?.effect === SPELL_EFFECT_LEARN_SPELL;
  const learnSpellInfo = firstEffect ? sSpellMgr.getSpellInfo(firstEffect.triggerSpell) : null;
  const talentCost = GetTalentSpellCost(id);
  const talent = talentCost > 0;
  const passive = isPassive(spellInfo);
  const active = target !== null && target.hasAura(id);
  // find rank of learned spell for learning spell, or talent rank
  const rank = talentCost ? talentCost : learn && learnSpellInfo ? spellRank(learnSpellInfo.id) : spellRank(id);
  // send spell in "id - [name, rank N] [talent] [passive] [learn] [known]" format
  let ss = handler.getSession() ? `${id} - |cffffffff|Hspell:${id}|h[${name}` : `${id} - ${name}`;
  // include rank in link name
  if (rank) ss += `${handler.getAcoreString(L.LANG_SPELL_RANK)}${rank}`;
  ss += handler.getSession() ? ` ${localeNames[locale] ?? ""}]|h|r` : ` ${localeNames[locale] ?? ""}`;
  if (talent) ss += handler.getAcoreString(L.LANG_TALENT);
  if (passive) ss += handler.getAcoreString(L.LANG_PASSIVE);
  if (learn) ss += handler.getAcoreString(L.LANG_LEARN);
  if (known) ss += handler.getAcoreString(L.LANG_KNOWN);
  if (active) ss += handler.getAcoreString(L.LANG_ACTIVE);
  return ss;
}

/** @ac scripts/Commands/cs_lookup.cpp lookup_commandscript::HandleLookupSpellCommand */
function HandleLookupSpellCommand(handler: ChatHandler, namePart: string): boolean {
  if (!namePart) return false;
  // can be nullptr at console call
  const target = handler.getSelectedPlayer();
  const wNamePart = wstrToLower(namePart);
  let found = false;
  const counter = { count: 0 };
  const maxResults = maxResultsLookup();
  // Search in Spell.dbc
  for (const id of sSpellMgr.spellIds()) {
    const spellInfo = sSpellMgr.getSpellInfo(id);
    if (!spellInfo) continue;
    const match = findLocalized(handler, spellNames(spellInfo), wNamePart);
    if (!match) continue;
    if (limitHit(handler, counter, maxResults)) return true;
    handler.sendSysMessage(spellLine(handler, target, spellInfo, match.name, match.locale));
    found = true;
  }
  if (!found) handler.sendSysMessage(L.LANG_COMMAND_NOSPELLFOUND);
  return true;
}

/** @ac scripts/Commands/cs_lookup.cpp lookup_commandscript::HandleLookupSpellIdCommand */
function HandleLookupSpellIdCommand(handler: ChatHandler, spell: SpellInfo): boolean {
  // can be nullptr at console call
  const target = handler.getSelectedPlayer();
  if (!sSpellMgr.isSpellValid(spell)) {
    handler.sendErrorMessage(L.LANG_COMMAND_SPELL_BROKEN, spell.id);
    return false;
  }
  const locale = handler.getSessionDbcLocale();
  const name = spellNames(spell)[locale] ?? "";
  if (!name) {
    handler.sendSysMessage(L.LANG_COMMAND_NOSPELLFOUND);
    return true;
  }
  handler.sendSysMessage(spellLine(handler, target, spell, name, locale));
  return true;
}

/** @ac scripts/Commands/cs_lookup.cpp lookup_commandscript::HandleLookupTaxiNodeCommand */
function HandleLookupTaxiNodeCommand(handler: ChatHandler, namePart: string): boolean {
  if (!namePart) return false;
  const wNamePart = wstrToLower(namePart);
  let found = false;
  const counter = { count: 0 };
  const maxResults = maxResultsLookup();
  // Search in TaxiNodes.dbc
  for (const nodeEntry of sTaxiNodesStore) {
    const match = findLocalized(handler, nodeEntry.name, wNamePart);
    if (!match) continue;
    if (limitHit(handler, counter, maxResults)) return true;
    // send taxinode in "id - [name] (Map:m X:x Y:y Z:z)" format
    const loc = localeNames[match.locale] ?? "";
    if (handler.getSession()) handler.pSendSysMessage(L.LANG_TAXINODE_ENTRY_LIST_CHAT, nodeEntry.ID, nodeEntry.ID, match.name, loc, nodeEntry.map_id, nodeEntry.x, nodeEntry.y, nodeEntry.z);
    else handler.pSendSysMessage(L.LANG_TAXINODE_ENTRY_LIST_CONSOLE, nodeEntry.ID, match.name, loc, nodeEntry.map_id, nodeEntry.x, nodeEntry.y, nodeEntry.z);
    found = true;
  }
  if (!found) handler.sendSysMessage(L.LANG_COMMAND_NOTAXINODEFOUND);
  return true;
}

/** @ac scripts/Commands/cs_lookup.cpp lookup_commandscript::HandleLookupTeleCommand */
function HandleLookupTeleCommand(handler: ChatHandler, namePart: string): boolean {
  if (!namePart) return false;
  const wNamePart = wstrToLower(namePart);
  let reply = "";
  let count = 0;
  const maxResults = maxResultsLookup();
  let limitReached = false;
  for (const [id, tele] of sObjectMgr.getGameTeleMap()) {
    if (!tele.wnameLow.includes(wNamePart)) continue;
    if (maxResults && count++ === maxResults) {
      limitReached = true;
      break;
    }
    reply += handler.getSession() ? `  |cffffffff|Htele:${id}|h[${tele.name}]|h|r\n` : `  ${id} ${tele.name}\n`;
  }
  if (!reply) handler.sendSysMessage(L.LANG_COMMAND_TELE_NOLOCATION);
  else handler.pSendSysMessage(L.LANG_COMMAND_TELE_LOCATION, reply);
  if (limitReached) handler.pSendSysMessage(L.LANG_COMMAND_LOOKUP_MAX_RESULTS, maxResults);
  return true;
}

/** @ac scripts/Commands/cs_lookup.cpp lookup_commandscript::HandleLookupTitleCommand */
function HandleLookupTitleCommand(handler: ChatHandler, namePart: string): boolean {
  if (!namePart) return false;
  // can be nullptr in console call
  const target = handler.getSelectedPlayer();
  // title name have single string arg for player name
  const targetName = target ? target.getName() : "NAME";
  const wNamePart = wstrToLower(namePart);
  let counter = 0; // Counter for figure out that we found smth.
  const maxResults = maxResultsLookup();
  // Search in CharTitles.dbc
  for (const titleInfo of sCharTitlesStore) {
    const match = findLocalized(handler, titleInfo.nameMale, wNamePart);
    if (!match) continue;
    if (maxResults && counter === maxResults) {
      handler.pSendSysMessage(L.LANG_COMMAND_LOOKUP_MAX_RESULTS, maxResults);
      return true;
    }
    const knownStr = target && target.hasTitle(titleInfo.bit_index) ? handler.getAcoreString(L.LANG_KNOWN) : "";
    const activeStr = target && target.getUInt32Value(PLAYER_CHOSEN_TITLE) === titleInfo.bit_index ? handler.getAcoreString(L.LANG_ACTIVE) : "";
    const titleNameStr = StringFormat(match.name, targetName);
    // send title in "id (idx:idx) - [namedlink locale]" format
    const loc = localeNames[match.locale] ?? "";
    if (handler.getSession()) handler.pSendSysMessage(L.LANG_TITLE_LIST_CHAT, titleInfo.ID, titleInfo.bit_index, titleInfo.ID, titleNameStr, loc, knownStr, activeStr);
    else handler.pSendSysMessage(L.LANG_TITLE_LIST_CONSOLE, titleInfo.ID, titleInfo.bit_index, titleNameStr, loc, knownStr, activeStr);
    ++counter;
  }
  // if counter == 0 then we found nth
  if (!counter) handler.sendSysMessage(L.LANG_COMMAND_NOTITLEFOUND);
  return true;
}

/** @ac scripts/Commands/cs_lookup.cpp lookup_commandscript::HandleLookupMapCommand */
function HandleLookupMapCommand(handler: ChatHandler, namePart: string): boolean {
  if (!namePart) return false;
  const wNamePart = wstrToLower(namePart);
  let counter = 0;
  const maxResults = maxResultsLookup();
  const locale = handler.getSessionDbcLocale();
  // search in Map.dbc
  for (const mapInfo of sMapStore) {
    const name = mapInfo.name[locale] ?? "";
    if (!name) continue;
    if (utf8FitTo(name, wNamePart) && locale < TOTAL_LOCALES) {
      if (maxResults && counter === maxResults) {
        handler.pSendSysMessage(L.LANG_COMMAND_LOOKUP_MAX_RESULTS, maxResults);
        return true;
      }
      let ss = `${mapInfo.MapID} - [${name}]`;
      // MapEntry::IsContinent
      if (mapInfo.MapID === 0 || mapInfo.MapID === 1 || mapInfo.MapID === 530 || mapInfo.MapID === 571) ss += handler.getAcoreString(L.LANG_CONTINENT);
      switch (mapInfo.map_type) {
        case MAP_INSTANCE:
          ss += handler.getAcoreString(L.LANG_INSTANCE);
          break;
        case MAP_RAID:
          ss += handler.getAcoreString(L.LANG_RAID);
          break;
        case MAP_BATTLEGROUND:
          ss += handler.getAcoreString(L.LANG_BATTLEGROUND);
          break;
        case MAP_ARENA:
          ss += handler.getAcoreString(L.LANG_ARENA);
          break;
      }
      handler.sendSysMessage(ss);
      ++counter;
    }
  }
  if (!counter) handler.sendSysMessage(L.LANG_COMMAND_NOMAPFOUND);
  return true;
}

/** @ac scripts/Commands/cs_lookup.cpp lookup_commandscript::HandleLookupPlayerIpCommand */
async function HandleLookupPlayerIpCommand(handler: ChatHandler, ipArg: string | null, limit: number | null): Promise<boolean> {
  const target = handler.getSelectedPlayerOrSelf();
  let ip = ipArg;
  if (!ip) {
    // nullptr only if used from console
    if (!target || target === handler.getSession()?.getPlayer()) return false;
    ip = target.getSession().getRemoteAddress();
  }
  const result = await queryFields(LoginDatabase(), LOGIN_SEL_ACCOUNT_BY_IP, ip);
  return LookupPlayerSearchCommand(result, limit ? limit : -1, handler);
}

/** @ac scripts/Commands/cs_lookup.cpp lookup_commandscript::HandleLookupPlayerAccountCommand */
async function HandleLookupPlayerAccountCommand(handler: ChatHandler, accountArg: string, limit: number | null): Promise<boolean> {
  const account = utf8ToUpperOnlyLatin(accountArg);
  if (!account) return false;
  const result = await queryFields(LoginDatabase(), LOGIN_SEL_ACCOUNT_LIST_BY_NAME, account);
  return LookupPlayerSearchCommand(result, limit ? limit : -1, handler);
}

/** @ac scripts/Commands/cs_lookup.cpp lookup_commandscript::HandleLookupPlayerEmailCommand */
async function HandleLookupPlayerEmailCommand(handler: ChatHandler, email: string, limit: number | null): Promise<boolean> {
  const result = await queryFields(LoginDatabase(), LOGIN_SEL_ACCOUNT_LIST_BY_EMAIL, email);
  return LookupPlayerSearchCommand(result, limit ? limit : -1, handler);
}

/** @ac scripts/Commands/cs_lookup.cpp lookup_commandscript::LookupPlayerSearchCommand */
async function LookupPlayerSearchCommand(result: Fields[], limit: number, handler: ChatHandler): Promise<boolean> {
  if (result.length === 0) {
    handler.sendErrorMessage(L.LANG_NO_PLAYERS_FOUND);
    return false;
  }
  let counter = 0;
  let count = 0;
  const maxResults = maxResultsLookup();
  for (const fields of result) {
    if (maxResults && count++ === maxResults) {
      handler.pSendSysMessage(L.LANG_COMMAND_LOOKUP_MAX_RESULTS, maxResults);
      return true;
    }
    const accountId = Number(fields[0]);
    const accountName = String(fields[1] ?? "");
    const result2 = await queryFields(CharacterDatabase(), CHAR_SEL_CHAR_GUID_NAME_BY_ACC, accountId);
    if (result2.length === 0) continue;
    handler.pSendSysMessage(L.LANG_LOOKUP_PLAYER_ACCOUNT, accountName, accountId);
    for (const characterFields of result2) {
      const guid = Number(characterFields[0]);
      const name = String(characterFields[1] ?? "");
      const online = ObjectAccessor.FindPlayerByLowGUID(guid) !== null;
      const gpd = sCharacterCache.getCharacterCacheByName(name);
      const plevel = gpd?.Level ?? 0;
      const prace = gpd?.Race ?? 0;
      const pclass = gpd?.Class ?? 0;
      if (plevel > 0 && prace > 0 && prace <= RACE_DRAENEI && pclass > 0 && pclass <= CLASS_DRUID) {
        handler.pSendSysMessage("  {} (GUID {}) - {} - {} - {}{}", name, guid, RACE_TITLES[prace] ?? "", CLASS_TITLES[pclass] ?? "", plevel, online ? " - [ONLINE]" : "");
      } else {
        handler.pSendSysMessage(L.LANG_LOOKUP_PLAYER_CHARACTER, name, guid);
      }
      ++counter;
      if (!(limit === -1 || counter < limit)) break;
    }
  }
  // empty accounts only
  if (!counter) {
    handler.sendErrorMessage(L.LANG_NO_PLAYERS_FOUND);
    return false;
  }
  return true;
}

/** @ac scripts/Commands/cs_lookup.cpp AddSC_lookup_commandscript */
export function AddSC_lookup_commandscript(): void {
  registerCommandScript(GetCommands);
}
