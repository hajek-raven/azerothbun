/**
 * @ac tools/vmap4_extractor/vec3d.h Vec3D
 * @ac tools/vmap4_extractor/vec3d.h AaBox3D
 * @ac tools/vmap4_extractor/vec3d.h Quaternion
 *
 * Only the data members are ported; the operators of `Vec3D` / `Vec2D` and `rotate` are never called by the
 * extractor (`@ac-skip unused by vmap4_extractor`). Values are JS numbers holding float32 values (every reader
 * produces them through `Float32` views, every writer rounds through `setFloat32`).
 */
export class Vec3D {
  constructor(
    public x = 0,
    public y = 0,
    public z = 0,
  ) {}
}

export class AaBox3D {
  min = new Vec3D();
  max = new Vec3D();
}

export interface Quaternion {
  X: number;
  Y: number;
  Z: number;
  W: number;
}
