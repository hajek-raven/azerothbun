/**
 * Port of `game/Movement/AbstractFollower.{h,cpp}`: a movement generator that follows a target unit and registers itself
 * with it (`Unit::FollowerAdded` / `FollowerRemoved`), so the target can drop every follower when it leaves the world.
 */
import type { MovementOwner } from "./MovementOwner.ts";

/** @ac game/Movement/AbstractFollower.h AbstractFollower */
export class AbstractFollower {
  private _target: MovementOwner | null = null;

  /** @ac game/Movement/AbstractFollower.h AbstractFollower::AbstractFollower */
  constructor(target: MovementOwner | null = null) {
    this.setTarget(target);
  }

  /** The C++ destructor is `SetTarget(nullptr)`; call it where the C++ deletes the generator. @ac game/Movement/AbstractFollower.h AbstractFollower::~AbstractFollower */
  destroyFollower(): void {
    this.setTarget(null);
  }

  /** @ac game/Movement/AbstractFollower.cpp AbstractFollower::SetTarget */
  setTarget(unit: MovementOwner | null): void {
    if (unit === this._target) return;

    if (this._target) this._target.followerRemoved(this);

    this._target = unit;
    if (this._target) this._target.followerAdded(this);
  }

  /** @ac game/Movement/AbstractFollower.h AbstractFollower::GetTarget */
  getTarget(): MovementOwner | null {
    return this._target;
  }
}
