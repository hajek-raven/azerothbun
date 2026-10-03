/**
 * Port of `game/Movement/MovementGenerators/IdleMovementGenerator.{h,cpp}`: the idle generator (a shared instance),
 * `RotateMovementGenerator`, `DistractMovementGenerator` and `AssistanceDistractMovementGenerator`.
 *
 * `IdleMovementFactory` (defined in `MovementGenerator.cpp`) is here: it needs `IdleMovementGenerator`, and
 * `MovementGenerator.ts` cannot import this file (the base class would not exist yet when this one extends it).
 */
import { UNIT_STAND_STATE_STAND, UNIT_STATE_DISTRACTED, UNIT_STATE_ROTATING } from "../../../spells/enums.ts";
import { MovementGenerator, MovementGeneratorCreator } from "../MovementGenerator.ts";
import {
  ASSISTANCE_DISTRACT_MOTION_TYPE,
  DISTRACT_MOTION_TYPE,
  IDLE_MOTION_TYPE,
  type MovementGeneratorType,
  ROTATE_DIRECTION_LEFT,
  ROTATE_MOTION_TYPE,
  type RotateDirection,
} from "../MotionMaster.ts";
import { REACT_AGGRESSIVE, type MovementOwner, type MovementOwnerCreature } from "../MovementOwner.ts";

const F = Math.fround;
/** `static_cast<float>(M_PI * 2)` */
const TWO_PI_F = F(Math.PI * 2);

/** @ac game/Movement/MovementGenerators/IdleMovementGenerator.h IdleMovementGenerator */
export class IdleMovementGenerator extends MovementGenerator {
  /** `static IdleMovementGenerator instance` of `IdleMovementFactory::Create`. */
  static readonly instance = new IdleMovementGenerator();

  // StopMoving is needed to make unit stop if its last movement generator expires
  // But it should not be sent otherwise there are many redundent packets
  /** @ac game/Movement/MovementGenerators/IdleMovementGenerator.cpp IdleMovementGenerator::Initialize */
  initialize(owner: MovementOwner): void {
    this.reset(owner);
  }

  /** @ac game/Movement/MovementGenerators/IdleMovementGenerator.h IdleMovementGenerator::Finalize */
  finalize(_unit: MovementOwner): void {}

  /** @ac game/Movement/MovementGenerators/IdleMovementGenerator.cpp IdleMovementGenerator::Reset */
  reset(owner: MovementOwner): void {
    if (!owner.isStopped()) owner.stopMoving();
  }

  /** @ac game/Movement/MovementGenerators/IdleMovementGenerator.h IdleMovementGenerator::Update */
  update(_unit: MovementOwner, _diff: number): boolean {
    return true;
  }

  /** @ac game/Movement/MovementGenerators/IdleMovementGenerator.h IdleMovementGenerator::GetMovementGeneratorType */
  getMovementGeneratorType(): MovementGeneratorType {
    return IDLE_MOTION_TYPE;
  }
}

/** @ac game/Movement/MovementGenerator.h IdleMovementFactory */
export class IdleMovementFactory extends MovementGeneratorCreator {
  constructor() {
    super(IDLE_MOTION_TYPE);
  }

  /** @ac game/Movement/MovementGenerator.cpp IdleMovementFactory::Create */
  create(_object?: MovementOwner | null): MovementGenerator {
    return IdleMovementGenerator.instance;
  }
}

/** @ac game/Movement/MovementGenerators/IdleMovementGenerator.h RotateMovementGenerator */
export class RotateMovementGenerator extends MovementGenerator {
  private m_duration: number;
  private m_maxDuration: number;
  private m_direction: RotateDirection;

  /** @ac game/Movement/MovementGenerators/IdleMovementGenerator.h RotateMovementGenerator::RotateMovementGenerator */
  constructor(time: number, direction: RotateDirection) {
    super();
    this.m_duration = time >>> 0;
    this.m_maxDuration = time >>> 0;
    this.m_direction = direction;
  }

  /** @ac game/Movement/MovementGenerators/IdleMovementGenerator.cpp RotateMovementGenerator::Initialize */
  initialize(owner: MovementOwner): void {
    if (!owner.isStopped()) owner.stopMoving();

    const victim = owner.getVictim();
    if (victim) owner.setInFront(victim);

    owner.addUnitState(UNIT_STATE_ROTATING);

    owner.attackStop();
  }

  /** @ac game/Movement/MovementGenerators/IdleMovementGenerator.cpp RotateMovementGenerator::Finalize */
  finalize(unit: MovementOwner): void {
    unit.clearUnitState(UNIT_STATE_ROTATING);
    const creature = unit.toCreature();
    if (creature) creature.ai()?.MovementInform?.(ROTATE_MOTION_TYPE, 0);
  }

  /** @ac game/Movement/MovementGenerators/IdleMovementGenerator.h RotateMovementGenerator::Reset */
  reset(owner: MovementOwner): void {
    this.initialize(owner);
  }

  /** @ac game/Movement/MovementGenerators/IdleMovementGenerator.cpp RotateMovementGenerator::Update */
  update(owner: MovementOwner, diff: number): boolean {
    let angle = owner.getOrientation();
    if (this.m_direction === ROTATE_DIRECTION_LEFT) {
      angle = F(angle + F(F(F(diff) * TWO_PI_F) / this.m_maxDuration));
      while (angle >= TWO_PI_F) angle = F(angle - TWO_PI_F);
    } else {
      angle = F(angle - F(F(F(diff) * TWO_PI_F) / this.m_maxDuration));
      while (angle < 0) angle = F(angle + TWO_PI_F);
    }

    owner.setFacingTo(angle);

    if (this.m_duration > diff) this.m_duration -= diff;
    else return false;

    return true;
  }

  /** @ac game/Movement/MovementGenerators/IdleMovementGenerator.h RotateMovementGenerator::GetMovementGeneratorType */
  getMovementGeneratorType(): MovementGeneratorType {
    return ROTATE_MOTION_TYPE;
  }
}

/** @ac game/Movement/MovementGenerators/IdleMovementGenerator.h DistractMovementGenerator */
export class DistractMovementGenerator extends MovementGenerator {
  protected m_timer: number;

  /** @ac game/Movement/MovementGenerators/IdleMovementGenerator.h DistractMovementGenerator::DistractMovementGenerator */
  constructor(timer: number) {
    super();
    this.m_timer = timer >>> 0;
  }

  /** @ac game/Movement/MovementGenerators/IdleMovementGenerator.cpp DistractMovementGenerator::Initialize */
  initialize(owner: MovementOwner): void {
    // Distracted creatures stand up if not standing
    if (!owner.isStandState()) owner.setStandState(UNIT_STAND_STATE_STAND);

    owner.addUnitState(UNIT_STATE_DISTRACTED);
  }

  /** @ac game/Movement/MovementGenerators/IdleMovementGenerator.cpp DistractMovementGenerator::Finalize */
  finalize(owner: MovementOwner): void {
    owner.clearUnitState(UNIT_STATE_DISTRACTED);

    // If this is a creature, then return orientation to original position (for idle movement creatures)
    const creature = owner.toCreature();
    if (creature) {
      const angle = creature.getHomePosition().getOrientation();
      owner.setFacingTo(angle);
    }
  }

  /** @ac game/Movement/MovementGenerators/IdleMovementGenerator.h DistractMovementGenerator::Reset */
  reset(owner: MovementOwner): void {
    this.initialize(owner);
  }

  /** @ac game/Movement/MovementGenerators/IdleMovementGenerator.cpp DistractMovementGenerator::Update */
  update(owner: MovementOwner, time_diff: number): boolean {
    if (owner.isInCombat() || time_diff > this.m_timer) return false;

    this.m_timer -= time_diff;
    return true;
  }

  /** @ac game/Movement/MovementGenerators/IdleMovementGenerator.h DistractMovementGenerator::GetMovementGeneratorType */
  getMovementGeneratorType(): MovementGeneratorType {
    return DISTRACT_MOTION_TYPE;
  }
}

/** @ac game/Movement/MovementGenerators/IdleMovementGenerator.h AssistanceDistractMovementGenerator */
export class AssistanceDistractMovementGenerator extends DistractMovementGenerator {
  /** @ac game/Movement/MovementGenerators/IdleMovementGenerator.h AssistanceDistractMovementGenerator::AssistanceDistractMovementGenerator */
  constructor(timer: number) {
    super(timer);
  }

  /** @ac game/Movement/MovementGenerators/IdleMovementGenerator.h AssistanceDistractMovementGenerator::GetMovementGeneratorType */
  override getMovementGeneratorType(): MovementGeneratorType {
    return ASSISTANCE_DISTRACT_MOTION_TYPE;
  }

  /** @ac game/Movement/MovementGenerators/IdleMovementGenerator.cpp AssistanceDistractMovementGenerator::Finalize */
  override finalize(unit: MovementOwner): void {
    unit.clearUnitState(UNIT_STATE_DISTRACTED);
    (unit.toCreature() as MovementOwnerCreature).setReactState(REACT_AGGRESSIVE);
  }
}
