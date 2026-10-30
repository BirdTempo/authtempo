import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkResources, type ResourcesInput } from "../scripts/check-resources.ts";
import { DOCS } from "../scripts/lib/paths.ts";
import { summaryLine } from "../scripts/lib/report.ts";
import { RESOURCES_EMPTY } from "../src/data/unpublished.ts";

const URL = "https://github.com/BirdTempo/authtempo";
const source = readFileSync(`${DOCS}docs/resources.md`, "utf8");
const CONTRIBUTE = `- [CONTRIBUTING.md](${URL}/blob/main/CONTRIBUTING.md)\n- [SECURITY.md](${URL}/blob/main/SECURITY.md)\n`;
/** A page of the first release: each released package, each example, and the demo. */
const RELEASE_PAGE = [
  "| [`@authtempo/core`](https://www.npmjs.com/package/@authtempo/core) |",
  "| [`@authtempo/cli`](https://www.npmjs.com/package/@authtempo/cli) |",
  `| [examples/node](${URL}/tree/main/examples/node) |`,
  "| [The demo](/demo/) |",
  CONTRIBUTE,
].join("\n");

const AT_ZERO: ResourcesInput = {
  version: "0.0.0",
  source,
  released: ["@authtempo/cli", "@authtempo/core"],
  examples: ["node"],
  repoUrl: URL,
  empty: RESOURCES_EMPTY,
};
const RELEASED: ResourcesInput = { ...AT_ZERO, version: "0.1.0", source: RELEASE_PAGE };
const failures = (input: ResourcesInput) => checkResources(input).failures;

describe("check-resources", () => {
  it("states the empty state at 0.0.0", () => {
    expect(summaryLine(checkResources(AT_ZERO))).toBe(
      "check-resources: PASS pages=1 packages=0 examples=0 demo=0 links=2 failures=0",
    );
    expect(failures({ ...AT_ZERO, source: CONTRIBUTE })).toEqual([
      `core is at 0.0.0, so the page must state: ${RESOURCES_EMPTY}`,
    ]);
  });

  it("fails a package row at 0.0.0", () => {
    expect(failures({ ...AT_ZERO, source: `${source}\n${RELEASE_PAGE}` })).toEqual([
      "core is at 0.0.0, and the page has a package row: @authtempo/core",
      "core is at 0.0.0, and the page has a package row: @authtempo/cli",
      "core is at 0.0.0, and the page has an example row: node",
      "core is at 0.0.0, and the page links the demo /demo/",
    ]);
  });

  it("lists each released package above 0.0.0, both ways", () => {
    expect(failures(RELEASED)).toEqual([]);
    expect(
      failures({
        ...RELEASED,
        released: ["@authtempo/cli", "@authtempo/core", "@authtempo/client"],
      }),
    ).toEqual([
      "the page has no row for the package @authtempo/client (https://www.npmjs.com/package/@authtempo/client)",
    ]);
    expect(failures({ ...RELEASED, released: ["@authtempo/core"] })).toEqual([
      "the page lists @authtempo/cli, which is not a released package",
    ]);
    expect(failures({ ...RELEASED, source: `${RELEASE_PAGE}\n${RESOURCES_EMPTY}` })).toEqual([
      `core is at 0.1.0, so the page must not state: ${RESOURCES_EMPTY}`,
    ]);
  });

  it("lists each example app and the demo above 0.0.0, both ways", () => {
    expect(failures({ ...RELEASED, examples: ["node", "worker"] })).toEqual([
      `the page has no row for the example worker (${URL}/tree/main/examples/worker)`,
    ]);
    expect(failures({ ...RELEASED, examples: [] })).toEqual([
      "the page lists the example node, which is not an example folder",
    ]);
    expect(failures({ ...RELEASED, source: RELEASE_PAGE.replace("(/demo/)", "(/docs/)") })).toEqual(
      ["the page has no row for the demo (/demo/)"],
    );
  });

  it("fails a package, an example, or the demo with two links", () => {
    const twice = [
      RELEASE_PAGE,
      "| [`@authtempo/core`](https://www.npmjs.com/package/@authtempo/core) |",
      `| [examples/node](${URL}/tree/main/examples/node) |`,
      "| [The demo](/demo/) |",
    ].join("\n");
    expect(failures({ ...RELEASED, source: twice })).toEqual([
      "the page links the package @authtempo/core 2 times",
      "the page links the example node 2 times",
      "the page links the demo /demo/ 2 times",
    ]);
  });

  it("links CONTRIBUTING.md and SECURITY.md at every version", () => {
    for (const input of [AT_ZERO, RELEASED]) {
      const without = input.source.replace(`(${URL}/blob/main/CONTRIBUTING.md)`, "(/docs/)");
      expect(failures({ ...input, source: without })).toEqual([
        `the page does not link CONTRIBUTING.md (${URL}/blob/main/CONTRIBUTING.md)`,
      ]);
    }
    // A link to another repository does not count.
    expect(failures({ ...AT_ZERO, repoUrl: "https://github.com/other/authtempo" })).toHaveLength(2);
  });
});
