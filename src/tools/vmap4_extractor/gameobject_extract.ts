import { GetExtension, GetPlainName, fixPlainName, fixname2, fixnamen } from "./adtfile.ts";
import { DBCFile } from "./dbcfile.ts";
import { FileWriter, fileExists, bytesToLatin1 } from "./fileio.ts";
import { Model } from "./model.ts";
import {
  ExtractSingleWmo,
  FatalError,
  RAW_VMAP_MAGIC,
  globals,
  setModelVertexCount,
  type MutableString,
} from "./vmapexport.ts";

void bytesToLatin1;

/**
 * Extracts one M2 model into the work directory as a raw vmap model.
 *
 * @ac tools/vmap4_extractor/gameobject_extract.cpp ExtractSingleModel
 */
export function ExtractSingleModel(fname: MutableString): boolean {
  if (fname.value.length < 4) {
    return false;
  }

  const extension = fname.value.slice(fname.value.length - 4);
  if (extension === ".mdx" || extension === ".MDX" || extension === ".mdl" || extension === ".MDL") {
    // replace .mdx -> .m2
    fname.value = `${fname.value.slice(0, fname.value.length - 2)}2`;
  }
  // >= 3.1.0 ADT MMDX section store filename.m2 filenames for corresponded .m2 file
  // nothing do

  const originalName = fname.value;

  fname.value = fixPlainName(fname.value);
  const name = GetPlainName(fname.value);

  const output = `${globals.szWorkDirWmo}/${name}`;

  if (fileExists(output)) {
    return true;
  }

  try {
    const mdl = new Model(originalName);
    if (!mdl.open()) {
      return false;
    }

    if (!mdl.ConvertToVMAPModel(output)) {
      return false;
    }
    setModelVertexCount(name, mdl.header.nBoundingVertices);
    return true;
  } catch (error) {
    console.log(`Error converting model ${originalName}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

function lowerAscii(text: string): string {
  return text.replace(/[A-Z]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) | 0x20));
}

/**
 * Extracts the models listed in GameObjectDisplayInfo.dbc and writes `temp_gameobject_models`
 * (magic, then per model: displayId u32, isWmo u8, name length u32, name).
 *
 * @ac tools/vmap4_extractor/gameobject_extract.cpp ExtractGameobjectModels
 */
export function ExtractGameobjectModels(): void {
  console.log("Extracting GameObject models...");
  const dbc = new DBCFile("DBFilesClient\\GameObjectDisplayInfo.dbc");
  if (!dbc.open()) {
    throw new FatalError("Fatal error: Invalid GameObjectDisplayInfo.dbc file format!");
  }

  const basepath = `${globals.szWorkDirWmo}/`;

  const modelListPath = `${basepath}temp_gameobject_models`;
  const model_list = FileWriter.open(modelListPath);
  if (!model_list) {
    console.log(`Fatal error: Could not open file ${modelListPath}`);
    return;
  }

  model_list.latin1(RAW_VMAP_MAGIC, 8);

  for (const it of dbc) {
    const path: MutableString = { value: it.getString(1) };

    if (path.value.length < 4) {
      continue;
    }

    path.value = fixnamen(path.value, path.value.length);
    // GetPlainName / fixname2 on the plain part, in place
    const plainAt = path.value.lastIndexOf("\\") + 1;
    path.value = path.value.slice(0, plainAt) + fixname2(path.value.slice(plainAt));

    const ch_ext = GetExtension(path.value.slice(plainAt));
    if (ch_ext === null) {
      continue;
    }

    // strToLower(ch_ext), in place in path
    path.value = path.value.slice(0, path.value.length - ch_ext.length) + lowerAscii(ch_ext);

    let result = false;
    let isWmo = 0;
    if (lowerAscii(ch_ext) === ".wmo") {
      isWmo = 1;
      result = ExtractSingleWmo(path);
    } else if (lowerAscii(ch_ext) === ".mdl") {
      /// @todo: extract .mdl files, if needed
      continue;
    } else {
      //if (!strcmp(ch_ext, ".mdx") || !strcmp(ch_ext, ".m2"))
      result = ExtractSingleModel(path);
    }

    if (result) {
      // `name` points into `path`, which the Extract functions edit in place (.mdx -> .m2)
      const name = GetPlainName(path.value);
      const displayId = it.getUInt(0);
      model_list.u32(displayId);
      model_list.u8(isWmo);
      model_list.u32(name.length);
      model_list.latin1(name);
    }
  }

  model_list.close();

  console.log("Done!");
}
