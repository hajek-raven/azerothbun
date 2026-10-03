import { expect, test } from "bun:test";
import { ConfigMgr, ConfigSeverity, defaultConfigPolicy } from "../../common/config.ts";
import { IN_MILLISECONDS } from "../../common/duration.ts";
import { ShutdownExitCode, startWorldUpdateLoop, World, WorldTimer } from "./world.ts";
import { WorldConfig } from "./world-config.ts";

test("a zero delay stops the world unless players are still online for an idle shutdown", () => {
  const world = new World(emptyWorldConfig());
  world.shutdownServ(0, 0, 0, "test");
  expect(world.isStopped()).toBe(true);

  const idle = new World(emptyWorldConfig());
  idle.setSessionCounts(1);
  idle.shutdownServ(0, 2);
  expect(idle.isStopped()).toBe(false);
  expect(idle.getShutdownTimer()).toBe(1);
});

test("the five second world timer resets after it fires", () => {
  const world = new World(emptyWorldConfig());
  world.update(5 * IN_MILLISECONDS - 1);
  expect(world.timer(WorldTimer.WUPDATE_5_SECS).passed()).toBe(false);
  world.update(1);
  expect(world.timer(WorldTimer.WUPDATE_5_SECS).getCurrent()).toBe(0);
});

test("shutdown cancel clears a pending timer", () => {
  const world = new World(emptyWorldConfig());
  world.shutdownServ(30, 0);
  expect(world.getShutdownTimer()).toBe(30);
  world.shutdownCancel();
  expect(world.getShutdownTimer()).toBe(0);
  expect(world.isStopped()).toBe(false);
});

test("the update loop ticks until stopNow, then calls onStop once", async () => {
  const world = new World(emptyWorldConfig());
  const stopped = Promise.withResolvers<number>();
  let stops = 0;
  startWorldUpdateLoop(world, {
    minUpdateDiff: 1,
    maxCoreStuckTime: 60,
    onStop() {
      stops += 1;
      stopped.resolve(world.loopCounter);
    },
  });
  await Bun.sleep(20);
  expect(world.loopCounter).toBeGreaterThan(1);
  world.stopNow(ShutdownExitCode.Shutdown);
  expect(await stopped.promise).toBeGreaterThan(1);
  await Bun.sleep(10);
  expect(stops).toBe(1);
});

test("stopping the loop cancels the pending tick", async () => {
  const world = new World(emptyWorldConfig());
  const loop = startWorldUpdateLoop(world, { minUpdateDiff: 1, maxCoreStuckTime: 60 });
  await Bun.sleep(10);
  loop.stop();
  const counter = world.loopCounter;
  await Bun.sleep(20);
  expect(world.loopCounter).toBe(counter);
});

function emptyWorldConfig(): WorldConfig {
  const config = new ConfigMgr();
  const policy = defaultConfigPolicy();
  policy.missingOptionSeverity = ConfigSeverity.Skip;
  policy.criticalOptionSeverity = ConfigSeverity.Skip;
  policy.valueErrorSeverity = ConfigSeverity.Skip;
  config.configure("", [], "", policy);
  const settings = new WorldConfig(config);
  settings.load();
  return settings;
}

test("the tick runs the sessions, then the map update, with the same diff", () => {
  const world = new World(emptyWorldConfig());
  const order: string[] = [];
  world.setSessionUpdate((diff) => order.push(`sessions ${diff}`));
  world.setMapUpdate((diff) => order.push(`maps ${diff}`));
  world.update(37);
  expect(order).toEqual(["sessions 37", "maps 37"]);
  world.setMapUpdate(null);
  world.update(1);
  expect(order).toHaveLength(3);
});
