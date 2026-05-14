import crypto from "node:crypto";

export function id(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto
    .randomBytes(4)
    .toString("hex")}`;
}

export function nowIso() {
  return new Date().toISOString();
}
