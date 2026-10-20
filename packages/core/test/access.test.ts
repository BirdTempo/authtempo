import { describe, expect, it } from "vitest";
import {
  CORE_STATEMENTS,
  can,
  effectiveOf,
  intersect,
  type RoleTable,
  type Statements,
  statementFault,
  union,
} from "../src/access.js";

/**
 * The one node:fs call of the import check. Core's typecheck has no Node
 * types, because core runs on Workers; vitest runs in Node. A specifier in a
 * constant keeps the import out of the typecheck (as sweep.test.ts does).
 */
interface SourceFs {
  readFileSync(file: URL, encoding: "utf8"): string;
}
const FS_MODULE = "node:fs";

const g: Statements = { member: ["read", "create"], invitation: ["read"] };

const table: RoleTable = {
  member: { rank: 2, permissions: { member: ["read"], ac: ["read"] } },
  admin: { rank: 3, permissions: { member: ["read", "create"] } },
};

describe("access", () => {
  it("answers false on an empty, unknown, or partial request", () => {
    expect(can(g, {})).toBe(false);
    expect(can(g, { member: [] })).toBe(false);
    expect(can(g, { ghost: ["read"] })).toBe(false);
    expect(can(g, { member: ["fly"] })).toBe(false);
    expect(can(g, { member: ["read", "fly"] })).toBe(false);
    expect(can(g, { member: ["read"] })).toBe(true);
    expect(can(g, { member: ["read", "create"], invitation: ["read"] })).toBe(true);
  });

  it("never throws on a value that is not a statement set", () => {
    expect(can(g, null as never)).toBe(false);
    expect(can(g, "x" as never)).toBe(false);
    expect(can(null as never, { member: ["read"] })).toBe(false);
    expect(can(g, { member: "read" } as never)).toBe(false);
    expect(can({ member: "read" } as never, { member: ["read"] })).toBe(false);
  });

  it("unions the parts of a role string and ignores an unknown part", () => {
    expect(effectiveOf("member,ghost", table)).toEqual({ member: ["read"], ac: ["read"] });
    expect(effectiveOf("ghost", table)).toEqual({});
    expect(effectiveOf("member,admin", table)).toEqual({
      member: ["read", "create"],
      ac: ["read"],
    });
    // A name of Object.prototype is no role of the table.
    expect(effectiveOf("constructor,toString", table)).toEqual({});
  });

  it("keeps each action once in union and intersect", () => {
    const a: Statements = { member: ["read", "create"], team: ["create"] };
    const b: Statements = { member: ["create", "read", "delete"], ac: ["read"] };
    expect(union(a, b)).toEqual({
      member: ["read", "create", "delete"],
      team: ["create"],
      ac: ["read"],
    });
    expect(union(a, a)).toEqual(a);
    expect(intersect(a, b)).toEqual({ member: ["read", "create"] });
    expect(intersect({ member: ["read", "read"] }, { member: ["read"] })).toEqual({
      member: ["read"],
    });
    expect(intersect({ team: ["create"] }, { team: ["delete"] })).toEqual({});
  });

  it("finds the first fault of a bad set", () => {
    const faults = [
      statementFault({ ghost: ["read"] }, CORE_STATEMENTS),
      statementFault({ member: ["fly"] }, CORE_STATEMENTS),
      statementFault({ member: [] }, CORE_STATEMENTS),
      statementFault({ member: ["read", "read"] }, CORE_STATEMENTS),
      statementFault({ "Bad name": ["read"] }, CORE_STATEMENTS),
      statementFault("x", CORE_STATEMENTS),
    ];
    expect(faults).toEqual([
      "ghost is not a known resource",
      "member.fly is not a known action",
      "member lists no action",
      "member.read is repeated",
      "Bad name is not a resource name",
      "the permissions must be an object",
    ]);
    expect(new Set(faults).size).toBe(6);
    expect(statementFault({ member: ["read"], ac: ["update"] }, CORE_STATEMENTS)).toBeNull();
    expect(statementFault({}, CORE_STATEMENTS)).toBeNull();
  });

  it("imports nothing", async () => {
    const { readFileSync }: SourceFs = await import(/* @vite-ignore */ FS_MODULE);
    const source = readFileSync(new URL("../src/access.ts", import.meta.url), "utf8");
    expect(source.length).toBeGreaterThan(0);
    expect(source.split("\n").filter((line) => line.startsWith("import"))).toEqual([]);
    // A re-export is an import too.
    expect(source.split("\n").filter((line) => /\bfrom\s+["']/.test(line))).toEqual([]);
  });
});
