/** `cs_go.cpp`: `.go creature|gameobject|graveyard|grid|taxinode|trigger|zonexy|xyz|ticket|quest`. */
import { queryFields } from "../../database/database.ts";
import { WorldDatabase } from "../../database/DatabaseEnv.ts";
import { RBAC_PERM_COMMAND_GO } from "../../game/Accounts/RBACDefines.ts";
import type { ChatHandler } from "../../game/Chat/Chat.ts";
import { ChatCommand, Console, registerCommandScript, SubCommands, type ChatCommandTable } from "../../game/Chat/ChatCommands/ChatCommand.ts";
import { floatArg, Optional, QuestArg, stringViewArg, uint32Arg } from "../../game/Chat/ChatCommands/ChatCommandArgs.ts";
import { HyperlinkOrUint32, Tail } from "../../game/Chat/ChatCommands/ChatCommandTags.ts";
import { area, areatrigger, creature, creature_entry, taxinode } from "../../game/Chat/Hyperlinks.ts";
import { sAreaTableStore, sMapStore, sTaxiNodesStore, Zone2MapCoordinates } from "../../game/DataStores/DBCStores.ts";
import { sObjectMgr, type CreatureData, type GameObjectData } from "../../game/Globals/ObjectMgr.ts";
import { getHeight, getWaterLevel, isValidMapCoord, MAX_HEIGHT, MAX_NUMBER_OF_GRIDS, SIZE_OF_GRIDS } from "../../game/Maps/MapMgr.ts";
import { sGraveyard } from "../../game/Misc/GameGraveyard.ts";
import * as L from "../../game/Miscellaneous/Language.ts";
import type { QuestTemplate } from "../../world/quests.ts";

const MAPID_INVALID = 0xffffffff;
const CENTER_GRID_ID = MAX_NUMBER_OF_GRIDS / 2;
const MAP_INSTANCE = 1;
const MAP_RAID = 2;
const MAP_BATTLEGROUND = 3;
const MAP_ARENA = 4;

/** @ac scripts/Commands/cs_go.cpp go_commandscript::GetCommands */
function GetCommands(): ChatCommandTable {
  const goCommandTable: ChatCommandTable = [
    ChatCommand("creature", [HyperlinkOrUint32(creature)], HandleGoCreatureSpawnIdCommand, RBAC_PERM_COMMAND_GO, Console.No),
    ChatCommand("creature id", [HyperlinkOrUint32(creature_entry), Optional(uint32Arg)], HandleGoCreatureCIdCommand, RBAC_PERM_COMMAND_GO, Console.No),
    ChatCommand("creature name", [Tail], HandleGoCreatureNameCommand, RBAC_PERM_COMMAND_GO, Console.No),
    ChatCommand("gameobject", [uint32Arg], HandleGoGameObjectSpawnIdCommand, RBAC_PERM_COMMAND_GO, Console.No),
    ChatCommand("gameobject id", [uint32Arg, Optional(uint32Arg)], HandleGoGameObjectGOIdCommand, RBAC_PERM_COMMAND_GO, Console.No),
    ChatCommand("graveyard", [uint32Arg], HandleGoGraveyardCommand, RBAC_PERM_COMMAND_GO, Console.No),
    ChatCommand("grid", [floatArg, floatArg, Optional(uint32Arg)], HandleGoGridCommand, RBAC_PERM_COMMAND_GO, Console.No),
    ChatCommand("taxinode", [HyperlinkOrUint32(taxinode)], HandleGoTaxinodeCommand, RBAC_PERM_COMMAND_GO, Console.No),
    ChatCommand("trigger", [HyperlinkOrUint32(areatrigger)], HandleGoTriggerCommand, RBAC_PERM_COMMAND_GO, Console.No),
    ChatCommand("zonexy", [floatArg, floatArg, Optional(HyperlinkOrUint32(area))], HandleGoZoneXYCommand, RBAC_PERM_COMMAND_GO, Console.No),
    ChatCommand("xyz", [Tail], HandleGoXYZCommand, RBAC_PERM_COMMAND_GO, Console.No),
    ChatCommand("ticket", [uint32Arg], HandleGoTicketCommand, RBAC_PERM_COMMAND_GO, Console.No),
    ChatCommand("quest", [stringViewArg, QuestArg], HandleGoQuestCommand, RBAC_PERM_COMMAND_GO, Console.No),
  ];
  return [SubCommands("go", goCommandTable)];
}

type Position = { x: number; y: number; z: number; o?: number };

/** @ac scripts/Commands/cs_go.cpp go_commandscript::DoTeleport */
function DoTeleport(handler: ChatHandler, pos: Position, mapIdArg = MAPID_INVALID): boolean {
  const player = handler.getSession()!.getPlayer()!;
  const mapId = mapIdArg === MAPID_INVALID ? player.getMapId() : mapIdArg;
  const o = pos.o ?? 0;
  if (sObjectMgr.isTransportMap(mapId)) return DoTeleportToTransport(handler, pos, mapId);
  if (!isValidMapCoord(mapId, pos.x, pos.y, pos.z, o)) {
    handler.sendErrorMessage(L.LANG_INVALID_TARGET_COORD, pos.x, pos.y, mapId);
    return false;
  }
  // stop flight if need; save only in non-flight case
  if (!player.isInFlight()) player.saveRecallPosition();
  player.teleportTo(mapId, pos.x, pos.y, pos.z, o);
  return true;
}

/**
 * @ac scripts/Commands/cs_go.cpp go_commandscript::DoTeleportToTransport
 * Transports are not ported, so no map holds the `MotionTransport` the C++ looks for.
 */
function DoTeleportToTransport(handler: ChatHandler, pos: Position, transportMapId: number): boolean {
  handler.sendErrorMessage(L.LANG_INVALID_TARGET_COORD, pos.x, pos.y, transportMapId);
  return false;
}

/** @ac scripts/Commands/cs_go.cpp go_commandscript::HandleGoCreatureCIdCommand */
function HandleGoCreatureCIdCommand(handler: ChatHandler, cId: number, posArg: number | null): boolean {
  let pos = 1;
  if (posArg !== null) {
    pos = posArg;
    if (pos < 1) {
      handler.sendErrorMessage(L.LANG_COMMAND_FACTION_INVPARAM, pos);
      return false;
    }
  }
  const spawnpoints = GetCreatureDataList(cId);
  if (spawnpoints.length === 0) {
    handler.sendErrorMessage(L.LANG_COMMAND_GOCREATNOTFOUND);
    return false;
  }
  if (spawnpoints.length < pos) {
    handler.sendErrorMessage(L.LANG_COMMAND_GONOTENOUGHSPAWNS, pos, spawnpoints.length);
    return false;
  }
  const spawnpoint = spawnpoints[pos - 1]!;
  return DoTeleport(handler, { x: spawnpoint.position_x, y: spawnpoint.position_y, z: spawnpoint.position_z }, spawnpoint.map);
}

/** @ac scripts/Commands/cs_go.cpp go_commandscript::HandleGoCreatureSpawnIdCommand */
function HandleGoCreatureSpawnIdCommand(handler: ChatHandler, spawnId: number): boolean {
  const spawnpoint = sObjectMgr.getCreatureData(spawnId);
  if (!spawnpoint) {
    handler.sendErrorMessage(L.LANG_COMMAND_GOCREATNOTFOUND);
    return false;
  }
  return DoTeleport(handler, { x: spawnpoint.position_x, y: spawnpoint.position_y, z: spawnpoint.position_z }, spawnpoint.map);
}

/** @ac scripts/Commands/cs_go.cpp go_commandscript::HandleGoCreatureNameCommand */
async function HandleGoCreatureNameCommand(handler: ChatHandler, name: string): Promise<boolean> {
  if (!name) return false;
  const [row] = await queryFields(WorldDatabase(), "SELECT entry FROM creature_template WHERE name = ? LIMIT 1", name);
  if (!row) {
    handler.sendErrorMessage(L.LANG_COMMAND_GOCREATNOTFOUND);
    return false;
  }
  const spawnpoint = GetCreatureData(handler, Number(row[0]));
  if (!spawnpoint) {
    handler.sendErrorMessage(L.LANG_COMMAND_GOCREATNOTFOUND);
    return false;
  }
  return DoTeleport(handler, { x: spawnpoint.position_x, y: spawnpoint.position_y, z: spawnpoint.position_z }, spawnpoint.map);
}

/** @ac scripts/Commands/cs_go.cpp go_commandscript::HandleGoGameObjectSpawnIdCommand */
function HandleGoGameObjectSpawnIdCommand(handler: ChatHandler, spawnId: number): boolean {
  const spawnpoint = sObjectMgr.getGameObjectData(spawnId);
  if (!spawnpoint) {
    handler.sendErrorMessage(L.LANG_COMMAND_GOOBJNOTFOUND);
    return false;
  }
  return DoTeleport(handler, { x: spawnpoint.position_x, y: spawnpoint.position_y, z: spawnpoint.position_z }, spawnpoint.map);
}

/** @ac scripts/Commands/cs_go.cpp go_commandscript::HandleGoGameObjectGOIdCommand */
function HandleGoGameObjectGOIdCommand(handler: ChatHandler, goId: number, posArg: number | null): boolean {
  let pos = 1;
  if (posArg !== null) {
    pos = posArg;
    if (pos < 1) {
      handler.sendErrorMessage(L.LANG_COMMAND_FACTION_INVPARAM, pos);
      return false;
    }
  }
  const spawnpoints = GetGameObjectDataList(goId);
  if (spawnpoints.length === 0) {
    handler.sendErrorMessage(L.LANG_COMMAND_GOOBJNOTFOUND);
    return false;
  }
  if (spawnpoints.length < pos) {
    handler.sendErrorMessage(L.LANG_COMMAND_GONOTENOUGHSPAWNS, pos, spawnpoints.length);
    return false;
  }
  const spawnpoint = spawnpoints[pos - 1]!;
  return DoTeleport(handler, { x: spawnpoint.position_x, y: spawnpoint.position_y, z: spawnpoint.position_z }, spawnpoint.map);
}

/** @ac scripts/Commands/cs_go.cpp go_commandscript::HandleGoGraveyardCommand */
function HandleGoGraveyardCommand(handler: ChatHandler, gyId: number): boolean {
  const gy = sGraveyard.getGraveyard(gyId);
  if (!gy) {
    handler.sendErrorMessage(L.LANG_COMMAND_GRAVEYARDNOEXIST, gyId);
    return false;
  }
  if (!isValidMapCoord(gy.Map, gy.x, gy.y, gy.z)) {
    handler.sendErrorMessage(L.LANG_INVALID_TARGET_COORD, gy.x, gy.y, gy.Map);
    return false;
  }
  const player = handler.getSession()!.getPlayer()!;
  if (!player.isInFlight()) player.saveRecallPosition();
  player.teleportTo(gy.Map, gy.x, gy.y, gy.z, player.getOrientation());
  return true;
}

/** @ac scripts/Commands/cs_go.cpp go_commandscript::HandleGoGridCommand */
function HandleGoGridCommand(handler: ChatHandler, gridX: number, gridY: number, oMapId: number | null): boolean {
  const player = handler.getSession()!.getPlayer()!;
  const mapId = oMapId ?? player.getMapId();
  // center of grid
  const x = Math.fround((gridX - CENTER_GRID_ID + 0.5) * SIZE_OF_GRIDS);
  const y = Math.fround((gridY - CENTER_GRID_ID + 0.5) * SIZE_OF_GRIDS);
  if (!isValidMapCoord(mapId, x, y)) {
    handler.sendErrorMessage(L.LANG_INVALID_TARGET_COORD, x, y, mapId);
    return false;
  }
  if (!player.isInFlight()) player.saveRecallPosition();
  const z = Math.max(getHeight(mapId, x, y, MAX_HEIGHT), getWaterLevel(mapId, x, y));
  player.teleportTo(mapId, x, y, z, player.getOrientation());
  return true;
}

/** @ac scripts/Commands/cs_go.cpp go_commandscript::HandleGoTaxinodeCommand */
function HandleGoTaxinodeCommand(handler: ChatHandler, nodeId: number): boolean {
  const node = sTaxiNodesStore.lookupEntry(nodeId);
  if (!node) {
    handler.sendErrorMessage(L.LANG_COMMAND_GOTAXINODENOTFOUND, nodeId);
    return false;
  }
  return DoTeleport(handler, { x: node.x, y: node.y, z: node.z }, node.map_id);
}

/** @ac scripts/Commands/cs_go.cpp go_commandscript::HandleGoTriggerCommand */
function HandleGoTriggerCommand(handler: ChatHandler, areaTriggerId: number): boolean {
  const at = sObjectMgr.getAreaTrigger(areaTriggerId);
  if (!at) {
    handler.sendErrorMessage(L.LANG_COMMAND_GOAREATRNOTFOUND, areaTriggerId);
    return false;
  }
  return DoTeleport(handler, { x: at.x, y: at.y, z: at.z }, at.map);
}

/** @ac scripts/Commands/cs_go.cpp go_commandscript::HandleGoZoneXYCommand */
function HandleGoZoneXYCommand(handler: ChatHandler, xArg: number, yArg: number, areaIdArg: number | null): boolean {
  const player = handler.getSession()!.getPlayer()!;
  const areaId = areaIdArg ?? player.getZoneId();
  const areaEntry = sAreaTableStore.lookupEntry(areaId);
  if (xArg < 0 || xArg > 100 || yArg < 0 || yArg > 100 || !areaEntry) {
    handler.sendErrorMessage(L.LANG_INVALID_ZONE_COORD, xArg, yArg, areaId);
    return false;
  }
  // update to parent zone if exist (client map show only zones without parents)
  const zoneEntry = areaEntry.zone ? sAreaTableStore.lookupEntry(areaEntry.zone)! : areaEntry;
  const map = sMapStore.lookupEntry(zoneEntry.mapid);
  if (map && [MAP_INSTANCE, MAP_RAID, MAP_BATTLEGROUND, MAP_ARENA].includes(map.map_type)) {
    handler.sendErrorMessage(L.LANG_INVALID_ZONE_MAP, areaEntry.ID, areaEntry.area_name[handler.getSessionDbcLocale()] ?? "", zoneEntry.mapid, map.name[0] ?? "");
    return false;
  }
  const { x, y } = Zone2MapCoordinates(xArg, yArg, zoneEntry.ID);
  if (!isValidMapCoord(zoneEntry.mapid, x, y)) {
    handler.sendErrorMessage(L.LANG_INVALID_TARGET_COORD, x, y, zoneEntry.mapid);
    return false;
  }
  if (!player.isInFlight()) player.saveRecallPosition();
  const z = Math.max(getHeight(zoneEntry.mapid, x, y, MAX_HEIGHT), getWaterLevel(zoneEntry.mapid, x, y));
  player.teleportTo(zoneEntry.mapid, x, y, z, player.getOrientation());
  return true;
}

/** @ac scripts/Commands/cs_go.cpp go_commandscript::HandleGoXYZCommand */
function HandleGoXYZCommand(handler: ChatHandler, args: string): boolean {
  // extract float and integer values from the input
  const locationValues = [...args.matchAll(/(-?\d+(?:\.\d+)?)/g)].map((match) => Math.fround(Number(match[1])));
  // X and Y are required
  if (locationValues.length < 2) return false;
  const player = handler.getSession()!.getPlayer()!;
  const mapId = locationValues.length >= 4 ? Math.trunc(locationValues[3]!) >>> 0 : player.getMapId();
  const x = locationValues[0]!;
  const y = locationValues[1]!;
  if (!sMapStore.lookupEntry(mapId) || !isValidMapCoord(mapId, x, y)) {
    handler.sendErrorMessage(L.LANG_INVALID_TARGET_COORD, x, y, mapId);
    return false;
  }
  const z = locationValues.length >= 3 ? locationValues[2]! : Math.max(getHeight(mapId, x, y, MAX_HEIGHT), getWaterLevel(mapId, x, y));
  // map ID (locationValues[3]) already handled above
  const o = locationValues.length >= 5 ? locationValues[4]! : player.getOrientation();
  if (!isValidMapCoord(mapId, x, y, z, o)) {
    handler.sendErrorMessage(L.LANG_INVALID_TARGET_COORD, x, y, mapId);
    return false;
  }
  return DoTeleport(handler, { x, y, z, o }, mapId);
}

/**
 * @ac scripts/Commands/cs_go.cpp go_commandscript::HandleGoTicketCommand
 * GM tickets are not ported; `sTicketMgr->GetTicket` finds none.
 */
function HandleGoTicketCommand(handler: ChatHandler, _ticketId: number): boolean {
  handler.sendSysMessage(L.LANG_COMMAND_TICKETNOTEXIST);
  return true;
}

/** @ac scripts/Commands/cs_go.cpp go_commandscript::HandleGoQuestCommand */
function HandleGoQuestCommand(handler: ChatHandler, type: string, quest: QuestTemplate): boolean {
  const entry = quest.id;
  const teleportToCreature = (relations: readonly { id: number; quest: number }[]): boolean | null => {
    for (const relation of relations) {
      if (relation.quest !== entry) continue;
      const spawnpoint = GetCreatureData(handler, relation.id);
      if (!spawnpoint) {
        handler.sendErrorMessage(L.LANG_COMMAND_GOCREATNOTFOUND);
        return false;
      }
      // We've found a creature, teleport to it.
      return DoTeleport(handler, { x: spawnpoint.position_x, y: spawnpoint.position_y, z: spawnpoint.position_z }, spawnpoint.map);
    }
    return null;
  };
  const teleportToGameObject = (relations: readonly { id: number; quest: number }[]): boolean | null => {
    for (const relation of relations) {
      if (relation.quest !== entry) continue;
      const spawnpoint = GetGameObjectData(handler, relation.id);
      if (!spawnpoint) {
        handler.sendErrorMessage(L.LANG_COMMAND_GOOBJNOTFOUND);
        return false;
      }
      return DoTeleport(handler, { x: spawnpoint.position_x, y: spawnpoint.position_y, z: spawnpoint.position_z }, spawnpoint.map);
    }
    return null;
  };
  if (type === "starter") {
    return teleportToCreature(sObjectMgr.getCreatureQuestRelationMap()) ?? teleportToGameObject(sObjectMgr.getGOQuestRelationMap()) ?? false;
  }
  if (type === "ender") {
    return teleportToCreature(sObjectMgr.getCreatureQuestInvolvedRelationMap()) ?? teleportToGameObject(sObjectMgr.getGOQuestInvolvedRelationMap()) ?? false;
  }
  handler.sendErrorMessage(L.LANG_CMD_GOQUEST_INVALID_SYNTAX);
  return false;
}

/** @ac scripts/Commands/cs_go.cpp go_commandscript::GetCreatureData */
function GetCreatureData(handler: ChatHandler, entry: number): CreatureData | null {
  let spawnpoint: CreatureData | null = null;
  for (const data of sObjectMgr.getAllCreatureData()) {
    if (data.id !== entry) continue;
    if (!spawnpoint) {
      spawnpoint = data;
    } else {
      handler.sendSysMessage(L.LANG_COMMAND_GOCREATMULTIPLE);
      break;
    }
  }
  return spawnpoint;
}

/** @ac scripts/Commands/cs_go.cpp go_commandscript::GetCreatureDataList */
function GetCreatureDataList(entry: number): CreatureData[] {
  return sObjectMgr.getAllCreatureData().filter((data) => data.id === entry);
}

/** @ac scripts/Commands/cs_go.cpp go_commandscript::GetGameObjectData */
function GetGameObjectData(handler: ChatHandler, entry: number): GameObjectData | null {
  let spawnpoint: GameObjectData | null = null;
  for (const data of sObjectMgr.getAllGOData()) {
    if (data.id !== entry) continue;
    if (!spawnpoint) {
      spawnpoint = data;
    } else {
      handler.sendSysMessage(L.LANG_COMMAND_GOCREATMULTIPLE);
      break;
    }
  }
  return spawnpoint;
}

/** @ac scripts/Commands/cs_go.cpp go_commandscript::GetGameObjectDataList */
function GetGameObjectDataList(entry: number): GameObjectData[] {
  return sObjectMgr.getAllGOData().filter((data) => data.id === entry);
}

/** @ac scripts/Commands/cs_go.cpp AddSC_go_commandscript */
export function AddSC_go_commandscript(): void {
  registerCommandScript(GetCommands);
}
