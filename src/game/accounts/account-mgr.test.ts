import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { testDatabase } from "../../database/test-db.ts";
import { account, realmcharacters } from "../../database/schema/auth.ts";
import { findAccount } from "../../db.ts";
import { AccountOpResult, createAccount } from "./account-mgr.ts";

test("account create stores an upper-case name and a realm character row", async () => {
  const db = await testDatabase("auth");
  expect(await createAccount(db, "Newuser", "secret", "a@b.c", 2)).toBe(AccountOpResult.Ok);
  const found = await findAccount(db, "NEWUSER");
  expect(found?.username).toBe("NEWUSER");
  expect(found?.email).toBe("A@B.C");
  expect(found?.expansion).toBe(2);
  const [row] = await db
    .select({ numchars: realmcharacters.numchars })
    .from(realmcharacters)
    .innerJoin(account, eq(account.id, realmcharacters.acctid))
    .where(eq(account.username, "NEWUSER"));
  expect(row?.numchars).toBe(0);
  expect(await createAccount(db, "newuser", "secret")).toBe(AccountOpResult.NameAlreadyExists);
  expect(await createAccount(db, "thisnameislongerthan", "secret")).toBe(AccountOpResult.NameTooLong);
  expect(await createAccount(db, "short", "thispasswordislonger")).toBe(AccountOpResult.PassTooLong);
});
