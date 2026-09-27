/**
 * Group loot methods: free-for-all, round robin, master loot, group loot, need before greed.
 * Port of AzerothCore LootMethod / Group::GroupLoot / NeedBeforeGreed / CountTheRoll / UpdateLooterGuid.
 * Party formation is not owned here — callers pass the member list and method.
 */

import { ByteWriter } from "../net/byte-buffer.ts";

/** `LootMethod` in LootMgr.h */
export const FREE_FOR_ALL = 0;
export const ROUND_ROBIN = 1;
export const MASTER_LOOT = 2;
export const GROUP_LOOT = 3;
export const NEED_BEFORE_GREED = 4;

export type LootMethod =
  | typeof FREE_FOR_ALL
  | typeof ROUND_ROBIN
  | typeof MASTER_LOOT
  | typeof GROUP_LOOT
  | typeof NEED_BEFORE_GREED;

/** `ItemQualities` in SharedDefines.h */
export const ITEM_QUALITY_POOR = 0;
export const ITEM_QUALITY_NORMAL = 1;
export const ITEM_QUALITY_UNCOMMON = 2;
export const ITEM_QUALITY_RARE = 3;
export const ITEM_QUALITY_EPIC = 4;
export const ITEM_QUALITY_LEGENDARY = 5;
export const ITEM_QUALITY_ARTIFACT = 6;
export const ITEM_QUALITY_HEIRLOOM = 7;

export type ItemQuality =
  | typeof ITEM_QUALITY_POOR
  | typeof ITEM_QUALITY_NORMAL
  | typeof ITEM_QUALITY_UNCOMMON
  | typeof ITEM_QUALITY_RARE
  | typeof ITEM_QUALITY_EPIC
  | typeof ITEM_QUALITY_LEGENDARY
  | typeof ITEM_QUALITY_ARTIFACT
  | typeof ITEM_QUALITY_HEIRLOOM;

/** `RollVote` in Group.h */
export const PASS = 0;
export const NEED = 1;
export const GREED = 2;
export const DISENCHANT = 3;
export const NOT_EMITED_YET = 4;
export const NOT_VALID = 5;

export type RollVote =
  | typeof PASS
  | typeof NEED
  | typeof GREED
  | typeof DISENCHANT
  | typeof NOT_EMITED_YET
  | typeof NOT_VALID;

/** `RollType` in LootMgr.h (client vote choice / roll type in packets) */
export const ROLL_PASS = 0;
export const ROLL_NEED = 1;
export const ROLL_GREED = 2;
export const ROLL_DISENCHANT = 3;
export const MAX_ROLL_TYPE = 4;

export type RollType =
  | typeof ROLL_PASS
  | typeof ROLL_NEED
  | typeof ROLL_GREED
  | typeof ROLL_DISENCHANT;

/** `RollMask` in LootMgr.h */
export const ROLL_FLAG_TYPE_PASS = 0x01;
export const ROLL_FLAG_TYPE_NEED = 0x02;
export const ROLL_FLAG_TYPE_GREED = 0x04;
export const ROLL_FLAG_TYPE_DISENCHANT = 0x08;
export const ROLL_ALL_TYPE_NO_DISENCHANT = 0x07;
export const ROLL_ALL_TYPE_MASK = 0x0f;

/** `PermissionTypes` in LootMgr.h */
export const ALL_PERMISSION = 0;
export const GROUP_PERMISSION = 1;
export const MASTER_PERMISSION = 2;
export const RESTRICTED_PERMISSION = 3;
export const ROUND_ROBIN_PERMISSION = 4;
export const OWNER_PERMISSION = 5;
export const NONE_PERMISSION = 6;

export type PermissionTypes =
  | typeof ALL_PERMISSION
  | typeof GROUP_PERMISSION
  | typeof MASTER_PERMISSION
  | typeof RESTRICTED_PERMISSION
  | typeof ROUND_ROBIN_PERMISSION
  | typeof OWNER_PERMISSION
  | typeof NONE_PERMISSION;

/** `LootSlotType` in LootMgr.h */
export const LOOT_SLOT_TYPE_ALLOW_LOOT = 0;
export const LOOT_SLOT_TYPE_ROLL_ONGOING = 1;
export const LOOT_SLOT_TYPE_MASTER = 2;
export const LOOT_SLOT_TYPE_LOCKED = 3;
export const LOOT_SLOT_TYPE_OWNER = 4;

export type LootSlotType =
  | typeof LOOT_SLOT_TYPE_ALLOW_LOOT
  | typeof LOOT_SLOT_TYPE_ROLL_ONGOING
  | typeof LOOT_SLOT_TYPE_MASTER
  | typeof LOOT_SLOT_TYPE_LOCKED
  | typeof LOOT_SLOT_TYPE_OWNER;

/** Opcodes.h */
export const SMSG_LOOT_ALL_PASSED = 0x29e;
export const SMSG_LOOT_ROLL_WON = 0x29f;
export const SMSG_LOOT_START_ROLL = 0x2a1;
export const SMSG_LOOT_ROLL = 0x2a2;
export const SMSG_LOOT_MASTER_LIST = 0x2a4;

const DEFAULT_COUNTDOWN_MS = 60_000;

/** Injected 1..100 roll. Defaults to `Math.random` mapped into that range. */
export type RollRng = () => number;

export type LootMember = {
  guid: bigint;
  /** `IsAtLootRewardDistance` / `IsAtGroupRewardDistance` */
  inRange: boolean;
  /**
   * Need-before-greed only: `CanRollForItemInLFG == EQUIP_ERR_OK`.
   * When false, NEED is stripped from that player's start-roll mask.
   * Defaults to true.
   */
  canNeed?: boolean;
};

export type LootItemInput = {
  /** HighGuid::Item guid used as the roll/item source guid in packets */
  itemGuid: bigint;
  itemId: number;
  quality: ItemQuality;
  slot: number;
  count?: number;
  randomSuffix?: number;
  randomPropId?: number;
  /** `ITEM_FLAG2_CAN_ONLY_ROLL_GREED` — strips NEED on need-before-greed */
  greedOnly?: boolean;
  /** When true, OR in `ROLL_FLAG_TYPE_DISENCHANT` on the vote mask */
  canDisenchant?: boolean;
};

export type LootItemState = {
  itemGuid: bigint;
  itemId: number;
  quality: ItemQuality;
  slot: number;
  count: number;
  randomSuffix: number;
  randomPropId: number;
  greedOnly: boolean;
  canDisenchant: boolean;
  /** quality < threshold (FillLoot / GroupLoot underthreshold path) */
  isUnderthreshold: boolean;
  /** Blocked for direct loot (rolling or master-assigned) */
  isBlocked: boolean;
  winnerGuid: bigint | null;
};

export type ActiveRoll = {
  itemGuid: bigint;
  itemId: number;
  slot: number;
  count: number;
  randomSuffix: number;
  randomPropId: number;
  rollVoteMask: number;
  /** playerGuid → vote */
  playerVote: Map<bigint, RollVote>;
  totalPlayersRolling: number;
  totalNeed: number;
  totalGreed: number;
  totalPass: number;
  resolved: boolean;
};

export type VoteBroadcast = {
  kind: "vote";
  packet: Uint8Array;
  playerGuid: bigint;
  choice: RollType;
};

export type RollOutcome =
  | {
      kind: "won";
      winnerGuid: bigint;
      rollNumber: number;
      rollType: RollType;
      wonPacket: Uint8Array;
      rollPackets: Uint8Array[];
    }
  | {
      kind: "all_passed";
      packet: Uint8Array;
    };

export type StartLootResult = {
  items: LootItemState[];
  rolls: ActiveRoll[];
  /** SMSG_LOOT_START_ROLL bodies keyed by itemGuid (shared mask), or per-player for NBG */
  startRollPackets: Map<bigint, Uint8Array | Map<bigint, Uint8Array>>;
  /** SMSG_LOOT_MASTER_LIST body when method is master loot */
  masterListPacket: Uint8Array | null;
  roundRobinGuid: bigint | null;
};

function defaultRng(): number {
  return 1 + Math.floor(Math.random() * 100);
}

function assertLootMethod(method: LootMethod): void {
  switch (method) {
    case FREE_FOR_ALL:
    case ROUND_ROBIN:
    case MASTER_LOOT:
    case GROUP_LOOT:
    case NEED_BEFORE_GREED:
      return;
    default: {
      const _exhaustive: never = method;
      void _exhaustive;
      throw new Error(`unknown loot method: ${method as number}`);
    }
  }
}

function assertRollType(choice: RollType): void {
  switch (choice) {
    case ROLL_PASS:
    case ROLL_NEED:
    case ROLL_GREED:
    case ROLL_DISENCHANT:
      return;
    default: {
      const _exhaustive: never = choice;
      void _exhaustive;
      throw new Error(`unknown roll type: ${choice as number}`);
    }
  }
}

/** Permission a viewer gets when opening loot for this method. */
export function permissionForMethod(method: LootMethod, viewerIsMasterLooter: boolean): PermissionTypes {
  assertLootMethod(method);
  switch (method) {
    case MASTER_LOOT:
      return viewerIsMasterLooter ? MASTER_PERMISSION : RESTRICTED_PERMISSION;
    case FREE_FOR_ALL:
      return ALL_PERMISSION;
    case ROUND_ROBIN:
      return ROUND_ROBIN_PERMISSION;
    case GROUP_LOOT:
    case NEED_BEFORE_GREED:
      return GROUP_PERMISSION;
    default: {
      const _exhaustive: never = method;
      return _exhaustive;
    }
  }
}

/** Slot type shown for a blocked over-threshold item under master loot. */
export function masterSlotType(viewerIsMasterLooter: boolean): LootSlotType {
  return viewerIsMasterLooter ? LOOT_SLOT_TYPE_MASTER : LOOT_SLOT_TYPE_LOCKED;
}

export function buildLootStartRoll(args: {
  itemGuid: bigint;
  mapId: number;
  slot: number;
  itemId: number;
  randomSuffix: number;
  randomPropId: number;
  count: number;
  countdownMs: number;
  rollVoteMask: number;
}): Uint8Array {
  return new ByteWriter()
    .writeU64(args.itemGuid)
    .writeU32(args.mapId)
    .writeU32(args.slot)
    .writeU32(args.itemId)
    .writeU32(args.randomSuffix)
    .writeU32(args.randomPropId)
    .writeU32(args.count)
    .writeU32(args.countdownMs)
    .writeU8(args.rollVoteMask)
    .toUint8Array();
}

export function buildLootRoll(args: {
  sourceGuid: bigint;
  slot: number;
  targetGuid: bigint;
  itemId: number;
  randomSuffix: number;
  randomPropId: number;
  rollNumber: number;
  rollType: number;
  autoPass?: boolean;
}): Uint8Array {
  return new ByteWriter()
    .writeU64(args.sourceGuid)
    .writeU32(args.slot)
    .writeU64(args.targetGuid)
    .writeU32(args.itemId)
    .writeU32(args.randomSuffix)
    .writeU32(args.randomPropId)
    .writeU8(args.rollNumber)
    .writeU8(args.rollType)
    .writeU8(args.autoPass ? 1 : 0)
    .toUint8Array();
}

export function buildLootRollWon(args: {
  sourceGuid: bigint;
  slot: number;
  itemId: number;
  randomSuffix: number;
  randomPropId: number;
  winnerGuid: bigint;
  rollNumber: number;
  rollType: number;
}): Uint8Array {
  return new ByteWriter()
    .writeU64(args.sourceGuid)
    .writeU32(args.slot)
    .writeU32(args.itemId)
    .writeU32(args.randomSuffix)
    .writeU32(args.randomPropId)
    .writeU64(args.winnerGuid)
    .writeU8(args.rollNumber)
    .writeU8(args.rollType)
    .toUint8Array();
}

export function buildLootAllPassed(args: {
  itemGuid: bigint;
  slot: number;
  itemId: number;
  randomPropId: number;
  randomSuffix: number;
}): Uint8Array {
  // C++ writes prop then suffix (opposite of start/roll order)
  return new ByteWriter()
    .writeU64(args.itemGuid)
    .writeU32(args.slot)
    .writeU32(args.itemId)
    .writeU32(args.randomPropId)
    .writeU32(args.randomSuffix)
    .toUint8Array();
}

export function buildLootMasterList(looterGuids: readonly bigint[]): Uint8Array {
  const w = new ByteWriter().writeU8(looterGuids.length);
  for (const guid of looterGuids) {
    w.writeU64(guid);
  }
  return w.toUint8Array();
}

function firstInRange(members: readonly LootMember[]): bigint | null {
  for (const m of members) {
    if (m.inRange) {
      return m.guid;
    }
  }
  return null;
}

/**
 * Advance past `current` to the next in-range member (wraps). Matches `Group::UpdateLooterGuid`.
 * Returns null when nobody in range.
 */
export function nextRoundRobinGuid(
  members: readonly LootMember[],
  current: bigint | null,
): bigint | null {
  if (members.length === 0) {
    return null;
  }
  let start = 0;
  if (current !== null) {
    const idx = members.findIndex((m) => m.guid === current);
    start = idx >= 0 ? idx + 1 : 0;
  }
  for (let i = 0; i < members.length; i += 1) {
    const m = members[(start + i) % members.length]!;
    if (m.inRange) {
      return m.guid;
    }
  }
  return null;
}

function baseVoteMask(item: LootItemInput, method: LootMethod): number {
  let mask = ROLL_ALL_TYPE_NO_DISENCHANT;
  if (item.canDisenchant) {
    mask |= ROLL_FLAG_TYPE_DISENCHANT;
  }
  if (method === NEED_BEFORE_GREED && item.greedOnly) {
    mask &= ~ROLL_FLAG_TYPE_NEED;
  }
  return mask;
}

function voteMaskForPlayer(base: number, method: LootMethod, member: LootMember): number {
  if (method !== NEED_BEFORE_GREED) {
    return base;
  }
  if (member.canNeed === false) {
    return base & ~ROLL_FLAG_TYPE_NEED;
  }
  return base;
}

export type StartLootArgs = {
  method: LootMethod;
  threshold: ItemQuality;
  members: readonly LootMember[];
  items: readonly LootItemInput[];
  mapId?: number;
  countdownMs?: number;
  masterLooterGuid?: bigint;
  /** Current round-robin owner; defaults to first in-range member */
  roundRobinGuid?: bigint | null;
  rng?: RollRng;
};

/**
 * Classify items and open rolls / master list for one loot window.
 * Under-threshold items use round robin (or FFA). At-or-above threshold use the method's roll/ML path.
 */
export function startLoot(args: StartLootArgs): StartLootResult {
  assertLootMethod(args.method);
  const mapId = args.mapId ?? 0;
  const countdownMs = args.countdownMs ?? DEFAULT_COUNTDOWN_MS;
  const inRange = args.members.filter((m) => m.inRange);
  let roundRobinGuid =
    args.roundRobinGuid !== undefined ? args.roundRobinGuid : firstInRange(args.members);

  const items: LootItemState[] = [];
  const rolls: ActiveRoll[] = [];
  const startRollPackets = new Map<bigint, Uint8Array | Map<bigint, Uint8Array>>();
  let masterListPacket: Uint8Array | null = null;

  for (const input of args.items) {
    const under = input.quality < args.threshold;
    const state: LootItemState = {
      itemGuid: input.itemGuid,
      itemId: input.itemId,
      quality: input.quality,
      slot: input.slot,
      count: input.count ?? 1,
      randomSuffix: input.randomSuffix ?? 0,
      randomPropId: input.randomPropId ?? 0,
      greedOnly: input.greedOnly ?? false,
      canDisenchant: input.canDisenchant ?? false,
      isUnderthreshold: under,
      isBlocked: false,
      winnerGuid: null,
    };

    switch (args.method) {
      case FREE_FOR_ALL:
        // Anyone may take; no rolls.
        break;
      case ROUND_ROBIN:
        // All items are round-robin owned; nothing blocked.
        break;
      case MASTER_LOOT:
        // Over-threshold blocked for master assignment; underthreshold stay RR.
        if (!under) {
          state.isBlocked = true;
        }
        break;
      case GROUP_LOOT:
      case NEED_BEFORE_GREED:
        if (!under && inRange.length > 0) {
          state.isBlocked = true;
          const mask = baseVoteMask(input, args.method);
          const playerVote = new Map<bigint, RollVote>();
          for (const m of inRange) {
            playerVote.set(m.guid, NOT_EMITED_YET);
          }
          const roll: ActiveRoll = {
            itemGuid: input.itemGuid,
            itemId: input.itemId,
            slot: input.slot,
            count: state.count,
            randomSuffix: state.randomSuffix,
            randomPropId: state.randomPropId,
            rollVoteMask: mask,
            playerVote,
            totalPlayersRolling: inRange.length,
            totalNeed: 0,
            totalGreed: 0,
            totalPass: 0,
            resolved: false,
          };
          rolls.push(roll);

          if (args.method === NEED_BEFORE_GREED) {
            const perPlayer = new Map<bigint, Uint8Array>();
            for (const m of inRange) {
              perPlayer.set(
                m.guid,
                buildLootStartRoll({
                  itemGuid: input.itemGuid,
                  mapId,
                  slot: input.slot,
                  itemId: input.itemId,
                  randomSuffix: state.randomSuffix,
                  randomPropId: state.randomPropId,
                  count: state.count,
                  countdownMs,
                  rollVoteMask: voteMaskForPlayer(mask, args.method, m),
                }),
              );
            }
            startRollPackets.set(input.itemGuid, perPlayer);
          } else {
            startRollPackets.set(
              input.itemGuid,
              buildLootStartRoll({
                itemGuid: input.itemGuid,
                mapId,
                slot: input.slot,
                itemId: input.itemId,
                randomSuffix: state.randomSuffix,
                randomPropId: state.randomPropId,
                count: state.count,
                countdownMs,
                rollVoteMask: mask,
              }),
            );
          }
        } else if (!under) {
          // No one in range to roll — leave lootable (matches empty roller delete path).
          state.isUnderthreshold = false;
        }
        break;
      default: {
        const _exhaustive: never = args.method;
        void _exhaustive;
      }
    }

    items.push(state);
  }

  if (args.method === MASTER_LOOT) {
    masterListPacket = buildLootMasterList(inRange.map((m) => m.guid));
  }

  if (args.method === FREE_FOR_ALL) {
    roundRobinGuid = null;
  }

  return { items, rolls, startRollPackets, masterListPacket, roundRobinGuid };
}

/**
 * Mutable loot window state for votes, resolve, whoReceives, and round-robin advance.
 */
export class LootMethods {
  readonly method: LootMethod;
  readonly threshold: ItemQuality;
  readonly members: readonly LootMember[];
  readonly masterLooterGuid: bigint | null;
  readonly mapId: number;
  readonly countdownMs: number;
  private readonly rng: RollRng;
  items: LootItemState[];
  rolls: Map<bigint, ActiveRoll>;
  roundRobinGuid: bigint | null;
  masterListPacket: Uint8Array | null;
  startRollPackets: Map<bigint, Uint8Array | Map<bigint, Uint8Array>>;

  constructor(args: StartLootArgs) {
    const started = startLoot(args);
    this.method = args.method;
    this.threshold = args.threshold;
    this.members = args.members;
    this.masterLooterGuid = args.masterLooterGuid ?? null;
    this.mapId = args.mapId ?? 0;
    this.countdownMs = args.countdownMs ?? DEFAULT_COUNTDOWN_MS;
    this.rng = args.rng ?? defaultRng;
    this.items = started.items;
    this.rolls = new Map(started.rolls.map((r) => [r.itemGuid, r]));
    this.roundRobinGuid = started.roundRobinGuid;
    this.masterListPacket = started.masterListPacket;
    this.startRollPackets = started.startRollPackets;
  }

  item(itemGuid: bigint): LootItemState | undefined {
    return this.items.find((i) => i.itemGuid === itemGuid);
  }

  roll(itemGuid: bigint): ActiveRoll | undefined {
    return this.rolls.get(itemGuid);
  }

  permission(viewerGuid: bigint): PermissionTypes {
    const isMaster = this.masterLooterGuid !== null && viewerGuid === this.masterLooterGuid;
    return permissionForMethod(this.method, isMaster);
  }

  /**
   * Who may take this item right now.
   * - FFA: `"any"`
   * - Round robin / underthreshold group paths: current RR player
   * - Master over-threshold: master looter only
   * - Active roll: `"rolling"`
   * - After win: winner guid
   */
  whoReceives(itemGuid: bigint): "any" | "rolling" | bigint | null {
    const item = this.item(itemGuid);
    if (!item) {
      return null;
    }
    if (item.winnerGuid !== null) {
      return item.winnerGuid;
    }
    const active = this.rolls.get(itemGuid);
    if (active && !active.resolved) {
      return "rolling";
    }

    switch (this.method) {
      case FREE_FOR_ALL:
        return "any";
      case ROUND_ROBIN:
        return this.roundRobinGuid;
      case MASTER_LOOT:
        if (!item.isUnderthreshold) {
          return this.masterLooterGuid;
        }
        return this.roundRobinGuid;
      case GROUP_LOOT:
      case NEED_BEFORE_GREED:
        if (item.isBlocked) {
          return "rolling";
        }
        if (!item.isUnderthreshold && item.winnerGuid === null) {
          // Unblocked over-threshold with no winner → free for group (all-passed path)
          return "any";
        }
        return this.roundRobinGuid;
      default: {
        const _exhaustive: never = this.method;
        return _exhaustive;
      }
    }
  }

  /** Whether `playerGuid` may loot/take/assign this item now. */
  canTake(playerGuid: bigint, itemGuid: bigint): boolean {
    const who = this.whoReceives(itemGuid);
    if (who === "rolling" || who === null) {
      return false;
    }
    if (who === "any") {
      return this.members.some((m) => m.guid === playerGuid && m.inRange);
    }
    return who === playerGuid;
  }

  /**
   * Record a player's vote. Auto-resolves when everyone has voted.
   * Returns the vote broadcast packet and optional outcome.
   */
  vote(
    itemGuid: bigint,
    playerGuid: bigint,
    choice: RollType,
  ): { broadcast: VoteBroadcast; outcome: RollOutcome | null } | null {
    assertRollType(choice);
    const roll = this.rolls.get(itemGuid);
    if (!roll || roll.resolved) {
      return null;
    }
    const current = roll.playerVote.get(playerGuid);
    if (current === undefined || current !== NOT_EMITED_YET) {
      return null;
    }

    const item = this.item(itemGuid);
    if (!item) {
      return null;
    }

    let rollNumber = 128;
    let rollType: number = choice;
    switch (choice) {
      case ROLL_PASS:
        roll.totalPass += 1;
        roll.playerVote.set(playerGuid, PASS);
        rollType = ROLL_PASS;
        break;
      case ROLL_NEED: {
        // CountRollVote sends rollNumber=0, rollType=0 for the need selection announce
        rollNumber = 0;
        rollType = 0;
        roll.totalNeed += 1;
        roll.playerVote.set(playerGuid, NEED);
        break;
      }
      case ROLL_GREED:
        roll.totalGreed += 1;
        roll.playerVote.set(playerGuid, GREED);
        rollType = ROLL_GREED;
        break;
      case ROLL_DISENCHANT:
        roll.totalGreed += 1;
        roll.playerVote.set(playerGuid, DISENCHANT);
        rollType = ROLL_DISENCHANT;
        break;
      default: {
        const _exhaustive: never = choice;
        return _exhaustive;
      }
    }

    const packet = buildLootRoll({
      sourceGuid: 0n,
      slot: roll.slot,
      targetGuid: playerGuid,
      itemId: roll.itemId,
      randomSuffix: roll.randomSuffix,
      randomPropId: roll.randomPropId,
      rollNumber,
      rollType,
    });

    const broadcast: VoteBroadcast = { kind: "vote", packet, playerGuid, choice };
    let outcome: RollOutcome | null = null;
    if (roll.totalPass + roll.totalNeed + roll.totalGreed >= roll.totalPlayersRolling) {
      outcome = this.countTheRoll(itemGuid);
    }
    return { broadcast, outcome };
  }

  /**
   * End the roll: anyone still `NOT_EMITED_YET` auto-passes (timeout / `Group::EndRoll`).
   */
  resolve(itemGuid: bigint, timedOut = true): RollOutcome | null {
    const roll = this.rolls.get(itemGuid);
    if (!roll || roll.resolved) {
      return null;
    }
    if (timedOut) {
      for (const [guid, vote] of roll.playerVote) {
        if (vote !== NOT_EMITED_YET) {
          continue;
        }
        roll.playerVote.set(guid, PASS);
        roll.totalPass += 1;
        // EndRoll sends pass with source = itemGUID
        void buildLootRoll({
          sourceGuid: roll.itemGuid,
          slot: roll.slot,
          targetGuid: guid,
          itemId: roll.itemId,
          randomSuffix: roll.randomSuffix,
          randomPropId: roll.randomPropId,
          rollNumber: 128,
          rollType: ROLL_PASS,
        });
      }
    }
    return this.countTheRoll(itemGuid);
  }

  /**
   * Master looter assigns an over-threshold item. Only the master may call this.
   */
  assignMasterLoot(masterGuid: bigint, itemGuid: bigint, targetGuid: bigint): boolean {
    if (this.method !== MASTER_LOOT) {
      return false;
    }
    if (this.masterLooterGuid === null || masterGuid !== this.masterLooterGuid) {
      return false;
    }
    const item = this.item(itemGuid);
    if (!item || item.isUnderthreshold || !item.isBlocked) {
      return false;
    }
    if (!this.members.some((m) => m.guid === targetGuid && m.inRange)) {
      return false;
    }
    item.isBlocked = false;
    item.winnerGuid = targetGuid;
    return true;
  }

  /**
   * Take an underthreshold / FFA / RR item. Advances round robin when the current RR player wins one.
   */
  takeItem(playerGuid: bigint, itemGuid: bigint): boolean {
    if (!this.canTake(playerGuid, itemGuid)) {
      return false;
    }
    const item = this.item(itemGuid);
    if (!item || item.winnerGuid !== null) {
      return false;
    }
    item.winnerGuid = playerGuid;
    item.isBlocked = false;

    const advancesRr =
      this.method !== FREE_FOR_ALL &&
      (this.method === ROUND_ROBIN || item.isUnderthreshold) &&
      this.roundRobinGuid === playerGuid;

    if (advancesRr) {
      this.roundRobinGuid = nextRoundRobinGuid(this.members, playerGuid);
    }
    return true;
  }

  /** `Group::CountTheRoll` — NEED pool first, then GREED+DISENCHANT; ties keep first max (`maxresul < randomN`). */
  private countTheRoll(itemGuid: bigint): RollOutcome | null {
    const roll = this.rolls.get(itemGuid);
    const item = this.item(itemGuid);
    if (!roll || !item || roll.resolved) {
      return null;
    }
    roll.resolved = true;

    if (roll.totalNeed > 0) {
      let maxResult = 0;
      let maxGuid = 0n;
      const rollPackets: Uint8Array[] = [];
      for (const [guid, vote] of roll.playerVote) {
        if (vote !== NEED) {
          continue;
        }
        const randomN = this.clampRoll(this.rng());
        rollPackets.push(
          buildLootRoll({
            sourceGuid: 0n,
            slot: roll.slot,
            targetGuid: guid,
            itemId: roll.itemId,
            randomSuffix: roll.randomSuffix,
            randomPropId: roll.randomPropId,
            rollNumber: randomN,
            rollType: ROLL_NEED,
          }),
        );
        if (maxResult < randomN) {
          maxGuid = guid;
          maxResult = randomN;
        }
      }
      if (maxGuid !== 0n) {
        item.isBlocked = false;
        item.winnerGuid = maxGuid;
        const wonPacket = buildLootRollWon({
          sourceGuid: roll.itemGuid,
          slot: roll.slot,
          itemId: roll.itemId,
          randomSuffix: roll.randomSuffix,
          randomPropId: roll.randomPropId,
          winnerGuid: maxGuid,
          rollNumber: maxResult,
          rollType: ROLL_NEED,
        });
        return { kind: "won", winnerGuid: maxGuid, rollNumber: maxResult, rollType: ROLL_NEED, wonPacket, rollPackets };
      }
    }

    if (roll.totalGreed > 0) {
      let maxResult = 0;
      let maxGuid = 0n;
      let rollVote: RollVote = NOT_VALID;
      const rollPackets: Uint8Array[] = [];
      for (const [guid, vote] of roll.playerVote) {
        if (vote !== GREED && vote !== DISENCHANT) {
          continue;
        }
        const randomN = this.clampRoll(this.rng());
        rollPackets.push(
          buildLootRoll({
            sourceGuid: 0n,
            slot: roll.slot,
            targetGuid: guid,
            itemId: roll.itemId,
            randomSuffix: roll.randomSuffix,
            randomPropId: roll.randomPropId,
            rollNumber: randomN,
            rollType: vote,
          }),
        );
        if (maxResult < randomN) {
          maxGuid = guid;
          maxResult = randomN;
          rollVote = vote;
        }
      }
      if (maxGuid !== 0n && (rollVote === GREED || rollVote === DISENCHANT)) {
        item.isBlocked = false;
        item.winnerGuid = maxGuid;
        const wonType: RollType = rollVote;
        const wonPacket = buildLootRollWon({
          sourceGuid: roll.itemGuid,
          slot: roll.slot,
          itemId: roll.itemId,
          randomSuffix: roll.randomSuffix,
          randomPropId: roll.randomPropId,
          winnerGuid: maxGuid,
          rollNumber: maxResult,
          rollType: wonType,
        });
        return { kind: "won", winnerGuid: maxGuid, rollNumber: maxResult, rollType: wonType, wonPacket, rollPackets };
      }
    }

    // All passed — unblock so anyone in the group may loot
    item.isBlocked = false;
    const packet = buildLootAllPassed({
      itemGuid: roll.itemGuid,
      slot: roll.slot,
      itemId: roll.itemId,
      randomPropId: roll.randomPropId,
      randomSuffix: roll.randomSuffix,
    });
    return { kind: "all_passed", packet };
  }

  private clampRoll(n: number): number {
    const v = Math.floor(n);
    if (v < 1) {
      return 1;
    }
    if (v > 100) {
      return 100;
    }
    return v;
  }
}
