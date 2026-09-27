import { ByteWriter } from "../net/byte-buffer.ts";
import { packedGuid } from "../world/update-object.ts";
import {
  CLASS_DEATH_KNIGHT,
  MAX_POWERS,
  POWER_ENERGY,
  POWER_MANA,
  POWER_RAGE,
  POWER_RUNIC_POWER,
  UNIT_FIELD_POWER_REGEN_FLAT_MODIFIER,
  UNIT_FIELD_POWER_REGEN_INTERRUPTED_FLAT_MODIFIER,
  type PlayerStats,
} from "./player-stats.ts";

/** `Rate.Health`, `Rate.Mana`, `Rate.Rage.Loss`, `Rate.RunicPower.Loss`, `Rate.Energy`, `LowLevelRegenBoost`. */
export type RegenRates = {
  health: number;
  mana: number;
  rageLoss: number;
  runicPowerLoss: number;
  energy: number;
  lowLevelRegenBoost: boolean;
};

export const DEFAULT_REGEN_RATES: RegenRates = {
  health: 1,
  mana: 1,
  rageLoss: 1,
  runicPowerLoss: 1,
  energy: 1,
  lowLevelRegenBoost: false,
};

/** What the unit is doing this tick; the answers come from combat, stand state, and the spell system. */
export type RegenState = {
  inCombat: boolean;
  /** `Unit::IsStandState` — not sitting, sleeping, or kneeling. */
  standing: boolean;
  /** `Player::IsUnderLastManaUseEffect` — cast within the last five seconds. */
  recentManaUse: boolean;
};

/** A `SetPower(..., fromRegenerate=true)` that sends `SMSG_POWER_UPDATE`. */
export type PowerUpdate = { power: number; value: number };

const UNIT_STAND_STATE_SIT = 1;
const UNIT_STAND_STATE_SIT_CHAIR = 2;
const UNIT_STAND_STATE_SLEEP = 3;
const UNIT_STAND_STATE_SIT_LOW_CHAIR = 4;
const UNIT_STAND_STATE_SIT_MEDIUM_CHAIR = 5;
const UNIT_STAND_STATE_SIT_HIGH_CHAIR = 6;
const UNIT_STAND_STATE_KNEEL = 8;

/** `Unit::IsStandState`. */
export function isStandState(standState: number): boolean {
  switch (standState) {
    case UNIT_STAND_STATE_SIT:
    case UNIT_STAND_STATE_SIT_CHAIR:
    case UNIT_STAND_STATE_SIT_LOW_CHAIR:
    case UNIT_STAND_STATE_SIT_MEDIUM_CHAIR:
    case UNIT_STAND_STATE_SIT_HIGH_CHAIR:
    case UNIT_STAND_STATE_SLEEP:
    case UNIT_STAND_STATE_KNEEL:
      return false;
    default:
      return true;
  }
}

const f = Math.fround;

/**
 * `Player::RegenerateAll`, `Player::Regenerate`, and `Player::RegenerateHealth` with the regen timers and
 * `m_powerFraction`. Auras that change regen (drink, food, Spirit Tap, ...) join with the aura system.
 */
export class PlayerRegen {
  private regenTimer = 0;
  private regenTimerCount = 0;
  private readonly powerFraction = new Array<number>(MAX_POWERS).fill(0);

  constructor(
    private readonly stats: PlayerStats,
    private readonly rates: RegenRates = DEFAULT_REGEN_RATES,
  ) {}

  /** `Player::Update` — `if (IsAlive()) { m_regenTimer += p_time; RegenerateAll(); }`. */
  update(diff: number, alive: boolean, state: RegenState): PowerUpdate[] {
    if (!alive) {
      return [];
    }
    this.regenTimer += diff;
    return this.regenerateAll(state);
  }

  private regenerateAll(state: RegenState): PowerUpdate[] {
    const updates: PowerUpdate[] = [];
    this.regenTimerCount += this.regenTimer;
    this.regenerate(POWER_ENERGY, state, updates);
    this.regenerate(POWER_MANA, state, updates);
    if (this.regenTimerCount >= 2000) {
      if (!state.inCombat || this.stats.baseHealthRegen) {
        this.regenerateHealth(state);
      }
      this.regenerate(POWER_RAGE, state, updates);
      if (this.stats.classId === CLASS_DEATH_KNIGHT) {
        this.regenerate(POWER_RUNIC_POWER, state, updates);
      }
      this.regenTimerCount -= 2000;
    }
    this.regenTimer = 0;
    return updates;
  }

  private lowLevelRate(rate: number): number {
    const level = this.stats.level;
    if (this.rates.lowLevelRegenBoost && level < 15) {
      return f(rate * (2.066 - level * 0.066));
    }
    return rate;
  }

  /** `Player::Regenerate`. */
  private regenerate(power: number, state: RegenState, updates: PowerUpdate[]): void {
    const maxValue = this.stats.maxPower(power);
    if (!maxValue) {
      return;
    }
    let curValue = this.stats.power(power);
    let addvalue = 0;
    switch (power) {
      case POWER_MANA: {
        const manaIncreaseRate = this.lowLevelRate(this.rates.mana);
        const field = state.recentManaUse
          ? UNIT_FIELD_POWER_REGEN_INTERRUPTED_FLAT_MODIFIER + POWER_MANA
          : UNIT_FIELD_POWER_REGEN_FLAT_MODIFIER + POWER_MANA;
        addvalue += f(this.stats.getFloat(field) * manaIncreaseRate * 0.001 * this.regenTimer);
        break;
      }
      case POWER_RAGE:
        if (!state.inCombat) {
          addvalue += -20 * this.rates.rageLoss;
        }
        break;
      case POWER_ENERGY:
        addvalue += this.stats.getFloat(UNIT_FIELD_POWER_REGEN_FLAT_MODIFIER + POWER_ENERGY) + 10;
        addvalue *= 0.001;
        addvalue *= this.regenTimer;
        addvalue *= this.rates.energy;
        addvalue = f(addvalue);
        break;
      case POWER_RUNIC_POWER:
        if (!state.inCombat) {
          addvalue += -30 * this.rates.runicPowerLoss;
        }
        break;
      default:
        return;
    }

    if (addvalue < 0) {
      if (curValue === 0) {
        return;
      }
    } else if (addvalue > 0) {
      if (curValue === maxValue) {
        return;
      }
    } else {
      return;
    }

    addvalue = f(addvalue + this.powerFraction[power]!);
    const integerValue = Math.trunc(Math.abs(addvalue));
    if (addvalue < 0) {
      if (curValue > integerValue) {
        curValue -= integerValue;
        this.powerFraction[power] = f(addvalue + integerValue);
      } else {
        curValue = 0;
        this.powerFraction[power] = 0;
      }
    } else {
      curValue += integerValue;
      if (curValue >= maxValue) {
        curValue = maxValue;
        this.powerFraction[power] = 0;
      } else {
        this.powerFraction[power] = f(addvalue - integerValue);
      }
    }

    this.stats.setPower(power, curValue);
    if (this.regenTimerCount >= 2000 || curValue === 0 || curValue === maxValue) {
      updates.push({ power, value: this.stats.power(power) });
    }
  }

  /** `Player::RegenerateHealth`. */
  private regenerateHealth(state: RegenState): void {
    const curValue = this.stats.health;
    const maxValue = this.stats.maxHealth;
    if (curValue >= maxValue) {
      return;
    }
    const healthIncreaseRate = this.lowLevelRate(this.rates.health);
    let addvalue = 0;
    if (!state.inCombat) {
      addvalue = f(this.stats.octRegenHPPerSpirit() * healthIncreaseRate);
      if (!state.standing) {
        addvalue = f(addvalue * 1.33);
      }
    }
    addvalue = f(addvalue + this.stats.baseHealthRegen / 2.5);
    if (addvalue < 0) {
      addvalue = 0;
    }
    this.stats.modifyHealth(Math.trunc(addvalue));
  }
}

export const SMSG_POWER_UPDATE = 0x480;

/** `SMSG_POWER_UPDATE` from `Unit::SetPower`: packed guid, power, value. */
export function powerUpdatePacket(guid: number, power: number, value: number): Uint8Array {
  const writer = new ByteWriter().writeBytes(packedGuid(BigInt(guid))).writeU8(power).writeU32(value);
  return writer.toUint8Array();
}
