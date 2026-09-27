import type { MySqlTable } from "drizzle-orm/mysql-core";
import {
  broadcast_text,
  conditions,
  gossip_menu,
  gossip_menu_option,
  npc_text,
  points_of_interest,
} from "../database/schema/world.ts";
import type { WorldTables } from "../database/world-tables.ts";
import { ByteWriter } from "../net/byte-buffer.ts";

export const SMSG_GOSSIP_MESSAGE = 0x17d;
export const SMSG_GOSSIP_COMPLETE = 0x17e;
export const SMSG_NPC_TEXT_UPDATE = 0x180;
export const SMSG_GOSSIP_POI = 0x224;
export const SMSG_LIST_INVENTORY = 0x19f;
export const SMSG_BINDER_CONFIRM = 0x2eb;
export const CMSG_GOSSIP_HELLO = 0x17b;
export const CMSG_GOSSIP_SELECT_OPTION = 0x17c;
export const CMSG_NPC_TEXT_QUERY = 0x17f;
export const CMSG_QUESTGIVER_HELLO = 0x184;
export const CMSG_GAMEOBJ_USE = 0x0b1;

export const GOSSIP_OPTION = {
  GOSSIP: 1,
  QUESTGIVER: 2,
  VENDOR: 3,
  TAXIVENDOR: 4,
  TRAINER: 5,
  SPIRITHEALER: 6,
  INNKEEPER: 8,
  BANKER: 9,
  PETITIONER: 10,
  TABARDDESIGNER: 11,
  BATTLEFIELD: 12,
  AUCTIONEER: 13,
  STABLEPET: 14,
  ARMORER: 15,
  UNLEARNTALENTS: 16,
  UNLEARNPETTALENTS: 17,
  LEARNDUALSPEC: 18,
  OUTDOORPVP: 19,
  DUALSPEC_INFO: 20,
} as const;

const DEFAULT_GOSSIP_MESSAGE = 0xffffff;
const GREETING = "Greetings $N";
const ALLIANCE_RACES = new Set([1, 3, 4, 7, 11]);
const SOURCE_GOSSIP_MENU = 14;
const SOURCE_GOSSIP_MENU_OPTION = 15;
const SOURCE_GOSSIP_HELLO = 20;

export type Speaker = {
  race: number;
  classId: number;
  gender: number;
  level: number;
  zone: number;
  map: number;
};

export type QuestMenuEntry = {
  questId: number;
  icon: number;
  level: number;
  flags: number;
  repeatable: boolean;
  title: string;
};

export type QuestGiverView = {
  menu(kind: "creature" | "gameobject", entry: number): QuestMenuEntry[];
  dialogStatus(kind: "creature" | "gameobject", entry: number): number;
  creditTalk(entry: number): void;
};

export type QuestStateView = {
  status(questId: number): number;
  rewarded(questId: number): boolean;
  objective(questId: number, index: number): number;
};

export type GossipOption = {
  optionId: number;
  icon: number;
  coded: boolean;
  boxMoney: number;
  text: string;
  boxText: string;
  type: number;
  npcFlag: number;
  actionMenuId: number;
  actionPoiId: number;
};

export type NpcTextSlot = {
  probability: number;
  text0: string;
  text1: string;
  language: number;
  emotes: Array<{ delay: number; emote: number }>;
};

export type ConditionRow = {
  elseGroup: number;
  conditionType: number;
  value1: number;
  value2: number;
  value3: number;
  negative: boolean;
};

type MenuTextRow = { textId: number };
type MenuOptionRow = {
  optionId: number;
  icon: number;
  optionText: string;
  optionBroadcastTextId: number;
  optionType: number;
  optionNpcFlag: number;
  actionMenuId: number;
  actionPoiId: number;
  boxCoded: number;
  boxMoney: number;
  boxText: string;
  boxBroadcastTextId: number;
};
type BroadcastTextRow = {
  languageId: number;
  maleText: string;
  femaleText: string;
  emoteId1: number;
  emoteDelay1: number;
  emoteId2: number;
  emoteDelay2: number;
  emoteId3: number;
  emoteDelay3: number;
};
type NpcTextRow = {
  slots: NpcTextSlot[];
  broadcastTextIds: number[];
};
type PoiRow = {
  flags: number;
  x: number;
  y: number;
  icon: number;
  importance: number;
  name: string;
};

type LooseRow = Record<string, unknown>;

function sortedRows(db: WorldTables, table: MySqlTable, ...columns: string[]): LooseRow[] {
  return [...(db.all(table) as readonly LooseRow[])].sort((left, right) => {
    for (const column of columns) {
      const diff = asNumber(left[column]) - asNumber(right[column]);
      if (diff !== 0) return diff;
    }
    return 0;
  });
}

function asString(value: unknown): string {
  return value == null ? "" : String(value);
}

function asNumber(value: unknown): number {
  return Number(value ?? 0);
}

function teamForRace(race: number): number {
  return ALLIANCE_RACES.has(race) ? 469 : 67;
}

function compareLevel(level: number, value1: number, comparisonType: number): boolean {
  switch (comparisonType) {
    case 0:
      return level === value1;
    case 1:
      return level > value1;
    case 2:
      return level < value1;
    case 3:
      return level >= value1;
    case 4:
      return level <= value1;
    default:
      return true;
  }
}

function questStateBits(quests: QuestStateView, questId: number): number {
  const status = quests.status(questId);
  let bits = 0;
  if (status === 0) bits |= 1;
  if (status === 1) bits |= 2;
  if (status === 3) bits |= 8;
  if (status === 5) bits |= 32;
  if (status === 6 || quests.rewarded(questId)) bits |= 64;
  return bits;
}

function evaluateCondition(row: ConditionRow, speaker: Speaker, quests: QuestStateView): boolean {
  let result: boolean;
  switch (row.conditionType) {
    case 0:
      result = true;
      break;
    case 4:
      result = speaker.zone === row.value1;
      break;
    case 6:
      result = teamForRace(speaker.race) === row.value1;
      break;
    case 8:
      result = quests.rewarded(row.value1);
      break;
    case 9: {
      const status = quests.status(row.value1);
      result = status === 1 || status === 3 || status === 5;
      break;
    }
    case 14: {
      const status = quests.status(row.value1);
      result = status === 0 && !quests.rewarded(row.value1);
      break;
    }
    case 15:
      result = speaker.classId === row.value1;
      break;
    case 16:
      result = speaker.race === row.value1;
      break;
    case 20:
      result = speaker.gender === row.value1;
      break;
    case 22:
      result = speaker.map === row.value1;
      break;
    case 23:
      result = speaker.zone === row.value1;
      break;
    case 27:
      result = compareLevel(speaker.level, row.value1, row.value2);
      break;
    case 28:
      result = quests.status(row.value1) === 1;
      break;
    case 43:
      result = quests.rewarded(row.value1);
      break;
    case 47:
      result = (questStateBits(quests, row.value1) & row.value2) !== 0;
      break;
    case 48:
      result = quests.objective(row.value1, row.value2) >= row.value3;
      break;
    default:
      // Auras, items, events, spells, and other unloaded condition sources stay open.
      result = true;
      break;
  }
  return row.negative ? !result : result;
}

export function meets(conditions: ConditionRow[], speaker: Speaker, quests: QuestStateView): boolean {
  if (conditions.length === 0) {
    return true;
  }
  const groups = new Map<number, ConditionRow[]>();
  for (const row of conditions) {
    const list = groups.get(row.elseGroup);
    if (list) {
      list.push(row);
    } else {
      groups.set(row.elseGroup, [row]);
    }
  }
  for (const rows of groups.values()) {
    let ok = true;
    for (const row of rows) {
      if (!evaluateCondition(row, speaker, quests)) {
        ok = false;
        break;
      }
    }
    if (ok) {
      return true;
    }
  }
  return false;
}

function broadcastTexts(bt: BroadcastTextRow, gender: number): { text0: string; text1: string } {
  const male = bt.maleText;
  const female = bt.femaleText;
  const primary = gender === 1 ? female : male;
  const secondary = gender === 1 ? male : female;
  const text0 = primary || secondary;
  const text1 = secondary || primary;
  return { text0, text1 };
}

function broadcastSide(bt: BroadcastTextRow | undefined, gender: number): string | null {
  if (!bt) {
    return null;
  }
  const preferred = gender === 1 ? bt.femaleText : bt.maleText;
  return preferred.length > 0 ? preferred : null;
}

function broadcastEmotes(bt: BroadcastTextRow): Array<{ delay: number; emote: number }> {
  return [
    { delay: bt.emoteDelay1, emote: bt.emoteId1 },
    { delay: bt.emoteDelay2, emote: bt.emoteId2 },
    { delay: bt.emoteDelay3, emote: bt.emoteId3 },
  ];
}

function emptyNpcTextSlots(): NpcTextSlot[] {
  return Array.from({ length: 8 }, () => ({
    probability: 0,
    text0: GREETING,
    text1: GREETING,
    language: 0,
    emotes: [
      { delay: 0, emote: 0 },
      { delay: 0, emote: 0 },
      { delay: 0, emote: 0 },
    ],
  }));
}

export class GossipCatalog {
  private readonly menuTexts = new Map<number, MenuTextRow[]>();
  private readonly menuOptions = new Map<number, MenuOptionRow[]>();
  private readonly menuIds = new Set<number>();
  private readonly npcTexts = new Map<number, NpcTextRow>();
  private readonly broadcastTexts = new Map<number, BroadcastTextRow>();
  private readonly pointsOfInterest = new Map<number, PoiRow>();
  private readonly conditionsByKey = new Map<string, ConditionRow[]>();
  private readonly helloByEntry = new Map<number, ConditionRow[]>();

  constructor(db: WorldTables) {
    this.loadBroadcastText(db);
    this.loadGossipMenu(db);
    this.loadGossipMenuOption(db);
    this.loadNpcText(db);
    this.loadPointsOfInterest(db);
    this.loadConditions(db);
  }

  textId(menuId: number, speaker: Speaker, quests: QuestStateView): number {
    const rows = this.menuTexts.get(menuId);
    if (!rows || rows.length === 0) {
      return DEFAULT_GOSSIP_MESSAGE;
    }
    let textId = DEFAULT_GOSSIP_MESSAGE;
    for (const row of rows) {
      const conditions = this.conditionsFor(SOURCE_GOSSIP_MENU, menuId, row.textId);
      if (meets(conditions, speaker, quests)) {
        textId = row.textId;
      }
    }
    return textId;
  }

  options(menuId: number, npcFlags: number, speaker: Speaker, quests: QuestStateView): GossipOption[] {
    const rows = this.menuOptions.get(menuId) ?? [];
    const out: GossipOption[] = [];
    for (const row of rows) {
      if (row.optionNpcFlag !== 0 && (row.optionNpcFlag & npcFlags) === 0) {
        continue;
      }
      const conditions = this.conditionsFor(SOURCE_GOSSIP_MENU_OPTION, menuId, row.optionId);
      if (!meets(conditions, speaker, quests)) {
        continue;
      }
      const optionBt = this.broadcastTexts.get(row.optionBroadcastTextId);
      const boxBt = this.broadcastTexts.get(row.boxBroadcastTextId);
      out.push({
        optionId: row.optionId,
        icon: row.icon,
        coded: row.boxCoded !== 0,
        boxMoney: row.boxMoney,
        text: broadcastSide(optionBt, speaker.gender) ?? row.optionText,
        boxText: broadcastSide(boxBt, speaker.gender) ?? row.boxText,
        type: row.optionType,
        npcFlag: row.optionNpcFlag,
        actionMenuId: row.actionMenuId,
        actionPoiId: row.actionPoiId,
      });
    }
    return out;
  }

  npcText(textId: number, gender: number): NpcTextSlot[] {
    const row = this.npcTexts.get(textId);
    if (!row) {
      return emptyNpcTextSlots();
    }
    return row.slots.map((slot, index) => {
      const broadcastId = row.broadcastTextIds[index] ?? 0;
      const bt = broadcastId > 0 ? this.broadcastTexts.get(broadcastId) : undefined;
      if (!bt) {
        return {
          probability: slot.probability,
          text0: slot.text0,
          text1: slot.text1,
          language: slot.language,
          emotes: slot.emotes.map((emote) => ({ ...emote })),
        };
      }
      const texts = broadcastTexts(bt, gender);
      return {
        probability: slot.probability,
        text0: texts.text0,
        text1: texts.text1,
        language: slot.language,
        emotes: broadcastEmotes(bt),
      };
    });
  }

  pointOfInterest(id: number): PoiRow | null {
    return this.pointsOfInterest.get(id) ?? null;
  }

  hasMenu(menuId: number): boolean {
    return this.menuIds.has(menuId);
  }

  helloConditions(creatureEntry: number): ConditionRow[] {
    return this.helloByEntry.get(creatureEntry) ?? [];
  }

  private conditionsFor(sourceType: number, sourceGroup: number, sourceEntry: number): ConditionRow[] {
    return this.conditionsByKey.get(`${sourceType}:${sourceGroup}:${sourceEntry}`) ?? [];
  }

  private loadBroadcastText(db: WorldTables): void {
    for (const row of db.all(broadcast_text) as readonly LooseRow[]) {
      this.broadcastTexts.set(asNumber(row.ID), {
        languageId: asNumber(row.LanguageID),
        maleText: asString(row.MaleText),
        femaleText: asString(row.FemaleText),
        emoteId1: asNumber(row.EmoteID1),
        emoteDelay1: asNumber(row.EmoteDelay1),
        emoteId2: asNumber(row.EmoteID2),
        emoteDelay2: asNumber(row.EmoteDelay2),
        emoteId3: asNumber(row.EmoteID3),
        emoteDelay3: asNumber(row.EmoteDelay3),
      });
    }
  }

  private loadGossipMenu(db: WorldTables): void {
    for (const row of sortedRows(db, gossip_menu, "MenuID", "TextID")) {
      const menuId = asNumber(row.MenuID);
      const textId = asNumber(row.TextID);
      const list = this.menuTexts.get(menuId);
      if (list) {
        list.push({ textId });
      } else {
        this.menuTexts.set(menuId, [{ textId }]);
      }
      this.menuIds.add(menuId);
    }
  }

  private loadGossipMenuOption(db: WorldTables): void {
    for (const row of sortedRows(db, gossip_menu_option, "MenuID", "OptionID")) {
      const menuId = asNumber(row.MenuID);
      const option: MenuOptionRow = {
        optionId: asNumber(row.OptionID),
        icon: asNumber(row.OptionIcon),
        optionText: asString(row.OptionText),
        optionBroadcastTextId: asNumber(row.OptionBroadcastTextID),
        optionType: asNumber(row.OptionType),
        optionNpcFlag: asNumber(row.OptionNpcFlag),
        actionMenuId: asNumber(row.ActionMenuID),
        actionPoiId: asNumber(row.ActionPoiID),
        boxCoded: asNumber(row.BoxCoded),
        boxMoney: asNumber(row.BoxMoney),
        boxText: asString(row.BoxText),
        boxBroadcastTextId: asNumber(row.BoxBroadcastTextID),
      };
      const list = this.menuOptions.get(menuId);
      if (list) {
        list.push(option);
      } else {
        this.menuOptions.set(menuId, [option]);
      }
      this.menuIds.add(menuId);
    }
  }

  private loadNpcText(db: WorldTables): void {
    for (const row of db.all(npc_text) as readonly LooseRow[]) {
      const slots: NpcTextSlot[] = [];
      const broadcastTextIds: number[] = [];
      for (let n = 0; n < 8; n++) {
        broadcastTextIds.push(asNumber(row[`BroadcastTextID${n}`]));
        slots.push({
          probability: asNumber(row[`Probability${n}`]),
          text0: asString(row[`text${n}_0`]),
          text1: asString(row[`text${n}_1`]),
          language: asNumber(row[`lang${n}`]),
          emotes: [
            { delay: asNumber(row[`em${n}_0`]), emote: asNumber(row[`em${n}_1`]) },
            { delay: asNumber(row[`em${n}_2`]), emote: asNumber(row[`em${n}_3`]) },
            { delay: asNumber(row[`em${n}_4`]), emote: asNumber(row[`em${n}_5`]) },
          ],
        });
      }
      this.npcTexts.set(asNumber(row.ID), { slots, broadcastTextIds });
    }
  }

  private loadPointsOfInterest(db: WorldTables): void {
    for (const row of db.all(points_of_interest) as readonly LooseRow[]) {
      this.pointsOfInterest.set(asNumber(row.ID), {
        flags: asNumber(row.Flags),
        x: asNumber(row.PositionX),
        y: asNumber(row.PositionY),
        icon: asNumber(row.Icon),
        importance: asNumber(row.Importance),
        name: asString(row.Name),
      });
    }
  }

  private loadConditions(db: WorldTables): void {
    const sources = new Set([SOURCE_GOSSIP_MENU, SOURCE_GOSSIP_MENU_OPTION, SOURCE_GOSSIP_HELLO]);
    for (const row of (db.all(conditions) as readonly LooseRow[]).filter((row) => sources.has(asNumber(row.SourceTypeOrReferenceId)))) {
      const sourceType = asNumber(row.SourceTypeOrReferenceId);
      const sourceGroup = asNumber(row.SourceGroup);
      const sourceEntry = asNumber(row.SourceEntry);
      const condition: ConditionRow = {
        elseGroup: asNumber(row.ElseGroup),
        conditionType: asNumber(row.ConditionTypeOrReference),
        value1: asNumber(row.ConditionValue1),
        value2: asNumber(row.ConditionValue2),
        value3: asNumber(row.ConditionValue3),
        negative: asNumber(row.NegativeCondition) !== 0,
      };
      if (sourceType === SOURCE_GOSSIP_HELLO) {
        const list = this.helloByEntry.get(sourceEntry);
        if (list) {
          list.push(condition);
        } else {
          this.helloByEntry.set(sourceEntry, [condition]);
        }
        continue;
      }
      const key = `${sourceType}:${sourceGroup}:${sourceEntry}`;
      const list = this.conditionsByKey.get(key);
      if (list) {
        list.push(condition);
      } else {
        this.conditionsByKey.set(key, [condition]);
      }
    }
  }
}

export function helloAllowed(
  catalog: GossipCatalog,
  creatureEntry: number,
  speaker: Speaker,
  quests: QuestStateView,
): boolean {
  return meets(catalog.helloConditions(creatureEntry), speaker, quests);
}

export function gossipMessage(
  guid: bigint,
  menuId: number,
  titleTextId: number,
  options: GossipOption[],
  quests: QuestMenuEntry[],
): Uint8Array {
  const w = new ByteWriter();
  w.writeU64(guid);
  w.writeU32(menuId);
  w.writeU32(titleTextId);
  w.writeU32(options.length);
  for (const option of options) {
    w.writeU32(option.optionId);
    w.writeU8(option.icon);
    w.writeU8(option.coded ? 1 : 0);
    w.writeU32(option.boxMoney);
    w.writeCString(option.text);
    w.writeCString(option.boxText);
  }
  w.writeU32(quests.length);
  for (const quest of quests) {
    w.writeU32(quest.questId);
    w.writeU32(quest.icon);
    w.writeU32(quest.level >>> 0);
    w.writeU32(quest.flags);
    w.writeU8(quest.repeatable ? 1 : 0);
    w.writeCString(quest.title);
  }
  return w.toUint8Array();
}

export function gossipComplete(): Uint8Array {
  return new Uint8Array(0);
}

export function gossipPoi(poi: {
  flags: number;
  x: number;
  y: number;
  icon: number;
  importance: number;
  name: string;
}): Uint8Array {
  const w = new ByteWriter();
  w.writeU32(poi.flags);
  w.writeF32(poi.x);
  w.writeF32(poi.y);
  w.writeU32(poi.icon);
  w.writeU32(poi.importance);
  w.writeCString(poi.name);
  return w.toUint8Array();
}

export function npcTextUpdate(textId: number, slots: NpcTextSlot[]): Uint8Array {
  const w = new ByteWriter();
  w.writeU32(textId);
  const filled = slots.length >= 8 ? slots : [...slots, ...emptyNpcTextSlots()].slice(0, 8);
  for (let i = 0; i < 8; i++) {
    const slot = filled[i]!;
    w.writeF32(slot.probability);
    w.writeCString(slot.text0);
    w.writeCString(slot.text1);
    w.writeU32(slot.language);
    for (let e = 0; e < 3; e++) {
      const emote = slot.emotes[e] ?? { delay: 0, emote: 0 };
      w.writeU32(emote.delay);
      w.writeU32(emote.emote);
    }
  }
  return w.toUint8Array();
}

export function emptyVendorList(guid: bigint): Uint8Array {
  const w = new ByteWriter();
  w.writeU64(guid);
  w.writeU8(0);
  return w.toUint8Array();
}

export function binderConfirm(guid: bigint): Uint8Array {
  const w = new ByteWriter();
  w.writeU64(guid);
  return w.toUint8Array();
}
