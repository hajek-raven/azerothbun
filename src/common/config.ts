import { log } from "../log.ts";

export const ConfigSeverity = {
  Skip: "skip",
  Warn: "warn",
  Error: "error",
  Fatal: "fatal",
} as const;

export type ConfigSeverity = (typeof ConfigSeverity)[keyof typeof ConfigSeverity];

export type ConfigPolicy = {
  defaultSeverity: ConfigSeverity;
  missingFileSeverity: ConfigSeverity;
  missingOptionSeverity: ConfigSeverity;
  criticalOptionSeverity: ConfigSeverity;
  unknownOptionSeverity: ConfigSeverity;
  valueErrorSeverity: ConfigSeverity;
};

export class ConfigException extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigException";
  }
}

const CRITICAL_OPTIONS = new Set(["RealmID", "LoginDatabaseInfo", "WorldDatabaseInfo", "CharacterDatabaseInfo"]);

export function defaultConfigPolicy(): ConfigPolicy {
  return {
    defaultSeverity: ConfigSeverity.Warn,
    missingFileSeverity: ConfigSeverity.Error,
    missingOptionSeverity: ConfigSeverity.Warn,
    criticalOptionSeverity: ConfigSeverity.Fatal,
    unknownOptionSeverity: ConfigSeverity.Error,
    valueErrorSeverity: ConfigSeverity.Error,
  };
}

/** `SomeConfig` -> `SOME_CONFIG`, `LogDB.Opt.ClearTime` -> `LOG_DB_OPT_CLEAR_TIME`. */
export function iniKeyToEnvVarKey(key: string): string {
  let result = "";
  for (let i = 0; i < key.length; i++) {
    const curr = key[i] ?? "";
    if (curr === " " || curr === "." || curr === "-") {
      result += "_";
      continue;
    }
    const isEnd = i === key.length - 1;
    if (!isEnd) {
      const next = key[i + 1] ?? "";
      const nextIsUpper = next >= "A" && next <= "Z";
      const currIsUpper = curr >= "A" && curr <= "Z";
      if (!currIsUpper && nextIsUpper) {
        result += curr.toUpperCase();
        result += "_";
        continue;
      }
      const currIsNumeric = curr >= "0" && curr <= "9";
      const nextIsNumeric = next >= "0" && next <= "9";
      if (!currIsNumeric && nextIsNumeric) {
        result += curr.toUpperCase();
        result += "_";
        continue;
      }
      if (currIsNumeric && !nextIsNumeric) {
        result += curr.toUpperCase();
        result += "_";
        continue;
      }
    }
    result += curr.toUpperCase();
  }
  return result;
}

export function envVarNameFor(configName: string): string {
  return `AC_${iniKeyToEnvVarKey(configName)}`;
}

function isAppConfig(fileName: string): boolean {
  return fileName.includes("authserver.conf") || fileName.includes("worldserver.conf") || fileName.includes("dbimport.conf");
}

function isLoggingSystemOption(optionName: string): boolean {
  return optionName.includes("Appender.") || optionName.includes("Logger.");
}

function parseSeverity(value: string): ConfigSeverity | null {
  if (value.length === 0) {
    return null;
  }
  const lowered = value.toLowerCase();
  switch (lowered) {
    case "skip":
      return ConfigSeverity.Skip;
    case "warn":
    case "warning":
      return ConfigSeverity.Warn;
    case "error":
      return ConfigSeverity.Error;
    case "fatal":
    case "abort":
    case "panic":
      return ConfigSeverity.Fatal;
    default:
      return null;
  }
}

function logWithSeverity(severity: ConfigSeverity, filename: string, message: string): void {
  switch (severity) {
    case ConfigSeverity.Skip:
      return;
    case ConfigSeverity.Warn:
      if (isAppConfig(filename)) {
        console.log(message);
      }
      log("server", message);
      return;
    case ConfigSeverity.Error:
      if (isAppConfig(filename)) {
        console.log(message);
      }
      log("server", message);
      return;
    case ConfigSeverity.Fatal:
      if (isAppConfig(filename)) {
        console.log(message);
      }
      log("server", message);
      throw new ConfigException(message);
    default: {
      const unreachable: never = severity;
      throw new ConfigException(`unknown config severity ${String(unreachable)}`);
    }
  }
}

function applyPolicyString(policy: ConfigPolicy, input: string): ConfigPolicy {
  if (input.length === 0) {
    return policy;
  }
  const next = { ...policy };
  let defaultOverride: ConfigSeverity | null = null;
  const overrides: Array<{ key: string; severity: ConfigSeverity }> = [];
  for (const rawToken of input.split(",")) {
    const token = rawToken.trim();
    if (token.length === 0) {
      continue;
    }
    const separator = token.indexOf("=");
    if (separator < 0) {
      continue;
    }
    const key = token.slice(0, separator).trim().toLowerCase();
    const value = token.slice(separator + 1).trim();
    if (key.length === 0 || value.length === 0) {
      continue;
    }
    const severity = parseSeverity(value);
    if (!severity) {
      continue;
    }
    if (key === "default") {
      defaultOverride = severity;
      continue;
    }
    overrides.push({ key, severity });
  }
  if (defaultOverride) {
    next.defaultSeverity = defaultOverride;
    next.missingFileSeverity = defaultOverride;
    next.missingOptionSeverity = defaultOverride;
    next.criticalOptionSeverity = defaultOverride;
    next.unknownOptionSeverity = defaultOverride;
    next.valueErrorSeverity = defaultOverride;
  }
  for (const override of overrides) {
    switch (override.key) {
      case "missing_file":
      case "file":
        next.missingFileSeverity = override.severity;
        break;
      case "missing_option":
      case "option":
        next.missingOptionSeverity = override.severity;
        break;
      case "critical_option":
      case "critical":
        next.criticalOptionSeverity = override.severity;
        break;
      case "unknown_option":
      case "unknown":
        next.unknownOptionSeverity = override.severity;
        break;
      case "value_error":
      case "value":
        next.valueErrorSeverity = override.severity;
        break;
      default:
        break;
    }
  }
  return next;
}

function applyPolicyFromArgs(policy: ConfigPolicy, args: readonly string[]): ConfigPolicy {
  let next = policy;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    const shortOpt = "--config-policy";
    if (!arg.startsWith(shortOpt)) {
      continue;
    }
    let value = "";
    if (arg.length === shortOpt.length && i + 1 < args.length) {
      value = args[i + 1] ?? "";
      i += 1;
    } else if (arg.length > shortOpt.length && arg[shortOpt.length] === "=") {
      value = arg.slice(shortOpt.length + 1);
    }
    if (value.length > 0) {
      next = applyPolicyString(next, value);
    }
  }
  return next;
}

export function stringToBool(value: string): boolean | null {
  const lower = value.toLowerCase();
  if (value === "1" || lower === "y" || lower === "on" || lower === "yes" || lower === "true") {
    return true;
  }
  if (value === "0" || lower === "n" || lower === "off" || lower === "no" || lower === "false") {
    return false;
  }
  return null;
}

export function stringToInt32(value: string): number | null {
  if (!/^-?\d+$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed > 0x7fffffff || parsed < -0x80000000) {
    return null;
  }
  return parsed;
}

export function stringToUint32(value: string): number | null {
  if (!/^\d+$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed > 0xffffffff) {
    return null;
  }
  return parsed;
}

export function stringToFloat(value: string): number | null {
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return parsed;
}

function formatDefault(value: boolean | number | string): string {
  if (typeof value === "boolean") {
    return value ? "1" : "0";
  }
  return String(value);
}

/**
 * AzerothCore `ConfigMgr`: ini files, `AC_*` environment overrides, and typed reads.
 * One process here runs auth and world together, so each server gets its own instance.
 */
export class ConfigMgr {
  private filename = "";
  private args: string[] = [];
  private policy: ConfigPolicy = defaultConfigPolicy();
  private readonly options = new Map<string, string>();
  private readonly envVarCache = new Map<string, string>();
  private readonly moduleConfigFiles: string[] = [];
  private additionalFiles: string[] = [];
  private dryRun = false;

  configure(initFileName: string, args: string[] = [], modulesConfigList = "", policy: ConfigPolicy = defaultConfigPolicy()): void {
    this.filename = initFileName;
    this.args = args;
    this.policy = policy;
    const fromEnv = process.env.AC_CONFIG_POLICY;
    if (fromEnv) {
      this.policy = applyPolicyString(this.policy, fromEnv);
    }
    this.policy = applyPolicyFromArgs(this.policy, this.args);
    this.additionalFiles = [];
    this.moduleConfigFiles.length = 0;
    if (modulesConfigList.length > 0) {
      for (const part of modulesConfigList.split(",")) {
        if (part.length > 0) {
          this.additionalFiles.push(part);
        }
      }
    }
  }

  async loadAppConfigs(isReload = false): Promise<boolean> {
    return this.loadInitial(this.filename, isReload);
  }

  async loadModulesConfigs(isReload = false, isNeedPrintInfo = true): Promise<boolean> {
    if (this.additionalFiles.length === 0) {
      return true;
    }
    if (isNeedPrintInfo) {
      log("server", "Loading Modules Configuration...");
    }
    const moduleConfigPath = `${this.getConfigPath()}modules/`;
    for (const fileName of this.additionalFiles) {
      if (await this.loadAdditionalFile(moduleConfigPath + fileName, false, isReload)) {
        this.moduleConfigFiles.push(fileName);
      }
    }
    if (isNeedPrintInfo) {
      if (this.moduleConfigFiles.length > 0) {
        log("server", "Using modules configuration:");
        for (const fileName of this.moduleConfigFiles) {
          log("server", `> ${fileName}`);
        }
      } else {
        log("server", "> Not found modules config files");
      }
    }
    return true;
  }

  async reload(): Promise<boolean> {
    if (!(await this.loadAppConfigs(true)) || !(await this.loadModulesConfigs(true, false))) {
      return false;
    }
    this.overrideWithEnvVariablesIfAny();
    return true;
  }

  overrideWithEnvVariablesIfAny(): string[] {
    const overridden: string[] = [];
    for (const [name, current] of this.options) {
      if (name.length === 0) {
        continue;
      }
      const envVar = this.envVarForIniKey(name);
      if (envVar === null) {
        continue;
      }
      if (envVar !== current) {
        this.options.set(name, envVar);
      }
      overridden.push(name);
    }
    return overridden;
  }

  getFilename(): string {
    return this.filename;
  }

  getArguments(): readonly string[] {
    return this.args;
  }

  getConfigPath(): string {
    return "configs/";
  }

  getKeysByString(name: string): string[] {
    const keys: string[] = [];
    for (const optionName of this.options.keys()) {
      if (optionName.startsWith(name)) {
        keys.push(optionName);
      }
    }
    return keys;
  }

  isDryRun(): boolean {
    return this.dryRun;
  }

  setDryRun(mode: boolean): void {
    this.dryRun = mode;
  }

  getBool(name: string, def: boolean, showLogs = true): boolean {
    const raw = this.getString(name, def ? "1" : "0", showLogs);
    const parsed = stringToBool(raw);
    if (parsed === null) {
      if (showLogs) {
        logWithSeverity(
          this.policy.valueErrorSeverity,
          this.filename,
          `> Config: Bad value defined for name '${name}', going to use '${def ? "true" : "false"}' instead`,
        );
      }
      return def;
    }
    return parsed;
  }

  getInt(name: string, def: number, showLogs = true): number {
    return this.readParsed(name, def, showLogs, stringToInt32);
  }

  getUInt(name: string, def: number, showLogs = true): number {
    return this.readParsed(name, def, showLogs, stringToUint32);
  }

  getFloat(name: string, def: number, showLogs = true): number {
    return this.readParsed(name, def, showLogs, stringToFloat);
  }

  getString(name: string, def: string, showLogs = true): string {
    const found = this.options.get(name);
    const notFound = found === undefined;
    const envName = envVarNameFor(name);
    const envVar = this.getEnvFromCache(name, envName);
    if (envVar !== null) {
      if (showLogs && (notFound || found !== envVar)) {
        log("server", `> Config: Found config value '${name}' from environment variable '${envName}'.`);
        this.addKey(name, envVar, "ENVIRONMENT", false, false);
      }
      return envVar;
    }
    if (notFound) {
      if (showLogs) {
        this.reportMissing(name, def);
      }
      return def;
    }
    return found;
  }

  private readParsed(name: string, def: number, showLogs: boolean, parse: (value: string) => number | null): number {
    const found = this.options.get(name);
    const notFound = found === undefined;
    const envName = envVarNameFor(name);
    const envVar = this.getEnvFromCache(name, envName);
    let strValue: string;
    if (envVar !== null) {
      if (showLogs && (notFound || found !== envVar)) {
        log("server", `> Config: Found config value '${name}' from environment variable '${envName}'.`);
        this.addKey(name, envVar, "ENVIRONMENT", false, false);
      }
      strValue = envVar;
    } else if (notFound) {
      if (showLogs) {
        this.reportMissing(name, def);
      }
      return def;
    } else {
      strValue = found;
    }
    const parsed = parse(strValue);
    if (parsed === null) {
      if (showLogs) {
        logWithSeverity(
          this.policy.valueErrorSeverity,
          this.filename,
          `> Config: Bad value defined for name '${name}', going to use '${def}' instead`,
        );
      }
      return def;
    }
    return parsed;
  }

  private reportMissing(name: string, def: boolean | number | string): void {
    const isCritical = CRITICAL_OPTIONS.has(name);
    const severity = isCritical ? this.policy.criticalOptionSeverity : this.policy.missingOptionSeverity;
    const printed = formatDefault(def);
    const envName = envVarNameFor(name);
    if (isCritical) {
      logWithSeverity(
        severity,
        this.filename,
        `> Config: FATAL ERROR: Missing property ${name} in config file ${this.filename}, add "${name} = ${printed}" to this file or define '${envName}' as an environment variable. Your server cannot start without this option!`,
      );
      return;
    }
    let configs = this.filename;
    if (this.moduleConfigFiles.length > 0) {
      configs += " or module config";
    }
    logWithSeverity(
      severity,
      this.filename,
      `> Config: Missing property ${name} in config file ${configs}, add "${name} = ${printed}" to this file or define '${envName}' as an environment variable.`,
    );
  }

  private async loadInitial(file: string, isReload: boolean): Promise<boolean> {
    this.options.clear();
    return this.loadFile(file, false, isReload);
  }

  private loadAdditionalFile(file: string, isOptional: boolean, isReload: boolean): Promise<boolean> {
    return this.loadFile(file, isOptional, isReload);
  }

  private async loadFile(file: string, isOptional: boolean, isReload: boolean): Promise<boolean> {
    try {
      return await this.parseFile(file, isOptional, isReload);
    } catch (error) {
      if (error instanceof ConfigException) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      log("server", `> ${message}`);
      return false;
    }
  }

  private async parseFile(file: string, isOptional: boolean, isReload: boolean): Promise<boolean> {
    const source = Bun.file(file);
    if (!(await source.exists())) {
      const severity = isOptional ? ConfigSeverity.Skip : this.policy.missingFileSeverity;
      logWithSeverity(severity, file, `> Config::LoadFile: Failed open ${isOptional ? "optional " : ""}file '${file}'`);
      return severity === ConfigSeverity.Skip;
    }
    const text = await source.text();
    const fileConfigs = new Map<string, string>();
    const lines = text.split(/\n/);
    let count = 0;
    for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
      const line = (lines[lineNumber] ?? "").trim();
      if (line.length === 0 || line[0] === "#" || line[0] === "[") {
        continue;
      }
      const equalPos = line.indexOf("=");
      if (equalPos < 0) {
        log("server", `> Config::LoadFile: Failure to read line number ${lineNumber + 1} in file '${file}'. Skip this line`);
        continue;
      }
      const entry = line.slice(0, equalPos).trim();
      const value = line.slice(equalPos + 1).trim().replaceAll('"', "");
      if (fileConfigs.has(entry)) {
        log("server", `> Config::LoadFile: Duplicate key name '${entry}' in config file '${file}'`);
        continue;
      }
      fileConfigs.set(entry, value);
      count += 1;
    }
    if (count === 0) {
      const severity = isOptional ? ConfigSeverity.Skip : this.policy.missingFileSeverity;
      logWithSeverity(severity, file, `> Config::LoadFile: Empty file '${file}'`);
      return severity === ConfigSeverity.Skip;
    }
    for (const [entry, key] of fileConfigs) {
      this.addKey(entry, key, file, isOptional, isReload);
    }
    return true;
  }

  private addKey(optionName: string, optionKey: string, fileName: string, isOptional: boolean, isReload: boolean): void {
    const existing = this.options.has(optionName);
    if (isOptional && !existing) {
      if (!isLoggingSystemOption(optionName) && !isReload) {
        logWithSeverity(
          this.policy.unknownOptionSeverity,
          fileName,
          `> Config::LoadFile: Found incorrect option '${optionName}' in config file '${fileName}'. Skip`,
        );
      }
      return;
    }
    if (existing) {
      this.options.delete(optionName);
    }
    this.options.set(optionName, optionKey);
  }

  private getEnvFromCache(configName: string, envName: string): string | null {
    const cached = this.envVarCache.get(envName);
    if (cached === undefined) {
      const found = this.envVarForIniKey(configName);
      if (found !== null) {
        this.envVarCache.set(envName, found);
      }
      return found;
    }
    return cached;
  }

  private envVarForIniKey(key: string): string | null {
    const value = process.env[envVarNameFor(key)];
    if (value === undefined) {
      return null;
    }
    return value;
  }
}
