import { afterAll } from "vitest";
import { dropLiveDatabases } from "./pg.js";

// A test that times out never reaches its own drop, so its Postgres
// database stays on the server. This afterAll drops it at the end of the file.
afterAll(dropLiveDatabases);
