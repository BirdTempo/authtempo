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
 * The note of the section Packages while no release exists (plan 12j Task 14
 * Step 3): its entry of PRE_RELEASE_SENTENCES, which rewrite-unpublished removes.
 */
const ENTRY = PRE_RELEASE_SENTENCES.find((e) => e.file === "README.md");
const NOTE = ENTRY?.sentence ?? "";
/** The install line of the section Packages. */
const INSTALL =
  "After the first release: `pnpm add @authtempo/core @authtempo/adapter-d1`, then `npm audit signatures`.";

/** The text of the section `## <name>`, up to the next `## ` heading. */
function section(text: string, name: string): string | null {
  const start = text.indexOf(`\n## ${name}\n`);
  if (start < 0) return null;
  const end = text.indexOf("\n## ", start + 1);
  return text.slice(start, end < 0 ? undefined : end);
}

/**
 * The faults of the root README at the group version `version`. At 0.0.0 the
 * section Packages holds the note and the install line. Above 0.0.0 no line
 * holds a note form of UNPUBLISHED_FORMS, in any case, so the version branch
 * removes it, as it removes each note of UNPUBLISHED_FILES.
 */
function readmeFaults(text: string, version: string): string[] {
  const faults: string[] = [];
  const packages = section(text, "Packages");
  if (packages === null) return ["the README has no section Packages"];
  if (!packages.includes(INSTALL)) faults.push("the section Packages lacks the install line");
  const forms = noteForms(text);
  if (version === UNPUBLISHED_VERSION) {
    if (!packages.includes(NOTE)) faults.push(`the section Packages lacks the note: ${NOTE}`);
  } else if (forms.length > 0)
    faults.push(
      `the group is at ${version}, and the README still holds ${forms.map((f) => `"${f}"`).join(", ")}`,
    );
  return faults;
}

/** The README of the release day: rewrite-unpublished with the entry of the README only. */
function released(text: string): string {
  if (ENTRY === undefined) throw new Error("PRE_RELEASE_SENTENCES has no entry of README.md");
  const lists = { files: [], pages: [], pageNotes: [], sentences: [ENTRY] };
  const r = rewriteUnpublished((p) => (p === "README.md" ? text : null), "0.1.0", lists);
  expect(r.failures).toEqual([]);
  return r.texts.get("README.md") ?? "";
}

describe("the root README", () => {
  it("holds the note while the group is at 0.0.0, and the install line at each version", () => {
    expect(noteForms(NOTE)).toEqual(["not on a registry yet"]);
    expect(readmeFaults(README, groupVersion(root))).toEqual([]);
    // Both ways: the release-day README has no note, and the README of main keeps it.
    const day = released(README);
    expect(day).toBe(README.replace(`${NOTE}\n\n`, ""));
    expect(readmeFaults(day, "0.1.0")).toEqual([]);
    expect(readmeFaults(README, "0.1.0")).toEqual([
      'the group is at 0.1.0, and the README still holds "not on a registry yet"',
    ]);
    expect(readmeFaults(day, "0.0.0")).toEqual([
      "the section Packages lacks the note: The packages are not on a registry yet.",
    ]);
    // Each form counts, in any case (ruling 53, Major 1).
    expect(readmeFaults(`${day}\nWhen the package is published, run x.\n`, "0.1.0")).toEqual([
      'the group is at 0.1.0, and the README still holds "when the package is published"',
    ]);
    expect(readmeFaults(README.replace(INSTALL, ""), "0.0.0")).toEqual([
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
