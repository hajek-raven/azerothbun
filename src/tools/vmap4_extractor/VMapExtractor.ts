/**
 * The vmap4 extractor: client MPQs to the raw model dump (`Buildings/`: `dir_bin`, raw `.wmo` / `.m2` files,
 * `temp_gameobject_models`) that `src/tools/vmap4_assembler/VMapAssembler.ts` turns into `data/vmaps`.
 *
 *   bun src/tools/vmap4_extractor/VMapExtractor.ts <client dir> [output dir = data/Buildings] [--locale enUS] [--maps 0,1] [-s | -l]
 *
 * @ac tools/vmap4_extractor/vmapexport.cpp main
 */
import { processArgv, runVMapExtractor } from "./vmapexport.ts";

export async function main(argv: string[]): Promise<number> {
  const options = processArgv(argv);
  if (!options) {
    return 1;
  }
  const started = Bun.nanoseconds();
  const code = await runVMapExtractor(options);
  console.log(`Took ${((Bun.nanoseconds() - started) / 1e9).toFixed(1)} s`);
  return code;
}

if (import.meta.main) {
  process.exit(await main(Bun.argv.slice(2)));
}
