import { and, asc, eq, sql, type InferSelectModel } from "drizzle-orm";
import { refreshRealmCharacterCount } from "./characters/live.ts";
import { makeRegistrationData } from "./crypto/srp6.ts";
import type { Db } from "./database/database.ts";
import { account, realmlist } from "./database/schema/auth.ts";
import { character_inventory, characters } from "./database/schema/characters.ts";
import type { WorldTables } from "./database/world-tables.ts";
import { objectGuids } from "./game/globals/object-guids.ts";
import { createItem } from "./items/instance.ts";

export const CLIENT_BUILD = 12340;

/** Backpack slots 23–38. Entries are `item_template` rows used to try bags, equip, use, and sell. */
const BAG_TEST_ITEMS = [
  { slot: 23, entry: 2589, count: 5 },
  { slot: 24, entry: 159, count: 5, charges: [-1, 0, 0, 0, 0] },
  { slot: 25, entry: 118, count: 1, charges: [-1, 0, 0, 0, 0] },
  { slot: 26, entry: 6948, count: 1 },
  { slot: 27, entry: 25, count: 1, durability: 20, maxDurability: 20 },
  { slot: 28, entry: 4496, count: 1 },
] as const;

type SeedAccount = {
  username: string;
  password: string;
  character: {
    name: string;
    gender: number;
    skin: number;
    face: number;
    hairStyle: number;
    hairColor: number;
    facialStyle: number;
    position_y: number;
    money?: number;
    bag?: readonly (typeof BAG_TEST_ITEMS)[number][];
  };
};

const SEED_ACCOUNTS: SeedAccount[] = [
  {
    username: "TEST",
    password: "TEST",
    character: { name: "Test", gender: 0, skin: 1, face: 1, hairStyle: 1, hairColor: 1, facialStyle: 0, position_y: -132.493 },
  },
  {
    username: "TEST2",
    password: "TEST2",
    character: { name: "Testtwo", gender: 1, skin: 2, face: 2, hairStyle: 3, hairColor: 4, facialStyle: 1, position_y: -136 },
  },
  {
    username: "TEST3",
    password: "TEST3",
    character: {
      name: "Bagtest",
      gender: 0,
      skin: 4,
      face: 3,
      hairStyle: 5,
      hairColor: 2,
      facialStyle: 2,
      position_y: -140,
      money: 50_000,
      bag: BAG_TEST_ITEMS,
    },
  },
];

/** `acore_auth.account`. */
export type Account = InferSelectModel<typeof account>;

/** `acore_characters.characters`. */
export type Character = InferSelectModel<typeof characters>;

/** `acore_auth.realmlist`. */
export type Realm = InferSelectModel<typeof realmlist>;

export async function findAccount(db: Db, username: string): Promise<Account | null> {
  const [row] = await db.select().from(account).where(eq(account.username, username));
  return row ?? null;
}

/** `LOGIN_UPD_LOGONPROOF` part the realm list needs: the session key, login time, and online flag. */
export async function saveSessionKey(db: Db, username: string, sessionKey: Uint8Array): Promise<void> {
  await db.update(account).set({ session_key: sessionKey, last_login: new Date(), online: 1 }).where(eq(account.username, username));
}

export async function findCharacter(db: Db, accountId: number, characterId: number): Promise<Character | null> {
  const [row] = await db
    .select()
    .from(characters)
    .where(and(eq(characters.guid, characterId), eq(characters.account, accountId)));
  return row ?? null;
}

export async function findCharacterById(db: Db, characterId: number): Promise<Character | null> {
  const [row] = await db.select().from(characters).where(eq(characters.guid, characterId));
  return row ?? null;
}

export async function listCharacters(db: Db, accountId: number): Promise<Character[]> {
  return db.select().from(characters).where(eq(characters.account, accountId)).orderBy(asc(characters.guid));
}

export async function listRealms(db: Db): Promise<Realm[]> {
  return db.select().from(realmlist).orderBy(asc(realmlist.id));
}

/** `RealmFlags` (Realm.h) */
export const REALM_FLAG_VERSION_MISMATCH = 0x01;
export const REALM_FLAG_OFFLINE = 0x02;

/** worldserver `Main`: while loading the realm is not offline but not connectable yet (`REALM_FLAG_VERSION_MISMATCH`). */
export async function markRealmStarting(db: Db, realmId: number): Promise<void> {
  await db
    .update(realmlist)
    .set({ flag: sql`(${realmlist.flag} & ~${REALM_FLAG_OFFLINE}) | ${REALM_FLAG_VERSION_MISMATCH}` })
    .where(eq(realmlist.id, realmId));
}

/** worldserver `Main`: the world is up, so the realm is connectable (`population = 0`). */
export async function markRealmOnline(db: Db, realmId: number): Promise<void> {
  await db
    .update(realmlist)
    .set({ flag: sql`${realmlist.flag} & ~${REALM_FLAG_VERSION_MISMATCH}`, population: 0 })
    .where(eq(realmlist.id, realmId));
}

/** worldserver `Main` at shutdown: set server offline. */
export async function markRealmOffline(db: Db, realmId: number): Promise<void> {
  await db
    .update(realmlist)
    .set({ flag: sql`${realmlist.flag} | ${REALM_FLAG_OFFLINE}` })
    .where(eq(realmlist.id, realmId));
}

/**
 * Development accounts `TEST`, `TEST2`, and `TEST3`, each with a level 1 human warrior in Northshire. Rows that
 * already exist stay as they are. The realm comes from the `realmlist` row in `sql/base/db_auth`.
 */
export async function seedDevelopmentAccounts(loginDb: Db, characterDb: Db, world: WorldTables | null): Promise<void> {
  for (const seed of SEED_ACCOUNTS) {
    let [found] = await loginDb.select({ id: account.id }).from(account).where(eq(account.username, seed.username));
    if (!found) {
      const registration = makeRegistrationData(seed.username, seed.password);
      await loginDb.insert(account).values({ username: seed.username, salt: registration.salt, verifier: registration.verifier });
      [found] = await loginDb.select({ id: account.id }).from(account).where(eq(account.username, seed.username));
    }
    if (!found) {
      continue;
    }
    const accountId = found.id;
    const existing = await characterDb.$count(characters, eq(characters.account, accountId));
    if (existing === 0) {
      const guid = objectGuids.player.generate();
      await characterDb.insert(characters).values({
        guid,
        account: accountId,
        name: seed.character.name,
        race: 1,
        class: 1,
        gender: seed.character.gender,
        level: 1,
        skin: seed.character.skin,
        face: seed.character.face,
        hairStyle: seed.character.hairStyle,
        hairColor: seed.character.hairColor,
        facialStyle: seed.character.facialStyle,
        position_x: -8949.95,
        position_y: seed.character.position_y,
        position_z: 83.5312,
        map: 0,
        zone: 12,
        health: 60,
        money: seed.character.money ?? 0,
        taximask: "",
        innTriggerId: 0,
      });
      if (seed.character.bag) {
        await seedBackpack(characterDb, world, guid, seed.character.bag);
      }
    } else if (seed.character.bag) {
      const [character] = await characterDb
        .select({ guid: characters.guid })
        .from(characters)
        .where(and(eq(characters.account, accountId), eq(characters.name, seed.character.name)));
      if (character && (await characterDb.$count(character_inventory, eq(character_inventory.guid, character.guid))) === 0) {
        await seedBackpack(characterDb, world, character.guid, seed.character.bag);
        if (seed.character.money !== undefined) {
          await characterDb.update(characters).set({ money: seed.character.money }).where(eq(characters.guid, character.guid));
        }
      }
    }
    await refreshRealmCharacterCount(characterDb, loginDb, accountId);
  }
}

async function seedBackpack(
  db: Db,
  world: WorldTables | null,
  characterGuid: number,
  items: NonNullable<SeedAccount["character"]["bag"]>,
): Promise<void> {
  for (const item of items) {
    const created = await createItem(db, world, {
      entry: item.entry,
      owner: characterGuid,
      count: item.count,
      charges: "charges" in item ? item.charges : undefined,
      durability: "durability" in item ? item.durability : undefined,
      maxDurability: "maxDurability" in item ? item.maxDurability : undefined,
    });
    await db.insert(character_inventory).values({ guid: characterGuid, bag: 0, slot: item.slot, item: created.guid });
  }
}
