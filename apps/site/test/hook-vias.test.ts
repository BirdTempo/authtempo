import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DOCS, REPO } from "../scripts/lib/paths.ts";

// The hooks guide lists the `via` values of three hook inputs. Each list must
// hold every member of its type in core, so a new value fails here until the
// guide names it. Plan 12i Tasks 5 and 6 added `phone` and `anonymous` to
// the session type, and the guide missed both (ruling 31 join).

const HOOKS = readFileSync(`${REPO}packages/core/src/engine/hooks.ts`, "utf8");
const GUIDE = readFileSync(`${DOCS}docs/guides/hooks.mdx`, "utf8");

/** The string members of the union `name` in hooks.ts. */
function union(name: string): string[] {
  const body = new RegExp(`export type ${name} =([^;]+);`).exec(HOOKS)?.[1];
  if (body === undefined) throw new Error(`no type ${name}`);
  return [...body.matchAll(/"([a-z_]+)"/g)].map((m) => m[1] ?? "").sort();
}

/** The code values of the guide row whose first cell is `label`. */
function row(label: string): string[] {
  const line = GUIDE.split("\n").find((l) => l.startsWith(`| ${label} |`));
  if (line === undefined) throw new Error(`no row ${label}`);
  const cell = line.split("|")[2] ?? "";
  return [...cell.matchAll(/`([a-z_]+)`/g)].map((m) => m[1] ?? "").sort();
}

describe("the via rows of the hooks guide", () => {
  it.each([
    ["`via` of a session", "SessionVia"],
    ["`via` of a user update", "UserUpdateVia"],
    ["`via` of a user verify", "UserVerifyVia"],
  ])("%s lists each member of %s", (label, type) => {
    const members = union(type);
    expect(members.length).toBeGreaterThan(4);
    expect(row(label)).toEqual(members);
  });
});
