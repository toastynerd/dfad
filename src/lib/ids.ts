import { customAlphabet } from "nanoid";

// URL-safe, unambiguous alphabet (no look-alikes like 0/O, 1/l/I).
const alphabet = "23456789abcdefghijkmnpqrstuvwxyz";
const generate = customAlphabet(alphabet, 10);

/** Generate a short, URL-safe deployment id. */
export function newId(): string {
  return generate();
}
