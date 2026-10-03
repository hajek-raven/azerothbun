/**
 * Port of `game/Movement/MovementGenerator.{h,cpp}`: the base class of every movement generator, the
 * `MovementGeneratorMedium` that casts the `Unit*` to the owner type of the generator, and the generator factories.
 *
 * C++ virtual destructors have no TypeScript equivalent: `MotionMaster` calls `destroy()` wherever the C++ `delete`s a
 * generator (generators that own an `AbstractFollower` unregister from their target there).
 *
 * `IdleMovementFactory` (defined in `MovementGenerator.cpp`) lives in `MovementGenerators/IdleMovementGenerator.ts`, because
 * it needs `IdleMovementGenerator` and that class extends the one defined here (an import cycle otherwise).
 */
import { FactoryHolder } from "../../common/Dynamic/FactoryHolder.ts";
import { ObjectRegistry } from "../../common/Dynamic/ObjectRegistry.ts";
import type { MovementGeneratorType } from "./MotionMaster.ts";
import type { MovementOwner } from "./MovementOwner.ts";

/** A `float& x, y, z` out triple: the destination of `GetResetPosition`. */
export type ResetPosition = { x: number; y: number; z: number };

/** @ac game/Movement/MovementGenerator.h MovementGenerator */
export abstract class MovementGenerator {
  /** The C++ destructor. @ac game/Movement/MovementGenerator.cpp MovementGenerator::~MovementGenerator */
  destroy(): void {}

  /** @ac game/Movement/MovementGenerator.h MovementGenerator::Initialize */
  abstract initialize(unit: MovementOwner): void;
  /** @ac game/Movement/MovementGenerator.h MovementGenerator::Finalize */
  abstract finalize(unit: MovementOwner): void;

  /** @ac game/Movement/MovementGenerator.h MovementGenerator::Reset */
  abstract reset(unit: MovementOwner): void;

  /** @ac game/Movement/MovementGenerator.h MovementGenerator::Update */
  abstract update(unit: MovementOwner, time_diff: number): boolean;

  /** @ac game/Movement/MovementGenerator.h MovementGenerator::GetMovementGeneratorType */
  abstract getMovementGeneratorType(): MovementGeneratorType;

  /** Xinef: Escort system. @ac game/Movement/MovementGenerator.h MovementGenerator::GetSplineId */
  getSplineId(): number {
    return 0;
  }

  /** @ac game/Movement/MovementGenerator.h MovementGenerator::unitSpeedChanged */
  unitSpeedChanged(): void {}

  /** timer in ms. @ac game/Movement/MovementGenerator.h MovementGenerator::Pause */
  pause(_timer = 0): void {}
  /** timer in ms. @ac game/Movement/MovementGenerator.h MovementGenerator::Resume */
  resume(_overrideTimer = 0): void {}

  /** used by Evade code for select point to evade with expected restart default movement. @ac game/Movement/MovementGenerator.h MovementGenerator::GetResetPosition */
  getResetPosition(_pos: ResetPosition): boolean {
    return false;
  }
}

/**
 * `T` is the owner type: the C++ template parameter of `MovementGeneratorMedium<T, D>` (`D` is the derived class, which
 * TypeScript does not need: the derived class overrides the `do*` methods).
 *
 * @ac game/Movement/MovementGenerator.h MovementGeneratorMedium
 */
export abstract class MovementGeneratorMedium<T extends MovementOwner> extends MovementGenerator {
  /** @ac game/Movement/MovementGenerator.h MovementGeneratorMedium::Initialize */
  initialize(u: MovementOwner): void {
    //u->AssertIsType<T>();
    this.doInitialize(u as T);
  }

  /** @ac game/Movement/MovementGenerator.h MovementGeneratorMedium::Finalize */
  finalize(u: MovementOwner): void {
    //u->AssertIsType<T>();
    this.doFinalize(u as T);
  }

  /** @ac game/Movement/MovementGenerator.h MovementGeneratorMedium::Reset */
  reset(u: MovementOwner): void {
    //u->AssertIsType<T>();
    this.doReset(u as T);
  }

  /** @ac game/Movement/MovementGenerator.h MovementGeneratorMedium::Update */
  update(u: MovementOwner, time_diff: number): boolean {
    //u->AssertIsType<T>();
    return this.doUpdate(u as T, time_diff);
  }

  abstract doInitialize(u: T): void;
  abstract doFinalize(u: T): void;
  abstract doReset(u: T): void;
  abstract doUpdate(u: T, time_diff: number): boolean;
}

/** @ac game/Movement/MovementGenerator.h MovementGeneratorRegistry (`MovementGeneratorCreator::FactoryHolderRegistry`) */
export type MovementGeneratorRegistry = ObjectRegistry<FactoryHolder<MovementGenerator, MovementOwner, MovementGeneratorType>, MovementGeneratorType>;

/** @ac game/Movement/MovementGenerator.h sMovementGeneratorRegistry (`MovementGeneratorRegistry::instance()`) */
export const sMovementGeneratorRegistry: MovementGeneratorRegistry = new ObjectRegistry();

/** @ac game/Movement/MovementGenerator.h MovementGeneratorCreator (`FactoryHolder<MovementGenerator, Unit, MovementGeneratorType>`) */
export abstract class MovementGeneratorCreator extends FactoryHolder<MovementGenerator, MovementOwner, MovementGeneratorType> {
  constructor(movementGeneratorType: MovementGeneratorType) {
    super(sMovementGeneratorRegistry, movementGeneratorType);
  }
}

/** @ac game/Movement/MovementGenerator.h MovementGeneratorFactory (`new Movement()`) */
export class MovementGeneratorFactory<M extends MovementGenerator> extends MovementGeneratorCreator {
  constructor(
    movementGeneratorType: MovementGeneratorType,
    private readonly _movement: new () => M,
  ) {
    super(movementGeneratorType);
  }

  /** @ac game/Movement/MovementGenerator.h MovementGeneratorFactory::Create */
  create(_object?: MovementOwner | null): MovementGenerator {
    return new this._movement();
  }
}
