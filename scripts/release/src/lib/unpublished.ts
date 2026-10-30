// The note "not on a registry yet" in the packed files (ruling 47 of plan 12j,
// item 1). The rule of deviation 6 holds packed files too. While the group is
// at 0.0.0, each file of UNPUBLISHED_FILES holds its note, and no other packed
// file holds a note form. Above 0.0.0, no packed file holds one. check-pack
// holds the rule on the tarballs. At the first release, rewrite-unpublished
// replaces each note with its published text (ruling 50 of plan 12j). Node
// runs this file by type stripping, so it holds only syntax that type
// stripping erases.

// The one source of the forms: the site check check-unpublished reads the same file.
import {
  noteForms,
  UNPUBLISHED_FORMS,
  UNPUBLISHED_MARK,
  type UnpublishedForm,
} from "../../../../apps/site/src/data/unpublished.ts";

export { noteForms, UNPUBLISHED_FORMS, UNPUBLISHED_MARK, type UnpublishedForm };

/** The version of every package before the first release. */
export const UNPUBLISHED_VERSION = "0.0.0";

/** One note of a packed file, and the text in its place at the first release. */
export interface UnpublishedNote {
  /** The form of the note that the text holds. */
  form: UnpublishedForm;
  /** The exact text of the note: a line, a sentence, or the lines of the paragraphs that go. */
  note: string;
  /** The exact text that rewrite-unpublished writes in its place. */
  published: string;
}

/** A packed file with one note or more. */
export interface UnpublishedFile {
  /** The packed path from the repository root. */
  path: string;
  notes: readonly UnpublishedNote[];
}

/** The line of each skill of the MCP package: the app lives in the workspace of a clone. */
const SKILL_NOTE =
  "- A clone of the authtempo repo. The packages are not on a registry yet, so the app lives in the pnpm workspace of the repo.";

/** The line of a skill in its place: the scaffold names the packages at the version of the CLI. */
const SKILL_PUBLISHED =
  "- The `@authtempo` packages are on npm, so the app installs them with `pnpm install`.";

/** The skills of the MCP package, each with SKILL_NOTE. */
const SKILLS = [
  "authtempo-integrate-binding",
  "authtempo-integrate-bun",
  "authtempo-integrate-node",
  "authtempo-integrate-workers-d1",
  "authtempo-integrate-workers-postgres",
  "authtempo-protect-mcp-server",
];

/** The install note of a README with the form `form`, and its text in its place. */
const installNote = (
  name: string,
  form: "when the package is published" | "when the package is on npm",
): UnpublishedFile => ({
  path: `packages/${name}/README.md`,
  notes: [
    {
      form,
      note: `${form.charAt(0).toUpperCase()}${form.slice(1)}, run \`pnpm add @authtempo/${name}\`.\nPublication is on hold. In this workspace, add it with \`"workspace:*"\`.`,
      published: `Run \`pnpm add @authtempo/${name}\`.`,
    },
  ],
});

/**
 * Each packed file that holds a note while the group is at 0.0.0, by its path
 * from the repository root. Read from the tree with `git grep -il` of each
 * form on 2026-10-30: the README of the CLI, each skill and the README of the
 * MCP package, and the READMEs of breach-check, captcha-turnstile, observe,
 * and verify. Each one ships in a tarball, so a stale note reaches every app
 * that installs it. check-pack fails on a packed file with a note form that
 * this list lacks, so a new one joins the list. check-changesets reads the
 * paths for the version branch.
 */
export const UNPUBLISHED_FILES: readonly UnpublishedFile[] = [
  {
    path: "packages/cli/README.md",
    notes: [
      {
        form: "not on a registry yet",
        note: `The packages are not on a registry yet: publication is the owner's call.
Until then, build the CLI once in a clone of this repo, then run each command
with \`node\` and the absolute path of the clone, from the folder of your app:

\`\`\`bash
cd /path/to/authtempo
pnpm turbo run build --filter=@authtempo/cli
cd /path/to/my-app
node /path/to/authtempo/packages/cli/dist/bin/authtempo.js --help
\`\`\`

Write the path of your clone in place of \`/path/to/authtempo\`. Each relative
path that a command reads or writes, such as \`--config\` or \`--users\`,
resolves from the current folder. \`test/documented-run.test.ts\` runs this
form from a temporary folder. \`examples/worker\` links the binary too, but
\`pnpm --filter authtempo-example-worker exec authtempo\` runs in
\`examples/worker\`, not in your folder, and exits 1 on any failure, so use it
for \`--help\` only. After the first release, install the CLI with
\`pnpm add -D @authtempo/cli\`, or run it with \`pnpm dlx @authtempo/cli\`.`,
        published:
          "Install the CLI with `pnpm add -D @authtempo/cli`, or run it with\n`pnpm dlx @authtempo/cli`.",
      },
      {
        form: "until the packages are on a registry",
        note: "Until the packages are on a registry, a\nscaffold installs only inside this workspace.",
        published: "A scaffold names each\n`@authtempo` package at the version of the CLI.",
      },
    ],
  },
  ...SKILLS.map(
    (skill): UnpublishedFile => ({
      path: `packages/mcp/skills/${skill}/SKILL.md`,
      notes: [{ form: "not on a registry yet", note: SKILL_NOTE, published: SKILL_PUBLISHED }],
    }),
  ),
  {
    path: "packages/mcp/README.md",
    notes: [
      {
        form: "it is not published",
        note: "The package is private. It is not published.",
        published: "The package is on npm as `@authtempo/mcp`.",
      },
    ],
  },
  installNote("breach-check", "when the package is published"),
  installNote("captcha-turnstile", "when the package is published"),
  installNote("observe", "when the package is on npm"),
  installNote("verify", "when the package is on npm"),
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
  files: readonly UnpublishedFile[];
  code: readonly UnpublishedCode[];
}

/** The lists of the repository. */
export const UNPUBLISHED_LISTS: UnpublishedLists = {
  files: UNPUBLISHED_FILES,
  code: UNPUBLISHED_CODE,
};

/** The forms of a failure line, each in quotes. */
const quoted = (forms: readonly string[]) => forms.map((f) => `"${f}"`).join(", ");

/** The failure of a listed file that still holds a note form above 0.0.0. */
export const listedNoteFailure = (
  path: string,
  forms: readonly string[],
  version: string,
): string =>
  `${path} still holds the note ${quoted(forms)} at ${version}; rewrite-unpublished rewrites each note of UNPUBLISHED_FILES`;

/** The failure of a listed file that lacks the form of one of its notes at 0.0.0. */
export const missingNoteFailure = (path: string, form: string): string =>
  `${path} is in UNPUBLISHED_FILES and lacks its note form "${form}" at ${UNPUBLISHED_VERSION}`;

export interface UnpublishedInput {
  /** The group version of the packed files. */
  version: string;
  /** Each packed file, by its path from the repository root. */
  packed: readonly string[];
  /** Each packed file that holds a note form, with the forms that noteForms finds in it. */
  marked: ReadonlyMap<string, readonly string[]>;
  lists: UnpublishedLists;
  /** True when the proof file exists, by its path from the repository root. */
  exists: (path: string) => boolean;
}

/**
 * The failures of the note rule over the packed files. At 0.0.0, each listed
 * file holds the form of each of its notes, and no other packed file holds a
 * form. Above 0.0.0, no packed file holds a form. A code file of the lists is
 * exempt at every version. A list entry that names no packed file is stale
 * and fails.
 */
export function unpublishedFailures(input: UnpublishedInput): string[] {
  const { version, lists, marked } = input;
  const failures: string[] = [];
  const packed = new Set(input.packed);
  const listed = new Map<string, UnpublishedFile>();
  for (const file of lists.files) {
    if (listed.has(file.path)) failures.push(`UNPUBLISHED_FILES lists ${file.path} twice`);
    listed.set(file.path, file);
    if (!packed.has(file.path))
      failures.push(`UNPUBLISHED_FILES lists ${file.path}, which no tarball holds`);
    if (file.notes.length === 0) failures.push(`UNPUBLISHED_FILES lists ${file.path} with no note`);
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
    const forms = marked.get(path) ?? [];
    const file = listed.get(path);
    if (unreleased) {
      if (file !== undefined)
        for (const form of new Set(file.notes.map((n) => n.form)))
          if (!forms.includes(form)) failures.push(missingNoteFailure(path, form));
      if (file === undefined && forms.length > 0)
        failures.push(
          `${path} holds the note ${quoted(forms)} at ${version}, and UNPUBLISHED_FILES lacks it`,
        );
    } else if (forms.length > 0)
      failures.push(
        file !== undefined
          ? listedNoteFailure(path, forms, version)
          : `${path} holds the note ${quoted(forms)} at ${version}, and UNPUBLISHED_FILES lacks it; no packed file holds it above ${UNPUBLISHED_VERSION}`,
      );
  }
  return failures;
}
