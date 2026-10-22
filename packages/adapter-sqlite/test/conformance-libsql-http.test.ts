import { createClient } from "@libsql/client/web";
import { afterAll } from "vitest";
import { libsql } from "../src/libsql.js";
import { runSqliteSuites } from "./support/suite.js";

/** The address of a test server: `node scripts/test-servers.mjs up` writes it, and `pnpm test` passes it. */
function serverUrl(name: string): string {
  const url = process.env[name];
  if (url === undefined || url === "")
    throw new Error(
      `${name} is not set. Run: node scripts/test-servers.mjs up (pnpm test runs it for you)`,
    );
  return url;
}

// The libSQL server of the slot of this worktree (service libsql). Each
// test fails, never skips, when the server does not answer.
const URL_ = serverUrl("AUTHTEMPO_LIBSQL_URL");
const START = "run: node scripts/test-servers.mjs up";

const client = createClient({ url: URL_ });

let health: Promise<void> | null = null;
/** Reads /health once. A failed read fails each test that opens the database. */
function serverAnswers(): Promise<void> {
  health ??= (async () => {
    const res = await fetch(new URL("/health", URL_)).catch((e: unknown) => {
      throw new Error(`the libSQL server at ${URL_} does not answer; ${START}`, { cause: e });
    });
    if (!res.ok) throw new Error(`the libSQL server at ${URL_} answers ${res.status}; ${START}`);
  })();
  return health;
}

afterAll(() => client.close());

// One server holds one database: the suites migrate it once and empty it before each test.
runSqliteSuites(
  "libsql http",
  async () => {
    await serverAnswers();
    return {
      driver: libsql(client),
      close: () => {
        // The client lives for the whole file.
      },
    };
  },
  { shared: true },
);
