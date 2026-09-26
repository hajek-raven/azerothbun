import type { Database } from "bun:sqlite";
import { makeRegistrationData, upperLatin } from "../../crypto/srp6.ts";
import { MAX_ACCOUNT_STR, MAX_EMAIL_STR, MAX_PASS_STR } from "../../shared/limits.ts";

export const AccountOpResult = {
  Ok: "ok",
  NameTooLong: "name-too-long",
  PassTooLong: "pass-too-long",
  EmailTooLong: "email-too-long",
  NameAlreadyExists: "name-already-exists",
  NameNotExist: "name-not-exist",
  DbInternalError: "db-internal-error",
} as const;

export type AccountOpResult = (typeof AccountOpResult)[keyof typeof AccountOpResult];

function utf8Length(value: string): number {
  let length = 0;
  for (const _char of value) {
    length += 1;
  }
  return length;
}

export function createAccount(db: Database, username: string, password: string, email = "", expansion = 2): AccountOpResult {
  if (utf8Length(username) > MAX_ACCOUNT_STR) {
    return AccountOpResult.NameTooLong;
  }
  if (utf8Length(password) > MAX_PASS_STR) {
    return AccountOpResult.PassTooLong;
  }
  if (utf8Length(email) > MAX_EMAIL_STR) {
    return AccountOpResult.EmailTooLong;
  }
  const name = upperLatin(username);
  const pass = upperLatin(password);
  const mail = upperLatin(email);
  const existing = db.query<{ id: number }, { username: string }>("SELECT id FROM account WHERE username = $username").get({ username: name });
  if (existing) {
    return AccountOpResult.NameAlreadyExists;
  }
  const registration = makeRegistrationData(name, pass);
  try {
    db.query(
      `INSERT INTO account (username, salt, verifier, expansion, reg_mail, email, joindate)
       VALUES ($username, $salt, $verifier, $expansion, $email, $email, CURRENT_TIMESTAMP)`,
    ).run({
      username: name,
      salt: registration.salt,
      verifier: registration.verifier,
      expansion,
      email: mail,
    });
    db.query(
      `INSERT INTO realmcharacters (realmid, acctid, numchars)
       SELECT realmlist.id, account.id, 0
       FROM realmlist, account
       LEFT JOIN realmcharacters ON acctid = account.id
       WHERE acctid IS NULL`,
    ).run();
  } catch {
    return AccountOpResult.DbInternalError;
  }
  return AccountOpResult.Ok;
}
