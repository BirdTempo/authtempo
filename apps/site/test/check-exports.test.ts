import { describe, expect, it } from "vitest";
import { checkExports, exportNames, readExports } from "../scripts/check-exports.ts";

describe("exportNames", () => {
  it("reads value exports, type exports, renamed exports, and declarations", () => {
    const source = `export const VERSION = "0.0.0";
export type {
  AuthConfig,
  MailPort,
} from "./config.js";
export { ConfigError, type Auth, createAuth as make } from "./x.js";
export function helper() {}`;
    expect(exportNames(source)).toEqual([
      "Auth",
      "AuthConfig",
      "ConfigError",
      "MailPort",
      "VERSION",
      "helper",
      "make",
    ]);
  });
});

describe("readExports", () => {
  it("reads every plain form of export", () => {
    const source = `export async function a() {}
export interface B {}
export type C = string;
export let d = 1;
export abstract class E {}
export enum F {}
export default function () {}
export * as G from "./g.js";`;
    const r = readExports(source, "x.ts");
    expect(r.names).toEqual(["B", "C", "E", "F", "G", "a", "d", "default"]);
    expect(readExports("export default class Foo {}", "x.ts").names).toEqual(["default"]);
    expect(r.unreadable).toEqual([]);
  });

  it("reports export * and an unreadable line with the file and the line", () => {
    const r = readExports(
      `export const ok = 1;\nexport * from "./more.js";\nexport =  foo;`,
      "src/index.ts",
    );
    expect(r.names).toEqual(["ok"]);
    expect(r.unreadable).toEqual([
      'src/index.ts:2: export * from "./more.js" re-exports names that this check cannot list',
      "src/index.ts:3: cannot read the export: export =  foo;",
    ]);
  });
});

const read = (names: string[], unreadable: string[] = []) => ({ names, unreadable });

/** A built table: a header row of `heads`, and one body row per entry of `rows`. */
function table(heads: string[], rows: string[][]): string {
  const th = heads.map((h) => `<th>${h}</th>`).join("");
  const body = rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("");
  return `<table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>`;
}

/** A built h2 in the wrapper that Starlight writes. */
const h2 = (text: string) =>
  `<div class="sl-heading-wrapper level-h2"><h2 id="x">${text}</h2></div>`;

describe("checkExports", () => {
  it("fails closed on an export line that the reader could not read", () => {
    const r = checkExports(
      h2("Exports") + table(["Export"], [["<code>a</code>"]]),
      read(["a"], ["x.ts:2: cannot read the export: export =  foo;"]),
      "core",
      ["Exports"],
    );
    expect(r.failures).toEqual(["x.ts:2: cannot read the export: export =  foo;"]);
  });

  it("passes when each name is a row of the entry's exports table, and each row an export", () => {
    const html =
      h2("Exports") +
      table(
        ["Export", "What it is"],
        [['<code dir="auto">createAuth</code>, <code>AuthConfig</code>', "The two."]],
      );
    const r = checkExports(html, read(["createAuth", "AuthConfig"]), "core", ["Exports"]);
    expect(r.failures).toEqual([]);
    expect(r.counts).toEqual({ exports: 2, found: 2, rows: 2 });
  });

  it("refuses an export that is a code span elsewhere on the page but not a row of its table", () => {
    const html = `<p><code>ROUTES</code></p>${h2("Exports")}${table(["Export"], [["<code>a</code>"]])}`;
    const r = checkExports(html, read(["a", "ROUTES"]), "core", ["Exports"]);
    expect(r.failures).toEqual(["core export ROUTES is not in its exports table"]);
  });

  it("refuses a row of the table that names no export of the entry", () => {
    const html = h2("Exports") + table(["Export"], [["<code>a</code>, <code>gone</code>"]]);
    const r = checkExports(html, read(["a"]), "core", ["Exports"]);
    expect(r.failures).toEqual(["core row gone names no export of the entry"]);
  });

  it("reads only its own sections, every table in them, and the Exports and Types columns", () => {
    const html =
      h2("Mine") +
      table(["Entry", "Exports"], [["<code>@x/a</code>", "<code>a</code>"]]) +
      table(["Area", "Types"], [["Sessions", "<code>T</code>"]]) +
      table(["Option", "Default"], [["<code>issuer</code>", "none"]]) +
      h2("Other") +
      table(["Export"], [["<code>b</code>"]]);
    const r = checkExports(html, read(["a", "T"]), "core", ["Mine"]);
    expect(r.failures).toEqual([]);
    expect(r.counts.rows).toBe(2);
  });

  it("fails on a heading that the page lacks, and on no export", () => {
    expect(checkExports("<p></p>", read(["a"]), "core", ["Exports"]).failures).toEqual([
      "core page has no heading Exports",
      "core export a is not in its exports table",
    ]);
    expect(checkExports("", read([]), "core", []).failures).toContain("read 0 exports");
  });

  it("takes the read of readExports, so an export * in the source fails the check", () => {
    const r = checkExports(
      h2("Exports") + table(["Export"], [["<code>ok</code>"]]),
      readExports('export const ok = 1;\nexport * from "./more.js";', "src/index.ts"),
      "core",
      ["Exports"],
    );
    expect(r.failures).toHaveLength(1);
  });
});
