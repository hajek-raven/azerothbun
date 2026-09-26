import { Database } from "bun:sqlite";
import type { CharacterLoginKit } from "../characters/store.ts";
import { creatureFlags, type WorldData } from "../data/world.ts";
import type { Character } from "../db.ts";
import { log } from "../log.ts";
import { ByteReader, ByteWriter } from "../net/byte-buffer.ts";
import {
  binderConfirm,
  CMSG_GAMEOBJ_USE,
  CMSG_GOSSIP_HELLO,
  CMSG_GOSSIP_SELECT_OPTION,
  CMSG_NPC_TEXT_QUERY,
  CMSG_QUESTGIVER_HELLO,
  emptyVendorList,
  GOSSIP_OPTION,
  gossipComplete,
  gossipMessage,
  gossipPoi,
  GossipCatalog,
  helloAllowed,
  npcTextUpdate,
  SMSG_BINDER_CONFIRM,
  SMSG_GOSSIP_COMPLETE,
  SMSG_GOSSIP_MESSAGE,
  SMSG_GOSSIP_POI,
  SMSG_LIST_INVENTORY,
  SMSG_NPC_TEXT_UPDATE,
  type QuestStateView,
  type Speaker,
} from "./gossip.ts";
import { SMSG_UPDATE_OBJECT } from "./packets.ts";
import { inGroupRewardRange, QuestParty, type SharePeer } from "./party.ts";
import {
  buildQuestConfirmAccept,
  buildQuestGiverOfferReward,
  buildQuestGiverQuestComplete,
  buildQuestGiverQuestDetails,
  buildQuestGiverQuestList,
  buildQuestGiverRequestItems,
  buildQuestGiverStatus,
  buildQuestGiverStatusMultiple,
  buildQuestPoiQueryResponse,
  buildQuestPushResult,
  buildQuestQueryResponse,
  buildQuestUpdateAddKill,
  buildQuestUpdateComplete,
  CMSG_PUSHQUESTTOPARTY,
  CMSG_QUEST_CONFIRM_ACCEPT,
  CMSG_QUEST_POI_QUERY,
  CMSG_QUEST_QUERY,
  CMSG_QUESTGIVER_ACCEPT_QUEST,
  CMSG_QUESTGIVER_CANCEL,
  CMSG_QUESTGIVER_CHOOSE_REWARD,
  CMSG_QUESTGIVER_COMPLETE_QUEST,
  CMSG_QUESTGIVER_QUERY_QUEST,
  CMSG_QUESTGIVER_QUEST_AUTOLAUNCH,
  CMSG_QUESTGIVER_REQUEST_REWARD,
  CMSG_QUESTGIVER_STATUS_MULTIPLE_QUERY,
  CMSG_QUESTGIVER_STATUS_QUERY,
  CMSG_QUESTLOG_REMOVE_QUEST,
  CMSG_QUESTLOG_SWAP_QUEST,
  getRewOrReqMoney,
  MSG_QUEST_PUSH_RESULT,
  QUEST_FLAGS_AUTO_ACCEPT,
  QUEST_FLAGS_AUTOCOMPLETE,
  QUEST_FLAGS_PARTY_ACCEPT,
  QUEST_LOG_SLOT_COUNT,
  QUEST_PARTY_MSG_ACCEPT_QUEST,
  QUEST_PARTY_MSG_BUSY,
  QUEST_PARTY_MSG_CANT_TAKE_QUEST,
  QUEST_PARTY_MSG_FINISH_QUEST,
  QUEST_PARTY_MSG_HAVE_QUEST,
  QUEST_PARTY_MSG_LOG_FULL,
  QUEST_PARTY_MSG_SHARING_QUEST,
  QUEST_SPECIAL_AUTO_ACCEPT,
  QUEST_STATUS_COMPLETE,
  QUEST_STATUS_INCOMPLETE,
  QUEST_STATUS_NONE,
  QuestCatalog,
  QuestLog,
  questLogValues,
  SMSG_QUEST_CONFIRM_ACCEPT,
  SMSG_QUEST_POI_QUERY_RESPONSE,
  SMSG_QUEST_QUERY_RESPONSE,
  SMSG_QUESTGIVER_OFFER_REWARD,
  SMSG_QUESTGIVER_QUEST_COMPLETE,
  SMSG_QUESTGIVER_QUEST_DETAILS,
  SMSG_QUESTGIVER_QUEST_LIST,
  SMSG_QUESTGIVER_REQUEST_ITEMS,
  SMSG_QUESTGIVER_STATUS,
  SMSG_QUESTGIVER_STATUS_MULTIPLE,
  SMSG_QUESTLOG_FULL,
  SMSG_QUESTUPDATE_ADD_KILL,
  SMSG_QUESTUPDATE_COMPLETE,
  type Credit,
  type QuestMenuEntry,
  type QuestTemplate,
} from "./quests.ts";
import {
  fieldUpdateBlock,
  PLAYER_FIELD_COINAGE,
  PLAYER_NEXT_LEVEL_XP,
  PLAYER_XP,
  UNIT_FIELD_LEVEL,
} from "./update-object.ts";

const HIGH_UNIT = 0xf130n;
const HIGH_GAMEOBJECT = 0xf110n;
const NO_GOSSIP_TEXT = 0xffffff;
const CMSG_BINDER_ACTIVATE = 0x1b5;
const SMSG_LEARNED_SPELL = 0x12b;
const NPC_GOSSIP = 1;
const NPC_QUESTGIVER = 2;

const XP_TO_NEXT = [0, 400, 900, 1400, 2100, 2800, 3600, 4500, 5400, 6500, 7600];

export type TalkPacket = { opcode: number; name: string; body: Uint8Array };

export type TalkData = { gossip: GossipCatalog; quests: QuestCatalog };

const sharedTalk = new WeakMap<WorldData, TalkData>();

export function talkDataFor(world: WorldData): TalkData {
  const found = sharedTalk.get(world);
  if (found) {
    return found;
  }
  const db = typeof world.database === "function" ? world.database() : new Database(":memory:");
  const created = { gossip: new GossipCatalog(db), quests: new QuestCatalog(db) };
  sharedTalk.set(world, created);
  return created;
}

type OpenTarget = {
  guid: bigint;
  kind: "creature" | "gameobject";
  entry: number;
  npcFlags: number;
  menuId: number;
  name: string;
};

export class Talk {
  readonly quests: QuestLog;
  private target: OpenTarget | null = null;
  private menuId = 0;
  private divider = 0n;

  constructor(
    private readonly gossip: GossipCatalog,
    catalog: QuestCatalog,
    private readonly world: WorldData,
    private readonly party: QuestParty | null = null,
  ) {
    this.quests = new QuestLog(catalog);
  }

  dividerGuid(): bigint {
    return this.divider;
  }

  setDivider(guid: bigint): void {
    this.divider = guid;
  }

  acceptShared(player: Character, questId: number): TalkPacket[] {
    this.syncSpeaker(player);
    if (this.quests.accept(questId) !== "ok") {
      return [];
    }
    return [this.progress(player, true)];
  }

  get catalog(): QuestCatalog {
    return this.quests.source();
  }

  login(db: Database, player: Character): void {
    this.syncSpeaker(player);
    this.quests.load(db, player.guid);
  }

  save(db: Database, guid: number): void {
    this.quests.save(db, guid);
  }

  loginUpdate(player: Character): TalkPacket[] {
    if (this.quests.active().size === 0) {
      return [];
    }
    return [this.progress(player, true)];
  }

  handle(
    opcode: number,
    payload: Uint8Array,
    player: Character,
    kit: CharacterLoginKit,
    known: ReadonlySet<bigint>,
  ): TalkPacket[] | null {
    this.syncSpeaker(player);
    switch (opcode) {
      case CMSG_GOSSIP_HELLO:
        return this.hello(payload, player, true);
      case CMSG_QUESTGIVER_HELLO:
      case CMSG_GAMEOBJ_USE:
        return this.hello(payload, player, false);
      case CMSG_GOSSIP_SELECT_OPTION:
        return this.select(payload, player, kit);
      case CMSG_NPC_TEXT_QUERY:
        return this.npcText(payload, player);
      case CMSG_QUESTGIVER_STATUS_QUERY:
        return this.statusQuery(payload);
      case CMSG_QUESTGIVER_STATUS_MULTIPLE_QUERY:
        return this.statusMultiple(known);
      case CMSG_QUESTGIVER_QUERY_QUEST:
        return this.queryQuest(payload, player);
      case CMSG_QUESTGIVER_QUEST_AUTOLAUNCH:
        return [];
      case CMSG_QUESTGIVER_ACCEPT_QUEST:
        return this.accept(payload, player);
      case CMSG_QUESTGIVER_COMPLETE_QUEST:
        return this.complete(payload, player);
      case CMSG_QUESTGIVER_REQUEST_REWARD:
        return this.requestReward(payload, player);
      case CMSG_QUESTGIVER_CHOOSE_REWARD:
        return this.chooseReward(payload, player, kit);
      case CMSG_QUESTGIVER_CANCEL:
        return [packet(SMSG_GOSSIP_COMPLETE, "SMSG_GOSSIP_COMPLETE", gossipComplete())];
      case CMSG_QUESTLOG_SWAP_QUEST:
        return this.swapQuest(payload, player);
      case CMSG_QUEST_CONFIRM_ACCEPT:
        return this.confirmAccept(payload, player);
      case CMSG_PUSHQUESTTOPARTY:
        return this.pushToParty(payload, player);
      case MSG_QUEST_PUSH_RESULT:
        return this.pushResult(payload, player);
      case CMSG_QUESTLOG_REMOVE_QUEST:
        return this.abandon(payload, player);
      case CMSG_QUEST_QUERY:
        return this.questQuery(payload, player);
      case CMSG_QUEST_POI_QUERY:
        return this.poiQuery(payload);
      case CMSG_BINDER_ACTIVATE:
        return this.bind(player, kit);
      default:
        return null;
    }
  }

  private hello(payload: Uint8Array, player: Character, checkHello: boolean): TalkPacket[] {
    if (payload.length < 8) {
      return [];
    }
    const guid = new ByteReader(payload).readU64();
    const target = this.resolve(guid);
    if (!target) {
      return [packet(SMSG_GOSSIP_COMPLETE, "SMSG_GOSSIP_COMPLETE", gossipComplete())];
    }
    if (checkHello && target.kind === "creature" && !helloAllowed(this.gossip, target.entry, speakerOf(player), this.view())) {
      return [packet(SMSG_GOSSIP_COMPLETE, "SMSG_GOSSIP_COMPLETE", gossipComplete())];
    }
    const credits =
      target.kind === "creature"
        ? this.quests.creditTalk(target.entry).map((credit) => ({ ...credit, guid: target.guid }))
        : [];
    this.target = target;
    return [...creditUpdate(credits, player, this.quests), ...this.openMenu(target, player)];
  }

  private openMenu(target: OpenTarget, player: Character): TalkPacket[] {
    const speaker = speakerOf(player);
    const view = this.view();
    let menuId = target.menuId;
    let options = this.gossip.options(menuId, target.npcFlags, speaker, view);
    let textId = this.gossip.textId(menuId, speaker, view);
    if (options.length === 0 && menuId !== 0) {
      const fallback = this.gossip.options(0, target.npcFlags, speaker, view);
      if (fallback.length > 0) {
        options = fallback;
        if (textId === NO_GOSSIP_TEXT) {
          textId = this.gossip.textId(0, speaker, view);
        }
        menuId = 0;
      }
    }
    this.menuId = menuId;
    const quests = this.quests.menu(target.kind, target.entry);
    if (options.length === 0 && quests.length === 0 && textId === NO_GOSSIP_TEXT) {
      return [packet(SMSG_GOSSIP_COMPLETE, "SMSG_GOSSIP_COMPLETE", gossipComplete())];
    }
    if (options.length === 0 && quests.length > 0) {
      return this.preparedQuests(target, quests, player);
    }
    if ((target.npcFlags & NPC_GOSSIP) === 0 && options.length === 0 && quests.length > 0) {
      return this.preparedQuests(target, quests, player);
    }
    return [
      packet(
        SMSG_GOSSIP_MESSAGE,
        "SMSG_GOSSIP_MESSAGE",
        gossipMessage(target.guid, menuId, textId, options, quests),
      ),
    ];
  }

  private preparedQuests(target: OpenTarget, quests: QuestMenuEntry[], player: Character): TalkPacket[] {
    if (quests.length === 1) {
      const only = quests[0];
      if (!only) {
        return [packet(SMSG_GOSSIP_COMPLETE, "SMSG_GOSSIP_COMPLETE", gossipComplete())];
      }
      return this.questWindow(target.guid, only.questId, player, only.icon === 4);
    }
    return [
      packet(
        SMSG_QUESTGIVER_QUEST_LIST,
        "SMSG_QUESTGIVER_QUEST_LIST",
        buildQuestGiverQuestList(target.guid, target.name, quests),
      ),
    ];
  }

  private questWindow(guid: bigint, questId: number, player: Character, progress: boolean, closeOnCancel = true): TalkPacket[] {
    const quest = this.catalog.quest(questId);
    if (!quest) {
      return [packet(SMSG_GOSSIP_COMPLETE, "SMSG_GOSSIP_COMPLETE", gossipComplete())];
    }
    if (progress || isAutoComplete(quest)) {
      const canComplete = this.quests.status(questId) === QUEST_STATUS_COMPLETE || (isAutoComplete(quest) && this.quests.status(questId) !== QUEST_STATUS_INCOMPLETE);
      const request = buildQuestGiverRequestItems(guid, quest, canComplete, player.level, this.catalog, closeOnCancel);
      if (request) {
        return [packet(SMSG_QUESTGIVER_REQUEST_ITEMS, "SMSG_QUESTGIVER_REQUEST_ITEMS", request)];
      }
      if (canComplete) {
        return [this.offerReward(guid, quest, player)];
      }
    }
    return [this.details(guid, quest, player)];
  }

  private details(
    guid: bigint,
    quest: NonNullable<ReturnType<QuestCatalog["quest"]>>,
    player: Character,
    divider: bigint = 0n,
    level = player.level,
  ): TalkPacket {
    return packet(
      SMSG_QUESTGIVER_QUEST_DETAILS,
      "SMSG_QUESTGIVER_QUEST_DETAILS",
      buildQuestGiverQuestDetails(guid, quest, level, this.catalog, (itemId) => this.display(itemId), true, divider),
    );
  }

  private offerReward(guid: bigint, quest: NonNullable<ReturnType<QuestCatalog["quest"]>>, player: Character): TalkPacket {
    return packet(
      SMSG_QUESTGIVER_OFFER_REWARD,
      "SMSG_QUESTGIVER_OFFER_REWARD",
      buildQuestGiverOfferReward(guid, quest, player.level, this.catalog, (itemId) => this.display(itemId)),
    );
  }

  private offers(target: OpenTarget, questId: number): boolean {
    return (
      this.catalog.starters(target.kind, target.entry).includes(questId) ||
      this.catalog.enders(target.kind, target.entry).includes(questId)
    );
  }

  private select(payload: Uint8Array, player: Character, kit: CharacterLoginKit): TalkPacket[] {
    if (payload.length < 16) {
      return [];
    }
    const reader = new ByteReader(payload);
    const guid = reader.readU64();
    const menuId = reader.readU32();
    const optionId = reader.readU32();
    const target = this.resolve(guid) ?? this.target;
    if (!target) {
      return [packet(SMSG_GOSSIP_COMPLETE, "SMSG_GOSSIP_COMPLETE", gossipComplete())];
    }
    this.target = target;
    const option = this.gossip
      .options(menuId, target.npcFlags, speakerOf(player), this.view())
      .find((row) => row.optionId === optionId);
    if (!option) {
      return [packet(SMSG_GOSSIP_COMPLETE, "SMSG_GOSSIP_COMPLETE", gossipComplete())];
    }
    if (option.boxMoney > 0) {
      if (player.money < option.boxMoney) {
        return [packet(SMSG_GOSSIP_COMPLETE, "SMSG_GOSSIP_COMPLETE", gossipComplete())];
      }
      player.money -= option.boxMoney;
    }
    return this.applyOption(option.type, option.actionMenuId, option.actionPoiId, target, player, kit);
  }

  private applyOption(
    type: number,
    actionMenuId: number,
    actionPoiId: number,
    target: OpenTarget,
    player: Character,
    _kit: CharacterLoginKit,
  ): TalkPacket[] {
    switch (type) {
      case GOSSIP_OPTION.GOSSIP:
      case GOSSIP_OPTION.DUALSPEC_INFO: {
        const packets: TalkPacket[] = [];
        const poi = actionPoiId > 0 ? this.gossip.pointOfInterest(actionPoiId) : null;
        if (poi) {
          packets.push(packet(SMSG_GOSSIP_POI, "SMSG_GOSSIP_POI", gossipPoi(poi)));
        }
        if (actionMenuId > 0) {
          target.menuId = actionMenuId;
          packets.push(...this.openMenu(target, player));
          return packets;
        }
        packets.push(packet(SMSG_GOSSIP_COMPLETE, "SMSG_GOSSIP_COMPLETE", gossipComplete()));
        return packets;
      }
      case GOSSIP_OPTION.QUESTGIVER:
        return this.preparedQuests(target, this.quests.menu(target.kind, target.entry), player);
      case GOSSIP_OPTION.VENDOR:
      case GOSSIP_OPTION.ARMORER:
        return [packet(SMSG_LIST_INVENTORY, "SMSG_LIST_INVENTORY", emptyVendorList(target.guid))];
      case GOSSIP_OPTION.INNKEEPER:
        return [
          packet(SMSG_GOSSIP_COMPLETE, "SMSG_GOSSIP_COMPLETE", gossipComplete()),
          packet(SMSG_BINDER_CONFIRM, "SMSG_BINDER_CONFIRM", binderConfirm(target.guid)),
        ];
      case GOSSIP_OPTION.TAXIVENDOR:
      case GOSSIP_OPTION.TRAINER:
      case GOSSIP_OPTION.SPIRITHEALER:
      case GOSSIP_OPTION.BANKER:
      case GOSSIP_OPTION.PETITIONER:
      case GOSSIP_OPTION.TABARDDESIGNER:
      case GOSSIP_OPTION.BATTLEFIELD:
      case GOSSIP_OPTION.AUCTIONEER:
      case GOSSIP_OPTION.STABLEPET:
      case GOSSIP_OPTION.UNLEARNTALENTS:
      case GOSSIP_OPTION.UNLEARNPETTALENTS:
      case GOSSIP_OPTION.LEARNDUALSPEC:
      case GOSSIP_OPTION.OUTDOORPVP:
        return [packet(SMSG_GOSSIP_COMPLETE, "SMSG_GOSSIP_COMPLETE", gossipComplete())];
      default:
        return [packet(SMSG_GOSSIP_COMPLETE, "SMSG_GOSSIP_COMPLETE", gossipComplete())];
    }
  }

  private npcText(payload: Uint8Array, player: Character): TalkPacket[] {
    if (payload.length < 4) {
      return [];
    }
    const textId = new ByteReader(payload).readU32();
    return [
      packet(
        SMSG_NPC_TEXT_UPDATE,
        "SMSG_NPC_TEXT_UPDATE",
        npcTextUpdate(textId, this.gossip.npcText(textId, player.gender)),
      ),
    ];
  }

  private statusQuery(payload: Uint8Array): TalkPacket[] {
    if (payload.length < 8) {
      return [];
    }
    const guid = new ByteReader(payload).readU64();
    const target = this.resolve(guid);
    const status = target ? this.quests.dialogStatus(target.kind, target.entry) : 0;
    return [packet(SMSG_QUESTGIVER_STATUS, "SMSG_QUESTGIVER_STATUS", buildQuestGiverStatus(guid, status))];
  }

  private statusMultiple(known: ReadonlySet<bigint>): TalkPacket[] {
    const entries: { guid: bigint; status: number }[] = [];
    for (const guid of known) {
      const target = this.resolve(guid);
      if (!target) {
        continue;
      }
      const status = this.quests.dialogStatus(target.kind, target.entry);
      if (status !== 0) {
        entries.push({ guid, status });
      }
    }
    return [
      packet(SMSG_QUESTGIVER_STATUS_MULTIPLE, "SMSG_QUESTGIVER_STATUS_MULTIPLE", buildQuestGiverStatusMultiple(entries)),
    ];
  }

  private queryQuest(payload: Uint8Array, player: Character): TalkPacket[] {
    if (payload.length < 12) {
      return [];
    }
    const reader = new ByteReader(payload);
    const guid = reader.readU64();
    const questId = reader.readU32();
    const target = this.resolve(guid);
    if (!target || !this.offers(target, questId)) {
      return [packet(SMSG_GOSSIP_COMPLETE, "SMSG_GOSSIP_COMPLETE", gossipComplete())];
    }
    const quest = this.catalog.quest(questId);
    if (!quest) {
      return [packet(SMSG_GOSSIP_COMPLETE, "SMSG_GOSSIP_COMPLETE", gossipComplete())];
    }
    const status = this.quests.status(questId);
    if (status === QUEST_STATUS_NONE) {
      if (!this.quests.canTake(questId, this.quests.speaker)) {
        return [packet(SMSG_GOSSIP_COMPLETE, "SMSG_GOSSIP_COMPLETE", gossipComplete())];
      }
      if (isAutoAccept(quest)) {
        this.quests.accept(questId);
      }
    }
    const inLog = status === QUEST_STATUS_INCOMPLETE || status === QUEST_STATUS_COMPLETE || isAutoAccept(quest);
    return this.questWindow(guid, questId, player, inLog || isAutoComplete(quest));
  }

  private accept(payload: Uint8Array, player: Character): TalkPacket[] {
    if (payload.length < 12) {
      return [];
    }
    const reader = new ByteReader(payload);
    const guid = reader.readU64();
    const questId = reader.readU32();
    const close = [packet(SMSG_GOSSIP_COMPLETE, "SMSG_GOSSIP_COMPLETE", gossipComplete())];
    const target = this.resolve(guid);
    const giver = target ? null : this.party?.peer(Number(guid));
    if (target) {
      if (!this.catalog.starters(target.kind, target.entry).includes(questId)) {
        this.divider = 0n;
        return close;
      }
    } else if (!giver || giver.guid === player.guid || !giver.canShare(questId)) {
      this.divider = 0n;
      return close;
    }
    const quest = this.catalog.quest(questId);
    if (!target && quest && soldSource(quest, this.world)) {
      return [];
    }
    if (!this.quests.canTake(questId, this.quests.speaker)) {
      this.divider = 0n;
      return close;
    }
    if (this.divider !== 0n) {
      const sharer = this.party?.peer(Number(this.divider));
      sharer?.deliver([pushResult(BigInt(player.guid), QUEST_PARTY_MSG_ACCEPT_QUEST)]);
      this.divider = 0n;
    }
    const result = this.quests.accept(questId);
    if (result === "full") {
      return [packet(SMSG_QUESTLOG_FULL, "SMSG_QUESTLOG_FULL", new Uint8Array())];
    }
    if (result !== "ok") {
      return close;
    }
    if (quest?.startItem) {
      log("world", `quest ${questId} start item ${quest.startItem} waits for bags`);
    }
    if (quest && (quest.flags & QUEST_FLAGS_PARTY_ACCEPT) !== 0) {
      this.offerPartyAccept(player, quest);
    }
    return [close[0]!, this.progress(player, true)];
  }

  private swapQuest(payload: Uint8Array, player: Character): TalkPacket[] {
    if (payload.length < 2) {
      return [];
    }
    const reader = new ByteReader(payload);
    const slot1 = reader.readU8();
    const slot2 = reader.readU8();
    if (!this.quests.swap(slot1, slot2)) {
      return [];
    }
    return [this.progress(player, true)];
  }

  private confirmAccept(payload: Uint8Array, player: Character): TalkPacket[] {
    if (payload.length < 4) {
      return [];
    }
    const questId = new ByteReader(payload).readU32();
    const quest = this.catalog.quest(questId);
    if (!quest || (quest.flags & QUEST_FLAGS_PARTY_ACCEPT) === 0 || this.divider === 0n) {
      return [];
    }
    const sharer = this.party?.peer(Number(this.divider));
    if (!sharer || !this.party?.sameGroup(player.guid, sharer.guid)) {
      return [];
    }
    if (!inGroupRewardRange(placeOf(player), sharer.place())) {
      return [];
    }
    if (!this.quests.canTake(questId, this.quests.speaker) || soldSource(quest, this.world)) {
      return [];
    }
    this.divider = 0n;
    if (this.quests.accept(questId) !== "ok") {
      return [];
    }
    if (quest.startItem) {
      log("world", `quest ${questId} start item ${quest.startItem} waits for bags`);
    }
    return [this.progress(player, true)];
  }

  private pushToParty(payload: Uint8Array, player: Character): TalkPacket[] {
    if (payload.length < 4) {
      return [];
    }
    const questId = new ByteReader(payload).readU32();
    const quest = this.catalog.quest(questId);
    if (!quest || !this.quests.canShare(questId)) {
      return [];
    }
    const packets: TalkPacket[] = [];
    const sharerGuid = BigInt(player.guid);
    for (const member of this.party?.members(player.guid) ?? []) {
      if (member.place().map !== player.map) {
        continue;
      }
      if (member.status(questId) === QUEST_STATUS_COMPLETE) {
        packets.push(pushResult(BigInt(member.guid), QUEST_PARTY_MSG_FINISH_QUEST));
        continue;
      }
      if (member.status(questId) !== QUEST_STATUS_NONE) {
        packets.push(pushResult(BigInt(member.guid), QUEST_PARTY_MSG_HAVE_QUEST));
        continue;
      }
      if (!member.canTake(questId)) {
        packets.push(pushResult(BigInt(member.guid), QUEST_PARTY_MSG_CANT_TAKE_QUEST));
        continue;
      }
      if (member.logFull()) {
        packets.push(pushResult(BigInt(member.guid), QUEST_PARTY_MSG_LOG_FULL));
        continue;
      }
      if (member.divider() !== 0n) {
        packets.push(pushResult(BigInt(member.guid), QUEST_PARTY_MSG_BUSY));
        continue;
      }
      packets.push(pushResult(BigInt(member.guid), QUEST_PARTY_MSG_SHARING_QUEST));
      const taken = isAutoAccept(quest) && member.canTake(questId) ? member.acceptShared(questId) : [];
      member.deliver([...taken, this.shareWindow(member, quest, sharerGuid)]);
    }
    return packets;
  }

  private pushResult(payload: Uint8Array, player: Character): TalkPacket[] {
    if (payload.length < 13) {
      return [];
    }
    const reader = new ByteReader(payload);
    const guid = reader.readU64();
    reader.readU32();
    const message = reader.readU8();
    if (this.divider === 0n || this.divider !== guid) {
      return [];
    }
    const sharer = this.party?.peer(Number(this.divider));
    sharer?.deliver([pushResult(BigInt(player.guid), message)]);
    this.divider = 0n;
    return [];
  }

  private complete(payload: Uint8Array, player: Character): TalkPacket[] {
    if (payload.length < 12) {
      return [];
    }
    const reader = new ByteReader(payload);
    const guid = reader.readU64();
    const questId = reader.readU32();
    const target = this.resolve(guid);
    if (!target || !this.catalog.enders(target.kind, target.entry).includes(questId)) {
      return [];
    }
    return this.questWindow(guid, questId, player, true, false);
  }

  private requestReward(payload: Uint8Array, player: Character): TalkPacket[] {
    if (payload.length < 12) {
      return [];
    }
    const reader = new ByteReader(payload);
    const guid = reader.readU64();
    const questId = reader.readU32();
    const target = this.resolve(guid);
    const quest = this.catalog.quest(questId);
    if (!target || !quest || !this.catalog.enders(target.kind, target.entry).includes(questId)) {
      return [];
    }
    if (this.quests.status(questId) === QUEST_STATUS_INCOMPLETE) {
      this.quests.complete(questId);
    }
    if (this.quests.status(questId) !== QUEST_STATUS_COMPLETE) {
      return [];
    }
    return [this.offerReward(guid, quest, player)];
  }

  private chooseReward(payload: Uint8Array, player: Character, kit: CharacterLoginKit): TalkPacket[] {
    if (payload.length < 16) {
      return [];
    }
    const reader = new ByteReader(payload);
    const guid = reader.readU64();
    const questId = reader.readU32();
    const choice = reader.readU32();
    const target = this.resolve(guid) ?? this.target;
    const quest = this.catalog.quest(questId);
    if (!quest || !target || !this.catalog.enders(target.kind, target.entry).includes(questId)) {
      return [];
    }
    if (choice > 5) {
      return [];
    }
    const cost = getRewOrReqMoney(quest, player.level, this.catalog.moneyByLevel);
    if (cost < 0 && player.money < -cost) {
      return [this.offerReward(guid, quest, player)];
    }
    const reward = this.quests.reward(questId, choice, player.level);
    if (!reward) {
      return [packet(SMSG_GOSSIP_COMPLETE, "SMSG_GOSSIP_COMPLETE", gossipComplete())];
    }
    applyXp(player, reward.xp);
    player.money = Math.max(0, player.money + reward.money);
    if (reward.spell > 0 && !kit.spells.includes(reward.spell)) {
      kit.spells.push(reward.spell);
    }
    for (const faction of reward.factions) {
      const slot = kit.factions.find((row) => row.faction === faction.faction);
      if (slot) {
        slot.standing += faction.standing;
      } else {
        kit.factions.push({ faction: faction.faction, standing: faction.standing, flags: 0 });
      }
    }
    if (reward.items.length > 0 || reward.choiceItem > 0) {
      const names = [
        ...reward.items.map((item) => `${item.id}x${item.count}`),
        reward.choiceItem > 0 ? `${reward.choiceItem}x${reward.choiceCount}` : "",
      ].filter((name) => name.length > 0);
      log("world", `quest ${questId} item reward ${names.join(", ")} waits for bags`);
    }
    const packets = [
      packet(
        SMSG_QUESTGIVER_QUEST_COMPLETE,
        "SMSG_QUESTGIVER_QUEST_COMPLETE",
        buildQuestGiverQuestComplete({ ...reward, questId }),
      ),
      this.progress(player, true),
    ];
    const nextId = quest.rewardNextQuest;
    const next = nextId > 0 ? this.catalog.quest(nextId) : null;
    if (next && this.catalog.starters(target.kind, target.entry).includes(nextId) && this.quests.canTake(nextId, this.quests.speaker)) {
      if (isAutoAccept(next)) {
        this.quests.accept(nextId);
      }
      packets.push(this.details(guid, next, player));
    } else {
      packets.push(packet(SMSG_GOSSIP_COMPLETE, "SMSG_GOSSIP_COMPLETE", gossipComplete()));
    }
    if (quest.questType === 0) {
      packets.push(
        packet(SMSG_QUESTGIVER_STATUS, "SMSG_QUESTGIVER_STATUS", buildQuestGiverStatus(guid, this.quests.dialogStatus(target.kind, target.entry))),
      );
    }
    if (reward.spell > 0) {
      packets.push(
        packet(
          SMSG_LEARNED_SPELL,
          "SMSG_LEARNED_SPELL",
          new ByteWriter().writeU32(reward.spell).writeU16(0).toUint8Array(),
        ),
      );
    }
    return packets;
  }

  private abandon(payload: Uint8Array, player: Character): TalkPacket[] {
    if (payload.length < 1) {
      return [];
    }
    const slot = new ByteReader(payload).readU8();
    if (this.quests.abandon(slot) === null) {
      return [];
    }
    return [this.progress(player, true)];
  }

  private questQuery(payload: Uint8Array, player: Character): TalkPacket[] {
    if (payload.length < 4) {
      return [];
    }
    const questId = new ByteReader(payload).readU32();
    const quest = this.catalog.quest(questId);
    if (!quest) {
      return [];
    }
    return [
      packet(
        SMSG_QUEST_QUERY_RESPONSE,
        "SMSG_QUEST_QUERY_RESPONSE",
        buildQuestQueryResponse(quest, player.level, this.catalog),
      ),
    ];
  }

  private poiQuery(payload: Uint8Array): TalkPacket[] {
    if (payload.length < 4) {
      return [];
    }
    const reader = new ByteReader(payload);
    const count = Math.min(reader.readU32(), QUEST_LOG_SLOT_COUNT);
    const ids: number[] = [];
    for (let index = 0; index < count && reader.remaining >= 4; index++) {
      ids.push(reader.readU32());
    }
    return [
      packet(
        SMSG_QUEST_POI_QUERY_RESPONSE,
        "SMSG_QUEST_POI_QUERY_RESPONSE",
        buildQuestPoiQueryResponse(ids, this.quests, this.catalog),
      ),
    ];
  }

  private bind(player: Character, kit: CharacterLoginKit): TalkPacket[] {
    kit.homebind = {
      mapId: player.map,
      zoneId: player.zone,
      posX: player.position_x,
      posY: player.position_y,
      posZ: player.position_z,
    };
    return [packet(SMSG_GOSSIP_COMPLETE, "SMSG_GOSSIP_COMPLETE", gossipComplete())];
  }

  private progress(player: Character, includeLog: boolean): TalkPacket {
    const fields = includeLog ? fullQuestLog(this.quests) : [];
    fields.push(
      { index: UNIT_FIELD_LEVEL, value: player.level },
      { index: PLAYER_XP, value: player.xp },
      { index: PLAYER_NEXT_LEVEL_XP, value: nextXp(player.level) },
      { index: PLAYER_FIELD_COINAGE, value: player.money >>> 0 },
    );
    return packet(SMSG_UPDATE_OBJECT, "SMSG_UPDATE_OBJECT", fieldUpdateBlock(player.guid, fields));
  }

  private resolve(guid: bigint): OpenTarget | null {
    const high = guid >> 48n;
    const counter = Number(guid & 0xffffffn);
    if (high === HIGH_UNIT) {
      const spawn = this.world.creatureSpawn(counter);
      const template = spawn ? this.world.creatureTemplate(spawn.entry) : undefined;
      if (!spawn || !template) {
        return null;
      }
      return {
        guid,
        kind: "creature",
        entry: spawn.entry,
        npcFlags: creatureFlags(template, spawn).npcFlags,
        menuId: template.gossipMenuId,
        name: template.name,
      };
    }
    if (high === HIGH_GAMEOBJECT) {
      const spawn = this.world.gameObjectSpawn(counter);
      const template = spawn ? this.world.gameObjectTemplate(spawn.entry) : undefined;
      if (!spawn || !template) {
        return null;
      }
      const menuId = template.type === 2 ? (template.data[3] ?? 0) : template.type === 10 ? (template.data[19] ?? 0) : 0;
      return {
        guid,
        kind: "gameobject",
        entry: spawn.entry,
        npcFlags: NPC_GOSSIP | NPC_QUESTGIVER,
        menuId,
        name: template.name,
      };
    }
    return null;
  }

  private view(): QuestStateView {
    return {
      status: (questId) => this.quests.status(questId),
      rewarded: (questId) => this.quests.rewarded(questId),
      objective: (questId, index) => this.quests.objective(questId, index),
    };
  }

  syncSpeaker(player: Character): void {
    this.quests.speaker = { race: player.race, classId: player.class, level: player.level };
  }

  private display(itemId: number): number {
    return this.world.itemTemplate(itemId)?.displayId ?? 0;
  }

  private offerPartyAccept(player: Character, quest: QuestTemplate): void {
    const here = placeOf(player);
    const sharerGuid = BigInt(player.guid);
    for (const member of this.party?.members(player.guid) ?? []) {
      if (!inGroupRewardRange(here, member.place()) || !member.canTake(quest.id)) {
        continue;
      }
      member.setDivider(sharerGuid);
      member.deliver([
        packet(SMSG_GOSSIP_COMPLETE, "SMSG_GOSSIP_COMPLETE", gossipComplete()),
        packet(
          SMSG_QUEST_CONFIRM_ACCEPT,
          "SMSG_QUEST_CONFIRM_ACCEPT",
          buildQuestConfirmAccept(quest.id, quest.logTitle, sharerGuid),
        ),
      ]);
    }
  }

  private shareWindow(member: SharePeer, quest: QuestTemplate, sharerGuid: bigint): TalkPacket {
    if (isAutoComplete(quest)) {
      const canComplete = member.status(quest.id) === QUEST_STATUS_COMPLETE;
      const request = buildQuestGiverRequestItems(sharerGuid, quest, canComplete, member.level(), this.catalog, true);
      if (request) {
        return packet(SMSG_QUESTGIVER_REQUEST_ITEMS, "SMSG_QUESTGIVER_REQUEST_ITEMS", request);
      }
      if (canComplete) {
        return packet(
          SMSG_QUESTGIVER_OFFER_REWARD,
          "SMSG_QUESTGIVER_OFFER_REWARD",
          buildQuestGiverOfferReward(sharerGuid, quest, member.level(), this.catalog, (itemId) => this.display(itemId)),
        );
      }
    }
    member.setDivider(sharerGuid);
    return packet(
      SMSG_QUESTGIVER_QUEST_DETAILS,
      "SMSG_QUESTGIVER_QUEST_DETAILS",
      buildQuestGiverQuestDetails(sharerGuid, quest, member.level(), this.catalog, (itemId) => this.display(itemId), true, sharerGuid),
    );
  }
}

function isAutoAccept(quest: { flags: number; specialFlags: number }): boolean {
  return (quest.flags & QUEST_FLAGS_AUTO_ACCEPT) !== 0 || (quest.specialFlags & QUEST_SPECIAL_AUTO_ACCEPT) !== 0;
}

function isAutoComplete(quest: { questType: number; flags: number }): boolean {
  return quest.questType === 0 || (quest.flags & QUEST_FLAGS_AUTOCOMPLETE) !== 0;
}

function speakerOf(player: Character): Speaker {
  return {
    race: player.race,
    classId: player.class,
    gender: player.gender,
    level: player.level,
    zone: player.zone,
    map: player.map,
  };
}

function fullQuestLog(log: QuestLog): { index: number; value: number }[] {
  return questLogValues(log.slotIds(), log.active());
}

function pushResult(guid: bigint, message: number): TalkPacket {
  return packet(MSG_QUEST_PUSH_RESULT, "MSG_QUEST_PUSH_RESULT", buildQuestPushResult(guid, message));
}

function placeOf(player: Character): { map: number; x: number; y: number; z: number } {
  return { map: player.map, x: player.position_x, y: player.position_y, z: player.position_z };
}

function soldSource(quest: { startItem: number }, world: WorldData): boolean {
  if (quest.startItem <= 0) {
    return false;
  }
  return (world.itemTemplate(quest.startItem)?.sellPrice ?? 0) > 0;
}

function nextXp(level: number): number {
  return XP_TO_NEXT[level] ?? 0;
}

function applyXp(player: Character, amount: number): void {
  if (amount <= 0) {
    return;
  }
  player.xp += amount;
  while (player.level < XP_TO_NEXT.length - 1 && player.xp >= (XP_TO_NEXT[player.level] ?? Number.MAX_SAFE_INTEGER)) {
    player.xp -= XP_TO_NEXT[player.level] ?? 0;
    player.level += 1;
  }
}

function packet(opcode: number, name: string, body: Uint8Array): TalkPacket {
  return { opcode, name, body };
}

export function creditKillPackets(log: QuestLog, entry: number, guid: bigint, player: Character): TalkPacket[] {
  const credits = log.creditKill(entry, guid);
  return creditUpdate(credits, player, log);
}

export function creditGoPackets(log: QuestLog, entry: number, guid: bigint, player: Character): TalkPacket[] {
  const credits = log.creditGo(entry, guid).map((credit) => ({
    ...credit,
    entry: (Math.abs(credit.entry) | 0x80000000) >>> 0,
  }));
  return creditUpdate(credits, player, log);
}

function creditUpdate(credits: Credit[], player: Character, log: QuestLog): TalkPacket[] {
  const packets: TalkPacket[] = [];
  for (const credit of credits) {
    packets.push(
      packet(
        SMSG_QUESTUPDATE_ADD_KILL,
        "SMSG_QUESTUPDATE_ADD_KILL",
        buildQuestUpdateAddKill(credit.questId, credit.entry, credit.count, credit.required, credit.guid),
      ),
    );
    if (credit.done) {
      packets.push(
        packet(SMSG_QUESTUPDATE_COMPLETE, "SMSG_QUESTUPDATE_COMPLETE", buildQuestUpdateComplete(credit.questId)),
      );
    }
  }
  if (credits.length > 0) {
    packets.push(packet(SMSG_UPDATE_OBJECT, "SMSG_UPDATE_OBJECT", fieldUpdateBlock(player.guid, fullQuestLog(log))));
  }
  return packets;
}
