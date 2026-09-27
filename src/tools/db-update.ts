/** Populate and update the auth, characters, and world databases without starting the servers: `bun run db:update`. */
import { ConfigMgr } from "../common/config.ts";
import { closeDatabases } from "../database/database.ts";
import { loadDatabases } from "../database/loader.ts";

const configFile = (await Bun.file("configs/worldserver.conf").exists()) ? "configs/worldserver.conf" : "configs/worldserver.conf.dist";
const config = new ConfigMgr();
config.configure(configFile, []);
if (!(await config.loadAppConfigs())) {
  throw new Error(`failed to load ${configFile}`);
}
config.overrideWithEnvVariablesIfAny();
await closeDatabases(await loadDatabases(config, ["login", "characters", "world"]));
