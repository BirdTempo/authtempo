import { openDriver } from "./support/drivers.js";
import { runSqliteSuites } from "./support/suite.js";

// A new database file in a new temp folder for each test.
runSqliteSuites("libsql file", async () => openDriver("libsql-file"));
