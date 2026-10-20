import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RELEASED_FILTERS_SHELL, RELEASED_NAMES_SHELL } from "../src/lib/release-copy.ts";
import { releasedNames } from "../src/lib/released.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

/** Each word that the shell makes of `text` at the root of the checkout. */
const shellWords = (text: string) =>
  execFileSync("sh", ["-c", `printf '%s\\n' ${text}`], { cwd: repoRoot, encoding: "utf8" })
    .split("\n")
    .filter((w) => w !== "");

describe("release copy", () => {
  it("reads the released names in the shell as releasedNames does", () => {
    // One fact, two readers: releasedNames for the scripts, and jq for the
    // run lines of release.yml (review of Task 6, L4).
    expect(RELEASED_NAMES_SHELL).toBe("$(jq -r '.fixed[0][]' .changeset/config.json)");
    expect(RELEASED_FILTERS_SHELL).toBe(
      `$(jq -r '"--filter=" + .fixed[0][]' .changeset/config.json)`,
    );
    const names = releasedNames(repoRoot);
    expect(names.length).toBeGreaterThan(0);
    expect(shellWords(RELEASED_NAMES_SHELL)).toEqual(names);
    expect(shellWords(RELEASED_FILTERS_SHELL)).toEqual(names.map((n) => `--filter=${n}`));
  });
});
