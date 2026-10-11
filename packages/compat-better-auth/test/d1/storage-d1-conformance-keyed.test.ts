import { applyD1Migrations, env } from "cloudflare:test";
import { BETTER_AUTH_SQLITE } from "../fixtures.js";
import { d1MappingSuite } from "./mapping-suite.js";
import { execD1 } from "./schema.js";

// Core's conformance suite and the D1 mapping tests on Better Auth's own
// SQLite SQL as recorded, with its seven foreign keys (plan 9b: every suite
// creates each parent row first). A test that writes a child row with no
// parent fails here on the key, so no test seeds a state the product cannot
// reach.
await execD1(BETTER_AUTH_SQLITE);
await applyD1Migrations(env.DB, env.COMPAT_MIGRATIONS);

d1MappingSuite("Better Auth's own SQLite SQL, with the foreign keys", {});
