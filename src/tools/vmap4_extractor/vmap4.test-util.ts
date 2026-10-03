import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MODEL_HEADER_SIZE } from "./modelheaders.ts";
import { gOpenArchives } from "./mpq_libmpq04.ts";
import { globals, resetExtractorState } from "./vmapexport.ts";

/** Little endian byte builder for the synthetic client files of the tests (this mirrors the C++ writers' layouts). */
export class Bytes {
  private parts: number[] = [];

  get length(): number {
    return this.parts.length;
  }

  u8(value: number): this {
    this.parts.push(value & 0xff);
    return this;
  }

  u16(value: number): this {
    return this.u8(value).u8(value >> 8);
  }

  u32(value: number): this {
    return this.u16(value & 0xffff).u16(value >>> 16);
  }

  f32(value: number): this {
    const view = new DataView(new ArrayBuffer(4));
    view.setFloat32(0, value, true);
    for (let index = 0; index < 4; ++index) {
      this.u8(view.getUint8(index));
    }
    return this;
  }

  /** Raw characters (latin1). */
  text(value: string): this {
    for (let index = 0; index < value.length; ++index) {
      this.u8(value.charCodeAt(index));
    }
    return this;
  }

  zeros(count: number): this {
    for (let index = 0; index < count; ++index) {
      this.u8(0);
    }
    return this;
  }

  bytes(value: ArrayLike<number>): this {
    for (let index = 0; index < value.length; ++index) {
      this.u8(value[index]!);
    }
    return this;
  }

  done(): Uint8Array {
    return Uint8Array.from(this.parts);
  }
}

/** A chunk as the client files store it: the four character id reversed ("MAIN" is "NIAM"), size, payload. */
export function chunk(fourcc: string, payload: Bytes | Uint8Array): Bytes {
  const body = payload instanceof Bytes ? payload.done() : payload;
  return new Bytes().text([...fourcc].reverse().join("")).u32(body.length).bytes(body);
}

/** Replaces the archives with in-memory files (names are matched case blind with `\` separators). */
export function useArchive(files: Record<string, Uint8Array>): void {
  const table = new Map<string, Uint8Array>();
  for (const [name, bytes] of Object.entries(files)) {
    table.set(name.replaceAll("/", "\\").toLowerCase(), bytes);
  }
  gOpenArchives.chain = { read: (name: string) => table.get(name.replaceAll("/", "\\").toLowerCase()) ?? null };
}

/** A fresh work directory; returns a cleanup function. */
export function useWorkDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "vmap4-"));
  globals.szWorkDirWmo = dir;
  globals.preciseVectorData = false;
  resetExtractorState();
  return {
    dir,
    cleanup: () => {
      gOpenArchives.chain = null;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * A minimal 3.3.5a M2: the 304 byte header with only the bounding triangle / vertex tables set, then the vertices
 * (client coordinates), then the indices. `vertices` are x, y, z triples.
 */
export function buildM2(vertices: number[][], indices: number[]): Uint8Array {
  const vertexOfs = MODEL_HEADER_SIZE;
  const indexOfs = vertexOfs + vertices.length * 12;
  const header = new Bytes();
  header.text("MD20").u32(0x108); // id, version
  // everything up to the last 22 uint32 is zero
  header.zeros(MODEL_HEADER_SIZE - 8 - 22 * 4);
  header.u32(indices.length).u32(indexOfs); // nBoundingTriangles, ofsBoundingTriangles
  header.u32(vertices.length).u32(vertexOfs); // nBoundingVertices, ofsBoundingVertices
  header.zeros(18 * 4); // the rest of the tail
  const body = new Bytes().bytes(header.done());
  for (const v of vertices) {
    body.f32(v[0]!).f32(v[1]!).f32(v[2]!);
  }
  for (const index of indices) {
    body.u16(index);
  }
  return body.done();
}

export interface TestGroup {
  mogpFlags?: number;
  groupWMOID?: number;
  groupName?: number;
  bb1?: [number, number, number];
  bb2?: [number, number, number];
  /** MOPY pairs: [flags, materialId]. */
  mopy: [number, number][];
  movi: number[];
  movt: number[][];
  /** The first uint16 of the third uint32 of each batch lands at MOBA[8]. */
  mobaIndex8?: number[];
  liquid?: { xverts: number; yverts: number; xtiles: number; ytiles: number; pos: [number, number, number]; material: number; heights: number[]; tiles: number[] };
}

/** A group file: the MOGP header chunk (the reader forces its size to 68) followed by its sub chunks. */
export function buildWmoGroup(group: TestGroup): Uint8Array {
  const header = new Bytes()
    .u32(group.groupName ?? 0) // groupName
    .u32(0) // descGroupName
    .u32(group.mogpFlags ?? 0);
  for (const value of group.bb1 ?? [0, 0, 0]) header.f32(value);
  for (const value of group.bb2 ?? [0, 0, 0]) header.f32(value);
  header.u16(0).u16(0).u16(0).u16(0).u32(0).u32(0).u32(0).u32(group.groupWMOID ?? 0); // 60 bytes so far
  header.zeros(8); // up to the 68 bytes the reader skips to
  const out = new Bytes().text("PGOM").u32(0xffff).bytes(header.done()); // MOGP: the size field is ignored
  const mopy = new Bytes();
  for (const [flags, material] of group.mopy) mopy.u8(flags).u8(material);
  out.bytes(chunk("MOPY", mopy).done());
  const movi = new Bytes();
  for (const index of group.movi) movi.u16(index);
  out.bytes(chunk("MOVI", movi).done());
  const movt = new Bytes();
  for (const v of group.movt) movt.f32(v[0]!).f32(v[1]!).f32(v[2]!);
  out.bytes(chunk("MOVT", movt).done());
  const moba = new Bytes();
  for (const value of group.mobaIndex8 ?? []) {
    moba.zeros(16).u16(value).zeros(6); // one 24 byte batch, uint16 index 8 is `value`
  }
  out.bytes(chunk("MOBA", moba).done());
  if (group.liquid) {
    const liquid = group.liquid;
    const mliq = new Bytes().u32(liquid.xverts).u32(liquid.yverts).u32(liquid.xtiles).u32(liquid.ytiles);
    for (const value of liquid.pos) mliq.f32(value);
    mliq.u16(liquid.material);
    for (const height of liquid.heights) mliq.u16(0).u16(0).f32(height);
    for (const tile of liquid.tiles) mliq.u8(tile);
    out.bytes(chunk("MLIQ", mliq).done());
  }
  return out.done();
}

/** A root file: MOHD (nGroups, RootWMOID, flags) and MOGN. Group names are NUL separated. */
export function buildWmoRoot(options: { nGroups: number; rootWMOID: number; flags?: number; groupNames?: string; doodads?: Uint8Array[] }): Uint8Array {
  const mohd = new Bytes().u32(0).u32(options.nGroups).u32(0).u32(0).u32(0).u32(0).u32(0).u32(0).u32(options.rootWMOID);
  mohd.zeros(24).u32(options.flags ?? 0);
  const out = new Bytes().bytes(chunk("MOHD", mohd).done());
  out.bytes(chunk("MOGN", new Bytes().text(options.groupNames ?? "\0")).done());
  for (const extra of options.doodads ?? []) out.bytes(extra);
  return out.done();
}
