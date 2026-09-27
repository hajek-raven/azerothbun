import type { MySqlTable } from "drizzle-orm/mysql-core";
import * as worldSchema from "../database/schema/world.ts";
import type { WorldTables } from "../database/world-tables.ts";

/** The world tables loaded by `SpellMgr`, spell scripts, and the spell DBC database loaders. */
export const SPELL_WORLD_TABLES = [
  "spell_area", "spell_bonus_data", "spell_cone", "spell_cooldown_overrides", "spell_custom_attr",
  "spell_dbc", "spell_enchant_proc_data", "spell_group", "spell_group_stack_rules", "spell_jump_distance",
  "spell_linked_spell", "spell_loot_template", "spell_mixology", "spell_pet_auras", "spell_proc",
  "spell_proc_event", "spell_ranks", "spell_required", "spell_script_names", "spell_scripts",
  "spell_target_position", "spell_threat", "spellcasttimes_dbc", "spellcategory_dbc", "spelldifficulty_dbc",
  "spellduration_dbc", "spellfocusobject_dbc", "spellitemenchantment_dbc",
  "spellitemenchantmentcondition_dbc", "spellradius_dbc", "spellrange_dbc", "spellrunecost_dbc",
  "spellshapeshiftform_dbc", "spellvisual_dbc",
] as const;

export type SpellWorldTableName = (typeof SPELL_WORLD_TABLES)[number];

export function spellWorldTable(name: SpellWorldTableName): MySqlTable {
  return (worldSchema as unknown as Record<SpellWorldTableName, MySqlTable>)[name];
}
export type SpellWorldRow = Readonly<Record<string, number | string | null>>;
export type SpellRankRow = SpellWorldRow & { first_spell_id: number; spell_id: number; rank: number };
export type SpellRequiredRow = SpellWorldRow & { spell_id: number; req_spell: number };
export type SpellGroupRow = SpellWorldRow & { id: number; spell_id: number };
export type SpellGroupStackRow = SpellWorldRow & { group_id: number; stack_rule: number; description: string };
export type SpellLinkedRow = SpellWorldRow & { spell_trigger: number; spell_effect: number; type: number; comment: string };
export type SpellTargetPositionRow = SpellWorldRow & {
  ID: number; EffectIndex: number; MapID: number; PositionX: number; PositionY: number; PositionZ: number; Orientation: number; VerifiedBuild: number | null;
};

/** Full rows stay available to spell effects and scripts; indexes expose the relationships `SpellMgr` uses. */
export class SpellWorldData {
  private readonly tables = new Map<SpellWorldTableName, readonly SpellWorldRow[]>();
  private readonly ranks = new Map<number, SpellRankRow>();
  private readonly ranksByFirst = new Map<number, SpellRankRow[]>();
  private readonly requirements = new Map<number, SpellRequiredRow[]>();
  private readonly groups = new Map<number, SpellGroupRow[]>();
  private readonly groupRules = new Map<number, SpellGroupStackRow>();
  private readonly linked = new Map<string, SpellLinkedRow[]>();
  private readonly targets = new Map<string, SpellTargetPositionRow>();
  private spellSpellGroup: Map<number, number[]> | null = null;
  private scriptNames: Set<number> | null = null;
  private spellScripts: Set<string> | null = null;
  private petAuras: Set<string> | null = null;

  constructor(world: WorldTables | null) {
    for (const name of SPELL_WORLD_TABLES) {
      this.tables.set(name, world ? (world.all(spellWorldTable(name)) as readonly SpellWorldRow[]) : []);
    }
    for (const row of this.rows("spell_ranks") as SpellRankRow[]) {
      this.ranks.set(row.spell_id, row);
      append(this.ranksByFirst, row.first_spell_id, row);
    }
    for (const rows of this.ranksByFirst.values()) rows.sort((a, b) => a.rank - b.rank);
    for (const row of this.rows("spell_required") as SpellRequiredRow[]) append(this.requirements, row.spell_id, row);
    // `LoadSpellGroups` drops members that are not a first rank and nested ids that name no group.
    const groupIds = new Set((this.rows("spell_group") as SpellGroupRow[]).map((row) => row.id));
    for (const row of this.rows("spell_group") as SpellGroupRow[]) {
      if (row.spell_id < 0 ? !groupIds.has(-row.spell_id) : (this.rank(row.spell_id)?.rank ?? 1) > 1) continue;
      append(this.groups, row.id, row);
    }
    for (const row of this.rows("spell_group_stack_rules") as SpellGroupStackRow[]) this.groupRules.set(row.group_id, row);
    for (const row of this.rows("spell_linked_spell") as SpellLinkedRow[]) append(this.linked, `${row.type}:${row.spell_trigger}`, row);
    for (const row of this.rows("spell_target_position") as SpellTargetPositionRow[]) this.targets.set(`${row.ID}:${row.EffectIndex}`, row);
  }

  rows(name: SpellWorldTableName): readonly SpellWorldRow[] {
    return this.tables.get(name) ?? [];
  }

  rank(spellId: number): SpellRankRow | null {
    return this.ranks.get(spellId) ?? null;
  }

  firstRank(spellId: number): number {
    return this.rank(spellId)?.first_spell_id ?? spellId;
  }

  withRank(spellId: number, rank: number): number | null {
    return this.ranksByFirst.get(this.firstRank(spellId))?.find((row) => row.rank === rank)?.spell_id ?? null;
  }

  required(spellId: number): readonly number[] {
    return (this.requirements.get(spellId) ?? []).map((row) => row.req_spell);
  }

  /** Negative members of `spell_group` name a nested group. Cycles are ignored (`GetSetOfSpellsInSpellGroup`). */
  groupMembers(groupId: number): readonly number[] {
    const spells = new Set<number>();
    const visited = new Set<number>();
    const visit = (id: number): void => {
      if (visited.has(id)) return;
      visited.add(id);
      for (const row of this.groups.get(id) ?? []) {
        if (row.spell_id < 0) visit(-row.spell_id);
        else spells.add(row.spell_id);
      }
    };
    visit(groupId);
    return [...spells].sort((a, b) => a - b);
  }

  groupStackRule(groupId: number): SpellGroupStackRow | null {
    return this.groupRules.get(groupId) ?? null;
  }

  /** `SpellMgr::GetSpellGroupStackRule` */
  spellGroupStackRule(groupId: number): number {
    return this.groupRules.get(groupId)?.stack_rule ?? 0;
  }

  /** `SpellMgr::GetSpellSpellGroupMapBounds` — the groups (ascending) that contain a spell's first rank, nested groups expanded. */
  spellGroupsOf(spellId: number): readonly number[] {
    if (!this.spellSpellGroup) {
      this.spellSpellGroup = new Map();
      for (const groupId of [...this.groups.keys()].sort((a, b) => a - b)) {
        for (const spell of this.groupMembers(groupId)) append(this.spellSpellGroup, spell, groupId);
      }
    }
    return this.spellSpellGroup.get(this.firstRank(spellId)) ?? [];
  }

  /** `SpellMgr::IsSpellMemberOfSpellGroup` */
  isSpellMemberOfSpellGroup(spellId: number, groupId: number): boolean {
    return this.spellGroupsOf(spellId).includes(groupId);
  }

  /** `SpellMgr::CheckSpellGroupStackRules`: common groups by first rank, skipping groups whose nested group holds both spells. */
  checkSpellGroupStackRules(leftSpell: number, rightSpell: number): number {
    const left = this.firstRank(leftSpell);
    const right = this.firstRank(rightSpell);
    const groups = new Set<number>();
    for (const groupId of this.spellGroupsOf(left)) {
      if (!this.isSpellMemberOfSpellGroup(right, groupId)) continue;
      const nested = (this.groups.get(groupId) ?? []).some((row) => {
        if (row.spell_id >= 0) return false;
        const child = -row.spell_id;
        return this.isSpellMemberOfSpellGroup(left, child) && this.isSpellMemberOfSpellGroup(right, child);
      });
      if (!nested) groups.add(groupId);
    }
    let rule = 0;
    for (const groupId of [...groups].sort((a, b) => a - b)) {
      const found = this.groupRules.get(groupId);
      if (found) rule = found.stack_rule;
      if (rule) break;
    }
    return rule;
  }

  linkedSpells(trigger: number, type: number): readonly SpellLinkedRow[] {
    return this.linked.get(`${type}:${trigger}`) ?? [];
  }

  /** A `spell_script_names` binding for the spell or (negative id) for every rank of it. */
  hasScriptName(spellId: number): boolean {
    if (!this.scriptNames) {
      this.scriptNames = new Set((this.rows("spell_script_names") as SpellWorldRow[]).map((row) => Number(row.spell_id)));
    }
    return this.scriptNames.has(spellId) || this.scriptNames.has(-this.firstRank(spellId));
  }

  /** `sSpellScripts` rows keyed like `ScriptsStart(sSpellScripts, spellId | effIndex << 24)`. */
  hasSpellScripts(spellId: number, effIndex: number): boolean {
    if (!this.spellScripts) {
      this.spellScripts = new Set((this.rows("spell_scripts") as SpellWorldRow[]).map((row) => `${row.id}:${row.effIndex}`));
    }
    return this.spellScripts.has(`${spellId}:${effIndex}`);
  }

  /** `SpellMgr::GetPetAura(spellId, effIndex)` */
  hasPetAura(spellId: number, effIndex: number): boolean {
    if (!this.petAuras) {
      this.petAuras = new Set((this.rows("spell_pet_auras") as SpellWorldRow[]).map((row) => `${row.spell}:${row.effectId}`));
    }
    return this.petAuras.has(`${spellId}:${effIndex}`);
  }

  targetPosition(spellId: number, effectIndex: number): SpellTargetPositionRow | null {
    return this.targets.get(`${spellId}:${effectIndex}`) ?? null;
  }
}

function append<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const rows = map.get(key);
  if (rows) rows.push(value);
  else map.set(key, [value]);
}
