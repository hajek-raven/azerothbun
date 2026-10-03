/**
 * The `Player` (and the `Unit` / `Creature` / `GameObject` parts) the chat commands act on. The port keeps player state
 * on `WorldSession`; `SessionPlayer` (`src/world/session-player.ts`) implements this interface over it. Methods keep
 * the C++ names in camelCase.
 */
import type { SpellUnit } from "../../../spells/unit.ts";
import type { WorldSession } from "../../../world/session.ts";
import type { ChatParty } from "../../Chat/Chat.ts";

export type WorldPosition = { mapId: number; x: number; y: number; z: number; o: number };

/** A `Unit` a command selected: the player itself, another player, or a creature. */
export interface CommandUnit {
  getName(): string;
  getGUID(): bigint;
  getEntry(): number;
  isPlayer(): boolean;
  isCreature(): boolean;
  isPet(): boolean;
  toPlayer(): Player | null;
  isAlive(): boolean;
  isInCombat(): boolean;
  getLevel(): number;
  getHealth(): number;
  getMaxHealth(): number;
  setHealth(value: number): void;
  setMaxHealth(value: number): void;
  getPower(power: number): number;
  getMaxPower(power: number): number;
  setPower(power: number, value: number): void;
  setMaxPower(power: number, value: number): void;
  getMapId(): number;
  getPositionX(): number;
  getPositionY(): number;
  getPositionZ(): number;
  getOrientation(): number;
  getPhaseMask(): number;
  getFaction(): number;
  setFaction(faction: number): void;
  getDisplayId(): number;
  getNativeDisplayId(): number;
  setDisplayId(displayId: number): void;
  deMorph(): void;
  getValuesCount(): number;
  setPhaseMask(newPhaseMask: number, update: boolean): void;
  getObjectScale(): number;
  setObjectScale(scale: number): void;
  getUnitFlags(): number;
  replaceAllUnitFlags(flags: number): void;
  getNpcFlags(): number;
  replaceAllNpcFlags(flags: number): void;
  getDynamicFlags(): number;
  replaceAllDynamicFlags(flags: number): void;
  getUInt32Value(index: number): number;
  setUInt32Value(index: number, value: number): void;
  setSpeedRate(moveType: number, rate: number): void;
  getSpeedRate(moveType: number): number;
  /** The unit's spell and aura state (`Unit` auras, `CastSpell`). */
  spellUnit(): SpellUnit | null;
  /** `Unit::Kill(killer, this)` */
  kill(killer: Player): void;
  /** `Unit::DealDamage(attacker, this, damage, DIRECT_DAMAGE)` */
  dealDamage(attacker: Player, damage: number): void;
  combatStop(): void;
}

/** A `GameObject` a command found near the player. */
export interface CommandGameObject {
  getName(): string;
  getGUID(): bigint;
  getEntry(): number;
  getSpawnId(): number;
  getMapId(): number;
  getPositionX(): number;
  getPositionY(): number;
  getPositionZ(): number;
  getOrientation(): number;
  getGoType(): number;
  getGoState(): number;
  setGoState(state: number): void;
  getPhaseMask(): number;
}

/** A creature spawned in the player's map (`Map::GetCreatureBySpawnIdStore` entry). */
export interface CommandCreature extends CommandUnit {
  getSpawnId(): number;
  isDead(): boolean;
  /** `Creature::Respawn(true)` */
  respawn(): void;
  getRespawnTime(): number;
  /** @ac game/Entities/Creature/Creature.cpp Creature::LowerPlayerDamageReq */
  lowerPlayerDamageReq(unDamage: number): void;
  /** `GetMotionMaster()->MovePoint(id, x, y, z)` */
  movePoint(id: number, x: number, y: number, z: number): void;
  /** The `MotionMaster` state `.movegens` lists. */
  motion(): { victim: number | null; evading: boolean; moving: boolean; home: boolean; destination: { x: number; y: number; z: number } | null } | null;
}

export interface Player extends CommandUnit {
  getSession(): WorldSession;
  getGUIDLow(): number;
  isInWorld(): boolean;
  getRace(): number;
  getClass(): number;
  getGender(): number;
  getTeamId(): number;
  getZoneId(): number;
  getAreaId(): number;
  getInstanceId(): number;
  getMoney(): number;
  setMoney(value: number): void;
  modifyMoney(delta: number): boolean;
  getTotalPlayedTime(): number;
  getLevelPlayedTime(): number;
  getLoginTime(): number;
  getXP(): number;
  /** The sender and receiver of chat packets (`BuildChatPacket(…, WorldObject*)`). */
  chatParty(): ChatParty;
  getChatTag(): number;
  sendMessageToSet(opcode: number, body: Uint8Array, self: boolean): void;

  // selection and visibility
  getTarget(): bigint;
  getSelectedPlayer(): Player | null;
  getSelectedUnit(): CommandUnit | null;
  isVisibleGloballyFor(other: Player): boolean;
  findNearestGameObject(range: number, goType?: number): CommandGameObject | null;
  getCreatureBySpawnId(spawnId: number): CommandCreature | null;
  getGameObjectBySpawnId(spawnId: number): CommandGameObject | null;
  /** Creatures of the player's map in the spawn index (`Map::GetCreatureBySpawnIdStore`). */
  getMapCreatures(): CommandCreature[];
  getDistance(other: { getPositionX(): number; getPositionY(): number; getPositionZ(): number }): number;

  // GM state
  isGameMaster(): boolean;
  setGameMaster(on: boolean): void;
  isGMChat(): boolean;
  setGMChat(on: boolean): void;
  isGMVisible(): boolean;
  setGMVisible(on: boolean): void;
  isGMSpectator(): boolean;
  setGMSpectator(on: boolean): void;
  isAcceptWhispers(): boolean;
  setAcceptWhispers(on: boolean): void;
  isDeveloper(): boolean;
  setDeveloper(on: boolean): void;
  isCommentator(): boolean;
  setCommentator(on: boolean): void;
  setBeastMaster(on: boolean): void;
  isTaxiCheater(): boolean;
  setTaxiCheater(on: boolean): void;
  getCommandStatus(command: number): boolean;
  setCommandStatusOn(command: number): void;
  setCommandStatusOff(command: number): void;
  canFly(): boolean;
  setCanFly(on: boolean): void;
  setWaterWalking(on: boolean): void;
  getExtraFlags(): number;

  // chat
  isAFK(): boolean;
  isDND(): boolean;
  toggleAFK(): void;
  toggleDND(): void;
  getAutoReplyMsg(): string;
  setAutoReplyMsg(msg: string): void;
  canSpeak(): boolean;
  addWhisperWhiteList(guid: bigint): void;
  isInWhisperWhiteList(guid: bigint): boolean;
  removeFromWhisperWhiteList(guid: bigint): void;
  clearWhisperWhiteList(): void;
  say(text: string, language: number): void;
  yell(text: string, language: number): void;
  textEmote(text: string): void;
  whisper(text: string, language: number, receiver: Player): void;

  // movement
  teleportTo(mapId: number, x: number, y: number, z: number, orientation: number, options?: number): boolean;
  isBeingTeleported(): boolean;
  isInFlight(): boolean;
  isMounted(): boolean;
  dismount(): void;
  saveRecallPosition(): void;
  getRecallPosition(): WorldPosition;
  getHomebind(): WorldPosition | null;
  getStartPosition(): WorldPosition | null;
  repopAtGraveyard(): Promise<void>;
  getClosePoint(size: number): { x: number; y: number; z: number };
  getObjectSize(): number;
  getGroup(): null;

  // progression
  giveLevel(level: number): void;
  setLevel(level: number): void;
  initStatsForLevel(): void;
  setFreeTalentPoints(points: number): void;
  getFreeTalentPoints(): number;
  getHonorPoints(): number;
  setHonorPoints(value: number): void;
  modifyHonorPoints(delta: number): void;
  getArenaPoints(): number;
  setArenaPoints(value: number): void;
  modifyArenaPoints(delta: number): void;
  hasTitle(bitIndex: number): boolean;
  setTitle(bitIndex: number, lost: boolean): void;
  getChosenTitle(): number;
  setChosenTitle(bitIndex: number): void;
  setAtLoginFlag(flag: number): void;
  getReputation(factionId: number): number | null;
  setReputation(factionId: number, standing: number): boolean;
  getReputationOf(factionId: number): number;
  setOneFactionReputation(factionId: number, standing: number): boolean;
  mount(displayId: number): void;
  setGender(gender: number): void;
  sendTalentsInfoData(pet: boolean): void;
  getRaceMask(): number;
  getPlayerSetting(source: string, index: number): number;
  updatePlayerSetting(source: string, index: number, value: number): void;
  durabilityRepairAll(cost: boolean, discountMod: number, guildBank: boolean): Promise<void>;
  getAverageItemLevel(): number;
  initDisplayIds(): void;
  setFactionForRace(): void;
  resetSpells(): void;
  resetTalents(noResetCost: boolean): boolean;
  getItemFromBuyBackSlot(slot: number): { entry: number } | null;
  removeItemFromBuyBackSlot(slot: number, del: boolean): void;
  getQuestStatus(questId: number): number;
  getSkillPermBonusValue(skillId: number): number;
  getSkillTempBonusValue(skillId: number): number;
  setName(name: string): void;
  initTalentForLevel(): void;
  getItemByPos(bag: number, slot: number): { entry: number; count: number } | null;
  getBagByPos(bag: number): { size: number; entry: number; freeSlots: number } | null;
  isSpellFitByClassAndRace(spellId: number): boolean;
  getFreePrimaryProfessionPoints(): number;
  getClassMask(): number;
  learnDefaultSkills(): void;
  learnCustomSpells(): void;
  learnQuestRewardedSpells(quest?: import("../../../world/quests.ts").QuestTemplate): void;
  satisfyQuestClass(quest: import("../../../world/quests.ts").QuestTemplate): boolean;
  rewardHonor(victim: CommandUnit | null, groupsize: number, honor?: number): Promise<boolean>;
  updateHonorFields(): void;
  setDrunkValue(value: number): void;

  // spells and auras
  hasSpell(spellId: number): boolean;
  learnSpell(spellId: number): void;
  removeSpell(spellId: number): void;
  getSpells(): readonly number[];
  castSpell(target: CommandUnit | null, spellId: number, triggered: boolean): void;
  removeSpellCooldown(spellId: number, update: boolean): void;
  removeAllSpellCooldown(): void;
  hasAura(spellId: number): boolean;
  removeAurasDueToSpell(spellId: number): void;

  // skills
  hasSkill(skillId: number): boolean;
  getSkillValue(skillId: number): number;
  getPureSkillValue(skillId: number): number;
  getMaxSkillValue(skillId: number): number;
  getPureMaxSkillValue(skillId: number): number;
  getSkillStep(skillId: number): number;
  setSkill(skillId: number, step: number, value: number, max: number): void;
  updateSkillsToMaxSkillsForLevel(): void;

  // items
  hasItemCount(entry: number, count: number, inBankAlso?: boolean): boolean;
  getItemCount(entry: number, inBankAlso?: boolean): number;
  destroyItemCount(entry: number, count: number): Promise<void>;
  /** @ac game/Entities/Player/PlayerStorage.cpp Player::DestroyItem */
  destroyItem(bag: number, slot: number): Promise<boolean>;
  /** `CanStoreNewItem` + `StoreNewItem` + `SendNewItem`: how many were stored and the equip error when not all fit. */
  addItem(entry: number, count: number, notify: Player | null): Promise<{ stored: number; noSpaceForCount: number; error: number }>;

  // death
  resurrectPlayer(restorePercent: number): Promise<void>;
  spawnCorpseBones(): Promise<void>;

  // persistence
  saveToDB(): Promise<void>;
  getSaveTimer(): number;
}
