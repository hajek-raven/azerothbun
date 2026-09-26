import { timingSafeEqual } from "node:crypto";

/** Constant-time compare for digests and proofs. */
export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}
