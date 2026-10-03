/** `cs_list.cpp`: `.list creature|item|object|auras|respawns`. */
import { queryFields } from "../../database/database.ts";
import { CharacterDatabase } from "../../database/DatabaseEnv.ts";
import { creature, creature_multispawn, gameobject } from "../../database/schema/world.ts";
import * as C from "../../gen/CharacterDatabase.gen.ts";
import * as R from "../../game/Accounts/RBACDefines.ts";
import { guidString, type ChatHandler } from "../../game/Chat/Chat.ts";
import { ChatCommand, Console, registerCommandScript, SubCommands, type ChatCommandTable } from "../../game/Chat/ChatCommands/ChatCommand.ts";
import { Optional, uint32Arg } from "../../game/Chat/ChatCommands/ChatCommandArgs.ts";
import { Hyperlink, HyperlinkOrUint32, Variant, WTail, type VariantValue } from "../../game/Chat/ChatCommands/ChatCommandTags.ts";
import { creature_entry, gameobject_entry, item, type ItemLinkData } from "../../game/Chat/Hyperlinks.ts";
import { GetTalentSpellCost } from "../../game/DataStores/DBCStores.ts";
import type { CommandCreature } from "../../game/Entities/Player/Player.ts";
import { ObjectAccessor } from "../../game/Globals/ObjectAccessor.ts";
import { sObjectMgr } from "../../game/Globals/ObjectMgr.ts";
import * as L from "../../game/Miscellaneous/Language.ts";
import { utf8FitTo, wstrToLower } from "../../common/util.ts";
import { isBankPos, isEquipmentPos, isInventoryPos } from "../../items/bags.ts";
import { isPassive, type SpellInfo } from "../../spells/spell-info.ts";
import { gameObjectGuid } from "../../world/spawn.ts";

const TOTAL_AURAS = 317;

/** @ac scripts/Commands/cs_list.cpp list_commandscript::GetCommands */
function GetCommands(): ChatCommandTable {
  const listAurasCommandTable: ChatCommandTable = [
    ChatCommand("", [], HandleListAllAurasCommand, R.RBAC_PERM_COMMAND_LIST_AURAS, Console.No),
    ChatCommand("id", [uint32Arg], HandleListAurasByIdCommand, R.RBAC_PERM_COMMAND_LIST_AURAS, Console.No),
    ChatCommand("name", [WTail], HandleListAurasByNameCommand, R.RBAC_PERM_COMMAND_LIST_AURAS, Console.No),
  ];
  const listCommandTable: ChatCommandTable = [
    ChatCommand("creature", [HyperlinkOrUint32(creature_entry), Optional(uint32Arg)], HandleListCreatureCommand, R.RBAC_PERM_COMMAND_LIST_CREATURE, Console.Yes),
    ChatCommand("item", [Variant(Hyperlink(item), uint32Arg), Optional(uint32Arg)], HandleListItemCommand, R.RBAC_PERM_COMMAND_LIST_ITEM, Console.Yes),
    ChatCommand("object", [HyperlinkOrUint32(gameobject_entry), Optional(uint32Arg)], HandleListObjectCommand, R.RBAC_PERM_COMMAND_LIST_OBJECT, Console.Yes),
    SubCommands("auras", listAurasCommandTable),
    ChatCommand("respawns", [Optional(uint32Arg), Optional(uint32Arg), Optional(uint32Arg)], HandleListRespawnsCommand, R.RBAC_PERM_COMMAND_LIST_RESPAWNS, Console.Yes),
  ];
  return [SubCommands("list", listCommandTable)];
}

/** The live creatures of a map (`Map::GetCreatureBySpawnIdStore`): the command user's map, or a base map with a player on it. */
function mapCreatures(handler: ChatHandler, mapId: number): CommandCreature[] | null {
  const own = handler.getSession()?.getPlayer();
  if (own) return own.getMapCreatures();
  const onMap = ObjectAccessor.GetPlayers().find((player) => player.getMapId() === mapId);
  return onMap ? onMap.getMapCreatures() : null;
}

/** Spawns sorted by distance to the command user (`ORDER BY order_`), or in table order from the console, then `LIMIT count`. */
function nearest<T extends { position_x: number; position_y: number; position_z: number }>(handler: ChatHandler, rows: readonly T[], count: number): T[] {
  const player = handler.getSession()?.getPlayer();
  if (!player) return rows.slice(0, count);
  const order = (row: T): number => (row.position_x - player.getPositionX()) ** 2 + (row.position_y - player.getPositionY()) ** 2 + (row.position_z - player.getPositionZ()) ** 2;
  return [...rows].sort((a, b) => order(a) - order(b)).slice(0, count);
}

/** @ac scripts/Commands/cs_list.cpp list_commandscript::HandleListCreatureCommand */
function HandleListCreatureCommand(handler: ChatHandler, creatureId: number, countArg: number | null): boolean {
  const cInfo = sObjectMgr.getCreatureTemplate(creatureId);
  if (!cInfo) {
    handler.sendErrorMessage(L.LANG_COMMAND_INVALIDCREATUREID, creatureId);
    return false;
  }
  const count = countArg ?? 10;
  if (count === 0) return false;
  const tables = sObjectMgr.worldTables();
  const multispawn = new Set((tables?.where(creature_multispawn, "entry", creatureId) ?? []).map((row) => row.spawnId));
  const rows = (tables?.all(creature) ?? []).filter((row) => row.id === creatureId || multispawn.has(row.guid));
  const creatureCount = rows.length;
  for (const row of nearest(handler, rows, count)) {
    const guid = row.guid;
    const x = row.position_x;
    const y = row.position_y;
    const z = row.position_z;
    const mapId = row.map;
    // Get map (only support base map from console); if map found, try to find active version of this creature
    const live = mapCreatures(handler, mapId)?.find((unit) => unit.getSpawnId() === guid) ?? null;
    const liveGuid = live ? guidString(live.getGUID()) : "";
    const alive = live ? (live.isAlive() ? "*" : " ") : "";
    if (handler.getSession()) handler.pSendSysMessage(L.LANG_CREATURE_LIST_CHAT, guid, cInfo.entry, guid, cInfo.name, x, y, z, mapId, liveGuid, alive);
    else handler.pSendSysMessage(L.LANG_CREATURE_LIST_CONSOLE, guid, cInfo.name, x, y, z, mapId, liveGuid, alive);
  }
  handler.pSendSysMessage(L.LANG_COMMAND_LISTCREATUREMESSAGE, creatureId, creatureCount);
  return true;
}

/** @ac scripts/Commands/cs_list.cpp list_commandscript::HandleListItemCommand */
async function HandleListItemCommand(handler: ChatHandler, itemArg: VariantValue<ItemLinkData | number>, countArg: number | null): Promise<boolean> {
  const itemId = itemArg.index === 0 ? (itemArg.value as ItemLinkData).Item.entry : (itemArg.value as number);
  let count = countArg ?? 10;
  if (!count || !itemId) return false;
  const db = CharacterDatabase();

  // inventory case
  const inventoryCount = Number((await queryFields(db, C.CHAR_SEL_CHAR_INVENTORY_COUNT_ITEM, itemId))[0]?.[0] ?? 0);
  let result = await queryFields(db, C.CHAR_SEL_CHAR_INVENTORY_ITEM_BY_ENTRY, itemId, count);
  for (const fields of result) {
    // `cb.slot AS bag`: the bag's slot, or NULL (read as 0) for the player's own slots, as AzerothCore reads it.
    const bag = Number(fields[1] ?? 0);
    const itemSlot = Number(fields[2]);
    const itemPos = isEquipmentPos(bag, itemSlot) ? "[equipped]" : isInventoryPos(bag, itemSlot) ? "[in inventory]" : isBankPos(bag, itemSlot) ? "[in bank]" : "";
    handler.pSendSysMessage(L.LANG_ITEMLIST_SLOT, Number(fields[0]), String(fields[5] ?? ""), Number(fields[3]), Number(fields[4]), itemPos);
  }
  count = count > result.length ? count - result.length : 0;

  // mail case
  const mailCount = Number((await queryFields(db, C.CHAR_SEL_MAIL_COUNT_ITEM, itemId))[0]?.[0] ?? 0);
  result = count > 0 ? await queryFields(db, C.CHAR_SEL_MAIL_ITEMS_BY_ENTRY, itemId, count) : [];
  for (const fields of result) {
    handler.pSendSysMessage(L.LANG_ITEMLIST_MAIL, Number(fields[0]), String(fields[4] ?? ""), Number(fields[1]), Number(fields[3]), String(fields[6] ?? ""), Number(fields[2]), Number(fields[5]), "[in mail]");
  }
  count = count > result.length ? count - result.length : 0;

  // auction case
  const auctionCount = Number((await queryFields(db, C.CHAR_SEL_AUCTIONHOUSE_COUNT_ITEM, itemId))[0]?.[0] ?? 0);
  result = count > 0 ? await queryFields(db, C.CHAR_SEL_AUCTIONHOUSE_ITEM_BY_ENTRY, itemId, count) : [];
  for (const fields of result) {
    handler.pSendSysMessage(L.LANG_ITEMLIST_AUCTION, Number(fields[0]), String(fields[3] ?? ""), Number(fields[1]), Number(fields[2]), "[in auction]");
  }

  // guild bank case
  const guildCount = Number((await queryFields(db, C.CHAR_SEL_GUILD_BANK_COUNT_ITEM, itemId))[0]?.[0] ?? 0);
  result = await queryFields(db, C.CHAR_SEL_GUILD_BANK_ITEM_BY_ENTRY, itemId, count);
  for (const fields of result) {
    handler.pSendSysMessage(L.LANG_ITEMLIST_GUILD, Number(fields[0]), String(fields[2] ?? ""), Number(fields[1]), "[in guild bank]");
  }

  if (inventoryCount + mailCount + auctionCount + guildCount === 0) {
    handler.sendErrorMessage(L.LANG_COMMAND_NOITEMFOUND);
    return false;
  }
  handler.pSendSysMessage(L.LANG_COMMAND_LISTITEMMESSAGE, itemId, inventoryCount + mailCount + auctionCount + guildCount, inventoryCount, mailCount, auctionCount, guildCount);
  return true;
}

/** @ac scripts/Commands/cs_list.cpp list_commandscript::HandleListObjectCommand */
function HandleListObjectCommand(handler: ChatHandler, gameObjectId: number, countArg: number | null): boolean {
  const gInfo = sObjectMgr.getGameObjectTemplate(gameObjectId);
  if (!gInfo) {
    handler.sendErrorMessage(L.LANG_COMMAND_LISTOBJINVALIDID, gameObjectId);
    return false;
  }
  const count = countArg ?? 10;
  if (count === 0) return false;
  const rows = sObjectMgr.worldTables()?.where(gameobject, "id", gameObjectId) ?? [];
  const objectCount = rows.length;
  for (const row of nearest(handler, rows, count)) {
    const guid = row.guid;
    // Gameobjects are never despawned here: a spawn shown on the map is the active object (`isSpawned`).
    const shown = sObjectMgr.getShownGameObjectSpawn(guid);
    const onMap = handler.getSession() ? handler.getSession()!.getPlayer()!.getMapId() === row.map : ObjectAccessor.GetPlayers().some((player) => player.getMapId() === row.map);
    const liveGuid = shown && onMap ? guidString(gameObjectGuid(row.id, guid)) : "";
    const spawned = shown && onMap ? "*" : "";
    if (handler.getSession()) handler.pSendSysMessage(L.LANG_GO_LIST_CHAT, guid, row.id, guid, gInfo.name, row.position_x, row.position_y, row.position_z, row.map, liveGuid, spawned);
    else handler.pSendSysMessage(L.LANG_GO_LIST_CONSOLE, guid, gInfo.name, row.position_x, row.position_y, row.position_z, row.map, liveGuid, spawned);
  }
  handler.pSendSysMessage(L.LANG_COMMAND_LISTOBJMESSAGE, gameObjectId, objectCount);
  return true;
}

/** @ac scripts/Commands/cs_list.cpp list_commandscript::HandleListAllAurasCommand */
function HandleListAllAurasCommand(handler: ChatHandler): boolean {
  return ListAurasCommand(handler, null, "");
}

/** @ac scripts/Commands/cs_list.cpp list_commandscript::HandleListAurasByIdCommand */
function HandleListAurasByIdCommand(handler: ChatHandler, spellId: number): boolean {
  return ListAurasCommand(handler, spellId, "");
}

/** @ac scripts/Commands/cs_list.cpp list_commandscript::HandleListAurasByNameCommand */
function HandleListAurasByNameCommand(handler: ChatHandler, namePart: string): boolean {
  return ListAurasCommand(handler, null, namePart);
}

/** @ac scripts/Commands/cs_list.cpp list_commandscript::ListAurasCommand */
function ListAurasCommand(handler: ChatHandler, spellId: number | null, namePartArg: string): boolean {
  const unit = handler.getSelectedUnit();
  const spellUnit = unit?.spellUnit() ?? null;
  if (!unit || !spellUnit) {
    handler.sendErrorMessage(L.LANG_SELECT_CHAR_OR_CREATURE);
    return false;
  }
  const namePart = wstrToLower(namePartArg);
  const talentStr = handler.getAcoreString(L.LANG_TALENT);
  const passiveStr = handler.getAcoreString(L.LANG_PASSIVE);
  const auras = spellUnit.appliedAuras;
  handler.pSendSysMessage(L.LANG_COMMAND_TARGET_LISTAURAS, auras.length);
  for (const aurApp of auras) {
    const aura = aurApp.base;
    const talent = GetTalentSpellCost(aura.spellInfo.id) > 0;
    const name = aura.spellInfo.name;
    if (!ShouldListAura(aura.spellInfo, spellId, namePart)) continue;
    const ss_name = `|cffffffff|Hspell:${aura.spellInfo.id}|h[${name}]|h|r`;
    const casterIsPlayer = ((aura.casterGuid >> 48n) & 0xffffn) === 0n;
    handler.pSendSysMessage(
      L.LANG_COMMAND_TARGET_AURADETAIL,
      aura.spellInfo.id,
      handler.getSession() ? ss_name : name,
      aurApp.effectMask,
      aura.procCharges,
      aura.stackAmount,
      aurApp.slot,
      aura.duration,
      aura.maxDuration,
      isPassive(aura.spellInfo) ? passiveStr : "",
      talent ? talentStr : "",
      casterIsPlayer ? "player" : "creature",
      guidString(aura.casterGuid),
    );
  }
  for (let i = 0; i < TOTAL_AURAS; ++i) {
    const auraList = spellUnit.auraEffectsByType(i);
    if (auraList.length === 0) continue;
    let sizeLogged = false;
    for (const effect of auraList) {
      if (!ShouldListAura(effect.base.spellInfo, spellId, namePart)) continue;
      if (!sizeLogged) {
        sizeLogged = true;
        handler.pSendSysMessage(L.LANG_COMMAND_TARGET_LISTAURATYPE, auraList.length, i);
      }
      handler.pSendSysMessage(L.LANG_COMMAND_TARGET_AURASIMPLE, effect.base.spellInfo.id, effect.effIndex, effect.amount);
    }
  }
  return true;
}

/** @ac scripts/Commands/cs_list.cpp list_commandscript::ShouldListAura */
function ShouldListAura(spellInfo: SpellInfo, spellId: number | null, namePart: string): boolean {
  if (spellId !== null) return spellInfo.id === spellId;
  if (namePart) return utf8FitTo(spellInfo.name, namePart);
  return true;
}

/** @ac scripts/Commands/cs_list.cpp list_commandscript::HandleListRespawnsCommand */
function HandleListRespawnsCommand(handler: ChatHandler, firstArg: number | null, secondArg: number | null, thirdArg: number | null): boolean {
  let creatures: CommandCreature[] | null;
  let entryFilter: number | null;
  let mapId: number;
  const session = handler.getSession();
  if (session) {
    // In-game: first arg = entryId (optional), use player's current map
    creatures = session.getPlayer()!.getMapCreatures();
    mapId = session.getPlayer()!.getMapId();
    entryFilter = firstArg;
  } else {
    // Console: first arg = mapId (required), second = instanceId, third = entryId
    if (firstArg === null) {
      handler.sendSysMessage(L.LANG_LIST_RESPAWNS_NO_MAP);
      return false;
    }
    mapId = firstArg;
    creatures = secondArg ? null : mapCreatures(handler, firstArg);
    entryFilter = thirdArg;
  }
  if (!creatures) {
    handler.pSendSysMessage(L.LANG_RESPAWN_GUID_MAP_NOT_LOADED, firstArg ?? 0);
    return false;
  }
  let count = 0;
  const now = Math.floor(Date.now() / 1000);
  handler.pSendSysMessage(L.LANG_LIST_RESPAWNS_CREATURE_HEADER, mapId, 0);
  for (const unit of creatures) {
    const respawnTime = unit.getRespawnTime();
    if (!respawnTime) continue;
    const data = sObjectMgr.getCreatureData(unit.getSpawnId());
    if (!data || (entryFilter !== null && data.id !== entryFilter)) continue;
    const name = sObjectMgr.getCreatureTemplate(data.id)?.name ?? "Unknown";
    handler.pSendSysMessage(L.LANG_LIST_RESPAWNS_CREATURE_ENTRY, unit.getSpawnId(), name, data.id, respawnTime > now ? respawnTime - now : 0);
    if (++count >= 50) {
      handler.sendSysMessage(L.LANG_LIST_RESPAWNS_LIMIT);
      break;
    }
  }
  // Gameobjects are never despawned in this server, so none waits for a respawn time.
  handler.sendSysMessage(L.LANG_LIST_RESPAWNS_GO_HEADER);
  return true;
}

/** @ac scripts/Commands/cs_list.cpp AddSC_list_commandscript */
export function AddSC_list_commandscript(): void {
  registerCommandScript(GetCommands);
}

