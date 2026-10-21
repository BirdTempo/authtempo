// The Worker of the bundle proof (plan 12g Task 4). It imports the libSQL
// entry, the Workers client of libSQL, and the adapter, as an app on Workers
// does. proof/bundle.mjs bundles it with Node.js compatibility off.
import { createSqliteAdapter } from "@authtempo/adapter-sqlite";
import { libsql } from "@authtempo/adapter-sqlite/libsql";
import { createClient } from "@libsql/client/web";

export default {
  async fetch(): Promise<Response> {
    // No request reaches this Worker: it is only bundled. The URL is never called.
    const driver = libsql(createClient({ url: "https://127.0.0.1:1" }));
    return new Response(typeof createSqliteAdapter(driver).findOne);
  },
};
