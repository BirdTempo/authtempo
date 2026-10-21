import { openDriver } from "./support/drivers.js";
import { runSqliteSuites } from "./support/suite.js";

// A new `:memory:` database for each test.
runSqliteSuites("node:sqlite", async () => openDriver("node"));
