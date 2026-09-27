/**
 * Item sets, enchantments, and sockets — rules and data only.
 *
 * Ports AzerothCore:
 * - SpellItemEnchantment.dbc / `spellitemenchantment_dbc`
 * - ItemSet.dbc / `itemset_dbc`
 * - GemProperties.dbc / `gemproperties_dbc`
 * - `item_template` socketColor_1..3, socketBonus
 * - Player::ApplyEnchantment (equip-spell ids only; no aura application)
 * - Item::GemsFitSockets / WorldSession::HandleSocketOpcode gem color rules
 * - AddItemsSetItem threshold spells
 * - ItemEnchantmentMgr::GetItemEnchantMod / Item::GenerateItemRandomPropertyId
 *
 * DBC/SQL gap: `data/dbc` has no ItemSet.dbc, SpellItemEnchantment.dbc, or
 * GemProperties.dbc. World SQL tables `itemset_dbc`, `spellitemenchantment_dbc`,
 * and `gemproperties_dbc` are schema-only (0 rows). Callers supply records via
 * fixtures, `*FromSqlRow`, or `parseWdbc` once binaries are present.
 * `item_enchantment_template` is populated and used by generateRandomPropertyId.
 */

import { irand, randChance } from "../common/random.ts";
import { parseWdbc, type DbcRecord } from "../data/dbc.ts";

/** Files expected under `data/dbc` but currently missing from this tree. */
export const ENCHANT_DBC_GAPS = [
  "ItemSet.dbc",
  "SpellItemEnchantment.dbc",
  "GemProperties.dbc",
] as const;

/** SQL DBC tables present but empty in `data/world.sqlite`. */
export const ENCHANT_SQL_DBC_GAPS = [
  "itemset_dbc",
  "spellitemenchantment_dbc",
  "gemproperties_dbc",
] as const;

export const MAX_SPELL_ITEM_ENCHANTMENT_EFFECTS = 3;
export const MAX_ITEM_SET_ITEMS = 10;
export const MAX_ITEM_SET_SPELLS = 8;
export const MAX_GEM_SOCKETS = 3;

/** SocketColor in ItemTemplate.h */
export const SOCKET_COLOR_META = 1;
export const SOCKET_COLOR_RED = 2;
export const SOCKET_COLOR_YELLOW = 4;
export const SOCKET_COLOR_BLUE = 8;
export const SOCKET_COLOR_ALL =
  SOCKET_COLOR_META | SOCKET_COLOR_RED | SOCKET_COLOR_YELLOW | SOCKET_COLOR_BLUE;

/** ItemEnchantmentType in DBCEnums.h */
export const ITEM_ENCHANTMENT_TYPE_NONE = 0;
export const ITEM_ENCHANTMENT_TYPE_COMBAT_SPELL = 1;
export const ITEM_ENCHANTMENT_TYPE_DAMAGE = 2;
export const ITEM_ENCHANTMENT_TYPE_EQUIP_SPELL = 3;
export const ITEM_ENCHANTMENT_TYPE_RESISTANCE = 4;
export const ITEM_ENCHANTMENT_TYPE_STAT = 5;
export const ITEM_ENCHANTMENT_TYPE_TOTEM = 6;
export const ITEM_ENCHANTMENT_TYPE_USE_SPELL = 7;
export const ITEM_ENCHANTMENT_TYPE_PRISMATIC_SOCKET = 8;

export type ItemEnchantmentType =
  | typeof ITEM_ENCHANTMENT_TYPE_NONE
  | typeof ITEM_ENCHANTMENT_TYPE_COMBAT_SPELL
  | typeof ITEM_ENCHANTMENT_TYPE_DAMAGE
  | typeof ITEM_ENCHANTMENT_TYPE_EQUIP_SPELL
  | typeof ITEM_ENCHANTMENT_TYPE_RESISTANCE
  | typeof ITEM_ENCHANTMENT_TYPE_STAT
  | typeof ITEM_ENCHANTMENT_TYPE_TOTEM
  | typeof ITEM_ENCHANTMENT_TYPE_USE_SPELL
  | typeof ITEM_ENCHANTMENT_TYPE_PRISMATIC_SOCKET;

/** AzerothCore SpellItemEnchantmentEntryfmt */
export const SPELL_ITEM_ENCHANTMENT_FMT = "niiiiiiixxxiiissssssssssssssssxiiiiiii";

/** AzerothCore ItemSetEntryfmt */
export const ITEM_SET_FMT = "dssssssssssssssssxiiiiiiiiiixxxxxxxiiiiiiiiiiiiiiiiii";

/** AzerothCore GemPropertiesEntryfmt */
export const GEM_PROPERTIES_FMT = "nixxi";

export type EnchantmentEffect = {
  type: number;
  amount: number;
  /** EffectArg — spell id, resistance school, or ITEM_MOD_* depending on type. */
  spellId: number;
};

/**
 * Resolved enchantment: instance slot fields plus the three DBC effects.
 * `effectSpellIds` are EffectArg values for non-NONE effects (raw DBC args).
 */
export type EnchantmentRecord = {
  id: number;
  duration: number;
  charges: number;
  effects: [EnchantmentEffect, EnchantmentEffect, EnchantmentEffect];
  effectSpellIds: number[];
  gemId: number;
  requiredSkill: number;
  requiredSkillValue: number;
  requiredLevel: number;
  enchantmentCondition: number;
};

/** SpellItemEnchantment.dbc / spellitemenchantment_dbc row (no instance duration). */
export type SpellItemEnchantment = {
  id: number;
  charges: number;
  effects: [EnchantmentEffect, EnchantmentEffect, EnchantmentEffect];
  gemId: number;
  enchantmentCondition: number;
  requiredSkill: number;
  requiredSkillValue: number;
  requiredLevel: number;
};

export type ItemSetEntry = {
  id: number;
  name: string;
  itemIds: number[];
  spells: number[];
  thresholds: number[];
  requiredSkillId: number;
  requiredSkillValue: number;
};

export type GemProperties = {
  id: number;
  enchantId: number;
  color: number;
};

/** item_template socket fields used by this module. */
export type SocketItemTemplate = {
  socketColor_1: number;
  socketColor_2: number;
  socketColor_3: number;
  socketBonus: number;
};

export type EquippedSetPiece = {
  /** `item_template.itemset` */
  itemSet: number;
};

export type ItemEnchantSlot = {
  id: number;
  duration: number;
  charges: number;
};

export type SocketGemItem = {
  template: SocketItemTemplate;
  /** Enchant ids currently in SOCK slots 0..2 (0 = empty). */
  socketEnchantIds: [number, number, number];
  /** True when PRISMATIC_ENCHANTMENT_SLOT is set (extra color-0 socket). */
  hasPrismaticSocket: boolean;
};

export type SocketGemInput = {
  /** GemProperties.color */
  color: number;
  /** GemProperties.spellitemenchantement */
  enchantId: number;
};

export type SocketGemResult =
  | {
      ok: true;
      enchantId: number;
      socketEnchantIds: [number, number, number];
      /** Present when GemsFitSockets is true after this insert. */
      socketBonusEnchantId: number | null;
      socketBonusSpellIds: number[];
    }
  | {
      ok: false;
      reason: "no_socket" | "color_mismatch" | "missing_gem_enchant";
    };

export type RandomPropertyTemplate = {
  entry: number;
  RandomProperty: number;
  RandomSuffix: number;
};

export type EnchantChanceRow = {
  ench: number;
  chance: number;
};

const SPELL_ITEM_ENCHANTMENT_FIELDS = (() => {
  const fields: string[] = [];
  fields.push("ID");
  fields.push("Charges");
  for (let i = 1; i <= 3; i += 1) {
    fields.push(`Effect_${i}`);
  }
  for (let i = 1; i <= 3; i += 1) {
    fields.push(`EffectPointsMin_${i}`);
  }
  // EffectPointsMax_1..3 skipped by xxx in format
  for (let i = 1; i <= 3; i += 1) {
    fields.push(`EffectArg_${i}`);
  }
  for (let i = 0; i < 16; i += 1) {
    fields.push(`Name_${i}`);
  }
  fields.push("ItemVisual");
  fields.push("Flags");
  fields.push("Src_ItemID");
  fields.push("Condition_Id");
  fields.push("RequiredSkillID");
  fields.push("RequiredSkillRank");
  fields.push("MinLevel");
  return fields;
})();

const ITEM_SET_FIELDS = (() => {
  const fields: string[] = ["ID"];
  for (let i = 0; i < 16; i += 1) {
    fields.push(`Name_${i}`);
  }
  for (let i = 1; i <= 10; i += 1) {
    fields.push(`ItemID_${i}`);
  }
  // 7 unused item id slots skipped by xxxxxxx
  for (let i = 1; i <= 8; i += 1) {
    fields.push(`SetSpellID_${i}`);
  }
  for (let i = 1; i <= 8; i += 1) {
    fields.push(`SetThreshold_${i}`);
  }
  fields.push("RequiredSkill");
  fields.push("RequiredSkillRank");
  return fields;
})();

const GEM_PROPERTIES_FIELDS = ["ID", "Enchant_Id", "Type"];

function num(record: DbcRecord | Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" ? value : Number(value ?? 0) || 0;
}

function str(record: DbcRecord | Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function effectTriple(types: number[], amounts: number[], spellIds: number[]): [EnchantmentEffect, EnchantmentEffect, EnchantmentEffect] {
  return [
    { type: types[0] ?? 0, amount: amounts[0] ?? 0, spellId: spellIds[0] ?? 0 },
    { type: types[1] ?? 0, amount: amounts[1] ?? 0, spellId: spellIds[1] ?? 0 },
    { type: types[2] ?? 0, amount: amounts[2] ?? 0, spellId: spellIds[2] ?? 0 },
  ];
}

function effectSpellIdsFromEffects(effects: EnchantmentEffect[]): number[] {
  const ids: number[] = [];
  for (const effect of effects) {
    if (effect.type === ITEM_ENCHANTMENT_TYPE_NONE) {
      continue;
    }
    if (effect.spellId) {
      ids.push(effect.spellId);
    }
  }
  return ids;
}

export function spellItemEnchantmentFromRecord(record: DbcRecord | Record<string, unknown>): SpellItemEnchantment {
  const effects = effectTriple(
    [num(record, "Effect_1"), num(record, "Effect_2"), num(record, "Effect_3")],
    [num(record, "EffectPointsMin_1"), num(record, "EffectPointsMin_2"), num(record, "EffectPointsMin_3")],
    [num(record, "EffectArg_1"), num(record, "EffectArg_2"), num(record, "EffectArg_3")],
  );
  return {
    id: num(record, "ID"),
    charges: num(record, "Charges"),
    effects,
    gemId: num(record, "Src_ItemID"),
    enchantmentCondition: num(record, "Condition_Id"),
    requiredSkill: num(record, "RequiredSkillID"),
    requiredSkillValue: num(record, "RequiredSkillRank"),
    requiredLevel: num(record, "MinLevel"),
  };
}

/** Map a `spellitemenchantment_dbc` SQL row (same column names). */
export function spellItemEnchantmentFromSqlRow(row: Record<string, unknown>): SpellItemEnchantment {
  return spellItemEnchantmentFromRecord(row);
}

export function itemSetFromRecord(record: DbcRecord | Record<string, unknown>): ItemSetEntry {
  const itemIds: number[] = [];
  for (let i = 1; i <= MAX_ITEM_SET_ITEMS; i += 1) {
    const id = num(record, `ItemID_${i}`);
    if (id) {
      itemIds.push(id);
    }
  }
  const spells: number[] = [];
  const thresholds: number[] = [];
  for (let i = 1; i <= MAX_ITEM_SET_SPELLS; i += 1) {
    spells.push(num(record, `SetSpellID_${i}`));
    thresholds.push(num(record, `SetThreshold_${i}`));
  }
  return {
    id: num(record, "ID"),
    name: str(record, "Name_0") || str(record, "Name_Lang_enUS"),
    itemIds,
    spells,
    thresholds,
    requiredSkillId: num(record, "RequiredSkill"),
    requiredSkillValue: num(record, "RequiredSkillRank"),
  };
}

export function itemSetFromSqlRow(row: Record<string, unknown>): ItemSetEntry {
  return itemSetFromRecord(row);
}

export function gemPropertiesFromRecord(record: DbcRecord | Record<string, unknown>): GemProperties {
  return {
    id: num(record, "ID"),
    enchantId: num(record, "Enchant_Id"),
    // SQL column `Type` / DBC field after two skipped maxcount ints
    color: num(record, "Type") || num(record, "color"),
  };
}

export function gemPropertiesFromSqlRow(row: Record<string, unknown>): GemProperties {
  return gemPropertiesFromRecord(row);
}

export function parseSpellItemEnchantmentDbc(bytes: Uint8Array): Map<number, SpellItemEnchantment> {
  const map = new Map<number, SpellItemEnchantment>();
  for (const row of parseWdbc(bytes, SPELL_ITEM_ENCHANTMENT_FMT, SPELL_ITEM_ENCHANTMENT_FIELDS)) {
    const entry = spellItemEnchantmentFromRecord(row);
    map.set(entry.id, entry);
  }
  return map;
}

export function parseItemSetDbc(bytes: Uint8Array): Map<number, ItemSetEntry> {
  const map = new Map<number, ItemSetEntry>();
  for (const row of parseWdbc(bytes, ITEM_SET_FMT, ITEM_SET_FIELDS)) {
    const entry = itemSetFromRecord(row);
    map.set(entry.id, entry);
  }
  return map;
}

export function parseGemPropertiesDbc(bytes: Uint8Array): Map<number, GemProperties> {
  const map = new Map<number, GemProperties>();
  for (const row of parseWdbc(bytes, GEM_PROPERTIES_FMT, GEM_PROPERTIES_FIELDS)) {
    const entry = gemPropertiesFromRecord(row);
    map.set(entry.id, entry);
  }
  return map;
}

export function toEnchantmentRecord(
  slot: ItemEnchantSlot,
  enchant: SpellItemEnchantment,
): EnchantmentRecord {
  return {
    id: enchant.id,
    duration: slot.duration,
    charges: slot.charges !== 0 ? slot.charges : enchant.charges,
    effects: enchant.effects,
    effectSpellIds: effectSpellIdsFromEffects(enchant.effects),
    gemId: enchant.gemId,
    requiredSkill: enchant.requiredSkill,
    requiredSkillValue: enchant.requiredSkillValue,
    requiredLevel: enchant.requiredLevel,
    enchantmentCondition: enchant.enchantmentCondition,
  };
}

/**
 * Spell ids gained from ITEM_ENCHANTMENT_TYPE_EQUIP_SPELL effects.
 * Mirrors Player::ApplyEnchantment apply path without casting auras.
 */
export function applyEnchantments(
  itemEnchants: ReadonlyArray<ItemEnchantSlot>,
  equipped: boolean,
  enchantTable: ReadonlyMap<number, SpellItemEnchantment>,
): number[] {
  if (!equipped) {
    return [];
  }
  const spellIds: number[] = [];
  for (const slot of itemEnchants) {
    if (!slot.id) {
      continue;
    }
    const enchant = enchantTable.get(slot.id);
    if (!enchant) {
      continue;
    }
    for (const effect of enchant.effects) {
      const enchantType = effect.type as ItemEnchantmentType;
      switch (enchantType) {
        case ITEM_ENCHANTMENT_TYPE_NONE:
        case ITEM_ENCHANTMENT_TYPE_COMBAT_SPELL:
        case ITEM_ENCHANTMENT_TYPE_DAMAGE:
        case ITEM_ENCHANTMENT_TYPE_RESISTANCE:
        case ITEM_ENCHANTMENT_TYPE_STAT:
        case ITEM_ENCHANTMENT_TYPE_TOTEM:
        case ITEM_ENCHANTMENT_TYPE_USE_SPELL:
        case ITEM_ENCHANTMENT_TYPE_PRISMATIC_SOCKET:
          break;
        case ITEM_ENCHANTMENT_TYPE_EQUIP_SPELL:
          if (effect.spellId) {
            spellIds.push(effect.spellId);
          }
          break;
        default: {
          const _exhaustive: never = enchantType;
          void _exhaustive;
          break;
        }
      }
    }
  }
  return spellIds;
}

export function socketColorsOf(template: SocketItemTemplate): [number, number, number] {
  return [template.socketColor_1, template.socketColor_2, template.socketColor_3];
}

/**
 * Socket-bonus color check: `(gemColor & socketColor) !== 0`.
 * Meta requires meta; prismatic gems (color mask with R|Y|B) match any colored socket.
 */
export function gemColorMatchesSocket(gemColor: number, socketColor: number): boolean {
  if (!socketColor) {
    return false;
  }
  return (gemColor & socketColor) !== 0;
}

/**
 * HandleSocketOpcode insert rules: meta↔meta only; non-meta gems may enter any
 * non-meta socket (wrong hue still sockets; bonus is separate).
 */
export function canSocketGem(
  item: SocketGemItem,
  socketIndex: number,
  gem: SocketGemInput,
): "ok" | "no_socket" | "color_mismatch" {
  if (socketIndex < 0 || socketIndex >= MAX_GEM_SOCKETS) {
    return "no_socket";
  }
  const colors = socketColorsOf(item.template);
  const socketColor = colors[socketIndex]!;

  let firstPrismatic = 0;
  while (firstPrismatic < MAX_GEM_SOCKETS && colors[firstPrismatic]) {
    firstPrismatic += 1;
  }

  if (!socketColor) {
    if (!item.hasPrismaticSocket) {
      return "no_socket";
    }
    if (socketIndex !== firstPrismatic) {
      return "no_socket";
    }
  }

  if (socketColor === SOCKET_COLOR_META && gem.color !== SOCKET_COLOR_META) {
    return "color_mismatch";
  }
  if (socketColor !== SOCKET_COLOR_META && gem.color === SOCKET_COLOR_META) {
    return "color_mismatch";
  }
  return "ok";
}

/**
 * Item::GemsFitSockets — every built-in colored socket must hold a gem whose
 * GemProperties.color intersects the socket color.
 */
export function gemsFitSockets(
  template: SocketItemTemplate,
  socketEnchantIds: ReadonlyArray<number>,
  enchantTable: ReadonlyMap<number, SpellItemEnchantment>,
  gemColorByEnchantId: ReadonlyMap<number, number>,
): boolean {
  const colors = socketColorsOf(template);
  for (let i = 0; i < MAX_GEM_SOCKETS; i += 1) {
    const socketColor = colors[i]!;
    if (!socketColor) {
      continue;
    }
    const enchantId = socketEnchantIds[i] ?? 0;
    if (!enchantId) {
      return false;
    }
    if (!enchantTable.has(enchantId)) {
      return false;
    }
    const gemColor = gemColorByEnchantId.get(enchantId) ?? 0;
    if (!gemColorMatchesSocket(gemColor, socketColor)) {
      return false;
    }
  }
  return true;
}

/**
 * Insert a gem into a socket. On success, if all colored sockets match, returns
 * the template `socketBonus` enchant id and its equip-spell ids.
 */
export function socketGem(
  item: SocketGemItem,
  socketIndex: number,
  gem: SocketGemInput,
  enchantTable: ReadonlyMap<number, SpellItemEnchantment>,
  gemColorByEnchantId: ReadonlyMap<number, number>,
): SocketGemResult {
  if (!gem.enchantId) {
    return { ok: false, reason: "missing_gem_enchant" };
  }
  const gate = canSocketGem(item, socketIndex, gem);
  if (gate === "no_socket") {
    return { ok: false, reason: "no_socket" };
  }
  if (gate === "color_mismatch") {
    return { ok: false, reason: "color_mismatch" };
  }

  const socketEnchantIds: [number, number, number] = [
    item.socketEnchantIds[0],
    item.socketEnchantIds[1],
    item.socketEnchantIds[2],
  ];
  socketEnchantIds[socketIndex] = gem.enchantId;

  const colorByEnchant = new Map(gemColorByEnchantId);
  colorByEnchant.set(gem.enchantId, gem.color);

  const bonusActive = gemsFitSockets(item.template, socketEnchantIds, enchantTable, colorByEnchant);
  const socketBonusEnchantId = bonusActive && item.template.socketBonus ? item.template.socketBonus : null;
  const socketBonusSpellIds =
    socketBonusEnchantId !== null
      ? applyEnchantments([{ id: socketBonusEnchantId, duration: 0, charges: 0 }], true, enchantTable)
      : [];

  return {
    ok: true,
    enchantId: gem.enchantId,
    socketEnchantIds,
    socketBonusEnchantId,
    socketBonusSpellIds,
  };
}

/**
 * Active set-bonus spell ids for currently equipped pieces.
 * Counts pieces sharing each `itemSet` id; activates spells whose threshold
 * (`SetThreshold_N`) is <= equipped count (AddItemsSetItem).
 */
export function itemSetBonuses(
  equippedEntries: ReadonlyArray<EquippedSetPiece>,
  setTable: ReadonlyMap<number, ItemSetEntry>,
): number[] {
  const counts = new Map<number, number>();
  for (const piece of equippedEntries) {
    if (!piece.itemSet) {
      continue;
    }
    counts.set(piece.itemSet, (counts.get(piece.itemSet) ?? 0) + 1);
  }

  const active: number[] = [];
  for (const [setId, count] of counts) {
    const set = setTable.get(setId);
    if (!set) {
      continue;
    }
    for (let i = 0; i < MAX_ITEM_SET_SPELLS; i += 1) {
      const spellId = set.spells[i] ?? 0;
      const threshold = set.thresholds[i] ?? 0;
      if (!spellId || !threshold) {
        continue;
      }
      if (threshold <= count) {
        active.push(spellId);
      }
    }
  }
  return active;
}

/**
 * ItemEnchantmentMgr::GetItemEnchantMod — weighted pick from
 * `item_enchantment_template` rows for one RandomProperty / RandomSuffix entry.
 */
export function getItemEnchantMod(entry: number, chances: ReadonlyArray<EnchantChanceRow>): number {
  if (!entry || entry === -1) {
    return 0;
  }
  if (chances.length === 0) {
    return 0;
  }

  let dRoll = randChance();
  let fCount = 0;
  for (const row of chances) {
    fCount += row.chance;
    if (fCount > dRoll) {
      return row.ench;
    }
  }

  dRoll = irand(0, Math.floor(fCount * 100) + 1) / 100;
  fCount = 0;
  for (const row of chances) {
    fCount += row.chance;
    if (fCount > dRoll) {
      return row.ench;
    }
  }
  return 0;
}

/**
 * Item::GenerateItemRandomPropertyId without DBC existence checks for the
 * rolled id (ItemRandomProperties / ItemRandomSuffix stores are a separate gap).
 * Positive id = property; negative id = suffix.
 */
export function generateRandomPropertyId(
  entry: number,
  templates: ReadonlyMap<number, RandomPropertyTemplate>,
  enchantChances: ReadonlyMap<number, ReadonlyArray<EnchantChanceRow>>,
): number {
  const template = templates.get(entry);
  if (!template) {
    return 0;
  }
  if (!template.RandomProperty && !template.RandomSuffix) {
    return 0;
  }
  if (template.RandomProperty && template.RandomSuffix) {
    return 0;
  }
  if (template.RandomProperty) {
    const rows = enchantChances.get(template.RandomProperty) ?? [];
    return getItemEnchantMod(template.RandomProperty, rows);
  }
  const rows = enchantChances.get(template.RandomSuffix) ?? [];
  const rolled = getItemEnchantMod(template.RandomSuffix, rows);
  return rolled ? -rolled : 0;
}
