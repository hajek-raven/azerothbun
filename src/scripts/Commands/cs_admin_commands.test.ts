import { expect, test } from "bun:test";
import { queryFields } from "../../database/database.ts";
import { chatTestEnv } from "../../game/Chat/test-chat.ts";
import { sCharacterCache } from "../../game/Cache/CharacterCache.ts";
import { handleConsoleCommand } from "../../game/Server/console.ts";

async function consoleLines(command: string): Promise<{ ok: boolean; lines: string[] }> {
  const lines: string[] = [];
  const result = await handleConsoleCommand(command, (line) => lines.push(line));
  return { ok: result?.ok ?? false, lines };
}

test(".ban, .baninfo, and .unban write account_banned and character_banned", async () => {
  const env = await chatTestEnv();
  expect((await consoleLines("ban account TEST2 1d griefing")).ok).toBe(true);
  const [ban] = await queryFields(env.db.login, "SELECT active, bannedby, banreason, unbandate - bandate FROM account_banned WHERE id = (SELECT id FROM account WHERE username = 'TEST2')");
  expect(ban!.map(String)).toEqual(["1", "Console", "griefing", "86400"]);
  expect((await consoleLines("baninfo account TEST2")).lines.join("\n")).toContain("griefing");
  expect((await consoleLines("unban account TEST2")).ok).toBe(true);
  const [after] = await queryFields(env.db.login, "SELECT active FROM account_banned WHERE id = (SELECT id FROM account WHERE username = 'TEST2')");
  expect(Number(after![0])).toBe(0);

  expect((await consoleLines("ban character Bagtest -1 cheating")).ok).toBe(true);
  const [charBan] = await queryFields(env.db.characters, "SELECT active, banreason FROM character_banned WHERE guid = 3");
  expect(charBan!.map(String)).toEqual(["1", "cheating"]);
  expect((await consoleLines("unban character Bagtest")).ok).toBe(true);
});

test(".rbac account grant, list, and revoke change rbac_account_permissions", async () => {
  const env = await chatTestEnv();
  expect((await consoleLines("rbac account grant TEST2 200")).ok).toBe(true);
  const rows = await queryFields(env.db.login, "SELECT permissionId, granted, realmId FROM rbac_account_permissions WHERE accountId = (SELECT id FROM account WHERE username = 'TEST2')");
  expect(rows.map((row) => row.map(Number))).toEqual([[200, 1, -1]]);
  expect((await consoleLines("rbac account list TEST2")).lines.join("\n")).toContain("200");
  expect((await consoleLines("rbac account revoke TEST2 200")).ok).toBe(true);
  expect(await queryFields(env.db.login, "SELECT 1 FROM rbac_account_permissions WHERE accountId = (SELECT id FROM account WHERE username = 'TEST2')")).toEqual([]);
});

test(".character level, rename, and erase act on offline characters", async () => {
  const env = await chatTestEnv();
  expect((await consoleLines("character level Bagtest 10")).ok).toBe(true);
  const [level] = await queryFields(env.db.characters, "SELECT level FROM characters WHERE guid = 3");
  expect(Number(level![0])).toBe(10);

  expect((await consoleLines("character rename Bagtest false Renamed")).ok).toBe(true);
  const [name] = await queryFields(env.db.characters, "SELECT name FROM characters WHERE guid = 3");
  expect(String(name![0])).toBe("Renamed");
  expect(sCharacterCache.getCharacterGuidByName("Renamed")).toBe(3);

  expect((await consoleLines("character erase Renamed")).ok).toBe(true);
  expect(await queryFields(env.db.characters, "SELECT 1 FROM characters WHERE guid = 3")).toEqual([]);
  expect(await queryFields(env.db.characters, "SELECT 1 FROM character_inventory WHERE guid = 3")).toEqual([]);
});
