import { afterEach, setDefaultTimeout } from "bun:test";

// The first run builds the `acore_test_template_*` MySQL databases from sql/base (a few seconds).
setDefaultTimeout(30_000);

// A test that set the map layer up (`src/world/map-world.test-util.ts` registers its teardown here) leaves nothing behind
// for the next one.
afterEach(() => {
  (globalThis as { tearDownMapTest?: () => void }).tearDownMapTest?.();
});
