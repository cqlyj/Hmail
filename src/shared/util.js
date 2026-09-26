import { timingSafeEqual } from "node:crypto";

/** Constant-time string compare; on a length mismatch it still runs one timingSafeEqual against a dummy. */
export function safeEqual(expected, presented) {
  const left = Buffer.from(String(expected));
  const right = Buffer.from(String(presented));
  if (left.length !== right.length) {
    timingSafeEqual(left, Buffer.alloc(left.length));
    return false;
  }
  return timingSafeEqual(left, right);
}

/** @param {unknown} err */
export function errMessage(err) {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Hides anything key-sized: 64 or more hex digits, with or without 0x. @param {string} text */
export function redactKeys(text) {
  return String(text).replace(/(?:0x)?[0-9a-fA-F]{64,}/g, "0x\u2026");
}

/** @param {string} id */
export function shortHex(id) {
  return `${id.slice(0, 6)}\u2026${id.slice(-4)}`;
}
