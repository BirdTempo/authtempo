import { createSqliteAdapter } from "@authtempo/adapter-sqlite";
import { libsql } from "@authtempo/adapter-sqlite/libsql";
import { createClient } from "@libsql/client/web";
import { expect, it } from "vitest";

it("loads the libsql entry with @libsql/client/web in workerd", () => {
  // The adapter sends no statement before its first call, so no request leaves the test.
  const driver = libsql(createClient({ url: "http://127.0.0.1:1" }));
  expect(driver.name).toBe("libsql");
  const adapter = createSqliteAdapter(driver);
  expect(typeof adapter.findOne).toBe("function");
  expect(typeof adapter.transaction).toBe("function");
});
