import { runPhoneCapConformance } from "@authtempo/core/limiter-conformance";
import { createPostgresAdapter, createPostgresLimiter } from "../src/index.js";
import { freshDatabase } from "./db.js";

// The phone code's daily cap on real Postgres (plan 12i Task 4, Review
// Focus 3). The client has four connections, so the 40 parallel sends race
// on four sessions, and the row lock of the limiter's one statement is the
// guard.
runPhoneCapConformance("postgres", async () => {
  const db = await freshDatabase();
  return {
    limiter: createPostgresLimiter(db.sql),
    storage: createPostgresAdapter(db.sql),
    close: () => db.close(),
  };
});
