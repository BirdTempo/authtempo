import { join } from "node:path";
import { createClient } from "@libsql/client";
import { describe, expect, it } from "vitest";
import { retryBusy } from "../src/busy.js";
import { tempFolder } from "./support/drivers.js";

describe("the libSQL wait for the write lock (ruling 5 of plan 12g)", () => {
  it("passes SQLITE_BUSY through unchanged at the cap", async () => {
    const folder = tempFolder();
    const url = `file:${join(folder.dir, "busy.sqlite")}`;
    const holder = createClient({ url });
    const other = createClient({ url });
    try {
      await holder.execute("CREATE TABLE t (a INTEGER)");
      const held = await holder.transaction("write");
      let tries = 0;
      const start = Date.now();
      const err = await retryBusy(
        () => {
          tries++;
          return other.transaction("write");
        },
        200,
        20,
      ).catch((e: unknown) => e);
      expect(Date.now() - start).toBeGreaterThanOrEqual(200);
      expect(tries).toBeGreaterThan(1);
      expect(err).toMatchObject({ code: "SQLITE_BUSY" });
      expect(err).not.toMatchObject({ name: "StorageError" });
      held.close();
    } finally {
      holder.close();
      other.close();
      folder.remove();
    }
  });
});
