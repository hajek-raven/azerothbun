import { getColumnTable, gte, max } from "drizzle-orm";
import type { AnyMySqlColumn, MySqlTable } from "drizzle-orm/mysql-core";
import type { Db } from "../../database/database.ts";
import {
  arena_team,
  auctionhouse,
  character_equipmentsets,
  character_inventory,
  characters,
  guild,
  guild_bank_item,
  item_instance,
  log_arena_fights,
  mail,
  mail_items,
} from "../../database/schema/characters.ts";
import { creature, gameobject, transports } from "../../database/schema/world.ts";

/** `ObjectGuidGenerator<high>`: the next free low guid, handed out in order. */
export class ObjectGuidGenerator {
  constructor(
    private readonly name: string,
    private nextGuid = 1,
    private readonly maxCounter = 0xffffffff,
  ) {}

  set(value: number): void {
    this.nextGuid = value;
  }

  generate(): number {
    if (this.nextGuid >= this.maxCounter - 1) {
      // `ObjectGuidGeneratorBase::HandleCounterOverflow`
      throw new Error(`${this.name} guid overflow!! Can't continue, shutting down server.`);
    }
    return this.nextGuid++;
  }

  getNextAfterMaxUsed(): number {
    return this.nextGuid;
  }
}

/** The counters `ObjectMgr` owns and `SetHighestGuids` seeds from the databases. */
export const objectGuids = {
  player: new ObjectGuidGenerator("Player"),
  item: new ObjectGuidGenerator("Item"),
  moTransport: new ObjectGuidGenerator("Mo_Transport"),
  auctionId: new ObjectGuidGenerator("Auction"),
  mailId: new ObjectGuidGenerator("Mail"),
  arenaTeamId: new ObjectGuidGenerator("ArenaTeam"),
  lastArenaLogId: 0,
  equipmentSetGuid: 1n,
  guildId: new ObjectGuidGenerator("Guild"),
  creatureSpawnId: new ObjectGuidGenerator("Creature spawn"),
  gameObjectSpawnId: new ObjectGuidGenerator("GameObject spawn"),
};

/** `ObjectMgr::GenerateEquipmentSetGuid`. */
export function generateEquipmentSetGuid(): bigint {
  if (objectGuids.equipmentSetGuid >= 0xfffffffffffffffen) {
    throw new Error("EquipmentSet guid overflow!! Can't continue, shutting down server.");
  }
  return objectGuids.equipmentSetGuid++;
}

/** `ObjectMgr::SetHighestGuids`. `world` is optional for tools and tests that open only the character database. */
export async function setHighestGuids(characterDb: Db, worldDb: Db | null = null): Promise<void> {
  const top = async (db: Db, column: AnyMySqlColumn): Promise<number | null> => {
    const [row] = await db.select({ value: max(column) }).from(getColumnTable(column) as MySqlTable);
    return row?.value === null || row?.value === undefined ? null : Number(row.value);
  };

  const player = await top(characterDb, characters.guid);
  if (player !== null) objectGuids.player.set(player + 1);
  const item = await top(characterDb, item_instance.guid);
  if (item !== null) objectGuids.item.set(item + 1);

  // Cleanup other tables from not existed guids ( >= _hiItemGuid)
  const nextItem = objectGuids.item.getNextAfterMaxUsed();
  await characterDb.delete(character_inventory).where(gte(character_inventory.item, nextItem));
  await characterDb.delete(mail_items).where(gte(mail_items.item_guid, nextItem));
  await characterDb.delete(auctionhouse).where(gte(auctionhouse.itemguid, nextItem));
  await characterDb.delete(guild_bank_item).where(gte(guild_bank_item.item_guid, nextItem));

  if (worldDb) {
    const transport = await top(worldDb, transports.guid);
    if (transport !== null) objectGuids.moTransport.set(transport + 1);
  }
  const auction = await top(characterDb, auctionhouse.id);
  if (auction !== null) objectGuids.auctionId.set(auction + 1);
  const mailId = await top(characterDb, mail.id);
  if (mailId !== null) objectGuids.mailId.set(mailId + 1);
  const arenaTeam = await top(characterDb, arena_team.arenaTeamId);
  if (arenaTeam !== null) objectGuids.arenaTeamId.set(arenaTeam + 1);
  const arenaLog = await top(characterDb, log_arena_fights.fight_id);
  if (arenaLog !== null) objectGuids.lastArenaLogId = arenaLog;
  const [equipmentSet] = await characterDb.select({ value: max(character_equipmentsets.setguid) }).from(character_equipmentsets);
  if (equipmentSet?.value !== null && equipmentSet?.value !== undefined) objectGuids.equipmentSetGuid = BigInt(equipmentSet.value) + 1n;
  const guildId = await top(characterDb, guild.guildid);
  if (guildId !== null) objectGuids.guildId.set(guildId + 1);
  if (worldDb) {
    const creatureSpawn = await top(worldDb, creature.guid);
    if (creatureSpawn !== null) objectGuids.creatureSpawnId.set(creatureSpawn + 1);
    const gameObjectSpawn = await top(worldDb, gameobject.guid);
    if (gameObjectSpawn !== null) objectGuids.gameObjectSpawnId.set(gameObjectSpawn + 1);
  }
}

/** Counters back to their constructor values (tests). */
export function resetObjectGuids(): void {
  for (const generator of Object.values(objectGuids)) {
    if (generator instanceof ObjectGuidGenerator) generator.set(1);
  }
  objectGuids.lastArenaLogId = 0;
  objectGuids.equipmentSetGuid = 1n;
}

