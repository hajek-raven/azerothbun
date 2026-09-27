import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { testDatabase } from "../database/test-db.ts";
import { account_tutorial } from "../database/schema/characters.ts";
import { AccountTutorials, loadTutorials, saveTutorials } from "./tutorials.ts";

describe("AccountTutorials", () => {
  test("CMSG_TUTORIAL_FLAG sets bit data % 32 of value data / 32", () => {
    const tutorials = new AccountTutorials();
    tutorials.flag(0);
    tutorials.flag(33);
    tutorials.flag(63);
    expect(tutorials.values.slice(0, 2)).toEqual([1, 0x80000002]);
    expect(tutorials.changed).toBe(true);
  });

  test("an index past MAX_ACCOUNT_TUTORIAL_VALUES is ignored", () => {
    const tutorials = new AccountTutorials();
    tutorials.flag(8 * 32);
    expect(tutorials.values).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(tutorials.changed).toBe(false);
  });

  test("clear marks everything seen and reset clears it", () => {
    const tutorials = new AccountTutorials();
    tutorials.clear();
    expect(tutorials.values.every((value) => value === 0xffffffff)).toBe(true);
    tutorials.reset();
    expect(tutorials.values.every((value) => value === 0)).toBe(true);
  });
});

describe("account_tutorial", () => {
  test("inserts, updates, and loads the account's tutorial values", async () => {
    const db = await testDatabase("characters");
    expect((await loadTutorials(db, 7)).values).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);

    const tutorials = await loadTutorials(db, 7);
    tutorials.flag(5);
    tutorials.flag(31);
    await saveTutorials(db, 7, tutorials);
    expect(tutorials.changed).toBe(false);
    expect((await loadTutorials(db, 7)).values[0]).toBe(0x80000020);

    tutorials.clear();
    await saveTutorials(db, 7, tutorials);
    const rows = await db.select().from(account_tutorial).where(eq(account_tutorial.accountId, 7));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tut7).toBe(0xffffffff);
    expect((await loadTutorials(db, 8)).values[0]).toBe(0);
  });
});
