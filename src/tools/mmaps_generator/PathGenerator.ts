/**
 * mmaps_generator: builds the Recast/Detour navigation meshes (`data/mmaps/MMM.mmap` and `MMMXXYY.mmtile`) from
 * `data/maps` and `data/vmaps`.
 *
 *   bun src/tools/mmaps_generator/PathGenerator.ts [map id] [--tile x,y] [--threads n] [--config file]
 *                                                  [--file mesh file] [--silent]
 *
 * Without a map id every map is built (subject to the skip settings of the config); with a map id and `--tile` a
 * single tile is built. The default config is `mmaps-config.yaml` in the current directory, then next to this file.
 */
import { existsSync, mkdirSync } from "node:fs";
import { Config } from "./Config.ts";
import { MapBuilder } from "./MapBuilder.ts";
import { LISTFILE_DIRECTORY_NOT_FOUND, executableDirectoryPath, getDirContents } from "./PathCommon.ts";
import { secsToTimeString } from "../../game/time/timer.ts";

/** @ac tools/mmaps_generator/PathGenerator.cpp checkDirectories */
export function checkDirectories(dataDirPath: string, debugOutput: boolean): boolean {
  let dirFiles: string[] = [];
  const dir = (name: string): string => (dataDirPath === "" ? name : `${dataDirPath.replace(/\/$/, "")}/${name}`);

  if (getDirContents(dirFiles, dir("maps")) === LISTFILE_DIRECTORY_NOT_FOUND || dirFiles.length === 0) {
    console.log("'maps' directory is empty or does not exist");
    return false;
  }

  dirFiles = [];
  if (getDirContents(dirFiles, dir("vmaps"), "*.vmtree") === LISTFILE_DIRECTORY_NOT_FOUND || dirFiles.length === 0) {
    console.log("'vmaps' directory is empty or does not exist");
    return false;
  }

  dirFiles = [];
  if (getDirContents(dirFiles, dir("mmaps")) === LISTFILE_DIRECTORY_NOT_FOUND) {
    try {
      mkdirSync(dir("mmaps"));
      return true;
    } catch {
      return false;
    }
  }

  dirFiles = [];
  if (debugOutput && getDirContents(dirFiles, dir("meshes")) === LISTFILE_DIRECTORY_NOT_FOUND) {
    console.log("'meshes' directory does not exist creating...");
    try {
      mkdirSync(dir("meshes"));
      return true;
    } catch {
      return false;
    }
  }

  return true;
}

/** `handleArgs` out parameters. */
export interface PathGeneratorArgs {
  mapnum: number;
  tileX: number;
  tileY: number;
  configFilePath: string;
  silent: boolean;
  file: string | null;
  threads: number;
}

/** `atoi` */
function atoi(s: string): number {
  const m = /^\s*([+-]?\d+)/.exec(s);
  return m ? Number(m[1]) | 0 : 0;
}

/** @ac tools/mmaps_generator/PathGenerator.cpp handleArgs */
export function handleArgs(argv: readonly string[], args: PathGeneratorArgs): boolean {
  let hasCustomConfigPath = false;
  let param: string | undefined;
  for (let i = 0; i < argv.length; ++i) {
    if (argv[i] === "--config") {
      param = argv[++i];
      if (param === undefined) return false;

      hasCustomConfigPath = true;
      args.configFilePath = param;
    } else if (argv[i] === "--threads") {
      param = argv[++i];
      if (param === undefined) return false;
      args.threads = Math.max(0, atoi(param));
    } else if (argv[i] === "--file") {
      param = argv[++i];
      if (param === undefined) return false;
      args.file = param;
    } else if (argv[i] === "--tile") {
      param = argv[++i];
      if (param === undefined) return false;

      // strtok(param, ",") / strtok(nullptr, ",")
      const parts = param.split(",").filter((p) => p !== "");
      const stileX = parts[0] ?? "";
      const stileY = parts[1] ?? "";
      const tilex = atoi(stileX);
      const tiley = atoi(stileY);

      if ((tilex > 0 && tilex < 64) || (tilex === 0 && stileX === "0")) args.tileX = tilex;
      if ((tiley > 0 && tiley < 64) || (tiley === 0 && stileY === "0")) args.tileY = tiley;

      if (args.tileX < 0 || args.tileY < 0) {
        console.log("invalid tile coords.");
        return false;
      }
    } else if (argv[i] === "--silent") {
      args.silent = true;
    } else {
      const map = atoi(argv[i]!);
      if (map > 0 || (map === 0 && argv[i] === "0")) args.mapnum = map;
      else {
        console.log("invalid map id");
        return false;
      }
    }
  }

  if (!hasCustomConfigPath) {
    if (!existsSync(args.configFilePath)) {
      const execRelPath = `${executableDirectoryPath()}/${args.configFilePath}`;
      if (!existsSync(execRelPath)) {
        console.log(
          "Failed to load configuration. Ensure that 'mmaps-config.yaml' exists in the current directory or specify its path using the --config option.'",
        );
        return false;
      }
      args.configFilePath = execRelPath;
    }
  }

  return true;
}

/**
 * `finish`: prints the message and waits for ENTER (only when a terminal is attached, otherwise there is nobody to
 * press it).
 * @ac tools/mmaps_generator/PathGenerator.cpp finish
 */
export function finish(message: string, returnValue: number): number {
  process.stdout.write(message);
  if (process.stdin.isTTY) prompt("");
  return returnValue;
}

/** @ac tools/mmaps_generator/PathGenerator.cpp main */
export async function main(argv: string[]): Promise<number> {
  const args: PathGeneratorArgs = {
    mapnum: -1,
    tileX: -1,
    tileY: -1,
    configFilePath: "mmaps-config.yaml",
    silent: false,
    file: null,
    threads: navigator.hardwareConcurrency,
  };
  const validParam = handleArgs(argv, args);

  if (!validParam) return args.silent ? -1 : finish("You have specified invalid parameters", -1);

  const config = await Config.FromFile(args.configFilePath);
  if (!config)
    return args.silent
      ? -1
      : finish(
          "Failed to load configuration. Ensure that 'mmaps-config.yaml' exists in the current directory or specify its path using the --config option.",
          -1,
        );

  if (args.mapnum === -1 && config.IsDebugOutputEnabled()) {
    if (args.silent) return -2;

    console.log("You have specified debug output, but didn't specify a map to generate.");
    console.log("This will generate debug output for ALL maps.");
    process.stdout.write("Are you sure you want to continue? (y/n) ");
    const answer = process.stdin.isTTY ? prompt("") : null;
    if (!answer || answer[0] !== "y") return 0;
  }

  if (!checkDirectories(config.DataDirPath(), config.IsDebugOutputEnabled())) return args.silent ? -3 : finish("Press ENTER to close...", -3);

  const builder = new MapBuilder(config, args.mapnum, args.threads);

  const start = Date.now();
  if (args.file) await builder.buildMeshFromFile(args.file);
  else if (args.tileX > -1 && args.tileY > -1 && args.mapnum >= 0) await builder.buildSingleTile(args.mapnum, args.tileX, args.tileY);
  else if (args.mapnum >= 0) await builder.buildMaps(args.mapnum >>> 0);
  else await builder.buildMaps(null);

  if (!args.silent) console.log(`Finished. MMAPS were built in ${secsToTimeString(Math.trunc((Date.now() - start) / 1000))}`);
  return 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
