/**
 * Copies every `DBFilesClient\*.dbc` from a 3.3.5a client into `data/dbc`, the files `map_extractor` writes as
 * `dbc/` in AzerothCore. Later archives in the client's load order override earlier ones (patches win).
 *
 *   bun src/tools/extract-dbc.ts <client directory> [output directory]
 */
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { archiveOrder, detectLocale, MpqChain } from "./mpq.ts";

export { archiveOrder, detectLocale };

export async function extractDbc(clientDir: string, outDir: string, report: (line: string) => void = console.log): Promise<number> {
  const dataDir = existsSync(join(clientDir, "Data")) ? join(clientDir, "Data") : clientDir;
  const locale = detectLocale(dataDir);
  if (!locale) {
    throw new Error(`no locale-<locale>.MPQ under ${dataDir}`);
  }
  const chain = await MpqChain.open(dataDir, locale);
  report(`locale ${locale}, ${chain.archives.length} archives`);
  await mkdir(outDir, { recursive: true });
  let written = 0;
  for (const name of chain.list(/^dbfilesclient\\.*\.dbc$/)) {
    const bytes = chain.read(name);
    if (!bytes) {
      continue;
    }
    await Bun.write(join(outDir, name.slice(name.lastIndexOf("\\") + 1)), bytes);
    written++;
  }
  chain.close();
  report(`wrote ${written} dbc files to ${outDir}`);
  return written;
}

if (import.meta.main) {
  const [clientDir, outDir = "data/dbc"] = process.argv.slice(2);
  if (!clientDir) {
    console.error("usage: bun src/tools/extract-dbc.ts <client directory> [output directory]");
    process.exit(1);
  }
  await extractDbc(clientDir, outDir);
}
