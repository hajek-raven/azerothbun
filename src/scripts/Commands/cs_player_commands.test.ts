import { expect, test } from "bun:test";
import { chatTestEnv, loginClient } from "../../game/Chat/test-chat.ts";
import { CHEAT_GOD } from "../../game/Entities/Player/PlayerDefines.ts";

test(".cheat, .modify, .titles, .honor, .learn, and .announce act on the player", async () => {
  const env = await chatTestEnv();
  const gm = await loginClient(env, "TEST", 1, 3);
  const target = await loginClient(env, "TEST2", 2, 0);
  const player = gm.session.getPlayer()!;
  const other = target.session.getPlayer()!;
  gm.takeMessages();
  target.takeMessages();

  await gm.say(".cheat god on");
  expect(player.getCommandStatus(CHEAT_GOD)).toBe(true);
  expect(gm.takeMessages()).toContain("Godmode is ON. You won't take damage.");

  // Commands on the selected player
  gm.session.selection = other.getGUID();
  await gm.say(".modify money 1g");
  expect(other.getMoney()).toBeGreaterThanOrEqual(10000);
  await gm.say(".modify hp 500");
  expect(other.getMaxHealth()).toBe(500);
  await gm.say(".modify gender male");
  expect(other.getGender()).toBe(0);

  await gm.say(".titles add 1");
  expect(other.hasTitle(1)).toBe(true);
  await gm.say(".titles remove 1");
  expect(other.hasTitle(1)).toBe(false);

  const honor = other.getHonorPoints();
  await gm.say(".honor add 50");
  expect(other.getHonorPoints()).toBe(honor + 50);

  await gm.say(".learn 668");
  expect(other.hasSpell(668)).toBe(true);
  await gm.say(".unlearn 668");
  expect(other.hasSpell(668)).toBe(false);

  // `.announce` is an `SMSG_CHAT_SERVER_MESSAGE` (SERVER_MSG_STRING) to every session.
  const seen = target.received.length;
  await gm.say(".announce hello realm");
  const announced = target.received.slice(seen).filter((packet) => packet.opcode === 0x291);
  expect(announced.some((packet) => new TextDecoder().decode(packet.payload).includes("hello realm"))).toBe(true);
});
