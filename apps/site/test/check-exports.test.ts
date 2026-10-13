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

describe("checkExports", () => {
  it("fails closed on an export line that the reader could not read", () => {
    const r = checkExports("<code>a</code>", ["a"], "core", [
      "x.ts:2: cannot read the export: export =  foo;",
    ]);
    expect(r.failures).toEqual(["x.ts:2: cannot read the export: export =  foo;"]);
  });

  it("passes when each name is a code span on the page", () => {
    const r = checkExports(
      "<p><code>createAuth</code> and <code>AuthConfig</code></p>",
      ["createAuth", "AuthConfig"],
      "core",
    );
    expect(r.failures).toEqual([]);
    expect(r.counts).toEqual({ exports: 2, found: 2 });
  });

  it("refuses a name that the page does not show in a code span", () => {
    const r = checkExports("<p>createAuth</p>", ["createAuth"], "core");
    expect(r.failures).toEqual(["core export createAuth is not on the page"]);
  });

  it("fails when it reads no export", () => {
    expect(checkExports("", [], "core").failures).toEqual(["read 0 exports"]);
  });
});
