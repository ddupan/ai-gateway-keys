// Pure helpers, kept apart from I/O so the tests can import them.
import { randomBytes } from "node:crypto";

export const ID_RE = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$|^[a-z0-9]$/;

export function validId(id: string): boolean {
  return ID_RE.test(id);
}

// 32 random bytes; the prefix makes a leaked key easy to recognise in logs and scanners.
export function newKey(): string {
  return "aigw_" + randomBytes(32).toString("base64url");
}

export function originAllowed(origin: string | undefined, publicUrl: string): boolean {
  return origin !== undefined && origin === new URL(publicUrl).origin;
}

export function inGroups(groups: unknown, allowed: string[]): boolean {
  return Array.isArray(groups) && groups.some((g) => allowed.includes(String(g)));
}
