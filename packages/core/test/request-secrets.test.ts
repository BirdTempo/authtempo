import { afterEach, describe, expect, it, vi } from "vitest";
import { createConnection } from "../src/engine/sso/connections.js";
import { createRouter } from "../src/http/router.js";
import { coreRoutes } from "../src/http/routes/index.js";
import { passwordsOf } from "../src/http/routes/scim.js";
import { type Observer, withSecrets } from "../src/observe/observer.js";
import type { AuthEvent } from "../src/observe/port.js";
import { BASE_URL, makeAuth } from "./helpers.js";
import { scimAuth, scimToken } from "./scim/helpers.js";
import { SSO_APP, seedOrganization } from "./sso/helpers.js";
import { samlWorld } from "./sso/saml-helpers.js";
import { acmeWithSso, ssoSignIn, ssoSignInWorld } from "./sso/sign-in-helpers.js";

// The secrets of one request body of plan 12d, in the scrub of the observer
// of plan 12h (ruling 64 of plan 12d): a SCIM password and token, the OIDC
// client secret, and the bearer values of a SAML post.

afterEach(() => {
  vi.restoreAllMocks();
});

/** A recording sink. */
function recording() {
  const batches: AuthEvent[][] = [];
  return {
    events: () => batches.flat(),
    sink: { write: (b: readonly AuthEvent[]) => void batches.push([...b]) },
  };
}

/** `config` with an observer that records the values of each `secrets` call. */
function spied<C extends { observe: Observer }>(config: C) {
  const seen: string[][] = [];
  const wrap = (o: Observer): Observer => ({
    emit: (e) => o.emit(e),
    scope: (s) => wrap(o.scope(s)),
    unscoped: () => wrap(o.unscoped()),
    secrets: (values) => {
      seen.push([...values]);
      return wrap(o.secrets(values));
    },
    flush: () => o.flush(),
    stats: () => o.stats(),
  });
  return { config: { ...config, observe: wrap(config.observe) }, seen };
}

const PASSWORD = "Pw-scim-0123456789abcdef";

describe("the secrets of one request (plan 12d on 12h)", () => {
  it("scrubs a value of the request from each string field, with a sink and with none", async () => {
    const r = recording();
    const auth = makeAuth({ observe: { sink: r.sink } });
    const scrubbing = withSecrets(auth.config, [PASSWORD, null, ""]);
    scrubbing.observe.emit({ name: "sso.denied", connectionId: PASSWORD });
    auth.config.observe.emit({ name: "sso.denied", connectionId: "c1" });
    await auth.config.observe.flush();
    expect(r.events().map((e) => e.connectionId)).toEqual(["***", "c1"]);
    // With no value left, the config stays the same object.
    expect(withSecrets(auth.config, [null, undefined, ""])).toBe(auth.config);
    // The default output scrubs its line too.
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const plain = makeAuth();
    withSecrets(plain.config, [PASSWORD]).observe.emit({
      name: "sso.denied",
      connectionId: PASSWORD,
    });
    expect(log.mock.calls).toEqual([["authtempo: sso denied", "***"]]);
  });

  it("reads each password of a SCIM body", () => {
    expect(
      passwordsOf({
        userName: "ada",
        password: "a-1",
        Operations: [
          { op: "replace", path: "password", value: "a-2" },
          { op: "add", value: { password: "a-3", nickName: "x" } },
          { op: "replace", path: "nickName", value: "not a password" },
        ],
      }).sort(),
    ).toEqual(["a-1", "a-2", "a-3"]);
  });

  it("scrubs the bearer token and each password of a SCIM request", async () => {
    const w = await scimAuth();
    const { token } = await scimToken(w);
    const s = spied(w.config);
    const handle = createRouter(s.config, coreRoutes(s.config));
    const res = await handle(
      new Request(`${BASE_URL}/auth/scim/v2/Users`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/scim+json" },
        body: JSON.stringify({
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
          userName: "ada@acme.example",
          password: PASSWORD,
        }),
      }),
    );
    expect(res.status).toBe(201);
    expect(s.seen).toEqual([[token], [PASSWORD]]);
  });

  it("scrubs the client secret of a connection create", async () => {
    const w = ssoSignInWorld();
    const organizationId = await seedOrganization(w, "acme");
    const s = spied(w.config);
    const made = await createConnection(s.config, SSO_APP, {
      organizationId,
      kind: "oidc",
      label: "Acme IdP",
      issuer: "https://login.acme-idp.example/v2.0",
      clientId: "acme-client",
      clientSecret: "acme-secret-0123456789",
    });
    expect(made.ok).toBe(true);
    expect(s.seen).toEqual([["acme-secret-0123456789"]]);
  });

  it("scrubs the opened client secret in the OIDC callback", async () => {
    const w = ssoSignInWorld();
    const { connectionId } = await acmeWithSso(w);
    const s = spied(w.config);
    const r = await ssoSignIn(
      { ...w, handle: createRouter(s.config, coreRoutes(s.config)) },
      connectionId,
      "acme",
      { sub: "ada-1", email: "ada@acme.example", email_verified: true },
    );
    expect(r.token).not.toBeNull();
    // oidcConnection gives the secret `<slug>-secret-0123456789`.
    expect(s.seen).toEqual([["acme-secret-0123456789"]]);
  });

  it("scrubs the SAMLResponse and the RelayState of an ACS post", async () => {
    const r = recording();
    const w = samlWorld({ observe: { sink: r.sink } });
    // A RelayState that is also the connection id of the path: its event field is the secret.
    const relay = "rs0123456789abcdef";
    const res = await w.handle(
      new Request(`${BASE_URL}/auth/sso/${relay}/acs`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `SAMLResponse=PHg%2B&RelayState=${relay}`,
      }),
    );
    expect(res.headers.get("location")).toContain("auth_error=sso_failed");
    await w.config.observe.flush();
    const failed = r.events().filter((e) => e.name === "sso.failed");
    expect(failed.map((e) => [e.connectionId, e.step])).toEqual([["***", "request"]]);
  });
});
