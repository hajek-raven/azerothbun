import type { ConfigMgr } from "../../common/config.ts";

/** Keys `worldserver` reads outside `WorldConfig::BuildConfigCache`. */
export type WorldAppSettings = {
  bindIp: string;
  minWorldUpdateTime: number;
  maxCoreStuckTime: number;
  consoleEnable: boolean;
  realmId: number;
  tcpNoDelay: boolean;
};

export function readWorldAppSettings(config: ConfigMgr): WorldAppSettings {
  const settings: WorldAppSettings = {
    bindIp: config.getString("BindIP", "0.0.0.0"),
    minWorldUpdateTime: config.getInt("MinWorldUpdateTime", 1),
    maxCoreStuckTime: config.getInt("MaxCoreStuckTime", 60),
    consoleEnable: config.getBool("Console.Enable", true),
    realmId: config.getUInt("RealmID", 1),
    tcpNoDelay: config.getBool("Network.TcpNodelay", true),
  };
  config.getBool("Log.Async.Enable", false);
  config.getString("PidFile", "");
  config.getInt("ThreadPool", 2);
  config.getInt("UseProcessors", 0);
  config.getBool("ProcessPriority", true);
  config.getBool("Ra.Enable", false);
  config.getBool("SOAP.Enabled", false);
  config.getString("SOAP.IP", "127.0.0.1");
  config.getInt("SOAP.Port", 7878);
  config.getInt("Network.Threads", 1);
  config.getBool("Network.UseSocketActivation", false);
  config.getBool("Cluster.Enabled", false);
  config.getInt("Ra.Port", 3443);
  config.getString("Ra.IP", "0.0.0.0");
  config.getBool("BeepAtStart", true);
  config.getBool("FlashAtStart", true);
  return settings;
}

/** Keys `authserver` reads at startup and during login. */
export type AuthAppSettings = {
  bindIp: string;
  realmServerPort: number;
  realmsStateUpdateDelay: number;
  maxPingTime: number;
  banExpiryCheckInterval: number;
  wrongPassMaxCount: number;
  wrongPassLogging: boolean;
  wrongPassBanTime: number;
  wrongPassBanType: boolean;
  strictVersionCheck: boolean;
  allowLoggingIpAddresses: boolean;
  enableProxyProtocol: boolean;
};

export function readAuthAppSettings(config: ConfigMgr): AuthAppSettings {
  const settings: AuthAppSettings = {
    bindIp: config.getString("BindIP", "0.0.0.0"),
    realmServerPort: config.getInt("RealmServerPort", 3724),
    realmsStateUpdateDelay: config.getInt("RealmsStateUpdateDelay", 20),
    maxPingTime: config.getInt("MaxPingTime", 30),
    banExpiryCheckInterval: config.getInt("BanExpiryCheckInterval", 60),
    wrongPassMaxCount: config.getInt("WrongPass.MaxCount", 0),
    wrongPassLogging: config.getBool("WrongPass.Logging", false),
    wrongPassBanTime: config.getInt("WrongPass.BanTime", 600),
    wrongPassBanType: config.getBool("WrongPass.BanType", false),
    strictVersionCheck: config.getBool("StrictVersionCheck", false),
    allowLoggingIpAddresses: config.getBool("AllowLoggingIPAddressesInDatabase", true),
    enableProxyProtocol: config.getBool("EnableProxyProtocol", false),
  };
  config.getString("PidFile", "");
  config.getInt("UseProcessors", 0);
  config.getBool("ProcessPriority", false);
  return settings;
}

export function portInRange(port: number): boolean {
  return port > 0 && port <= 0xffff;
}
