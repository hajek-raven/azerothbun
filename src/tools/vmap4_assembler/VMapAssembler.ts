/**
 * vmap4_assembler: converts the raw vmap dump of `vmap4_extractor` into the runtime vmap files.
 *
 *   bun src/tools/vmap4_assembler/VMapAssembler.ts <raw data dir> <vmap dest dir>
 *
 * Defaults are `Buildings` and `vmaps`, like the C++ tool.
 */
import { TileAssembler } from "../../common/Collision/Maps/TileAssembler.ts";

/** @ac tools/vmap4_assembler/VMapAssembler.cpp main */
export async function main(argv: string[]): Promise<number> {
  let src = "Buildings";
  let dest = "vmaps";

  // argv excludes the program name; argc in C++ is argv.length + 1
  if (argv.length + 1 > 3) {
    console.log("usage: VMapAssembler.ts <raw data dir> <vmap dest dir>");
    return 1;
  }
  if (argv.length > 0) src = argv[0]!;
  if (argv.length > 1) dest = argv[1]!;

  console.log(`using ${src} as source directory and writing output to ${dest}`);

  const ta = new TileAssembler(src, dest);

  if (!(await ta.convertWorld2())) {
    console.log("exit with errors");
    return 1;
  }

  console.log("Ok, all done");
  return 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
