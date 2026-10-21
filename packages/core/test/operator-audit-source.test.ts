import { describe, expect, it } from "vitest";

/**
 * The two node:fs calls of the scan. Core's typecheck has no Node types,
 * because core runs on Workers; vitest runs in Node. A specifier in a
 * constant keeps the import out of the typecheck (ip-key-sites.test.ts).
 */
interface SourceFs {
  readdirSync(dir: URL, options: { recursive: true }): string[];
  readFileSync(file: URL, encoding: "utf8"): string;
}
const FS_MODULE = "node:fs";

/**
 * The files of core that may name the audit model. `schema.ts` declares it.
 * The adapter suite writes and reads rows of its own fresh store. `audit.ts`
 * is the one writer and the one reader. A call that is not in a file of
 * this list cannot touch the table, in any form of the name. The sweep is
 * not in the list, so no expiry removes a row. `ddl.ts` names the model only
 * in the keys of `MYSQL_STRINGS`, the MySQL column widths (plan 12g): it
 * makes no storage call.
 */
const NAMED_IN = [
  "engine/operator/audit.ts",
  "schema.ts",
  "storage/conformance.ts",
  "storage/ddl.ts",
];

describe("the audit model is append-only (plan 12f Task 4, spec 26 item 8)", () => {
  it("names the audit model only in the allowed files, and only a create and a read in the writer", async () => {
    const { readdirSync, readFileSync }: SourceFs = await import(/* @vite-ignore */ FS_MODULE);
    const src = new URL("../src/", import.meta.url);
    const files = readdirSync(src, { recursive: true }).filter((file) => file.endsWith(".ts"));
    const text = (file: string) => readFileSync(new URL(file, src), "utf8");
    // The scan must read the writer: a list with no file finds no hit.
    expect(files).toContain("engine/operator/audit.ts");
    // Any text of the name counts: a quote, a template literal, or a constant.
    const naming = files.filter((file) => text(file).includes("operatorAudit")).sort();
    expect(naming).toEqual(NAMED_IN);
    // In the writer, each use of the name is the model argument of a create
    // or a findMany. The pattern spans lines, so a split call still matches.
    const writer = text("engine/operator/audit.ts");
    const uses = writer.match(/operatorAudit/g)?.length ?? 0;
    const allowed = writer.match(/\.(create|findMany)\(\s*"operatorAudit",/g)?.length ?? 0;
    // The insert of writeAuditIn, the list, and the read of the impersonation
    // targets (plan 12f Task 11). operatorAct, the stop rows of ruling 43,
    // and each act of plan 12d write through writeAuditIn (plan 12d
    // deviation 3), so the writer holds one insert.
    expect(allowed).toBe(3);
    expect(writer.match(/\.create\(\s*"operatorAudit",/g)?.length).toBe(1);
    expect(uses).toBe(allowed);
    // In ddl.ts, each use of the name is a key of MYSQL_STRINGS in the form
    // "operatorAudit.<field>". So a storage call there fails this test.
    const ddl = text("storage/ddl.ts");
    const ddlUses = ddl.match(/operatorAudit/g)?.length ?? 0;
    const keys = ddl.match(/"operatorAudit\.[a-zA-Z]+"/g)?.length ?? 0;
    expect(keys).toBe(3);
    expect(ddlUses).toBe(keys);
  });
});
