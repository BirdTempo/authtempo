import { openDriver } from "./support/drivers.js";
import { runSqliteSuites } from "./support/suite.js";

// A new `:memory:` database for each test. The limiter suite sends the D1
// limiter's `?1`, `?2`, `?3` text. This driver takes that text only as an
// object bind (ruling 1 of plan 12g, N3).
runSqliteSuites("better-sqlite3", async () => openDriver("better-sqlite3"));
