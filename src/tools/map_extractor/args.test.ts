/** `HandleArgs` of the extractor CLI. */
import { describe, expect, test } from "bun:test";
import { Extract, HandleArgs } from "./System.ts";

describe("HandleArgs", () => {
  test("defaults", () => {
    const options = HandleArgs(["client"]);
    expect(options.input).toBe("client");
    expect(options.output).toBe("data");
    expect(options.maps).toBeNull();
    expect(options.locale).toBeNull();
    expect(options.extract).toBe(Extract.EXTRACT_MAP | Extract.EXTRACT_DBC | Extract.EXTRACT_CAMERA);
  });

  test("output directory, map filter and locale", () => {
    const options = HandleArgs(["/games/wow", "out", "--maps", "0,1,530", "--locale", "deDE"]);
    expect(options.input).toBe("/games/wow");
    expect(options.output).toBe("out");
    expect([...options.maps!]).toEqual([0, 1, 530]);
    expect(options.locale).toBe("deDE");
  });

  test("--extract selects the parts", () => {
    expect(HandleArgs(["c", "--extract", "map"]).extract).toBe(Extract.EXTRACT_MAP);
    expect(HandleArgs(["c", "--extract", "map,dbc"]).extract).toBe(Extract.EXTRACT_MAP | Extract.EXTRACT_DBC);
  });
});
