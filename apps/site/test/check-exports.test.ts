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

describe("checkExports", () => {
  it("fails closed on an export line that the reader could not read", () => {
    const r = checkExports(
      "<code>a</code>",
      read(["a"], ["x.ts:2: cannot read the export: export =  foo;"]),
      "core",
      new Set(["a"]),
    );
    expect(r.failures).toEqual(["x.ts:2: cannot read the export: export =  foo;"]);
  });

  it("passes when each name is a code span on the page", () => {
    const r = checkExports(
      "<p><code>createAuth</code> and <code>AuthConfig</code></p>",
      read(["createAuth", "AuthConfig"]),
      "core",
      new Set(["createAuth", "AuthConfig"]),
    );
    expect(r.failures).toEqual([]);
    expect(r.counts).toEqual({ exports: 2, found: 2, rows: 0 });
  });

  it("refuses a name that the page does not show in a code span", () => {
    const r = checkExports(
      "<p>createAuth</p>",
      read(["createAuth"]),
      "core",
      new Set(["createAuth"]),
    );
    expect(r.failures).toEqual(["core export createAuth is not on the page"]);
  });

  it("fails when it reads no export", () => {
    expect(checkExports("", read([]), "core", new Set()).failures).toEqual(["read 0 exports"]);
  });

  it("takes the read of readExports, so an export * in the source fails the check", () => {
    const r = checkExports(
      "<code>ok</code>",
      readExports('export const ok = 1;\nexport * from "./more.js";', "src/index.ts"),
      "core",
      new Set(["ok"]),
    );
    expect(r.failures).toHaveLength(1);
  });
});

/** A built table: a header row of `heads`, and one body row per entry of `rows`. */
function table(heads: string[], rows: string[][]): string {
  const th = heads.map((h) => `<th>${h}</th>`).join("");
  const body = rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("");
  return `<table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>`;
}

describe("checkExports, the page side (plan 11d Task 15 review, M2)", () => {
  it("refuses an export row that names no export of the page", () => {
    const html = table(
      ["Export", "What it is"],
      [
        ["<code>createAuth</code>", "Makes it."],
        ['<code dir="auto">gone</code>', "Old."],
      ],
    );
    const r = checkExports(html, read(["createAuth"]), "core", new Set(["createAuth"]));
    expect(r.failures).toEqual(["core page row gone names no export of the page"]);
    expect(r.counts).toEqual({ exports: 1, found: 1, rows: 2 });
  });

  it("reads the Exports and Types columns too, and every code span of a cell", () => {
    const html =
      table(["Entry", "Exports"], [["<code>@x/a</code>", "<code>a</code>, <code>b</code>"]]) +
      table(["Area", "Types"], [["Sessions", "<code>T</code>, <code>U</code>"]]);
    const r = checkExports(html, read(["a"]), "core", new Set(["a", "b", "T"]));
    expect(r.failures).toEqual(["core page row U names no export of the page"]);
  });

  it("takes the names of every entry of a shared page, and skips the other tables", () => {
    const html =
      table(["Export", "What it is"], [["<code>a</code>, <code>other</code>", "Two entries."]]) +
      table(["Option", "Default"], [["<code>issuer</code>", "required"]]);
    const r = checkExports(html, read(["a"]), "core", new Set(["a", "other"]));
    expect(r.failures).toEqual([]);
    expect(r.counts.rows).toBe(2);
  });
});
