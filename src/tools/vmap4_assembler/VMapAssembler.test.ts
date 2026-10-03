import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ModelFlags } from "../../common/Collision/Models/ModelInstance.ts";
import { crateMesh, dirBinBytes, makeTempDir, rawM2Bytes } from "../../common/Collision/test-fixtures.ts";
import { main } from "./VMapAssembler.ts";

const tmp = makeTempDir("vmapasm-test-");
afterAll(() => tmp.cleanup());

describe("VMapAssembler", () => {
  test("converts a raw dump directory", async () => {
    const raw = join(tmp.dir, "Buildings");
    const dest = join(tmp.dir, "vmaps");
    mkdirSync(raw);
    await Bun.write(join(raw, "cli_crate.m2"), rawM2Bytes(crateMesh()));
    await Bun.write(
      join(raw, "dir_bin"),
      dirBinBytes([{ mapID: 0, tileX: 1, tileY: 2, flags: ModelFlags.MOD_M2, adtId: 0, uniqueId: 1, pos: [0, 0, 0], rot: [0, 0, 0], scale: 1, name: "cli_crate.m2" }]),
    );
    const out = spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await main([raw, dest])).toBe(0);
      expect(out.mock.calls.at(-1)?.[0]).toBe("Ok, all done");
      expect(await main(["a", "b", "c"])).toBe(1);
      expect(await main([join(tmp.dir, "nothing"), join(tmp.dir, "out2")])).toBe(1);
    } finally {
      out.mockRestore();
    }
    expect(existsSync(join(dest, "000.vmtree"))).toBe(true);
    expect(existsSync(join(dest, "000_01_02.vmtile"))).toBe(true);
    expect(existsSync(join(dest, "cli_crate.m2.vmo"))).toBe(true);
  });
});
