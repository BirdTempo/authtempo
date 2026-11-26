import { describe, expect, it } from "vitest";
import { DRIVER, PG_URL, postgres } from "./pg.js";

/**
 * The proof that a run has the driver major it names. `pnpm test` runs the
 * Postgres tests on 3.4.9 and then on 4.1.1. An env value that does not
 * reach the tests gives two runs on one major, and both look like a pass.
 * The count reporter of each vitest config fails a run that has no suite of
 * this name.
 */
describe(`postgres driver: ${DRIVER}`, () => {
  it("is the major that TEMPO_AUTH_PG_DRIVER names", async () => {
    const sql = postgres(PG_URL, { max: 1, onnotice: () => {} });
    try {
      // 4.0.0 removed `sql.array`: a call throws ARRAY_REMOVED. 3.4.9 has it.
      let array: string;
      try {
        (sql as unknown as { array(v: number[]): unknown }).array([1]);
        array = "kept";
      } catch (e) {
        array = (e as { code?: string }).code ?? "no code";
      }
      // 4.1.0 added `sql.identifier`. 3.4.9 has no such key.
      const identifier = typeof (sql as unknown as { identifier?: unknown }).identifier;
      expect({ array, identifier }).toEqual(
        DRIVER === "3"
          ? { array: "kept", identifier: "undefined" }
          : { array: "ARRAY_REMOVED", identifier: "function" },
      );
      // The client of this run answers a query.
      const rows = await sql<{ n: number }[]>`SELECT 1 AS n`;
      expect(rows[0]?.n).toBe(1);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});
