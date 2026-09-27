import { eq } from "drizzle-orm";
import type { Db } from "../database/database.ts";
import { characters } from "../database/schema/characters.ts";
import type { Character } from "../db.ts";
import { deleteCharacterKit, writeCharacterKit, type CharacterLoginKit } from "./store.ts";

/** `Player::SaveToDB`: the full `characters` row and the kit tables, in one transaction. */
export async function saveCharacterState(db: Db, character: Character, kit: CharacterLoginKit): Promise<void> {
  const { guid, account: _account, creation_date: _created, deleteInfos_Account: _a, deleteInfos_Name: _n, deleteDate: _d, order: _o, ...row } = character;
  await db.transaction(async (tx) => {
    await tx
      .update(characters)
      .set({ ...row, knownCurrencies: BigInt(character.knownCurrencies) })
      .where(eq(characters.guid, guid));
    await deleteCharacterKit(tx, guid);
    await writeCharacterKit(tx, guid, kit);
  });
}
