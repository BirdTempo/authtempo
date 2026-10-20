import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The parts of .changeset/config.json that the release checks read. */
export interface ChangesetConfig {
  fixed: string[][];
  /** Changesets reads an absent `linked` as an empty list. */
  linked: string[][];
  ignore: string[];
}

export function readChangesetConfig(root: string): ChangesetConfig {
  const config = JSON.parse(readFileSync(join(root, ".changeset/config.json"), "utf8")) as {
    fixed?: unknown;
    linked?: unknown;
    ignore?: unknown;
  };
  const isNames = (v: unknown): v is string[] =>
    Array.isArray(v) && v.every((n) => typeof n === "string");
  if (!Array.isArray(config.fixed) || !config.fixed.every(isNames))
    throw new Error(".changeset/config.json: fixed is not a list of name lists");
  const linked = config.linked ?? [];
  if (!Array.isArray(linked) || !linked.every(isNames))
    throw new Error(".changeset/config.json: linked is not a list of name lists");
  if (!isNames(config.ignore)) throw new Error(".changeset/config.json: ignore is not a name list");
  return { fixed: config.fixed, linked, ignore: config.ignore };
}

/**
 * The released packages: `fixed[0]` of .changeset/config.json, the one list
 * of the group (spec 33 item 2). Every release check reads it from here. The
 * run lines of release.yml read the same path with jq (RELEASED_JQ of
 * src/lib/release-copy.ts), and a test runs both on the real config.
 */
export function releasedNames(root: string): string[] {
  const group = readChangesetConfig(root).fixed[0];
  if (group === undefined) throw new Error(".changeset/config.json: fixed has no group");
  return [...group];
}
