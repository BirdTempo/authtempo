import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  checkDependenciesPage,
  type DependenciesPageInput,
  type DependencyRow,
  pageRow,
} from "../scripts/check-dependencies-page.ts";
import { DOCS, REPO } from "../scripts/lib/paths.ts";

const rows = JSON.parse(
  readFileSync(`${REPO}release/dependencies.json`, "utf8"),
) as DependencyRow[];
const released = (
  JSON.parse(readFileSync(`${REPO}.changeset/config.json`, "utf8")) as { fixed: string[][] }
).fixed[0] as string[];
const source = readFileSync(`${DOCS}docs/reference/dependencies.md`, "utf8");
const REAL: DependenciesPageInput = { rows, released, source };
const failures = (input: DependenciesPageInput) => checkDependenciesPage(input).failures;

/** The first runtime row of a released package, and its table row. */
const runtime = rows.find((r) => r.kind === "runtime" && pageRow(r, released) !== null);
if (runtime === undefined) throw new Error("no runtime row of a released package");
const line = pageRow(runtime, released) ?? "";

describe("check-dependencies-page", () => {
  it("passes the real page against the real file", () => {
    expect(failures(REAL)).toEqual([]);
  });

  it("holds one row per runtime row of dependencies.json, both ways", () => {
    // A runtime row of the file with no table row.
    expect(failures({ ...REAL, source: source.replace(`${line}\n`, "") })).toEqual([
      `docs/reference/dependencies.md lacks the row | \`${runtime.name}\` | runtime |`,
    ]);
    // A table row with no row of the file.
    expect(failures({ ...REAL, rows: rows.filter((r) => r !== runtime) })).toEqual([
      `docs/reference/dependencies.md has the row | \`${runtime.name}\` | runtime |, which no runtime or peer row of a released package gives`,
    ]);
    // A row of the file with a new version.
    const moved = rows.map((r) => (r === runtime ? { ...r, versions: ["9.9.9"] } : r));
    expect(failures({ ...REAL, rows: moved })).toHaveLength(1);
  });

  it("fails a row that the table holds twice", () => {
    expect(
      failures({ ...REAL, source: source.replace(`${line}\n`, `${line}\n${line}\n`) }),
    ).toEqual([
      `docs/reference/dependencies.md has the row | \`${runtime.name}\` | runtime | 2 times`,
    ]);
  });

  it("lists a peer row of a released package, and no dev row or example-only row", () => {
    expect(
      pageRow(
        { name: "x", kind: "dev", versions: ["1.0.0"], users: released, reason: "r" },
        released,
      ),
    ).toBeNull();
    expect(
      pageRow(
        {
          name: "x",
          kind: "runtime",
          versions: ["1.0.0"],
          users: ["authtempo-example-node"],
          reason: "r",
        },
        released,
      ),
    ).toBeNull();
    expect(
      pageRow(
        {
          name: "x",
          kind: "peer",
          versions: ["^1.0.0"],
          users: ["@authtempo/core"],
          reason: "a | b",
        },
        ["@authtempo/core"],
      ),
    ).toBe("| `x` | peer | `^1.0.0` | `@authtempo/core` | a \\| b |");
  });

  it("fails a missing page", () => {
    expect(failures({ ...REAL, source: "" })).toContain(
      "docs/reference/dependencies.md does not exist",
    );
  });
});
