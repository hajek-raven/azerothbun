import { creatureStatLevel, generateCreatureStats } from "../data/creature-stats.ts";
import type { CreatureSpawn, CreatureTemplate, GameObjectSpawn, GameObjectTemplate, ItemTemplate, WorldData } from "../data/world.ts";
import { creatureFlags, creatureModel, creatureQueryModels, equippedItems } from "../data/world.ts";
import { ByteWriter } from "../net/byte-buffer.ts";
import { packedGuid } from "./update-object.ts";

const OBJECT_END = 0x0006;
const UNIT_END = OBJECT_END + 0x008e;
const GAMEOBJECT_END = OBJECT_END + 0x000c;

const OBJECT_FIELD_GUID = 0x0000;
const OBJECT_FIELD_TYPE = 0x0002;
const OBJECT_FIELD_ENTRY = 0x0003;
const OBJECT_FIELD_SCALE_X = 0x0004;
const UNIT_FIELD_TARGET = OBJECT_END + 0x000c;
const UNIT_FIELD_BYTES_0 = OBJECT_END + 0x0011;
const UNIT_FIELD_HEALTH = OBJECT_END + 0x0012;
const UNIT_FIELD_POWER1 = OBJECT_END + 0x0013;
const UNIT_FIELD_MAXHEALTH = OBJECT_END + 0x001a;
const UNIT_FIELD_MAXPOWER1 = OBJECT_END + 0x001b;
const UNIT_FIELD_LEVEL = OBJECT_END + 0x0030;
const UNIT_FIELD_FACTIONTEMPLATE = OBJECT_END + 0x0031;
const UNIT_VIRTUAL_ITEM_SLOT_ID = OBJECT_END + 0x0032;
const UNIT_FIELD_FLAGS = OBJECT_END + 0x0035;
const UNIT_FIELD_FLAGS_2 = OBJECT_END + 0x0036;
const UNIT_FIELD_BOUNDINGRADIUS = OBJECT_END + 0x003b;
const UNIT_FIELD_COMBATREACH = OBJECT_END + 0x003c;
const UNIT_FIELD_DISPLAYID = OBJECT_END + 0x003d;
const UNIT_FIELD_NATIVEDISPLAYID = OBJECT_END + 0x003e;
const UNIT_FIELD_MINDAMAGE = OBJECT_END + 0x0040;
const UNIT_FIELD_MAXDAMAGE = OBJECT_END + 0x0041;
const UNIT_DYNAMIC_FLAGS = OBJECT_END + 0x0049;
const UNIT_MOD_CAST_SPEED = OBJECT_END + 0x004a;
const UNIT_NPC_FLAGS = OBJECT_END + 0x004c;
const UNIT_FIELD_STAT0 = OBJECT_END + 0x004e;
const UNIT_FIELD_RESISTANCES = OBJECT_END + 0x005d;
const UNIT_FIELD_BYTES_2 = OBJECT_END + 0x0074;
const UNIT_FIELD_ATTACK_POWER = OBJECT_END + 0x0075;
const UNIT_FIELD_HOVERHEIGHT = OBJECT_END + 0x008c;
const GAMEOBJECT_DISPLAYID = OBJECT_END + 0x0002;
const GAMEOBJECT_PARENTROTATION = OBJECT_END + 0x0004;
const GAMEOBJECT_BYTES_1 = OBJECT_END + 0x000b;

const TYPEMASK_UNIT = 0x0009;
const TYPEMASK_GAMEOBJECT = 0x0021;
const TYPEID_UNIT = 3;
const TYPEID_GAMEOBJECT = 5;
const UPDATETYPE_CREATE_OBJECT = 2;
const UPDATETYPE_CREATE_OBJECT2 = 3;
const UPDATEFLAG_LOWGUID = 0x0010;
const UPDATEFLAG_LIVING = 0x0020;
const UPDATEFLAG_STATIONARY_POSITION = 0x0040;
const UPDATEFLAG_POSITION = 0x0100;
const UPDATEFLAG_ROTATION = 0x0200;
const SHEATH_STATE_MELEE = 1;
const HIGHGUID_GAMEOBJECT = 0xf110n;
const HIGHGUID_UNIT = 0xf130n;
const CREATE_OBJECT2_TYPES = new Set([6, 16, 24, 26]);

const BASE_WALK = 2.5;
const BASE_RUN = 7;
const BASE_RUN_BACK = 4.5;
const BASE_SWIM = 4.722222;
const BASE_SWIM_BACK = 2.5;
const BASE_FLIGHT = 7;
const BASE_FLIGHT_BACK = 4.5;
const BASE_TURN = 3.141594;
const BASE_PITCH = 3.14;

export function creatureGuid(entry: number, counter: number): bigint {
  return BigInt(counter) | (BigInt(entry) << 24n) | (HIGHGUID_UNIT << 48n);
}

export function gameObjectGuid(entry: number, counter: number): bigint {
  return BigInt(counter) | (BigInt(entry) << 24n) | (HIGHGUID_GAMEOBJECT << 48n);
}

/** Runtime overrides for a creature's create block (health, position, flags). `hidden` removes it from view. */
export type LiveCreatureView = {
  hidden: boolean;
  health: number;
  x: number;
  y: number;
  z: number;
  o: number;
  unitFlags: number;
  dynamicFlags: number;
  npcFlags: number;
  target: bigint;
  /** Fields a command set on the creature (`SetDisplayId`, `SetFaction`, …), written over the template values. */
  fields?: readonly { index: number; value: number }[];
};

export function creatureQueryPayload(world: WorldData, entry: number): Uint8Array {
  const template = world.creatureTemplate(entry);
  if (!template) {
    return new ByteWriter().writeU32(entry | 0x80000000).toUint8Array();
  }
  const models = creatureQueryModels(template);
  const body = new ByteWriter()
    .writeU32(entry)
    .writeCString(template.name)
    .writeU8(0)
    .writeU8(0)
    .writeU8(0)
    .writeCString(template.subName)
    .writeCString(template.iconName)
    .writeU32(template.typeFlags)
    .writeU32(template.type)
    .writeU32(template.family)
    .writeU32(template.rank)
    .writeU32(template.killCredit[0])
    .writeU32(template.killCredit[1]);
  for (const displayId of models) {
    body.writeU32(displayId);
  }
  body.writeF32(template.healthMod).writeF32(template.manaMod).writeU8(template.racialLeader);
  for (const item of world.questItems("creature", entry)) {
    body.writeU32(item);
  }
  return body.writeU32(template.movementId).toUint8Array();
}

export function gameObjectQueryPayload(world: WorldData, entry: number): Uint8Array {
  const template = world.gameObjectTemplate(entry);
  if (!template) {
    return new ByteWriter().writeU32(entry | 0x80000000).toUint8Array();
  }
  const body = new ByteWriter()
    .writeU32(entry)
    .writeU32(template.type)
    .writeU32(template.displayId)
    .writeCString(template.name)
    .writeU8(0)
    .writeU8(0)
    .writeU8(0)
    .writeCString(template.iconName)
    .writeCString(template.castBarCaption)
    .writeCString(template.unk1);
  for (let index = 0; index < 24; index++) {
    body.writeU32(template.data[index] ?? 0);
  }
  body.writeF32(template.size > 0 ? template.size : 1);
  for (const item of world.questItems("gameobject", entry)) {
    body.writeU32(item);
  }
  return body.toUint8Array();
}

export function itemQueryPayload(world: WorldData, entry: number): Uint8Array {
  const item = world.itemTemplate(entry);
  if (!item) {
    return new ByteWriter().writeU32(entry | 0x80000000).toUint8Array();
  }
  const body = new ByteWriter()
    .writeU32(item.entry)
    .writeU32(item.classId)
    .writeU32(item.subclass)
    .writeU32(item.soundOverrideSubclass)
    .writeCString(item.name)
    .writeU8(0)
    .writeU8(0)
    .writeU8(0)
    .writeU32(item.displayId)
    .writeU32(item.quality)
    .writeU32(item.flags)
    .writeU32(item.flags2)
    .writeU32(item.buyPrice)
    .writeU32(item.sellPrice)
    .writeU32(item.inventoryType)
    .writeU32(item.allowableClass)
    .writeU32(item.allowableRace)
    .writeU32(item.itemLevel)
    .writeU32(item.requiredLevel)
    .writeU32(item.requiredSkill)
    .writeU32(item.requiredSkillRank)
    .writeU32(item.requiredSpell)
    .writeU32(item.requiredHonorRank)
    .writeU32(item.requiredCityRank)
    .writeU32(item.requiredReputationFaction)
    .writeU32(item.requiredReputationRank)
    .writeU32(item.maxCount)
    .writeU32(item.stackable)
    .writeU32(item.containerSlots)
    .writeU32(item.stats.length);
  for (const stat of item.stats) {
    body.writeU32(stat.type).writeU32(stat.value);
  }
  body.writeU32(item.scalingStatDistribution).writeU32(item.scalingStatValue);
  for (let index = 0; index < 2; index++) {
    const damage = item.damages[index];
    body.writeF32(damage?.min ?? 0).writeF32(damage?.max ?? 0).writeU32(damage?.type ?? 0);
  }
  body.writeU32(item.armor);
  for (let index = 0; index < 6; index++) {
    body.writeU32(item.resistances[index] ?? 0);
  }
  body.writeU32(item.delay).writeU32(item.ammoType).writeF32(item.rangedModRange);
  for (let index = 0; index < 5; index++) {
    writeItemSpell(body, item, index);
  }
  body
    .writeU32(item.bonding)
    .writeCString(item.description)
    .writeU32(item.pageText)
    .writeU32(item.languageId)
    .writeU32(item.pageMaterial)
    .writeU32(item.startQuest)
    .writeU32(item.lockId)
    .writeU32(item.material)
    .writeU32(item.sheath)
    .writeU32(item.randomProperty)
    .writeU32(item.randomSuffix)
    .writeU32(item.block)
    .writeU32(item.itemSet)
    .writeU32(item.maxDurability)
    .writeU32(item.area)
    .writeU32(item.map)
    .writeU32(item.bagFamily)
    .writeU32(item.totemCategory);
  for (let index = 0; index < 3; index++) {
    const socket = item.sockets[index];
    body.writeU32(socket?.color ?? 0).writeU32(socket?.content ?? 0);
  }
  return body
    .writeU32(item.socketBonus)
    .writeU32(item.gemProperties)
    .writeU32(item.requiredDisenchantSkill)
    .writeF32(item.armorDamageModifier)
    .writeU32(item.duration)
    .writeU32(item.itemLimitCategory)
    .writeU32(item.holidayId)
    .toUint8Array();
}

/**
 * The map object of a creature as the create block reads it: its movement block (`Object::BuildMovementUpdate`: movement flags, position,
 * speeds, and the spline while it moves).
 */
export interface CreatureMovementSource {
  buildMovementUpdate(data: ByteWriter): void;
}

export function creatureCreateBlock(
  spawn: CreatureSpawn,
  template: CreatureTemplate,
  world?: WorldData,
  live: LiveCreatureView | null = null,
  movement: CreatureMovementSource | null = null,
): Uint8Array {
  const model = creatureModel(template);
  const stored = template.models.find((row) => row.displayId === model.displayId);
  const scale = model.scale > 0 ? model.scale : 1;
  const items = equippedItems(template, spawn.equipmentId);
  const flags = creatureFlags(template, spawn);
  const level = creatureStatLevel(template.minLevel, template.maxLevel);
  const generated =
    world === undefined
      ? null
      : generateCreatureStats(world.creatureClassLevelStats(level, template.unitClass), {
          expansion: template.expansion,
          healthMod: template.healthMod,
          manaMod: template.manaMod,
          armorMod: template.armorMod,
          rank: template.rank,
        });
  const health = generated ? generated.health : spawn.health > 0 ? spawn.health : 1;
  const mana = generated ? generated.mana : spawn.mana;
  const guid = creatureGuid(spawn.entry, spawn.guid);
  const values = new Uint32Array(UNIT_END);
  setGuid(values, guid);
  values[OBJECT_FIELD_TYPE] = TYPEMASK_UNIT;
  values[OBJECT_FIELD_ENTRY] = spawn.entry;
  setFloat(values, OBJECT_FIELD_SCALE_X, scale);
  values[UNIT_FIELD_BYTES_0] =
    (template.unitClass << 8) | ((stored?.gender ?? 2) << 16) | (powerForClass(template.unitClass) << 24);
  values[UNIT_FIELD_HEALTH] = live ? live.health : health;
  values[UNIT_FIELD_MAXHEALTH] = health;
  if (live && live.target !== 0n) {
    values[UNIT_FIELD_TARGET] = Number(live.target & 0xffffffffn);
    values[UNIT_FIELD_TARGET + 1] = Number((live.target >> 32n) & 0xffffffffn);
  }
  if (mana > 0) {
    values[UNIT_FIELD_POWER1] = mana;
    values[UNIT_FIELD_MAXPOWER1] = mana;
  }
  values[UNIT_FIELD_LEVEL] = level;
  values[UNIT_FIELD_FACTIONTEMPLATE] = template.faction;
  values[UNIT_VIRTUAL_ITEM_SLOT_ID] = items[0];
  values[UNIT_VIRTUAL_ITEM_SLOT_ID + 1] = items[1];
  values[UNIT_VIRTUAL_ITEM_SLOT_ID + 2] = items[2];
  values[UNIT_FIELD_FLAGS] = live ? live.unitFlags : flags.unitFlags;
  values[UNIT_FIELD_FLAGS_2] = template.unitFlags2;
  setFloat(values, UNIT_FIELD_BOUNDINGRADIUS, (stored?.boundingRadius ?? 0) * scale);
  setFloat(values, UNIT_FIELD_COMBATREACH, (stored?.combatReach ?? 0) * scale);
  values[UNIT_FIELD_DISPLAYID] = model.displayId;
  values[UNIT_FIELD_NATIVEDISPLAYID] = model.displayId;
  if (generated) {
    setFloat(values, UNIT_FIELD_MINDAMAGE, generated.minDamage);
    setFloat(values, UNIT_FIELD_MAXDAMAGE, generated.maxDamage);
    for (let index = 0; index < 5; index++) {
      values[UNIT_FIELD_STAT0 + index] = generated.stats[index]!;
    }
    values[UNIT_FIELD_RESISTANCES] = generated.armor;
    for (let school = 1; school < 7; school++) {
      values[UNIT_FIELD_RESISTANCES + school] = template.resistances[school] ?? 0;
    }
    values[UNIT_FIELD_ATTACK_POWER] = generated.attackPower;
  }
  values[UNIT_DYNAMIC_FLAGS] = live ? live.dynamicFlags : flags.dynamicFlags;
  setFloat(values, UNIT_MOD_CAST_SPEED, 1);
  values[UNIT_NPC_FLAGS] = live ? live.npcFlags : flags.npcFlags;
  values[UNIT_FIELD_BYTES_2] = SHEATH_STATE_MELEE;
  setFloat(values, UNIT_FIELD_HOVERHEIGHT, template.hoverHeight > 0 ? template.hoverHeight : 1);
  for (const field of live?.fields ?? []) {
    if (field.index >= 0 && field.index < values.length) values[field.index] = field.value >>> 0;
  }

  const body = new ByteWriter()
    .writeU8(UPDATETYPE_CREATE_OBJECT)
    .writeBytes(packedGuid(guid))
    .writeU8(TYPEID_UNIT)
    .writeU16(UPDATEFLAG_LIVING | UPDATEFLAG_STATIONARY_POSITION);
  if (movement) {
    // the creature of the map: its own flags, position, speeds, and current spline
    movement.buildMovementUpdate(body);
  } else {
    body
      .writeU32(0)
      .writeU16(0)
      .writeU32(Date.now())
      .writeF32(live ? live.x : spawn.x)
      .writeF32(live ? live.y : spawn.y)
      .writeF32(live ? live.z : spawn.z)
      .writeF32(live ? live.o : spawn.orientation)
      .writeU32(0);
    for (const speed of creatureSpeeds(template)) {
      body.writeF32(speed);
    }
  }
  // Dynamic and npc flags stay in the mask even at 0. The client only applies a later
  // lootable / gossip change for a field that was present on the create.
  writeValues(body, values, new Set([UNIT_DYNAMIC_FLAGS, UNIT_NPC_FLAGS]));
  return body.toUint8Array();
}

export function gameObjectCreateBlock(spawn: GameObjectSpawn, template: GameObjectTemplate): Uint8Array {
  const guid = gameObjectGuid(spawn.entry, spawn.guid);
  const rotation = unitQuaternion(spawn.rotation, spawn.orientation);
  const values = new Uint32Array(GAMEOBJECT_END);
  setGuid(values, guid);
  values[OBJECT_FIELD_TYPE] = TYPEMASK_GAMEOBJECT;
  values[OBJECT_FIELD_ENTRY] = spawn.entry;
  setFloat(values, OBJECT_FIELD_SCALE_X, template.size > 0 ? template.size : 1);
  values[GAMEOBJECT_DISPLAYID] = template.displayId;
  setFloat(values, GAMEOBJECT_PARENTROTATION + 3, 1);
  values[GAMEOBJECT_BYTES_1] = (spawn.state & 0xff) | ((template.type & 0xff) << 8) | ((spawn.animProgress & 0xff) << 24);

  const updateType = CREATE_OBJECT2_TYPES.has(template.type) ? UPDATETYPE_CREATE_OBJECT2 : UPDATETYPE_CREATE_OBJECT;
  const body = new ByteWriter()
    .writeU8(updateType)
    .writeBytes(packedGuid(guid))
    .writeU8(TYPEID_GAMEOBJECT)
    .writeU16(UPDATEFLAG_LOWGUID | UPDATEFLAG_STATIONARY_POSITION | UPDATEFLAG_POSITION | UPDATEFLAG_ROTATION)
    .writeU8(0)
    .writeF32(spawn.x)
    .writeF32(spawn.y)
    .writeF32(spawn.z)
    .writeF32(spawn.x)
    .writeF32(spawn.y)
    .writeF32(spawn.z)
    .writeF32(spawn.orientation)
    .writeF32(0)
    .writeU32(spawn.guid)
    .writeU64(packedWorldRotation(rotation));
  writeValues(body, values);
  return body.toUint8Array();
}

function writeItemSpell(body: ByteWriter, item: ItemTemplate, index: number): void {
  const spell = item.spells[index];
  if (!spell || spell.id === 0) {
    body.writeU32(0).writeU32(0).writeU32(0).writeU32(-1).writeU32(0).writeU32(-1);
    return;
  }
  body
    .writeU32(spell.id)
    .writeU32(spell.trigger)
    .writeU32(spell.charges)
    .writeU32(spell.cooldown)
    .writeU32(spell.category)
    .writeU32(spell.categoryCooldown);
}

function creatureSpeeds(template: CreatureTemplate): number[] {
  return [
    BASE_WALK * (template.speedWalk > 0 ? template.speedWalk : 1),
    BASE_RUN * (template.speedRun > 0 ? template.speedRun : 1),
    BASE_RUN_BACK,
    BASE_SWIM * (template.speedSwim > 0 ? template.speedSwim : 1),
    BASE_SWIM_BACK,
    BASE_FLIGHT * (template.speedFlight > 0 ? template.speedFlight : 1),
    BASE_FLIGHT_BACK,
    BASE_TURN,
    BASE_PITCH,
  ];
}

function unitQuaternion(rotation: [number, number, number, number], orientation: number): [number, number, number, number] {
  const [x, y, z, w] = rotation;
  const magnitude = x * x + y * y + z * z + w * w;
  if (magnitude < 1e-8) {
    const half = orientation / 2;
    return [0, 0, Math.sin(half), Math.cos(half)];
  }
  const scale = 1 / Math.sqrt(magnitude);
  return [x * scale, y * scale, z * scale, w * scale];
}

function packedWorldRotation(rotation: [number, number, number, number]): bigint {
  const packYz = 1 << 20;
  const packX = packYz << 1;
  const packYzMask = (packYz << 1) - 1;
  const packXMask = (packX << 1) - 1;
  const sign = rotation[3] >= 0 ? 1 : -1;
  const x = (Math.trunc(rotation[0] * packX) * sign) & packXMask;
  const y = (Math.trunc(rotation[1] * packYz) * sign) & packYzMask;
  const z = (Math.trunc(rotation[2] * packYz) * sign) & packYzMask;
  return BigInt(z) | (BigInt(y) << 21n) | (BigInt(x) << 42n);
}

function powerForClass(classId: number): number {
  if (classId === 1) {
    return 1;
  }
  if (classId === 3) {
    return 2;
  }
  if (classId === 4) {
    return 3;
  }
  if (classId === 6) {
    return 6;
  }
  return 0;
}

function setGuid(values: Uint32Array, guid: bigint): void {
  values[OBJECT_FIELD_GUID] = Number(guid & 0xffffffffn);
  values[OBJECT_FIELD_GUID + 1] = Number((guid >> 32n) & 0xffffffffn);
}

function setFloat(values: Uint32Array, index: number, value: number): void {
  new DataView(values.buffer).setFloat32(index * 4, value, true);
}

function writeValues(body: ByteWriter, values: Uint32Array, force?: ReadonlySet<number>): void {
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
