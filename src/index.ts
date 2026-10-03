import { startAuthServer } from "./auth/server.ts";
import { ConfigMgr } from "./common/config.ts";
import { listRealms, markRealmOffline, markRealmOnline, markRealmStarting, seedDevelopmentAccounts } from "./db.ts";
import { closeDatabases } from "./database/database.ts";
import { loadDatabases } from "./database/loader.ts";
import { setHighestGuids } from "./game/Globals/object-guids.ts";
import { loadDbcStores } from "./data/dbc.ts";
import { SpellStore } from "./spells/spell-info.ts";
import { loadPlayerEnvironment } from "./characters/player-env.ts";
import { configureCombatRates } from "./combat/combat-world.ts";
import { ItemDbc } from "./items/item-dbc.ts";
import { configureLootRates } from "./loot/templates.ts";
import { loadSpellRecoveryMap, type SpellRecovery } from "./items/use-item.ts";
import { loadWorldData } from "./data/import.ts";
import { portInRange, readAuthAppSettings, readWorldAppSettings } from "./game/Server/app-config.ts";
import { handleConsoleCommand, startConsole } from "./game/Server/console.ts";
import { worldUpdateTime } from "./game/time/update-time.ts";
import { ServerConfig, WorldConfig } from "./game/world/world-config.ts";
import { setWorldInstance, ShutdownExitCode, startWorldUpdateLoop, World } from "./game/world/world.ts";
import { log, logBanner } from "./log.ts";
import { startWorldServer } from "./world/server.ts";
import { queryFields } from "./database/database.ts";
import { setDatabaseEnv } from "./database/DatabaseEnv.ts";
import { LOGIN_SEL_REALMLIST_SECURITY_LEVEL } from "./gen/LoginDatabase.gen.ts";
import { realm as realmInfo } from "./shared/Realms/Realm.ts";
import { loadDBCStores } from "./game/DataStores/DBCStores.ts";
import { setMapMgrWorld, sMapMgr } from "./game/Maps/MapMgr.ts";
import { startMapSystem } from "./game/Maps/MapSetup.ts";
import { sDisableMgr } from "./game/Conditions/DisableMgr.ts";
import { sGameEventMgr } from "./game/Events/GameEventMgr.ts";
import { sObjectMgr } from "./game/Globals/ObjectMgr.ts";
import { sGraveyard } from "./game/Misc/GameGraveyard.ts";
import { sSpellMgr } from "./game/Spells/SpellMgr.ts";
import { sAccountMgr } from "./game/Accounts/AccountMgr.ts";
import { sCharacterCache } from "./game/Cache/CharacterCache.ts";
import { sMotdMgr } from "./game/Motd/MotdMgr.ts";
import { sSecretMgr } from "./shared/Secrets/SecretMgr.ts";
import { sWorldSessionMgr } from "./game/Server/WorldSessionMgr.ts";
import { clearCommandScripts, LoadCommandMap, setCommandTableSource } from "./game/Chat/ChatCommands/ChatCommand.ts";
import { AddCommandsScripts } from "./scripts/Commands/cs_script_loader.ts";

type HotReload = {
  generation: number;
  stop: (() => void) | null;
  where: string | null;
};

// bun --hot re-evaluates this file and keeps globalThis. import.meta.hot stays unset.
const hotReload: HotReload = ((globalThis as { wowHotReload?: HotReload }).wowHotReload ??= {
  generation: 0,
  stop: null,
  where: null,
});

const previousStop = hotReload.stop;
if (previousStop) {
  const closing = hotReload.where ?? "listeners";
  hotReload.stop = null;
  logBanner("hot", `reloading #${hotReload.generation} — closing ${closing}`);
  previousStop();
}


const worldFile = await resolveConfigFile("configs/worldserver.conf", "configs/worldserver.conf.dist");
const authFile = await resolveConfigFile("configs/authserver.conf", "configs/authserver.conf.dist");
const worldConfigFile = new ConfigMgr();
worldConfigFile.configure(worldFile, process.argv.slice(2));
if (!(await worldConfigFile.loadAppConfigs()) || !(await worldConfigFile.loadModulesConfigs())) {
  throw new Error(`failed to load world config ${worldFile}`);
}
worldConfigFile.overrideWithEnvVariablesIfAny();
const worldSettings = new WorldConfig(worldConfigFile);
worldSettings.load();
configureCombatRates(worldSettings);
configureLootRates(worldSettings);
const worldApp = readWorldAppSettings(worldConfigFile);
worldUpdateTime.loadFromConfig(worldConfigFile);

const authConfigFile = new ConfigMgr();
authConfigFile.configure(authFile, process.argv.slice(2));
if (!(await authConfigFile.loadAppConfigs())) {
  throw new Error(`failed to load auth config ${authFile}`);
}
authConfigFile.overrideWithEnvVariablesIfAny();
const authApp = readAuthAppSettings(authConfigFile);
if (!portInRange(authApp.realmServerPort) || !portInRange(worldSettings.getUInt(ServerConfig.CONFIG_PORT_WORLD))) {
  throw new Error("Specified port out of allowed range (1-65535)");
}

// `DatabaseLoader`: authserver and worldserver share this process, so one pool per database serves both.
const databases = await loadDatabases(worldConfigFile, ["login", "characters", "world"]);
const worldData = await loadWorldData(databases.world);
log(
  "world",
  `${worldData.creaturesOnMap.length} creatures, ${worldData.gameObjectsOnMap.length} gameobjects, ${worldData.items.size} items`,
);
await setHighestGuids(databases.characters, databases.world);
await seedDevelopmentAccounts(databases.login, databases.characters, worldData.tables());
const sessionDatabases = { login: databases.login, characters: databases.characters };
const realm = (await listRealms(databases.login))[0];
const worldPort = worldSettings.getUInt(ServerConfig.CONFIG_PORT_WORLD);
if (realm && realm.port !== worldPort) {
  log("server", `realmlist port ${realm.port} does not match WorldServerPort ${worldPort}`);
}
// set server offline (not connectable)
if (realm) {
  await markRealmStarting(databases.login, realm.id);
}
let dbc = null;
let spellRecovery: Map<number, SpellRecovery> | undefined;
try {
  dbc = loadDbcStores("data/dbc");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  log("world", `dbc left unloaded: ${message}`);
}
if (dbc) {
  try {
    spellRecovery = loadSpellRecoveryMap(await Bun.file("data/dbc/Spell.dbc").bytes());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log("world", `spell recovery left unloaded: ${message}`);
  }
  log(
    "world",
    `dbc ${dbc.spells.size} spells, ${dbc.factions.length} factions, ${spellRecovery?.size ?? 0} spell recoveries`,
  );
}
const playerEnv = await loadPlayerEnvironment({ directory: "data/dbc", dbc, worldDb: worldData.tables(), settings: worldSettings });
const spellStore = await SpellStore.load("data/dbc", worldData.tables());
const itemDbc = await ItemDbc.load("data/dbc", worldData.tables());
const gameWorld = new World(worldSettings);
setWorldInstance(gameWorld);
gameWorld.realmName = realm?.name ?? "";
await initializeChatCommands();
await initializeMaps();
const worldSessions = sWorldSessionMgr;
gameWorld.setSessionUpdate((diff) => worldSessions.update(diff));
let auth: ReturnType<typeof startAuthServer> | undefined;
let world: ReturnType<typeof startWorldServer> | undefined;
try {
  auth = startAuthServer({ hostname: authApp.bindIp, port: authApp.realmServerPort, db: databases.login });
  world = startWorldServer({
    hostname: worldApp.bindIp,
    port: worldPort,
    db: sessionDatabases,
    world: worldData,
    dbc,
    spellRecovery,
    spellStore,
    itemDbc,
    tcpNoDelay: worldApp.tcpNoDelay,
    settings: worldSettings,
    playerEnv,
    sessions: worldSessions,
  });
} catch (error) {
  auth?.stop(true);
  world?.stop(true);
  await closeDatabases(databases);
  const message = error instanceof Error ? error.message : String(error);
  logBanner("hot", `bind failed — ${message}. Stop this process and start it again.`);
  throw error;
}
const worldLoop = startWorldUpdateLoop(gameWorld, {
  minUpdateDiff: worldApp.minWorldUpdateTime,
  maxCoreStuckTime: worldApp.maxCoreStuckTime,
  onStop() {
    void closeServers().then(() => {
      log("server", "Halting process...");
      process.exit(gameWorld.getExitCode());
    });
  },
});
const stopOnSignal = (): void => gameWorld.stopNow(ShutdownExitCode.Shutdown);
process.on("SIGINT", stopOnSignal);
process.on("SIGTERM", stopOnSignal);
const consoleInput = worldApp.consoleEnable
  ? startConsole((line) => {
      void handleConsoleCommand(line).catch((error: unknown) => log("server", `console command failed: ${String(error)}`));
    })
  : null;

hotReload.generation += 1;
const where = `auth ${auth.hostname}:${auth.port}, world ${world.hostname}:${world.port}`;
hotReload.where = where;
hotReload.stop = closeServers;

let closed: Promise<void> | null = null;
/**
 * Closing the world listener runs every socket `close` handler, which saves the characters still online. The pools
 * close once those saves are done.
 */
function closeServers(): Promise<void> {
  closed ??= shutdownServers();
  return closed;
}

async function shutdownServers(): Promise<void> {
  process.off("SIGINT", stopOnSignal);
  process.off("SIGTERM", stopOnSignal);
  consoleInput?.stop();
  worldLoop.stop();
  auth?.stop(true);
  world?.stop(true);
  await worldSessions.drain();
  // `sMapMgr->UnloadAll()`
  sMapMgr().unloadAll();
  // set server offline
  if (realm) {
    await markRealmOffline(databases.login, realm.id);
  }
  await closeDatabases(databases);
}

if (realm) {
  await markRealmOnline(databases.login, realm.id);
}
console.log(`Auth server listening on ${auth.hostname}:${auth.port}`);
console.log(`World server listening on ${world.hostname}:${world.port}`);

const hotEnabled = process.execArgv.includes("--hot") || import.meta.hot != null;
if (hotEnabled && hotReload.generation === 1) {
  log("hot", `watching source files — ${where}`);
} else if (hotReload.generation > 1) {
  logBanner("hot", `reloaded #${hotReload.generation} — ${where}`);
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    const stop = hotReload.stop;
    if (!stop) {
      return;
    }
    hotReload.stop = null;
    logBanner("hot", `reloading #${hotReload.generation} — closing ${where}`);
    stop();
  });
}

/**
 * The parts of `World::SetInitialWorldSettings` the chat command system needs: the DBC stores, `acore_string`,
 * `game_tele`, RBAC, the character cache, the message of the day, and the command table.
 */
async function initializeChatCommands(): Promise<void> {
  setDatabaseEnv(databases);
  realmInfo.Id.Realm = realm?.id ?? 1;
  realmInfo.Name = realm?.name ?? "";
  await loadDBCStores("data/dbc", worldData.tables());
  setMapMgrWorld(worldData.tables());
  sObjectMgr.setWorld(worldData, worldData.tables(), databases.world);
  sGraveyard.setWorld(worldData.tables(), databases.world);
  sObjectMgr.loadAcoreStrings();
  sObjectMgr.loadGameTele();
  sGameEventMgr.loadFromDB(worldData.tables());
  await sObjectMgr.loadReservedPlayerNames(databases.characters);
  await sObjectMgr.loadProfanityNames(databases.characters);
  sSpellMgr.setStore(spellStore);
  await sAccountMgr.loadRBAC(databases.login);
  await sCharacterCache.loadCharacterCacheStorage(databases.characters);
  await sMotdMgr.LoadMotd(databases.login, realmInfo.Id.Realm);
  const [securityRow] = await queryFields(databases.login, LOGIN_SEL_REALMLIST_SECURITY_LEVEL, realmInfo.Id.Realm);
  if (securityRow) gameWorld.setPlayerSecurityLimit(Number(securityRow[0]));
  sSecretMgr.setConfig((key) => worldConfigFile.getString(key, "", false));
  // `World::LoadConfigSettings`: `DataDir` (`maps/`, `vmaps/`, `mmaps/` below it)
  gameWorld.loadDataPath(worldConfigFile.getString("DataDir", "data", false));
  clearCommandScripts();
  AddCommandsScripts();
  setCommandTableSource(worldData.tables());
  LoadCommandMap();
}

/**
 * The map part of `World::SetInitialWorldSettings`: the spawn stores and the disables, then the map system (hooks, vmap
 * switches, respawn times, instance ids, update interval), and the map update the world tick runs after the sessions.
 */
async function initializeMaps(): Promise<void> {
  sDisableMgr().loadDisables(worldData.tables());
  sDisableMgr().checkQuestDisables();
  await startMapSystem({ config: worldConfigFile, characterDb: databases.characters });
  gameWorld.setMapUpdate((diff) => sMapMgr().update(diff));
}

async function resolveConfigFile(conf: string, dist: string): Promise<string> {
  if (await Bun.file(conf).exists()) {
    return conf;
  }
  return dist;
}
