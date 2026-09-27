/**
 * Creature corpse looting: `LootHandler.cpp` and the `Player` loot calls it makes.
 * `HandleLootOpcode` → `Player::SendLoot`, `HandleAutostoreLootItemOpcode` → `Player::StoreLootItem`,
 * `HandleLootMoneyOpcode`, and `HandleLootReleaseOpcode` → `WorldSession::DoLootRelease`.
 * The loot lives on the creature (`Creature::loot`); the player keeps only the guid it is looting (`Player::m_lootGuid`).
 */

import type { Db } from "../database/database.ts";
import type { WorldTables } from "../database/world-tables.ts";
import { item_template } from "../database/schema/world.ts";
import {
  buildInventoryChangeFailure,
  buildItemPushResult,
  canStoreNewItem,
  EQUIP_ERR_ALREADY_LOOTED,
  EQUIP_ERR_OK,
  EQUIP_ERR_TOO_MUCH_GOLD,
  getItemCount,
  getItemPos,
  INVENTORY_SLOT_BAG_0,
  itemAtStorePos,
  NULL_BAG,
  NULL_SLOT,
  placeStoredItem,
  SMSG_INVENTORY_CHANGE_FAILURE,
  SMSG_ITEM_PUSH_RESULT,
  type Inventory,
  type InventoryItem,
  type ItemPosCount,
  type SlotChange,
} from "../items/bags.ts";
import { generateItemRandomPropertyId, setItemRandomProperties, type ItemDbc } from "../items/item-dbc.ts";
import { createItem, saveItem, type ItemInstance } from "../items/instance.ts";
import { ITEM_FIELD_FLAG_SOULBOUND } from "../items/stacks.ts";
import {
  buildLootError,
  buildLootMoneyNotify,
  buildLootReleaseResponse,
  buildLootRemoved,
  buildLootResponse,
  LootError,
  LootType,
  PermissionTypes,
  SMSG_LOOT_RESPONSE,
  type Loot,
  type LootErrorValue,
  type LootItemProto,
  type LootPlayer,
  type LootTypeValue,
  type PermissionType,
} from "../loot/loot.ts";
import { ByteReader } from "../net/byte-buffer.ts";
import { MAX_MONEY_AMOUNT } from "../shared/limits.ts";
import { buildSuccessPackets, lookupTemplate } from "./bags-play.ts";
import { SMSG_UPDATE_OBJECT } from "./packets.ts";
import { fieldUpdateBlock, PLAYER_FIELD_COINAGE } from "./update-object.ts";

/** CMSG_LOOT */
export const CMSG_LOOT = 0x15d;
/** CMSG_AUTOSTORE_LOOT_ITEM */
export const CMSG_AUTOSTORE_LOOT_ITEM = 0x108;
/** CMSG_LOOT_MONEY */
export const CMSG_LOOT_MONEY = 0x15e;
/** CMSG_LOOT_RELEASE */
export const CMSG_LOOT_RELEASE = 0x15f;
/** SMSG_LOOT_RELEASE_RESPONSE */
export const SMSG_LOOT_RELEASE_RESPONSE = 0x161;
/** SMSG_LOOT_REMOVED */
export const SMSG_LOOT_REMOVED = 0x162;
/** SMSG_LOOT_MONEY_NOTIFY */
export const SMSG_LOOT_MONEY_NOTIFY = 0x163;
/** SMSG_LOOT_CLEAR_MONEY */
export const SMSG_LOOT_CLEAR_MONEY = 0x165;

/** `ItemBondingType` values `Player::_StoreItem` binds on store. */
const BIND_WHEN_PICKED_UP = 1;
const BIND_QUEST_ITEM = 4;

/** `HighGuid::Unit` / `HighGuid::Vehicle`: `ObjectGuid::IsCreatureOrVehicle`. */
const HIGHGUID_UNIT = 0xf130n;
const HIGHGUID_VEHICLE = 0xf150n;

export const LOOT_OPCODES: ReadonlySet<number> = new Set([CMSG_LOOT, CMSG_AUTOSTORE_LOOT_ITEM, CMSG_LOOT_MONEY, CMSG_LOOT_RELEASE]);

export type PlayPacket = { opcode: number; name: string; body: Uint8Array };

/** A creature as the loot handlers see it (`Map::GetCreature`). */
export type LootCreature = {
  guid: bigint;
  alive: boolean;
  /** `UNIT_DYNFLAG_LOOTABLE` on the creature itself. */
  lootable: boolean;
  /** `Creature::GetLootRecipient` (a player guid). */
  lootRecipient: number | null;
  /** `Creature::loot`; null once cleared. */
  loot: Loot | null;
  /** `IsWithinDistInMap(player, INTERACTION_DISTANCE)` */
  withinInteractionDistance: boolean;
};

/** The map side of creature looting. */
export type LootCreatures = {
  creature(guid: bigint): LootCreature | null;
  /**
   * `DoLootRelease` for a creature whose checks passed: a looted corpse runs `AllLootRemovedFromCorpse`, drops
   * `UNIT_DYNFLAG_LOOTABLE`, and clears its loot; otherwise the round robin player lets go and the dynamic flags are resent.
   */
  releaseLoot(guid: bigint, playerGuid: number): void;
};

/** The session state a loot opcode reads and changes. `lootGuid` and `money` are written back by the handlers. */
export type LootPlayCtx = {
  db: Db;
  world: WorldTables | null;
  itemDbc: ItemDbc;
  player: LootPlayer;
  playerGuid: number;
  alive: boolean;
  money: number;
  /** `Player::m_lootGuid` */
  lootGuid: bigint;
  inventory: Inventory;
  creatures: LootCreatures | null;
  /** A packet for another player looting the same corpse. */
  sendToPlayer(guid: bigint, packet: PlayPacket): void;
  /** `Player::ItemAddedQuestCheck`, with the quest log update it causes. */
  itemAdded(entry: number, count: number): PlayPacket[];
  /** `Player::IsNonMeleeSpellCast` → `InterruptNonMeleeSpells(false)` */
  interruptNonMeleeSpells(): void;
  /** `Player::SendLoot`: invisibility and feign death go at every loot, stealth when looting a corpse. */
  removeLootAuras(removeStealth: boolean): void;
  /** `UNIT_FLAG_LOOTING` */
  setLooting(on: boolean): void;
};

function pkt(opcode: number, name: string, body: Uint8Array): PlayPacket {
  return { opcode, name, body };
}

function isCreatureOrVehicle(guid: bigint): boolean {
  const high = guid >> 48n;
  return high === HIGHGUID_UNIT || high === HIGHGUID_VEHICLE;
}

/** Runs one loot opcode. Returns null for opcodes this module does not own. */
export async function handleLoot(opcode: number, payload: Uint8Array, ctx: LootPlayCtx): Promise<PlayPacket[] | null> {
  switch (opcode) {
    case CMSG_LOOT:
      return handleLootOpcode(payload, ctx);
    case CMSG_AUTOSTORE_LOOT_ITEM:
      return handleAutostoreLootItemOpcode(payload, ctx);
    case CMSG_LOOT_MONEY:
      return handleLootMoneyOpcode(ctx);
    case CMSG_LOOT_RELEASE:
      return handleLootReleaseOpcode(payload, ctx);
    default:
      return null;
  }
}

/** `WorldSession::HandleLootOpcode` */
function handleLootOpcode(payload: Uint8Array, ctx: LootPlayCtx): PlayPacket[] {
  if (payload.length < 8) {
    return [];
  }
  const guid = new ByteReader(payload).readU64();
  // Check possible cheat
  if (!ctx.alive || !isCreatureOrVehicle(guid)) {
    return [];
  }
  // interrupt cast
  ctx.interruptNonMeleeSpells();
  return sendLoot(guid, LootType.CORPSE, ctx);
}

/** `Player::SendLootRelease` */
function lootRelease(guid: bigint): PlayPacket {
  return pkt(SMSG_LOOT_RELEASE_RESPONSE, "SMSG_LOOT_RELEASE_RESPONSE", buildLootReleaseResponse(guid));
}

/** `Player::SendLootError` */
function lootError(guid: bigint, error: LootErrorValue): PlayPacket {
  return pkt(SMSG_LOOT_RESPONSE, "SMSG_LOOT_RESPONSE", buildLootError(guid, error));
}

/** `Player::SendEquipError` without items. */
function equipError(msg: number, itemId: number, ctx: LootPlayCtx): PlayPacket {
  const limitCategory = lookupTemplate(ctx.world, itemId)?.ItemLimitCategory ?? 0;
  return pkt(SMSG_INVENTORY_CHANGE_FAILURE, "SMSG_INVENTORY_CHANGE_FAILURE", buildInventoryChangeFailure(msg, 0n, 0n, 0, limitCategory));
}

/** `Player::SendLoot` for a creature (`LOOT_CORPSE`, or `LOOT_SKINNING` once the corpse was skinned). */
function sendLoot(guid: bigint, requestedType: LootTypeValue, ctx: LootPlayCtx): PlayPacket[] {
  const packets: PlayPacket[] = [];
  if (ctx.lootGuid) {
    packets.push(...doLootRelease(ctx.lootGuid, ctx));
  }
  let lootType = requestedType;
  // remove FD and invisibility at all loots, stealth only if looting a corpse
  ctx.removeLootAuras(lootType === LootType.CORPSE);

  const creature = ctx.creatures?.creature(guid) ?? null;
  // must be in range and creature must be alive for pickpocket and must be dead for another loot
  if (!creature || !creature.loot || creature.alive !== (lootType === LootType.PICKPOCKETING) || !creature.withinInteractionDistance) {
    packets.push(lootRelease(guid));
    return packets;
  }
  const loot = creature.loot;
  // Xinef: Exploit fix
  if (!creature.lootable) {
    packets.push(lootError(guid, LootError.DIDNT_KILL));
    return packets;
  }
  // the player whose group may loot the corpse
  if (creature.lootRecipient === null) {
    return packets;
  }
  const recipient = creature.lootRecipient === ctx.playerGuid;
  let permission: PermissionType;
  if (loot.loot_type === LootType.SKINNING) {
    // if loot is already skinning loot then don't do anything else
    lootType = LootType.SKINNING;
    permission = recipient ? PermissionTypes.OWNER : PermissionTypes.NONE;
  } else {
    // set group rights only for loot_type != LOOT_SKINNING
    permission = recipient ? PermissionTypes.OWNER : PermissionTypes.NONE;
  }
  // need know merged fishing/corpse loot type for achievements
  loot.loot_type = lootType;

  if (permission === PermissionTypes.NONE) {
    packets.push(lootError(guid, LootError.DIDNT_KILL));
    return packets;
  }
  ctx.lootGuid = guid;
  packets.push(pkt(SMSG_LOOT_RESPONSE, "SMSG_LOOT_RESPONSE", buildLootResponse(guid, lootType, loot, ctx.player, permission)));
  // add 'this' player as one of the players that are looting 'loot'
  loot.addLooter(ctx.player.guid);
  if (lootType === LootType.CORPSE) {
    ctx.setLooting(true);
  }
  return packets;
}

/**
 * The loot a creature loot opcode works on: `creature->IsAlive() == (rogue && pickpocketing)` and
 * `IsWithinDistInMap(_player, INTERACTION_DISTANCE)`, else the loot error the C++ sends.
 */
function creatureLoot(guid: bigint, ctx: LootPlayCtx): { loot: Loot; creature: LootCreature } | { error: PlayPacket } {
  const creature = ctx.creatures?.creature(guid) ?? null;
  const lootAllowed = !!creature && creature.loot !== null && !creature.alive;
  if (!lootAllowed || !creature.withinInteractionDistance) {
    return { error: lootError(guid, lootAllowed ? LootError.TOO_FAR : LootError.DIDNT_KILL) };
  }
  return { loot: creature.loot!, creature };
}

/** `WorldSession::HandleAutostoreLootItemOpcode` */
async function handleAutostoreLootItemOpcode(payload: Uint8Array, ctx: LootPlayCtx): Promise<PlayPacket[]> {
  if (payload.length < 1) {
    return [];
  }
  const lootSlot = new ByteReader(payload).readU8();
  const found = creatureLoot(ctx.lootGuid, ctx);
  if ("error" in found) {
    return [found.error];
  }
  return storeLootItem(lootSlot, found.loot, ctx);
}

/** `Player::StoreLootItem` */
export async function storeLootItem(lootSlot: number, loot: Loot, ctx: LootPlayCtx): Promise<PlayPacket[]> {
  const found = loot.lootItemInSlot(lootSlot, ctx.player);
  if (!found || found.item.is_looted) {
    return [equipError(EQUIP_ERR_ALREADY_LOOTED, 0, ctx)];
  }
  const { item, qitem, ffaitem, conditem } = found;
  if (!item.allowedForPlayer(ctx.player, loot.env)) {
    return [lootRelease(ctx.lootGuid)];
  }
  // questitems use the blocked field for other purposes
  if (!qitem && item.is_blocked) {
    return [lootRelease(ctx.lootGuid)];
  }
  // xinef: dont allow protected item to be looted by someone else
  if (item.rollWinnerGUID && item.rollWinnerGUID !== ctx.player.guid) {
    return [lootRelease(ctx.lootGuid)];
  }

  const proto = lookupTemplate(ctx.world, item.itemid);
  const can = canStoreNewItem(ctx.inventory, NULL_BAG, NULL_SLOT, proto, item.count, (id) => ctx.itemDbc.limitCategory(id));
  if (can.result !== EQUIP_ERR_OK || !proto) {
    return [equipError(can.result, item.itemid, ctx)];
  }
  const packets: PlayPacket[] = [];
  const stored = await storeNewItem(can.dest, item.itemid, item.randomPropertyId, proto, ctx);
  packets.push(...stored.packets);

  const removed = pkt(SMSG_LOOT_REMOVED, "SMSG_LOOT_REMOVED", buildLootRemoved(lootSlot));
  const notifyAll = (): void => {
    for (const guid of loot.notifyItemRemoved()) {
      if (guid === ctx.player.guid) packets.push(removed);
      else ctx.sendToPlayer(guid, removed);
    }
  };
  if (qitem) {
    qitem.is_looted = true;
    // freeforall is 1 if everyone's supposed to get the quest item.
    if (item.freeforall || loot.getPlayerQuestItems().size === 1) {
      packets.push(removed);
    } else {
      for (const notify of loot.notifyQuestItemRemoved(qitem.index)) {
        const body = pkt(SMSG_LOOT_REMOVED, "SMSG_LOOT_REMOVED", buildLootRemoved(notify.lootSlot));
        if (notify.guid === ctx.player.guid) packets.push(body);
        else ctx.sendToPlayer(notify.guid, body);
      }
    }
  } else if (ffaitem) {
    // freeforall case, notify only one player of the removal
    ffaitem.is_looted = true;
    packets.push(removed);
  } else {
    // not freeforall, notify everyone
    if (conditem) {
      conditem.is_looted = true;
    }
    notifyAll();
  }
  // if only one person is supposed to loot the item, then set it to looted
  if (!item.freeforall) {
    item.is_looted = true;
  }
  --loot.unlootedCount;

  // `Player::SendNewItem(newitem, item->count, false, false, true)`
  const last = stored.last;
  const pos = getItemPos(ctx.inventory, last.guid)!;
  packets.push(
    pkt(
      SMSG_ITEM_PUSH_RESULT,
      "SMSG_ITEM_PUSH_RESULT",
      buildItemPushResult({
        playerGuid: ctx.player.guid,
        received: false,
        created: false,
        sendChatMessage: true,
        bagSlot: bagSlotOf(ctx.inventory, pos.bag),
        slot: last.count === item.count ? pos.slot : -1,
        entry: last.entry,
        suffixFactor: stored.lastInstance?.propertySeed ?? 0,
        randomPropertyId: stored.lastInstance?.randomPropertyId ?? item.randomPropertyId,
        count: item.count,
        inventoryCount: getItemCount(ctx.inventory, last.entry),
      }),
    ),
  );
  return packets;
}

/**
 * `Player::StoreNewItem` → `Item::CreateItem` + `Player::StoreItem`: fills the stacks in `dest` and creates an item for each
 * free slot, binding it the way `_StoreItem` does. Returns the last stored item, which `SendNewItem` reports.
 */
async function storeNewItem(
  dest: readonly ItemPosCount[],
  entry: number,
  randomPropertyId: number,
  proto: NonNullable<ReturnType<typeof lookupTemplate>>,
  ctx: LootPlayCtx,
): Promise<{ packets: PlayPacket[]; last: InventoryItem; lastInstance: ItemInstance | null }> {
  const count = dest.reduce((sum, pos) => sum + pos.count, 0);
  // `CreateItem(item, count, this, false, randomPropertyId)`: no clone, so the random property is rolled when the loot had none.
  const propertyId = randomPropertyId || generateItemRandomPropertyId(ctx.world, ctx.itemDbc, entry);
  const bound = proto.bonding === BIND_WHEN_PICKED_UP || proto.bonding === BIND_QUEST_ITEM;
  const changes: SlotChange[] = [];
  const created: InventoryItem[] = [];
  const instances = new Map<number, ItemInstance>();
  const countUpdates: InventoryItem[] = [];
  let last: InventoryItem | null = null;
  let lastInstance: ItemInstance | null = null;

  for (const pos of dest) {
    const existing = itemAtStorePos(ctx.inventory, pos);
    if (existing) {
      existing.count += pos.count;
      countUpdates.push(existing);
      last = existing;
      lastInstance = null;
      continue;
    }
    const instance = await createItem(ctx.db, ctx.world, {
      entry,
      owner: ctx.playerGuid,
      count: pos.count,
      randomPropertyId: propertyId,
      flags: bound ? ITEM_FIELD_FLAG_SOULBOUND : 0,
    });
    setItemRandomProperties(instance, propertyId, ctx.world, ctx.itemDbc);
    await saveItem(ctx.db, instance);
    const stored: InventoryItem = { guid: instance.guid, entry, count: pos.count, template: proto };
    const change = placeStoredItem(ctx.inventory, pos.bag, pos.slot, stored);
    if (change) {
      changes.push(change);
    }
    created.push(stored);
    instances.set(instance.guid, instance);
    last = stored;
    lastInstance = instance;
  }

  const packets = buildSuccessPackets(ctx.playerGuid, ctx.inventory, { ok: true, error: EQUIP_ERR_OK, changes }, ctx.world, {
    created,
    instances,
    countUpdates,
  });
  packets.push(...ctx.itemAdded(entry, count));
  return { packets, last: last!, lastInstance };
}

/** `Item::GetBagSlot`: INVENTORY_SLOT_BAG_0 in the backpack, else the equipped bag's slot. */
function bagSlotOf(inventory: Inventory, bag: number): number {
  return bag === 0 ? INVENTORY_SLOT_BAG_0 : (getItemPos(inventory, bag)?.slot ?? INVENTORY_SLOT_BAG_0);
}

/** `WorldSession::HandleLootMoneyOpcode` for a creature corpse. */
function handleLootMoneyOpcode(ctx: LootPlayCtx): PlayPacket[] {
  const guid = ctx.lootGuid;
  if (!guid) {
    return [];
  }
  if (!isCreatureOrVehicle(guid)) {
    // unlootable type
    return [];
  }
  const found = creatureLoot(guid, ctx);
  if ("error" in found) {
    return [found.error];
  }
  const loot = found.loot;
  const packets: PlayPacket[] = [];
  // `Loot::NotifyMoneyRemoved`
  const cleared = pkt(SMSG_LOOT_CLEAR_MONEY, "SMSG_LOOT_CLEAR_MONEY", new Uint8Array());
  for (const looter of loot.notifyMoneyRemoved()) {
    if (looter === ctx.player.guid) packets.push(cleared);
    else ctx.sendToPlayer(looter, cleared);
  }
  // Item, pickpocket and players can be looted only single player; the money of a group corpse is shared through the group.
  const finalGold = loot.gold;
  // `Player::ModifyMoney`
  if (finalGold) {
    if (ctx.money < MAX_MONEY_AMOUNT - finalGold) {
      ctx.money += finalGold;
      packets.push(pkt(SMSG_UPDATE_OBJECT, "SMSG_UPDATE_OBJECT", fieldUpdateBlock(ctx.playerGuid, [{ index: PLAYER_FIELD_COINAGE, value: ctx.money >>> 0 }])));
    } else {
      packets.push(equipError(EQUIP_ERR_TOO_MUCH_GOLD, 0, ctx));
    }
  }
  // "You loot..."
  packets.push(pkt(SMSG_LOOT_MONEY_NOTIFY, "SMSG_LOOT_MONEY_NOTIFY", buildLootMoneyNotify(finalGold, true)));
  loot.gold = 0;
  return packets;
}

/** `WorldSession::HandleLootReleaseOpcode`: cheaters can modify lguid to prevent correct apply loot release code and re-loot, use internal stored guid. */
function handleLootReleaseOpcode(payload: Uint8Array, ctx: LootPlayCtx): PlayPacket[] {
  if (payload.length < 8) {
    return [];
  }
  const guid = new ByteReader(payload).readU64();
  if (ctx.lootGuid && ctx.lootGuid === guid) {
    return doLootRelease(ctx.lootGuid, ctx);
  }
  return [];
}

/** `WorldSession::DoLootRelease` for a creature. */
function doLootRelease(lguid: bigint, ctx: LootPlayCtx): PlayPacket[] {
  ctx.lootGuid = 0n;
  const packets = [lootRelease(lguid)];
  ctx.setLooting(false);
  const creature = ctx.creatures?.creature(lguid) ?? null;
  const lootAllowed = !!creature && creature.loot !== null && !creature.alive;
  if (!lootAllowed || !creature.withinInteractionDistance) {
    return packets;
  }
  const loot = creature.loot!;
  ctx.creatures!.releaseLoot(lguid, ctx.playerGuid);
  // Player is not looking at loot list, he doesn't need to see updates on the loot list
  loot.removeLooter(ctx.player.guid);
  return packets;
}

/** The loot guid body of CMSG_LOOT / CMSG_LOOT_RELEASE (`recvData >> guid`). */
export function packLootGuid(guid: bigint): Uint8Array {
  const body = new Uint8Array(8);
  new DataView(body.buffer).setBigUint64(0, guid, true);
  return body;
}

/** Item template fields the loot code needs, from `item_template`. */
export function lootItemProto(world: WorldTables | null, entry: number): LootItemProto | null {
  const row = world?.first(item_template, "entry", entry);
  if (!row) {
    return null;
  }
  return {
    entry: row.entry,
    Quality: row.Quality,
    Flags: row.Flags,
    FlagsExtra: row.FlagsExtra,
    flagsCustom: row.flagsCustom,
    class: row.class,
    bonding: row.bonding,
    InventoryType: row.InventoryType,
    stackable: row.stackable ?? 1,
    maxcount: row.maxcount,
    BagFamily: row.BagFamily,
    RequiredSkill: row.RequiredSkill,
    spellid_2: row.spellid_2,
    startquest: row.startquest,
    displayid: row.displayid,
  };
}
