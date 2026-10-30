import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PRE_RELEASE_SENTENCES } from "../../../apps/site/src/data/unpublished.ts";
import { groupVersion } from "../src/lib/released.ts";
import { noteForms, UNPUBLISHED_VERSION } from "../src/lib/unpublished.ts";
import { rewriteUnpublished } from "../src/rewrite-unpublished.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const README = readFileSync(join(root, "README.md"), "utf8");

/**
 * The two texts of the section Packages while no release exists, each with
 * its entry of PRE_RELEASE_SENTENCES (plan 12j Task 14 Step 3, and ruling 58
 * item 5): the note, which rewrite-unpublished removes, and the install line,
 * which it replaces with the published install line.
 */
const ENTRIES = PRE_RELEASE_SENTENCES.filter((e) => e.file === "README.md");
const NOTE = ENTRIES.find((e) => noteForms(e.sentence).length > 0)?.sentence ?? "";
/** The install line of the section Packages at 0.0.0. */
const INSTALL =
  "After the first release: `pnpm add @authtempo/core @authtempo/adapter-d1`, then `npm audit signatures`.";
/** The install line in its place above 0.0.0. */
const PUBLISHED = ENTRIES.find((e) => e.sentence === INSTALL)?.published ?? "";
/**
 * A README before the first release, for the probes. The version branch
 * rewrites the real README, so a probe on it fails there (ruling 65 of plan
 * 12j, C1). The first test holds the real README at the group version.
 */
const BEFORE = `# authtempo\n\nAn auth engine.\n\n## Packages\n\n${NOTE}\n\n${INSTALL}\n\n## Security\n\nRead SECURITY.md.\n`;

/** The text of the section `## <name>`, up to the next `## ` heading. */
function section(text: string, name: string): string | null {
  const start = text.indexOf(`\n## ${name}\n`);
  if (start < 0) return null;
  const end = text.indexOf("\n## ", start + 1);
  return text.slice(start, end < 0 ? undefined : end);
}

/**
 * The faults of the root README at the group version `version`. At 0.0.0 the
 * section Packages holds the note and the install line. Above 0.0.0 it holds
 * the published install line, no line holds the install line of 0.0.0, and
 * no line holds a note form of UNPUBLISHED_FORMS, in any case. So the version
 * branch rewrites both texts, as it rewrites each note of UNPUBLISHED_FILES.
 */
function readmeFaults(text: string, version: string): string[] {
  const faults: string[] = [];
  const packages = section(text, "Packages");
  if (packages === null) return ["the README has no section Packages"];
  const forms = noteForms(text);
  if (version === UNPUBLISHED_VERSION) {
    if (!packages.includes(NOTE)) faults.push(`the section Packages lacks the note: ${NOTE}`);
    if (!packages.includes(INSTALL)) faults.push("the section Packages lacks the install line");
  } else {
    if (forms.length > 0)
      faults.push(
        `the group is at ${version}, and the README still holds ${forms.map((f) => `"${f}"`).join(", ")}`,
      );
    if (text.includes(INSTALL))
      faults.push(
        `the group is at ${version}, and the README still holds the install line of 0.0.0`,
      );
    if (!packages.includes(PUBLISHED))
      faults.push(
        `the group is at ${version}, and the section Packages lacks the published install line`,
      );
  }
  return faults;
}

/** The README of the release day: rewrite-unpublished with the entries of the README only. */
function released(text: string): string {
  const lists = { files: [], pages: [], pageNotes: [], sentences: ENTRIES };
  const r = rewriteUnpublished((p) => (p === "README.md" ? text : null), "0.1.0", lists);
  expect(r.failures).toEqual([]);
  return r.texts.get("README.md") ?? "";
}

describe("the root README", () => {
  it("holds the real README at the group version", () => {
    expect(ENTRIES).toHaveLength(2);
    expect(noteForms(NOTE)).toEqual(["not on a registry yet"]);
    expect(PUBLISHED).toContain("`pnpm add @authtempo/core @authtempo/adapter-d1`");
    expect(readmeFaults(README, groupVersion(root))).toEqual([]);
  });

  it("holds the note and the install line at 0.0.0, and the published install line above", () => {
    expect(readmeFaults(BEFORE, "0.0.0")).toEqual([]);
    // Both ways: the release-day README has the published texts, and the README of main keeps them.
    const day = released(BEFORE);
    expect(day).toBe(BEFORE.replace(`${NOTE}\n\n`, "").replace(INSTALL, PUBLISHED));
    expect(readmeFaults(day, "0.1.0")).toEqual([]);
    expect(readmeFaults(BEFORE, "0.1.0")).toEqual([
      'the group is at 0.1.0, and the README still holds "not on a registry yet"',
      "the group is at 0.1.0, and the README still holds the install line of 0.0.0",
      "the group is at 0.1.0, and the section Packages lacks the published install line",
    ]);
    expect(readmeFaults(day, "0.0.0")).toEqual([
      "the section Packages lacks the note: The packages are not on a registry yet.",
      "the section Packages lacks the install line",
    ]);
    // Each form counts, in any case (ruling 53, Major 1).
    expect(readmeFaults(`${day}\nWhen the package is published, run x.\n`, "0.1.0")).toEqual([
      'the group is at 0.1.0, and the README still holds "when the package is published"',
    ]);
    expect(readmeFaults(BEFORE.replace(INSTALL, ""), "0.0.0")).toEqual([
      "the section Packages lacks the install line",
    ]);
  });

  it("links SECURITY.md, its support table, and CONTRIBUTING.md", () => {
    const security = section(README, "Security");
    const contribute = section(README, "Contribute");
    expect(security).toContain("[`SECURITY.md`](SECURITY.md)");
    expect(security).toContain("[support table](SECURITY.md#supported-versions)");
    expect(contribute).toContain("[`CONTRIBUTING.md`](CONTRIBUTING.md)");
    for (const file of ["SECURITY.md", "CONTRIBUTING.md"])
      expect(existsSync(join(root, file)), file).toBe(true);
    // The anchor is the GitHub id of the heading that holds the table.
    expect(readFileSync(join(root, "SECURITY.md"), "utf8").split("\n")).toContain(
      "## Supported versions",
    );
  });
});
