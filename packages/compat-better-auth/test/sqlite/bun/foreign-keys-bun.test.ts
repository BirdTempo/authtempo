// @ts-expect-error: bun:sqlite has its types in @types/bun, which this package does not take.
import { Database } from "bun:sqlite";
import { bunSqlite } from "@authtempo/adapter-sqlite/bun";
import { foreignKeysSuite } from "../keys-suite.js";

// The foreign key tests of the bun:sqlite run (rulings 40 and 44 of plan 12n).
// The suite of mapping-bun.test.ts turns the keys on itself. bun:sqlite opens
// with the keys off, so these tests open each file as an app does, with no pragma.
foreignKeysSuite("bun:sqlite", {
  open: async (file) => {
    const db = new Database(file);
    return {
      driver: bunSqlite(db),
      exec: async (text) => {
        db.run(text);
      },
      close: () => db.close(),
    };
  },
  oneConnection: true,
});
