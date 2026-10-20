import { type Auth, createAuth } from "@authtempo/core";
import { exampleConfig, exampleWorker, lastMailedLink } from "./app.js";
import { conformanceConfig, conformanceOn, seedConformance } from "./conformance.js";

// The entry of the conformance mode (plan 12e Task 17, ruling 53). Only
// wrangler.conformance.jsonc names it, so the deployed bundle of wrangler.jsonc
// holds none of this code. It serves nothing unless CONFORMANCE_MODE is "1".

let auth: Auth | null = null;
let seeded: Promise<void> | null = null;

function conformanceAuth(env: Env): Auth {
  auth ??= createAuth({
    ...exampleConfig(env),
    ...conformanceConfig(env.BASE_URL, (input, init) => fetch(input, init)),
  });
  return auth;
}

/**
 * The test user and the two clients, once per isolate. A failed seed logs
 * one line and is dropped, so the next request tries again.
 */
function seedOnce(env: Env, a: Auth): Promise<void> {
  if (!conformanceOn(env))
    return Promise.reject(new Error("the conformance entry needs CONFORMANCE_MODE set to 1"));
  const password = env.CONFORMANCE_PASSWORD;
  if (!password)
    return Promise.reject(new Error("the conformance mode needs CONFORMANCE_PASSWORD"));
  seeded ??= seedConformance(a, password, lastMailedLink).catch((e: unknown) => {
    seeded = null;
    console.error("conformance: the seed failed:", e instanceof Error ? e.message : String(e));
    throw e;
  });
  return seeded;
}

export default exampleWorker(conformanceAuth, seedOnce);
