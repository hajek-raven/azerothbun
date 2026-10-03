import { ADTFile, GetPlainName, MODF_SIZE, fixname2, fixnamen, readMODF } from "./adtfile.ts";
import { FileWriter } from "./fileio.ts";
import { MapObject, newWMODoodadData } from "./wmo.ts";
import { Doodad } from "./model.ts";
import { MPQFile, readChunkHeader } from "./mpq_libmpq04.ts";
import { ExtractSingleWmo, globals } from "./vmapexport.ts";
import { readNameList } from "./adtfile.ts";

/** @ac tools/vmap4_extractor/wdtfile.cpp wdtGetPlainName */
export const wdtGetPlainName = GetPlainName;

/**
 * @ac tools/vmap4_extractor/wdtfile.h WDTFile
 * @ac tools/vmap4_extractor/wdtfile.cpp WDTFile::WDTFile
 * @ac tools/vmap4_extractor/wdtfile.cpp WDTFile::init
 * @ac tools/vmap4_extractor/wdtfile.cpp WDTFile::GetMap
 * @ac tools/vmap4_extractor/wdtfile.cpp WDTFile::~WDTFile
 */
export class WDTFile {
  _wmoNames: string[] = [];
  private _file: MPQFile;
  private filename: string;

  constructor(file_name: string, file_name1: string) {
    this._file = new MPQFile(file_name);
    this.filename = file_name1;
  }

  init(mapId: number): boolean {
    const file = this._file;
    if (file.isEof()) {
      return false;
    }

    const dirname = `${globals.szWorkDirWmo}/dir_bin`;
    const dirfile = FileWriter.open(dirname, true);
    if (!dirfile) {
      console.log(`Can't open dirfile!'${dirname}'`);
      return false;
    }

    for (let chunk = readChunkHeader(file); chunk; chunk = readChunkHeader(file)) {
      const { fourcc, size } = chunk;
      const nextpos = file.getPos() + size;

      if (fourcc === "MAIN") {
        // not needed
      }
      if (fourcc === "MWMO") {
        // global map objects
        if (size) {
          for (const path of readNameList(file, size)) {
            const s = fixname2(fixnamen(wdtGetPlainName(path)));
            this._wmoNames.push(s);

            ExtractSingleWmo({ value: path });
          }
        }
      } else if (fourcc === "MODF") {
        // global wmo instance data
        if (size) {
          const mapObjectCount = Math.trunc(size / MODF_SIZE);
          for (let i = 0; i < mapObjectCount; ++i) {
            const mapObjDef = readMODF(file);
            const name = this._wmoNames[mapObjDef.Id];
            if (name === undefined) {
              continue; // out of range index (undefined behaviour in the C++)
            }
            MapObject.Extract(mapObjDef, name, mapId, 65, 65, dirfile);
            Doodad.ExtractSet(globals.WmoDoodads.get(name) ?? newWMODoodadData(), mapObjDef, mapId, 65, 65, dirfile);
          }
        }
      }
      file.seek(nextpos);
    }

    file.close();
    dirfile.close();
    return true;
  }

  GetMap(x: number, z: number): ADTFile | null {
    if (!(x >= 0 && z >= 0 && x < 64 && z < 64)) {
      return null;
    }

    return new ADTFile(`World\\Maps\\${this.filename}\\${this.filename}_${x}_${z}.adt`);
  }

  close(): void {
    this._file.close();
  }
}
