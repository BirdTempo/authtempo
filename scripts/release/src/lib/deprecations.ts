import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The deprecation register (spec 33 item 8): the one source of each deprecated item. */
export const REGISTER_FILE = "release/deprecations.json";

/** A file and a text in it that exist only while the item stays. */
export interface Marker {
  /** The path from the repository root, with "/" as the separator. */
  file: string;
  text: string;
}

/** One entry of release/deprecations.json. */
export interface Deprecation {
  id: string;
  what: string;
  /** The first version that ships the item with its deprecation line. */
  since: string;
  /** The minor after `since`: the first version without the item. */
  removeIn: string;
  markers: Marker[];
  /** The anchor of the item on /docs/reference/deprecations/. */
  docs: string;
}

const isText = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

function isMarker(v: unknown): v is Marker {
  if (typeof v !== "object" || v === null) return false;
  const m = v as Record<string, unknown>;
  return isText(m.file) && typeof m.text === "string";
}

function isDeprecation(v: unknown): v is Deprecation {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  return (
    isText(e.id) &&
    isText(e.what) &&
    isText(e.since) &&
    isText(e.removeIn) &&
    isText(e.docs) &&
    Array.isArray(e.markers) &&
    e.markers.every(isMarker)
  );
}

/**
 * Reads the register at `root`. The file is required: check-deprecations,
 * check-pack (core's `authtempo.deprecations`), and prepare read it. A wrong
 * shape throws, so no reader gets a part of an entry.
 */
export function readDeprecations(root: string): Deprecation[] {
  const value = JSON.parse(readFileSync(join(root, REGISTER_FILE), "utf8")) as unknown;
  if (!Array.isArray(value)) throw new Error(`${REGISTER_FILE}: the register is not a list`);
  value.forEach((e, i) => {
    if (!isDeprecation(e))
      throw new Error(
        `${REGISTER_FILE}: entry ${i} is not { id, what, since, removeIn, markers: { file, text }[], docs }`,
      );
  });
  return value as Deprecation[];
}
