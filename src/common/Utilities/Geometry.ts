/** Port of `common/Utilities/Geometry.h`. */

/** @ac common/Utilities/Geometry.h getAngle */
export function getAngle(startX: number, startY: number, destX: number, destY: number): number {
  const dx = destX - startX;
  const dy = destY - startY;

  let ang = Math.atan2(dy, dx);
  ang = ang >= 0 ? ang : 2 * Math.fround(Math.PI) + ang;
  return ang;
}

/** @ac common/Utilities/Geometry.h getSlopeAngle */
export function getSlopeAngle(startX: number, startY: number, startZ: number, destX: number, destY: number, destZ: number): number {
  const floorDist = Math.sqrt(Math.pow(startY - destY, 2.0) + Math.pow(startX - destX, 2.0));
  return Math.atan(Math.abs(destZ - startZ) / Math.abs(floorDist));
}

/** @ac common/Utilities/Geometry.h getSlopeAngleAbs */
export function getSlopeAngleAbs(startX: number, startY: number, startZ: number, destX: number, destY: number, destZ: number): number {
  return Math.abs(getSlopeAngle(startX, startY, startZ, destX, destY, destZ));
}

/** @ac common/Utilities/Geometry.h getCircleAreaByRadius */
export function getCircleAreaByRadius(radius: number): number {
  return radius * radius * Math.PI;
}

/** @ac common/Utilities/Geometry.h getCirclePerimeterByRadius */
export function getCirclePerimeterByRadius(radius: number): number {
  return radius * Math.PI;
}

/** @ac common/Utilities/Geometry.h getCylinderVolume */
export function getCylinderVolume(height: number, radius: number): number {
  return height * getCircleAreaByRadius(radius);
}
