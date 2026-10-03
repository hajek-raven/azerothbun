import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LISTFILE_DIRECTORY_NOT_FOUND, LISTFILE_OK, executableDirectoryPath, getDirContents, matchWildcardFilter } from "./PathCommon.ts";

describe("matchWildcardFilter", () => {
  test("exact and mismatching names", () => {
    expect(matchWildcardFilter("abc", "abc")).toBe(true);
    expect(matchWildcardFilter("abc", "abd")).toBe(false);
    expect(matchWildcardFilter("abc", "ab")).toBe(false);
    expect(matchWildcardFilter("ab", "abc")).toBe(false);
    expect(matchWildcardFilter(null, "abc")).toBe(false);
    expect(matchWildcardFilter("abc", null)).toBe(false);
  });

  test("a wildcard at the end matches the rest", () => {
    expect(matchWildcardFilter("*", "anything")).toBe(true);
    expect(matchWildcardFilter("000*", "0004832.map")).toBe(true);
    expect(matchWildcardFilter("001*", "0004832.map")).toBe(false);
  });

  test("a wildcard in the middle skips to the next filter character", () => {
    expect(matchWildcardFilter("*.vmtree", "000.vmtree")).toBe(true);
    expect(matchWildcardFilter("*.vmtree", "000.vmtile")).toBe(false);
    expect(matchWildcardFilter("000*.vmtile", "000_27_29.vmtile")).toBe(true);
    expect(matchWildcardFilter("000*.vmtile", "001_27_29.vmtile")).toBe(false);
  });
});

describe("getDirContents", () => {
  const dir = mkdtempSync(join(tmpdir(), "mmaps-pathcommon-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "000.vmtree"), "");
  writeFileSync(join(dir, "000_01_02.vmtile"), "");
  writeFileSync(join(dir, "001.vmtree"), "");

  test("lists the entries that match the filter", () => {
    const files: string[] = [];
    expect(getDirContents(files, dir, "*.vmtree")).toBe(LISTFILE_OK);
    expect(files.sort()).toEqual(["000.vmtree", "001.vmtree"]);
  });

  test("the default filter lists everything, like readdir(3), including . and ..", () => {
    const files: string[] = [];
    getDirContents(files, dir);
    expect(files).toContain(".");
    expect(files).toContain("..");
    expect(files).toContain("000_01_02.vmtile");
  });

  test("a missing directory is reported", () => {
    expect(getDirContents([], join(dir, "missing"))).toBe(LISTFILE_DIRECTORY_NOT_FOUND);
  });
});

test("executableDirectoryPath is the directory of the generator", () => {
  expect(executableDirectoryPath().endsWith("src/tools/mmaps_generator")).toBe(true);
});
