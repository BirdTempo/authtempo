import { describe, expect, it } from "vitest";
import { checkExports, exportNames } from "../scripts/check-exports.ts";

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

describe("checkExports", () => {
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
