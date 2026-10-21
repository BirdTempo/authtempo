import { createMysqlAdapter } from "@authtempo/adapter-mysql";
import { createPool } from "mysql2/promise";

// The bundle proof of the MySQL adapter (plan 12g, Task 5). The Worker
// builds a pool as an app on Hyperdrive does, with `disableEval: true`.
// Hyperdrive says: "Required to enable mysql2 compatibility for Workers".
// No query runs.
export default {
  async fetch(): Promise<Response> {
    const pool = createPool({ host: "127.0.0.1", port: 1, user: "app", disableEval: true });
    const adapter = createMysqlAdapter(pool);
    return new Response(typeof adapter.findOne);
  },
};
