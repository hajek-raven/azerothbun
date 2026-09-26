import { expect, test } from "bun:test";
import { findAccount, openAuthDatabase } from "../../db.ts";
import { AccountOpResult, createAccount } from "./account-mgr.ts";

test("account create stores an upper-case name and a realm character row", () => {
  const db = openAuthDatabase(":memory:");
  expect(createAccount(db, "Newuser", "secret", "a@b.c", 2)).toBe(AccountOpResult.Ok);
  const account = findAccount(db, "NEWUSER");
  expect(account?.username).toBe("NEWUSER");
  expect(account?.email).toBe("A@B.C");
  expect(account?.expansion).toBe(2);
  const row = db
    .query<{ numchars: number }, []>(
      `SELECT realmcharacters.numchars FROM realmcharacters
       JOIN account ON account.id = realmcharacters.acctid
       WHERE account.username = 'NEWUSER'`,
    )
    .get();
  expect(row?.numchars).toBe(0);
  expect(createAccount(db, "newuser", "secret")).toBe(AccountOpResult.NameAlreadyExists);
  expect(createAccount(db, "thisnameislongerthan", "secret")).toBe(AccountOpResult.NameTooLong);
  expect(createAccount(db, "short", "thispasswordislonger")).toBe(AccountOpResult.PassTooLong);
  db.close();
});
