import { runRefreshRaceConformance } from "@authtempo/core/conformance";
import { createPostgresAdapter } from "../src/index.js";
import { freshDatabase } from "./db.js";

// Ruling 40 of plan 12e: a detected refresh reuse leaves no live row on Postgres.
runRefreshRaceConformance("postgres", async () => {
  const db = await freshDatabase();
  return { adapter: createPostgresAdapter(db.sql), close: () => db.close() };
});
