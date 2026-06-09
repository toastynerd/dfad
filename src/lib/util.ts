import { createHash } from "node:crypto";
import { config } from "../config.js";

/** Salted, truncated hash of an IP for abuse triage (avoids storing raw PII). */
export function hashIp(ip: string | undefined): string {
  return createHash("sha256")
    .update(`${config.IP_HASH_SALT}:${ip ?? "unknown"}`)
    .digest("hex")
    .slice(0, 16);
}

/** Current time in epoch seconds. */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
