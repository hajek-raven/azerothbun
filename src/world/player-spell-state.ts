import { Aura } from "../spells/aura.ts";
import type { SavedAura, SavedSpellCooldown } from "../spells/persist.ts";
import { isPositive } from "../spells/spell-info.ts";
import type { SpellUnit } from "../spells/unit.ts";

/** `infinityCooldownDelayCheck`: cooldowns past half a month are "infinite" and are not saved. */
const INFINITY_COOLDOWN_DELAY_CHECK = 15 * 24 * 3600 * 1000;

/**
 * `Player::_LoadAuras`: recreate the saved auras on the player. Negative auras kept counting down while the
 * player was offline; charges are clamped to the spell's proc charges.
 */
export function loadPlayerAuras(unit: SpellUnit, rows: readonly SavedAura[], offlineSeconds: number): void {
  for (const row of rows) {
    const info = unit.world.spells.get(row.spell);
    if (!info) continue;
    let remaining = row.remainTime;
    if (remaining !== -1 && !isPositive(info)) {
      if (remaining / 1000 <= offlineSeconds) continue;
      remaining -= offlineSeconds * 1000;
    }
    let charges = row.remainCharges;
    if (info.procCharges) {
      if (charges <= 0 || charges > info.procCharges) charges = info.procCharges;
    } else {
      charges = 0;
    }
    const aura = Aura.tryCreate(info, row.effectMask, unit, null, {
      baseAmount: [row.base_amount0, row.base_amount1, row.base_amount2],
      castItemGuid: row.itemGuid,
      casterGuid: row.casterGuid,
    });
    if (!aura) continue;
    if (!aura.canBeSaved()) {
      aura.remove();
      continue;
    }
    aura.setLoadedState(row.maxDuration, remaining, charges, row.stackCount, row.recalculateMask, [row.amount0, row.amount1, row.amount2]);
    aura.applyForTargetsNow();
  }
}

/** `Player::_SaveAuras`: every owned aura that `CanBeSaved`. */
export function savePlayerAuras(unit: SpellUnit, guid: number): SavedAura[] {
  const rows: SavedAura[] = [];
  for (const aura of unit.ownedAuras) {
    if (aura.isRemoved || !aura.canBeSaved()) continue;
    const amounts = [0, 0, 0];
    const baseAmounts = [0, 0, 0];
    let effectMask = 0;
    let recalculateMask = 0;
    aura.effects.forEach((effect, index) => {
      if (!effect) return;
      baseAmounts[index] = effect.baseAmount;
      amounts[index] = effect.amount;
      effectMask |= 1 << index;
      if (effect.canBeRecalculated) recalculateMask |= 1 << index;
    });
    rows.push({
      guid,
      casterGuid: aura.casterGuid,
      itemGuid: aura.castItemGuid,
      spell: aura.id,
      effectMask,
      recalculateMask,
      stackCount: aura.stackAmount,
      amount0: amounts[0]!,
      amount1: amounts[1]!,
      amount2: amounts[2]!,
      base_amount0: baseAmounts[0]!,
      base_amount1: baseAmounts[1]!,
      base_amount2: baseAmounts[2]!,
      maxDuration: aura.maxDuration,
      remainTime: aura.duration,
      remainCharges: aura.procCharges,
    });
  }
  return rows;
}

/** `Player::_LoadSpellCooldowns`: rows still running go back into the cooldown map. */
export function loadPlayerCooldowns(unit: SpellUnit, rows: readonly SavedSpellCooldown[], nowSeconds: number): void {
  const now = unit.world.now();
  for (const row of rows) {
    if (row.time <= nowSeconds) continue;
    unit.spellCooldowns.set(row.spell, { end: now + (row.time - nowSeconds) * 1000, category: row.category, item: row.item, needSend: row.needSend !== 0 });
  }
}

/** `Player::_SaveSpellCooldowns`: cooldowns with more than a second left, without the infinite ones. */
export function savePlayerCooldowns(unit: SpellUnit, guid: number, nowSeconds: number): SavedSpellCooldown[] {
  const now = unit.world.now();
  const rows: SavedSpellCooldown[] = [];
  for (const [spell, row] of unit.spellCooldowns) {
    const remaining = row.end - now;
    if (remaining <= 1000 || remaining >= INFINITY_COOLDOWN_DELAY_CHECK) continue;
    rows.push({ guid, spell, category: row.category, item: row.item, time: nowSeconds + Math.ceil(remaining / 1000), needSend: row.needSend ? 1 : 0 });
  }
  return rows;
}
