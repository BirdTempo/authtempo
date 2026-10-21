import {
  BetterAuthCompatError,
  betterAuthSchemaStorage,
  type D1DatabaseLike,
  moveBetterAuthApiKeys,
  movedKeyPrefixesOf,
} from "../../../src/index.js";
import { ac, authOptions, keys } from "./auth.js";

/**
 * Steps 1 and 5 of the key cutover on D1: a Worker with the app's D1 binding
 * `DB`. `POST /move` runs a dry run, and `POST /move?dryRun=false` moves.
 * Put it behind a check that only an operator passes, and delete it after
 * the move.
 */
export default {
  async fetch(request: Request, env: { DB: D1DatabaseLike }): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/move")
      return new Response(null, { status: 404 });
    const storage = betterAuthSchemaStorage({ dialect: "d1", db: env.DB });
    try {
      const report = await moveBetterAuthApiKeys(storage, {
        names: storage.names,
        references: keys.references ?? "user",
        dryRun: url.searchParams.get("dryRun") !== "false",
        movedPrefixes: movedKeyPrefixesOf(authOptions(env)),
        rateLimitEnabled: keys.rateLimit?.enabled ?? true,
        statements: ac.statements,
      });
      return Response.json(report);
    } catch (error) {
      // A stored prefix outside the list, or a row with no prefix: nothing moved.
      if (error instanceof BetterAuthCompatError)
        return Response.json({ refusals: error.refusals }, { status: 409 });
      throw error;
    }
  },
};
