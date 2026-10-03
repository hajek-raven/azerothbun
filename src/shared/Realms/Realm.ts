/** `Realm realm` (`Realm.h`): the realm this world server runs, set from `realmlist` at startup. */
export type Realm = {
  Id: { Realm: number };
  Name: string;
  /** `realmlist.gamebuild`. */
  Build: number;
};

export const realm: Realm = { Id: { Realm: 1 }, Name: "", Build: 12340 };
