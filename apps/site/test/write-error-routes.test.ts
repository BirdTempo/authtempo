import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DOCS, SITE } from "../scripts/lib/paths.ts";

const PAGE = `${DOCS}docs/reference/errors.md`;

/** The Routes row of the code at `anchor` on the errors page. */
function rowOf(lines: readonly string[], anchor: string): string {
  const at = lines.findIndex((l) => l.startsWith(`<h3 id="${anchor}">`));
  const next = lines.findIndex((l, i) => i > at && l.startsWith("<h3 "));
  const head = lines.findIndex((l, i) => i > at && l === "| Routes |");
  if (at < 0 || head < 0 || (next >= 0 && head > next))
    throw new Error(`#${anchor}: no Routes table on the errors page`);
  return lines[head + 2] ?? "";
}

// The script writes the Routes cell of a code from ROUTES (decision 4 of plan
// 12n). This test holds its form to the cells of the page (ruling 36 of plan
// 12n). So each cell that it writes keeps that form.
describe("write-error-routes", () => {
  it("prints the cell of the page for a list with closing prose, a mention, and an OAuth code", () => {
    // In the order of the page, because the script prints in that order.
    const anchors = ["unauthorized", "session_not_fresh", "oauth-invalid_token"];
    const lines = readFileSync(PAGE, "utf8").split("\n");
    const run = spawnSync(process.execPath, [`${SITE}scripts/write-error-routes.ts`, ...anchors], {
      encoding: "utf8",
    });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(anchors.map((a) => `#${a}\n${rowOf(lines, a)}\n\n`).join(""));
  });
});
