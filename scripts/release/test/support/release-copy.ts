import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { releasedNames } from "../../src/lib/released.ts";
import { readWorkspace } from "../../src/lib/workspace.ts";

/** The tree of fixtures/release-copy: two released packages at 0.0.0, as on main. */
export const RELEASE_COPY_FIXTURE = fileURLToPath(
  new URL("../fixtures/release-copy", import.meta.url),
);

/** A copy of fixtures/release-copy in a new temporary folder, after `edit`. */
export function copyFixture(edit: (dir: string) => void = () => {}): string {
  const dir = mkdtempSync(join(tmpdir(), "authtempo-release-copy-"));
  cpSync(RELEASE_COPY_FIXTURE, dir, { recursive: true });
  edit(dir);
  return dir;
}

/**
 * What `pnpm changeset version` 3.0.3 writes for one minor changeset that names
 * each released package. Each version moves to 0.1.0, and each package gets a
 * CHANGELOG.md. Task 2 of plan 12j recorded the bytes in a copy of the tree
 * ($SCRATCH/plan-12j-task-2-changesets.md). A package that depends on another
 * released package also gets the "Updated dependencies" lines.
 */
export function changesetVersion(dir: string, body: string): void {
  const released = new Set(releasedNames(dir));
  for (const p of readWorkspace(dir)) {
    if (!released.has(p.name)) continue;
    const file = join(dir, p.dir, "package.json");
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace('"version": "0.0.0"', '"version": "0.1.0"'),
    );
    const deps = Object.keys(p.manifest.dependencies ?? {}).filter((d) => released.has(d));
    const updated =
      deps.length === 0
        ? ""
        : `\n### Patch Changes\n\n- Updated dependencies\n${deps.map((d) => `  - ${d}@0.1.0\n`).join("")}`;
    writeFileSync(
      join(dir, p.dir, "CHANGELOG.md"),
      `# ${p.name}\n\n## 0.1.0\n\n### Minor Changes\n\n- ${body}\n${updated}`,
    );
  }
  const changeset = join(dir, ".changeset/dry-run.md");
  if (existsSync(changeset)) rmSync(changeset);
}
