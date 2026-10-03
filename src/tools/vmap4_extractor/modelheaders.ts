/**
 * The 3.3.5a M2 header (`#pragma pack(1)`, 304 bytes): `id[4]`, `version[4]`, 38 uint32 up to `ofsTexAnimLookup`,
 * `float floats[14]`, then 22 uint32 from `nBoundingTriangles` to `ofsParticleEmitters`.
 *
 * @ac tools/vmap4_extractor/modelheaders.h ModelHeader
 */
const HEAD_FIELDS = [
  "nameLength",
  "nameOfs",
  "type",
  "nGlobalSequences",
  "ofsGlobalSequences",
  "nAnimations",
  "ofsAnimations",
  "nAnimationLookup",
  "ofsAnimationLookup",
  "nBones",
  "ofsBones",
  "nKeyBoneLookup",
  "ofsKeyBoneLookup",
  "nVertices",
  "ofsVertices",
  "nViews",
  "nColors",
  "ofsColors",
  "nTextures",
  "ofsTextures",
  "nTransparency",
  "ofsTransparency",
  "nTextureanimations",
  "ofsTextureanimations",
  "nTexReplace",
  "ofsTexReplace",
  "nRenderFlags",
  "ofsRenderFlags",
  "nBoneLookupTable",
  "ofsBoneLookupTable",
  "nTexLookup",
  "ofsTexLookup",
  "nTexUnits",
  "ofsTexUnits",
  "nTransLookup",
  "ofsTransLookup",
  "nTexAnimLookup",
  "ofsTexAnimLookup",
] as const;

const TAIL_FIELDS = [
  "nBoundingTriangles",
  "ofsBoundingTriangles",
  "nBoundingVertices",
  "ofsBoundingVertices",
  "nBoundingNormals",
  "ofsBoundingNormals",
  "nAttachments",
  "ofsAttachments",
  "nAttachLookup",
  "ofsAttachLookup",
  "nAttachments_2",
  "ofsAttachments_2",
  "nLights",
  "ofsLights",
  "nCameras",
  "ofsCameras",
  "nCameraLookup",
  "ofsCameraLookup",
  "nRibbonEmitters",
  "ofsRibbonEmitters",
  "nParticleEmitters",
  "ofsParticleEmitters",
] as const;

export const MODEL_HEADER_SIZE = 8 + HEAD_FIELDS.length * 4 + 14 * 4 + TAIL_FIELDS.length * 4;

export type ModelHeader = {
  id: string;
  version: [number, number, number, number];
  floats: Float32Array;
} & Record<(typeof HEAD_FIELDS)[number] | (typeof TAIL_FIELDS)[number], number>;

/** `ModelHeader header()`: all zero. */
export function emptyModelHeader(): ModelHeader {
  const header = { id: "\0\0\0\0", version: [0, 0, 0, 0], floats: new Float32Array(14) } as Record<string, unknown>;
  for (const name of HEAD_FIELDS) {
    header[name] = 0;
  }
  for (const name of TAIL_FIELDS) {
    header[name] = 0;
  }
  return header as ModelHeader;
}

/** `memcpy(&header, f.getBuffer(), sizeof(ModelHeader))`; bytes missing from a short file read as 0. */
export function readModelHeader(buffer: Uint8Array): ModelHeader {
  const padded = buffer.length >= MODEL_HEADER_SIZE ? buffer : new Uint8Array(MODEL_HEADER_SIZE);
  if (padded !== buffer) {
    padded.set(buffer);
  }
  const view = new DataView(padded.buffer, padded.byteOffset, padded.byteLength);
  const header = emptyModelHeader();
  header.id = String.fromCharCode(padded[0]!, padded[1]!, padded[2]!, padded[3]!);
  header.version = [padded[4]!, padded[5]!, padded[6]!, padded[7]!];
  let at = 8;
  for (const name of HEAD_FIELDS) {
    header[name] = view.getUint32(at, true);
    at += 4;
  }
  for (let index = 0; index < 14; ++index) {
    header.floats[index] = view.getFloat32(at, true);
    at += 4;
  }
  for (const name of TAIL_FIELDS) {
    header[name] = view.getUint32(at, true);
    at += 4;
  }
  return header;
}
