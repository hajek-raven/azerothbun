import { describe, expect, test } from "bun:test";
import { FactoryHolder } from "../../common/Dynamic/FactoryHolder.ts";
import { ObjectRegistry } from "../../common/Dynamic/ObjectRegistry.ts";
import { AddMovementGeneratorFactories } from "../AI/CreatureAIRegistry.ts";
import { SelectMovementGenerator } from "../AI/CreatureAISelector.ts";
import { IDLE_MOTION_TYPE, RANDOM_MOTION_TYPE, WAYPOINT_MOTION_TYPE } from "./MotionMaster.ts";
import { MovementGenerator, MovementGeneratorFactory, sMovementGeneratorRegistry } from "./MovementGenerator.ts";
import { IdleMovementGenerator } from "./MovementGenerators/IdleMovementGenerator.ts";
import { RandomMovementGenerator } from "./MovementGenerators/RandomMovementGenerator.ts";
import { WaypointMovementGenerator } from "./MovementGenerators/WaypointMovementGenerator.ts";
import { FakeUnit } from "./test-movement-owner.ts";

describe("ObjectRegistry and FactoryHolder", () => {
  test("insert, get, has, the registered items; a duplicate key is refused unless forced", () => {
    const registry = new ObjectRegistry<string, number>();
    expect(registry.getRegistryItem(1)).toBeNull();
    expect(registry.insertItem("a", 1)).toBe(true);
    expect(registry.insertItem("b", 1)).toBe(false);
    expect(registry.getRegistryItem(1)).toBe("a");
    expect(registry.insertItem("b", 1, true)).toBe(true);
    expect(registry.getRegistryItem(1)).toBe("b");
    expect(registry.hasItem(1)).toBe(true);
    expect(registry.hasItem(2)).toBe(false);
    expect([...registry.getRegisteredItems()]).toEqual([[1, "b"]]);
  });

  test("a factory registers itself under its key", () => {
    const registry = new ObjectRegistry<FactoryHolder<string, never, string>, string>();
    class Hello extends FactoryHolder<string, never, string> {
      create(): string {
        return "hello";
      }
    }
    const f = new Hello(registry, "hi");
    f.registerSelf();
    expect(registry.getRegistryItem("hi")).toBe(f);
    expect(registry.getRegistryItem("hi")!.create()).toBe("hello");
  });
});

describe("movement generator factories", () => {
  test("AddMovementGeneratorFactories registers idle, random and waypoint (once)", () => {
    AddMovementGeneratorFactories();
    AddMovementGeneratorFactories();
    expect(sMovementGeneratorRegistry.getRegisteredItems().size).toBe(3);
    expect(sMovementGeneratorRegistry.getRegistryItem(IDLE_MOTION_TYPE)!.create()).toBe(IdleMovementGenerator.instance);
    expect(sMovementGeneratorRegistry.getRegistryItem(RANDOM_MOTION_TYPE)!.create()).toBeInstanceOf(RandomMovementGenerator);
    expect(sMovementGeneratorRegistry.getRegistryItem(WAYPOINT_MOTION_TYPE)!.create()).toBeInstanceOf(WaypointMovementGenerator);
    // a new generator every time (`new Movement()`), the idle one is shared
    expect(sMovementGeneratorRegistry.getRegistryItem(RANDOM_MOTION_TYPE)!.create()).not.toBe(sMovementGeneratorRegistry.getRegistryItem(RANDOM_MOTION_TYPE)!.create());
  });

  test("MovementGeneratorFactory builds the generator class it was given", () => {
    class Probe extends MovementGenerator {
      initialize(): void {}
      finalize(): void {}
      reset(): void {}
      update(): boolean {
        return true;
      }
      getMovementGeneratorType() {
        return IDLE_MOTION_TYPE;
      }
    }
    const factory = new MovementGeneratorFactory(IDLE_MOTION_TYPE, Probe);
    expect(factory.create()).toBeInstanceOf(Probe);
  });

  test("SelectMovementGenerator: the default movement type of a creature, idle for a player or a charmed creature", () => {
    AddMovementGeneratorFactories();
    const random = new FakeUnit({ defaultMovementType: RANDOM_MOTION_TYPE });
    expect(SelectMovementGenerator(random.asOwner())).toBeInstanceOf(RandomMovementGenerator);
    const waypoint = new FakeUnit({ defaultMovementType: WAYPOINT_MOTION_TYPE });
    expect(SelectMovementGenerator(waypoint.asOwner())).toBeInstanceOf(WaypointMovementGenerator);
    const player = new FakeUnit({ player: true, defaultMovementType: RANDOM_MOTION_TYPE });
    expect(SelectMovementGenerator(player.asOwner())).toBe(IdleMovementGenerator.instance);
    const pet = new FakeUnit({ defaultMovementType: RANDOM_MOTION_TYPE });
    pet.charmerOrOwner = player;
    expect(SelectMovementGenerator(pet.asOwner())).toBe(IdleMovementGenerator.instance);
    const unknown = new FakeUnit({ defaultMovementType: 2 });
    expect(SelectMovementGenerator(unknown.asOwner())).toBeInstanceOf(WaypointMovementGenerator);
  });

  test("base generator defaults", () => {
    const gen = IdleMovementGenerator.instance;
    expect(gen.getSplineId()).toBe(0);
    expect(gen.getResetPosition({ x: 0, y: 0, z: 0 })).toBe(false);
    gen.unitSpeedChanged();
    gen.pause();
    gen.resume();
    gen.destroy();
  });
});
