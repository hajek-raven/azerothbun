import type { Db } from "../database/database.ts";
import {
  creature_questender,
  creature_queststarter,
  gameobject_questender,
  gameobject_queststarter,
  quest_details,
  quest_money_reward,
  quest_offer_reward,
  quest_poi,
  quest_poi_points,
  quest_request_items,
  quest_template,
  quest_template_addon,
  questfactionreward_dbc,
  questxp_dbc,
} from "../database/schema/world.ts";
import type { WorldTables } from "../database/world-tables.ts";
import {
  loadQuestStatus,
  saveQuestStatus,
  type QuestStatusState,
} from "../characters/quest-status.ts";
import { ByteWriter } from "../net/byte-buffer.ts";

export const QUEST_STATUS_NONE = 0;
export const QUEST_STATUS_COMPLETE = 1;
export const QUEST_STATUS_INCOMPLETE = 3;
export const QUEST_STATUS_FAILED = 5;
export const QUEST_STATUS_REWARDED = 6;

export const DIALOG_NONE = 0;
export const DIALOG_UNAVAILABLE = 1;
export const DIALOG_LOW_LEVEL_AVAILABLE = 2;
export const DIALOG_LOW_LEVEL_REWARD_REP = 3;
export const DIALOG_LOW_LEVEL_AVAILABLE_REP = 4;
export const DIALOG_INCOMPLETE = 5;
export const DIALOG_REWARD_REP = 6;
export const DIALOG_AVAILABLE_REP = 7;
export const DIALOG_AVAILABLE = 8;
export const DIALOG_REWARD2 = 9;
export const DIALOG_REWARD = 10;

export const QUEST_FLAGS_PARTY_ACCEPT = 0x2;
export const QUEST_FLAGS_SHARABLE = 0x8;
export const QUEST_FLAGS_HIDDEN_REWARDS = 0x200;
export const QUEST_FLAGS_DAILY = 0x1000;
export const QUEST_FLAGS_UNAVAILABLE = 0x4000;
export const QUEST_FLAGS_WEEKLY = 0x8000;
export const QUEST_FLAGS_AUTOCOMPLETE = 0x10000;
export const QUEST_FLAGS_AUTO_ACCEPT = 0x80000;
export const QUEST_SPECIAL_AUTO_ACCEPT = 0x4;

export const QUEST_SPECIAL_REPEATABLE = 0x1;
export const QUEST_SPECIAL_EXPLORATION = 0x2;
export const QUEST_SPECIAL_MONTHLY = 0x10;

export const QUEST_LOG_SLOT_COUNT = 25;
export const QUEST_LOG_INDEX = (6 + 0x8e) + 0x0a;
export const QUEST_LOG_SLOT_SIZE = 5;

export const SMSG_QUESTGIVER_STATUS = 0x183;
export const SMSG_QUESTGIVER_QUEST_LIST = 0x185;
export const SMSG_QUESTGIVER_QUEST_DETAILS = 0x188;
export const SMSG_QUESTGIVER_REQUEST_ITEMS = 0x18b;
export const SMSG_QUESTGIVER_OFFER_REWARD = 0x18d;
export const SMSG_QUESTGIVER_QUEST_COMPLETE = 0x191;
export const SMSG_QUESTLOG_FULL = 0x195;
export const SMSG_QUESTUPDATE_COMPLETE = 0x198;
export const SMSG_QUESTUPDATE_ADD_KILL = 0x199;
export const SMSG_QUEST_QUERY_RESPONSE = 0x05d;
export const SMSG_QUEST_POI_QUERY_RESPONSE = 0x1e4;
export const CMSG_QUESTGIVER_STATUS_QUERY = 0x182;
export const CMSG_QUESTGIVER_QUERY_QUEST = 0x186;
export const CMSG_QUESTGIVER_QUEST_AUTOLAUNCH = 0x187;
export const CMSG_QUESTGIVER_ACCEPT_QUEST = 0x189;
export const CMSG_QUESTGIVER_COMPLETE_QUEST = 0x18a;
export const CMSG_QUESTGIVER_REQUEST_REWARD = 0x18c;
export const CMSG_QUESTGIVER_CHOOSE_REWARD = 0x18e;
export const CMSG_QUESTGIVER_CANCEL = 0x190;
export const CMSG_QUESTLOG_SWAP_QUEST = 0x193;
export const CMSG_QUESTLOG_REMOVE_QUEST = 0x194;
export const CMSG_QUEST_CONFIRM_ACCEPT = 0x19b;
export const CMSG_PUSHQUESTTOPARTY = 0x19d;
export const SMSG_QUEST_CONFIRM_ACCEPT = 0x19c;
export const MSG_QUEST_PUSH_RESULT = 0x276;

export const QUEST_PARTY_MSG_SHARING_QUEST = 0;
export const QUEST_PARTY_MSG_CANT_TAKE_QUEST = 1;
export const QUEST_PARTY_MSG_ACCEPT_QUEST = 2;
export const QUEST_PARTY_MSG_DECLINE_QUEST = 3;
export const QUEST_PARTY_MSG_BUSY = 4;
export const QUEST_PARTY_MSG_LOG_FULL = 5;
export const QUEST_PARTY_MSG_HAVE_QUEST = 6;
export const QUEST_PARTY_MSG_FINISH_QUEST = 7;
export const QUEST_PARTY_MSG_CANT_BE_SHARED_TODAY = 8;
export const QUEST_PARTY_MSG_SHARING_TIMER_EXPIRED = 9;
export const QUEST_PARTY_MSG_NOT_IN_PARTY = 10;
export const CMSG_QUEST_QUERY = 0x05c;
export const CMSG_QUEST_POI_QUERY = 0x1e3;
export const CMSG_QUESTGIVER_STATUS_MULTIPLE_QUERY = 0x417;
export const SMSG_QUESTGIVER_STATUS_MULTIPLE = 0x418;

export type QuestGiverKind = "creature" | "gameobject";

export type ActiveQuest = {
  status: number;
  explored: number;
  timer: number;
  mob: [number, number, number, number];
  item: [number, number, number, number, number, number];
  playerCount: number;
};

export type Credit = {
  questId: number;
  entry: number;
  count: number;
  required: number;
  guid: bigint;
  done: boolean;
};

export type RewardResult = {
  xp: number;
  money: number;
  honor: number;
  spell: number;
  talents: number;
  arena: number;
  factions: { faction: number; standing: number }[];
  choiceItem: number;
  choiceCount: number;
  items: { id: number; count: number }[];
};

export type QuestPoiPoint = { x: number; y: number };

export type QuestPoi = {
  id: number;
  objectiveIndex: number;
  mapId: number;
  worldMapAreaId: number;
  floor: number;
  priority: number;
  flags: number;
  points: QuestPoiPoint[];
};

export type QuestTemplate = {
  id: number;
  questType: number;
  questLevel: number;
  minLevel: number;
  questSortId: number;
  questInfoId: number;
  suggestedGroupNum: number;
  requiredFactionId: [number, number];
  requiredFactionValue: [number, number];
  rewardNextQuest: number;
  rewardXPDifficulty: number;
  rewardMoney: number;
  rewardMoneyDifficulty: number;
  rewardDisplaySpell: number;
  rewardSpell: number;
  rewardHonor: number;
  rewardKillHonor: number;
  startItem: number;
  flags: number;
  requiredPlayerKills: number;
  rewardItem: [number, number, number, number];
  rewardAmount: [number, number, number, number];
  itemDrop: [number, number, number, number];
  itemDropQuantity: [number, number, number, number];
  rewardChoiceItemId: [number, number, number, number, number, number];
  rewardChoiceItemQuantity: [number, number, number, number, number, number];
  poiContinent: number;
  poiX: number;
  poiY: number;
  poiPriority: number;
  rewardTitle: number;
  rewardTalents: number;
  rewardArenaPoints: number;
  rewardFactionId: [number, number, number, number, number];
  rewardFactionValue: [number, number, number, number, number];
  rewardFactionOverride: [number, number, number, number, number];
  timeAllowed: number;
  allowableRaces: number;
  logTitle: string;
  logDescription: string;
  questDescription: string;
  areaDescription: string;
  questCompletionLog: string;
  requiredNpcOrGo: [number, number, number, number];
  requiredNpcOrGoCount: [number, number, number, number];
  requiredItemId: [number, number, number, number, number, number];
  requiredItemCount: [number, number, number, number, number, number];
  objectiveText: [string, string, string, string];
  maxLevel: number;
  allowableClasses: number;
  prevQuestId: number;
  nextQuestId: number;
  exclusiveGroup: number;
  specialFlags: number;
  providedItemCount: number;
  offerEmote: [number, number, number, number];
  offerEmoteDelay: [number, number, number, number];
  rewardText: string;
  emoteOnComplete: number;
  emoteOnIncomplete: number;
  completionText: string;
  detailsEmote: [number, number, number, number];
  detailsEmoteDelay: [number, number, number, number];
};

export type QuestSpeaker = { race: number; classId: number; level: number };

export type QuestMenuEntry = {
  questId: number;
  icon: number;
  level: number;
  flags: number;
  repeatable: boolean;
  title: string;
};

const LOW_LEVEL_DIFF = 7;
const QUEST_SORT_SEASONAL = 22;
const QUEST_SORT_SPECIAL = 284;
const QUEST_SORT_LUNAR_FESTIVAL = 366;
const QUEST_SORT_MIDSUMMER = 369;
const QUEST_SORT_BREWFEST = 370;
const QUEST_SORT_NOBLEGARDEN = 374;
const QUEST_SORT_LOVE_IS_IN_THE_AIR = 376;

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string" && value.length > 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function writeI32(writer: ByteWriter, value: number): void {
  writer.writeU32(value | 0);
}

function npcOrGoPacketId(id: number): number {
  if (id < 0) {
    return ((-id) | 0x80000000) >>> 0;
  }
  return id >>> 0;
}

function emptyActive(): ActiveQuest {
  return {
    status: QUEST_STATUS_INCOMPLETE,
    explored: 0,
    timer: 0,
    mob: [0, 0, 0, 0],
    item: [0, 0, 0, 0, 0, 0],
    playerCount: 0,
  };
}

function isDaily(q: QuestTemplate): boolean {
  return (q.flags & QUEST_FLAGS_DAILY) !== 0;
}

function isWeekly(q: QuestTemplate): boolean {
  return (q.flags & QUEST_FLAGS_WEEKLY) !== 0;
}

function isMonthly(q: QuestTemplate): boolean {
  return (q.specialFlags & QUEST_SPECIAL_MONTHLY) !== 0;
}

function isRepeatable(q: QuestTemplate): boolean {
  return (q.specialFlags & QUEST_SPECIAL_REPEATABLE) !== 0;
}

function isSeasonal(q: QuestTemplate): boolean {
  if (isRepeatable(q)) {
    return false;
  }
  const sort = -q.questSortId;
  switch (sort) {
    case QUEST_SORT_SEASONAL:
    case QUEST_SORT_SPECIAL:
    case QUEST_SORT_LUNAR_FESTIVAL:
    case QUEST_SORT_MIDSUMMER:
    case QUEST_SORT_BREWFEST:
    case QUEST_SORT_LOVE_IS_IN_THE_AIR:
    case QUEST_SORT_NOBLEGARDEN:
      return true;
    default:
      return false;
  }
}

function packetRepeatable(q: QuestTemplate): boolean {
  return isRepeatable(q) && !isDaily(q) && !isWeekly(q) && !isMonthly(q);
}

function questLevelForPlayer(q: QuestTemplate, playerLevel: number): number {
  return q.questLevel === -1 ? playerLevel : q.questLevel;
}

function hasObjectives(q: QuestTemplate): boolean {
  for (let i = 0; i < 4; i += 1) {
    if (q.requiredNpcOrGo[i] !== 0 && (q.requiredNpcOrGoCount[i] ?? 0) > 0) {
      return true;
    }
  }
  for (let i = 0; i < 6; i += 1) {
    if (q.requiredItemId[i] !== 0 && (q.requiredItemCount[i] ?? 0) > 0) {
      return true;
    }
  }
  if (q.requiredPlayerKills > 0) {
    return true;
  }
  if ((q.specialFlags & QUEST_SPECIAL_EXPLORATION) !== 0) {
    return true;
  }
  return false;
}

function choiceCount(q: QuestTemplate): number {
  let count = 0;
  for (const id of q.rewardChoiceItemId) {
    if (id) {
      count += 1;
    }
  }
  return count;
}

function rewardItemCount(q: QuestTemplate): number {
  let count = 0;
  for (const id of q.rewardItem) {
    if (id) {
      count += 1;
    }
  }
  return count;
}

function requiredItemObjectiveCount(q: QuestTemplate): number {
  let count = 0;
  for (let i = 0; i < 6; i += 1) {
    if (q.requiredItemId[i]) {
      count += 1;
    }
  }
  return count;
}

export function questXPValue(
  q: QuestTemplate,
  playerLevel: number,
  xpByLevel: Map<number, number[]>,
): number {
  const questLevel = questLevelForPlayer(q, playerLevel);
  const entry = xpByLevel.get(questLevel);
  if (!entry) {
    return 0;
  }
  let diffFactor = 2 * (questLevel - playerLevel) + 20;
  if (diffFactor < 1) {
    diffFactor = 1;
  } else if (diffFactor > 10) {
    diffFactor = 10;
  }
  const difficulty = entry[q.rewardXPDifficulty] ?? 0;
  let xp = Math.trunc((diffFactor * difficulty) / 10);
  if (xp <= 100) {
    xp = 5 * Math.trunc((xp + 2) / 5);
  } else if (xp <= 500) {
    xp = 10 * Math.trunc((xp + 5) / 10);
  } else if (xp <= 1000) {
    xp = 25 * Math.trunc((xp + 12) / 25);
  } else {
    xp = 50 * Math.trunc((xp + 25) / 50);
  }
  return xp;
}

export function getRewOrReqMoney(
  q: QuestTemplate,
  playerLevel: number,
  moneyByLevel: Map<number, number[]>,
): number {
  let rewardedMoney = q.rewardMoney;
  if (rewardedMoney < 0) {
    return rewardedMoney;
  }
  if (playerLevel && q.rewardMoneyDifficulty) {
    const row = moneyByLevel.get(playerLevel);
    if (row && q.rewardMoneyDifficulty < 10) {
      const fromTable = row[q.rewardMoneyDifficulty] ?? 0;
      if (fromTable) {
        rewardedMoney = fromTable;
      }
    }
  }
  return rewardedMoney;
}

function reputationStanding(
  q: QuestTemplate,
  index: number,
  factionRewards: Map<number, number[]>,
): number | null {
  const faction = q.rewardFactionId[index] ?? 0;
  if (!faction) {
    return null;
  }
  const override = q.rewardFactionOverride[index] ?? 0;
  if (override !== 0) {
    return override / 100;
  }
  const value = q.rewardFactionValue[index] ?? 0;
  const rowId = value < 0 ? 2 : 1;
  const field = Math.abs(value);
  const row = factionRewards.get(rowId);
  if (!row) {
    return 0;
  }
  return row[field] ?? 0;
}

export class QuestCatalog {
  readonly quests = new Map<number, QuestTemplate>();
  readonly creatureStarters = new Map<number, number[]>();
  readonly creatureEnders = new Map<number, number[]>();
  readonly goStarters = new Map<number, number[]>();
  readonly goEnders = new Map<number, number[]>();
  readonly pois = new Map<number, QuestPoi[]>();
  readonly exclusiveGroups = new Map<number, number[]>();
  readonly xpByLevel = new Map<number, number[]>();
  readonly factionRewards = new Map<number, number[]>();
  readonly moneyByLevel = new Map<number, number[]>();

  constructor(db: WorldTables) {
    this.load(db);
  }

  quest(id: number): QuestTemplate | null {
    return this.quests.get(id) ?? null;
  }

  starters(kind: QuestGiverKind, entry: number): number[] {
    const map = kind === "creature" ? this.creatureStarters : this.goStarters;
    return map.get(entry) ?? [];
  }

  enders(kind: QuestGiverKind, entry: number): number[] {
    const map = kind === "creature" ? this.creatureEnders : this.goEnders;
    return map.get(entry) ?? [];
  }

  poi(questId: number): QuestPoi[] {
    return this.pois.get(questId) ?? [];
  }

  private load(db: WorldTables): void {
    if (db.has(quest_template)) {
      const rows = db.all(quest_template) as readonly Record<string, unknown>[];
      for (const row of rows) {
        const id = asNumber(row.ID ?? row.id);
        const quest: QuestTemplate = {
          id,
          questType: asNumber(row.QuestType),
          questLevel: asNumber(row.QuestLevel),
          minLevel: asNumber(row.MinLevel),
          questSortId: asNumber(row.QuestSortID),
          questInfoId: asNumber(row.QuestInfoID),
          suggestedGroupNum: asNumber(row.SuggestedGroupNum),
          requiredFactionId: [asNumber(row.RequiredFactionId1), asNumber(row.RequiredFactionId2)],
          requiredFactionValue: [asNumber(row.RequiredFactionValue1), asNumber(row.RequiredFactionValue2)],
          rewardNextQuest: asNumber(row.RewardNextQuest),
          rewardXPDifficulty: asNumber(row.RewardXPDifficulty),
          rewardMoney: asNumber(row.RewardMoney),
          rewardMoneyDifficulty: asNumber(row.RewardMoneyDifficulty),
          rewardDisplaySpell: asNumber(row.RewardDisplaySpell),
          rewardSpell: asNumber(row.RewardSpell),
          rewardHonor: asNumber(row.RewardHonor),
          rewardKillHonor: asNumber(row.RewardKillHonor),
          startItem: asNumber(row.StartItem),
          flags: asNumber(row.Flags),
          requiredPlayerKills: asNumber(row.RequiredPlayerKills),
          rewardItem: [
            asNumber(row.RewardItem1),
            asNumber(row.RewardItem2),
            asNumber(row.RewardItem3),
            asNumber(row.RewardItem4),
          ],
          rewardAmount: [
            asNumber(row.RewardAmount1),
            asNumber(row.RewardAmount2),
            asNumber(row.RewardAmount3),
            asNumber(row.RewardAmount4),
          ],
          itemDrop: [
            asNumber(row.ItemDrop1),
            asNumber(row.ItemDrop2),
            asNumber(row.ItemDrop3),
            asNumber(row.ItemDrop4),
          ],
          itemDropQuantity: [
            asNumber(row.ItemDropQuantity1),
            asNumber(row.ItemDropQuantity2),
            asNumber(row.ItemDropQuantity3),
            asNumber(row.ItemDropQuantity4),
          ],
          rewardChoiceItemId: [
            asNumber(row.RewardChoiceItemID1),
            asNumber(row.RewardChoiceItemID2),
            asNumber(row.RewardChoiceItemID3),
            asNumber(row.RewardChoiceItemID4),
            asNumber(row.RewardChoiceItemID5),
            asNumber(row.RewardChoiceItemID6),
          ],
          rewardChoiceItemQuantity: [
            asNumber(row.RewardChoiceItemQuantity1),
            asNumber(row.RewardChoiceItemQuantity2),
            asNumber(row.RewardChoiceItemQuantity3),
            asNumber(row.RewardChoiceItemQuantity4),
            asNumber(row.RewardChoiceItemQuantity5),
            asNumber(row.RewardChoiceItemQuantity6),
          ],
          poiContinent: asNumber(row.POIContinent),
          poiX: asNumber(row.POIx),
          poiY: asNumber(row.POIy),
          poiPriority: asNumber(row.POIPriority),
          rewardTitle: asNumber(row.RewardTitle),
          rewardTalents: asNumber(row.RewardTalents),
          rewardArenaPoints: asNumber(row.RewardArenaPoints),
          rewardFactionId: [
            asNumber(row.RewardFactionID1),
            asNumber(row.RewardFactionID2),
            asNumber(row.RewardFactionID3),
            asNumber(row.RewardFactionID4),
            asNumber(row.RewardFactionID5),
          ],
          rewardFactionValue: [
            asNumber(row.RewardFactionValue1),
            asNumber(row.RewardFactionValue2),
            asNumber(row.RewardFactionValue3),
            asNumber(row.RewardFactionValue4),
            asNumber(row.RewardFactionValue5),
          ],
          rewardFactionOverride: [
            asNumber(row.RewardFactionOverride1),
            asNumber(row.RewardFactionOverride2),
            asNumber(row.RewardFactionOverride3),
            asNumber(row.RewardFactionOverride4),
            asNumber(row.RewardFactionOverride5),
          ],
          timeAllowed: asNumber(row.TimeAllowed),
          allowableRaces: asNumber(row.AllowableRaces),
          logTitle: asString(row.LogTitle),
          logDescription: asString(row.LogDescription),
          questDescription: asString(row.QuestDescription),
          areaDescription: asString(row.AreaDescription),
          questCompletionLog: asString(row.QuestCompletionLog),
          requiredNpcOrGo: [
            asNumber(row.RequiredNpcOrGo1),
            asNumber(row.RequiredNpcOrGo2),
            asNumber(row.RequiredNpcOrGo3),
            asNumber(row.RequiredNpcOrGo4),
          ],
          requiredNpcOrGoCount: [
            asNumber(row.RequiredNpcOrGoCount1),
            asNumber(row.RequiredNpcOrGoCount2),
            asNumber(row.RequiredNpcOrGoCount3),
            asNumber(row.RequiredNpcOrGoCount4),
          ],
          requiredItemId: [
            asNumber(row.RequiredItemId1),
            asNumber(row.RequiredItemId2),
            asNumber(row.RequiredItemId3),
            asNumber(row.RequiredItemId4),
            asNumber(row.RequiredItemId5),
            asNumber(row.RequiredItemId6),
          ],
          requiredItemCount: [
            asNumber(row.RequiredItemCount1),
            asNumber(row.RequiredItemCount2),
            asNumber(row.RequiredItemCount3),
            asNumber(row.RequiredItemCount4),
            asNumber(row.RequiredItemCount5),
            asNumber(row.RequiredItemCount6),
          ],
          objectiveText: [
            asString(row.ObjectiveText1),
            asString(row.ObjectiveText2),
            asString(row.ObjectiveText3),
            asString(row.ObjectiveText4),
          ],
          maxLevel: 0,
          allowableClasses: 0,
          prevQuestId: 0,
          nextQuestId: 0,
          exclusiveGroup: 0,
          specialFlags: 0,
          providedItemCount: 0,
          offerEmote: [0, 0, 0, 0],
          offerEmoteDelay: [0, 0, 0, 0],
          rewardText: "",
          emoteOnComplete: 0,
          emoteOnIncomplete: 0,
          completionText: "",
          detailsEmote: [0, 0, 0, 0],
          detailsEmoteDelay: [0, 0, 0, 0],
        };
        this.quests.set(id, quest);
      }
    }

    if (db.has(quest_template_addon)) {
      const rows = db.all(quest_template_addon) as readonly Record<string, unknown>[];
      for (const row of rows) {
        const quest = this.quests.get(asNumber(row.ID ?? row.id));
        if (!quest) {
          continue;
        }
        quest.maxLevel = asNumber(row.MaxLevel);
        quest.allowableClasses = asNumber(row.AllowableClasses);
        quest.prevQuestId = asNumber(row.PrevQuestID);
        quest.nextQuestId = asNumber(row.NextQuestID);
        quest.exclusiveGroup = asNumber(row.ExclusiveGroup);
        quest.specialFlags = asNumber(row.SpecialFlags);
        quest.providedItemCount = asNumber(row.ProvidedItemCount);
      }
    }

    if (db.has(quest_offer_reward)) {
      const rows = db.all(quest_offer_reward) as readonly Record<string, unknown>[];
      for (const row of rows) {
        const quest = this.quests.get(asNumber(row.ID ?? row.id));
        if (!quest) {
          continue;
        }
        quest.offerEmote = [
          asNumber(row.Emote1),
          asNumber(row.Emote2),
          asNumber(row.Emote3),
          asNumber(row.Emote4),
        ];
        quest.offerEmoteDelay = [
          asNumber(row.EmoteDelay1),
          asNumber(row.EmoteDelay2),
          asNumber(row.EmoteDelay3),
          asNumber(row.EmoteDelay4),
        ];
        quest.rewardText = asString(row.RewardText);
      }
    }

    if (db.has(quest_request_items)) {
      const rows = db.all(quest_request_items) as readonly Record<string, unknown>[];
      for (const row of rows) {
        const quest = this.quests.get(asNumber(row.ID ?? row.id));
        if (!quest) {
          continue;
        }
        quest.emoteOnComplete = asNumber(row.EmoteOnComplete);
        quest.emoteOnIncomplete = asNumber(row.EmoteOnIncomplete);
        quest.completionText = asString(row.CompletionText);
      }
    }

    if (db.has(quest_details)) {
      const rows = db.all(quest_details) as readonly Record<string, unknown>[];
      for (const row of rows) {
        const quest = this.quests.get(asNumber(row.ID ?? row.id));
        if (!quest) {
          continue;
        }
        quest.detailsEmote = [
          asNumber(row.Emote1),
          asNumber(row.Emote2),
          asNumber(row.Emote3),
          asNumber(row.Emote4),
        ];
        quest.detailsEmoteDelay = [
          asNumber(row.EmoteDelay1),
          asNumber(row.EmoteDelay2),
          asNumber(row.EmoteDelay3),
          asNumber(row.EmoteDelay4),
        ];
      }
    }

    this.loadRelations(db, creature_queststarter, this.creatureStarters);
    this.loadRelations(db, creature_questender, this.creatureEnders);
    this.loadRelations(db, gameobject_queststarter, this.goStarters);
    this.loadRelations(db, gameobject_questender, this.goEnders);

    if (db.has(quest_poi)) {
      const poiRows = db.all(quest_poi) as readonly Record<string, unknown>[];
      const pointRows = db.has(quest_poi_points)
        ? [...(db.all(quest_poi_points) as readonly Record<string, unknown>[])].sort(
            (left, right) =>
              asNumber(left.QuestID) - asNumber(right.QuestID) ||
              asNumber(left.Idx1) - asNumber(right.Idx1) ||
              asNumber(left.Idx2) - asNumber(right.Idx2),
          )
        : [];
      const pointsByKey = new Map<string, QuestPoiPoint[]>();
      for (const row of pointRows) {
        const questId = asNumber(row.QuestID);
        const idx1 = asNumber(row.Idx1);
        const key = `${questId}:${idx1}`;
        const list = pointsByKey.get(key) ?? [];
        list.push({ x: asNumber(row.X), y: asNumber(row.Y) });
        pointsByKey.set(key, list);
      }
      for (const row of poiRows) {
        const questId = asNumber(row.QuestID);
        const id = asNumber(row.id ?? row.ID);
        const poi: QuestPoi = {
          id,
          objectiveIndex: asNumber(row.ObjectiveIndex),
          mapId: asNumber(row.MapID),
          worldMapAreaId: asNumber(row.WorldMapAreaId),
          floor: asNumber(row.Floor),
          priority: asNumber(row.Priority),
          flags: asNumber(row.Flags),
          points: pointsByKey.get(`${questId}:${id}`) ?? [],
        };
        const list = this.pois.get(questId) ?? [];
        list.push(poi);
        this.pois.set(questId, list);
      }
    }

    if (db.has(questxp_dbc)) {
      for (const row of db.all(questxp_dbc) as readonly Record<string, unknown>[]) {
        this.xpByLevel.set(asNumber(row.ID), [
          asNumber(row.Difficulty_1),
          asNumber(row.Difficulty_2),
          asNumber(row.Difficulty_3),
          asNumber(row.Difficulty_4),
          asNumber(row.Difficulty_5),
          asNumber(row.Difficulty_6),
          asNumber(row.Difficulty_7),
          asNumber(row.Difficulty_8),
          asNumber(row.Difficulty_9),
          asNumber(row.Difficulty_10),
        ]);
      }
    }

    if (db.has(questfactionreward_dbc)) {
      for (const row of db.all(questfactionreward_dbc) as readonly Record<string, unknown>[]) {
        this.factionRewards.set(asNumber(row.ID), [
          asNumber(row.Difficulty_1),
          asNumber(row.Difficulty_2),
          asNumber(row.Difficulty_3),
          asNumber(row.Difficulty_4),
          asNumber(row.Difficulty_5),
          asNumber(row.Difficulty_6),
          asNumber(row.Difficulty_7),
          asNumber(row.Difficulty_8),
          asNumber(row.Difficulty_9),
          asNumber(row.Difficulty_10),
        ]);
      }
    }

    if (db.has(quest_money_reward)) {
      for (const row of db.all(quest_money_reward) as readonly Record<string, unknown>[]) {
        this.moneyByLevel.set(asNumber(row.Level), [
          asNumber(row.Money0),
          asNumber(row.Money1),
          asNumber(row.Money2),
          asNumber(row.Money3),
          asNumber(row.Money4),
          asNumber(row.Money5),
          asNumber(row.Money6),
          asNumber(row.Money7),
          asNumber(row.Money8),
          asNumber(row.Money9),
        ]);
      }
    }

    for (const quest of this.quests.values()) {
      if (quest.exclusiveGroup !== 0) {
        const list = this.exclusiveGroups.get(quest.exclusiveGroup) ?? [];
        list.push(quest.id);
        this.exclusiveGroups.set(quest.exclusiveGroup, list);
      }
    }
  }

  private loadRelations(
    db: WorldTables,
    table: typeof creature_queststarter | typeof creature_questender | typeof gameobject_queststarter | typeof gameobject_questender,
    target: Map<number, number[]>,
  ): void {
    for (const row of db.all(table)) {
      const list = target.get(row.id) ?? [];
      list.push(row.quest);
      target.set(row.id, list);
    }
  }
}

export class QuestLog {
  speaker: QuestSpeaker = { race: 1, classId: 1, level: 1 };
  private readonly activeQuests = new Map<number, ActiveQuest>();
  private readonly rewardedQuests = new Set<number>();
  private readonly dailyQuests = new Map<number, number>();
  private readonly weeklyQuests = new Set<number>();
  private readonly monthlyQuests = new Set<number>();
  private readonly seasonalQuests = new Map<number, number>();
  private readonly slots = new Array<number>(QUEST_LOG_SLOT_COUNT).fill(0);

  constructor(private readonly catalog: QuestCatalog) {}

  source(): QuestCatalog {
    return this.catalog;
  }

  async load(db: Db, guid: number): Promise<void> {
    const state = await loadQuestStatus(db, guid);
    this.activeQuests.clear();
    this.rewardedQuests.clear();
    this.dailyQuests.clear();
    this.weeklyQuests.clear();
    this.monthlyQuests.clear();
    this.seasonalQuests.clear();

    for (const row of state.active) {
      this.activeQuests.set(row.quest, {
        status: row.status,
        explored: row.explored,
        timer: row.timer,
        mob: [row.mobcount1, row.mobcount2, row.mobcount3, row.mobcount4],
        item: [
          row.itemcount1,
          row.itemcount2,
          row.itemcount3,
          row.itemcount4,
          row.itemcount5,
          row.itemcount6,
        ],
        playerCount: row.playercount,
      });
    }
    for (const row of state.rewarded) {
      this.rewardedQuests.add(row.quest);
    }
    for (const row of state.daily) {
      this.dailyQuests.set(row.quest, row.time);
    }
    for (const row of state.weekly) {
      this.weeklyQuests.add(row.quest);
    }
    for (const row of state.monthly) {
      this.monthlyQuests.add(row.quest);
    }
    for (const row of state.seasonal) {
      this.seasonalQuests.set(row.quest, row.event);
    }
    this.rebuildSlots();
  }

  async save(db: Db, guid: number): Promise<void> {
    const state: QuestStatusState = {
      active: [],
      rewarded: [],
      daily: [],
      weekly: [],
      monthly: [],
      seasonal: [],
    };
    for (const [quest, aq] of this.activeQuests) {
      state.active.push({
        quest,
        status: aq.status,
        explored: aq.explored,
        timer: aq.timer,
        mobcount1: aq.mob[0],
        mobcount2: aq.mob[1],
        mobcount3: aq.mob[2],
        mobcount4: aq.mob[3],
        itemcount1: aq.item[0],
        itemcount2: aq.item[1],
        itemcount3: aq.item[2],
        itemcount4: aq.item[3],
        itemcount5: aq.item[4],
        itemcount6: aq.item[5],
        playercount: aq.playerCount,
      });
    }
    for (const quest of this.rewardedQuests) {
      state.rewarded.push({ quest, active: 1 });
    }
    for (const [quest, time] of this.dailyQuests) {
      state.daily.push({ quest, time });
    }
    for (const quest of this.weeklyQuests) {
      state.weekly.push({ quest });
    }
    for (const quest of this.monthlyQuests) {
      state.monthly.push({ quest });
    }
    for (const [quest, event] of this.seasonalQuests) {
      state.seasonal.push({ quest, event });
    }
    await saveQuestStatus(db, guid, state);
  }

  status(questId: number): number {
    const active = this.activeQuests.get(questId);
    if (active) {
      return active.status;
    }
    if (this.rewardedQuests.has(questId)) {
      return QUEST_STATUS_REWARDED;
    }
    return QUEST_STATUS_NONE;
  }

  rewarded(questId: number): boolean {
    return this.rewardedQuests.has(questId);
  }

  objective(questId: number, index: number): number {
    const active = this.activeQuests.get(questId);
    if (!active || index < 0 || index > 3) {
      return 0;
    }
    return active.mob[index] ?? 0;
  }

  active(): Map<number, ActiveQuest> {
    return this.activeQuests;
  }

  menu(kind: QuestGiverKind, entry: number): QuestMenuEntry[] {
    const entries: QuestMenuEntry[] = [];
    for (const questId of this.catalog.enders(kind, entry)) {
      const quest = this.catalog.quest(questId);
      if (!quest) {
        continue;
      }
      const st = this.status(questId);
      if (st === QUEST_STATUS_COMPLETE || st === QUEST_STATUS_INCOMPLETE) {
        entries.push(this.menuEntry(quest, 4));
      }
    }
    for (const questId of this.catalog.starters(kind, entry)) {
      const quest = this.catalog.quest(questId);
      if (!quest) {
        continue;
      }
      if (!this.canTake(questId, this.speaker)) {
        continue;
      }
      if (this.status(questId) !== QUEST_STATUS_NONE) {
        continue;
      }
      let icon = 2;
      if (quest.questType === 0) {
        if (!isRepeatable(quest) || isDaily(quest) || isWeekly(quest) || isMonthly(quest)) {
          icon = 0;
        } else {
          icon = 4;
        }
      }
      entries.push(this.menuEntry(quest, icon));
    }
    return entries;
  }

  dialogStatus(kind: QuestGiverKind, entry: number): number {
    let result = DIALOG_NONE;
    for (const questId of this.catalog.enders(kind, entry)) {
      const quest = this.catalog.quest(questId);
      if (!quest) {
        continue;
      }
      let next = DIALOG_NONE;
      const st = this.status(questId);
      if (st === QUEST_STATUS_COMPLETE) {
        next = DIALOG_REWARD;
      } else if (st === QUEST_STATUS_INCOMPLETE) {
        next = DIALOG_INCOMPLETE;
      }
      if (
        quest.questType === 0 &&
        isRepeatable(quest) &&
        !isDaily(quest) &&
        !isWeekly(quest) &&
        this.canTake(questId, this.speaker)
      ) {
        next = DIALOG_REWARD_REP;
      }
      if (next > result) {
        result = next;
      }
    }

    for (const questId of this.catalog.starters(kind, entry)) {
      const quest = this.catalog.quest(questId);
      if (!quest) {
        continue;
      }
      if (this.status(questId) !== QUEST_STATUS_NONE) {
        continue;
      }
      let next = DIALOG_NONE;
      if (this.speaker.level < quest.minLevel) {
        if (this.passesNonLevelGates(quest, this.speaker)) {
          next = DIALOG_UNAVAILABLE;
        }
      } else if (this.canTake(questId, this.speaker)) {
        const qLevel = questLevelForPlayer(quest, this.speaker.level);
        const notLow = this.speaker.level <= qLevel + LOW_LEVEL_DIFF;
        if (isDaily(quest)) {
          next = notLow ? DIALOG_AVAILABLE_REP : DIALOG_LOW_LEVEL_AVAILABLE_REP;
        } else if (isWeekly(quest) || isMonthly(quest)) {
          next = notLow ? DIALOG_AVAILABLE : DIALOG_LOW_LEVEL_AVAILABLE;
        } else {
          next = notLow ? DIALOG_AVAILABLE : DIALOG_LOW_LEVEL_AVAILABLE;
        }
      }
      if (next > result) {
        result = next;
      }
    }
    return result;
  }

  canTake(questId: number, speaker: QuestSpeaker): boolean {
    this.speaker = speaker;
    const quest = this.catalog.quest(questId);
    if (!quest) {
      return false;
    }
    if (this.activeQuests.has(questId)) {
      return false;
    }
    if (speaker.level < quest.minLevel) {
      return false;
    }
    if (quest.maxLevel !== 0 && speaker.level > quest.maxLevel) {
      return false;
    }
    if (quest.allowableRaces !== 0 && (quest.allowableRaces & (1 << (speaker.race - 1))) === 0) {
      return false;
    }
    if (quest.allowableClasses !== 0 && (quest.allowableClasses & (1 << (speaker.classId - 1))) === 0) {
      return false;
    }
    if (quest.prevQuestId > 0 && !this.rewardedQuests.has(quest.prevQuestId)) {
      return false;
    }
    if (quest.prevQuestId < 0) {
      const prev = Math.abs(quest.prevQuestId);
      if (!this.activeQuests.has(prev) && !this.rewardedQuests.has(prev)) {
        return false;
      }
    }
    if (quest.exclusiveGroup !== 0) {
      const group = this.catalog.exclusiveGroups.get(quest.exclusiveGroup) ?? [];
      for (const otherId of group) {
        if (otherId === questId) {
          continue;
        }
        if (this.activeQuests.has(otherId) || this.rewardedQuests.has(otherId)) {
          return false;
        }
      }
    }
    if (isDaily(quest) && this.dailyQuests.has(questId)) {
      return false;
    }
    if (isWeekly(quest) && this.weeklyQuests.has(questId)) {
      return false;
    }
    if (isMonthly(quest) && this.monthlyQuests.has(questId)) {
      return false;
    }
    if (isSeasonal(quest) && this.seasonalQuests.has(questId)) {
      return false;
    }
    if (this.rewardedQuests.has(questId)) {
      if (!(isRepeatable(quest) && !isDaily(quest) && !isWeekly(quest) && !isMonthly(quest))) {
        return false;
      }
    }
    if (quest.flags & QUEST_FLAGS_UNAVAILABLE) {
      return false;
    }
    return true;
  }

  accept(questId: number): "ok" | "full" | "denied" {
    const quest = this.catalog.quest(questId);
    if (!quest) {
      return "denied";
    }
    if (!this.canTake(questId, this.speaker)) {
      return "denied";
    }
    if (this.activeQuests.size >= QUEST_LOG_SLOT_COUNT) {
      return "full";
    }
    const aq = emptyActive();
    if (!hasObjectives(quest) || quest.questType === 0) {
      aq.status = QUEST_STATUS_COMPLETE;
    }
    this.activeQuests.set(questId, aq);
    this.occupy(questId);
    return "ok";
  }

  canShare(questId: number): boolean {
    const quest = this.catalog.quest(questId);
    if (!quest || (quest.flags & QUEST_FLAGS_SHARABLE) === 0) {
      return false;
    }
    return this.activeQuests.has(questId);
  }

  logFull(): boolean {
    return !this.slots.includes(0);
  }

  slotIds(): readonly number[] {
    return this.slots;
  }

  swap(slot1: number, slot2: number): boolean {
    if (slot1 === slot2 || slot1 < 0 || slot2 < 0 || slot1 >= QUEST_LOG_SLOT_COUNT || slot2 >= QUEST_LOG_SLOT_COUNT) {
      return false;
    }
    const first = this.slots[slot1] ?? 0;
    this.slots[slot1] = this.slots[slot2] ?? 0;
    this.slots[slot2] = first;
    return true;
  }

  abandon(slot: number): number | null {
    const questId = this.slots[slot] ?? 0;
    if (questId === 0) {
      return null;
    }
    this.slots[slot] = 0;
    this.activeQuests.delete(questId);
    return questId;
  }

  complete(questId: number): boolean {
    const aq = this.activeQuests.get(questId);
    const quest = this.catalog.quest(questId);
    if (!aq || !quest || aq.status === QUEST_STATUS_FAILED) {
      return false;
    }
    if (!this.objectivesMet(quest, aq)) {
      return false;
    }
    aq.status = QUEST_STATUS_COMPLETE;
    return true;
  }

  reward(questId: number, choice: number, speakerLevel: number): RewardResult | null {
    const aq = this.activeQuests.get(questId);
    const quest = this.catalog.quest(questId);
    if (!aq || !quest || aq.status !== QUEST_STATUS_COMPLETE) {
      return null;
    }

    const alreadyRewarded = this.rewardedQuests.has(questId);
    const giveXp =
      alreadyRewarded && !isDaily(quest) && !isWeekly(quest) && !isMonthly(quest)
        ? 0
        : questXPValue(quest, speakerLevel, this.catalog.xpByLevel);
    const money = getRewOrReqMoney(quest, speakerLevel, this.catalog.moneyByLevel);
    const factions: { faction: number; standing: number }[] = [];
    for (let i = 0; i < 5; i += 1) {
      const standing = reputationStanding(quest, i, this.catalog.factionRewards);
      const faction = quest.rewardFactionId[i] ?? 0;
      if (faction && standing !== null && standing !== 0) {
        factions.push({ faction, standing });
      }
    }

    const choiceItem = quest.rewardChoiceItemId[choice] ?? 0;
    const choiceCountValue = choiceItem ? (quest.rewardChoiceItemQuantity[choice] ?? 0) : 0;
    const items: { id: number; count: number }[] = [];
    for (let i = 0; i < 4; i += 1) {
      const id = quest.rewardItem[i] ?? 0;
      if (id) {
        items.push({ id, count: quest.rewardAmount[i] ?? 0 });
      }
    }

    this.activeQuests.delete(questId);
    this.vacate(questId);

    if (isDaily(quest)) {
      this.dailyQuests.set(questId, Math.floor(Date.now() / 1000));
    } else if (isWeekly(quest)) {
      this.weeklyQuests.add(questId);
    } else if (isMonthly(quest)) {
      this.monthlyQuests.add(questId);
    } else if (isSeasonal(quest)) {
      this.seasonalQuests.set(questId, 0);
    }
    this.rewardedQuests.add(questId);

    return {
      xp: giveXp,
      money,
      honor: quest.rewardHonor,
      spell: quest.rewardSpell || quest.rewardDisplaySpell,
      talents: quest.rewardTalents,
      arena: quest.rewardArenaPoints,
      factions,
      choiceItem,
      choiceCount: choiceCountValue,
      items,
    };
  }

  creditKill(entry: number, guid: bigint): Credit[] {
    return this.creditCreatureOrGo(entry, guid, "kill");
  }

  creditGo(entry: number, guid: bigint): Credit[] {
    return this.creditCreatureOrGo(-entry, guid, "go");
  }

  creditTalk(entry: number): Credit[] {
    const credits: Credit[] = [];
    for (const [questId, aq] of this.activeQuests) {
      if (aq.status !== QUEST_STATUS_INCOMPLETE) {
        continue;
      }
      const quest = this.catalog.quest(questId);
      if (!quest) {
        continue;
      }
      const enders = this.catalog.enders("creature", entry);
      if (!enders.includes(questId)) {
        continue;
      }
      for (let j = 0; j < 4; j += 1) {
        const requiredId = quest.requiredNpcOrGo[j] ?? 0;
        if (requiredId <= 0 || requiredId !== entry) {
          continue;
        }
        const required = quest.requiredNpcOrGoCount[j] ?? 0;
        const current = aq.mob[j] ?? 0;
        if (current >= required) {
          continue;
        }
        aq.mob[j] = current + 1;
        const done = this.objectivesMet(quest, aq);
        if (done) {
          aq.status = QUEST_STATUS_COMPLETE;
        }
        credits.push({
          questId,
          entry,
          count: aq.mob[j]!,
          required,
          guid: 0n,
          done,
        });
        break;
      }
    }
    return credits;
  }

  explore(questId: number): boolean {
    const aq = this.activeQuests.get(questId);
    const quest = this.catalog.quest(questId);
    if (!aq || !quest || aq.status === QUEST_STATUS_FAILED) {
      return false;
    }
    aq.explored = 1;
    if (this.objectivesMet(quest, aq)) {
      aq.status = QUEST_STATUS_COMPLETE;
    }
    return true;
  }

  /**
   * `Player::HasQuestForItem`: an item a quest in the log still collects (`RequiredItemId`) or hands out (`ItemDrop`).
   * `showInLoot` is cleared when a quest needs the item but the bags already hold enough of it.
   */
  hasQuestForItem(
    itemId: number,
    opts: {
      /** `Player::GetItemCount(itemid, true)` */
      ownedCount: (itemId: number) => number;
      /** `item_template.maxcount` and `ItemTemplate::GetMaxStackSize` */
      itemProto: (itemId: number) => { maxcount: number; maxStackSize: number } | null;
      excludeQuestId?: number;
      turnIn?: boolean;
      showInLoot?: { value: boolean };
    },
  ): boolean {
    const turnIn = opts.turnIn ?? false;
    for (const questId of this.slots) {
      if (questId === 0 || questId === opts.excludeQuestId) {
        continue;
      }
      const aq = this.activeQuests.get(questId);
      if (!aq) {
        continue;
      }
      if (aq.status !== QUEST_STATUS_INCOMPLETE && !(turnIn && aq.status === QUEST_STATUS_COMPLETE)) {
        continue;
      }
      const quest = this.catalog.quest(questId);
      if (!quest) {
        continue;
      }
      // There should be no mixed ReqItem/ReqSource drop
      // This part for ReqItem drop
      for (let j = 0; j < 6; j++) {
        const required = quest.requiredItemCount[j] ?? 0;
        const collected = aq.item[j] ?? 0;
        if (itemId === quest.requiredItemId[j] && collected < required) {
          if (opts.showInLoot) {
            if (opts.ownedCount(itemId) < required) {
              return true;
            }
            opts.showInLoot.value = false;
          } else {
            return true;
          }
        }
        if (turnIn && collected >= required) {
          return true;
        }
      }
      // This part - for ReqSource
      for (let j = 0; j < 4; j++) {
        // examined item is a source item
        if (quest.itemDrop[j] !== itemId) {
          continue;
        }
        const proto = opts.itemProto(itemId);
        if (!proto) {
          continue;
        }
        const ownedCount = opts.ownedCount(itemId);
        // 'unique' item
        if ((proto.maxcount && ownedCount < proto.maxcount) || (turnIn && ownedCount >= proto.maxcount)) {
          return true;
        }
        // allows custom amount drop when not 0
        const quantity = quest.itemDropQuantity[j] ?? 0;
        if (quantity) {
          if (ownedCount < quantity || (turnIn && ownedCount >= quantity)) {
            return true;
          }
        } else if (ownedCount < proto.maxStackSize) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * `Player::ItemAddedQuestCheck`: counts `count` of `entry` toward the item objectives in the log and completes the quests that are done.
   * Returns true when a quest was completed (its log slot state changed).
   */
  itemAddedQuestCheck(entry: number, count: number): boolean {
    let completed = false;
    for (const questId of this.slots) {
      if (questId === 0) {
        continue;
      }
      const aq = this.activeQuests.get(questId);
      if (!aq || aq.status !== QUEST_STATUS_INCOMPLETE) {
        continue;
      }
      const quest = this.catalog.quest(questId);
      // `QUEST_SPECIAL_FLAGS_DELIVER` is set at load for a quest with a `RequiredItemId`.
      if (!quest || !quest.requiredItemId.some((id) => id !== 0)) {
        continue;
      }
      for (let j = 0; j < 6; j++) {
        if (quest.requiredItemId[j] !== entry) {
          continue;
        }
        const required = quest.requiredItemCount[j] ?? 0;
        const current = aq.item[j] ?? 0;
        if (current < required) {
          aq.item[j] = Math.min(current + count, required);
        }
        // `CanCompleteQuest` → `CompleteQuest`
        if (aq.status === QUEST_STATUS_INCOMPLETE && this.objectivesMet(quest, aq)) {
          aq.status = QUEST_STATUS_COMPLETE;
          completed = true;
        }
      }
    }
    return completed;
  }

  private menuEntry(quest: QuestTemplate, icon: number): QuestMenuEntry {
    return {
      questId: quest.id,
      icon,
      level: quest.questLevel,
      flags: quest.flags,
      repeatable: packetRepeatable(quest),
      title: quest.logTitle,
    };
  }

  private passesNonLevelGates(quest: QuestTemplate, speaker: QuestSpeaker): boolean {
    if (this.activeQuests.has(quest.id)) {
      return false;
    }
    if (quest.allowableRaces !== 0 && (quest.allowableRaces & (1 << (speaker.race - 1))) === 0) {
      return false;
    }
    if (quest.allowableClasses !== 0 && (quest.allowableClasses & (1 << (speaker.classId - 1))) === 0) {
      return false;
    }
    if (quest.flags & QUEST_FLAGS_UNAVAILABLE) {
      return false;
    }
    return true;
  }

  private objectivesMet(quest: QuestTemplate, aq: ActiveQuest): boolean {
    for (let i = 0; i < 4; i += 1) {
      if ((quest.requiredNpcOrGo[i] ?? 0) === 0) {
        continue;
      }
      if ((aq.mob[i] ?? 0) < (quest.requiredNpcOrGoCount[i] ?? 0)) {
        return false;
      }
    }
    for (let i = 0; i < 6; i += 1) {
      if ((quest.requiredItemId[i] ?? 0) === 0) {
        continue;
      }
      if ((aq.item[i] ?? 0) < (quest.requiredItemCount[i] ?? 0)) {
        return false;
      }
    }
    if (aq.playerCount < quest.requiredPlayerKills) {
      return false;
    }
    if ((quest.specialFlags & QUEST_SPECIAL_EXPLORATION) !== 0 && aq.explored !== 1) {
      return false;
    }
    return true;
  }

  private creditCreatureOrGo(
    requiredMatch: number,
    guid: bigint,
    mode: "kill" | "go",
  ): Credit[] {
    const credits: Credit[] = [];
    for (const [questId, aq] of this.activeQuests) {
      if (aq.status !== QUEST_STATUS_INCOMPLETE) {
        continue;
      }
      const quest = this.catalog.quest(questId);
      if (!quest) {
        continue;
      }
      for (let j = 0; j < 4; j += 1) {
        const requiredId = quest.requiredNpcOrGo[j] ?? 0;
        if (mode === "kill" && !(requiredId > 0 && requiredId === requiredMatch)) {
          continue;
        }
        if (mode === "go" && requiredId !== requiredMatch) {
          continue;
        }
        const required = quest.requiredNpcOrGoCount[j] ?? 0;
        const current = aq.mob[j] ?? 0;
        if (current >= required) {
          continue;
        }
        aq.mob[j] = current + 1;
        const done = this.objectivesMet(quest, aq);
        if (done) {
          aq.status = QUEST_STATUS_COMPLETE;
        }
        const entry =
          mode === "go" ? Math.abs(requiredMatch) : requiredMatch;
        credits.push({
          questId,
          entry,
          count: aq.mob[j]!,
          required,
          guid,
          done,
        });
        break;
      }
    }
    return credits;
  }

  private rebuildSlots(): void {
    this.slots.fill(0);
    let index = 0;
    for (const questId of this.activeQuests.keys()) {
      if (index >= QUEST_LOG_SLOT_COUNT) {
        break;
      }
      this.slots[index] = questId;
      index += 1;
    }
  }

  private occupy(questId: number): void {
    if (this.slots.includes(questId)) {
      return;
    }
    const index = this.slots.indexOf(0);
    if (index >= 0) {
      this.slots[index] = questId;
    }
  }

  private vacate(questId: number): void {
    const index = this.slots.indexOf(questId);
    if (index >= 0) {
      this.slots[index] = 0;
    }
  }
}

export function questLogValues(
  slots: readonly number[],
  active: ReadonlyMap<number, ActiveQuest>,
): { index: number; value: number }[] {
  const values: { index: number; value: number }[] = [];
  for (let slot = 0; slot < QUEST_LOG_SLOT_COUNT; slot += 1) {
    const questId = slots[slot] ?? 0;
    const aq = questId === 0 ? undefined : active.get(questId);
    const base = QUEST_LOG_INDEX + slot * QUEST_LOG_SLOT_SIZE;
    if (!aq) {
      for (let offset = 0; offset < QUEST_LOG_SLOT_SIZE; offset += 1) {
        values.push({ index: base + offset, value: 0 });
      }
      continue;
    }
    values.push({ index: base, value: questId });
    let state = 0;
    if (aq.status === QUEST_STATUS_COMPLETE) {
      state = 0x0001;
    } else if (aq.status === QUEST_STATUS_FAILED) {
      state = 0x0002;
    }
    values.push({ index: base + 1, value: state });
    values.push({
      index: base + 2,
      value: (aq.mob[0]! & 0xffff) | ((aq.mob[1]! & 0xffff) << 16),
    });
    values.push({
      index: base + 3,
      value: (aq.mob[2]! & 0xffff) | ((aq.mob[3]! & 0xffff) << 16),
    });
    values.push({ index: base + 4, value: aq.timer });
  }
  return values;
}

export function buildQuestGiverStatus(guid: bigint, status: number): Uint8Array {
  return new ByteWriter().writeU64(guid).writeU8(status).toUint8Array();
}

export function buildQuestConfirmAccept(questId: number, title: string, playerGuid: bigint): Uint8Array {
  return new ByteWriter().writeU32(questId).writeCString(title).writeU64(playerGuid).toUint8Array();
}

export function buildQuestPushResult(playerGuid: bigint, message: number): Uint8Array {
  return new ByteWriter().writeU64(playerGuid).writeU8(message).toUint8Array();
}

export function buildQuestGiverStatusMultiple(entries: { guid: bigint; status: number }[]): Uint8Array {
  const writer = new ByteWriter().writeU32(entries.length);
  for (const entry of entries) {
    writer.writeU64(entry.guid).writeU8(entry.status);
  }
  return writer.toUint8Array();
}

export function buildQuestGiverQuestList(
  guid: bigint,
  greeting: string,
  quests: QuestMenuEntry[],
): Uint8Array {
  const writer = new ByteWriter()
    .writeU64(guid)
    .writeCString(greeting)
    .writeU32(0)
    .writeU32(0)
    .writeU8(quests.length);
  for (const quest of quests) {
    writer
      .writeU32(quest.questId)
      .writeU32(quest.icon)
      .writeU32(quest.level | 0)
      .writeU32(quest.flags)
      .writeU8(quest.repeatable ? 1 : 0)
      .writeCString(quest.title);
  }
  return writer.toUint8Array();
}

export function buildQuestGiverQuestDetails(
  guid: bigint,
  quest: QuestTemplate,
  playerLevel: number,
  catalog: QuestCatalog,
  displayOf: (itemId: number) => number = () => 0,
  activateAccept = true,
  divider: bigint = 0n,
): Uint8Array {
  const writer = new ByteWriter()
    .writeU64(guid)
    .writeU64(divider)
    .writeU32(quest.id)
    .writeCString(quest.logTitle)
    .writeCString(quest.questDescription)
    .writeCString(quest.logDescription)
    .writeU8(activateAccept ? 1 : 0)
    .writeU32(quest.flags)
    .writeU32(quest.suggestedGroupNum)
    .writeU8(0);

  if (quest.flags & QUEST_FLAGS_HIDDEN_REWARDS) {
    writer.writeU32(0).writeU32(0).writeU32(0).writeU32(0);
  } else {
    writer.writeU32(choiceCount(quest));
    for (let i = 0; i < 6; i += 1) {
      const id = quest.rewardChoiceItemId[i] ?? 0;
      if (!id) {
        continue;
      }
      writer
        .writeU32(id)
        .writeU32(quest.rewardChoiceItemQuantity[i] ?? 0)
        .writeU32(displayOf(id));
    }
    writer.writeU32(rewardItemCount(quest));
    for (let i = 0; i < 4; i += 1) {
      const id = quest.rewardItem[i] ?? 0;
      if (!id) {
        continue;
      }
      writer
        .writeU32(id)
        .writeU32(quest.rewardAmount[i] ?? 0)
        .writeU32(displayOf(id));
    }
    const money = getRewOrReqMoney(quest, playerLevel, catalog.moneyByLevel);
    writer.writeU32(money < 0 ? 0 : money);
    writer.writeU32(questXPValue(quest, playerLevel, catalog.xpByLevel));
  }

  writer.writeU32(10 * quest.rewardHonor);
  writer.writeF32(0);
  writer.writeU32(quest.rewardDisplaySpell);
  writeI32(writer, quest.rewardSpell);
  writer.writeU32(quest.rewardTitle);
  writer.writeU32(quest.rewardTalents);
  writer.writeU32(quest.rewardArenaPoints);
  writer.writeU32(0);
  for (let i = 0; i < 5; i += 1) {
    writer.writeU32(quest.rewardFactionId[i] ?? 0);
  }
  for (let i = 0; i < 5; i += 1) {
    writeI32(writer, quest.rewardFactionValue[i] ?? 0);
  }
  for (let i = 0; i < 5; i += 1) {
    writeI32(writer, quest.rewardFactionOverride[i] ?? 0);
  }
  writer.writeU32(4);
  for (let i = 0; i < 4; i += 1) {
    writer.writeU32(quest.detailsEmote[i] ?? 0);
    writer.writeU32(quest.detailsEmoteDelay[i] ?? 0);
  }
  return writer.toUint8Array();
}

export function buildQuestGiverRequestItems(
  guid: bigint,
  quest: QuestTemplate,
  canComplete: boolean,
  playerLevel = 0,
  catalog?: QuestCatalog,
  closeOnCancel = true,
): Uint8Array | null {
  if (requiredItemObjectiveCount(quest) === 0 && canComplete) {
    return null;
  }
  const moneyTable = catalog?.moneyByLevel ?? new Map<number, number[]>();
  const money = getRewOrReqMoney(quest, playerLevel, moneyTable);
  const writer = new ByteWriter()
    .writeU64(guid)
    .writeU32(quest.id)
    .writeCString(quest.logTitle)
    .writeCString(quest.completionText)
    .writeU32(0)
    .writeU32(canComplete ? quest.emoteOnComplete : quest.emoteOnIncomplete)
    .writeU32(closeOnCancel ? 1 : 0)
    .writeU32(quest.flags)
    .writeU32(quest.suggestedGroupNum)
    .writeU32(money < 0 ? -money : 0)
    .writeU32(requiredItemObjectiveCount(quest));
  for (let i = 0; i < 6; i += 1) {
    const id = quest.requiredItemId[i] ?? 0;
    if (!id) {
      continue;
    }
    writer.writeU32(id).writeU32(quest.requiredItemCount[i] ?? 0).writeU32(0);
  }
  writer.writeU32(canComplete ? 3 : 0).writeU32(4).writeU32(8).writeU32(0x10);
  return writer.toUint8Array();
}

export function buildQuestGiverOfferReward(
  guid: bigint,
  quest: QuestTemplate,
  playerLevel: number,
  catalog: QuestCatalog,
  displayOf: (itemId: number) => number = () => 0,
  enableNext = true,
): Uint8Array {
  const writer = new ByteWriter()
    .writeU64(guid)
    .writeU32(quest.id)
    .writeCString(quest.logTitle)
    .writeCString(quest.rewardText)
    .writeU8(enableNext ? 1 : 0)
    .writeU32(quest.flags)
    .writeU32(quest.suggestedGroupNum);

  let emoteCount = 0;
  for (let i = 0; i < 4; i += 1) {
    if ((quest.offerEmote[i] ?? 0) <= 0) {
      break;
    }
    emoteCount += 1;
  }
  writer.writeU32(emoteCount);
  for (let i = 0; i < emoteCount; i += 1) {
    writer.writeU32(quest.offerEmoteDelay[i] ?? 0);
    writer.writeU32(quest.offerEmote[i] ?? 0);
  }

  if (quest.flags & QUEST_FLAGS_HIDDEN_REWARDS) {
    writer.writeU32(0).writeU32(0).writeU32(0).writeU32(0);
  } else {
    writer.writeU32(choiceCount(quest));
    for (let i = 0; i < 6; i += 1) {
      const id = quest.rewardChoiceItemId[i] ?? 0;
      if (!id) {
        continue;
      }
      writer
        .writeU32(id)
        .writeU32(quest.rewardChoiceItemQuantity[i] ?? 0)
        .writeU32(displayOf(id));
    }
    writer.writeU32(rewardItemCount(quest));
    for (let i = 0; i < 4; i += 1) {
      const id = quest.rewardItem[i] ?? 0;
      if (!id) {
        continue;
      }
      writer
        .writeU32(id)
        .writeU32(quest.rewardAmount[i] ?? 0)
        .writeU32(displayOf(id));
    }
    const money = getRewOrReqMoney(quest, playerLevel, catalog.moneyByLevel);
    writer.writeU32(money < 0 ? 0 : money);
    writer.writeU32(questXPValue(quest, playerLevel, catalog.xpByLevel));
  }

  writer.writeU32(10 * quest.rewardHonor);
  writer.writeF32(0);
  writer.writeU32(0x08);
  writer.writeU32(quest.rewardDisplaySpell);
  writeI32(writer, quest.rewardSpell);
  writer.writeU32(quest.rewardTitle);
  writer.writeU32(quest.rewardTalents);
  writer.writeU32(quest.rewardArenaPoints);
  writer.writeU32(0);
  for (let i = 0; i < 5; i += 1) {
    writer.writeU32(quest.rewardFactionId[i] ?? 0);
  }
  for (let i = 0; i < 5; i += 1) {
    writeI32(writer, quest.rewardFactionValue[i] ?? 0);
  }
  for (let i = 0; i < 5; i += 1) {
    writer.writeU32((quest.rewardFactionOverride[i] ?? 0) >>> 0);
  }
  return writer.toUint8Array();
}

export function buildQuestGiverQuestComplete(result: {
  questId: number;
  xp: number;
  money: number;
  honor: number;
  talents: number;
  arena: number;
}): Uint8Array {
  return new ByteWriter()
    .writeU32(result.questId)
    .writeU32(result.xp)
    .writeU32(result.money > 0 ? result.money : 0)
    .writeU32(result.honor)
    .writeU32(result.talents)
    .writeU32(result.arena)
    .toUint8Array();
}

export function buildQuestUpdateComplete(questId: number): Uint8Array {
  return new ByteWriter().writeU32(questId).toUint8Array();
}

export function buildQuestUpdateAddKill(
  questId: number,
  creatureEntry: number,
  count: number,
  required: number,
  guid: bigint,
): Uint8Array {
  return new ByteWriter()
    .writeU32(questId)
    .writeU32(creatureEntry >>> 0)
    .writeU32(count)
    .writeU32(required)
    .writeU64(guid)
    .toUint8Array();
}

export function buildQuestQueryResponse(
  quest: QuestTemplate,
  playerLevel: number,
  catalog: QuestCatalog,
): Uint8Array {
  const writer = new ByteWriter();
  writer.writeU32(quest.id);
  writer.writeU32(quest.questType);
  writer.writeU32(quest.questLevel | 0);
  writer.writeU32(quest.minLevel);
  writeI32(writer, quest.questSortId);
  writer.writeU32(quest.questInfoId);
  writer.writeU32(quest.suggestedGroupNum);
  writer.writeU32(quest.requiredFactionId[0] ?? 0);
  writeI32(writer, quest.requiredFactionValue[0] ?? 0);
  writer.writeU32(quest.requiredFactionId[1] ?? 0);
  writeI32(writer, quest.requiredFactionValue[1] ?? 0);
  writer.writeU32(quest.rewardNextQuest);
  writer.writeU32(quest.rewardXPDifficulty);

  if (quest.flags & QUEST_FLAGS_HIDDEN_REWARDS) {
    writer.writeU32(0);
  } else {
    const money = getRewOrReqMoney(quest, playerLevel, catalog.moneyByLevel);
    writeI32(writer, money);
  }

  writer.writeU32(0); // RewardMoneyMaxLevel skipped
  writer.writeU32(quest.rewardDisplaySpell);
  writeI32(writer, quest.rewardSpell);
  writer.writeU32(quest.rewardHonor);
  writer.writeF32(quest.rewardKillHonor);
  writer.writeU32(quest.startItem);
  writer.writeU32(quest.flags & 0xffff);
  writer.writeU32(quest.rewardTitle);
  writer.writeU32(quest.requiredPlayerKills);
  writer.writeU32(quest.rewardTalents);
  writer.writeU32(quest.rewardArenaPoints);
  writer.writeU32(0);

  if (quest.flags & QUEST_FLAGS_HIDDEN_REWARDS) {
    for (let i = 0; i < 4; i += 1) {
      writer.writeU32(0).writeU32(0);
    }
    for (let i = 0; i < 6; i += 1) {
      writer.writeU32(0).writeU32(0);
    }
  } else {
    for (let i = 0; i < 4; i += 1) {
      writer.writeU32(quest.rewardItem[i] ?? 0).writeU32(quest.rewardAmount[i] ?? 0);
    }
    for (let i = 0; i < 6; i += 1) {
      writer
        .writeU32(quest.rewardChoiceItemId[i] ?? 0)
        .writeU32(quest.rewardChoiceItemQuantity[i] ?? 0);
    }
  }

  for (let i = 0; i < 5; i += 1) {
    writer.writeU32(quest.rewardFactionId[i] ?? 0);
  }
  for (let i = 0; i < 5; i += 1) {
    writeI32(writer, quest.rewardFactionValue[i] ?? 0);
  }
  for (let i = 0; i < 5; i += 1) {
    writeI32(writer, quest.rewardFactionOverride[i] ?? 0);
  }

  writer.writeU32(quest.poiContinent);
  writer.writeF32(quest.poiX);
  writer.writeF32(quest.poiY);
  writer.writeU32(quest.poiPriority);
  writer.writeCString(quest.logTitle);
  writer.writeCString(quest.logDescription);
  writer.writeCString(quest.questDescription);
  writer.writeCString(quest.areaDescription);
  writer.writeCString(quest.questCompletionLog);

  for (let i = 0; i < 4; i += 1) {
    writer.writeU32(npcOrGoPacketId(quest.requiredNpcOrGo[i] ?? 0));
    writer.writeU32(quest.requiredNpcOrGoCount[i] ?? 0);
    writer.writeU32(quest.itemDrop[i] ?? 0);
    writer.writeU32(0);
  }
  for (let i = 0; i < 6; i += 1) {
    writer.writeU32(quest.requiredItemId[i] ?? 0);
    writer.writeU32(quest.requiredItemCount[i] ?? 0);
  }
  for (let i = 0; i < 4; i += 1) {
    writer.writeCString(quest.objectiveText[i] ?? "");
  }
  return writer.toUint8Array();
}

export function buildQuestPoiQueryResponse(
  questIds: number[],
  log: QuestLog,
  catalog: QuestCatalog,
): Uint8Array {
  const writer = new ByteWriter().writeU32(questIds.length);
  for (const questId of questIds) {
    writer.writeU32(questId);
    if (!log.active().has(questId)) {
      writer.writeU32(0);
      continue;
    }
    const pois = catalog.poi(questId);
    writer.writeU32(pois.length);
    for (const poi of pois) {
      writer.writeU32(poi.id);
      writeI32(writer, poi.objectiveIndex);
      writer.writeU32(poi.mapId);
      writer.writeU32(poi.worldMapAreaId);
      writer.writeU32(poi.floor);
      writer.writeU32(poi.priority);
      writer.writeU32(poi.flags);
      writer.writeU32(poi.points.length);
      for (const point of poi.points) {
        writeI32(writer, point.x);
        writeI32(writer, point.y);
      }
    }
  }
  return writer.toUint8Array();
}
