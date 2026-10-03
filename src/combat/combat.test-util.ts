/**
 * Test helpers for the combat code over the map layer: a real `SessionMapPlayer` (the object a creature chases and the one
 * that receives what the creature broadcasts) over a stub `WorldSession`, the `CombatPlayer` that wraps it, and the melee stats.
 * Not a test file itself.
 */
import { Loot } from "../loot/loot.ts";
import type { MovementOwner } from "../game/Movement/MovementOwner.ts";
import { MOVEMENTFLAG_FORWARD } from "../game/Entities/Unit/UnitDefines.ts";
import { addToMap, relocateOnMap, showWorld } from "../world/session-map.ts";
import { SessionMapPlayer } from "../world/session-map-player.ts";
import type { WorldSession } from "../world/session.ts";
import { SMSG_UPDATE_OBJECT } from "./constants.ts";
import type { CombatPlayer, CombatWorld, CreatureKill, PlayerMelee } from "./combat-world.ts";
import type { FactionTemplate } from "./faction.ts";

/** The part of a `WorldSession` the map player reads, with the packets it sends recorded. */
export class StubSession {
  character: Record<string, number | string> & { guid: number; name: string; map: number; position_x: number; position_y: number; position_z: number; orientation: number };
  clientMoveTime = 0;
  standState = 0;
  mapPlayer: SessionMapPlayer | null = null;
  moveFlags = 0;
  deathState = "alive";
  health = 100;
  pendingTeleport = null;
  unit = null;
  playerFacade = null;
  combat: CombatWorld | null = null;
  readonly packets: { opcode: number; payload: Uint8Array }[] = [];

  constructor(guid: number, x: number, y: number, z: number, o = 0, map = 0) {
    this.character = {
      guid,
      name: `player${guid}`,
      map,
      position_x: x,
      position_y: y,
      position_z: z,
      orientation: o,
      race: 1,
      class: 1,
      gender: 0,
      level: 1,
      health: 100,
      skin: 0,
      face: 0,
      hairStyle: 0,
      hairColor: 0,
      facialStyle: 0,
    };
  }

  publicFieldStats(): undefined {
    return undefined;
  }

  sendPacket(opcode: number, payload: Uint8Array): void {
    this.packets.push({ opcode, payload });
  }

  getSessionDbLocaleIndex(): number {
    return 0;
  }

  /** The payloads of one opcode this player received. */
  payloads(opcode: number): Uint8Array[] {
    return this.packets.filter((packet) => packet.opcode === opcode).map((packet) => packet.payload);
  }

  /** The number of packets of one opcode this player received. */
  count(opcode: number): number {
    return this.packets.filter((packet) => packet.opcode === opcode).length;
  }

  asSession(): WorldSession {
    return this as unknown as WorldSession;
  }
}

/** A player that entered the world at a place (`addToMap`, `showWorld`): the map object and the stub session behind it. */
export function joinWorld(guid: number, x: number, y: number, z: number, combat: CombatWorld | null = null): { session: StubSession; player: SessionMapPlayer } {
  const session = new StubSession(guid, x, y, z);
  session.combat = combat;
  if (!addToMap(session.asSession())) throw new Error("the test player could not join the map");
  showWorld(session.asSession());
  return { session, player: session.mapPlayer! };
}

/** The player moves (a movement packet: the character row and `Map::PlayerRelocation`; `forward` sets the client's moving flag). */
export function movePlayer(session: StubSession, x: number, y: number, z: number, o = session.character.orientation, forward = false): void {
  session.character.position_x = x;
  session.character.position_y = y;
  session.character.position_z = z;
  session.character.orientation = o;
  session.moveFlags = forward ? MOVEMENTFLAG_FORWARD : 0;
  relocateOnMap(session.asSession());
}

export function factionTemplate(id: number, faction: number, ourMask: number, friendlyMask: number, hostileMask: number): FactionTemplate {
  return { id, faction, flags: 1, ourMask, friendlyMask, hostileMask, enemyFaction: [0, 0, 0, 0], friendFaction: [0, 0, 0, 0] };
}

export function melee(overrides: Partial<PlayerMelee> = {}): PlayerMelee {
  return {
    attackTime: () => 2000,
    hasOffhand: false,
    damage: () => ({ min: 20, max: 20, school: 0 }),
    crit: () => 0,
    weaponSkill: () => 5,
    maxSkill: 5,
    defenseSkill: 5,
    expertiseReduction: () => 0,
    modMeleeHitChance: 100,
    armorPenetrationPct: 0,
    dodge: 0,
    parry: 0,
    block: 0,
    blockValue: 0,
    armor: 0,
    missFromDefense: 0,
    critTakenReduction: 0,
    canParry: false,
    canBlock: false,
    usesRage: true,
    ...overrides,
  };
}

export type TestCombatPlayer = CombatPlayer & {
  sent: number[];
  updates: Uint8Array[];
  place: { map: number; x: number; y: number; z: number; o: number };
  hp: number;
  dead: boolean;
  combat: boolean[];
  kills: CreatureKill[];
  known: Set<bigint>;
  /** The stub session of the player on the map (`null` when the player is not on one). */
  session: StubSession | null;
};

/**
 * A `CombatPlayer` over a player on the map (`session`) or without one. `place` reads and writes the map player's position, so a
 * test that sets `place` moves the player a creature chases.
 */
export function testCombatPlayer(guid: number, place: { x: number; y: number; z: number; o: number }, stats: PlayerMelee = melee(), session: StubSession | null = null): TestCombatPlayer {
  let stored = { map: 0, ...place };
  const player: TestCombatPlayer = {
    guid,
    sent: [],
    updates: [],
    get place() {
      if (!session) return stored;
      const c = session.character;
      return { map: c.map, x: c.position_x, y: c.position_y, z: c.position_z, o: c.orientation };
    },
    set place(value) {
      stored = value;
      if (session) movePlayer(session, value.x, value.y, value.z, value.o);
    },
    hp: 100,
    dead: false,
    combat: [],
    kills: [],
    known: new Set(),
    session,
    name: () => `player${guid}`,
    position: () => player.place,
    level: () => 1,
    race: () => 1,
    classId: () => 1,
    factionTemplate: () => 1,
    reputation: () => null,
    alive: () => !player.dead,
    gameMaster: () => false,
    sitting: () => false,
    standUp: () => {},
    moving: () => false,
    mounted: () => false,
    knows: (g) => player.known.has(g) || (session?.mapPlayer?.haveAtClient(g) ?? false),
    mapObject: () => (session?.mapPlayer?.isInWorld() ? (session.mapPlayer as unknown as MovementOwner) : null),
    send: (opcode, body) => {
      player.sent.push(opcode);
      if (opcode === SMSG_UPDATE_OBJECT) {
        player.updates.push(body);
      }
    },
    broadcast: () => {},
    health: () => player.hp,
    melee: () => stats,
    takeDamage: (amount) => {
      player.hp = Math.max(0, player.hp - amount);
      player.dead = player.hp === 0;
      return player.dead;
    },
    addRage: () => {},
    setInCombat: (on) => player.combat.push(on),
    killedCreature: (kill) => {
      player.kills.push(kill);
      // A corpse with money on it (`Loot::generateMoneyLoot`).
      const loot = new Loot({ itemProto: () => null, enchSuffixFactor: () => 0, randomPropertyId: () => 0 });
      loot.gold = 5;
      return loot;
    },
    combatSkill: () => {},
  };
  return player;
}
