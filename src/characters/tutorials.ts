import { eq } from "drizzle-orm";
import type { Db } from "../database/database.ts";
import { account_tutorial } from "../database/schema/characters.ts";

/** `MAX_ACCOUNT_TUTORIAL_VALUES` */
export const MAX_ACCOUNT_TUTORIAL_VALUES = 8;

/** `WorldSession::m_Tutorials` and `m_TutorialsChanged`: the account's seen-tutorial bits (`account_tutorial`). */
export class AccountTutorials {
  readonly values: number[] = new Array<number>(MAX_ACCOUNT_TUTORIAL_VALUES).fill(0);
  changed = false;

  /** `WorldSession::GetTutorialInt` */
  get(index: number): number {
    return this.values[index] ?? 0;
  }

  /** `WorldSession::SetTutorialInt` */
  set(index: number, value: number): void {
    const next = value >>> 0;
    if (this.values[index] !== next) {
      this.values[index] = next;
      this.changed = true;
    }
  }

  /** `WorldSession::HandleTutorialFlag`: `CMSG_TUTORIAL_FLAG` marks one tutorial as seen. */
  flag(data: number): void {
    const index = Math.floor(data / 32);
    if (index >= MAX_ACCOUNT_TUTORIAL_VALUES) {
      return;
    }
    this.set(index, this.get(index) | (1 << (data % 32)));
  }

  /** `WorldSession::HandleTutorialClear`: `CMSG_TUTORIAL_CLEAR` marks every tutorial as seen. */
  clear(): void {
    for (let index = 0; index < MAX_ACCOUNT_TUTORIAL_VALUES; index++) {
      this.set(index, 0xffffffff);
    }
  }

  /** `WorldSession::HandleTutorialReset`: `CMSG_TUTORIAL_RESET` shows every tutorial again. */
  reset(): void {
    for (let index = 0; index < MAX_ACCOUNT_TUTORIAL_VALUES; index++) {
      this.set(index, 0);
    }
  }
}

/** `CHAR_SEL_TUTORIALS` into `WorldSession::LoadTutorialsData`. */
export async function loadTutorials(db: Db, accountId: number): Promise<AccountTutorials> {
  const tutorials = new AccountTutorials();
  const [row] = await db.select().from(account_tutorial).where(eq(account_tutorial.accountId, accountId));
  if (row) {
    tutorials.values.splice(0, MAX_ACCOUNT_TUTORIAL_VALUES, row.tut0, row.tut1, row.tut2, row.tut3, row.tut4, row.tut5, row.tut6, row.tut7);
  }
  tutorials.changed = false;
  return tutorials;
}

/** `WorldSession::SaveTutorialsData`: `CHAR_UPD_TUTORIALS` or `CHAR_INS_TUTORIALS`, only when a value changed. */
export async function saveTutorials(db: Db, accountId: number, tutorials: AccountTutorials): Promise<void> {
  if (!tutorials.changed) {
    return;
  }
  const [tut0, tut1, tut2, tut3, tut4, tut5, tut6, tut7] = tutorials.values as [number, number, number, number, number, number, number, number];
  const values = { tut0, tut1, tut2, tut3, tut4, tut5, tut6, tut7 };
  tutorials.changed = false;
  const [has] = await db.select({ accountId: account_tutorial.accountId }).from(account_tutorial).where(eq(account_tutorial.accountId, accountId));
  if (has) {
    await db.update(account_tutorial).set(values).where(eq(account_tutorial.accountId, accountId));
  } else {
    await db.insert(account_tutorial).values({ ...values, accountId });
  }
}
