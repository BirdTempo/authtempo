import { runSecretRotationConformance } from "@authtempo/core/conformance";
import { createPostgresAdapter } from "../src/index.js";
import { freshDatabase } from "./db.js";

// Plan 12b: the two-phase rotation through the Postgres adapter.
runSecretRotationConformance("postgres", async () => {
  const db = await freshDatabase();
  return { adapter: createPostgresAdapter(db.sql), close: () => db.close() };
});
