import { FIREBASE as VECTOR_PROJECT, VECTORS } from "@authtempo/legacy-hashes/testing";
import type { ImportRecord, Source } from "../../src/types.js";

export const now = () => new Date("2026-10-11T00:00:00.000Z");

/** Every record a source yields, in order. */
export async function all(source: Source): Promise<ImportRecord[]> {
  const out: ImportRecord[] = [];
  for await (const r of source.records()) out.push(r);
  return out;
}

/**
 * The firebase/scrypt README project parameters, and the hash string of its
 * one user. Both come from legacy-hashes' own vectors (one source, ruling M-6).
 */
export const FIREBASE = { ...VECTOR_PROJECT };
export const FIRESCRYPT: string = VECTORS.firescrypt.stored;
