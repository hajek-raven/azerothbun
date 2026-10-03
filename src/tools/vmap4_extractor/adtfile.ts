import { FileWriter, bytesToLatin1 } from "./fileio.ts";
import { MPQFile, readChunkHeader } from "./mpq_libmpq04.ts";
import { Doodad } from "./model.ts";
import { AaBox3D, Vec3D } from "./vec3d.ts";
import { ExtractSingleModel, ExtractSingleWmo, globals } from "./vmapexport.ts";
import { MapObject, newWMODoodadData } from "./wmo.ts";

/** `ADT::MDDF`, 36 bytes packed. */
export interface MDDF {
  Id: number;
  UniqueId: number;
  Position: Vec3D;
  Rotation: Vec3D;
  Scale: number;
  Flags: number;
}

export const MDDF_SIZE = 36;

/** `ADT::MODF`, 64 bytes packed. */
export interface MODF {
  Id: number;
  UniqueId: number;
  Position: Vec3D;
  Rotation: Vec3D;
  Bounds: AaBox3D;
  Flags: number;
  DoodadSet: number;
  NameSet: number;
  Scale: number;
}

export const MODF_SIZE = 64;

/** Reads one `ADT::MDDF` (`_file.read(&doodadDef, sizeof(ADT::MDDF))`). */
export function readMDDF(f: MPQFile): MDDF {
  const raw = f.readBytes(MDDF_SIZE);
  const view = new DataView(raw.buffer);
  return {
    Id: view.getUint32(0, true),
    UniqueId: view.getUint32(4, true),
    Position: new Vec3D(view.getFloat32(8, true), view.getFloat32(12, true), view.getFloat32(16, true)),
    Rotation: new Vec3D(view.getFloat32(20, true), view.getFloat32(24, true), view.getFloat32(28, true)),
    Scale: view.getUint16(32, true),
    Flags: view.getUint16(34, true),
  };
}

/** Reads one `ADT::MODF` (`_file.read(&mapObjDef, sizeof(ADT::MODF))`). */
export function readMODF(f: MPQFile): MODF {
  const raw = f.readBytes(MODF_SIZE);
  const view = new DataView(raw.buffer);
  const bounds = new AaBox3D();
  bounds.min = new Vec3D(view.getFloat32(32, true), view.getFloat32(36, true), view.getFloat32(40, true));
  bounds.max = new Vec3D(view.getFloat32(44, true), view.getFloat32(48, true), view.getFloat32(52, true));
  return {
    Id: view.getUint32(0, true),
    UniqueId: view.getUint32(4, true),
    Position: new Vec3D(view.getFloat32(8, true), view.getFloat32(12, true), view.getFloat32(16, true)),
    Rotation: new Vec3D(view.getFloat32(20, true), view.getFloat32(24, true), view.getFloat32(28, true)),
    Bounds: bounds,
    Flags: view.getUint16(56, true),
    DoodadSet: view.getUint16(58, true),
    NameSet: view.getUint16(60, true),
    Scale: view.getUint16(62, true),
  };
}

/** The part of a path after the last backslash. @ac tools/vmap4_extractor/adtfile.cpp GetPlainName */
export function GetPlainName(FileName: string): string {
  const index = FileName.lastIndexOf("\\");
  return index >= 0 ? FileName.slice(index + 1) : FileName;
}

/** The `strrchr(FileName, '.')` suffix (with the dot), or null. @ac tools/vmap4_extractor/adtfile.cpp GetExtension */
export function GetExtension(FileName: string): string | null {
  const index = FileName.lastIndexOf(".");
  return index >= 0 ? FileName.slice(index) : null;
}

/** `isalpha` in the C locale. */
function isAlpha(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

/**
 * `fixnamen(name, len)`: first letters upper case, the rest lower case, the last three characters lower case. The
 * C++ edits in place; this returns the fixed string (`len` defaults to the string length, as every caller passes).
 *
 * @ac tools/vmap4_extractor/adtfile.cpp fixnamen
 */
export function fixnamen(name: string, len: number = name.length): string {
  if (len < 3) {
    return name;
  }
  const codes: number[] = new Array(name.length);
  for (let i = 0; i < name.length; ++i) {
    codes[i] = name.charCodeAt(i);
  }

  for (let i = 0; i < len - 3; i++) {
    if (i > 0 && codes[i]! >= 0x41 && codes[i]! <= 0x5a && isAlpha(codes[i - 1]!)) {
      codes[i] = codes[i]! | 0x20;
    } else if ((i === 0 || !isAlpha(codes[i - 1]!)) && codes[i]! >= 0x61 && codes[i]! <= 0x7a) {
      codes[i] = codes[i]! & ~0x20;
    }
  }

  //extension in lowercase
  for (let i = len - 3; i < len; i++) {
    codes[i] = codes[i]! | 0x20;
  }
  return String.fromCharCode(...codes);
}

/** `fixname2(name, len)`: spaces become underscores (except in the last three characters). @ac tools/vmap4_extractor/adtfile.cpp fixname2 */
export function fixname2(name: string, len: number = name.length): string {
  if (len < 3) {
    return name;
  }
  let out = name.slice(0, len - 3).replaceAll(" ", "_");
  out += name.slice(len - 3);
  return out;
}

/**
 * `GetPlainName` + `fixnamen` + `fixname2` on the plain part of `path` in place, the way the callers do it
 * (`ExtractSingleModel`, `ExtractSingleWmo`).
 */
export function fixPlainName(path: string): string {
  const at = path.lastIndexOf("\\") + 1;
  const plain = path.slice(at);
  return path.slice(0, at) + fixname2(fixnamen(plain, plain.length), plain.length);
}

/**
 * Reads the NUL separated names of an MMDX / MWMO chunk (`while (p < buf + size) { ...; p += strlen(p) + 1; }`).
 * The last string of a chunk without a final NUL ends at the chunk end.
 */
export function readNameList(f: MPQFile, size: number): string[] {
  const buf = f.readBytes(size);
  const names: string[] = [];
  let p = 0;
  while (p < size) {
    let end = p;
    while (end < size && buf[end] !== 0) {
      ++end;
    }
    names.push(bytesToLatin1(buf, p, end));
    p = end + 1;
  }
  return names;
}

/**
 * @ac tools/vmap4_extractor/adtfile.h ADTFile
 * @ac tools/vmap4_extractor/adtfile.cpp ADTFile::ADTFile
 * @ac tools/vmap4_extractor/adtfile.cpp ADTFile::init
 * @ac tools/vmap4_extractor/adtfile.cpp ADTFile::~ADTFile
 */
export class ADTFile {
  private _file: MPQFile;
  Adtfilename: string;
  WmoInstanceNames: string[] = [];
  ModelInstanceNames: string[] = [];

  constructor(filename: string) {
    this._file = new MPQFile(filename);
    this.Adtfilename = filename;
  }

  init(map_num: number, tileX: number, tileY: number): boolean {
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

      if (fourcc === "MCIN") {
        // not needed
      } else if (fourcc === "MTEX") {
        // not needed
      } else if (fourcc === "MMDX") {
        if (size) {
          for (const name of readNameList(file, size)) {
            // fixnamen(p, strlen(p)) on the whole path, then GetPlainName / fixname2 on the plain part; `s` and
            // `path` are views of the same buffer, so the path that is extracted carries both fixes
            const fixed = fixnamen(name);
            const at = fixed.lastIndexOf("\\") + 1;
            const plain = fixname2(fixed.slice(at));
            const path = { value: fixed.slice(0, at) + plain };
            this.ModelInstanceNames.push(plain);

            ExtractSingleModel(path);
          }
        }
      } else if (fourcc === "MWMO") {
        if (size) {
          for (const path of readNameList(file, size)) {
            const s = fixname2(fixnamen(GetPlainName(path)));
            this.WmoInstanceNames.push(s);

            ExtractSingleWmo({ value: path });
          }
        }
      }
      //======================
      else if (fourcc === "MDDF") {
        if (size) {
          const doodadCount = Math.trunc(size / MDDF_SIZE);
          for (let i = 0; i < doodadCount; ++i) {
            const doodadDef = readMDDF(file);
            const name = this.ModelInstanceNames[doodadDef.Id];
            if (name === undefined) {
              continue; // ModelInstanceNames[doodadDef.Id] is out of range (undefined behaviour in the C++)
            }
            Doodad.Extract(doodadDef, name, map_num, tileX, tileY, dirfile);
          }
        }
      } else if (fourcc === "MODF") {
        if (size) {
          const mapObjectCount = Math.trunc(size / MODF_SIZE);
          for (let i = 0; i < mapObjectCount; ++i) {
            const mapObjDef = readMODF(file);
            const name = this.WmoInstanceNames[mapObjDef.Id];
            if (name === undefined) {
              continue;
            }
            MapObject.Extract(mapObjDef, name, map_num, tileX, tileY, dirfile);
            Doodad.ExtractSet(globals.WmoDoodads.get(name) ?? newWMODoodadData(), mapObjDef, map_num, tileX, tileY, dirfile);
          }
        }
      }
      //======================
      file.seek(nextpos);
      dirfile.flushIfLarge();
    }
    file.close();
    dirfile.close();
    return true;
  }

  /** The C++ destructor closes the file. */
  close(): void {
    this._file.close();
  }
}
