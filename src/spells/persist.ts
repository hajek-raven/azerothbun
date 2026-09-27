import { asc, eq } from "drizzle-orm";
import type { Db } from "../database/database.ts";
import { character_aura, character_spell_cooldown } from "../database/schema/characters.ts";

/** Columns from `db_characters.character_aura`, including the values needed to recalculate effects on login. */
export type SavedAura = {
  guid: number;
  casterGuid: bigint;
  itemGuid: bigint;
  spell: number;
  effectMask: number;
  recalculateMask: number;
  stackCount: number;
  amount0: number;
  amount1: number;
  amount2: number;
  base_amount0: number;
  base_amount1: number;
  base_amount2: number;
  maxDuration: number;
  remainTime: number;
  remainCharges: number;
};

/** Columns from `db_characters.character_spell_cooldown`. `time` is absolute Unix seconds. */
export type SavedSpellCooldown = {
  guid: number;
  spell: number;
  category: number;
  item: number;
  time: number;
  needSend: number;
};

export async function loadSpellState(db: Db, guid: number): Promise<{ auras: SavedAura[]; cooldowns: SavedSpellCooldown[] }> {
  const auras = await db
    .select()
    .from(character_aura)
    .where(eq(character_aura.guid, guid))
    .orderBy(asc(character_aura.spell), asc(character_aura.casterGuid), asc(character_aura.itemGuid));
  const cooldowns = (await db
    .select()
    .from(character_spell_cooldown)
    .where(eq(character_spell_cooldown.guid, guid))
    .orderBy(asc(character_spell_cooldown.spell))).map((row) => ({ ...row, category: row.category ?? 0 }));
  return { auras, cooldowns };
}

export async function saveSpellState(db: Db, guid: number, auras: readonly SavedAura[], cooldowns: readonly SavedSpellCooldown[]): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(character_aura).where(eq(character_aura.guid, guid));
    if (auras.length > 0) {
      await tx.insert(character_aura).values(auras.map((aura) => ({
        ...aura,
        guid,
        casterGuid: BigInt.asUintN(64, aura.casterGuid),
        itemGuid: BigInt.asUintN(64, aura.itemGuid),
      })));
    }
    await tx.delete(character_spell_cooldown).where(eq(character_spell_cooldown.guid, guid));
    if (cooldowns.length > 0) {
      await tx.insert(character_spell_cooldown).values(cooldowns.map((cooldown) => ({ ...cooldown, guid })));
    }
  });
}
