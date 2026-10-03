import { expect, test } from "bun:test";
import { queryFields } from "../../database/database.ts";
import { chatTestEnv, loginClient } from "../../game/Chat/test-chat.ts";
import { handleConsoleCommand } from "../../game/Server/console.ts";
import { QUEST_STATUS_COMPLETE, QUEST_STATUS_INCOMPLETE, QUEST_STATUS_NONE, QUEST_STATUS_REWARDED } from "../../world/quests.ts";

test(".quest add, complete, reward, and remove drive the quest log", async () => {
  const env = await chatTestEnv();
  const gm = await loginClient(env, "TEST", 1, 3);
  const player = gm.session.getPlayer()!;
  // 7: Kobold Camp Cleanup (Northshire)
  await gm.say(".quest add 7");
  expect(player.getQuestStatus(7)).toBe(QUEST_STATUS_INCOMPLETE);
  await gm.say(".quest complete 7");
  expect(player.getQuestStatus(7)).toBe(QUEST_STATUS_COMPLETE);
  const money = player.getMoney();
  await gm.say(".quest reward 7");
  expect(player.getQuestStatus(7)).toBe(QUEST_STATUS_REWARDED);
  expect(player.getMoney()).toBeGreaterThan(money);
  await gm.say(".quest remove 7");
  expect(player.getQuestStatus(7)).toBe(QUEST_STATUS_NONE);

  // Offline: the character_queststatus row.
  expect((await handleConsoleCommand("quest add 7 Testtwo", () => {}))?.ok).toBe(true);
  const [row] = await queryFields(env.db.characters, "SELECT status FROM character_queststatus WHERE guid = 2 AND quest = 7");
  expect(Number(row![0])).toBe(1);
});
