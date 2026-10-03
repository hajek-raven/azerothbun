/** `cs_misc.cpp`: `.appear`, `.summon`, `.revive`, `.additem`, `.pinfo`, `.mute`, `.respawn`, `.gps`, and the other misc commands. */
import { commitTransaction, executeStatement, executeStatementAsync, queryFields, type StatementTransaction } from "../../database/database.ts";
import { CharacterDatabase, LoginDatabase } from "../../database/DatabaseEnv.ts";
import { player_xp_for_level } from "../../database/schema/world.ts";
import {
  CHAR_DEL_CHAR_AURA_FROZEN,
  CHAR_DEL_CHAR_INVENTORY_BY_ITEM,
  CHAR_DEL_CORPSE,
  CHAR_DEL_GIFT,
  CHAR_DEL_ITEM_BOP_TRADE,
  CHAR_DEL_ITEM_INSTANCE,
  CHAR_DEL_ITEM_REFUND_INSTANCE,
  CHAR_DEL_ITEMCONTAINER_CONTAINER,
  CHAR_SEL_CHAR_INVENTORY_STACKS_BY_ENTRY_AND_OWNER,
  CHAR_SEL_CHAR_PINFO,
  CHAR_SEL_CHARACTER_HOMEBIND,
  CHAR_SEL_GUILD_MEMBER_EXTENDED,
  CHAR_SEL_PINFO_BANS,
  CHAR_SEL_PINFO_MAILS,
  CHAR_SEL_PINFO_XP,
  CHAR_UPD_ADD_AT_LOGIN_FLAG,
  CHAR_UPD_ITEM_COUNT,
} from "../../gen/CharacterDatabase.gen.ts";
import { LOGIN_INS_ACCOUNT_MUTE, LOGIN_SEL_ACCOUNT_MUTE_INFO, LOGIN_SEL_PINFO, LOGIN_SEL_PINFO_BANS, LOGIN_UPD_MUTE_TIME } from "../../gen/LoginDatabase.gen.ts";
import { getId, getSecurity, isPlayerAccount } from "../../game/Accounts/AccountMgr.ts";
import * as R from "../../game/Accounts/RBACDefines.ts";
import { sCharacterCache } from "../../game/Cache/CharacterCache.ts";
import { ChatHandler } from "../../game/Chat/Chat.ts";
import { ChatCommand, Console, registerCommandScript, SendCommandHelpFor, SubCommands, type ChatCommandTable } from "../../game/Chat/ChatCommands/ChatCommand.ts";
import {
  boolArg,
  floatArg,
  int16Arg,
  int32Arg,
  ItemTemplateArg,
  Optional,
  SpellInfoArg,
  stringArg,
  stringViewArg,
  uint16Arg,
  uint32Arg,
  uint8Arg,
  VectorArg,
} from "../../game/Chat/ChatCommands/ChatCommandArgs.ts";
import { HyperlinkOrUint32, PlayerIdentifier, PlayerIdentifierArg, Tail, Variant, type VariantValue } from "../../game/Chat/ChatCommands/ChatCommandTags.ts";
import { itemset, skill } from "../../game/Chat/Hyperlinks.ts";
import { Map2ZoneCoordinates, sAreaTableStore, sMapStore, sSkillLineStore, sSoundEntriesStore } from "../../game/DataStores/DBCStores.ts";
import type { CommandCreature, CommandUnit, Player } from "../../game/Entities/Player/Player.ts";
import { AT_LOGIN_RESURRECT, PLAYER_FLAGS_GHOST } from "../../game/Entities/Player/PlayerDefines.ts";
import { LoadPositionFromDB, SavePositionInDB } from "../../game/Entities/Player/PlayerMisc.ts";
import { ObjectAccessor } from "../../game/Globals/ObjectAccessor.ts";
import { sObjectMgr } from "../../game/Globals/ObjectMgr.ts";
import { getHeight, MAX_HEIGHT, MAX_NUMBER_OF_GRIDS, SIZE_OF_GRIDS } from "../../game/Maps/MapMgr.ts";
import * as L from "../../game/Miscellaneous/Language.ts";
import { sGraveyard } from "../../game/Misc/GameGraveyard.ts";
import { sWorldSessionMgr } from "../../game/Server/WorldSessionMgr.ts";
import { sSpellMgr } from "../../game/Spells/SpellMgr.ts";
import { secsToTimeString, timeStringToSecs, timeToHumanReadable } from "../../game/time/timer.ts";
import { ServerConfig } from "../../game/world/world-config.ts";
import { sWorld } from "../../game/world/world.ts";
import { accountFlagNames, MAX_ACCOUNT_FLAG } from "../../common/Common.ts";
import { stringEqualI, stringStartsWith, utf8ToUpperOnlyLatin } from "../../common/util.ts";
import { realm } from "../../shared/Realms/Realm.ts";
import { DEFAULT_LOCALE, SEC_CONSOLE, SEC_PLAYER, TEAM_ALLIANCE, TEAM_HORDE, TEAM_NEUTRAL } from "../../shared/SharedDefines.ts";
import { Aura } from "../../spells/aura.ts";
import { castFailedPacket, SMSG_CAST_FAILED } from "../../spells/packets.ts";
import { SPELL_FAILED_CANT_DO_THAT_RIGHT_NOW } from "../../spells/defines.ts";
import type { SpellInfo } from "../../spells/spell-info.ts";
import type { ItemTemplate } from "../../data/world.ts";
import { attackerStateUpdate } from "../../combat/packets.ts";
import { HITINFO_AFFECTS_VICTIM, SMSG_ATTACKERSTATEUPDATE, VICTIMSTATE_HIT } from "../../combat/constants.ts";
import { getClosestGraveyard, type TeamId } from "../../characters/graveyard.ts";
import { visibilityDistance } from "../../world/visibility.ts";
import { terrainMapOf, terrainStatusAt } from "../../world/session-terrain.ts";
import { GridTerrainLoader } from "../../game/Grids/GridTerrainLoader.ts";
import { DEFAULT_COLLISION_HEIGHT } from "../../game/Entities/Object/ObjectDefines.ts";
import { ByteWriter } from "../../net/byte-buffer.ts";
import { PLAYER_EXPLORED_ZONES_1 } from "../../gen/UpdateFields.gen.ts";
import { PLAYER_EXPLORED_ZONES_SIZE } from "../../world/session.ts";

const SPELL_STUCK = 7355;
const SPELL_FREEZE = 9454;
const MAX_EFFECT_MASK = 7;
const SPELL_SCHOOL_MASK_NORMAL = 1;
const GO_STATE_ACTIVE = 0;
const GAMEOBJECT_TYPE_DOOR = 0;
const MAP_OUTLAND = 530;
const GOLD = 10000;
const SILVER = 100;
const MINUTE = 60;
const IN_MILLISECONDS = 1000;
const MAX_NUMBER_OF_CELLS = 8;
const SMSG_PLAY_SOUND = 0x2d2;
const SMSG_SHOW_MAILBOX = 0x297;

/** `MapTypes` (DBCEnums.h) */
const MAP_INSTANCE = 1;
const MAP_RAID = 2;
const MAP_BATTLEGROUND = 3;
const MAP_ARENA = 4;

/** `MovementGeneratorType` (MovementGenerator.h) */
const IDLE_MOTION_TYPE = 0;
const RANDOM_MOTION_TYPE = 1;
const WAYPOINT_MOTION_TYPE = 2;
const CHASE_MOTION_TYPE = 5;
const HOME_MOTION_TYPE = 7;
const POINT_MOTION_TYPE = 8;
const MAX_MOTION_SLOT = 3;

/** `MapEntry::Instanceable` / `IsDungeon` / `IsBattlegroundOrArena` (DBCStructure.h) */
function mapType(mapId: number): number {
  return sMapStore.lookupEntry(mapId)?.map_type ?? 0;
}
function Instanceable(mapId: number): boolean {
  const type = mapType(mapId);
  return type === MAP_INSTANCE || type === MAP_RAID || type === MAP_BATTLEGROUND || type === MAP_ARENA;
}
function IsDungeon(mapId: number): boolean {
  const type = mapType(mapId);
  return type === MAP_INSTANCE || type === MAP_RAID;
}
function IsBattlegroundOrArena(mapId: number): boolean {
  const type = mapType(mapId);
  return type === MAP_BATTLEGROUND || type === MAP_ARENA;
}

/** @ac scripts/Commands/cs_misc.cpp GetLocalizeCreatureName */
function GetLocalizeCreatureName(creature: CommandUnit, locale: number): string {
  const creatureTemplate = sObjectMgr.getCreatureTemplate(creature.getEntry());
  const cretureLocale = sObjectMgr.getCreatureLocale(creature.getEntry());
  let name = "";
  if (cretureLocale) name = cretureLocale.Name[locale] ?? "";
  if (!name && creatureTemplate) name = creatureTemplate.name;
  if (!name) name = "Unknown creature";
  return name;
}

/** @ac game/Grids/GridDefines.h Acore::ComputeCellCoord (with `Cell::GridX` / `CellX`) */
function ComputeCell(x: number, y: number): { gridX: number; gridY: number; cellX: number; cellY: number } {
  const size = SIZE_OF_GRIDS / MAX_NUMBER_OF_CELLS;
  const center = (MAX_NUMBER_OF_CELLS * MAX_NUMBER_OF_GRIDS) / 2;
  const cx = Math.max(0, Math.trunc(center - x / size));
  const cy = Math.max(0, Math.trunc(center - y / size));
  return { gridX: Math.trunc(cx / MAX_NUMBER_OF_CELLS), gridY: Math.trunc(cy / MAX_NUMBER_OF_CELLS), cellX: cx % MAX_NUMBER_OF_CELLS, cellY: cy % MAX_NUMBER_OF_CELLS };
}

/** @ac game/Grids/GridDefines.h Acore::ComputeGridCoord (`CoordPair::GetId`) */
function ComputeGridId(x: number, y: number): number {
  const center = MAX_NUMBER_OF_GRIDS / 2;
  const gx = Math.max(0, Math.trunc(center - x / SIZE_OF_GRIDS));
  const gy = Math.max(0, Math.trunc(center - y / SIZE_OF_GRIDS));
  return gy * MAX_NUMBER_OF_GRIDS + gx;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/** @ac scripts/Commands/cs_misc.cpp misc_commandscript::GetCommands */
function GetCommands(): ChatCommandTable {
  const auraCommandTable: ChatCommandTable = [
    ChatCommand("stack", [SpellInfoArg, int16Arg], HandleAuraStacksCommand, R.RBAC_PERM_COMMAND_AURA_STACK, Console.No),
    ChatCommand("", [SpellInfoArg], HandleAuraCommand, R.RBAC_PERM_COMMAND_AURA, Console.No),
  ];
  return [
    ChatCommand("commentator", [Optional(boolArg)], HandleCommentatorCommand, R.RBAC_PERM_COMMAND_COMMENTATOR, Console.No),
    ChatCommand("dev", [Optional(boolArg)], HandleDevCommand, R.RBAC_PERM_COMMAND_DEV, Console.No),
    ChatCommand("gps", [Optional(PlayerIdentifierArg)], HandleGPSCommand, R.RBAC_PERM_COMMAND_GPS, Console.No),
    SubCommands("aura", auraCommandTable),
    ChatCommand("unaura", [Variant(SpellInfoArg, stringViewArg)], HandleUnAuraCommand, R.RBAC_PERM_COMMAND_UNAURA, Console.No),
    ChatCommand("appear", [Optional(PlayerIdentifierArg)], HandleAppearCommand, R.RBAC_PERM_COMMAND_APPEAR, Console.No),
    ChatCommand("summon", [Optional(PlayerIdentifierArg)], HandleSummonCommand, R.RBAC_PERM_COMMAND_SUMMON, Console.No),
    ChatCommand("groupsummon", [Optional(PlayerIdentifierArg)], HandleGroupSummonCommand, R.RBAC_PERM_COMMAND_GROUP_SUMMON, Console.No),
    ChatCommand("commands", [], HandleCommandsCommand, R.RBAC_PERM_COMMAND_COMMANDS, Console.Yes),
    ChatCommand("die", [], HandleDieCommand, R.RBAC_PERM_COMMAND_DIE, Console.No),
    ChatCommand("revive", [Optional(PlayerIdentifierArg)], HandleReviveCommand, R.RBAC_PERM_COMMAND_REVIVE, Console.Yes),
    ChatCommand("dismount", [], HandleDismountCommand, R.RBAC_PERM_COMMAND_DISMOUNT, Console.No),
    ChatCommand("guid", [], HandleGUIDCommand, R.RBAC_PERM_COMMAND_GUID, Console.No),
    ChatCommand("help", [Tail], HandleHelpCommand, R.RBAC_PERM_COMMAND_HELP, Console.Yes),
    ChatCommand("cooldown", [Optional(SpellInfoArg)], HandleCooldownCommand, R.RBAC_PERM_COMMAND_COOLDOWN, Console.No),
    ChatCommand("distance", [Optional(PlayerIdentifierArg)], HandleGetDistanceCommand, R.RBAC_PERM_COMMAND_DISTANCE, Console.No),
    ChatCommand("recall", [Optional(PlayerIdentifierArg)], HandleRecallCommand, R.RBAC_PERM_COMMAND_RECALL, Console.No),
    ChatCommand("save", [], HandleSaveCommand, R.RBAC_PERM_COMMAND_SAVE, Console.No),
    ChatCommand("saveall", [], HandleSaveAllCommand, R.RBAC_PERM_COMMAND_SAVEALL, Console.Yes),
    ChatCommand("kick", [Optional(PlayerIdentifierArg), Optional(stringViewArg)], HandleKickPlayerCommand, R.RBAC_PERM_COMMAND_KICK, Console.Yes),
    ChatCommand("unstuck", [Optional(PlayerIdentifierArg), Optional(stringViewArg)], HandleUnstuckCommand, R.RBAC_PERM_COMMAND_UNSTUCK, Console.Yes),
    ChatCommand("linkgrave", [uint32Arg, Optional(stringViewArg)], HandleLinkGraveCommand, R.RBAC_PERM_COMMAND_LINKGRAVE, Console.No),
    ChatCommand("neargrave", [Optional(stringViewArg)], HandleNearGraveCommand, R.RBAC_PERM_COMMAND_NEARGRAVE, Console.No),
    ChatCommand("showarea", [uint32Arg], HandleShowAreaCommand, R.RBAC_PERM_COMMAND_SHOWAREA, Console.No),
    ChatCommand("hidearea", [uint32Arg], HandleHideAreaCommand, R.RBAC_PERM_COMMAND_HIDEAREA, Console.No),
    ChatCommand("additem", [Optional(PlayerIdentifierArg), ItemTemplateArg, Optional(int32Arg)], HandleAddItemCommand, R.RBAC_PERM_COMMAND_ADDITEM, Console.Yes),
    ChatCommand("additem set", [HyperlinkOrUint32(itemset)], HandleAddItemSetCommand, R.RBAC_PERM_COMMAND_ADDITEMSET, Console.No),
    ChatCommand("wchange", [uint32Arg, floatArg], HandleChangeWeather, R.RBAC_PERM_COMMAND_WCHANGE, Console.No),
    ChatCommand("maxskill", [], HandleMaxSkillCommand, R.RBAC_PERM_COMMAND_MAXSKILL, Console.No),
    ChatCommand("setskill", [HyperlinkOrUint32(skill), int32Arg, Optional(uint16Arg)], HandleSetSkillCommand, R.RBAC_PERM_COMMAND_SETSKILL, Console.No),
    ChatCommand("pinfo", [Optional(PlayerIdentifierArg)], HandlePInfoCommand, R.RBAC_PERM_COMMAND_PINFO, Console.Yes),
    ChatCommand("respawn", [], HandleRespawnCommand, R.RBAC_PERM_COMMAND_RESPAWN, Console.No),
    ChatCommand("respawn all", [], HandleRespawnAllCommand, R.RBAC_PERM_COMMAND_RESPAWN_ALL, Console.No),
    ChatCommand("respawn creature guid", [uint32Arg], HandleRespawnCreatureByGuidCommand, R.RBAC_PERM_COMMAND_RESPAWN_CREATURE_GUID, Console.Yes),
    ChatCommand("respawn gameobject guid", [uint32Arg], HandleRespawnGameObjectByGuidCommand, R.RBAC_PERM_COMMAND_RESPAWN_GAMEOBJECT_GUID, Console.Yes),
    ChatCommand("respawn creature entry", [uint32Arg, Optional(uint32Arg), Optional(uint32Arg)], HandleRespawnCreatureByEntryCommand, R.RBAC_PERM_COMMAND_RESPAWN_CREATURE_ENTRY, Console.Yes),
    ChatCommand("respawn gameobject entry", [uint32Arg, Optional(uint32Arg), Optional(uint32Arg)], HandleRespawnGameObjectByEntryCommand, R.RBAC_PERM_COMMAND_RESPAWN_GAMEOBJECT_ENTRY, Console.Yes),
    ChatCommand("mute", [Optional(PlayerIdentifierArg), stringArg, Tail], HandleMuteCommand, R.RBAC_PERM_COMMAND_MUTE, Console.Yes),
    ChatCommand("mutehistory", [stringArg], HandleMuteInfoCommand, R.RBAC_PERM_COMMAND_MUTEHISTORY, Console.Yes),
    ChatCommand("unmute", [Optional(PlayerIdentifierArg)], HandleUnmuteCommand, R.RBAC_PERM_COMMAND_UNMUTE, Console.Yes),
    ChatCommand("movegens", [], HandleMovegensCommand, R.RBAC_PERM_COMMAND_MOVEGENS, Console.No),
    ChatCommand("cometome", [], HandleComeToMeCommand, R.RBAC_PERM_COMMAND_COMETOME, Console.No),
    ChatCommand("damage", [uint32Arg, Optional(stringArg)], HandleDamageCommand, R.RBAC_PERM_COMMAND_DAMAGE, Console.No),
    ChatCommand("combatstop", [Optional(PlayerIdentifierArg)], HandleCombatStopCommand, R.RBAC_PERM_COMMAND_COMBATSTOP, Console.Yes),
    ChatCommand("flusharenapoints", [], HandleFlushArenaPointsCommand, R.RBAC_PERM_COMMAND_FLUSHARENAPOINTS, Console.Yes),
    ChatCommand("freeze", [Optional(PlayerIdentifierArg)], HandleFreezeCommand, R.RBAC_PERM_COMMAND_FREEZE, Console.No),
    ChatCommand("unfreeze", [Optional(PlayerIdentifierArg)], HandleUnFreezeCommand, R.RBAC_PERM_COMMAND_UNFREEZE, Console.No),
    ChatCommand("possess", [], HandlePossessCommand, R.RBAC_PERM_COMMAND_POSSESS, Console.No),
    ChatCommand("unpossess", [], HandleUnPossessCommand, R.RBAC_PERM_COMMAND_UNPOSSESS, Console.No),
    ChatCommand("bindsight", [], HandleBindSightCommand, R.RBAC_PERM_COMMAND_BINDSIGHT, Console.No),
    ChatCommand("unbindsight", [], HandleUnbindSightCommand, R.RBAC_PERM_COMMAND_UNBINDSIGHT, Console.No),
    ChatCommand("playall", [uint32Arg], HandlePlayAllCommand, R.RBAC_PERM_COMMAND_PLAYALL, Console.No),
    ChatCommand("skirmish", [VectorArg(stringViewArg)], HandleSkirmishCommand, R.RBAC_PERM_COMMAND_SKIRMISH, Console.No),
    ChatCommand("mailbox", [], HandleMailBoxCommand, R.RBAC_PERM_COMMAND_MAILBOX, Console.No),
    ChatCommand("string", [uint32Arg, Optional(uint8Arg)], HandleStringCommand, R.RBAC_PERM_COMMAND_STRING, Console.No),
    ChatCommand("opendoor", [Optional(floatArg)], HandleOpenDoorCommand, R.RBAC_PERM_COMMAND_OPENDOOR, Console.No),
    ChatCommand("bm", [Optional(boolArg)], HandleBMCommand, R.RBAC_PERM_COMMAND_BEASTMASTER, Console.No),
    ChatCommand("packetlog", [Optional(PlayerIdentifierArg), Optional(boolArg)], HandlePacketLog, R.RBAC_PERM_COMMAND_PACKETLOG, Console.Yes),
  ];
}

/** @ac scripts/Commands/cs_misc.cpp misc_commandscript::HandleSkirmishCommand */
function HandleSkirmishCommand(handler: ChatHandler, args: string[]): boolean {
  const tokens = args;
  if (tokens.length === 0) {
    handler.setSentErrorMessage(true);
    return false;
  }
  let tokensItr = 0;
  const allowedArenas: string[] = [];
  const arenasStr = tokens[tokensItr++]!;
  const arenaTokens = arenasStr.split(",");
  for (const arenaName of arenaTokens) {
    if (arenaName === "all") {
      if (arenaTokens.length > 1) {
        handler.sendErrorMessage("Invalid [arena] specified.");
        return false;
      }
      allowedArenas.push("NA", "BE", "RL", "DS", "RV");
    } else if (arenaName === "NA" || arenaName === "BE" || arenaName === "RL" || arenaName === "DS" || arenaName === "RV") {
      allowedArenas.push(arenaName);
    } else {
      handler.sendErrorMessage("Invalid [arena] specified.");
      return false;
    }
  }
  let count = 0;
  if (tokensItr < tokens.length) {
    const mode = tokens[tokensItr++];
    if (mode === "1v1") count = 2;
    else if (mode === "2v2") count = 4;
    else if (mode === "3v3") count = 6;
    else if (mode === "5v5") count = 10;
  }
  if (!count) {
    handler.sendErrorMessage("Invalid bracket. Can be 1v1, 2v2, 3v3, 5v5");
    return false;
  }
  if (tokens.length !== count + 2) {
    handler.sendErrorMessage("Invalid number of nicknames for this bracket.");
    return false;
  }
  const hcnt = Math.trunc(count / 2);
  let error = 0;
  let last_name = "";
  const players: Player[] = [];
  for (; tokensItr < tokens.length; ++tokensItr) {
    last_name = tokens[tokensItr]!;
    const plr = ObjectAccessor.FindPlayerByName(last_name, false);
    if (!plr) {
      error = 1;
      break;
    }
    if (!plr.isInWorld() || plr.isBeingTeleported()) {
      error = 2;
      break;
    }
    if (Instanceable(plr.getMapId())) {
      error = 3;
      break;
    }
    // LFG and battleground queues are not ported: no player uses them (errors 4 and 5).
    if (plr.isInFlight()) {
      error = 10;
      break;
    }
    if (!plr.isAlive()) {
      error = 11;
      break;
    }
    // Groups are not ported, so no player is in one.
    if (hcnt > 1 && !plr.getGroup()) {
      error = 6;
      break;
    }
    players.push(plr);
  }
  for (let i = 0; i < players.length && !error; ++i) {
    for (let j = i + 1; j < players.length; ++j) {
      if (players[i]!.getGUID() === players[j]!.getGUID()) {
        last_name = players[i]!.getName();
        error = 13;
        break;
      }
    }
  }
  const errors: Record<number, string> = {
    1: "Player {} not found.",
    2: "Player {} is being teleported.",
    3: "Player {} is in instance/battleground/arena.",
    4: "Player {} is in LFG system.",
    5: "Player {} is queued for battleground/arena.",
    6: "Player {} is not in group.",
    7: "Player {} is not in normal group.",
    8: "Group of player {} has invalid member count.",
    9: "Players {} are not in the same group.",
    10: "Player {} is in flight.",
    11: "Player {} is dead.",
    12: "Player {} is in a group.",
    13: "Player {} occurs more than once.",
  };
  if (error) {
    handler.pSendSysMessage(errors[error]!, last_name);
    handler.setSentErrorMessage(true);
    return false;
  }
  // `sBattlegroundMgr->GetBattlegroundTemplate(BATTLEGROUND_AA)`: battlegrounds are not ported, so there is no template.
  handler.sendErrorMessage("Couldn't create arena map!");
  return false;
}

/** @ac scripts/Commands/cs_misc.cpp misc_commandscript::HandleCommentatorCommand */
function HandleCommentatorCommand(handler: ChatHandler, enableArg: boolean | null): boolean {
  const session = handler.getSession();
  if (!session) {
    handler.sendErrorMessage(L.LANG_USE_BOL);
    return false;
  }
  const SetCommentatorMod = (enable: boolean): void => {
    handler.sendNotification(enable ? "Commentator mode on" : "Commentator mode off");
    session.getPlayer()!.setCommentator(enable);
  };
  if (enableArg === null) {
    SetCommentatorMod(!isPlayerAccount(session.getSecurity()) && session.getPlayer()!.isCommentator());
    return true;
  }
  SetCommentatorMod(enableArg);
  return true;
}

/** @ac scripts/Commands/cs_misc.cpp misc_commandscript::HandleDevCommand */
function HandleDevCommand(handler: ChatHandler, enableArg: boolean | null): boolean {
  const session = handler.getSession();
  if (!session) {
    handler.sendErrorMessage(L.LANG_USE_BOL);
    return false;
  }
  const SetDevMod = (enable: boolean): void => {
    handler.sendNotification(enable ? L.LANG_DEV_ON : L.LANG_DEV_OFF);
    session.getPlayer()!.setDeveloper(enable);
  };
  if (enableArg === null) {
    SetDevMod(!isPlayerAccount(session.getSecurity()) && session.getPlayer()!.isDeveloper());
    return true;
  }
  SetDevMod(enableArg);
  return true;
}

/** @ac scripts/Commands/cs_misc.cpp misc_commandscript::HandleGPSCommand */
async function HandleGPSCommand(handler: ChatHandler, targetArg: PlayerIdentifier | null): Promise<boolean> {
  const target = targetArg ?? PlayerIdentifier.fromTargetOrSelf(handler);
  let object: CommandUnit | null = handler.getSelectedUnit();
  if (!object && !target) return false;
  if (!object && target && target.isConnected()) object = target.getConnectedPlayer();
  if (!object) return false;

  const cell = ComputeCell(object.getPositionX(), object.getPositionY());
  const player = object.toPlayer();
  const mapId = object.getMapId();
  // `object->GetZoneAndAreaId`, `IsOutdoors`, and `GetLiquidData` read the map data at the object's position
  const status = terrainStatusAt(mapId, object.getPhaseMask(), object.getPositionX(), object.getPositionY(), object.getPositionZ());
  const zoneId = status ? status.zoneid : player ? player.getZoneId() : 0;
  const areaId = status ? status.areaid : player ? player.getAreaId() : 0;
  const locale = handler.getSessionDbcLocale();
  const mapEntry = sMapStore.lookupEntry(mapId);
  const zoneEntry = sAreaTableStore.lookupEntry(zoneId);
  const areaEntry = sAreaTableStore.lookupEntry(areaId);
  const zone = Map2ZoneCoordinates(object.getPositionX(), object.getPositionY(), zoneId);
  const groundZ = getHeight(mapId, object.getPositionX(), object.getPositionY(), MAX_HEIGHT);
  const floorZ = getHeight(mapId, object.getPositionX(), object.getPositionY(), object.getPositionZ());

  const haveMap = GridTerrainLoader.existMap(mapId, cell.gridX, cell.gridY) ? 1 : 0;
  const haveVMap = GridTerrainLoader.existVMap(mapId, cell.gridX, cell.gridY) ? 1 : 0;
  // `handler->GetSession()->GetPlayer()->GetMap()->GetMapCollisionData().GetMMapData().GetNavMesh()`
  const handlerMap = terrainMapOf(handler.getSession()?.getPlayer()?.getMapId() ?? mapId);
  const haveMMAP = handlerMap?.getMapCollisionData().getMMapData().getNavMesh() ? 1 : 0;

  if (haveVMap) {
    if (status?.outdoors ?? true) handler.pSendSysMessage("You are outdoors");
    else handler.pSendSysMessage("You are indoors");
  } else {
    handler.pSendSysMessage("no VMAP available for area info");
  }

  handler.pSendSysMessage(
    L.LANG_MAP_POSITION,
    mapId,
    mapEntry ? mapEntry.name[locale] ?? "" : "<unknown>",
    zoneId,
    zoneEntry ? zoneEntry.area_name[locale] ?? "" : "<unknown>",
    areaId,
    areaEntry ? areaEntry.area_name[locale] ?? "" : "<unknown>",
    object.getPhaseMask(),
    object.getPositionX(),
    object.getPositionY(),
    object.getPositionZ(),
    object.getOrientation(),
    cell.gridX,
    cell.gridY,
    cell.cellX,
    cell.cellY,
    player ? player.getInstanceId() : 0,
    zone.x,
    zone.y,
    groundZ,
    floorZ,
    haveMap,
    haveVMap,
    haveMMAP,
  );
  const liquidData = terrainMapOf(mapId)?.getLiquidData(object.getPhaseMask(), object.getPositionX(), object.getPositionY(), object.getPositionZ(), DEFAULT_COLLISION_HEIGHT);
  if (liquidData && liquidData.Status) {
    handler.pSendSysMessage(L.LANG_LIQUID_STATUS, liquidData.Level, liquidData.DepthLevel, liquidData.Entry, liquidData.Flags, liquidData.Status);
  }
  // @ac-skip transport offset: nobody is on a transport (transports are not ported)
  return true;
}

/** @ac scripts/Commands/cs_misc.cpp misc_commandscript::HandleAuraCommand */
function HandleAuraCommand(handler: ChatHandler, spell: SpellInfo | null): boolean {
  if (!spell) {
    handler.sendErrorMessage(L.LANG_COMMAND_NOSPELLFOUND);
    return false;
  }
  if (!sSpellMgr.isSpellValid(spell)) {
    handler.sendErrorMessage(L.LANG_COMMAND_SPELL_BROKEN, spell.id);
    return false;
  }
  const target = handler.getSelectedUnit();
  if (!target) {
    handler.sendErrorMessage(L.LANG_SELECT_CHAR_OR_CREATURE);
    return false;
  }
  const unit = target.spellUnit();
  if (unit) Aura.tryRefreshStackOrCreate(spell, MAX_EFFECT_MASK, unit, unit).aura?.applyForTargetsNow();
  return true;
}

/** @ac scripts/Commands/cs_misc.cpp misc_commandscript::HandleAuraStacksCommand */
function HandleAuraStacksCommand(handler: ChatHandler, spell: SpellInfo | null, stacks: number): boolean {
  if (!spell) {
    handler.sendErrorMessage(L.LANG_COMMAND_NOSPELLFOUND);
    return false;
  }
  if (!sSpellMgr.isSpellValid(spell)) {
    handler.sendErrorMessage(L.LANG_COMMAND_SPELL_BROKEN, spell.id);
    return false;
  }
  if (!stacks) {
    handler.sendErrorMessage(L.LANG_COMMAND_AURASTACK_NO_STACK);
    return false;
  }
  const target = handler.getSelectedUnit();
  if (!target) {
    handler.sendErrorMessage(L.LANG_SELECT_CHAR_OR_CREATURE);
    return false;
  }
  const aur = target.spellUnit()?.getAura(spell.id) ?? null;
  if (!aur) {
    handler.sendErrorMessage(L.LANG_COMMAND_AURASTACK_NO_AURA, spell.id);
    return false;
  }
  if (!spell.stackAmount) {
    handler.sendErrorMessage(L.LANG_COMMAND_AURASTACK_CANT_STACK, spell.id);
    return false;
  }
  aur.modStackAmount(stacks);
  return true;
}

/** @ac scripts/Commands/cs_misc.cpp misc_commandscript::HandleUnAuraCommand */
function HandleUnAuraCommand(handler: ChatHandler, spells: VariantValue<SpellInfo | string>): boolean {
  const target = handler.getSelectedUnit();
  if (!target) {
    handler.sendErrorMessage(L.LANG_SELECT_CHAR_OR_CREATURE);
    return false;
  }
  if (spells.index === 1 && spells.value === "all") {
    target.spellUnit()?.removeAllAuras();
    return true;
  }
  if (spells.index !== 0) {
    handler.sendErrorMessage(L.LANG_COMMAND_NOSPELLFOUND);
    return false;
  }
  const spell = spells.value as SpellInfo;
  if (!sSpellMgr.isSpellValid(spell)) {
    handler.sendErrorMessage(L.LANG_COMMAND_SPELL_BROKEN, spell.id);
    return false;
  }
  target.spellUnit()?.removeAurasDueToSpell(spell.id);
  return true;
}

/** @ac scripts/Commands/cs_misc.cpp misc_commandscript::HandleAppearCommand */
async function HandleAppearCommand(handler: ChatHandler, targetArg: PlayerIdentifier | null): Promise<boolean> {
  const target = targetArg ?? PlayerIdentifier.fromTarget(handler);
  if (!target) return false;
  const _player = handler.getSession()!.getPlayer()!;
  if (target.getGUID() === _player.getGUIDLow()) {
    handler.sendErrorMessage(L.LANG_CANT_TELEPORT_SELF);
    return false;
  }
  const nameLink = handler.playerLink(target.getName());
  const targetPlayer = target.getConnectedPlayer();
  if (targetPlayer) {
    // check online security
    if (await handler.hasLowerSecurity(targetPlayer)) return false;
    const mapId = targetPlayer.getMapId();
    if (IsBattlegroundOrArena(mapId)) {
      // only allow if gm mode is on
      if (!_player.isGameMaster()) {
        handler.sendErrorMessage(L.LANG_CANNOT_GO_TO_BG_GM, nameLink);
        return false;
      }
    } else if (IsDungeon(mapId)) {
      // we have to go to instance, and can go to player only if:
      //   1) we are in his group (either as leader or as member)
      //   2) we are not bound to any group and have GM mode on
      if (_player.getGroup()) {
        if (_player.getGroup() !== targetPlayer.getGroup()) {
          handler.sendErrorMessage(L.LANG_CANNOT_GO_TO_INST_PARTY, nameLink);
          return false;
        }
      } else if (!_player.isGameMaster()) {
        handler.sendErrorMessage(L.LANG_CANNOT_GO_TO_INST_GM, nameLink);
        return false;
      }
      // Instance binds and difficulties are not ported.
    }
    handler.pSendSysMessage(L.LANG_APPEARING_AT, nameLink);
    // stop flight if need; save only in non-flight case
    if (!_player.isInFlight()) _player.saveRecallPosition();
    _player.teleportTo(mapId, targetPlayer.getPositionX(), targetPlayer.getPositionY(), targetPlayer.getPositionZ() + 0.25, _player.getOrientation());
  } else {
    // check offline security
    if (await handler.hasLowerSecurity(null, target.getGUID())) return false;
    handler.pSendSysMessage(L.LANG_APPEARING_AT, nameLink);
    // to point where player stay (if loaded)
    const pos = await LoadPositionFromDB(target.getGUID());
    if (!pos) return false;
    if (!_player.isInFlight()) _player.saveRecallPosition();
    _player.teleportTo(pos.mapId, pos.x, pos.y, pos.z, _player.getOrientation());
  }
  return true;
}

/** @ac scripts/Commands/cs_misc.cpp misc_commandscript::HandleSummonCommand */
async function HandleSummonCommand(handler: ChatHandler, targetArg: PlayerIdentifier | null): Promise<boolean> {
  const target = targetArg ?? PlayerIdentifier.fromTarget(handler);
  if (!target) return false;
  const _player = handler.getSession()!.getPlayer()!;
  if (target.getGUID() === _player.getGUIDLow()) {
    handler.sendErrorMessage(L.LANG_CANT_TELEPORT_SELF);
    return false;
  }
  const nameLink = handler.playerLink(target.getName());
  const targetPlayer = target.getConnectedPlayer();
  if (targetPlayer) {
    // check online security
    if (await handler.hasLowerSecurity(targetPlayer)) return false;
    if (targetPlayer.isBeingTeleported()) {
      handler.sendErrorMessage(L.LANG_IS_TELEPORTED, nameLink);
      return false;
    }
    const mapId = _player.getMapId();
    if (IsBattlegroundOrArena(mapId)) {
      handler.sendErrorMessage("Can't summon to a battleground!");
      return false;
    } else if (IsDungeon(mapId)) {
      // Allow GM to summon players or only other GM accounts inside instances.
      if (!sWorld().getBoolConfig(ServerConfig.CONFIG_INSTANCE_GMSUMMON_PLAYER)) {
        // pussywizard: prevent unbinding normal player's perm bind by just summoning him >_>
        if (!targetPlayer.getSession().getSecurity()) {
          handler.sendErrorMessage("Only GMs can be summoned to an instance!");
          return false;
        }
      }
      // we are in an instance, and can only summon players in our group with us as leader (groups are not ported)
      if (!_player.getGroup() || !targetPlayer.getGroup()) {
        handler.sendErrorMessage(L.LANG_CANNOT_SUMMON_TO_INST, nameLink);
        return false;
      }
    }
    handler.pSendSysMessage(L.LANG_SUMMONING, nameLink, "");
    if (handler.needReportToTarget(targetPlayer)) new ChatHandler(targetPlayer.getSession()).pSendSysMessage(L.LANG_SUMMONED_BY, handler.playerLink(_player.getName()));
    // stop flight if need; save only in non-flight case
    if (!targetPlayer.isInFlight()) targetPlayer.saveRecallPosition();
    // before GM
    const pos = _player.getClosePoint(targetPlayer.getObjectSize());
    targetPlayer.teleportTo(_player.getMapId(), pos.x, pos.y, pos.z, targetPlayer.getOrientation());
  } else {
    // check offline security
    if (await handler.hasLowerSecurity(null, target.getGUID())) return false;
    handler.pSendSysMessage(L.LANG_SUMMONING, nameLink, handler.getAcoreString(L.LANG_OFFLINE));
    // in point where GM stay
    await SavePositionInDB(
      { mapId: _player.getMapId(), x: _player.getPositionX(), y: _player.getPositionY(), z: _player.getPositionZ(), o: _player.getOrientation() },
      _player.getZoneId(),
      target.getGUID(),
    );
  }
  return true;
}

/** @ac scripts/Commands/cs_misc.cpp misc_commandscript::HandleGroupSummonCommand */
async function HandleGroupSummonCommand(handler: ChatHandler, targetArg: PlayerIdentifier | null): Promise<boolean> {
  const target = targetArg ?? PlayerIdentifier.fromTargetOrSelf(handler);
  const targetPlayer = target?.getConnectedPlayer() ?? null;
  if (!target || !targetPlayer) return false;
  // check online security
  if (await handler.hasLowerSecurity(targetPlayer)) return false;
  const group = targetPlayer.getGroup();
  const nameLink = handler.playerLink(target.getName());
  // Groups are not ported, so the target is never in one.
  if (!group) {
    handler.sendErrorMessage(L.LANG_NOT_IN_GROUP, nameLink);
    return false;
  }
  return true;
}

/** @ac scripts/Commands/cs_misc.cpp misc_commandscript::HandleCommandsCommand */
function HandleCommandsCommand(handler: ChatHandler): boolean {
  SendCommandHelpFor(handler, "");
  return true;
}

/** @ac scripts/Commands/cs_misc.cpp misc_commandscript::HandleDieCommand */
async function HandleDieCommand(handler: ChatHandler): Promise<boolean> {
  const target = handler.getSelectedUnit();
  const player = handler.getSession()!.getPlayer()!;
  if (!target || !player.getTarget()) {
    handler.sendErrorMessage(L.LANG_SELECT_CHAR_OR_CREATURE);
    return false;
  }
  const targetPlayer = target.toPlayer();
  if (targetPlayer && (await handler.hasLowerSecurity(targetPlayer))) return false;
  if (target.isAlive()) {
    if (sWorld().getBoolConfig(ServerConfig.CONFIG_DIE_COMMAND_MODE)) {
      if (target.isCreature() && handler.getSession()!.getSecurity() === SEC_CONSOLE) {
        // pussywizard
        (target as CommandCreature & { lowerPlayerDamageReq(unDamage: number): void }).lowerPlayerDamageReq(target.getMaxHealth());
      }
      target.kill(player);
    } else {
      target.dealDamage(player, target.getHealth());
    }
  }
  return true;
}

/** @ac scripts/Commands/cs_misc.cpp misc_commandscript::HandleReviveCommand */
async function HandleReviveCommand(handler: ChatHandler, targetArg: PlayerIdentifier | null): Promise<boolean> {
  const target = targetArg ?? PlayerIdentifier.fromTargetOrSelf(handler);
  if (!target) return false;
  const targetPlayer = target.getConnectedPlayer();
  if (targetPlayer) {
    targetPlayer.removeAurasDueToSpell(27827); // Spirit of Redemption
    await targetPlayer.resurrectPlayer(!isPlayerAccount(targetPlayer.getSession().getSecurity()) ? 1.0 : 0.5);
    await targetPlayer.spawnCorpseBones();
    await targetPlayer.saveToDB();
  } else {
    await OfflineResurrect(target.getGUID());
  }
  return true;
}

/** @ac game/Entities/Player/Player.cpp Player::OfflineResurrect */
async function OfflineResurrect(guid: number): Promise<void> {
  // Corpse::DeleteFromDB
  await executeStatement(CharacterDatabase(), CHAR_DEL_CORPSE, guid);
  await executeStatement(CharacterDatabase(), CHAR_UPD_ADD_AT_LOGIN_FLAG, AT_LOGIN_RESURRECT, guid);
}

/** @ac scripts/Commands/cs_misc.cpp misc_commandscript::HandleDismountCommand */
function HandleDismountCommand(handler: ChatHandler): boolean {
  const player = handler.getSession()!.getPlayer()!;
  // If player is not mounted, so go out :)
  if (!player.isMounted()) {
    handler.sendErrorMessage(L.LANG_CHAR_NON_MOUNTED);
    return false;
  }
  if (player.isInFlight()) {
    handler.sendErrorMessage(L.LANG_YOU_IN_FLIGHT);
    return false;
  }
  player.dismount();
  player.setSpeedRate(1 /* MOVE_RUN */, 1);
  player.setSpeedRate(6 /* MOVE_FLIGHT */, 1);
  return true;
}

/** @ac scripts/Commands/cs_misc.cpp misc_commandscript::HandleGUIDCommand */
function HandleGUIDCommand(handler: ChatHandler): boolean {
  const guid = handler.getSession()!.getPlayer()!.getTarget();
  if (!guid) {
    handler.sendErrorMessage(L.LANG_NO_SELECTION);
    return false;
  }
  handler.pSendSysMessage(L.LANG_OBJECT_GUID, guidToString(guid));
  return true;
}

/** @ac game/Entities/Object/ObjectGuid.cpp ObjectGuid::ToString */
function guidToString(guid: bigint): string {
  const high = Number((guid >> 48n) & 0xffffn);
  const names: Record<number, string> = { 0x0000: "Player", 0x4700: "Item", 0xf100: "Transport", 0xf110: "GameObject", 0xf120: "Transport", 0xf130: "Creature", 0xf140: "Pet", 0xf150: "Vehicle", 0xf101: "DynamicObject", 0xf500: "Corpse", 0x1fc0: "MoTransport", 0x1f10: "Instance", 0x1f50: "Group" };
  const hasEntry = high === 0xf110 || high === 0xf130 || high === 0xf140 || high === 0xf150;
  let str = `GUID Full: 0x${guid.toString(16).padStart(16, "0")} Type: ${names[high] ?? "<unknown>"}`;
  if (hasEntry) str += ` Entry: ${high === 0xf140 ? 0 : Number((guid >> 24n) & 0xffffffn)}`;
  str += ` Low: ${hasEntry ? Number(guid & 0xffffffn) : Number(guid & 0xffffffffn)}`;
  return str;
}

/** @ac scripts/Commands/cs_misc.cpp misc_commandscript::HandleHelpCommand */
function HandleHelpCommand(handler: ChatHandler, cmd: string): boolean {
  SendCommandHelpFor(handler, cmd);
  if (!cmd) SendCommandHelpFor(handler, "help");
  return true;
}

/** @ac scripts/Commands/cs_misc.cpp misc_commandscript::HandleCooldownCommand */
function HandleCooldownCommand(handler: ChatHandler, spell: SpellInfo | null): boolean {
  const target = handler.getSelectedPlayer();
  if (!target) {
    handler.sendErrorMessage(L.LANG_PLAYER_NOT_FOUND);
    return false;
  }
  const nameLink = handler.getNameLink(target);
  if (!spell) {
    target.removeAllSpellCooldown();
    handler.pSendSysMessage(L.LANG_REMOVEALL_COOLDOWN, nameLink);
  } else {
    if (!sSpellMgr.isSpellValid(spell)) {
      handler.sendErrorMessage(L.LANG_COMMAND_SPELL_BROKEN, spell.id);
      return false;
    }
    target.removeSpellCooldown(spell.id, true);
    handler.pSendSysMessage(L.LANG_REMOVE_COOLDOWN, spell.id, target === handler.getSession()!.getPlayer() ? handler.getAcoreString(L.LANG_YOU) : nameLink);
  }
  return true;
}

/** @ac scripts/Commands/cs_misc.cpp misc_commandscript::HandleGetDistanceCommand */
function HandleGetDistanceCommand(handler: ChatHandler, targetArg: PlayerIdentifier | null): boolean {
  const target = targetArg ?? PlayerIdentifier.fromTargetOrSelf(handler);
  let object: CommandUnit | null = handler.getSelectedUnit();
  if (!object && !target) return false;
  if (!object && target && target.isConnected()) object = target.getConnectedPlayer();
  if (!object) return false;
  const player = handler.getSession()!.getPlayer()!;
  const dx = object.getPositionX() - player.getPositionX();
  const dy = object.getPositionY() - player.getPositionY();
  const dz = object.getPositionZ() - player.getPositionZ();
  const exact = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const exact2d = Math.sqrt(dx * dx + dy * dy);
  // `GetDistance` subtracts both objects' combat reach (`GetObjectSize`).
  const sizes = player.getObjectSize() + (object.toPlayer()?.getObjectSize() ?? 0);
  handler.pSendSysMessage(L.LANG_DISTANCE, Math.max(0, exact - sizes), Math.max(0, exact2d - sizes), exact, exact2d);
  return true;
}

/** @ac scripts/Commands/cs_misc.cpp misc_commandscript::HandleRecallCommand */
async function HandleRecallCommand(handler: ChatHandler, targetArg: PlayerIdentifier | null): Promise<boolean> {
  const target = targetArg ?? PlayerIdentifier.fromTargetOrSelf(handler);
  const targetPlayer = target?.getConnectedPlayer() ?? null;
  if (!target || !targetPlayer) return false;
  // check online security
  if (await handler.hasLowerSecurity(targetPlayer)) return false;
  if (targetPlayer.isBeingTeleported()) {
    handler.sendErrorMessage(L.LANG_IS_TELEPORTED, handler.playerLink(target.getName()));
    return false;
  }
  const recall = targetPlayer.getRecallPosition();
  targetPlayer.teleportTo(recall.mapId, recall.x, recall.y, recall.z, recall.o);
  return true;
}

/** @ac scripts/Commands/cs_misc.cpp misc_commandscript::HandleSaveCommand */
async function HandleSaveCommand(handler: ChatHandler): Promise<boolean> {
  const player = handler.getSession()!.getPlayer()!;
  // save GM account without delay and output message
  if (handler.getSession()!.hasPermission(R.RBAC_PERM_COMMANDS_SAVE_WITHOUT_DELAY)) {
    const target = handler.getSelectedPlayer();
    if (target) await target.saveToDB();
    else await player.saveToDB();
    handler.sendSysMessage(L.LANG_PLAYER_SAVED);
    return true;
  }
  // save if the player has last been saved over 20 seconds ago
  const saveInterval = sWorld().getIntConfig(ServerConfig.CONFIG_INTERVAL_SAVE);
  if (saveInterval === 0 || (saveInterval > 20 * IN_MILLISECONDS && player.getSaveTimer() <= saveInterval - 20 * IN_MILLISECONDS)) await player.saveToDB();
  return true;
}

/** @ac scripts/Commands/cs_misc.cpp misc_commandscript::HandleSaveAllCommand */
async function HandleSaveAllCommand(handler: ChatHandler): Promise<boolean> {
  await ObjectAccessor.SaveAllPlayers();
  handler.sendSysMessage(L.LANG_PLAYERS_SAVED);
  return true;
}

/** @ac scripts/Commands/cs_misc.cpp misc_commandscript::HandleKickPlayerCommand */
async function HandleKickPlayerCommand(handler: ChatHandler, targetArg: PlayerIdentifier | null, reason: string | null): Promise<boolean> {
  const target = targetArg ?? PlayerIdentifier.fromTargetOrSelf(handler);
  const targetPlayer = target?.getConnectedPlayer() ?? null;
  if (!target || !targetPlayer) return false;
  const session = handler.getSession();
  if (session && target.getGUID() === session.getPlayer()!.getGUIDLow()) {
    handler.sendErrorMessage(L.LANG_COMMAND_KICKSELF);
    return false;
  }
  // check online security
  if (await handler.hasLowerSecurity(targetPlayer)) return false;
  let kickReasonStr = handler.getAcoreString(L.LANG_NO_REASON);
  if (reason) kickReasonStr = reason;
  if (sWorld().getBoolConfig(ServerConfig.CONFIG_SHOW_KICK_IN_WORLD)) {
    handler.sendWorldText(L.LANG_COMMAND_KICKMESSAGE_WORLD, session ? session.getPlayerName() : "Server", target.getName(), kickReasonStr);
  } else {
    handler.pSendSysMessage(L.LANG_COMMAND_KICKMESSAGE, target.getName());
  }
  targetPlayer.getSession().kickPlayer("HandleKickPlayerCommand");
  return true;
}

/** @ac scripts/Commands/cs_misc.cpp misc_commandscript::HandleUnstuckCommand */
async function HandleUnstuckCommand(handler: ChatHandler, targetArg: PlayerIdentifier | null, location: string | null): Promise<boolean> {
  // No args required for players
  const session = handler.getSession();
  if (session && isPlayerAccount(session.getSecurity())) {
    const player = session.getPlayer();
    if (player) player.castSpell(player, SPELL_STUCK, false);
    return true;
  }
  const target = targetArg ?? PlayerIdentifier.fromTargetOrSelf(handler);
  if (!target) return false;
  const player = target.getConnectedPlayer();
  if (!player) {
    if (await handler.hasLowerSecurity(null, target.getGUID())) return false;
    const [fieldsDB] = await queryFields(CharacterDatabase(), CHAR_SEL_CHARACTER_HOMEBIND, target.getGUID());
    if (fieldsDB) {
      const loc = { mapId: Number(fieldsDB[0]), x: Number(fieldsDB[2]), y: Number(fieldsDB[3]), z: Number(fieldsDB[4]), o: 0 };
      const zoneId = Number(fieldsDB[1]);
      await SavePositionInDB(loc, zoneId, target.getGUID());
      handler.pSendSysMessage(L.LANG_SUMMONING, target.getName(), handler.getAcoreString(L.LANG_OFFLINE));
    }
    return true;
  }
  if (player.isInFlight() || player.isInCombat()) {
    const spellInfo = sSpellMgr.getSpellInfo(SPELL_STUCK);
    if (!spellInfo) return false;
    // Spell::SendCastResult
    player.getSession().sendPacket(SMSG_CAST_FAILED, castFailedPacket(0, spellInfo.id, SPELL_FAILED_CANT_DO_THAT_RIGHT_NOW));
    return false;
  }
  if (!location || location === "inn") {
    const home = player.getHomebind();
    if (home) player.teleportTo(home.mapId, home.x, home.y, home.z, player.getOrientation());
    return true;
  }
  if (location === "graveyard") {
    await player.repopAtGraveyard();
    return true;
  }
  if (location === "startzone") {
    const start = player.getStartPosition();
    if (start) player.teleportTo(start.mapId, start.x, start.y, start.z, start.o);
    return true;
  }
  // Not a supported argument
  return false;
}

/** `StringEqualI(team->substr(0, 6), "horde")` / `(0, 9), "alliance"` */
function parseGraveTeam(team: string | null): TeamId | null {
  if (!team) return TEAM_NEUTRAL;
  if (stringEqualI(team.substring(0, 6), "horde")) return TEAM_HORDE;
  if (stringEqualI(team.substring(0, 9), "alliance")) return TEAM_ALLIANCE;
  return null;
}

/** @ac scripts/Commands/cs_misc.cpp misc_commandscript::HandleLinkGraveCommand */
function HandleLinkGraveCommand(handler: ChatHandler, graveyardId: number, team: string | null): boolean {
  const teamId = parseGraveTeam(team);
  if (teamId === null) return false;
  const graveyard = sGraveyard.getGraveyard(graveyardId);
  if (!graveyard) {
    handler.sendErrorMessage(L.LANG_COMMAND_GRAVEYARDNOEXIST, graveyardId);
    return false;
  }
  const player = handler.getSession()!.getPlayer()!;
  const zoneId = player.getZoneId();
  const areaEntry = sAreaTableStore.lookupEntry(zoneId);
  if (!areaEntry || areaEntry.zone !== 0) {
    handler.sendErrorMessage(L.LANG_COMMAND_GRAVEYARDWRONGZONE, graveyardId, zoneId);
    return false;
  }
  if (sGraveyard.addGraveyardLink(graveyardId, zoneId, teamId)) handler.pSendSysMessage(L.LANG_COMMAND_GRAVEYARDLINKED, graveyardId, zoneId);
  else handler.pSendSysMessage(L.LANG_COMMAND_GRAVEYARDALRLINKED, graveyardId, zoneId);
  return true;
}

/** @ac scripts/Commands/cs_misc.cpp misc_commandscript::HandleNearGraveCommand */
function HandleNearGraveCommand(handler: ChatHandler, team: string | null): boolean {
  const teamId = parseGraveTeam(team);
  if (teamId === null) return false;
  const player = handler.getSession()!.getPlayer()!;
  const zone_id = player.getZoneId();
  const graveyard = getClosestGraveyard(sGraveyard.graveyardStore(), {
    mapId: player.getMapId(),
    x: player.getPositionX(),
    y: player.getPositionY(),
    z: player.getPositionZ(),
    teamId,
    areaId: player.getAreaId(),
    zoneId: zone_id,
    isDeathKnight: player.getClass() === 6,
  });
  const teamName = (id: TeamId): string =>
    id === TEAM_NEUTRAL
      ? handler.getAcoreString(L.LANG_COMMAND_GRAVEYARD_ANY)
      : id === TEAM_HORDE
        ? handler.getAcoreString(L.LANG_COMMAND_GRAVEYARD_HORDE)
        : handler.getAcoreString(L.LANG_COMMAND_GRAVEYARD_ALLIANCE);
  if (graveyard) {
    const graveyardId = graveyard.ID;
    const data = sGraveyard.findGraveyardData(graveyardId, zone_id);
    if (!data) {
      handler.sendErrorMessage(L.LANG_COMMAND_GRAVEYARDERROR, graveyardId);
      return false;
    }
    handler.pSendSysMessage(L.LANG_COMMAND_GRAVEYARDNEAREST, graveyardId, teamName(data.teamId), zone_id);
  } else {
    handler.pSendSysMessage(L.LANG_COMMAND_ZONENOGRAFACTION, zone_id, teamName(teamId));
  }
  return true;
}

/** @ac scripts/Commands/cs_misc.cpp misc_commandscript::HandleShowAreaCommand */
function HandleShowAreaCommand(handler: ChatHandler, areaID: number): boolean {
  return exploreArea(handler, areaID, true);
}

/** @ac scripts/Commands/cs_misc.cpp misc_commandscript::HandleHideAreaCommand */
function HandleHideAreaCommand(handler: ChatHandler, areaID: number): boolean {
  return exploreArea(handler, areaID, false);
}

/** `.showarea` sets and `.hidearea` toggles the area's bit in `PLAYER_EXPLORED_ZONES_1 + offset`. */
function exploreArea(handler: ChatHandler, areaID: number, show: boolean): boolean {
  const playerTarget = handler.getSelectedPlayer();
  if (!playerTarget) {
    handler.sendErrorMessage(L.LANG_NO_CHAR_SELECTED);
    return false;
  }
  const area = sAreaTableStore.lookupEntry(areaID);
  if (!area) {
    handler.sendErrorMessage(L.LANG_BAD_VALUE);
    return false;
  }
  const offset = Math.trunc(area.exploreFlag / 32);
  if (offset >= PLAYER_EXPLORED_ZONES_SIZE) {
    handler.sendErrorMessage(L.LANG_BAD_VALUE);
    return false;
  }
  const val = (1 << area.exploreFlag % 32) >>> 0;
  const currFields = playerTarget.getUInt32Value(PLAYER_EXPLORED_ZONES_1 + offset);
  playerTarget.setUInt32Value(PLAYER_EXPLORED_ZONES_1 + offset, (show ? currFields | val : currFields ^ val) >>> 0);
  handler.sendSysMessage(show ? L.LANG_EXPLORE_AREA : L.LANG_UNEXPLORE_AREA);
  return true;
}

/** @ac scripts/Commands/cs_misc.cpp misc_commandscript::HandleAddItemCommand */
async function HandleAddItemCommand(handler: ChatHandler, playerArg: PlayerIdentifier | null, itemTemplate: ItemTemplate, _count: number | null): Promise<boolean> {
  if (!sObjectMgr.getItemTemplate(itemTemplate.entry)) {
    handler.sendErrorMessage(L.LANG_COMMAND_ITEMIDINVALID, itemTemplate.entry);
    return false;
  }
  const itemId = itemTemplate.entry;
  let count = _count ?? 1;
  if (!count) count = 1;
  const player = playerArg ?? PlayerIdentifier.fromTargetOrSelf(handler);
  if (!player) return false;
  const playerTarget = player.getConnectedPlayer();

  // Subtract
  if (count < 0) {
    const removeCount = -count;
    if (playerTarget) {
      // Only have scam check on player accounts
      if (playerTarget.getSession().getSecurity() === SEC_PLAYER) {
        if (!playerTarget.hasItemCount(itemId, 0)) {
          // output that player don't have any items to destroy
          handler.sendErrorMessage(L.LANG_REMOVEITEM_FAILURE, handler.getNameLink(playerTarget), itemId);
          return false;
        }
        if (!playerTarget.hasItemCount(itemId, removeCount)) {
          // output that player don't have as many items that you want to destroy
          handler.sendErrorMessage(L.LANG_REMOVEITEM_ERROR, handler.getNameLink(playerTarget), itemId);
          return false;
        }
      }
      // output successful amount of destroyed items
      await playerTarget.destroyItemCount(itemId, removeCount);
      handler.pSendSysMessage(L.LANG_REMOVEITEM, itemId, removeCount, handler.getNameLink(playerTarget));
      return true;
    }

    // offline target: remove the items directly from the DB
    if (await handler.hasLowerSecurity(null, player.getGUID())) return false;
    const nameLink = handler.playerLink(player.getName());
    const stacks: [number, number][] = [];
    let totalCount = 0;
    for (const fields of await queryFields(CharacterDatabase(), CHAR_SEL_CHAR_INVENTORY_STACKS_BY_ENTRY_AND_OWNER, itemId, player.getGUID())) {
      stacks.push([Number(fields[0]), Number(fields[1])]);
      totalCount += Number(fields[1]);
    }
    if (!totalCount) {
      handler.sendErrorMessage(L.LANG_REMOVEITEM_FAILURE, nameLink, itemId);
      return false;
    }
    // Only have scam check on player accounts
    const accountId = sCharacterCache.getCharacterAccountIdByGuid(player.getGUID());
    if ((await getSecurity(LoginDatabase(), accountId, realm.Id.Realm)) === SEC_PLAYER && totalCount < removeCount) {
      handler.sendErrorMessage(L.LANG_REMOVEITEM_ERROR, nameLink, itemId);
      return false;
    }
    const trans: StatementTransaction = [];
    let remaining = removeCount;
    for (const [itemGuid, stackCount] of stacks) {
      if (!remaining) break;
      if (stackCount <= remaining) {
        remaining -= stackCount;
        // Item::DeleteFromInventoryDB, Item::DeleteFromDB
        trans.push([CHAR_DEL_CHAR_INVENTORY_BY_ITEM, itemGuid], [CHAR_DEL_ITEM_INSTANCE, itemGuid]);
        trans.push([CHAR_DEL_GIFT, itemGuid], [CHAR_DEL_ITEM_REFUND_INSTANCE, itemGuid], [CHAR_DEL_ITEM_BOP_TRADE, itemGuid], [CHAR_DEL_ITEMCONTAINER_CONTAINER, itemGuid]);
      } else {
        trans.push([CHAR_UPD_ITEM_COUNT, stackCount - remaining, itemGuid]);
        remaining = 0;
      }
    }
    await commitTransaction(CharacterDatabase(), trans);
    handler.pSendSysMessage(L.LANG_REMOVEITEM, itemId, removeCount - remaining, nameLink);
    return true;
  }

  // Adding items requires the target to be online
  if (!playerTarget) {
    handler.sendErrorMessage(L.LANG_PLAYER_NOT_FOUND);
    return false;
  }
  // Adding items
  const p = handler.getSession()?.getPlayer() ?? null;
  const result = await playerTarget.addItem(itemId, count, p);
  if (!result.stored) {
    // can't add any
    handler.sendErrorMessage(L.LANG_ITEM_CANNOT_CREATE, itemId, result.noSpaceForCount);
    return false;
  }
  if (result.noSpaceForCount) handler.pSendSysMessage(L.LANG_ITEM_CANNOT_CREATE, itemId, result.noSpaceForCount);
  return true;
}

/** @ac scripts/Commands/cs_misc.cpp misc_commandscript::HandleAddItemSetCommand */
async function HandleAddItemSetCommand(handler: ChatHandler, itemSetId: number): Promise<boolean> {
  // prevent generation all items with itemset field value '0'
  if (!itemSetId) {
    handler.sendErrorMessage(L.LANG_NO_ITEMS_FROM_ITEMSET_FOUND, itemSetId);
    return false;
  }
  const player = handler.getSession()!.getPlayer()!;
  const playerTarget = handler.getSelectedPlayer() ?? player;
  let found = false;
  for (const itemTemplate of sObjectMgr.getItemTemplateStore().values()) {
    if (itemTemplate.itemSet !== itemSetId) continue;
    found = true;
    const result = await playerTarget.addItem(itemTemplate.entry, 1, player);
    if (!result.stored) {
      // Player::SendEquipError
      player.getSession().sendPacket(SMSG_INVENTORY_CHANGE_FAILURE, equipErrorPacket(result.error, itemTemplate.entry));
      handler.pSendSysMessage(L.LANG_ITEM_CANNOT_CREATE, itemTemplate.entry, 1);
    }
  }
  if (!found) {
    handler.sendErrorMessage(L.LANG_NO_ITEMS_FROM_ITEMSET_FOUND, itemSetId);
    return false;
  }
  return true;
}

const SMSG_INVENTORY_CHANGE_FAILURE = 0x112;
const EQUIP_ERR_CANT_EQUIP_LEVEL_I = 1;
const EQUIP_ERR_PURCHASE_LEVEL_TOO_LOW = 0x42;
const EQUIP_ERR_OUT_OF_RANGE = 0x2d;
const EQUIP_ERR_EVENT_AUTOEQUIP_BIND_CONFIRM = 0x53;
const EQUIP_ERR_ITEM_MAX_LIMIT_CATEGORY_COUNT_EXCEEDED = 0x4e;
const EQUIP_ERR_ITEM_MAX_LIMIT_CATEGORY_SOCKETED_EXCEEDED = 0x4f;
const EQUIP_ERR_ITEM_MAX_LIMIT_CATEGORY_EQUIPPED_EXCEEDED = 0x50;

/** @ac game/Entities/Player/PlayerStorage.cpp Player::SendEquipError (no items, the item entry for the level error) */
function equipErrorPacket(msg: number, itemId: number): Uint8Array {
  const data = new ByteWriter().writeU8(msg);
  if (msg !== 0) {
    data.writeU64(0n).writeU64(0n).writeU8(0);
    switch (msg) {
      case EQUIP_ERR_CANT_EQUIP_LEVEL_I:
      case EQUIP_ERR_PURCHASE_LEVEL_TOO_LOW:
        data.writeU32(sObjectMgr.getItemTemplate(itemId)?.requiredLevel ?? 0);
        break;
      case EQUIP_ERR_EVENT_AUTOEQUIP_BIND_CONFIRM:
        data.writeU64(0n).writeU32(0).writeU64(0n);
        break;
      case EQUIP_ERR_ITEM_MAX_LIMIT_CATEGORY_COUNT_EXCEEDED:
      case EQUIP_ERR_ITEM_MAX_LIMIT_CATEGORY_SOCKETED_EXCEEDED:
      case EQUIP_ERR_ITEM_MAX_LIMIT_CATEGORY_EQUIPPED_EXCEEDED:
        data.writeU32(sObjectMgr.getItemTemplate(itemId)?.itemLimitCategory ?? 0);
        break;
      case EQUIP_ERR_OUT_OF_RANGE:
      default:
        break;
    }
  }
  return data.toUint8Array();
}

/** @ac scripts/Commands/cs_misc.cpp misc_commandscript::HandleChangeWeather */
function HandleChangeWeather(handler: ChatHandler, _type: number, _grade: number): boolean {
  // Weather is OFF
  if (!sWorld().getBoolConfig(ServerConfig.CONFIG_WEATHER)) {
    handler.sendErrorMessage(L.LANG_WEATHER_DISABLED);
    return false;
  }
  // `Map::GetOrGenerateZoneDefaultWeather`: `game_weather` and `WeatherMgr` are not ported, so no zone has weather.
  handler.sendErrorMessage(L.LANG_NO_WEATHER);
  return false;
}

/** @ac scripts/Commands/cs_misc.cpp misc_commandscript::HandleMaxSkillCommand */
function HandleMaxSkillCommand(handler: ChatHandler): boolean {
  const SelectedPlayer = handler.getSelectedPlayer();
  if (!SelectedPlayer) {
    handler.sendErrorMessage(L.LANG_NO_CHAR_SELECTED);
    return false;
  }
  // each skills that have max skill value dependent from level seted to current level max skill value
  SelectedPlayer.updateSkillsToMaxSkillsForLevel();
  return true;
}

/** @ac scripts/Commands/cs_misc.cpp misc_commandscript::HandleSetSkillCommand */
function HandleSetSkillCommand(handler: ChatHandler, skillID: number, level: number, maxPureSkill: number | null): boolean {
  if (skillID <= 0) {
    handler.sendErrorMessage(L.LANG_INVALID_SKILL_ID, skillID);
    return false;
  }
  const target = handler.getSelectedPlayer();
  if (!target) {
    handler.sendErrorMessage(L.LANG_NO_CHAR_SELECTED);
    return false;
  }
  const skillLine = sSkillLineStore.lookupEntry(skillID);
  if (!skillLine) {
    handler.sendErrorMessage(L.LANG_INVALID_SKILL_ID, skillID);
    return false;
  }
  const targetHasSkill = target.getSkillValue(skillID) !== 0;
  // If our target does not yet have the skill they are trying to add to them, the chosen level also becomes
  // the max level of the new profession.
  const max = maxPureSkill !== null ? maxPureSkill : targetHasSkill ? target.getPureMaxSkillValue(skillID) : level & 0xffff;
  if (level <= 0 || level > max || max <= 0) return false;
  // If the player has the skill, we get the current skill step. If they don't have the skill, we
  // add the skill to the player's book with step 1 (which is the first rank, in most cases something
  // like 'Apprentice <skill>'.
  target.setSkill(skillID, targetHasSkill ? target.getSkillStep(skillID) : 1, level, max);
  handler.pSendSysMessage(L.LANG_SET_SKILL, skillID, skillLine.name[handler.getSessionDbcLocale()] ?? "", handler.getNameLink(target), level, max);
  return true;
}

const RACE_NAMES: Record<number, string> = { 1: "Human", 2: "Orc", 3: "Dwarf", 4: "Night Elf", 5: "Undead", 6: "Tauren", 7: "Gnome", 8: "Troll", 10: "Blood Elf", 11: "Draenei" };
const CLASS_NAMES: Record<number, string> = { 1: "Warrior", 2: "Paladin", 3: "Hunter", 4: "Rogue", 5: "Priest", 6: "Death Knight", 7: "Shaman", 8: "Mage", 9: "Warlock", 11: "Druid" };

/** @ac scripts/Commands/cs_misc.cpp misc_commandscript::HandlePInfoCommand */
async function HandlePInfoCommand(handler: ChatHandler, targetArg: PlayerIdentifier | null): Promise<boolean> {
  const target = targetArg ?? PlayerIdentifier.fromTargetOrSelf(handler);
  if (!target) return false;
  const playerTarget = target.getConnectedPlayer();

  // Account data print variables
  let userName = handler.getAcoreString(L.LANG_ERROR);
  const lowguid = target.getGUID();
  let accId = 0;
  let eMail = handler.getAcoreString(L.LANG_ERROR);
  let regMail = handler.getAcoreString(L.LANG_ERROR);
  let security = 0;
  let lastIp = handler.getAcoreString(L.LANG_ERROR);
  let locked = 0;
  let lastLogin = handler.getAcoreString(L.LANG_ERROR);
  let failedLogins = 0;
  let latency = 0;
  let OS = handler.getAcoreString(L.LANG_UNKNOWN);

  // Mute data print variables
  let muteTime = -1;
  let muteReason = handler.getAcoreString(L.LANG_NO_REASON);
  let muteBy = handler.getAcoreString(L.LANG_UNKNOWN);

  // Ban data print variables
  let banTime = -1;
  let banType = handler.getAcoreString(L.LANG_UNKNOWN);
  let banReason = handler.getAcoreString(L.LANG_NO_REASON);
  let bannedBy = handler.getAcoreString(L.LANG_UNKNOWN);

  // Character data print variables
  let raceid = 0;
  let classid = 0;
  let gender = 0;
  const locale = handler.getSessionDbcLocale();
  let totalPlayerTime = 0;
  let level = 0;
  let alive = handler.getAcoreString(L.LANG_ERROR);
  let money = 0;
  let xp = 0;
  let xptotal = 0;

  // Position data print
  let mapId = 0;
  let areaId = 0;
  let phase = 0;
  let areaName = "";
  let zoneName = "";

  // Guild data print variables defined so that they exist, but are not necessarily used
  let guildId = 0;
  const guildRankId = 0;
  let guildName = "";
  let guildRank = "";
  let note = "";
  let officeNote = "";

  // get additional information from Player object
  if (playerTarget) {
    // check online security
    if (await handler.hasLowerSecurity(playerTarget)) return false;
    accId = playerTarget.getSession().getAccountId();
    money = playerTarget.getMoney();
    totalPlayerTime = playerTarget.getTotalPlayedTime();
    level = playerTarget.getLevel();
    latency = playerTarget.getSession().getLatency();
    raceid = playerTarget.getRace();
    classid = playerTarget.getClass();
    muteTime = playerTarget.getSession().muteTime;
    mapId = playerTarget.getMapId();
    areaId = playerTarget.getAreaId();
    alive = playerTarget.isAlive() ? handler.getAcoreString(L.LANG_YES) : handler.getAcoreString(L.LANG_NO);
    gender = playerTarget.getGender();
    phase = playerTarget.getPhaseMask();
  } else {
    // get additional information from DB
    // check offline security
    if (await handler.hasLowerSecurity(null, target.getGUID())) return false;
    // Query informations from the DB
    const [fields] = await queryFields(CharacterDatabase(), CHAR_SEL_CHAR_PINFO, lowguid);
    if (!fields) return false;
    totalPlayerTime = Number(fields[0]);
    level = Number(fields[1]);
    money = Number(fields[2]);
    accId = Number(fields[3]);
    raceid = Number(fields[4]);
    classid = Number(fields[5]);
    mapId = Number(fields[6]);
    areaId = Number(fields[7]);
    gender = Number(fields[8]);
    const health = Number(fields[9]);
    const playerFlags = Number(fields[10]);
    alive = !health || playerFlags & PLAYER_FLAGS_GHOST ? handler.getAcoreString(L.LANG_NO) : handler.getAcoreString(L.LANG_YES);
  }

  // Query the prepared statement for login data
  const [accInfo] = await queryFields(LoginDatabase(), LOGIN_SEL_PINFO, realm.Id.Realm, accId);
  if (accInfo) {
    userName = String(accInfo[0] ?? "");
    security = Number(accInfo[1] ?? 0);
    // Only fetch these fields if commander has sufficient rights)
    const session = handler.getSession();
    if (!session || session.getSecurity() >= security) {
      eMail = String(accInfo[2] ?? "");
      regMail = String(accInfo[3] ?? "");
      lastIp = String(accInfo[4] ?? "");
      lastLogin = String(accInfo[5] ?? "");
      // `sIPLocation` needs the IP2Location CSV (`IPLocationFile`), which this server does not load.
    } else {
      eMail = handler.getAcoreString(L.LANG_UNAUTHORIZED);
      regMail = handler.getAcoreString(L.LANG_UNAUTHORIZED);
      lastIp = handler.getAcoreString(L.LANG_UNAUTHORIZED);
      lastLogin = handler.getAcoreString(L.LANG_UNAUTHORIZED);
    }
    muteTime = Number(accInfo[6] ?? 0);
    muteReason = String(accInfo[7] ?? "");
    muteBy = String(accInfo[8] ?? "");
    failedLogins = Number(accInfo[9] ?? 0);
    locked = Number(accInfo[10] ?? 0);
    OS = String(accInfo[11] ?? "");
  }

  // Creates a chat link to the character. Returns nameLink
  const nameLink = handler.playerLink(target.getName());

  // Returns banType, banTime, bannedBy, banreason
  let [banned] = await queryFields(LoginDatabase(), LOGIN_SEL_PINFO_BANS, accId);
  if (!banned) {
    banType = handler.getAcoreString(L.LANG_CHARACTER);
    [banned] = await queryFields(CharacterDatabase(), CHAR_SEL_PINFO_BANS, lowguid);
  }
  if (banned) {
    banTime = Number(banned[1]) ? 0 : Number(banned[0]);
    bannedBy = String(banned[2] ?? "");
    banReason = String(banned[3] ?? "");
  }

  // Can be used to query data from World database
  const xpRow = sObjectMgr.worldTables()?.first(player_xp_for_level, "Level", level);
  if (xpRow) xptotal = xpRow.Experience;

  // Can be used to query data from Characters database
  const [charXp] = await queryFields(CharacterDatabase(), CHAR_SEL_PINFO_XP, lowguid);
  if (charXp) {
    xp = Number(charXp[0]);
    const gguid = Number(charXp[1] ?? 0);
    if (gguid !== 0) {
      const [guildInfo] = await queryFields(CharacterDatabase(), CHAR_SEL_GUILD_MEMBER_EXTENDED, lowguid);
      if (guildInfo) {
        guildId = Number(guildInfo[0]);
        guildName = String(guildInfo[1] ?? "");
        guildRank = String(guildInfo[2] ?? "");
        note = String(guildInfo[3] ?? "");
        officeNote = String(guildInfo[4] ?? "");
      }
    }
  }

  const now = Math.floor(Date.now() / 1000);
  // Initiate output
  // Output I. LANG_PINFO_PLAYER
  handler.pSendSysMessage(L.LANG_PINFO_PLAYER, playerTarget ? "" : handler.getAcoreString(L.LANG_OFFLINE), nameLink, guidToString(BigInt(lowguid)));
  // Output II. LANG_PINFO_GM_ACTIVE if character is gamemaster
  if (playerTarget && playerTarget.isGameMaster()) handler.pSendSysMessage(L.LANG_PINFO_GM_ACTIVE);
  // Output III. LANG_PINFO_BANNED if ban exists and is applied
  if (banTime >= 0) {
    handler.pSendSysMessage(L.LANG_PINFO_BANNED, banType, banReason, banTime > 0 ? secsToTimeString(banTime - now, true) : handler.getAcoreString(L.LANG_PERMANENTLY), bannedBy);
  }
  // Output IV. LANG_PINFO_MUTED if mute is applied
  if (muteTime > 0) handler.pSendSysMessage(L.LANG_PINFO_MUTED, muteReason, secsToTimeString(muteTime - now, true), muteBy);
  // Output V. LANG_PINFO_ACC_ACCOUNT
  handler.pSendSysMessage(L.LANG_PINFO_ACC_ACCOUNT, userName, accId, security);
  if (playerTarget) {
    const accountFlags = playerTarget.getSession().getAccountFlags();
    handler.pSendSysMessage(L.LANG_ACCOUNT_FLAGS_PINFO);
    for (let i = 0; i < MAX_ACCOUNT_FLAG; i++) {
      if (accountFlags & (1 << i)) handler.pSendSysMessage(L.LANG_SUBCMDS_LIST_ENTRY, accountFlagNames[i]?.full ?? "");
    }
  }
  // Output VI. LANG_PINFO_ACC_LASTLOGIN
  handler.pSendSysMessage(L.LANG_PINFO_ACC_LASTLOGIN, lastLogin, failedLogins);
  // Output VII. LANG_PINFO_ACC_OS
  handler.pSendSysMessage(L.LANG_PINFO_ACC_OS, OS, latency);
  // Output VIII. LANG_PINFO_ACC_REGMAILS
  handler.pSendSysMessage(L.LANG_PINFO_ACC_REGMAILS, regMail, eMail);
  // Output IX. LANG_PINFO_ACC_IP
  handler.pSendSysMessage(L.LANG_PINFO_ACC_IP, lastIp, locked ? handler.getAcoreString(L.LANG_YES) : handler.getAcoreString(L.LANG_NO));
  // Output X. LANG_PINFO_CHR_LEVEL
  if (level !== sWorld().getIntConfig(ServerConfig.CONFIG_MAX_PLAYER_LEVEL)) handler.pSendSysMessage(L.LANG_PINFO_CHR_LEVEL_LOW, level, xp, xptotal, (xptotal - xp) >>> 0);
  else handler.pSendSysMessage(L.LANG_PINFO_CHR_LEVEL_HIGH, level);
  // Output XI. LANG_PINFO_CHR_RACE
  const raceStr = RACE_NAMES[raceid] ?? "";
  const classStr = CLASS_NAMES[classid] ?? handler.getAcoreString(L.LANG_UNKNOWN);
  handler.pSendSysMessage(
    L.LANG_PINFO_CHR_RACE,
    gender === 0 ? handler.getAcoreString(L.LANG_CHARACTER_GENDER_MALE) : handler.getAcoreString(L.LANG_CHARACTER_GENDER_FEMALE),
    raceStr,
    classStr,
  );
  // Output XII. LANG_PINFO_CHR_ALIVE
  handler.pSendSysMessage(L.LANG_PINFO_CHR_ALIVE, alive);
  // Output XIII. LANG_PINFO_CHR_PHASE if player is not in GM mode (GM is in every phase)
  if (playerTarget && !playerTarget.isGameMaster()) handler.pSendSysMessage(L.LANG_PINFO_CHR_PHASE, phase);
  // Output XIV. LANG_PINFO_CHR_MONEY
  const gold = Math.trunc(money / GOLD);
  const silv = Math.trunc((money % GOLD) / SILVER);
  const copp = (money % GOLD) % SILVER;
  handler.pSendSysMessage(L.LANG_PINFO_CHR_MONEY, gold, silv, copp);
  // Position data
  const map = sMapStore.lookupEntry(mapId);
  const area = sAreaTableStore.lookupEntry(areaId);
  if (area) {
    zoneName = area.area_name[locale] ?? "";
    const zone = sAreaTableStore.lookupEntry(area.zone);
    if (zone) {
      areaName = zoneName;
      zoneName = zone.area_name[locale] ?? "";
    }
  }
  if (!zoneName) zoneName = handler.getAcoreString(L.LANG_UNKNOWN);
  const mapName = map?.name[locale] ?? "";
  if (areaName) handler.pSendSysMessage(L.LANG_PINFO_CHR_MAP_WITH_AREA, mapName, zoneName, areaName);
  else handler.pSendSysMessage(L.LANG_PINFO_CHR_MAP, mapName, zoneName);
  // Output XVII. - XVIX. if they are not empty
  if (guildName) {
    handler.pSendSysMessage(L.LANG_PINFO_CHR_GUILD, guildName, guildId);
    handler.pSendSysMessage(L.LANG_PINFO_CHR_GUILD_RANK, guildRank, guildRankId);
    if (note) handler.pSendSysMessage(L.LANG_PINFO_CHR_GUILD_NOTE, note);
    if (officeNote) handler.pSendSysMessage(L.LANG_PINFO_CHR_GUILD_ONOTE, officeNote);
  }
  // Output XX. LANG_PINFO_CHR_PLAYEDTIME
  handler.pSendSysMessage(L.LANG_PINFO_CHR_PLAYEDTIME, secsToTimeString(totalPlayerTime, true));
  // Output XXI. LANG_PINFO_CHR_ONLINETIME (only for online players)
  if (playerTarget) handler.pSendSysMessage(L.LANG_PINFO_CHR_ONLINETIME, secsToTimeString(now - playerTarget.getLoginTime(), true));
  // Mail Data - an own query, because it may or may not be useful.
  const [mailInfo] = await queryFields(CharacterDatabase(), CHAR_SEL_PINFO_MAILS, lowguid);
  if (mailInfo) {
    const readmail = Math.trunc(Number(mailInfo[0] ?? 0));
    const totalmail = Number(mailInfo[1] ?? 0);
    // Output XXI. LANG_INFO_CHR_MAILS if at least one mail is given
    if (totalmail >= 1) handler.pSendSysMessage(L.LANG_PINFO_CHR_MAILS, readmail, totalmail);
  }
  return true;
}

/** `sMapMgr->FindMap(mapId, 0)`: a continent is loaded while a player is on it; the command's own map comes first. */
function findMapCreatures(handler: ChatHandler, mapId: number): CommandCreature[] | null {
  const own = handler.getSession()?.getPlayer();
  if (own && own.getMapId() === mapId) return own.getMapCreatures();
  if (Instanceable(mapId)) return null;
  const onMap = ObjectAccessor.GetPlayers().find((player) => player.getMapId() === mapId);
  return onMap ? onMap.getMapCreatures() : null;
}

/** @ac scripts/Commands/cs_misc.cpp misc_commandscript::HandleRespawnCreatureByGuidCommand */
function HandleRespawnCreatureByGuidCommand(handler: ChatHandler, spawnId: number): boolean {
  const creData = sObjectMgr.getCreatureData(spawnId);
  if (!creData) {
    handler.sendErrorMessage(L.LANG_RESPAWN_GUID_CREATURE_NOT_FOUND, spawnId);
    return false;
  }
  const creatures = findMapCreatures(handler, creData.map);
  if (!creatures) {
    handler.pSendSysMessage(L.LANG_RESPAWN_GUID_MAP_NOT_LOADED, creData.map);
    return true;
  }
  const creBounds = creatures.filter((creature) => creature.getSpawnId() === spawnId);
  // First pass: check if any instance is alive
  if (creBounds.some((creature) => creature.isAlive())) {
    handler.pSendSysMessage(L.LANG_RESPAWN_GUID_CREATURE_ALIVE, spawnId, creData.id);
    return true;
  }
  // Second pass: respawn any dead corpses in the world (a creature waiting for its respawn time is a dead unit here)
  for (const creature of creBounds) if (creature.isDead()) creature.respawn();
  handler.pSendSysMessage(L.LANG_RESPAWN_GUID_CREATURE_QUEUED, spawnId, creData.id);
  return true;
}

/** @ac scripts/Commands/cs_misc.cpp misc_commandscript::HandleRespawnGameObjectByGuidCommand */
function HandleRespawnGameObjectByGuidCommand(handler: ChatHandler, spawnId: number): boolean {
  const goData = sObjectMgr.getGameObjectData(spawnId);
  if (!goData) {
    handler.sendErrorMessage(L.LANG_RESPAWN_GUID_GAMEOBJECT_NOT_FOUND, spawnId);
    return false;
  }
  if (!findMapCreatures(handler, goData.map)) {
    handler.pSendSysMessage(L.LANG_RESPAWN_GUID_MAP_NOT_LOADED, goData.map);
    return true;
  }
  // Gameobjects are never despawned in this server (no `GameObject::Delete` on use), so every shown spawn is active.
  if (sObjectMgr.getShownGameObjectSpawn(spawnId)) {
    handler.pSendSysMessage(L.LANG_RESPAWN_GUID_GAMEOBJECT_ACTIVE, spawnId, goData.id);
    return true;
  }
  handler.pSendSysMessage(L.LANG_RESPAWN_GUID_GAMEOBJECT_QUEUED, spawnId, goData.id);
  return true;
}

/** @ac scripts/Commands/cs_misc.cpp misc_commandscript::HandleRespawnCreatureByEntryCommand */
function HandleRespawnCreatureByEntryCommand(handler: ChatHandler, entry: number, mapIdArg: number | null, _instanceIdArg: number | null): boolean {
  if (!sObjectMgr.getCreatureTemplate(entry)) {
    handler.sendErrorMessage(L.LANG_RESPAWN_ENTRY_CREATURE_NOT_FOUND, entry);
    return false;
  }
  let creatures: CommandCreature[] | null;
  const session = handler.getSession();
  if (session) {
    // In-game: always use the player's current map
    creatures = session.getPlayer()!.getMapCreatures();
  } else {
    // Console: mapId required, instanceId optional
    if (mapIdArg === null) {
      handler.sendSysMessage(L.LANG_LIST_RESPAWNS_NO_MAP);
      return false;
    }
    creatures = findMapCreatures(handler, mapIdArg);
  }
  if (!creatures) {
    handler.pSendSysMessage(L.LANG_RESPAWN_GUID_MAP_NOT_LOADED, mapIdArg ?? 0);
    return false;
  }
  let count = 0;
  // Respawn dead corpses and the spawns waiting for their respawn time.
  for (const creature of creatures) {
    const data = sObjectMgr.getCreatureData(creature.getSpawnId());
    if (!data || data.id !== entry) continue;
    if (creature.isDead()) {
      creature.respawn();
      ++count;
    }
  }
  handler.pSendSysMessage(L.LANG_RESPAWN_ENTRY_CREATURE_QUEUED, count, entry);
  return true;
}

/** @ac scripts/Commands/cs_misc.cpp misc_commandscript::HandleRespawnGameObjectByEntryCommand */
function HandleRespawnGameObjectByEntryCommand(handler: ChatHandler, entry: number, mapIdArg: number | null, _instanceIdArg: number | null): boolean {
  if (!sObjectMgr.getGameObjectTemplate(entry)) {
    handler.sendErrorMessage(L.LANG_RESPAWN_ENTRY_GAMEOBJECT_NOT_FOUND, entry);
    return false;
  }
  const session = handler.getSession();
  if (!session) {
    // Console: mapId required, instanceId optional
    if (mapIdArg === null) {
      handler.sendSysMessage(L.LANG_LIST_RESPAWNS_NO_MAP);
      return false;
    }
    if (!findMapCreatures(handler, mapIdArg)) {
      handler.pSendSysMessage(L.LANG_RESPAWN_GUID_MAP_NOT_LOADED, mapIdArg);
      return false;
    }
  }
  // Gameobjects are never despawned in this server, so none is waiting to respawn.
  handler.pSendSysMessage(L.LANG_RESPAWN_ENTRY_GAMEOBJECT_QUEUED, 0, entry);
  return true;
}

/** @ac scripts/Commands/cs_misc.cpp misc_commandscript::HandleRespawnCommand */
function HandleRespawnCommand(handler: ChatHandler): boolean {
  const player = handler.getSession()!.getPlayer()!;
  const target = handler.getSelectedUnit();
  if (player.getTarget() && target) {
    if (!target.isCreature() || target.isPet()) {
      handler.sendErrorMessage(L.LANG_SELECT_CREATURE);
      return false;
    }
    const creature = target as CommandCreature;
    if (creature.isDead()) creature.respawn();
    return true;
  }
  handler.sendErrorMessage(L.LANG_SELECT_CREATURE);
  return false;
}

/** @ac scripts/Commands/cs_misc.cpp misc_commandscript::HandleRespawnAllCommand */
function HandleRespawnAllCommand(handler: ChatHandler): boolean {
  const player = handler.getSession()!.getPlayer()!;
  // Phase 1: respawn creatures that still have corpses in the grid (`Cell::VisitObjects` over the grid activation range)
  // Phase 2: force-respawn creatures of the player's grid waiting for their respawn time
  const range = visibilityDistance(player.getMapId());
  const gridId = ComputeGridId(player.getPositionX(), player.getPositionY());
  for (const creature of player.getMapCreatures()) {
    if (!creature.isDead()) continue;
    const inRange = player.getDistance(creature) <= range;
    const data = sObjectMgr.getCreatureData(creature.getSpawnId());
    const inGrid = data !== null && ComputeGridId(data.position_x, data.position_y) === gridId;
    if (inRange || inGrid) creature.respawn();
  }
  return true;
}

/** @ac scripts/Commands/cs_misc.cpp misc_commandscript::HandleMuteCommand */
async function HandleMuteCommand(handler: ChatHandler, playerArg: PlayerIdentifier | null, notSpeakTime: string, muteReason: string): Promise<boolean> {
  let muteReasonStr = muteReason;
  if (!notSpeakTime) return false;
  if (parseIntOr0(notSpeakTime) < 0) {
    handler.sendErrorMessage(L.LANG_BAD_VALUE);
    return false;
  }
  if (!muteReason) muteReasonStr = handler.getAcoreString(L.LANG_NO_REASON);
  const player = playerArg ?? PlayerIdentifier.fromTarget(handler);
  if (!player) {
    handler.sendErrorMessage(L.LANG_PLAYER_NOT_FOUND);
    return false;
  }
  let target = player.getConnectedPlayer();
  const accountId = target ? target.getSession().getAccountId() : sCharacterCache.getCharacterAccountIdByGuid(player.getGUID());
  // find only player from same account if any
  if (!target) target = sWorldSessionMgr.FindSession(accountId)?.getPlayer() ?? null;
  // must have strong lesser security level
  if (await handler.hasLowerSecurity(target, player.getGUID(), true)) return false;
  let muteDuration = timeStringToSecs(notSpeakTime);
  if (muteDuration <= 0) muteDuration = parseIntOr0(notSpeakTime);
  if (muteDuration <= 0) {
    handler.sendErrorMessage(L.LANG_BAD_VALUE);
    return false;
  }
  const session = handler.getSession();
  const muteBy = session ? session.getPlayerName() : handler.getAcoreString(L.LANG_CONSOLE);
  let muteTimeValue: number;
  if (target) {
    // Target is online, mute will be in effect right away.
    const muteTime = Math.floor(Date.now() / 1000) + muteDuration;
    target.getSession().muteTime = muteTime;
    muteTimeValue = muteTime;
    const nameLink = handler.playerLink(player.getName());
    if (sWorld().getBoolConfig(ServerConfig.CONFIG_SHOW_MUTE_IN_WORLD)) {
      handler.sendWorldText(L.LANG_COMMAND_MUTEMESSAGE_WORLD, muteBy, nameLink, secsToTimeString(muteDuration, true), muteReasonStr);
    }
    new ChatHandler(target.getSession()).pSendSysMessage(L.LANG_YOUR_CHAT_DISABLED, secsToTimeString(muteDuration, true), muteBy, muteReasonStr);
  } else {
    // Target is offline, mute will be in effect starting from the next login.
    muteTimeValue = -muteDuration;
  }
  await executeStatement(LoginDatabase(), LOGIN_UPD_MUTE_TIME, muteTimeValue, muteReasonStr, muteBy, accountId);
  await executeStatement(LoginDatabase(), LOGIN_INS_ACCOUNT_MUTE, accountId, Math.trunc(muteDuration / MINUTE), muteBy, muteReasonStr);
  const nameLink = handler.playerLink(player.getName());
  if (sWorld().getBoolConfig(ServerConfig.CONFIG_SHOW_MUTE_IN_WORLD) && !target) {
    handler.sendWorldText(L.LANG_COMMAND_MUTEMESSAGE_WORLD, muteBy, nameLink, secsToTimeString(muteDuration, true), muteReasonStr);
  } else {
    // pussywizard: notify all online GMs
    for (const gm of ObjectAccessor.GetPlayers()) {
      if (gm.getSession().getSecurity()) {
        new ChatHandler(gm.getSession()).pSendSysMessage(
          target ? L.LANG_YOU_DISABLE_CHAT : L.LANG_COMMAND_DISABLE_CHAT_DELAYED,
          session ? session.getPlayerName() : handler.getAcoreString(L.LANG_CONSOLE),
          nameLink,
          secsToTimeString(muteDuration, true),
          muteReasonStr,
        );
      }
    }
  }
  return true;
}

/** `Acore::StringTo<int32>(str).value_or(0)` */
function parseIntOr0(str: string): number {
  return /^[+-]?\d+$/.test(str) ? Number.parseInt(str, 10) | 0 : 0;
}

/** @ac scripts/Commands/cs_misc.cpp misc_commandscript::HandleUnmuteCommand */
async function HandleUnmuteCommand(handler: ChatHandler, targetArg: PlayerIdentifier | null): Promise<boolean> {
  const target = targetArg ?? PlayerIdentifier.fromTargetOrSelf(handler);
  if (!target) return false;
  let playerTarget = target.getConnectedPlayer();
  const accountId = playerTarget ? playerTarget.getSession().getAccountId() : sCharacterCache.getCharacterAccountIdByGuid(target.getGUID());
  // find only player from same account if any
  if (!playerTarget) playerTarget = sWorldSessionMgr.FindSession(accountId)?.getPlayer() ?? null;
  // must have strong lesser security level
  if (await handler.hasLowerSecurity(playerTarget, target.getGUID(), true)) return false;
  if (playerTarget) {
    if (playerTarget.canSpeak()) {
      handler.sendErrorMessage(L.LANG_CHAT_ALREADY_ENABLED);
      return false;
    }
    playerTarget.getSession().muteTime = 0;
  }
  await executeStatement(LoginDatabase(), LOGIN_UPD_MUTE_TIME, 0, "", "", accountId);
  if (playerTarget) new ChatHandler(playerTarget.getSession()).pSendSysMessage(L.LANG_YOUR_CHAT_ENABLED);
  handler.pSendSysMessage(L.LANG_YOU_ENABLE_CHAT, handler.playerLink(target.getName()));
  return true;
}

/** @ac scripts/Commands/cs_misc.cpp misc_commandscript::HandleMuteInfoCommand */
async function HandleMuteInfoCommand(handler: ChatHandler, accountNameArg: string): Promise<boolean> {
  const accountName = utf8ToUpperOnlyLatin(accountNameArg);
  if (!accountName) {
    handler.sendErrorMessage(L.LANG_ACCOUNT_NOT_EXIST, accountNameArg);
    return false;
  }
  const accountId = await getId(LoginDatabase(), accountName);
  if (!accountId) {
    handler.pSendSysMessage(L.LANG_ACCOUNT_NOT_EXIST, accountName);
    return false;
  }
  return HandleMuteInfoHelper(handler, accountId, accountName);
}

/** @ac scripts/Commands/cs_misc.cpp misc_commandscript::HandleMuteInfoHelper */
async function HandleMuteInfoHelper(handler: ChatHandler, accountId: number, accountName: string): Promise<boolean> {
  const result = await queryFields(LoginDatabase(), LOGIN_SEL_ACCOUNT_MUTE_INFO, accountId);
  if (result.length === 0) {
    handler.pSendSysMessage(L.LANG_COMMAND_MUTEHISTORY_EMPTY, accountName);
    return true;
  }
  handler.pSendSysMessage(L.LANG_COMMAND_MUTEHISTORY, accountName);
  for (const fields of result) {
    handler.pSendSysMessage(L.LANG_COMMAND_MUTEHISTORY_OUTPUT, timeToHumanReadable(Number(fields[0])), Number(fields[1]), String(fields[2] ?? ""), String(fields[3] ?? ""));
  }
  return true;
}

/** @ac scripts/Commands/cs_misc.cpp misc_commandscript::HandleMovegensCommand */
function HandleMovegensCommand(handler: ChatHandler): boolean {
  const unit = handler.getSelectedUnit();
  if (!unit) {
    handler.sendErrorMessage(L.LANG_SELECT_CHAR_OR_CREATURE);
    return false;
  }
  handler.pSendSysMessage(L.LANG_MOVEGENS_LIST, unit.isPlayer() ? "Player" : "Creature", guidToString(unit.getGUID()));
  // `MotionMaster` slots: IDLE (the spawn's `MovementType` for a creature), ACTIVE (chase, home, or a point), CONTROLLED.
  const slots: (number | null)[] = [IDLE_MOTION_TYPE, null, null];
  let destination: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 };
  let victim: number | null = null;
  const creature = unit.isCreature() ? (unit as CommandCreature) : null;
  if (creature) {
    const data = sObjectMgr.getCreatureData(creature.getSpawnId());
    const movementType = data?.MovementType ?? 0;
    slots[0] = movementType === 1 ? RANDOM_MOTION_TYPE : movementType === 2 ? WAYPOINT_MOTION_TYPE : IDLE_MOTION_TYPE;
    const motion = creature.motion();
    if (motion) {
      if (motion.destination) destination = motion.destination;
      if (motion.home || motion.evading) slots[1] = HOME_MOTION_TYPE;
      else if (motion.victim !== null) {
        slots[1] = CHASE_MOTION_TYPE;
        victim = motion.victim;
      } else if (motion.moving) slots[1] = POINT_MOTION_TYPE;
    }
  }
  for (let i = 0; i < MAX_MOTION_SLOT; ++i) {
    const type = slots[i];
    if (type === null || type === undefined) {
      handler.sendSysMessage("Empty");
      continue;
    }
    switch (type) {
      case IDLE_MOTION_TYPE:
        handler.sendSysMessage(L.LANG_MOVEGENS_IDLE);
        break;
      case RANDOM_MOTION_TYPE:
        handler.sendSysMessage(L.LANG_MOVEGENS_RANDOM);
        break;
      case WAYPOINT_MOTION_TYPE:
        handler.sendSysMessage(L.LANG_MOVEGENS_WAYPOINT);
        break;
      case CHASE_MOTION_TYPE: {
        const target = victim !== null ? ObjectAccessor.FindPlayerByLowGUID(victim) : null;
        if (!target) handler.sendSysMessage(L.LANG_MOVEGENS_CHASE_NULL);
        else handler.pSendSysMessage(L.LANG_MOVEGENS_CHASE_PLAYER, target.getName(), guidToString(target.getGUID()));
        break;
      }
      case HOME_MOTION_TYPE:
        if (unit.isCreature()) handler.pSendSysMessage(L.LANG_MOVEGENS_HOME_CREATURE, destination.x, destination.y, destination.z);
        else handler.sendSysMessage(L.LANG_MOVEGENS_HOME_PLAYER);
        break;
      case POINT_MOTION_TYPE:
        handler.pSendSysMessage(L.LANG_MOVEGENS_POINT, destination.x, destination.y, destination.z);
        break;
      default:
        handler.pSendSysMessage(L.LANG_MOVEGENS_UNKNOWN, type);
        break;
    }
  }
  return true;
}

/** @ac scripts/Commands/cs_misc.cpp misc_commandscript::HandleComeToMeCommand */
function HandleComeToMeCommand(handler: ChatHandler): boolean {
  const caster = handler.getSelectedCreature();
  if (!caster) {
    handler.sendErrorMessage(L.LANG_SELECT_CREATURE);
    return false;
  }
  const player = handler.getSession()!.getPlayer()!;
  caster.movePoint(0, player.getPositionX(), player.getPositionY(), player.getPositionZ());
  return true;
}

/** @ac scripts/Commands/cs_misc.cpp misc_commandscript::HandleDamageCommand */
async function HandleDamageCommand(handler: ChatHandler, damageArg: number, percent: string | null): Promise<boolean> {
  let damage = damageArg;
  const target = handler.getSelectedUnit();
  const player = handler.getSession()!.getPlayer()!;
  if (!target || !player.getTarget()) {
    handler.sendErrorMessage(L.LANG_SELECT_CHAR_OR_CREATURE);
    return false;
  }
  const targetPlayer = target.toPlayer();
  if (targetPlayer && (await handler.hasLowerSecurity(targetPlayer))) return false;
  if (!target.isAlive() || !damage) return true;
  if (target.isCreature() && handler.getSession()!.getSecurity() === SEC_CONSOLE) {
    // pussywizard
    (target as CommandCreature).lowerPlayerDamageReq(target.getMaxHealth());
  }
  if (percent && stringStartsWith("pct", percent) && damage <= 100) damage = Math.trunc((target.getMaxHealth() * damage) / 100);
  target.dealDamage(player, damage);
  if (target !== player) {
    // Unit::SendAttackStateUpdate(HITINFO_AFFECTS_VICTIM, target, 1, SPELL_SCHOOL_MASK_NORMAL, damage, 0, 0, VICTIMSTATE_HIT, 0)
    const body = attackerStateUpdate({
      hitInfo: HITINFO_AFFECTS_VICTIM,
      attacker: player.getGUID(),
      target: target.getGUID(),
      damages: [
        { schoolMask: SPELL_SCHOOL_MASK_NORMAL, damage, absorb: 0, resist: 0 },
        { schoolMask: 0, damage: 0, absorb: 0, resist: 0 },
      ],
      targetHealth: target.getHealth(),
      targetState: VICTIMSTATE_HIT,
      blocked: 0,
    });
    player.sendMessageToSet(SMSG_ATTACKERSTATEUPDATE, body, true);
  }
  return true;
}

/** @ac scripts/Commands/cs_misc.cpp misc_commandscript::HandleCombatStopCommand */
async function HandleCombatStopCommand(handler: ChatHandler, targetArg: PlayerIdentifier | null): Promise<boolean> {
  const target = targetArg ?? PlayerIdentifier.fromTargetOrSelf(handler);
  const playerTarget = target?.getConnectedPlayer() ?? null;
  if (!target || !playerTarget) {
    handler.sendErrorMessage(L.LANG_PLAYER_NOT_FOUND);
    return false;
  }
  // check online security
  if (await handler.hasLowerSecurity(playerTarget)) return false;
  // `CombatStop` and `GetThreatMgr().RemoveMeFromThreatLists()`
  playerTarget.combatStop();
  return true;
}

/** @ac scripts/Commands/cs_misc.cpp misc_commandscript::HandleFlushArenaPointsCommand */
function HandleFlushArenaPointsCommand(_handler: ChatHandler): boolean {
  // `sArenaTeamMgr->DistributeArenaPoints()`: arena teams are not ported, so there are no points to distribute.
  return true;
}

/** @ac scripts/Commands/cs_misc.cpp misc_commandscript::HandleFreezeCommand */
function HandleFreezeCommand(handler: ChatHandler, targetArg: PlayerIdentifier | null): boolean {
  const creatureTarget = handler.getSelectedCreature();
  let target = targetArg;
  if (!target && !creatureTarget) target = PlayerIdentifier.fromTargetOrSelf(handler);
  if (!target && !creatureTarget) {
    handler.sendErrorMessage(L.LANG_SELECT_CHAR_OR_CREATURE);
    return false;
  }
  const playerTarget = target?.getConnectedPlayer() ?? null;
  const spellInfo = sSpellMgr.getSpellInfo(SPELL_FREEZE);
  if (playerTarget && !creatureTarget) {
    handler.pSendSysMessage(L.LANG_COMMAND_FREEZE, target!.getName());
    const unit = playerTarget.spellUnit();
    if (spellInfo && unit) Aura.tryRefreshStackOrCreate(spellInfo, MAX_EFFECT_MASK, unit, unit).aura?.applyForTargetsNow();
    return true;
  } else if (creatureTarget && creatureTarget.isAlive()) {
    handler.pSendSysMessage(L.LANG_COMMAND_FREEZE, GetLocalizeCreatureName(creatureTarget, handler.getSessionDbcLocale()));
    const unit = creatureTarget.spellUnit();
    if (spellInfo && unit) Aura.tryRefreshStackOrCreate(spellInfo, MAX_EFFECT_MASK, unit, unit).aura?.applyForTargetsNow();
    return true;
  }
  handler.sendErrorMessage(L.LANG_SELECT_CHAR_OR_CREATURE);
  return false;
}

/** @ac scripts/Commands/cs_misc.cpp misc_commandscript::HandleUnFreezeCommand */
function HandleUnFreezeCommand(handler: ChatHandler, targetArg: PlayerIdentifier | null): boolean {
  const creatureTarget = handler.getSelectedCreature();
  let target = targetArg;
  if (!target && !creatureTarget) target = PlayerIdentifier.fromTargetOrSelf(handler);
  if (!target && !creatureTarget) {
    handler.sendErrorMessage(L.LANG_SELECT_CHAR_OR_CREATURE);
    return false;
  }
  const playerTarget = target?.getConnectedPlayer() ?? null;
  if (!creatureTarget && playerTarget && playerTarget.hasAura(SPELL_FREEZE)) {
    handler.pSendSysMessage(L.LANG_COMMAND_UNFREEZE, target!.getName());
    playerTarget.removeAurasDueToSpell(SPELL_FREEZE);
    return true;
  } else if (creatureTarget && creatureTarget.spellUnit()?.hasAura(SPELL_FREEZE)) {
    handler.pSendSysMessage(L.LANG_COMMAND_UNFREEZE, GetLocalizeCreatureName(creatureTarget, handler.getSessionDbcLocale()));
    creatureTarget.spellUnit()!.removeAurasDueToSpell(SPELL_FREEZE);
    return true;
  } else if (!creatureTarget && target && !target.isConnected()) {
    executeStatementAsync(CharacterDatabase(), CHAR_DEL_CHAR_AURA_FROZEN, target.getGUID());
    handler.pSendSysMessage(L.LANG_COMMAND_UNFREEZE, target.getName());
    return true;
  }
  handler.sendSysMessage(L.LANG_COMMAND_FREEZE_WRONG);
  return true;
}

/** @ac scripts/Commands/cs_misc.cpp misc_commandscript::HandlePlayAllCommand */
function HandlePlayAllCommand(handler: ChatHandler, soundId: number): boolean {
  if (!sSoundEntriesStore.lookupEntry(soundId)) {
    handler.sendErrorMessage(L.LANG_SOUND_NOT_EXIST, soundId);
    return false;
  }
  // WorldPackets::Misc::Playsound
  sWorldSessionMgr.SendGlobalMessage(SMSG_PLAY_SOUND, new ByteWriter().writeU32(soundId).toUint8Array());
  handler.pSendSysMessage(L.LANG_COMMAND_PLAYED_TO_ALL, soundId);
  return true;
}

/** @ac scripts/Commands/cs_misc.cpp misc_commandscript::HandlePossessCommand */
function HandlePossessCommand(handler: ChatHandler): boolean {
  const unit = handler.getSelectedUnit();
  if (!unit) return false;
  handler.getSession()!.getPlayer()!.castSpell(unit, MAP_OUTLAND, true);
  return true;
}

/** @ac scripts/Commands/cs_misc.cpp misc_commandscript::HandleUnPossessCommand */
function HandleUnPossessCommand(handler: ChatHandler): boolean {
  const unit = handler.getSelectedUnit() ?? handler.getSession()!.getPlayer()!;
  // Unit::RemoveCharmAuras
  const spellUnit = unit.spellUnit();
  if (spellUnit) {
    for (const type of [SPELL_AURA_MOD_CHARM, SPELL_AURA_MOD_POSSESS_PET, SPELL_AURA_MOD_POSSESS, SPELL_AURA_AOE_CHARM]) spellUnit.removeAurasByType(type);
  }
  return true;
}

const SPELL_AURA_MOD_POSSESS = 2;
const SPELL_AURA_MOD_CHARM = 6;
const SPELL_AURA_MOD_POSSESS_PET = 128;
const SPELL_AURA_AOE_CHARM = 177;

/** @ac scripts/Commands/cs_misc.cpp misc_commandscript::HandleBindSightCommand */
function HandleBindSightCommand(handler: ChatHandler): boolean {
  const unit = handler.getSelectedUnit();
  if (!unit) return false;
  handler.getSession()!.getPlayer()!.castSpell(unit, 6277, true);
  return true;
}

/** @ac scripts/Commands/cs_misc.cpp misc_commandscript::HandleUnbindSightCommand */
function HandleUnbindSightCommand(handler: ChatHandler): boolean {
  const player = handler.getSession()!.getPlayer()!;
  // Possession is not ported (`isPossessing` is false). `StopCastingBindSight` removes the bind sight auras.
  player.spellUnit()?.removeAurasByType(SPELL_AURA_BIND_SIGHT);
  return true;
}

const SPELL_AURA_BIND_SIGHT = 5;

/** @ac scripts/Commands/cs_misc.cpp misc_commandscript::HandleMailBoxCommand */
function HandleMailBoxCommand(handler: ChatHandler): boolean {
  const player = handler.getSession()!.getPlayer()!;
  // WorldSession::SendShowMailBox
  handler.getSession()!.sendPacket(SMSG_SHOW_MAILBOX, new ByteWriter().writeU64(player.getGUID()).toUint8Array());
  return true;
}

/** @ac scripts/Commands/cs_misc.cpp misc_commandscript::HandleStringCommand */
function HandleStringCommand(handler: ChatHandler, id: number, locale: number | null): boolean {
  if (!id) {
    handler.sendSysMessage(L.LANG_CMD_SYNTAX);
    return false;
  }
  const str = sObjectMgr.getAcoreString(id, locale ?? DEFAULT_LOCALE);
  handler.sendSysMessage(str);
  return true;
}

/** @ac scripts/Commands/cs_misc.cpp misc_commandscript::HandleOpenDoorCommand */
function HandleOpenDoorCommand(handler: ChatHandler, range: number | null): boolean {
  const go = handler.getPlayer()!.findNearestGameObject(range ?? 5.0, GAMEOBJECT_TYPE_DOOR);
  if (go) {
    go.setGoState(GO_STATE_ACTIVE);
    handler.pSendSysMessage(L.LANG_CMD_DOOR_OPENED, go.getName(), go.getEntry());
    return true;
  }
  handler.sendErrorMessage(L.LANG_CMD_NO_DOOR_FOUND, range ?? 5.0);
  return false;
}

/** @ac scripts/Commands/cs_misc.cpp misc_commandscript::HandleBMCommand */
function HandleBMCommand(handler: ChatHandler, enableArg: boolean | null): boolean {
  const session = handler.getSession();
  if (!session) return false;
  const SetBMMod = (enable: boolean): void => {
    handler.sendNotification(L.LANG_COMMAND_BEASTMASTER_MODE, enable ? "ON" : "OFF");
    session.getPlayer()!.setBeastMaster(enable);
  };
  if (enableArg === null) {
    SetBMMod(!isPlayerAccount(session.getSecurity()) && session.getPlayer()!.isDeveloper());
    return true;
  }
  SetBMMod(enableArg);
  return true;
}

/** @ac scripts/Commands/cs_misc.cpp misc_commandscript::HandlePacketLog */
function HandlePacketLog(handler: ChatHandler, targetArg: PlayerIdentifier | null, enableArg: boolean | null): boolean {
  const target = targetArg ?? PlayerIdentifier.fromTargetOrSelf(handler);
  const playerTarget = target?.getConnectedPlayer() ?? null;
  if (!target || !playerTarget) {
    handler.sendErrorMessage(L.LANG_PLAYER_NOT_FOUND);
    return false;
  }
  const session = playerTarget.getSession();
  if (enableArg !== null) {
    session.packetLogging = enableArg;
    handler.pSendSysMessage(enableArg ? "Packet logging enabled for {}." : "Packet logging disabled for {}.", playerTarget.getName());
    return true;
  }
  handler.sendErrorMessage(L.LANG_USE_BOL);
  return false;
}

/** @ac scripts/Commands/cs_misc.cpp AddSC_misc_commandscript */
export function AddSC_misc_commandscript(): void {
  registerCommandScript(GetCommands);
}
