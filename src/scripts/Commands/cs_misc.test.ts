import { expect, test } from "bun:test";
import { queryFields } from "../../database/database.ts";
import { chatTestEnv, loginClient } from "../../game/Chat/test-chat.ts";
import { sObjectMgr } from "../../game/Globals/ObjectMgr.ts";
import { handleConsoleCommand } from "../../game/Server/console.ts";

test(".additem, .pinfo, .string, and .gps answer like AzerothCore", async () => {
  const env = await chatTestEnv();
  const gm = await loginClient(env, "TEST", 1, 3);
  gm.takeMessages();
  const player = gm.session.getPlayer()!;

  const before = player.getItemCount(25);
  await gm.say(".additem 25 2");
  expect(player.getItemCount(25)).toBe(before + 2);
  await gm.say(".additem 25 -1");
  expect(player.getItemCount(25)).toBe(before + 1);
  expect(gm.takeMessages().some((line) => line.includes("Removed itemID = 25, amount = 1"))).toBe(true);

  await gm.say(".pinfo Testtwo");
  const pinfo = gm.takeMessages().join("\n");
  expect(pinfo).toContain("Testtwo");
  expect(pinfo).toContain("TEST2");

  await gm.say(".string 1");
  expect(gm.takeMessages()).toEqual([sObjectMgr.getAcoreString(1)]);

  await gm.say(".gps");
  expect(gm.takeMessages().some((line) => line.includes("Map: 0"))).toBe(true);
});

test(".mute and .unmute an online player; .summon moves it to the GM", async () => {
  const env = await chatTestEnv();
  const gm = await loginClient(env, "TEST", 1, 3);
  const target = await loginClient(env, "TEST2", 2, 0);
  gm.takeMessages();
  target.takeMessages();

  await gm.say(".mute Testtwo 5m spamming");
  expect(target.session.getPlayer()!.canSpeak()).toBe(false);
  expect(target.takeMessages().some((line) => line.includes("spamming"))).toBe(true);
  const [mute] = await queryFields(env.db.login, "SELECT mutetime, mutereason, muteby FROM account WHERE username = 'TEST2'");
  expect(Number(mute![0])).toBeGreaterThan(Date.now() / 1000);
  expect(mute!.slice(1)).toEqual(["spamming", "Test"]);
  await gm.say(".mutehistory TEST2");
  expect(gm.takeMessages().join("\n")).toContain("spamming");

  await gm.say(".unmute Testtwo");
  expect(target.session.getPlayer()!.canSpeak()).toBe(true);

  await gm.say(".summon Testtwo");
  const gmPlayer = gm.session.getPlayer()!;
  const summoned = target.session.getPlayer()!;
  expect(summoned.getMapId()).toBe(gmPlayer.getMapId());
  expect(Math.hypot(summoned.getPositionX() - gmPlayer.getPositionX(), summoned.getPositionY() - gmPlayer.getPositionY())).toBeLessThan(5);
});

test(".revive of an offline character flags it for resurrection at login", async () => {
  const env = await chatTestEnv();
  await env.db.characters.$client.unsafe("UPDATE characters SET health = 0 WHERE guid = 3");
  expect((await handleConsoleCommand("revive Bagtest", () => {}))?.ok).toBe(true);
  const [row] = await queryFields(env.db.characters, "SELECT at_login FROM characters WHERE guid = 3");
  expect(Number(row![0]) & 0x800).toBe(0x800);
  const client = await loginClient(env, "TEST3", 3, 0);
  expect(client.session.getPlayer()!.isAlive()).toBe(true);
});
