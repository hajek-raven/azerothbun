import { expect, test } from "bun:test";
import {
  spell_group,
  spell_group_stack_rules,
  spell_linked_spell,
  spell_ranks,
  spell_required,
  spell_target_position,
} from "../database/schema/world.ts";
import { WorldTables } from "../database/world-tables.ts";
import { SpellWorldData, SPELL_WORLD_TABLES } from "./world-data.ts";

const rank = (first_spell_id: number, spell_id: number, rank: number) => ({ first_spell_id, spell_id, rank });
const group = (id: number, spell_id: number) => ({ id, spell_id });

test("SpellMgr world rows retain every column and index rank, group, linked, and target data", () => {
  const db = WorldTables.fromRows([
    [spell_ranks, [rank(78, 78, 1), rank(78, 284, 2)]],
    [spell_required, [{ spell_id: 284, req_spell: 78 }]],
    [spell_group, [group(1, 78), group(1, -2), group(2, 284), group(2, 100), group(2, -1), group(3, -9)]],
    [spell_group_stack_rules, [{ group_id: 1, stack_rule: 3, description: "exclusive" }]],
    [spell_linked_spell, [{ spell_trigger: 78, spell_effect: 284, type: 0, comment: "trigger" }]],
    [spell_target_position, [{ ID: 8690, EffectIndex: 0, MapID: 0, PositionX: 1, PositionY: 2, PositionZ: 3, Orientation: 4, VerifiedBuild: 12340 }]],
  ]);
  const data = new SpellWorldData(db);
  expect(data.rows("spell_target_position")[0]).toMatchObject({ VerifiedBuild: 12340, PositionX: 1 });
  expect(data.firstRank(284)).toBe(78);
  expect(data.withRank(78, 2)).toBe(284);
  expect(data.required(284)).toEqual([78]);
  // 284 is rank 2 and group 9 does not exist, so LoadSpellGroups drops both rows.
  expect(data.groupMembers(1)).toEqual([78, 100]);
  expect(data.groupMembers(3)).toEqual([]);
  expect(data.groupStackRule(1)?.description).toBe("exclusive");
  expect(data.linkedSpells(78, 0)[0]?.spell_effect).toBe(284);
  expect(data.targetPosition(8690, 0)?.MapID).toBe(0);
  expect(data.rows("spell_proc")).toEqual([]);
  expect(SPELL_WORLD_TABLES).toContain("spell_dbc");
});

test("nested spell groups decide stack rules before their parent and use first ranks", () => {
  const db = WorldTables.fromRows([
    [spell_ranks, [rank(100, 100, 1), rank(100, 101, 2)]],
    [spell_group, [group(1, -2), group(1, 200), group(2, 100), group(2, 200)]],
    [spell_group_stack_rules, [{ group_id: 1, stack_rule: 1, description: "parent" }, { group_id: 2, stack_rule: 4, description: "child" }]],
  ]);
  const data = new SpellWorldData(db);
  expect(data.checkSpellGroupStackRules(101, 200)).toBe(4);
  expect(data.checkSpellGroupStackRules(101, 300)).toBe(0);
  expect(data.spellGroupsOf(101)).toEqual([1, 2]);
});
