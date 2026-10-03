import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { VMapFactory } from "../../common/Collision/Management/VMapFactory.ts";
import { DisableTypes } from "../../common/Collision/Management/VMapMgr2.ts";
import { disables } from "../../database/schema/world.ts";
import { WorldTables } from "../../database/world-tables.ts";
import type { SpellInfo, SpellStore } from "../../spells/spell-info.ts";
import { SPELL_ATTR2_IGNORE_LINE_OF_SIGHT } from "../../spells/defines.ts";
import { setMapEntry } from "../Maps/Map.test-util.ts";
import { MAP_COMMON, MAP_INSTANCE } from "../DataStores/MapDBCStores.ts";
import { sSpellMgr } from "../Spells/SpellMgr.ts";
import {
  DISABLE_TYPE_MAP,
  DISABLE_TYPE_QUEST,
  DISABLE_TYPE_SPELL,
  DISABLE_TYPE_VMAP,
  DisableMgr,
  SPELL_DISABLE_AREA,
  SPELL_DISABLE_CREATURE,
  SPELL_DISABLE_DEPRECATED_SPELL,
  SPELL_DISABLE_LOS,
  SPELL_DISABLE_MAP,
  SPELL_DISABLE_PLAYER,
  sDisableMgr,
  type DisableUnit,
} from "./DisableMgr.ts";

const row = (sourceType: number, entry: number, flags = 0, params_0 = "", params_1 = "") => ({ sourceType, entry, flags, params_0, params_1, comment: "" });
const tables = (rows: ReturnType<typeof row>[]) => WorldTables.fromRows([[disables, rows]]);

const spellInfo = { attributes: [0, 0, 0, 0, 0, 0, 0, 0] } as unknown as SpellInfo;
const fakeStore = { get: (id: number) => (id === 100 || id === 101 || id === 102 ? spellInfo : null) } as unknown as SpellStore;

const player = (map: number, area: number): DisableUnit => ({ isPlayer: () => true, isCreature: () => false, getMapId: () => map, getAreaId: () => area });
const creature = (map: number, area: number, pet = false): DisableUnit => ({ isPlayer: () => false, isCreature: () => true, isPet: () => pet, getMapId: () => map, getAreaId: () => area });

beforeEach(() => {
  sSpellMgr.setStore(fakeStore);
  setMapEntry(930, MAP_COMMON);
  setMapEntry(931, MAP_INSTANCE);
});

afterEach(() => {
  DisableMgr.clear();
  sSpellMgr.setStore(null);
  spellInfo.attributes[2] = 0;
});

describe("DisableMgr::LoadDisables", () => {
  test("skips rows that name something that does not exist or carry invalid flags", () => {
    sDisableMgr().loadDisables(
      tables([
        row(DISABLE_TYPE_SPELL, 100, SPELL_DISABLE_PLAYER),
        row(DISABLE_TYPE_SPELL, 999, SPELL_DISABLE_PLAYER), // no such spell
        row(DISABLE_TYPE_SPELL, 101, 0), // no flags
        row(DISABLE_TYPE_SPELL, 102, 0x80), // flag above the maximum
        row(DISABLE_TYPE_SPELL, 5000, SPELL_DISABLE_DEPRECATED_SPELL), // deprecated spells need no spell info
        row(DISABLE_TYPE_MAP, 930, 0),
        row(DISABLE_TYPE_MAP, 930, 1), // a world map takes no flags
        row(DISABLE_TYPE_MAP, 777, 0), // no such map
        row(99, 1, 0), // invalid type
      ]),
    );
    expect([...DisableMgr.disablesOf(DISABLE_TYPE_SPELL).keys()].sort()).toEqual([100, 5000]);
    expect([...DisableMgr.disablesOf(DISABLE_TYPE_MAP).keys()]).toEqual([930]);
  });

  test("a reload replaces the rows", () => {
    sDisableMgr().loadDisables(tables([row(DISABLE_TYPE_SPELL, 100, SPELL_DISABLE_PLAYER)]));
    sDisableMgr().loadDisables(tables([]));
    expect(DisableMgr.disablesOf(DISABLE_TYPE_SPELL).size).toBe(0);
  });

  test("a spell disabled for line of sight gets SPELL_ATTR2_IGNORE_LINE_OF_SIGHT", () => {
    sDisableMgr().loadDisables(tables([row(DISABLE_TYPE_SPELL, 100, SPELL_DISABLE_PLAYER | SPELL_DISABLE_LOS)]));
    expect(spellInfo.attributes[2]! & SPELL_ATTR2_IGNORE_LINE_OF_SIGHT).toBe(SPELL_ATTR2_IGNORE_LINE_OF_SIGHT);
  });
});

describe("DisableMgr::IsDisabledFor", () => {
  test("spells: by caster kind, map, and area", () => {
    sDisableMgr().loadDisables(
      tables([
        row(DISABLE_TYPE_SPELL, 100, SPELL_DISABLE_PLAYER),
        row(DISABLE_TYPE_SPELL, 101, SPELL_DISABLE_CREATURE | SPELL_DISABLE_MAP, "930,931"),
        row(DISABLE_TYPE_SPELL, 102, SPELL_DISABLE_PLAYER | SPELL_DISABLE_MAP | SPELL_DISABLE_AREA, "930", "12,13"),
        row(DISABLE_TYPE_SPELL, 5000, SPELL_DISABLE_DEPRECATED_SPELL),
      ]),
    );
    expect(DisableMgr.isDisabledFor(DISABLE_TYPE_SPELL, 100, player(0, 0))).toBe(true);
    expect(DisableMgr.isDisabledFor(DISABLE_TYPE_SPELL, 100, creature(0, 0))).toBe(false);
    expect(DisableMgr.isDisabledFor(DISABLE_TYPE_SPELL, 101, creature(931, 0))).toBe(true);
    expect(DisableMgr.isDisabledFor(DISABLE_TYPE_SPELL, 101, creature(1, 0))).toBe(false);
    // map and area: the map listed disables it everywhere, another map only in the listed areas
    expect(DisableMgr.isDisabledFor(DISABLE_TYPE_SPELL, 102, player(930, 99))).toBe(true);
    expect(DisableMgr.isDisabledFor(DISABLE_TYPE_SPELL, 102, player(1, 12))).toBe(true);
    expect(DisableMgr.isDisabledFor(DISABLE_TYPE_SPELL, 102, player(1, 99))).toBe(false);
    // a deprecated spell is disabled when asked without a caster
    expect(DisableMgr.isDisabledFor(DISABLE_TYPE_SPELL, 5000, null)).toBe(true);
    expect(DisableMgr.isDisabledFor(DISABLE_TYPE_SPELL, 4999, null)).toBe(false);
  });

  test("quests and other flagless types are disabled for everyone; unknown types never are", () => {
    DisableMgr.instance().addDisable(DISABLE_TYPE_QUEST, 77, 0, "", "");
    expect(DisableMgr.isDisabledFor(DISABLE_TYPE_QUEST, 77, null)).toBe(true);
    expect(DisableMgr.isDisabledFor(DISABLE_TYPE_QUEST, 78, null)).toBe(false);
    expect(DisableMgr.isDisabledFor(42, 77, null)).toBe(false);
  });

  test("vmaps: the flags asked for must overlap the flags disabled", () => {
    sDisableMgr().loadDisables(tables([row(DISABLE_TYPE_VMAP, 931, DisableTypes.VMAP_DISABLE_LOS | DisableTypes.VMAP_DISABLE_HEIGHT)]));
    expect(DisableMgr.isVMAPDisabledFor(931, DisableTypes.VMAP_DISABLE_LOS)).toBe(true);
    expect(DisableMgr.isVMAPDisabledFor(931, DisableTypes.VMAP_DISABLE_AREAFLAG)).toBe(false);
    expect(DisableMgr.isVMAPDisabledFor(930, DisableTypes.VMAP_DISABLE_LOS)).toBe(false);
  });

  test("DisableMgr.install makes the vmap manager ask the disables", () => {
    sDisableMgr().loadDisables(tables([row(DISABLE_TYPE_VMAP, 931, DisableTypes.VMAP_DISABLE_LOS)]));
    DisableMgr.install();
    expect(VMapFactory.createOrGetVMapMgr().IsVMAPDisabledForPtr(931, DisableTypes.VMAP_DISABLE_LOS)).toBe(true);
    expect(VMapFactory.createOrGetVMapMgr().IsVMAPDisabledForPtr(930, DisableTypes.VMAP_DISABLE_LOS)).toBe(false);
  });
});
