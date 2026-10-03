/**
 * Session-ready vendor handler — list / buy / sell / repair / buyback.
 * Pure pricing and stock live in `../items/vendor.ts`; this wires packets + inventory.
 */

import { eq } from "drizzle-orm";
import type { Db } from "../database/database.ts";
import { item_instance } from "../database/schema/characters.ts";
import { creature, item_template, itemextendedcost_dbc } from "../database/schema/world.ts";
import type { WorldTables } from "../database/world-tables.ts";
import {
  autoStoreItem,
  getItem,
  getItemPos,
  INVENTORY_SLOT_BAG_0,
  INVENTORY_SLOT_BAG_END,
  INVENTORY_SLOT_BAG_START,
  INVENTORY_SLOT_ITEM_END,
  INVENTORY_SLOT_ITEM_START,
  NULL_BAG,
  NULL_SLOT,
  storeItem,
  type Inventory,
  type InventoryItem,
  type ItemTemplateSlice,
} from "../items/bags.ts";
import {
  createItem,
  itemFieldValues,
  ITEM_END,
  ITEM_FIELD_CONTAINED,
  ITEM_FIELD_OWNER,
  loadItem,
  OBJECT_END,
  OBJECT_FIELD_ENTRY,
  saveItem,
  SetDurability,
  type ItemInstance,
} from "../items/instance.ts";
import {
  buy,
  buyback,
  buildBuyFailed,
  buildBuyItem,
  buildListInventory,
  buildSellItem,
  BUY_ERR_CANT_CARRY_MORE,
  BUY_ERR_CANT_FIND_ITEM,
  BUYBACK_SLOT_START,
  CMSG_BUY_ITEM,
  CMSG_BUY_ITEM_IN_SLOT,
  CMSG_BUYBACK_ITEM,
  CMSG_LIST_INVENTORY,
  CMSG_REPAIR_ITEM,
  CMSG_SELL_ITEM,
  createBuybackState,
  createVendorStock,
  listInventoryEntries,
  loadVendor,
  repairAll,
  repairOne,
  sell,
  SELL_ERR_CANT_FIND_ITEM,
  SELL_ERR_CANT_FIND_VENDOR,
  SELL_ERR_CANT_SELL_ITEM,
  SMSG_BUY_FAILED,
  SMSG_BUY_ITEM,
  SMSG_LIST_INVENTORY,
  SMSG_SELL_ITEM,
  type BuybackState,
  type NpcVendorRow,
  type RepairableItem,
  type VendorBuyTemplate,
  type VendorSellTemplate,
  type VendorStock,
} from "../items/vendor.ts";
import { ByteReader, ByteWriter } from "../net/byte-buffer.ts";
import { SMSG_DESTROY_OBJECT, SMSG_UPDATE_OBJECT } from "./packets.ts";
import {
  fieldUpdateBlock,
  packedGuid,
  PLAYER_FIELD_COINAGE,
  PLAYER_END,
} from "./update-object.ts";

export type PlayPacket = { opcode: number; name: string; body: Uint8Array };
export type VendorPlayResult = { packets: PlayPacket[]; money?: number } | null;

export const VENDOR_OPCODES: ReadonlySet<number> = new Set([
  CMSG_LIST_INVENTORY,
  CMSG_SELL_ITEM,
  CMSG_BUY_ITEM,
  CMSG_BUY_ITEM_IN_SLOT,
  CMSG_BUYBACK_ITEM,
  CMSG_REPAIR_ITEM,
]);

export type VendorPlayCtx = {
  db: Db;
  world: WorldTables | null;
  playerGuid: number;
  money: number;
  inventory: Inventory;
};

/** Opaque per-login vendor state (buyback + limited stock). */
export type VendorSession = {
  buyback: BuybackState;
  /** creature spawn guid → stock counts */
  stockBySpawn: Map<number, VendorStock>;
  loginTime: number;
};

export function createVendorSession(loginTime = Math.floor(Date.now() / 1000)): VendorSession {
  return {
    buyback: createBuybackState(),
    stockBySpawn: new Map(),
    loginTime,
  };
}

const HIGHGUID_ITEM = 0x4000n;
const OBJECT_FIELD_GUID = 0x0000;
const OBJECT_FIELD_TYPE = 0x0002;
const TYPEMASK_ITEM = 0x0002;
const TYPEID_ITEM = 1;
const UPDATETYPE_CREATE_OBJECT2 = 3;
const UNIT_END = OBJECT_END + 0x008e;
const PLAYER_FIELD_INV_SLOT_HEAD = UNIT_END + 0x00b0;
const PLAYER_FIELD_PACK_SLOT_1 = UNIT_END + 0x00de;
const PLAYER_FIELD_BANK_SLOT_1 = UNIT_END + 0x00fe;
const PLAYER_FIELD_BANKBAG_SLOT_1 = UNIT_END + 0x0136;
const PLAYER_FIELD_KEYRING_SLOT_1 = UNIT_END + 0x015c;
const PLAYER_FIELD_CURRENCYTOKEN_SLOT_1 = UNIT_END + 0x019c;
const PLAYER_FIELD_BUYBACK_PRICE_1 = UNIT_END + 0x041d;
const PLAYER_FIELD_BUYBACK_TIMESTAMP_1 = UNIT_END + 0x0429;
const PLAYER_FIELD_VENDORBUYBACK_SLOT_1 = UNIT_END + 0x0144;
const BANK_SLOT_ITEM_START = 39;
const BANK_SLOT_ITEM_END = 67;
const BANK_SLOT_BAG_START = 67;
const BANK_SLOT_BAG_END = 74;
const KEYRING_SLOT_START = 86;
const KEYRING_SLOT_END = 118;
const CURRENCYTOKEN_SLOT_START = 118;
const CURRENCYTOKEN_SLOT_END = 150;
const EQUIPMENT_SLOT_END = 19;

type VendorOpcode =
  | typeof CMSG_LIST_INVENTORY
  | typeof CMSG_SELL_ITEM
  | typeof CMSG_BUY_ITEM
  | typeof CMSG_BUY_ITEM_IN_SLOT
  | typeof CMSG_BUYBACK_ITEM
  | typeof CMSG_REPAIR_ITEM;

type ItemTemplateRow = VendorBuyTemplate &
  VendorSellTemplate &
  ItemTemplateSlice & {
    displayid: number;
    MaxDurability: number;
    BuyCount: number;
    BuyPrice: number;
    Flags2: number;
  };

type ExtendedCostReq = { itemId: number; count: number };

export async function handleVendor(
  opcode: number,
  payload: Uint8Array,
  ctx: VendorPlayCtx,
  session: VendorSession,
): Promise<VendorPlayResult> {
  if (!VENDOR_OPCODES.has(opcode)) {
    return null;
  }
  const op = opcode as VendorOpcode;
  switch (op) {
    case CMSG_LIST_INVENTORY:
      return handleListInventory(payload, ctx, session);
    case CMSG_BUY_ITEM:
      return handleBuyItem(payload, ctx, session, false);
    case CMSG_BUY_ITEM_IN_SLOT:
      return handleBuyItem(payload, ctx, session, true);
    case CMSG_SELL_ITEM:
      return handleSellItem(payload, ctx, session);
    case CMSG_BUYBACK_ITEM:
      return handleBuybackItem(payload, ctx, session);
    case CMSG_REPAIR_ITEM:
      return handleRepairItem(payload, ctx);
    default: {
      const _exhaustive: never = op;
      return _exhaustive;
    }
  }
}

function handleListInventory(
  payload: Uint8Array,
  ctx: VendorPlayCtx,
  session: VendorSession,
): VendorPlayResult {
  const vendorGuid = new ByteReader(payload).readU64();
  const spawnGuid = Number(vendorGuid & 0xffffffn);
  const entry = resolveCreatureEntry(ctx.world, spawnGuid);
  if (entry === null || !ctx.world) {
    return {
      packets: [
        pkt(
          SMSG_LIST_INVENTORY,
          "SMSG_LIST_INVENTORY",
          buildListInventory(vendorGuid, []),
        ),
      ],
    };
  }

  const vendorItems = loadVendor(ctx.world, entry);
  const stock = stockFor(session, spawnGuid);
  const templates = loadBuyTemplates(ctx.world, vendorItems);
  const entries = listInventoryEntries(vendorItems, stock, templates);
  return {
    packets: [
      pkt(SMSG_LIST_INVENTORY, "SMSG_LIST_INVENTORY", buildListInventory(vendorGuid, entries)),
    ],
  };
}

async function handleBuyItem(
  payload: Uint8Array,
  ctx: VendorPlayCtx,
  session: VendorSession,
  inSlot: boolean,
): Promise<VendorPlayResult> {
  const reader = new ByteReader(payload);
  const vendorGuid = reader.readU64();
  const itemEntry = reader.readU32();
  let vendorslot = reader.readU32();
  let bag = NULL_BAG;
  let slot = NULL_SLOT;
  let count: number;
  if (inSlot) {
    const bagGuid = reader.readU64();
    slot = reader.readU8();
    count = reader.readU32();
    bag = resolveBuyBag(ctx, bagGuid);
    if (bag === NULL_BAG) {
      return {
        packets: [
          pkt(
            SMSG_BUY_FAILED,
            "SMSG_BUY_FAILED",
            buildBuyFailed(vendorGuid, itemEntry, BUY_ERR_CANT_FIND_ITEM),
          ),
        ],
      };
    }
  } else {
    count = reader.readU32();
    // trailing unk u8 — ignore if present
    if (reader.remaining > 0) {
      reader.readU8();
    }
  }

  if (vendorslot > 0) {
    vendorslot -= 1;
  } else {
    return {
      packets: [
        pkt(
          SMSG_BUY_FAILED,
          "SMSG_BUY_FAILED",
          buildBuyFailed(vendorGuid, itemEntry, BUY_ERR_CANT_FIND_ITEM),
        ),
      ],
    };
  }

  const spawnGuid = Number(vendorGuid & 0xffffffn);
  const entry = resolveCreatureEntry(ctx.world, spawnGuid);
  if (entry === null || !ctx.world) {
    return {
      packets: [
        pkt(
          SMSG_BUY_FAILED,
          "SMSG_BUY_FAILED",
          buildBuyFailed(vendorGuid, itemEntry, BUY_ERR_CANT_FIND_ITEM),
        ),
      ],
    };
  }

  const vendorItems = loadVendor(ctx.world, entry);
  const stock = stockFor(session, spawnGuid);
  const proto = loadItemTemplate(ctx.world, itemEntry);
  if (!proto) {
    return {
      packets: [
        pkt(
          SMSG_BUY_FAILED,
          "SMSG_BUY_FAILED",
          buildBuyFailed(vendorGuid, itemEntry, BUY_ERR_CANT_FIND_ITEM),
        ),
      ],
    };
  }

  const crItem = vendorItems[vendorslot];
  if (!crItem || crItem.item !== itemEntry) {
    return {
      packets: [
        pkt(
          SMSG_BUY_FAILED,
          "SMSG_BUY_FAILED",
          buildBuyFailed(vendorGuid, itemEntry, BUY_ERR_CANT_FIND_ITEM),
        ),
      ],
    };
  }

  if (crItem.ExtendedCost !== 0) {
    const missing = missingExtendedCostItems(ctx.world, ctx.inventory, crItem.ExtendedCost, count);
    if (missing) {
      return {
        packets: [
          pkt(
            SMSG_BUY_FAILED,
            "SMSG_BUY_FAILED",
            buildBuyFailed(vendorGuid, itemEntry, BUY_ERR_CANT_FIND_ITEM),
          ),
        ],
      };
    }
  }

  const buyCount = count < 1 ? 1 : count;
  const units = proto.BuyCount * buyCount;

  // Store first (AC CanStoreNewItem), then charge / deplete stock.
  const instance = await createItem(ctx.db, ctx.world, {
    entry: itemEntry,
    owner: ctx.playerGuid,
    count: units,
    durability: proto.MaxDurability,
    maxDurability: proto.MaxDurability,
  });

  const invItem: InventoryItem = {
    guid: instance.guid,
    entry: itemEntry,
    count: units,
    template: toSlice(proto),
  };

  const storeResult =
    bag === NULL_BAG && slot === NULL_SLOT
      ? autoStoreItem(ctx.inventory, invItem)
      : storeItem(ctx.inventory, bag === NULL_BAG ? INVENTORY_SLOT_BAG_0 : bag, slot, invItem);

  if (!storeResult.ok) {
    await deleteItemInstance(ctx.db, instance.guid);
    return {
      packets: [
        pkt(
          SMSG_BUY_FAILED,
          "SMSG_BUY_FAILED",
          buildBuyFailed(vendorGuid, itemEntry, BUY_ERR_CANT_CARRY_MORE),
        ),
      ],
    };
  }

  const now = Math.floor(Date.now() / 1000);
  const bought = buy(
    vendorItems,
    stock,
    vendorslot,
    itemEntry,
    count,
    ctx.money,
    proto,
    1,
    now,
  );
  if (!bought.ok) {
    const pos = getItemPos(ctx.inventory, instance.guid);
    if (pos) {
      removeInventoryItem(ctx.inventory, pos.bag, pos.slot);
    }
    await deleteItemInstance(ctx.db, instance.guid);
    return {
      packets: [
        pkt(
          SMSG_BUY_FAILED,
          "SMSG_BUY_FAILED",
          buildBuyFailed(vendorGuid, itemEntry, bought.buyError),
        ),
      ],
      money: bought.money,
    };
  }

  if (crItem.ExtendedCost !== 0) {
    await consumeExtendedCostItems(ctx.world, ctx.db, ctx.inventory, crItem.ExtendedCost, count);
  }

  ctx.money = bought.money;
  const packets: PlayPacket[] = [
    pkt(
      SMSG_BUY_ITEM,
      "SMSG_BUY_ITEM",
      buildBuyItem(vendorGuid, bought.vendorSlot, bought.stockLeft, count),
    ),
    pkt(
      SMSG_UPDATE_OBJECT,
      "SMSG_UPDATE_OBJECT",
      buildItemCreate(instance, ctx.playerGuid),
    ),
    ...slotChangePackets(ctx.playerGuid, storeResult.changes),
    pkt(
      SMSG_UPDATE_OBJECT,
      "SMSG_UPDATE_OBJECT",
      fieldUpdateBlock(ctx.playerGuid, [{ index: PLAYER_FIELD_COINAGE, value: ctx.money }]),
    ),
  ];
  return { packets, money: ctx.money };
}

async function handleSellItem(
  payload: Uint8Array,
  ctx: VendorPlayCtx,
  session: VendorSession,
): Promise<VendorPlayResult> {
  const reader = new ByteReader(payload);
  const vendorGuid = reader.readU64();
  const itemGuidPacked = reader.readU64();
  const sellCount = reader.readU32();
  const itemGuid = Number(itemGuidPacked & 0xffffffffn);

  if (!itemGuid) {
    return { packets: [] };
  }

  const spawnGuid = Number(vendorGuid & 0xffffffn);
  if (ctx.world && resolveCreatureEntry(ctx.world, spawnGuid) === null) {
    return {
      packets: [
        pkt(
          SMSG_SELL_ITEM,
          "SMSG_SELL_ITEM",
          buildSellItem(vendorGuid, itemGuidPacked, SELL_ERR_CANT_FIND_VENDOR),
        ),
      ],
    };
  }

  const pos = getItemPos(ctx.inventory, itemGuid);
  if (!pos) {
    return {
      packets: [
        pkt(
          SMSG_SELL_ITEM,
          "SMSG_SELL_ITEM",
          buildSellItem(vendorGuid, itemGuidPacked, SELL_ERR_CANT_FIND_ITEM),
        ),
      ],
    };
  }

  const invItem = getItem(ctx.inventory, pos.bag, pos.slot);
  if (!invItem) {
    return {
      packets: [
        pkt(
          SMSG_SELL_ITEM,
          "SMSG_SELL_ITEM",
          buildSellItem(vendorGuid, itemGuidPacked, SELL_ERR_CANT_FIND_ITEM),
        ),
      ],
    };
  }

  const proto =
    (ctx.world ? loadItemTemplate(ctx.world, invItem.entry) : null) ??
    sellTemplateFromSlice(invItem);
  if (!proto || proto.SellPrice <= 0) {
    return {
      packets: [
        pkt(
          SMSG_SELL_ITEM,
          "SMSG_SELL_ITEM",
          buildSellItem(vendorGuid, itemGuidPacked, SELL_ERR_CANT_SELL_ITEM),
        ),
      ],
    };
  }

  const instance = await loadItem(ctx.db, ctx.world, itemGuid);
  const durability = instance?.durability ?? proto.MaxDurability ?? 0;
  const maxDurability = instance?.maxDurability ?? proto.MaxDurability ?? 0;

  const sold = sell(
    {
      entry: invItem.entry,
      count: invItem.count,
      durability,
      maxDurability,
    },
    sellCount,
    ctx.money,
    session.buyback,
    proto,
    { world: ctx.world ?? undefined, now: Math.floor(Date.now() / 1000), loginTime: session.loginTime },
  );

  if (!sold.ok) {
    return {
      packets: [
        pkt(
          SMSG_SELL_ITEM,
          "SMSG_SELL_ITEM",
          buildSellItem(vendorGuid, itemGuidPacked, sold.sellError),
        ),
      ],
    };
  }

  const countSold = sellCount === 0 ? invItem.count : sellCount;
  const packets: PlayPacket[] = [];

  if (countSold < invItem.count) {
    invItem.count -= countSold;
    if (instance) {
      instance.count = invItem.count;
      await saveItem(ctx.db, instance);
      packets.push(
        pkt(SMSG_UPDATE_OBJECT, "SMSG_UPDATE_OBJECT", writeItemValues(instance)),
      );
    }
  } else {
    removeInventoryItem(ctx.inventory, pos.bag, pos.slot);
    await deleteItemInstance(ctx.db, itemGuid);
    packets.push(
      pkt(SMSG_DESTROY_OBJECT, "SMSG_DESTROY_OBJECT", destroyObject(makeItemGuid(itemGuid))),
      ...slotChangePackets(ctx.playerGuid, [{ bag: pos.bag, slot: pos.slot, itemGuid: null }]),
    );
  }

  ctx.money = sold.money;
  packets.push(
    ...buybackFieldPackets(ctx.playerGuid, session.buyback),
    pkt(
      SMSG_UPDATE_OBJECT,
      "SMSG_UPDATE_OBJECT",
      fieldUpdateBlock(ctx.playerGuid, [{ index: PLAYER_FIELD_COINAGE, value: ctx.money }]),
    ),
    pkt(SMSG_SELL_ITEM, "SMSG_SELL_ITEM", buildSellItem(vendorGuid, itemGuidPacked, 0)),
  );
  return { packets, money: ctx.money };
}

async function handleBuybackItem(
  payload: Uint8Array,
  ctx: VendorPlayCtx,
  session: VendorSession,
): Promise<VendorPlayResult> {
  const reader = new ByteReader(payload);
  const vendorGuid = reader.readU64();
  const absoluteSlot = reader.readU32();

  const result = buyback(session.buyback, absoluteSlot, ctx.money);
  if (!result.ok) {
    return {
      packets: [
        pkt(
          SMSG_BUY_FAILED,
          "SMSG_BUY_FAILED",
          buildBuyFailed(vendorGuid, result.buyError === BUY_ERR_CANT_FIND_ITEM ? 0 : 0, result.buyError),
        ),
      ],
    };
  }

  const proto = ctx.world ? loadItemTemplate(ctx.world, result.item.entry) : null;
  const slice: ItemTemplateSlice = proto
    ? toSlice(proto)
    : {
        entry: result.item.entry,
        InventoryType: 0,
        ContainerSlots: 0,
        BagFamily: 0,
        class: 0,
        subclass: 0,
        bonding: 0,
      };

  const instance = await createItem(ctx.db, ctx.world, {
    entry: result.item.entry,
    owner: ctx.playerGuid,
    count: result.item.count,
    durability: result.item.durability,
    maxDurability: result.item.maxDurability,
  });

  const invItem: InventoryItem = {
    guid: instance.guid,
    entry: result.item.entry,
    count: result.item.count,
    template: slice,
  };

  const stored = autoStoreItem(ctx.inventory, invItem);
  if (!stored.ok) {
    await deleteItemInstance(ctx.db, instance.guid);
    // restore buyback slot
    session.buyback.items[absoluteSlot - BUYBACK_SLOT_START] = result.item;
    session.buyback.prices[absoluteSlot - BUYBACK_SLOT_START] = result.price;
    return {
      packets: [
        pkt(
          SMSG_BUY_FAILED,
          "SMSG_BUY_FAILED",
          buildBuyFailed(vendorGuid, result.item.entry, BUY_ERR_CANT_CARRY_MORE),
        ),
      ],
    };
  }

  ctx.money = result.money;
  return {
    packets: [
      pkt(SMSG_UPDATE_OBJECT, "SMSG_UPDATE_OBJECT", buildItemCreate(instance, ctx.playerGuid)),
      ...slotChangePackets(ctx.playerGuid, stored.changes),
      ...buybackFieldPackets(ctx.playerGuid, session.buyback),
      pkt(
        SMSG_UPDATE_OBJECT,
        "SMSG_UPDATE_OBJECT",
        fieldUpdateBlock(ctx.playerGuid, [{ index: PLAYER_FIELD_COINAGE, value: ctx.money }]),
      ),
    ],
    money: ctx.money,
  };
}

async function handleRepairItem(payload: Uint8Array, ctx: VendorPlayCtx): Promise<VendorPlayResult> {
  const reader = new ByteReader(payload);
  reader.readU64(); // npc guid
  const itemGuidPacked = reader.readU64();
  if (reader.remaining > 0) {
    reader.readU8(); // guildBank
  }

  if (!ctx.world) {
    return { packets: [] };
  }

  const itemGuidLow = Number(itemGuidPacked & 0xffffffffn);
  if (itemGuidLow) {
    const pos = getItemPos(ctx.inventory, itemGuidLow);
    if (!pos) {
      return { packets: [] };
    }
    const invItem = getItem(ctx.inventory, pos.bag, pos.slot);
    if (!invItem) {
      return { packets: [] };
    }
    const repairable = await toRepairable(ctx.db, ctx.world, invItem);
    if (!repairable) {
      return { packets: [] };
    }
    const result = repairOne(ctx.world, repairable, ctx.money);
    if (!result.ok) {
      return { packets: [], money: ctx.money };
    }
    ctx.money = result.money;
    await applyDurability(ctx.db, ctx.world, invItem.guid, result.item.durability, result.item.maxDurability);
    const packets: PlayPacket[] = [
      pkt(
        SMSG_UPDATE_OBJECT,
        "SMSG_UPDATE_OBJECT",
        fieldUpdateBlock(ctx.playerGuid, [{ index: PLAYER_FIELD_COINAGE, value: ctx.money }]),
      ),
    ];
    const instance = await loadItem(ctx.db, ctx.world, invItem.guid);
    if (instance) {
      packets.unshift(
        pkt(SMSG_UPDATE_OBJECT, "SMSG_UPDATE_OBJECT", writeItemValues(instance)),
      );
    }
    return { packets, money: ctx.money };
  }

  const repairables: RepairableItem[] = [];
  const guids: number[] = [];
  for (const [, bagSlots] of ctx.inventory.slots) {
    for (const [, invItem] of bagSlots) {
      const r = await toRepairable(ctx.db, ctx.world, invItem);
      if (r && r.maxDurability > 0 && r.durability < r.maxDurability) {
        repairables.push(r);
        guids.push(invItem.guid);
      }
    }
  }

  const result = repairAll(ctx.world, repairables, ctx.money);
  if (!result.ok) {
    return { packets: [], money: ctx.money };
  }

  ctx.money = result.money;
  const packets: PlayPacket[] = [];
  for (let i = 0; i < result.items.length; i++) {
    const repaired = result.items[i]!;
    const guid = guids[i]!;
    await applyDurability(ctx.db, ctx.world, guid, repaired.durability, repaired.maxDurability);
    const instance = await loadItem(ctx.db, ctx.world, guid);
    if (instance) {
      packets.push(pkt(SMSG_UPDATE_OBJECT, "SMSG_UPDATE_OBJECT", writeItemValues(instance)));
    }
  }
  packets.push(
    pkt(
      SMSG_UPDATE_OBJECT,
      "SMSG_UPDATE_OBJECT",
      fieldUpdateBlock(ctx.playerGuid, [{ index: PLAYER_FIELD_COINAGE, value: ctx.money }]),
    ),
  );
  return { packets, money: ctx.money };
}

/**
 * @ac game/Entities/Player/PlayerStorage.cpp Player::DurabilityRepairAll (`cost` false: `.gear repair` repairs every item
 * for free) — the repaired items' values.
 */
export async function durabilityRepairAllFree(db: Db, world: WorldTables, inventory: Inventory): Promise<PlayPacket[]> {
  const packets: PlayPacket[] = [];
  for (const [, bagSlots] of inventory.slots) {
    for (const [, invItem] of bagSlots) {
      const r = await toRepairable(db, world, invItem);
      if (!r || r.maxDurability <= 0 || r.durability >= r.maxDurability) continue;
      await applyDurability(db, world, invItem.guid, r.maxDurability, r.maxDurability);
      const instance = await loadItem(db, world, invItem.guid);
      if (instance) packets.push(pkt(SMSG_UPDATE_OBJECT, "SMSG_UPDATE_OBJECT", writeItemValues(instance)));
    }
  }
  return packets;
}

// --- helpers -----------------------------------------------------------------

function pkt(opcode: number, name: string, body: Uint8Array): PlayPacket {
  return { opcode, name, body };
}

function stockFor(session: VendorSession, spawnGuid: number): VendorStock {
  let stock = session.stockBySpawn.get(spawnGuid);
  if (!stock) {
    stock = createVendorStock();
    session.stockBySpawn.set(spawnGuid, stock);
  }
  return stock;
}

function resolveCreatureEntry(world: WorldTables | null, spawnGuid: number): number | null {
  const row = world?.first(creature, "guid", spawnGuid);
  return row ? row.id >>> 0 : null;
}

async function deleteItemInstance(db: Db, guid: number): Promise<void> {
  await db.delete(item_instance).where(eq(item_instance.guid, guid));
}

function loadBuyTemplates(
  world: WorldTables,
  vendorItems: readonly NpcVendorRow[],
): Map<number, VendorBuyTemplate & { displayid: number; MaxDurability: number }> {
  const map = new Map<number, VendorBuyTemplate & { displayid: number; MaxDurability: number }>();
  for (const v of vendorItems) {
    if (map.has(v.item)) {
      continue;
    }
    const proto = loadItemTemplate(world, v.item);
    if (proto) {
      map.set(v.item, proto);
    }
  }
  return map;
}

function loadItemTemplate(world: WorldTables, entry: number): ItemTemplateRow | null {
  const row = world.first(item_template, "entry", entry);
  if (!row) {
    return null;
  }
  return {
    entry: row.entry,
    class: row.class,
    subclass: row.subclass,
    displayid: row.displayid >>> 0,
    BuyCount: row.BuyCount > 0 ? row.BuyCount : 1,
    BuyPrice: row.BuyPrice >>> 0,
    SellPrice: row.SellPrice >>> 0,
    InventoryType: row.InventoryType >>> 0,
    ContainerSlots: row.ContainerSlots >>> 0,
    BagFamily: row.BagFamily >>> 0,
    bonding: row.bonding >>> 0,
    ItemLevel: row.ItemLevel >>> 0,
    Quality: row.Quality >>> 0,
    MaxDurability: row.MaxDurability >>> 0,
    Flags: row.Flags >>> 0,
    Flags2: row.FlagsExtra >>> 0,
  };
}

function toSlice(proto: ItemTemplateRow): ItemTemplateSlice {
  return {
    entry: proto.entry,
    InventoryType: proto.InventoryType,
    ContainerSlots: proto.ContainerSlots,
    BagFamily: proto.BagFamily,
    class: proto.class,
    subclass: proto.subclass,
    bonding: proto.bonding,
  };
}

function sellTemplateFromSlice(item: InventoryItem): VendorSellTemplate & { MaxDurability: number } {
  return {
    SellPrice: 0,
    ItemLevel: 1,
    Quality: 1,
    class: item.template.class,
    subclass: item.template.subclass,
    bonding: item.template.bonding,
    MaxDurability: 0,
  };
}

function resolveBuyBag(ctx: VendorPlayCtx, bagGuid: bigint): number {
  const low = Number(bagGuid & 0xffffffffn);
  if (low === ctx.playerGuid || bagGuid === BigInt(ctx.playerGuid)) {
    return INVENTORY_SLOT_BAG_0;
  }
  for (let bagSlot = INVENTORY_SLOT_BAG_START; bagSlot < INVENTORY_SLOT_BAG_END; bagSlot++) {
    const bagItem = getItem(ctx.inventory, 0, bagSlot);
    if (bagItem && bagItem.guid === low) {
      return bagItem.guid;
    }
  }
  return NULL_BAG;
}

function missingExtendedCostItems(
  world: WorldTables,
  inv: Inventory,
  extendedCost: number,
  buyCount: number,
): boolean {
  const reqs = loadExtendedCostReqs(world, extendedCost);
  if (!reqs) {
    return true;
  }
  for (const req of reqs) {
    if (!req.itemId) {
      continue;
    }
    const need = req.count * buyCount;
    if (countItemEntry(inv, req.itemId) < need) {
      return true;
    }
  }
  return false;
}

async function consumeExtendedCostItems(
  world: WorldTables,
  db: Db,
  inv: Inventory,
  extendedCost: number,
  buyCount: number,
): Promise<void> {
  const reqs = loadExtendedCostReqs(world, extendedCost);
  if (!reqs) {
    return;
  }
  for (const req of reqs) {
    if (!req.itemId) {
      continue;
    }
    let need = req.count * buyCount;
    for (const [bag, bagSlots] of inv.slots) {
      for (const [slot, item] of [...bagSlots.entries()]) {
        if (need <= 0) {
          break;
        }
        if (item.entry !== req.itemId) {
          continue;
        }
        if (item.count <= need) {
          need -= item.count;
          removeInventoryItem(inv, bag, slot);
          await deleteItemInstance(db, item.guid);
        } else {
          item.count -= need;
          need = 0;
          const instance = await loadItem(db, world, item.guid);
          if (instance) {
            instance.count = item.count;
            await saveItem(db, instance);
          }
        }
      }
    }
  }
}

function loadExtendedCostReqs(world: WorldTables, id: number): ExtendedCostReq[] | null {
  const row = world.first(itemextendedcost_dbc, "ID", id);
  if (!row) {
    return null;
  }
  return [
    { itemId: row.ItemID_1, count: row.ItemCount_1 },
    { itemId: row.ItemID_2, count: row.ItemCount_2 },
    { itemId: row.ItemID_3, count: row.ItemCount_3 },
    { itemId: row.ItemID_4, count: row.ItemCount_4 },
    { itemId: row.ItemID_5, count: row.ItemCount_5 },
  ];
}

function countItemEntry(inv: Inventory, entry: number): number {
  let total = 0;
  for (const [, bagSlots] of inv.slots) {
    for (const [, item] of bagSlots) {
      if (item.entry === entry) {
        total += item.count;
      }
    }
  }
  return total;
}

function removeInventoryItem(inv: Inventory, bag: number, slot: number): InventoryItem | null {
  const map = inv.slots.get(bag);
  if (!map) {
    return null;
  }
  const item = map.get(slot) ?? null;
  if (item) {
    map.delete(slot);
    inv.byGuid.delete(item.guid);
  }
  return item;
}

async function toRepairable(
  db: Db,
  world: WorldTables,
  invItem: InventoryItem,
): Promise<RepairableItem | null> {
  const proto = loadItemTemplate(world, invItem.entry);
  if (!proto || !proto.MaxDurability) {
    return null;
  }
  const instance = await loadItem(db, world, invItem.guid);
  return {
    durability: instance?.durability ?? proto.MaxDurability,
    maxDurability: instance?.maxDurability ?? proto.MaxDurability,
    ItemLevel: proto.ItemLevel,
    Quality: proto.Quality,
    class: proto.class,
    subclass: proto.subclass,
  };
}

async function applyDurability(
  db: Db,
  world: WorldTables | null,
  guid: number,
  durability: number,
  maxDurability: number,
): Promise<void> {
  const item = await loadItem(db, world, guid);
  if (!item) {
    return;
  }
  SetDurability(item, durability, maxDurability);
  await saveItem(db, item);
}

function makeItemGuid(counter: number): bigint {
  return BigInt(counter >>> 0) | (HIGHGUID_ITEM << 48n);
}

function destroyObject(guid: bigint): Uint8Array {
  return new ByteWriter().writeU64(guid).writeU8(0).toUint8Array();
}

function buildItemCreate(item: ItemInstance, ownerGuid: number): Uint8Array {
  const values = new Uint32Array(ITEM_END);
  const packed = makeItemGuid(item.guid);
  values[OBJECT_FIELD_GUID] = Number(packed & 0xffffffffn);
  values[OBJECT_FIELD_GUID + 1] = Number((packed >> 32n) & 0xffffffffn);
  values[OBJECT_FIELD_TYPE] = TYPEMASK_ITEM;
  values[OBJECT_FIELD_ENTRY] = item.itemEntry;
  values[ITEM_FIELD_OWNER] = ownerGuid >>> 0;
  values[ITEM_FIELD_CONTAINED] = ownerGuid >>> 0;
  for (const field of itemFieldValues(item)) {
    if (field.index >= 0 && field.index < values.length) {
      values[field.index] = field.value >>> 0;
    }
  }

  const body = new ByteWriter()
    .writeU32(1)
    .writeU8(UPDATETYPE_CREATE_OBJECT2)
    .writeBytes(packedGuid(packed))
    .writeU8(TYPEID_ITEM)
    .writeU16(0);
  writeValuesMask(body, values, new Set([OBJECT_FIELD_GUID, OBJECT_FIELD_GUID + 1, OBJECT_FIELD_TYPE]));
  return body.toUint8Array();
}

function writeItemValues(item: ItemInstance): Uint8Array {
  const values = new Uint32Array(ITEM_END);
  const force = new Set<number>();
  for (const field of itemFieldValues(item)) {
    if (field.index < 0 || field.index >= values.length) {
      continue;
    }
    values[field.index] = field.value >>> 0;
    force.add(field.index);
  }
  const body = new ByteWriter()
    .writeU32(1)
    .writeU8(0)
    .writeBytes(packedGuid(makeItemGuid(item.guid)));
  writeValuesMask(body, values, force);
  return body.toUint8Array();
}

function writeValuesMask(
  body: ByteWriter,
  values: Uint32Array,
  force?: ReadonlySet<number>,
): void {
  const blocks = Math.ceil(values.length / 32);
  body.writeU8(blocks);
  const present: number[] = [];
  for (let block = 0; block < blocks; block++) {
    let mask = 0;
    for (let bit = 0; bit < 32; bit++) {
      const index = block * 32 + bit;
      if (index < values.length && (values[index] !== 0 || force?.has(index))) {
        mask |= 1 << bit;
        present.push(index);
      }
    }
    body.writeU32(mask >>> 0);
  }
  for (const index of present) {
    body.writeU32(values[index]!);
  }
}

function slotFieldIndex(bag: number, slot: number): number | null {
  if (bag === 0) {
    if (slot < EQUIPMENT_SLOT_END || (slot >= INVENTORY_SLOT_BAG_START && slot < INVENTORY_SLOT_BAG_END)) {
      return PLAYER_FIELD_INV_SLOT_HEAD + slot * 2;
    }
    if (slot >= INVENTORY_SLOT_ITEM_START && slot < INVENTORY_SLOT_ITEM_END) {
      return PLAYER_FIELD_PACK_SLOT_1 + (slot - INVENTORY_SLOT_ITEM_START) * 2;
    }
    if (slot >= BANK_SLOT_ITEM_START && slot < BANK_SLOT_ITEM_END) {
      return PLAYER_FIELD_BANK_SLOT_1 + (slot - BANK_SLOT_ITEM_START) * 2;
    }
    if (slot >= BANK_SLOT_BAG_START && slot < BANK_SLOT_BAG_END) {
      return PLAYER_FIELD_BANKBAG_SLOT_1 + (slot - BANK_SLOT_BAG_START) * 2;
    }
    if (slot >= KEYRING_SLOT_START && slot < KEYRING_SLOT_END) {
      return PLAYER_FIELD_KEYRING_SLOT_1 + (slot - KEYRING_SLOT_START) * 2;
    }
    if (slot >= CURRENCYTOKEN_SLOT_START && slot < CURRENCYTOKEN_SLOT_END) {
      return PLAYER_FIELD_CURRENCYTOKEN_SLOT_1 + (slot - CURRENCYTOKEN_SLOT_START) * 2;
    }
    return null;
  }
  // Bag contents update the container object; parent session may not mirror them yet.
  return null;
}

function slotChangePackets(
  playerGuid: number,
  changes: readonly { bag: number; slot: number; itemGuid: number | null }[],
): PlayPacket[] {
  const fields: { index: number; value: number }[] = [];
  for (const change of changes) {
    const index = slotFieldIndex(change.bag, change.slot);
    if (index === null || index + 1 >= PLAYER_END) {
      continue;
    }
    if (change.itemGuid === null) {
      fields.push({ index, value: 0 }, { index: index + 1, value: 0 });
    } else {
      const packed = makeItemGuid(change.itemGuid);
      fields.push(
        { index, value: Number(packed & 0xffffffffn) },
        { index: index + 1, value: Number((packed >> 32n) & 0xffffffffn) },
      );
    }
  }
  if (fields.length === 0) {
    return [];
  }
  return [pkt(SMSG_UPDATE_OBJECT, "SMSG_UPDATE_OBJECT", fieldUpdateBlock(playerGuid, fields))];
}

function buybackFieldPackets(playerGuid: number, state: BuybackState): PlayPacket[] {
  const fields: { index: number; value: number }[] = [];
  for (let i = 0; i < state.items.length; i++) {
    const item = state.items[i];
    const slotIndex = PLAYER_FIELD_VENDORBUYBACK_SLOT_1 + i * 2;
    if (item) {
      // Buyback items are not re-created as world objects here; price/timestamp drive the UI.
      fields.push({ index: slotIndex, value: 0 }, { index: slotIndex + 1, value: 0 });
    } else {
      fields.push({ index: slotIndex, value: 0 }, { index: slotIndex + 1, value: 0 });
    }
    fields.push({ index: PLAYER_FIELD_BUYBACK_PRICE_1 + i, value: state.prices[i]! >>> 0 });
    fields.push({
      index: PLAYER_FIELD_BUYBACK_TIMESTAMP_1 + i,
      value: state.timestamps[i]! >>> 0,
    });
  }
  return [pkt(SMSG_UPDATE_OBJECT, "SMSG_UPDATE_OBJECT", fieldUpdateBlock(playerGuid, fields))];
}
