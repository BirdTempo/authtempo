import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DOCS, REPO } from "../scripts/lib/paths.ts";

// The CLI page states the Node floor of the CLI (plan 12j Task 13, from the
// review of Task 3b). The engines field of packages/cli/package.json is the
// one source, so a change of the floor fails here until the page follows.
const engines = (
  JSON.parse(readFileSync(`${REPO}packages/cli/package.json`, "utf8")) as {
    engines?: { node?: string };
  }
).engines?.node;
const page = readFileSync(`${DOCS}docs/reference/cli/index.md`, "utf8");

describe("the Node floor of the CLI page", () => {
  it("is the engines floor of @authtempo/cli", () => {
    const floor = /^>=(\d+(?:\.\d+){0,2})$/.exec(engines ?? "")?.[1];
    expect(floor, `engines.node is ${engines}`).toBeDefined();
    const before = page.split("## Before you start")[1]?.split("\n## ")[0] ?? "";
    expect(before).toContain(`- Node ${floor} or newer.`);
  });
});
