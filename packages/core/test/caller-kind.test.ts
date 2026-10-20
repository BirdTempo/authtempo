import { describe, expect, expectTypeOf, it } from "vitest";
import type { Caller } from "../src/engine/tokens.js";

/**
 * The kinds of a caller (spec 5): an app that switches over `Caller.kind`
 * must handle each kind, or it fails to compile. A new kind then fails the
 * typecheck of `kindName` until it has a case. The union is closed, so the
 * `@ts-expect-error` below holds too.
 */

function kindName(c: Caller): string {
  switch (c.kind) {
    case "session":
      return "a person with a session";
    case "token":
      return "a script with an API token";
    case "organizationToken":
      return "a script of an organization (plan 12k)";
    case "oauth":
      return "an OAuth client for a person";
    case "oauth-client":
      return "an OAuth client for itself";
    default: {
      const unreached: never = c;
      return unreached;
    }
  }
}

function missesOne(c: Caller): string {
  switch (c.kind) {
    case "session":
    case "token":
    case "organizationToken":
    case "oauth":
      return c.kind;
    default: {
      // @ts-expect-error: the oauth-client kind has no case, so c is not never here.
      const unreached: never = c;
      return unreached;
    }
  }
}

describe("the kinds of a caller (spec 5)", () => {
  it("has five kinds, and an exhaustive switch names each", () => {
    expectTypeOf<Caller["kind"]>().toEqualTypeOf<
      "session" | "token" | "organizationToken" | "oauth" | "oauth-client"
    >();
    expect(kindName({ kind: "oauth-client" } as Caller)).toBe("an OAuth client for itself");
    expect(missesOne({ kind: "token" } as Caller)).toBe("token");
  });
});
