import { createAuth, type JwtSeam } from "@authtempo/core";
import { ID_TOKEN_PROVIDERS } from "@authtempo/core/compat";
import { describe, expect, it } from "vitest";
import { createHandler } from "../src/server/better-auth.js";
import { mapOptions } from "../src/server/map-options.js";
import { betterAuthTables, browser, json, signInOptions } from "./sign-in-helpers.js";

// Plan 12n decision 18: the shim takes its list of ID-token providers from
// core's compat entry, so the two lists cannot drift. Each name of core's
// list reaches core's own route through `/sign-in/social`. Any other name
// answers 501, with a text built from core's list.

/** A verifier that knows no token: core's route answers INVALID_TOKEN, so the call reached it. */
const NO_TOKEN: JwtSeam = {
  async verifyIdToken() {
    throw new Error("bad token");
  },
  async signES256() {
    throw new Error("not used");
  },
};

describe("the ID-token providers of /sign-in/social (plan 12n decision 18)", () => {
  it("sends each provider of core's list to core's route, and answers 501 for any other", async () => {
    const t = await betterAuthTables();
    const mapped = mapOptions(
      signInOptions(t.database, {
        socialProviders: {
          google: { clientId: "g-client", clientSecret: "g-secret" },
          apple: { clientId: "com.x.web", teamId: "T", keyId: "K", privateKey: "P" },
          github: { clientId: "h-client", clientSecret: "h-secret" },
        },
      }),
    );
    const { send } = browser(
      createHandler(createAuth({ ...mapped.config, jwt: NO_TOKEN }), mapped),
    );
    expect(ID_TOKEN_PROVIDERS.length).toBeGreaterThan(0);
    for (const provider of ID_TOKEN_PROVIDERS) {
      const res = await send("/sign-in/social", { provider, idToken: { token: "x.y.z" } });
      expect([provider, res.status, (await json(res)).code]).toEqual([
        provider,
        400,
        "INVALID_TOKEN",
      ]);
    }
    const github = await send("/sign-in/social", {
      provider: "github",
      idToken: { token: "x.y.z" },
    });
    expect([github.status, await json(github)]).toEqual([
      501,
      { code: "NOT_SUPPORTED", message: "core takes an ID token of google and apple only" },
    ]);
  });
});
