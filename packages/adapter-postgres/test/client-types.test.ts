import type { Sql as Sql3 } from "postgres";
import type { Sql as Sql4 } from "postgres-4";
import { describe, expect, it } from "vitest";
import type { PostgresClient } from "../src/client.js";

/** Compiles only when `T` fits the client type of the package. The typecheck is the test. */
const fits = <_T extends PostgresClient>(): true => true;

// The peer range is `^3.4.9 || ^4.1.1`. The `Sql` types of the two majors do
// not fit each other, so the public type of the package names neither. A new
// call of the source on a member that one major lacks fails the typecheck here.
describe("PostgresClient", () => {
  it("takes the client of postgres 3.4.9 and of postgres 4.1.1", () => {
    expect([fits<Sql3>(), fits<Sql4>()]).toEqual([true, true]);
  });

  it("refuses an object with no begin", () => {
    // @ts-expect-error a connection alone is not a client: `begin` is missing.
    expect(fits<{ unsafe: Sql3["unsafe"] }>()).toBe(true);
  });
});
