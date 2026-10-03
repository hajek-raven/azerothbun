/**
 * Port of `tools/mmaps_generator/PathCommon.h`: the directory helpers of the mmaps generator.
 */
import { readdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * `boost::dll::program_location().parent_path()`. The program is the generator entry point
 * (`src/tools/mmaps_generator/PathGenerator.ts`), so this is the directory of that file (the one that holds the
 * default `mmaps-config.yaml`).
 * @ac tools/mmaps_generator/PathCommon.h MMAP::executableDirectoryPath
 */
export function executableDirectoryPath(): string {
  return dirname(Bun.fileURLToPath(new URL("./PathGenerator.ts", import.meta.url)));
}

/**
 * Matches `str` against a filter that may contain `*` wildcards (a `*` matches any run of characters up to the next
 * filter character; a trailing `*` matches the rest).
 * @ac tools/mmaps_generator/PathCommon.h MMAP::matchWildcardFilter
 */
export function matchWildcardFilter(filter: string | null, str: string | null): boolean {
  if (filter === null || str === null) return false;

  let f = 0;
  let s = 0;
  // end on null character
  while (f < filter.length && s < str.length) {
    if (filter[f] === "*") {
      if (++f >= filter.length) {
        // wildcard at end of filter means all remaing chars match
        return true;
      }

      for (;;) {
        if (filter[f] === str[s]) break;
        if (s >= str.length) return false; // reached end of string without matching next filter character
        s++;
      }
    } else if (filter[f] !== str[s]) {
      return false; // mismatch
    }

    f++;
    s++;
  }

  return (f >= filter.length || (filter[f] === "*" && ++f >= filter.length)) && s >= str.length;
}

/** @ac tools/mmaps_generator/PathCommon.h MMAP::ListFilesResult */
export const ListFilesResult = {
  LISTFILE_DIRECTORY_NOT_FOUND: 0,
  LISTFILE_OK: 1,
} as const;
export type ListFilesResult = (typeof ListFilesResult)[keyof typeof ListFilesResult];
export const LISTFILE_DIRECTORY_NOT_FOUND = ListFilesResult.LISTFILE_DIRECTORY_NOT_FOUND;
export const LISTFILE_OK = ListFilesResult.LISTFILE_OK;

/**
 * Appends the names of the entries of `dirpath` that match `filter` to `fileList` (the POSIX branch: `.` and `..`
 * are entries too, they never match a filter that needs an extension).
 * @ac tools/mmaps_generator/PathCommon.h MMAP::getDirContents
 */
export function getDirContents(fileList: string[], dirpath = ".", filter = "*"): ListFilesResult {
  let names: string[];
  try {
    names = readdirSync(dirpath);
  } catch {
    return LISTFILE_DIRECTORY_NOT_FOUND;
  }

  // readdir(3) also returns "." and ".."
  for (const name of [".", "..", ...names]) {
    if (matchWildcardFilter(filter, name)) fileList.push(name);
  }

  return LISTFILE_OK;
}
