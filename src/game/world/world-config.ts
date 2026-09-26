import type { ConfigMgr } from "../../common/config.ts";
import { log } from "../../log.ts";
import { ServerConfig, WORLD_CONFIG_ENTRIES, type ConfigValue, type WorldConfigEntry } from "./world-config-data.ts";

type Slot = {
  type: WorldConfigEntry["type"];
  value: ConfigValue;
};

/** Typed cache of every `ServerConfigs` value, filled in `WorldConfig::BuildConfigCache` order. */
export class WorldConfig {
  private readonly slots: Array<Slot | undefined>;
  private reloading = false;

  constructor(private readonly config: ConfigMgr) {
    this.slots = Array.from({ length: ServerConfig.MAX_NUM_SERVER_CONFIGS });
  }

  load(reload = false): void {
    this.reloading = reload;
    if (!reload) {
      this.slots.fill(undefined);
    }
    for (const entry of WORLD_CONFIG_ENTRIES) {
      this.setEntry(entry);
    }
    this.reloading = false;
    for (let index = 0; index < ServerConfig.MAX_NUM_SERVER_CONFIGS; index++) {
      if (!this.slots[index]) {
        throw new Error(`Server Config (Index: ${index}) is defined but not loaded, unable to continue.`);
      }
    }
  }

  getBool(id: ServerConfig): boolean {
    const slot = this.slot(id);
    if (slot.type !== "bool" || typeof slot.value !== "boolean") {
      throw new Error(`Wrong config variant type ${id}`);
    }
    return slot.value;
  }

  getUInt(id: ServerConfig): number {
    const slot = this.slot(id);
    if (slot.type !== "uint32" || typeof slot.value !== "number") {
      throw new Error(`Wrong config variant type ${id}`);
    }
    return slot.value;
  }

  getFloat(id: ServerConfig): number {
    const slot = this.slot(id);
    if (slot.type !== "float" || typeof slot.value !== "number") {
      throw new Error(`Wrong config variant type ${id}`);
    }
    return slot.value;
  }

  getString(id: ServerConfig): string {
    const slot = this.slot(id);
    if (slot.type !== "string" || typeof slot.value !== "string") {
      throw new Error(`Wrong config variant type ${id}`);
    }
    return slot.value;
  }

  overwrite(id: ServerConfig, value: ConfigValue): void {
    const slot = this.slot(id);
    if (!sameKind(slot, value)) {
      throw new Error(`Config value type changed ${id}`);
    }
    slot.value = value;
  }

  private setEntry(entry: WorldConfigEntry): void {
    const fallback = this.resolveDefault(entry);
    const value = this.readConfig(entry, fallback);
    const previous = this.slots[entry.id];
    if (this.reloading) {
      if (!entry.reloadable) {
        if (!previous || previous.value !== value) {
          log(
            "server",
            `Server Config (Name: ${entry.key}) cannot be changed by reload. A server restart is required to update this config value.`,
          );
        }
        return;
      }
    } else if (previous) {
      throw new Error(`Config overwriting an existing value ${entry.key}`);
    }
    if (entry.check && !entry.check(value, (id) => this.slot(id).value)) {
      log(
        "server",
        `Server Config (Name: ${entry.key}) failed validation check '${entry.checkText ?? ""}'. Default value '${String(fallback)}' will be used instead.`,
      );
      this.slots[entry.id] = { type: entry.type, value: fallback };
      return;
    }
    this.slots[entry.id] = { type: entry.type, value };
  }

  private resolveDefault(entry: WorldConfigEntry): ConfigValue {
    if (typeof entry.defaultValue === "function") {
      return entry.defaultValue((id) => this.slot(id).value);
    }
    return entry.defaultValue;
  }

  private readConfig(entry: WorldConfigEntry, fallback: ConfigValue): ConfigValue {
    switch (entry.type) {
      case "bool":
        return this.config.getBool(entry.key, fallback === true, true);
      case "uint32":
        return this.config.getUInt(entry.key, typeof fallback === "number" ? fallback : 0, true);
      case "float":
        return this.config.getFloat(entry.key, typeof fallback === "number" ? fallback : 0, true);
      case "string":
        return this.config.getString(entry.key, typeof fallback === "string" ? fallback : "", true);
      default: {
        const unreachable: never = entry.type;
        throw new Error(`unknown config type ${String(unreachable)}`);
      }
    }
  }

  private slot(id: ServerConfig): Slot {
    const slot = this.slots[id];
    if (!slot) {
      throw new Error(`Config value must already be set ${id}`);
    }
    return slot;
  }
}

function sameKind(slot: Slot, value: ConfigValue): boolean {
  switch (slot.type) {
    case "bool":
      return typeof value === "boolean";
    case "uint32":
    case "float":
      return typeof value === "number";
    case "string":
      return typeof value === "string";
    default: {
      const unreachable: never = slot.type;
      throw new Error(`unknown config type ${String(unreachable)}`);
    }
  }
}

export { ServerConfig };
