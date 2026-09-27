import { CreatureStats } from "../combat/creature-spell-unit.ts";
import type { CreatureInfo } from "../combat/creature.ts";
import { SpellStore } from "./spell-info.ts";
import { SpellUnit, type Point, type SpellMap, type UnitPosition } from "./unit.ts";

/** A packet a test unit sent (`opcode`, and whether it went to the set). */
export type SentPacket = { opcode: number; body: Uint8Array; toSet: boolean };

/** A flat map for spell tests: every unit sees every other, and time only moves with `advance`. */
export class TestMap implements SpellMap {
  readonly units: TestUnit[] = [];
  time = 1_000_000;

  constructor(readonly spells: SpellStore) {}

  now(): number {
    return this.time;
  }

  unit(guid: bigint): SpellUnit | null {
    return this.units.find((unit) => unit.guid === guid && unit.inWorld) ?? null;
  }

  unitsInRange(reference: SpellUnit, radius: number, center?: Point): SpellUnit[] {
    const at = center ?? reference.position();
    return this.units.filter((unit) => {
      const pos = unit.position();
      return (pos.x - at.x) ** 2 + (pos.y - at.y) ** 2 + (pos.z - at.z) ** 2 <= (radius + unit.combatReach) ** 2;
    });
  }

  /** One world tick for every unit. */
  advance(diff: number): void {
    this.time += diff;
    for (const unit of [...this.units]) unit.updateSpellsAndAuras(diff);
  }
}

let nextGuid = 1n;

/** A minimal `Unit` with creature-style stats: players and creatures differ only in `isPlayer` and faction team. */
export class TestUnit extends SpellUnit {
  readonly guid = nextGuid++;
  readonly stats: CreatureStats;
  readonly sent: SentPacket[] = [];
  pos: UnitPosition;
  hp: number;
  powers = [0, 0, 0, 0, 0, 0, 0];
  maxPowers = [0, 0, 0, 0, 0, 0, 0];
  flags = 0;
  auraState = 0;
  stand = 0;
  team: number;
  combat = new Set<SpellUnit>();
  threat = new Map<SpellUnit, number>();
  moving = false;
  combo = { target: 0n, points: 0 };
  learned: number[] = [];
  died = false;

  constructor(
    readonly world: TestMap,
    readonly isPlayer: boolean,
    options: { level?: number; health?: number; mana?: number; team?: number; x?: number; y?: number; classId?: number } = {},
  ) {
    super();
    const level = options.level ?? 10;
    const health = options.health ?? 1000;
    this.hp = health;
    this.team = options.team ?? (isPlayer ? 1 : 2);
    this.pos = { map: 0, x: options.x ?? 0, y: options.y ?? 0, z: 0, o: 0 };
    this.maxPowers[0] = options.mana ?? 1000;
    this.powers[0] = this.maxPowers[0];
    this.classIdValue = options.classId ?? 8;
    const info = {
      level, maxHealth: health, maxMana: this.maxPowers[0], armor: 0, attackPower: 0, resistances: [0, 0, 0, 0, 0, 0, 0],
      baseVariance: 1, baseDamage: 5, damageModifier: 1, attackTime: 2000, typeFlags: 0,
    } as unknown as CreatureInfo;
    this.stats = new CreatureStats(info, () => {});
    world.units.push(this);
  }

  private readonly classIdValue: number;
  get entry(): number {
    return this.isPlayer ? 0 : 1;
  }
  get level(): number {
    return (this.stats as unknown as { info: CreatureInfo }).info.level;
  }
  get classId(): number {
    return this.classIdValue;
  }
  get inWorld(): boolean {
    return true;
  }
  position(): UnitPosition {
    return this.pos;
  }
  get combatReach(): number {
    return 1.5;
  }
  get boundingRadius(): number {
    return 0.4;
  }
  isAlive(): boolean {
    return this.hp > 0;
  }
  get health(): number {
    return this.hp;
  }
  get maxHealth(): number {
    return this.stats.maxHealth;
  }
  setHealth(value: number): void {
    this.hp = Math.max(0, Math.min(this.maxHealth, Math.trunc(value)));
  }
  get createHealth(): number {
    return this.maxHealth;
  }
  get createMana(): number {
    return this.maxPowers[0]!;
  }
  get powerType(): number {
    return 0;
  }
  power(power: number): number {
    return this.powers[power] ?? 0;
  }
  maxPower(power: number): number {
    return this.maxPowers[power] ?? 0;
  }
  setPower(power: number, value: number): void {
    this.powers[power] = Math.max(0, Math.min(this.maxPower(power), Math.trunc(value)));
  }
  get unitFlags(): number {
    return this.flags;
  }
  setUnitFlag(flag: number, on: boolean): void {
    this.flags = on ? this.flags | flag : this.flags & ~flag;
  }
  get auraStateField(): number {
    return this.auraState;
  }
  set auraStateField(value: number) {
    this.auraState = value;
  }
  reactionTo(target: SpellUnit): number {
    return (target as TestUnit).team === this.team ? 4 : 1;
  }
  isInCombat(): boolean {
    return this.combat.size > 0;
  }
  setInCombatWith(enemy: SpellUnit): void {
    this.combat.add(enemy);
    (enemy as TestUnit).combat.add(this);
  }
  get creatureType(): number {
    return 7;
  }
  isGameMaster(): boolean {
    return false;
  }
  isInFlight(): boolean {
    return false;
  }
  isMounted(): boolean {
    return false;
  }
  isMoving(): boolean {
    return this.moving;
  }
  isEvading(): boolean {
    return false;
  }
  get shapeshiftForm(): number {
    return 0;
  }
  get standState(): number {
    return this.stand;
  }
  setStandState(state: number): void {
    this.stand = state;
  }
  get isTotem(): boolean {
    return false;
  }
  sendToSelf(opcode: number, body: Uint8Array): void {
    this.sent.push({ opcode, body, toSet: false });
  }
  sendToSet(opcode: number, body: Uint8Array): void {
    this.sent.push({ opcode, body, toSet: true });
  }
  receiveDamage(_attacker: SpellUnit | null, damage: number): boolean {
    this.hp = Math.max(0, this.hp - damage);
    if (this.hp === 0 && !this.died) {
      this.died = true;
      this.interruptNonMeleeSpells(false);
      this.removeAllAurasOnDeath();
    }
    return this.hp === 0;
  }
  addThreat(attacker: SpellUnit, amount: number): void {
    this.threat.set(attacker, (this.threat.get(attacker) ?? 0) + amount);
  }
  modifyThreatPercent(attacker: SpellUnit, percent: number): void {
    const value = this.threat.get(attacker);
    if (value !== undefined) this.threat.set(attacker, (value * (100 + percent)) / 100);
  }
  forwardThreatForAssistingMe(): void {}
  taunt(): void {}
  attackStop(): void {}
  sendSpeed(): void {}
  sendRoot(): void {}
  get comboPoints(): number {
    return this.combo.points;
  }
  get comboTarget(): bigint {
    return this.combo.target;
  }
  addComboPoints(target: SpellUnit, count: number): void {
    if (target.guid !== this.combo.target) this.combo = { target: target.guid, points: 0 };
    this.combo.points = Math.min(5, this.combo.points + count);
  }
  clearComboPoints(): void {
    this.combo = { target: 0n, points: 0 };
  }
  startCooldownOnEvent(): void {}
  isInPartyWith(other: SpellUnit): boolean {
    return other === this;
  }
  charmerOrOwner(): SpellUnit | null {
    return null;
  }
  victim(): SpellUnit | null {
    return null;
  }
  nearTeleportTo(x: number, y: number, z: number, orientation: number): void {
    this.pos = { ...this.pos, x, y, z, o: orientation };
  }
  override learnSpell(spellId: number): void {
    this.learned.push(spellId);
  }
  override canHaveThreatList(): boolean {
    return !this.isPlayer;
  }
  override hasSpell(): boolean {
    return true;
  }
  override hasItem(): boolean {
    return true;
  }
  override hasItemCount(): boolean {
    return true;
  }
  /** Opcodes this unit sent, in order. */
  opcodes(): number[] {
    return this.sent.map((packet) => packet.opcode);
  }
}
