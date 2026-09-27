/**
 * Copies every `DBFilesClient\*.dbc` from a 3.3.5a client into `data/dbc`, the files `map_extractor` writes as
 * `dbc/` in AzerothCore. Later archives in the client's load order override earlier ones (patches win).
 *
 *   bun src/tools/extract-dbc.ts <client directory> [output directory]
 */
import { existsSync, readdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { MpqArchive } from "./mpq.ts";

/** The client's archive order for one locale (lowest priority first), like `map_extractor`'s `LoadCommonMPQFiles` / `LoadLocaleMPQFiles`. */
export function archiveOrder(dataDir: string, locale: string): string[] {
  const base = ["common.MPQ", "common-2.MPQ", "expansion.MPQ", "lichking.MPQ"];
  const localeFiles = [
    `${locale}/locale-${locale}.MPQ`,
    `${locale}/speech-${locale}.MPQ`,
    `${locale}/expansion-locale-${locale}.MPQ`,
    `${locale}/expansion-speech-${locale}.MPQ`,
    `${locale}/lichking-locale-${locale}.MPQ`,
    `${locale}/lichking-speech-${locale}.MPQ`,
  ];
  const patches = patchFiles(dataDir, "");
  const localePatches = patchFiles(join(dataDir, locale), `${locale}/`, locale);
  return [...base, ...localeFiles, ...patches, ...localePatches].map((file) => join(dataDir, file)).filter((path) => existsSync(path));
}

/** `patch.MPQ`, `patch-2.MPQ`, ... `patch-9.MPQ`, `patch-A.MPQ` ... in the order the client loads them. */
function patchFiles(directory: string, prefix: string, locale?: string): string[] {
  if (!existsSync(directory)) {
    return [];
  }
  const stem = locale ? `patch-${locale}` : "patch";
  const pattern = new RegExp(`^${stem}(?:-([0-9A-Za-z]))?\\.mpq$`, "i");
  return readdirSync(directory)
    .map((file) => ({ file, match: pattern.exec(file) }))
    .filter((row) => row.match !== null)
    .sort((left, right) => patchRank(left.match![1]) - patchRank(right.match![1]))
    .map((row) => `${prefix}${row.file}`);
}

function patchRank(suffix: string | undefined): number {
  if (!suffix) {
    return 1;
  }
  const digit = Number.parseInt(suffix, 10);
  return Number.isNaN(digit) ? 100 + suffix.toUpperCase().charCodeAt(0) : digit;
}

export function detectLocale(dataDir: string): string | null {
  for (const locale of ["enUS", "enGB", "deDE", "frFR", "esES", "esMX", "ruRU", "koKR", "zhCN", "zhTW"]) {
    if (existsSync(join(dataDir, locale, `locale-${locale}.MPQ`))) {
      return locale;
    }
  }
  return null;
}

export async function extractDbc(clientDir: string, outDir: string, report: (line: string) => void = console.log): Promise<number> {
  const dataDir = existsSync(join(clientDir, "Data")) ? join(clientDir, "Data") : clientDir;
  const locale = detectLocale(dataDir);
  if (!locale) {
    throw new Error(`no locale-<locale>.MPQ under ${dataDir}`);
  }
  const archives = archiveOrder(dataDir, locale);
  report(`locale ${locale}, ${archives.length} archives`);
  const sources = new Map<string, MpqArchive>();
  const names = new Map<string, string>();
  for (const path of archives) {
    const archive = await MpqArchive.open(path);
    let count = 0;
    for (const name of archive.listFiles()) {
      const lower = name.toLowerCase();
      if (!lower.startsWith("dbfilesclient\\") || !lower.endsWith(".dbc")) {
        continue;
      }
      if (!archive.has(name)) {
        continue;
      }
      sources.set(lower, archive);
      names.set(lower, name);
      count++;
    }
    report(`  ${path}: ${count} dbc`);
  }
  await mkdir(outDir, { recursive: true });
  let written = 0;
  for (const [lower, archive] of sources) {
    const name = names.get(lower)!;
    const bytes = archive.read(name);
    if (!bytes) {
      continue;
    }
    const file = name.slice(name.lastIndexOf("\\") + 1);
    await Bun.write(join(outDir, file), bytes);
    written++;
  }
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
