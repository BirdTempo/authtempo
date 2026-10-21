import { createClient } from "@libsql/client/web";
import { afterAll } from "vitest";
import { libsql } from "../src/libsql.js";
import { runSqliteSuites } from "./support/suite.js";

// The libSQL server of docker-compose.yml (service libsql, port 8089). Each
// test fails, never skips, when the server does not answer.
const URL_ = process.env.AUTHTEMPO_LIBSQL_URL ?? "http://127.0.0.1:8089";
const START = "run: docker compose up -d libsql";

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
