/** `cs_cache.cpp`: `.cache info|delete|refresh` for the character cache. */
import { queryFields } from "../../database/database.ts";
import { CharacterDatabase } from "../../database/DatabaseEnv.ts";
import * as R from "../../game/Accounts/RBACDefines.ts";
import { sCharacterCache } from "../../game/Cache/CharacterCache.ts";
import { guidString, type ChatHandler } from "../../game/Chat/Chat.ts";
import { ChatCommand, Console, registerCommandScript, SubCommands, type ChatCommandTable } from "../../game/Chat/ChatCommands/ChatCommand.ts";
import { Optional } from "../../game/Chat/ChatCommands/ChatCommandArgs.ts";
import { PlayerIdentifier, PlayerIdentifierArg } from "../../game/Chat/ChatCommands/ChatCommandTags.ts";
import { ObjectAccessor } from "../../game/Globals/ObjectAccessor.ts";
import * as L from "../../game/Miscellaneous/Language.ts";

const ARENA_SLOT_2v2 = 0;
const ARENA_SLOT_3v3 = 1;
const ARENA_SLOT_5v5 = 2;

/** @ac scripts/Commands/cs_cache.cpp cache_commandscript::GetCommands */
function GetCommands(): ChatCommandTable {
  const cacheCommandTable: ChatCommandTable = [
    ChatCommand("info", [Optional(PlayerIdentifierArg)], HandleCacheInfoCommand, R.RBAC_PERM_COMMAND_DEBUG, Console.Yes),
    ChatCommand("delete", [Optional(PlayerIdentifierArg)], HandleCacheDeleteCommand, R.RBAC_PERM_COMMAND_DEBUG, Console.Yes),
    ChatCommand("refresh", [Optional(PlayerIdentifierArg)], HandleCacheRefreshCommand, R.RBAC_PERM_COMMAND_DEBUG, Console.Yes),
  ];
  return [SubCommands("cache", cacheCommandTable)];
}

function playerGuidString(guid: number): string {
  return guidString(BigInt(guid));
}

/** @ac scripts/Commands/cs_cache.cpp cache_commandscript::HandleCacheInfoCommand */
function HandleCacheInfoCommand(handler: ChatHandler, playerArg: PlayerIdentifier | null): boolean {
  const player = playerArg ?? PlayerIdentifier.fromTargetOrSelf(handler);
  if (!player) {
    handler.sendErrorMessage(L.LANG_PLAYER_NOT_FOUND);
    return false;
  }
  const cache = sCharacterCache.getCharacterCacheByGuid(player.getGUID());
  if (!cache) {
    handler.sendErrorMessage(L.LANG_COMMAND_CACHE_NOT_FOUND, player.getName());
    return false;
  }
  handler.pSendSysMessage(
    L.LANG_COMMAND_CACHE_INFO,
    cache.Name,
    playerGuidString(cache.Guid),
    cache.AccountId,
    cache.Class,
    cache.Race,
    cache.Sex,
    cache.Level,
    cache.MailCount,
    cache.GuildId,
    guidString(cache.GroupGuid),
    cache.ArenaTeamId[ARENA_SLOT_2v2] ?? 0,
    cache.ArenaTeamId[ARENA_SLOT_3v3] ?? 0,
    cache.ArenaTeamId[ARENA_SLOT_5v5] ?? 0,
  );
  handler.setSentErrorMessage(false);
  return true;
}

/** @ac scripts/Commands/cs_cache.cpp cache_commandscript::HandleCacheDeleteCommand */
function HandleCacheDeleteCommand(handler: ChatHandler, playerArg: PlayerIdentifier | null): boolean {
  const player = playerArg ?? PlayerIdentifier.fromTargetOrSelf(handler);
  if (!player) {
    handler.sendErrorMessage(L.LANG_PLAYER_NOT_FOUND);
    return false;
  }
  sCharacterCache.deleteCharacterCacheEntry(player.getGUID(), player.getName());
  handler.pSendSysMessage(L.LANG_COMMAND_CACHE_DELETE, player.getName(), playerGuidString(player.getGUID()));
  handler.setSentErrorMessage(false);
  return true;
}

/** @ac scripts/Commands/cs_cache.cpp cache_commandscript::HandleCacheRefreshCommand */
async function HandleCacheRefreshCommand(handler: ChatHandler, playerArg: PlayerIdentifier | null): Promise<boolean> {
  const player = playerArg ?? PlayerIdentifier.fromTargetOrSelf(handler);
  if (!player) {
    handler.sendErrorMessage(L.LANG_PLAYER_NOT_FOUND);
    return false;
  }
  if (player.isConnected()) {
    const cPlayer = ObjectAccessor.FindConnectedPlayer(BigInt(player.getGUID()));
    if (cPlayer) {
      const guid = cPlayer.getGUIDLow();
      if (sCharacterCache.hasCharacterCacheEntry(guid)) sCharacterCache.updateCharacterData(guid, cPlayer.getName(), cPlayer.getGender(), cPlayer.getRace());
      else sCharacterCache.addCharacterCacheEntry(guid, cPlayer.getSession().getAccountId(), cPlayer.getName(), cPlayer.getGender(), cPlayer.getRace(), cPlayer.getClass(), cPlayer.getLevel());
      sCharacterCache.updateCharacterAccountId(guid, cPlayer.getSession().getAccountId());
      // Guilds and arena teams are not ported: the ids are 0.
      sCharacterCache.updateCharacterGuildId(guid, 0);
      // MailMgr::RecountMailCount
      const [row] = await queryFields(CharacterDatabase(), "SELECT COUNT(*) FROM mail WHERE receiver = ?", guid);
      sCharacterCache.updateCharacterMailCount(guid, Number(row?.[0] ?? 0), true);
      sCharacterCache.updateCharacterArenaTeamId(guid, ARENA_SLOT_2v2, 0);
      sCharacterCache.updateCharacterArenaTeamId(guid, ARENA_SLOT_3v3, 0);
      sCharacterCache.updateCharacterArenaTeamId(guid, ARENA_SLOT_5v5, 0);
      // Groups are not ported, so no player is in one.
      sCharacterCache.clearCharacterGroup(guid);
    }
  } else {
    await sCharacterCache.refreshCacheEntry(CharacterDatabase(), player.getGUID());
  }
  handler.pSendSysMessage(L.LANG_COMMAND_CACHE_REFRESH, player.getName(), playerGuidString(player.getGUID()));
  handler.setSentErrorMessage(false);
  return true;
}

/** @ac scripts/Commands/cs_cache.cpp AddSC_cache_commandscript */
export function AddSC_cache_commandscript(): void {
  registerCommandScript(GetCommands);
}
