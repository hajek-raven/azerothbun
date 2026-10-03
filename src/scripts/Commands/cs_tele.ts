/** `cs_tele.cpp`: `.teleport <tele>`, `.teleport add|del|group|name …`. */
import { queryRows, queryFields } from "../../database/database.ts";
import { CharacterDatabase } from "../../database/DatabaseEnv.ts";
import { CHAR_SEL_CHAR_HOMEBIND } from "../../gen/CharacterDatabase.gen.ts";
import {
  RBAC_PERM_COMMAND_TELE,
  RBAC_PERM_COMMAND_TELE_ADD,
  RBAC_PERM_COMMAND_TELE_DEL,
  RBAC_PERM_COMMAND_TELE_GROUP,
  RBAC_PERM_COMMAND_TELE_NAME,
} from "../../game/Accounts/RBACDefines.ts";
import { ChatHandler } from "../../game/Chat/Chat.ts";
import { ChatCommand, Console, registerCommandScript, SubCommands, type ChatCommandTable } from "../../game/Chat/ChatCommands/ChatCommand.ts";
import { GameTeleArg, Optional, stringArg } from "../../game/Chat/ChatCommands/ChatCommandArgs.ts";
import { ExactSequence, HyperlinkOrUint32, PlayerIdentifier, PlayerIdentifierArg, Tail, Variant, type VariantValue } from "../../game/Chat/ChatCommands/ChatCommandTags.ts";
import { creature, creature_entry } from "../../game/Chat/Hyperlinks.ts";
import { sMapStore } from "../../game/DataStores/DBCStores.ts";
import type { WorldPosition } from "../../game/Entities/Player/Player.ts";
import { SavePositionInDB } from "../../game/Entities/Player/PlayerMisc.ts";
import { sObjectMgr, type GameTele } from "../../game/Globals/ObjectMgr.ts";
import { isValidMapCoord } from "../../game/Maps/MapMgr.ts";
import * as L from "../../game/Miscellaneous/Language.ts";
import { WorldDatabase } from "../../database/DatabaseEnv.ts";

const MAP_BATTLEGROUND = 3;
const MAP_ARENA = 4;

/** @ac scripts/Commands/cs_tele.cpp tele_commandscript::GetCommands */
function GetCommands(): ChatCommandTable {
  const teleNameNpcCommandTable: ChatCommandTable = [
    ChatCommand("id", [PlayerIdentifierArg, HyperlinkOrUint32(creature_entry)], HandleTeleNameNpcIdCommand, RBAC_PERM_COMMAND_TELE_NAME, Console.Yes),
    ChatCommand("guid", [PlayerIdentifierArg, HyperlinkOrUint32(creature)], HandleTeleNameNpcSpawnIdCommand, RBAC_PERM_COMMAND_TELE_NAME, Console.Yes),
    ChatCommand("name", [PlayerIdentifierArg, Tail], HandleTeleNameNpcNameCommand, RBAC_PERM_COMMAND_TELE_NAME, Console.Yes),
  ];
  const teleNameCommandTable: ChatCommandTable = [
    SubCommands("npc", teleNameNpcCommandTable),
    ChatCommand("", [Optional(PlayerIdentifierArg), Variant(GameTeleArg, ExactSequence("$home"))], HandleTeleNameCommand, RBAC_PERM_COMMAND_TELE_NAME, Console.Yes),
  ];
  const teleCommandTable: ChatCommandTable = [
    ChatCommand("add", [stringArg], HandleTeleAddCommand, RBAC_PERM_COMMAND_TELE_ADD, Console.No),
    ChatCommand("del", [GameTeleArg], HandleTeleDelCommand, RBAC_PERM_COMMAND_TELE_DEL, Console.Yes),
    SubCommands("name", teleNameCommandTable),
    ChatCommand("group", [GameTeleArg], HandleTeleGroupCommand, RBAC_PERM_COMMAND_TELE_GROUP, Console.No),
    ChatCommand("", [GameTeleArg], HandleTeleCommand, RBAC_PERM_COMMAND_TELE, Console.No),
  ];
  return [SubCommands("teleport", teleCommandTable)];
}

/** @ac scripts/Commands/cs_tele.cpp tele_commandscript::HandleTeleAddCommand */
function HandleTeleAddCommand(handler: ChatHandler, name: string): boolean {
  const player = handler.getSession()?.getPlayer();
  if (!player) return false;
  if (sObjectMgr.getGameTeleByName(name, true)) {
    handler.sendErrorMessage(L.LANG_COMMAND_TP_ALREADYEXIST);
    return false;
  }
  const added = sObjectMgr.addGameTele({
    position_x: player.getPositionX(),
    position_y: player.getPositionY(),
    position_z: player.getPositionZ(),
    orientation: player.getOrientation(),
    mapId: player.getMapId(),
    name,
  });
  if (!added) {
    handler.sendErrorMessage(L.LANG_COMMAND_TP_ADDEDERR);
    return false;
  }
  handler.sendSysMessage(L.LANG_COMMAND_TP_ADDED);
  return true;
}

/** @ac scripts/Commands/cs_tele.cpp tele_commandscript::HandleTeleDelCommand */
function HandleTeleDelCommand(handler: ChatHandler, tele: GameTele | null): boolean {
  if (!tele) {
    handler.sendErrorMessage(L.LANG_COMMAND_TELE_NOTFOUND);
    return false;
  }
  sObjectMgr.deleteGameTele(tele.name);
  handler.sendSysMessage(L.LANG_COMMAND_TP_DELETED);
  return true;
}

/** @ac scripts/Commands/cs_tele.cpp tele_commandscript::DoNameTeleport */
async function DoNameTeleport(handler: ChatHandler, player: PlayerIdentifier, mapId: number, pos: { x: number; y: number; z: number; o: number }, locationName: string): Promise<boolean> {
  if (!isValidMapCoord(mapId, pos.x, pos.y, pos.z, pos.o) || sObjectMgr.isTransportMap(mapId)) {
    handler.sendErrorMessage(L.LANG_INVALID_TARGET_COORD, pos.x, pos.y, mapId);
    return false;
  }
  const target = player.getConnectedPlayer();
  if (target) {
    // check online security
    if (await handler.hasLowerSecurity(target, 0)) return false;
    const chrNameLink = handler.playerLink(target.getName());
    if (target.isBeingTeleported()) {
      handler.sendErrorMessage(L.LANG_IS_TELEPORTED, chrNameLink);
      return false;
    }
    handler.pSendSysMessage(L.LANG_TELEPORTING_TO, chrNameLink, "", locationName);
    if (handler.needReportToTarget(target)) new ChatHandler(target.getSession()).pSendSysMessage(L.LANG_TELEPORTED_TO_BY, handler.getNameLink());
    // stop flight if need; save only in non-flight case
    if (!target.isInFlight()) target.saveRecallPosition();
    target.teleportTo(mapId, pos.x, pos.y, pos.z, pos.o);
  } else {
    // check offline security
    if (await handler.hasLowerSecurity(null, player.getGUID())) return false;
    const nameLink = handler.playerLink(player.getName());
    handler.pSendSysMessage(L.LANG_TELEPORTING_TO, nameLink, handler.getAcoreString(L.LANG_OFFLINE), locationName);
    // `sMapMgr->GetZoneId` needs terrain area data, which is not ported: the zone is 0.
    await SavePositionInDB({ mapId, ...pos }, 0, player.getGUID());
  }
  return true;
}

/** @ac scripts/Commands/cs_tele.cpp tele_commandscript::HandleTeleNameCommand */
async function HandleTeleNameCommand(handler: ChatHandler, playerArg: PlayerIdentifier | null, where: VariantValue<GameTele | string>): Promise<boolean> {
  const player = playerArg ?? PlayerIdentifier.fromTargetOrSelf(handler);
  if (!player) return false;
  if (where.index === 1) {
    // References target's homebind
    const target = player.getConnectedPlayer();
    if (target) {
      const home = target.getHomebind();
      if (home) target.teleportTo(home.mapId, home.x, home.y, home.z, target.getOrientation());
    } else {
      const [fieldsDB] = await queryFields(CharacterDatabase(), CHAR_SEL_CHAR_HOMEBIND, player.getGUID());
      if (fieldsDB) {
        const loc: WorldPosition = { mapId: Number(fieldsDB[0]), x: Number(fieldsDB[2]), y: Number(fieldsDB[3]), z: Number(fieldsDB[4]), o: 0 };
        await SavePositionInDB(loc, Number(fieldsDB[1]), player.getGUID());
      }
    }
    return true;
  }
  // id, or string, or [name] Shift-click form |color|Htele:id|h[name]|h|r
  const tele = where.value as GameTele;
  return DoNameTeleport(handler, player, tele.mapId, { x: tele.position_x, y: tele.position_y, z: tele.position_z, o: tele.orientation }, tele.name);
}

/** @ac scripts/Commands/cs_tele.cpp tele_commandscript::HandleTeleGroupCommand */
async function HandleTeleGroupCommand(handler: ChatHandler, tele: GameTele | null): Promise<boolean> {
  if (!tele) {
    handler.sendErrorMessage(L.LANG_COMMAND_TELE_NOTFOUND);
    return false;
  }
  const target = handler.getSelectedPlayer();
  if (!target) {
    handler.sendErrorMessage(L.LANG_NO_CHAR_SELECTED);
    return false;
  }
  // check online security
  if (await handler.hasLowerSecurity(target, 0)) return false;
  const map = sMapStore.lookupEntry(tele.mapId);
  if (!map || map.map_type === MAP_BATTLEGROUND || map.map_type === MAP_ARENA) {
    handler.sendErrorMessage(L.LANG_CANNOT_TELE_TO_BG);
    return false;
  }
  const nameLink = handler.getNameLink(target);
  // `GetGroup()`: groups are not ported, so no player is in one.
  if (!target.getGroup()) {
    handler.sendErrorMessage(L.LANG_NOT_IN_GROUP, nameLink);
    return false;
  }
  return true;
}

/** @ac scripts/Commands/cs_tele.cpp tele_commandscript::HandleTeleCommand */
function HandleTeleCommand(handler: ChatHandler, tele: GameTele | null): boolean {
  if (!tele) {
    handler.sendErrorMessage(L.LANG_COMMAND_TELE_NOTFOUND);
    return false;
  }
  const player = handler.getSession()!.getPlayer()!;
  if (player.isInCombat()) {
    handler.sendErrorMessage(L.LANG_YOU_IN_COMBAT);
    return false;
  }
  const map = sMapStore.lookupEntry(tele.mapId);
  if (!map || ((map.map_type === MAP_BATTLEGROUND || map.map_type === MAP_ARENA) && (player.getMapId() !== tele.mapId || !player.isGameMaster()))) {
    handler.sendErrorMessage(L.LANG_CANNOT_TELE_TO_BG);
    return false;
  }
  // stop flight if need; save only in non-flight case
  if (!player.isInFlight()) player.saveRecallPosition();
  player.teleportTo(tele.mapId, tele.position_x, tele.position_y, tele.position_z, tele.orientation);
  return true;
}

/** @ac scripts/Commands/cs_tele.cpp tele_commandscript::HandleTeleNameNpcIdCommand */
async function HandleTeleNameNpcIdCommand(handler: ChatHandler, player: PlayerIdentifier, creatureId: number): Promise<boolean> {
  let spawnpoint = null;
  for (const data of sObjectMgr.getAllCreatureData()) {
    if (data.id !== creatureId) continue;
    if (!spawnpoint) {
      spawnpoint = data;
    } else {
      handler.sendSysMessage(L.LANG_COMMAND_GOCREATMULTIPLE);
      break;
    }
  }
  if (!spawnpoint) {
    handler.sendErrorMessage(L.LANG_COMMAND_GOCREATNOTFOUND);
    return false;
  }
  const creatureTemplate = sObjectMgr.getCreatureTemplate(creatureId)!;
  return DoNameTeleport(handler, player, spawnpoint.map, { x: spawnpoint.position_x, y: spawnpoint.position_y, z: spawnpoint.position_z, o: 0 }, creatureTemplate.name);
}

/** @ac scripts/Commands/cs_tele.cpp tele_commandscript::HandleTeleNameNpcSpawnIdCommand */
async function HandleTeleNameNpcSpawnIdCommand(handler: ChatHandler, player: PlayerIdentifier, spawnId: number): Promise<boolean> {
  const spawnpoint = sObjectMgr.getCreatureData(spawnId);
  if (!spawnpoint) {
    handler.sendErrorMessage(L.LANG_COMMAND_GOCREATNOTFOUND);
    return false;
  }
  const creatureTemplate = sObjectMgr.getCreatureTemplate(spawnpoint.id)!;
  return DoNameTeleport(handler, player, spawnpoint.map, { x: spawnpoint.position_x, y: spawnpoint.position_y, z: spawnpoint.position_z, o: 0 }, creatureTemplate.name);
}

/** @ac scripts/Commands/cs_tele.cpp tele_commandscript::HandleTeleNameNpcNameCommand */
async function HandleTeleNameNpcNameCommand(handler: ChatHandler, player: PlayerIdentifier, name: string): Promise<boolean> {
  // May need work //PussyWizardEliteMalcrom
  const result = await queryRows<{ position_x: number; position_y: number; position_z: number; orientation: number; map: number; name: string }>(
    WorldDatabase(),
    "SELECT c.position_x, c.position_y, c.position_z, c.orientation, c.map, ct.name FROM creature c INNER JOIN creature_template ct ON c.id = ct.entry WHERE ct.name LIKE ?",
    name,
  );
  if (result.length === 0) {
    handler.sendErrorMessage(L.LANG_COMMAND_GOCREATNOTFOUND);
    return false;
  }
  if (result.length > 1) handler.sendSysMessage(L.LANG_COMMAND_GOCREATMULTIPLE);
  const fields = result[0]!;
  return DoNameTeleport(handler, player, fields.map, { x: fields.position_x, y: fields.position_y, z: fields.position_z, o: fields.orientation }, fields.name);
}

/** @ac scripts/Commands/cs_tele.cpp AddSC_tele_commandscript */
export function AddSC_tele_commandscript(): void {
  registerCommandScript(GetCommands);
}

