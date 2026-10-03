import { describe, expect, test } from "bun:test";
import { FakeUnit } from "./test-movement-owner.ts";
import { AbstractFollower } from "./AbstractFollower.ts";

describe("AbstractFollower", () => {
  test("registers with its target and moves the registration when the target changes", () => {
    const a = new FakeUnit();
    const b = new FakeUnit();
    const follower = new AbstractFollower(a.asOwner());
    expect(follower.getTarget()).toBe(a.asOwner());
    expect(a.followers.has(follower)).toBe(true);
    follower.setTarget(b.asOwner());
    expect(a.followers.has(follower)).toBe(false);
    expect(b.followers.has(follower)).toBe(true);
    follower.setTarget(b.asOwner()); // the same target: nothing happens
    expect(b.followers.size).toBe(1);
    follower.setTarget(null);
    expect(follower.getTarget()).toBeNull();
    expect(b.followers.size).toBe(0);
  });

  test("no target by default; destroyFollower is SetTarget(nullptr)", () => {
    expect(new AbstractFollower().getTarget()).toBeNull();
    const a = new FakeUnit();
    const follower = new AbstractFollower(a.asOwner());
    follower.destroyFollower();
    expect(a.followers.size).toBe(0);
  });

  test("a target that drops all its followers (`Unit::RemoveAllFollowers`) clears them through SetTarget", () => {
    const a = new FakeUnit();
    const follower = new AbstractFollower(a.asOwner());
    for (const f of [...a.followers]) (f as AbstractFollower).setTarget(null);
    expect(follower.getTarget()).toBeNull();
  });
});
