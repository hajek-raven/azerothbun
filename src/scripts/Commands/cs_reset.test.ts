import { expect, test } from "bun:test";
import { chatTestEnv, loginClient } from "../../game/Chat/test-chat.ts";

test(".reset items bags destroys the backpack and .list item counts the copies", async () => {
  const env = await chatTestEnv();
  const gm = await loginClient(env, "TEST", 1, 3);
  const player = gm.session.getPlayer()!;
  await gm.say(".additem 25 1");
  expect(player.getItemCount(25)).toBeGreaterThan(0);
  gm.takeMessages();
  await gm.say(".list item 25");
  expect(gm.takeMessages().join("\n")).toContain("25");

  gm.session.selection = player.getGUID();
  await gm.say(".reset items bags");
  expect(player.getItemCount(25)).toBe(0);
  expect(gm.takeMessages().join("\n")).toMatch(/\d/);
  // The destroy went through the client path: an SMSG_DESTROY_OBJECT or item update was sent.
  expect(gm.received.some((packet) => packet.opcode === 0x0aa || packet.opcode === 0x0a9)).toBe(true);

  await gm.say(".list auras");
  expect(gm.takeMessages().length).toBeGreaterThan(0);
});
