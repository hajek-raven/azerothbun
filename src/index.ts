import { mkdir } from "node:fs/promises";
import { startAuthServer } from "./auth/server.ts";
import { ConfigMgr } from "./common/config.ts";
import { listRealms, openAuthDatabase } from "./db.ts";
import { loadDbcStores } from "./data/dbc.ts";
import { openWorldData } from "./data/import.ts";
import { portInRange, readAuthAppSettings, readWorldAppSettings } from "./game/server/app-config.ts";
import { handleConsoleCommand, startConsole } from "./game/server/console.ts";
import { worldUpdateTime } from "./game/time/update-time.ts";
import { ServerConfig, WorldConfig } from "./game/world/world-config.ts";
import { ShutdownExitCode, startWorldUpdateLoop, World } from "./game/world/world.ts";
import { log, logBanner } from "./log.ts";
import { startWorldServer } from "./world/server.ts";

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

await mkdir("data", { recursive: true });

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

const worldData = await openWorldData("data/world.sqlite", "sql/base/db_world");
log(
  "world",
  `${worldData.creaturesOnMap.length} creatures, ${worldData.gameObjectsOnMap.length} gameobjects, ${worldData.items.size} items`,
);
const db = openAuthDatabase("data/auth.sqlite");
const realm = listRealms(db)[0];
const worldPort = worldSettings.getUInt(ServerConfig.CONFIG_PORT_WORLD);
if (realm && realm.port !== worldPort) {
  log("server", `realmlist port ${realm.port} does not match WorldServerPort ${worldPort}`);
}
let dbc = null;
try {
  dbc = loadDbcStores("data/dbc");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  log("world", `dbc left unloaded: ${message}`);
}
if (dbc) {
  log("world", `dbc ${dbc.spells.size} spells, ${dbc.factions.length} factions`);
}
const gameWorld = new World(worldSettings);
let auth: ReturnType<typeof startAuthServer> | undefined;
let world: ReturnType<typeof startWorldServer> | undefined;
try {
  auth = startAuthServer({ hostname: authApp.bindIp, port: authApp.realmServerPort, db });
  world = startWorldServer({ hostname: worldApp.bindIp, port: worldPort, db, world: worldData, dbc, tcpNoDelay: worldApp.tcpNoDelay, settings: worldSettings });
} catch (error) {
  auth?.stop(true);
  world?.stop(true);
  db.close();
  worldData.close();
  const message = error instanceof Error ? error.message : String(error);
  logBanner("hot", `bind failed — ${message}. Stop this process and start it again.`);
  throw error;
}
const worldLoop = startWorldUpdateLoop(gameWorld, {
  minUpdateDiff: worldApp.minWorldUpdateTime,
  maxCoreStuckTime: worldApp.maxCoreStuckTime,
  onStop() {
    closeServers();
    log("server", "Halting process...");
    process.exit(gameWorld.getExitCode());
  },
});
const stopOnSignal = (): void => gameWorld.stopNow(ShutdownExitCode.Shutdown);
process.on("SIGINT", stopOnSignal);
process.on("SIGTERM", stopOnSignal);
const consoleInput = worldApp.consoleEnable
  ? startConsole((line) => {
      const result = handleConsoleCommand(line, {
        db,
        world: gameWorld,
        expansion: worldSettings.getUInt(ServerConfig.CONFIG_EXPANSION),
      });
      if (result) {
        log("server", result.message);
      }
    })
  : null;

hotReload.generation += 1;
const where = `auth ${auth.hostname}:${auth.port}, world ${world.hostname}:${world.port}`;
hotReload.where = where;
hotReload.stop = closeServers;

let closed = false;
/** Closing the world listener runs every socket `close` handler, which saves the characters still online. */
function closeServers(): void {
  if (closed) {
    return;
  }
  closed = true;
  process.off("SIGINT", stopOnSignal);
  process.off("SIGTERM", stopOnSignal);
  consoleInput?.stop();
  worldLoop.stop();
  auth?.stop(true);
  world?.stop(true);
  db.close();
  worldData.close();
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
