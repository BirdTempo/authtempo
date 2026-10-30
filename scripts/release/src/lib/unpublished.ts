// The note "not on a registry yet" in the packed files (ruling 47 of plan 12j,
// item 1). The rule of deviation 6 holds packed files too. While the group is
// at 0.0.0, each file of UNPUBLISHED_FILES holds the note, and no other packed
// file does. Above 0.0.0, no packed file holds it. check-pack holds the rule on
// the tarballs, and the version branch rewrites each listed file. Node runs
// this file by type stripping, so it holds only syntax that type stripping erases.

// The one source of the words: the site check check-unpublished reads the same value.
import { UNPUBLISHED_MARK } from "../../../../apps/site/src/data/unpublished.ts";

export { UNPUBLISHED_MARK };

/** The version of every package before the first release. */
export const UNPUBLISHED_VERSION = "0.0.0";

/**
 * Each packed file that holds the note while the group is at 0.0.0, by its
 * path from the repository root. Read from the tree with `git grep -l` on
 * 2026-10-30: the README of the CLI and each skill of the MCP package. Each one
 * ships in a tarball, so a stale note reaches every app that installs it.
 * check-pack fails on a packed file with the note that this list lacks, so a
 * new one joins the list. check-changesets reads the list for the version branch.
 */
export const UNPUBLISHED_FILES: readonly string[] = [
  "packages/cli/README.md",
  "packages/mcp/skills/authtempo-integrate-binding/SKILL.md",
  "packages/mcp/skills/authtempo-integrate-bun/SKILL.md",
  "packages/mcp/skills/authtempo-integrate-node/SKILL.md",
  "packages/mcp/skills/authtempo-integrate-workers-d1/SKILL.md",
  "packages/mcp/skills/authtempo-integrate-workers-postgres/SKILL.md",
  "packages/mcp/skills/authtempo-protect-mcp-server/SKILL.md",
];

/** A packed code file that holds the note as a value and shows it only at 0.0.0. */
export interface UnpublishedCode {
  /** The packed path from the repository root. */
  path: string;
  /** Why the file may hold the note at every version. */
  reason: string;
  /** The test file, from the repository root, that holds the gate. */
  proof: string;
}

/**
 * The packed code files that may hold the note at every version. The CLI
 * compiles UNPUBLISHED_NOTE of src/templates.ts into these two files. It
 * prints the note and writes it into a scaffold only when its own version is
 * 0.0.0 (isUnpublished). Without this list, the first release fails on code
 * that never shows the note. An entry fails when no tarball holds its path,
 * when the file no longer holds the note, and when its proof does not exist.
 */
export const UNPUBLISHED_CODE: readonly UnpublishedCode[] = [
  {
    path: "packages/cli/dist/templates.js",
    reason:
      "UNPUBLISHED_NOTE of src/templates.ts; the CLI shows it only at 0.0.0, and the build renders dist/templates.json without it above 0.0.0",
    proof: "packages/cli/test/init-scaffold.test.ts",
  },
  {
    path: "packages/cli/dist/templates.d.ts",
    reason: "the declaration of UNPUBLISHED_NOTE, whose type is its text",
    proof: "packages/cli/test/init-scaffold.test.ts",
  },
];

/** The lists that the rule reads. Each test of a fixture tree gives its own. */
export interface UnpublishedLists {
  files: readonly string[];
  code: readonly UnpublishedCode[];
}

/** The lists of the repository. */
export const UNPUBLISHED_LISTS: UnpublishedLists = {
  files: UNPUBLISHED_FILES,
  code: UNPUBLISHED_CODE,
};

/** The failure of a listed file that still holds the note above 0.0.0. The dry run reads it back with listedNotePath. */
export const listedNoteFailure = (path: string, version: string): string =>
  `${path} still holds the note "${UNPUBLISHED_MARK}" at ${version}; the version branch rewrites each file of UNPUBLISHED_FILES`;

const LISTED_NOTE =
  /^(\S+) still holds the note "(.*)" at (\S+); the version branch rewrites each file of UNPUBLISHED_FILES$/;

/** The path and the version of a failure of listedNoteFailure, or null for another line. */
export function listedNotePath(failure: string): { path: string; version: string } | null {
  const m = LISTED_NOTE.exec(failure);
  if (m?.[1] === undefined || m[3] === undefined || m[2] !== UNPUBLISHED_MARK) return null;
  return { path: m[1], version: m[3] };
}

/** The failure of a listed file that lacks the note at 0.0.0. */
export const missingNoteFailure = (path: string): string =>
  `${path} is in UNPUBLISHED_FILES and lacks the note "${UNPUBLISHED_MARK}" at ${UNPUBLISHED_VERSION}`;

export interface UnpublishedInput {
  /** The group version of the packed files. */
  version: string;
  /** Each packed file, by its path from the repository root. */
  packed: readonly string[];
  /** Each packed file whose text holds UNPUBLISHED_MARK. */
  marked: readonly string[];
  lists: UnpublishedLists;
  /** True when the proof file exists, by its path from the repository root. */
  exists: (path: string) => boolean;
}

/**
 * The failures of the note rule over the packed files. At 0.0.0, each listed
 * file holds the note, and each file with the note is listed. Above 0.0.0, no
 * packed file holds the note. A code file of the lists is exempt at every
 * version. A list entry that names no packed file is stale and fails.
 */
export function unpublishedFailures(input: UnpublishedInput): string[] {
  const { version, lists } = input;
  const failures: string[] = [];
  const packed = new Set(input.packed);
  const marked = new Set(input.marked);
  const listed = new Set<string>();
  for (const path of lists.files) {
    if (listed.has(path)) failures.push(`UNPUBLISHED_FILES lists ${path} twice`);
    listed.add(path);
    if (!packed.has(path)) failures.push(`UNPUBLISHED_FILES lists ${path}, which no tarball holds`);
  }
  const code = new Set<string>();
  for (const entry of lists.code) {
    code.add(entry.path);
    if (listed.has(entry.path))
      failures.push(`${entry.path} is in UNPUBLISHED_FILES and in UNPUBLISHED_CODE`);
    if (!packed.has(entry.path))
      failures.push(`UNPUBLISHED_CODE lists ${entry.path}, which no tarball holds`);
    else if (!marked.has(entry.path))
      failures.push(
        `UNPUBLISHED_CODE lists ${entry.path}, which does not hold the note; remove the entry`,
      );
    if (!input.exists(entry.proof))
      failures.push(`UNPUBLISHED_CODE: the proof ${entry.proof} of ${entry.path} does not exist`);
  }
  const unreleased = version === UNPUBLISHED_VERSION;
  for (const path of [...packed].sort()) {
    if (code.has(path)) continue;
    const holds = marked.has(path);
    if (unreleased) {
      if (listed.has(path) && !holds) failures.push(missingNoteFailure(path));
      if (!listed.has(path) && holds)
        failures.push(
          `${path} holds the note "${UNPUBLISHED_MARK}" at ${version}, and UNPUBLISHED_FILES lacks it`,
        );
    } else if (holds)
      failures.push(
        listed.has(path)
          ? listedNoteFailure(path, version)
          : `${path} holds the note "${UNPUBLISHED_MARK}" at ${version}, and UNPUBLISHED_FILES lacks it; no packed file holds it above ${UNPUBLISHED_VERSION}`,
      );
  }
  return failures;
}
