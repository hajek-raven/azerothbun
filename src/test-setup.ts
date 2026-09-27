import { setDefaultTimeout } from "bun:test";

// The first run builds the `acore_test_template_*` MySQL databases from sql/base (a few seconds).
setDefaultTimeout(30_000);
