import { spell_target_position, taxinodes_dbc, taxipath_dbc, taxipathnode_dbc } from "../database/schema/world.ts";
import { WorldTables } from "../database/world-tables.ts";
import { ByteReader } from "../net/byte-buffer.ts";

/** Near vs far matches `Player::TeleportTo`: different map is far. */
export type TeleportStart = {
  map: number;
  x: number;
  y: number;
  z: number;
  orientation: number;
  far: boolean;
};

export type HomebindRow = {
  mapId: number;
  zoneId?: number;
  posX?: number;
  posY?: number;
  posZ?: number;
  x?: number;
  y?: number;
  z?: number;
};

export type SpellTargetPositionRow = {
  ID: number;
  EffectIndex: number;
  MapID: number;
  PositionX: number;
  PositionY: number;
  PositionZ: number;
  Orientation: number;
};

export type TaxiNodeRow = {
  id: number;
  map: number;
  x: number;
  y: number;
  z: number;
};

export type TaxiPathRow = {
  id: number;
  from: number;
  to: number;
  cost: number;
};

export type TaxiPathNodeRow = {
  pathId: number;
  nodeIndex: number;
  map: number;
  x: number;
  y: number;
  z: number;
  flags?: number;
  delay?: number;
};

export type TaxiTeleportStart = TeleportStart & {
  pathId: number;
  sourceNode: number;
  destNode: number;
  cost: number;
  pathNodes: TaxiPathNodeRow[];
};

export type TaxiRecords = {
  nodes: readonly TaxiNodeRow[];
  paths: readonly TaxiPathRow[];
  pathNodes?: readonly TaxiPathNodeRow[];
};

export type CreaturePlace = {
  map: number;
  x: number;
  y: number;
  z: number;
  orientation?: number;
};

export type PlayerPlace = {
  map: number;
  orientation?: number;
};

export type CommandTeleportOk = { ok: true; start: TeleportStart };
export type CommandTeleportErr = { ok: false; error: string };
export type CommandTeleportResult = CommandTeleportOk | CommandTeleportErr;

export type ActivateTaxi = {
  guid: bigint;
  nodes: number[];
};

const SPELL_EFFECT_TELEPORT_UNITS = 5;
const TARGET_DEST_HOME = 9;
const TARGET_DEST_DB = 17;

export function teleportStart(
  map: number,
  x: number,
  y: number,
  z: number,
  orientation: number,
  playerMap: number,
): TeleportStart {
  return {
    map,
    x,
    y,
    z,
    orientation,
    far: map !== playerMap,
  };
}

/**
 * Hearthstone (spell 8690) destination: `TARGET_DEST_HOME` / homebind row.
 * Orientation is 0 here; the caster's live facing is applied when the spell fires.
 */
export function hearthTeleport(homebind: HomebindRow, playerMap: number): TeleportStart {
  const x = homebind.posX ?? homebind.x ?? 0;
  const y = homebind.posY ?? homebind.y ?? 0;
  const z = homebind.posZ ?? homebind.z ?? 0;
  return teleportStart(homebind.mapId, x, y, z, 0, playerMap);
}

/**
 * `EFFECT_TELEPORT_UNITS` with `TARGET_DEST_DB`: coords from `spell_target_position`.
 * Hearth (`TARGET_DEST_HOME`) is `hearthTeleport`, not this path.
 */
export function spellTeleport(
  worldOrRecords: WorldTables | readonly SpellTargetPositionRow[],
  spellId: number,
  player: PlayerPlace,
  spellEffect?: { effect?: number; targetA?: number; targetB?: number } | null,
): TeleportStart | null {
  if (spellEffect) {
    const effect = spellEffect.effect ?? SPELL_EFFECT_TELEPORT_UNITS;
    if (effect !== SPELL_EFFECT_TELEPORT_UNITS) {
      return null;
    }
    const targetA = spellEffect.targetA ?? 0;
    const targetB = spellEffect.targetB ?? 0;
    if (targetA === TARGET_DEST_HOME || targetB === TARGET_DEST_HOME) {
      return null;
    }
    if (targetA !== 0 && targetB !== 0 && targetA !== TARGET_DEST_DB && targetB !== TARGET_DEST_DB) {
      return null;
    }
  }

  const row = findSpellTargetPosition(worldOrRecords, spellId);
  if (!row) {
    return null;
  }
  const orientation = row.Orientation || player.orientation || 0;
  return teleportStart(row.MapID, row.PositionX, row.PositionY, row.PositionZ, orientation, player.map);
}

/**
 * Source→dest taxi path (`ObjectMgr::GetTaxiPath` + destination node).
 * Instant-taxi style destination is the dest node; path nodes are kept for spline flight later.
 */
export function taxiTeleport(
  data: WorldTables | TaxiRecords,
  sourceNode: number,
  destNode: number,
  player: PlayerPlace,
): TaxiTeleportStart | null {
  const path = findTaxiPath(data, sourceNode, destNode);
  if (!path) {
    return null;
  }
  const dest = findTaxiNode(data, destNode);
  if (!dest) {
    return null;
  }
  const pathNodes = findTaxiPathNodes(data, path.id);
  const orientation = player.orientation ?? 0;
  const start = teleportStart(dest.map, dest.x, dest.y, dest.z, orientation, player.map);
  return {
    ...start,
    pathId: path.id,
    sourceNode,
    destNode,
    cost: path.cost,
    pathNodes,
  };
}

/** `CMSG_ACTIVATETAXI`: guid (u64) + source node + dest node. */
export function parseActivateTaxi(payload: Uint8Array): ActivateTaxi {
  const reader = new ByteReader(payload);
  const guid = reader.readU64();
  const nodes = [reader.readU32(), reader.readU32()];
  return { guid, nodes };
}

/** `CMSG_ACTIVATETAXIEXPRESS`: guid (u64) + count + node ids. */
export function parseActivateTaxiExpress(payload: Uint8Array): ActivateTaxi {
  const reader = new ByteReader(payload);
  const guid = reader.readU64();
  const count = reader.readU32();
  const nodes: number[] = [];
  for (let i = 0; i < count; i += 1) {
    nodes.push(reader.readU32());
  }
  return { guid, nodes };
}

/**
 * AzerothCore `cs_go`: `.go xyz <x> <y> [<z>] [<map>] [<o>]` and `.go creature <spawnId>`.
 * Also accepts shorthand `.go <x> <y> <z> [<map>] [<o>]`.
 * Creature coords come from `creature` (caller loads the spawn); spawn id is only validated as present.
 */
export function parseGoCommand(
  args: string,
  player: PlayerPlace,
  creature?: CreaturePlace | null,
): CommandTeleportResult {
  const tokens = tokenizeCommand(args);
  if (tokens.length === 0) {
    return { ok: false, error: "go xyz <x> <y> [<z> [<map> [<o>]]] | go creature <spawnId>" };
  }

  const head = (tokens[0] ?? "").toLowerCase();
  if (head === "creature") {
    return parseGoCreature(tokens.slice(1), player, creature);
  }
  if (head === "xyz") {
    return parseGoXyz(tokens.slice(1), player);
  }
  if (looksLikeNumber(tokens[0])) {
    return parseGoXyz(tokens, player);
  }
  return { ok: false, error: `Unknown go subcommand '${head}'.` };
}

export function commandTeleport(
  args: string,
  player: PlayerPlace,
  creature?: CreaturePlace | null,
): CommandTeleportResult {
  return parseGoCommand(args, player, creature);
}

function findSpellTargetPosition(
  worldOrRecords: WorldTables | readonly SpellTargetPositionRow[],
  spellId: number,
): SpellTargetPositionRow | null {
  if (Array.isArray(worldOrRecords)) {
    const match = worldOrRecords.find((row) => row.ID === spellId);
    return match ?? null;
  }
  const rows = [...(worldOrRecords as WorldTables).where(spell_target_position, "ID", spellId)];
  rows.sort((left, right) => left.EffectIndex - right.EffectIndex);
  return (rows[0] as SpellTargetPositionRow | undefined) ?? null;
}

function findTaxiPath(data: WorldTables | TaxiRecords, source: number, dest: number): TaxiPathRow | null {
  if (!isWorldTables(data)) {
    const match = data.paths.find((path) => path.from === source && path.to === dest);
    return match ?? null;
  }
  const row = data.where(taxipath_dbc, "FromTaxiNode", source).find((path) => path.ToTaxiNode === dest);
  return row ? { id: row.ID, from: row.FromTaxiNode, to: row.ToTaxiNode, cost: row.Cost } : null;
}

function findTaxiNode(data: WorldTables | TaxiRecords, nodeId: number): TaxiNodeRow | null {
  if (!isWorldTables(data)) {
    const match = data.nodes.find((node) => node.id === nodeId);
    return match ?? null;
  }
  const row = data.first(taxinodes_dbc, "ID", nodeId);
  return row ? { id: row.ID, map: row.ContinentID, x: row.X, y: row.Y, z: row.Z } : null;
}

function findTaxiPathNodes(data: WorldTables | TaxiRecords, pathId: number): TaxiPathNodeRow[] {
  if (!isWorldTables(data)) {
    return (data.pathNodes ?? [])
      .filter((node) => node.pathId === pathId)
      .slice()
      .sort((a, b) => a.nodeIndex - b.nodeIndex);
  }
  return data
    .where(taxipathnode_dbc, "PathID", pathId)
    .map((row) => ({
      pathId: row.PathID,
      nodeIndex: row.NodeIndex,
      map: row.ContinentID,
      x: row.LocX,
      y: row.LocY,
      z: row.LocZ,
      flags: row.Flags,
      delay: row.Delay,
    }))
    .sort((a, b) => a.nodeIndex - b.nodeIndex);
}

function isWorldTables(value: WorldTables | TaxiRecords): value is WorldTables {
  return value instanceof WorldTables;
}

function parseGoCreature(
  tokens: string[],
  player: PlayerPlace,
  creature?: CreaturePlace | null,
): CommandTeleportResult {
  if (tokens.length === 0 || !looksLikeNumber(tokens[0])) {
    return { ok: false, error: "go creature <spawnId>" };
  }
  if (!creature) {
    return { ok: false, error: "Creature spawn not found." };
  }
  const orientation = creature.orientation ?? player.orientation ?? 0;
  return {
    ok: true,
    start: teleportStart(creature.map, creature.x, creature.y, creature.z, orientation, player.map),
  };
}

function parseGoXyz(tokens: string[], player: PlayerPlace): CommandTeleportResult {
  const values: number[] = [];
  for (const token of tokens) {
    const value = Number(token);
    if (!Number.isFinite(value)) {
      return { ok: false, error: `Invalid coordinate '${token}'.` };
    }
    values.push(value);
  }
  // X and Y are required (HandleGoXYZCommand).
  if (values.length < 2) {
    return { ok: false, error: "go xyz <x> <y> [<z> [<map> [<o>]]]" };
  }
  const x = values[0]!;
  const y = values[1]!;
  const z = values.length >= 3 ? values[2]! : 0;
  const map = values.length >= 4 ? values[3]! | 0 : player.map;
  const orientation = values.length >= 5 ? values[4]! : (player.orientation ?? 0);
  return { ok: true, start: teleportStart(map, x, y, z, orientation, player.map) };
}

function tokenizeCommand(args: string): string[] {
  let line = args.trim();
  if (line.startsWith(".")) {
    line = line.slice(1).trim();
  }
  const parts = line.split(/\s+/).filter((part) => part.length > 0);
  if (parts.length > 0 && parts[0]!.toLowerCase() === "go") {
    return parts.slice(1);
  }
  return parts;
}

function looksLikeNumber(token: string | undefined): boolean {
  if (token === undefined) {
    return false;
  }
  return Number.isFinite(Number(token));
}
