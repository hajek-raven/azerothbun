import { startAuthServer } from "./auth/server.ts";
import { ConfigMgr } from "./common/config.ts";
import { listRealms, markRealmOffline, markRealmOnline, markRealmStarting, seedDevelopmentAccounts } from "./db.ts";
import { closeDatabases } from "./database/database.ts";
import { loadDatabases } from "./database/loader.ts";
import { setHighestGuids } from "./game/globals/object-guids.ts";
import { loadDbcStores } from "./data/dbc.ts";
import { SpellStore } from "./spells/spell-info.ts";
import { loadPlayerEnvironment } from "./characters/player-env.ts";
import { configureCombatRates } from "./combat/combat-world.ts";
import { ItemDbc } from "./items/item-dbc.ts";
import { configureLootRates } from "./loot/templates.ts";
import { loadSpellRecoveryMap, type SpellRecovery } from "./items/use-item.ts";
import { loadWorldData } from "./data/import.ts";
import { portInRange, readAuthAppSettings, readWorldAppSettings } from "./game/server/app-config.ts";
import { handleConsoleCommand, startConsole } from "./game/server/console.ts";
import { worldUpdateTime } from "./game/time/update-time.ts";
import { ServerConfig, WorldConfig } from "./game/world/world-config.ts";
import { ShutdownExitCode, startWorldUpdateLoop, World } from "./game/world/world.ts";
import { log, logBanner } from "./log.ts";
import { startWorldServer, WorldSessions } from "./world/server.ts";

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
const worldSessions = new WorldSessions();
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
      void handleConsoleCommand(line, {
        db: databases.login,
        world: gameWorld,
        expansion: worldSettings.getUInt(ServerConfig.CONFIG_EXPANSION),
      }).then((result) => {
        if (result) {
          log("server", result.message);
        }
      });
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

async function resolveConfigFile(conf: string, dist: string): Promise<string> {
  if (await Bun.file(conf).exists()) {
    return conf;
  }
  return dist;
}
