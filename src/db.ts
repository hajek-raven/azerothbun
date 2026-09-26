import { constants, Database } from "bun:sqlite";
import { ensureCharacterTables } from "./characters/store.ts";
import { makeRegistrationData } from "./crypto/srp6.ts";

export const CLIENT_BUILD = 12340;
export const REALM_ADDRESS = "127.0.0.1";
export const REALM_PORT = 8085;

const SEED_ACCOUNTS = [
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
] as const;

export type Account = {
  id: number;
  username: string;
  salt: Uint8Array;
  verifier: Uint8Array;
  session_key: Uint8Array | null;
  totp_secret: Uint8Array | null;
  email: string;
  reg_mail: string;
  joindate: string;
  last_ip: string;
  last_attempt_ip: string;
  failed_logins: number;
  locked: number;
  lock_country: string;
  last_login: string | null;
  online: number;
  expansion: number;
  Flags: number;
  mutetime: number;
  mutereason: string;
  muteby: string;
  locale: number;
  os: string;
  recruiter: number;
  totaltime: number;
};

export type Character = {
  guid: number;
  account: number;
  name: string;
  race: number;
  class: number;
  gender: number;
  level: number;
  xp: number;
  money: number;
  skin: number;
  face: number;
  hairStyle: number;
  hairColor: number;
  facialStyle: number;
  bankSlots: number;
  restState: number;
  playerFlags: number;
  position_x: number;
  position_y: number;
  position_z: number;
  map: number;
  instance_id: number;
  instance_mode_mask: number;
  orientation: number;
  taximask: string;
  online: number;
  cinematic: number;
  totaltime: number;
  leveltime: number;
  logout_time: number;
  is_logout_resting: number;
  rest_bonus: number;
  resettalents_cost: number;
  resettalents_time: number;
  trans_x: number;
  trans_y: number;
  trans_z: number;
  trans_o: number;
  transguid: number;
  extra_flags: number;
  stable_slots: number;
  at_login: number;
  zone: number;
  death_expire_time: number;
  taxi_path: string | null;
  arenaPoints: number;
  totalHonorPoints: number;
  todayHonorPoints: number;
  yesterdayHonorPoints: number;
  totalKills: number;
  todayKills: number;
  yesterdayKills: number;
  chosenTitle: number;
  knownCurrencies: number;
  watchedFaction: number;
  drunk: number;
  health: number;
  power1: number;
  power2: number;
  power3: number;
  power4: number;
  power5: number;
  power6: number;
  power7: number;
  latency: number;
  talentGroupsCount: number;
  activeTalentGroup: number;
  exploredZones: string | null;
  equipmentCache: string | null;
  ammoId: number;
  knownTitles: string | null;
  actionBars: number;
  grantableLevels: number;
  order: number | null;
  creation_date: string;
  deleteInfos_Account: number | null;
  deleteInfos_Name: string | null;
  deleteDate: number | null;
  innTriggerId: number;
  extraBonusTalentCount: number;
};

export type Realm = {
  id: number;
  name: string;
  address: string;
  localAddress: string;
  localSubnetMask: string;
  port: number;
  icon: number;
  flag: number;
  timezone: number;
  allowedSecurityLevel: number;
  population: number;
  gamebuild: number;
};

const ACCOUNT_COLUMNS = `id, username, salt, verifier, session_key, totp_secret, email, reg_mail, joindate, last_ip,
  last_attempt_ip, failed_logins, locked, lock_country, last_login, online, expansion, Flags, mutetime, mutereason,
  muteby, locale, os, recruiter, totaltime`;

const CHARACTER_COLUMNS = `guid, account, name, race, class, gender, level, xp, money, skin, face, hairStyle, hairColor,
  facialStyle, bankSlots, restState, playerFlags, position_x, position_y, position_z, map, instance_id, instance_mode_mask,
  orientation, taximask, online, cinematic, totaltime, leveltime, logout_time, is_logout_resting, rest_bonus,
  resettalents_cost, resettalents_time, trans_x, trans_y, trans_z, trans_o, transguid, extra_flags, stable_slots, at_login,
  zone, death_expire_time, taxi_path, arenaPoints, totalHonorPoints, todayHonorPoints, yesterdayHonorPoints, totalKills,
  todayKills, yesterdayKills, chosenTitle, knownCurrencies, watchedFaction, drunk, health, power1, power2, power3, power4,
  power5, power6, power7, latency, talentGroupsCount, activeTalentGroup, exploredZones, equipmentCache, ammoId, knownTitles,
  actionBars, grantableLevels, "order", creation_date, deleteInfos_Account, deleteInfos_Name, deleteDate, innTriggerId,
  extraBonusTalentCount`;

/**
 * `bun:sqlite` runs on the event loop thread, where AzerothCore has async database workers.
 * WAL with `synchronous = NORMAL` keeps each commit off `fsync`, so saves do not stall the loop.
 */
export function openAuthDatabase(path: string): Database {
  const db = new Database(path, { create: true, strict: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = NORMAL");
  db.fileControl(constants.SQLITE_FCNTL_PERSIST_WAL, 0);
  db.run("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  ensureCharacterTables(db);
  seed(db);
  return db;
}

export function findAccount(db: Database, username: string): Account | null {
  return db.query<Account, { username: string }>(`SELECT ${ACCOUNT_COLUMNS} FROM account WHERE username = $username`).get({ username }) ?? null;
}

export function saveSessionKey(db: Database, username: string, sessionKey: Uint8Array): void {
  db.query(
    "UPDATE account SET session_key = $session_key, last_login = CURRENT_TIMESTAMP, online = 1 WHERE username = $username",
  ).run({
    session_key: sessionKey,
    username,
  });
}

export function findCharacter(db: Database, accountId: number, characterId: number): Character | null {
  return (
    db
      .query<Character, { guid: number; account: number }>(
        `SELECT ${CHARACTER_COLUMNS} FROM characters WHERE guid = $guid AND account = $account`,
      )
      .get({ guid: characterId, account: accountId }) ?? null
  );
}

export function findCharacterById(db: Database, characterId: number): Character | null {
  return (
    db.query<Character, { guid: number }>(`SELECT ${CHARACTER_COLUMNS} FROM characters WHERE guid = $guid`).get({ guid: characterId }) ??
    null
  );
}

export function listCharacters(db: Database, accountId: number): Character[] {
  return db
    .query<Character, { account: number }>(`SELECT ${CHARACTER_COLUMNS} FROM characters WHERE account = $account ORDER BY guid`)
    .all({ account: accountId });
}

export function listRealms(db: Database): Realm[] {
  return db
    .query<Realm, []>(
      `SELECT id, name, address, localAddress, localSubnetMask, port, icon, flag, timezone, allowedSecurityLevel, population, gamebuild
       FROM realmlist ORDER BY id`,
    )
    .all();
}

function seed(db: Database): void {
  db.transaction(() => {
    const realms = db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM realmlist").get();
    if (realms?.count === 0) {
      db.query(
        `INSERT INTO realmlist (name, address, localAddress, localSubnetMask, port, icon, flag, timezone, allowedSecurityLevel, population, gamebuild)
         VALUES ($name, $address, $localAddress, $localSubnetMask, $port, $icon, $flag, $timezone, $allowedSecurityLevel, $population, $gamebuild)`,
      ).run({
        name: "Azeroth",
        address: REALM_ADDRESS,
        localAddress: REALM_ADDRESS,
        localSubnetMask: "255.255.255.0",
        port: REALM_PORT,
        icon: 0,
        flag: 0,
        timezone: 1,
        allowedSecurityLevel: 0,
        population: 0,
        gamebuild: CLIENT_BUILD,
      });
    }
    for (const seed of SEED_ACCOUNTS) {
      let account = db.query<{ id: number }, { username: string }>("SELECT id FROM account WHERE username = $username").get({
        username: seed.username,
      });
      if (!account) {
        const registration = makeRegistrationData(seed.username, seed.password);
        db.query("INSERT INTO account (username, salt, verifier) VALUES ($username, $salt, $verifier)").run({
          username: seed.username,
          salt: registration.salt,
          verifier: registration.verifier,
        });
        account = db.query<{ id: number }, { username: string }>("SELECT id FROM account WHERE username = $username").get({
          username: seed.username,
        });
      }
      if (!account) {
        continue;
      }
      const existing = db.query<{ count: number }, { account: number }>("SELECT COUNT(*) AS count FROM characters WHERE account = $account").get({
        account: account.id,
      });
      if (existing?.count === 0) {
        db.query(
          `INSERT INTO characters (
             account, name, race, class, gender, level, skin, face, hairStyle, hairColor, facialStyle,
             position_x, position_y, position_z, map, zone, health, taximask, innTriggerId
           ) VALUES (
             $account, $name, $race, $class, $gender, $level, $skin, $face, $hairStyle, $hairColor, $facialStyle,
             $position_x, $position_y, $position_z, $map, $zone, $health, $taximask, $innTriggerId
           )`,
        ).run({
          account: account.id,
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
          taximask: "",
          innTriggerId: 0,
        });
      }
      db.query(
        `INSERT INTO realmcharacters (realmid, acctid, numchars)
         VALUES (1, $acctid, (SELECT COUNT(*) FROM characters WHERE account = $acctid))
         ON CONFLICT(realmid, acctid) DO UPDATE SET numchars = excluded.numchars`,
      ).run({ acctid: account.id });
    }
  })();
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS account (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL DEFAULT '',
    salt BLOB NOT NULL,
    verifier BLOB NOT NULL,
    session_key BLOB,
    totp_secret BLOB,
    email TEXT NOT NULL DEFAULT '',
    reg_mail TEXT NOT NULL DEFAULT '',
    joindate TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_ip TEXT NOT NULL DEFAULT '127.0.0.1',
    last_attempt_ip TEXT NOT NULL DEFAULT '127.0.0.1',
    failed_logins INTEGER NOT NULL DEFAULT 0,
    locked INTEGER NOT NULL DEFAULT 0,
    lock_country TEXT NOT NULL DEFAULT '00',
    last_login TEXT,
    online INTEGER NOT NULL DEFAULT 0,
    expansion INTEGER NOT NULL DEFAULT 2,
    Flags INTEGER NOT NULL DEFAULT 0,
    mutetime INTEGER NOT NULL DEFAULT 0,
    mutereason TEXT NOT NULL DEFAULT '',
    muteby TEXT NOT NULL DEFAULT '',
    locale INTEGER NOT NULL DEFAULT 0,
    os TEXT NOT NULL DEFAULT '',
    recruiter INTEGER NOT NULL DEFAULT 0,
    totaltime INTEGER NOT NULL DEFAULT 0
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_username ON account (username);

  CREATE TABLE IF NOT EXISTS account_access (
    id INTEGER NOT NULL,
    gmlevel INTEGER NOT NULL,
    RealmID INTEGER NOT NULL DEFAULT -1,
    comment TEXT DEFAULT '',
    PRIMARY KEY (id, RealmID)
  );

  CREATE TABLE IF NOT EXISTS account_banned (
    id INTEGER NOT NULL DEFAULT 0,
    bandate INTEGER NOT NULL DEFAULT 0,
    unbandate INTEGER NOT NULL DEFAULT 0,
    bannedby TEXT NOT NULL,
    banreason TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (id, bandate)
  );

  CREATE TABLE IF NOT EXISTS account_muted (
    guid INTEGER NOT NULL DEFAULT 0,
    mutedate INTEGER NOT NULL DEFAULT 0,
    mutetime INTEGER NOT NULL DEFAULT 0,
    mutedby TEXT NOT NULL,
    mutereason TEXT NOT NULL,
    PRIMARY KEY (guid, mutedate)
  );

  CREATE TABLE IF NOT EXISTS autobroadcast (
    realmid INTEGER NOT NULL DEFAULT -1,
    id INTEGER NOT NULL,
    weight INTEGER DEFAULT 1,
    text TEXT NOT NULL,
    PRIMARY KEY (id, realmid)
  );

  CREATE TABLE IF NOT EXISTS autobroadcast_locale (
    realmid INTEGER NOT NULL,
    id INTEGER NOT NULL,
    locale TEXT NOT NULL,
    text TEXT NOT NULL,
    PRIMARY KEY (realmid, id, locale)
  );

  CREATE TABLE IF NOT EXISTS build_info (
    build INTEGER PRIMARY KEY,
    majorVersion INTEGER,
    minorVersion INTEGER,
    bugfixVersion INTEGER,
    hotfixVersion TEXT,
    winAuthSeed TEXT,
    win64AuthSeed TEXT,
    mac64AuthSeed TEXT,
    winChecksumSeed TEXT,
    macChecksumSeed TEXT
  );

  CREATE TABLE IF NOT EXISTS ip_banned (
    ip TEXT NOT NULL DEFAULT '127.0.0.1',
    bandate INTEGER NOT NULL,
    unbandate INTEGER NOT NULL,
    bannedby TEXT NOT NULL DEFAULT '[Console]',
    banreason TEXT NOT NULL DEFAULT 'no reason',
    PRIMARY KEY (ip, bandate)
  );

  CREATE TABLE IF NOT EXISTS logs (
    time INTEGER NOT NULL,
    realm INTEGER NOT NULL,
    type TEXT NOT NULL,
    level INTEGER NOT NULL DEFAULT 0,
    string TEXT
  );

  CREATE TABLE IF NOT EXISTS logs_ip_actions (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL,
    character_guid INTEGER NOT NULL,
    type INTEGER NOT NULL,
    ip TEXT NOT NULL DEFAULT '127.0.0.1',
    systemnote TEXT,
    unixtime INTEGER NOT NULL,
    time TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    comment TEXT
  );

  CREATE TABLE IF NOT EXISTS motd (
    realmid INTEGER PRIMARY KEY,
    text TEXT
  );

  CREATE TABLE IF NOT EXISTS motd_localized (
    realmid INTEGER NOT NULL,
    locale TEXT NOT NULL,
    text TEXT,
    PRIMARY KEY (realmid, locale)
  );

  CREATE TABLE IF NOT EXISTS rbac_permissions (
    id INTEGER NOT NULL DEFAULT 0 PRIMARY KEY,
    name TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS rbac_account_permissions (
    accountId INTEGER NOT NULL,
    permissionId INTEGER NOT NULL,
    granted INTEGER NOT NULL DEFAULT 1,
    realmId INTEGER NOT NULL DEFAULT -1,
    PRIMARY KEY (accountId, permissionId, realmId),
    FOREIGN KEY (accountId) REFERENCES account (id) ON DELETE CASCADE,
    FOREIGN KEY (permissionId) REFERENCES rbac_permissions (id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS rbac_default_permissions (
    secId INTEGER NOT NULL,
    permissionId INTEGER NOT NULL,
    realmId INTEGER NOT NULL DEFAULT -1,
    PRIMARY KEY (secId, permissionId, realmId),
    FOREIGN KEY (permissionId) REFERENCES rbac_permissions (id)
  );

  CREATE TABLE IF NOT EXISTS rbac_linked_permissions (
    id INTEGER NOT NULL,
    linkedId INTEGER NOT NULL,
    PRIMARY KEY (id, linkedId),
    FOREIGN KEY (id) REFERENCES rbac_permissions (id) ON DELETE CASCADE,
    FOREIGN KEY (linkedId) REFERENCES rbac_permissions (id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS realmcharacters (
    realmid INTEGER NOT NULL DEFAULT 0,
    acctid INTEGER NOT NULL,
    numchars INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (realmid, acctid)
  );
  CREATE INDEX IF NOT EXISTS idx_realmcharacters_acctid ON realmcharacters (acctid);

  CREATE TABLE IF NOT EXISTS realmlist (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    address TEXT NOT NULL DEFAULT '127.0.0.1',
    localAddress TEXT NOT NULL DEFAULT '127.0.0.1',
    localSubnetMask TEXT NOT NULL DEFAULT '255.255.255.0',
    port INTEGER NOT NULL DEFAULT 8085,
    icon INTEGER NOT NULL DEFAULT 0,
    flag INTEGER NOT NULL DEFAULT 2,
    timezone INTEGER NOT NULL DEFAULT 0,
    allowedSecurityLevel INTEGER NOT NULL DEFAULT 0,
    population REAL NOT NULL DEFAULT 0 CHECK (population >= 0),
    gamebuild INTEGER NOT NULL DEFAULT 12340
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_realmlist_name ON realmlist (name);

  CREATE TABLE IF NOT EXISTS secret_digest (
    id INTEGER PRIMARY KEY,
    digest TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS updates (
    name TEXT PRIMARY KEY,
    hash TEXT DEFAULT '',
    state TEXT NOT NULL DEFAULT 'RELEASED',
    timestamp TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    speed INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS updates_include (
    path TEXT PRIMARY KEY,
    state TEXT NOT NULL DEFAULT 'RELEASED'
  );

  CREATE TABLE IF NOT EXISTS uptime (
    realmid INTEGER NOT NULL,
    starttime INTEGER NOT NULL DEFAULT 0,
    uptime INTEGER NOT NULL DEFAULT 0,
    maxplayers INTEGER NOT NULL DEFAULT 0,
    revision TEXT NOT NULL DEFAULT 'AzerothCore',
    PRIMARY KEY (realmid, starttime)
  );

  CREATE TABLE IF NOT EXISTS characters (
    guid INTEGER PRIMARY KEY,
    account INTEGER NOT NULL DEFAULT 0,
    name TEXT NOT NULL,
    race INTEGER NOT NULL DEFAULT 0,
    class INTEGER NOT NULL DEFAULT 0,
    gender INTEGER NOT NULL DEFAULT 0,
    level INTEGER NOT NULL DEFAULT 0,
    xp INTEGER NOT NULL DEFAULT 0,
    money INTEGER NOT NULL DEFAULT 0,
    skin INTEGER NOT NULL DEFAULT 0,
    face INTEGER NOT NULL DEFAULT 0,
    hairStyle INTEGER NOT NULL DEFAULT 0,
    hairColor INTEGER NOT NULL DEFAULT 0,
    facialStyle INTEGER NOT NULL DEFAULT 0,
    bankSlots INTEGER NOT NULL DEFAULT 0,
    restState INTEGER NOT NULL DEFAULT 0,
    playerFlags INTEGER NOT NULL DEFAULT 0,
    position_x REAL NOT NULL DEFAULT 0,
    position_y REAL NOT NULL DEFAULT 0,
    position_z REAL NOT NULL DEFAULT 0,
    map INTEGER NOT NULL DEFAULT 0,
    instance_id INTEGER NOT NULL DEFAULT 0,
    instance_mode_mask INTEGER NOT NULL DEFAULT 0,
    orientation REAL NOT NULL DEFAULT 0,
    taximask TEXT NOT NULL,
    online INTEGER NOT NULL DEFAULT 0,
    cinematic INTEGER NOT NULL DEFAULT 0,
    totaltime INTEGER NOT NULL DEFAULT 0,
    leveltime INTEGER NOT NULL DEFAULT 0,
    logout_time INTEGER NOT NULL DEFAULT 0,
    is_logout_resting INTEGER NOT NULL DEFAULT 0,
    rest_bonus REAL NOT NULL DEFAULT 0,
    resettalents_cost INTEGER NOT NULL DEFAULT 0,
    resettalents_time INTEGER NOT NULL DEFAULT 0,
    trans_x REAL NOT NULL DEFAULT 0,
    trans_y REAL NOT NULL DEFAULT 0,
    trans_z REAL NOT NULL DEFAULT 0,
    trans_o REAL NOT NULL DEFAULT 0,
    transguid INTEGER DEFAULT 0,
    extra_flags INTEGER NOT NULL DEFAULT 0,
    stable_slots INTEGER NOT NULL DEFAULT 0,
    at_login INTEGER NOT NULL DEFAULT 0,
    zone INTEGER NOT NULL DEFAULT 0,
    death_expire_time INTEGER NOT NULL DEFAULT 0,
    taxi_path TEXT,
    arenaPoints INTEGER NOT NULL DEFAULT 0,
    totalHonorPoints INTEGER NOT NULL DEFAULT 0,
    todayHonorPoints INTEGER NOT NULL DEFAULT 0,
    yesterdayHonorPoints INTEGER NOT NULL DEFAULT 0,
    totalKills INTEGER NOT NULL DEFAULT 0,
    todayKills INTEGER NOT NULL DEFAULT 0,
    yesterdayKills INTEGER NOT NULL DEFAULT 0,
    chosenTitle INTEGER NOT NULL DEFAULT 0,
    knownCurrencies INTEGER NOT NULL DEFAULT 0,
    watchedFaction INTEGER NOT NULL DEFAULT 0,
    drunk INTEGER NOT NULL DEFAULT 0,
    health INTEGER NOT NULL DEFAULT 0,
    power1 INTEGER NOT NULL DEFAULT 0,
    power2 INTEGER NOT NULL DEFAULT 0,
    power3 INTEGER NOT NULL DEFAULT 0,
    power4 INTEGER NOT NULL DEFAULT 0,
    power5 INTEGER NOT NULL DEFAULT 0,
    power6 INTEGER NOT NULL DEFAULT 0,
    power7 INTEGER NOT NULL DEFAULT 0,
    latency INTEGER DEFAULT 0,
    talentGroupsCount INTEGER NOT NULL DEFAULT 1,
    activeTalentGroup INTEGER NOT NULL DEFAULT 0,
    exploredZones TEXT,
    equipmentCache TEXT,
    ammoId INTEGER NOT NULL DEFAULT 0,
    knownTitles TEXT,
    actionBars INTEGER NOT NULL DEFAULT 0,
    grantableLevels INTEGER NOT NULL DEFAULT 0,
    "order" INTEGER,
    creation_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleteInfos_Account INTEGER,
    deleteInfos_Name TEXT,
    deleteDate INTEGER,
    innTriggerId INTEGER NOT NULL,
    extraBonusTalentCount INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_account ON characters (account);
  CREATE INDEX IF NOT EXISTS idx_online ON characters (online);
  CREATE INDEX IF NOT EXISTS idx_name ON characters (name);
`;
