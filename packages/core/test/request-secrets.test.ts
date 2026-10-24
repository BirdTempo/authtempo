import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig } from "../src/config.js";
import { scimJson } from "../src/engine/scim/answer.js";
import { createConnection } from "../src/engine/sso/connections.js";
import { createRouter } from "../src/http/router.js";
import { coreRoutes } from "../src/http/routes/index.js";
import { passwordsOf, scimRoute } from "../src/http/routes/scim.js";
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

/** An app hook that throws an error with the name `name`: an error name is an event field. */
function namedThrow(name: string) {
  return () => {
    const e = new Error("the app refuses");
    e.name = name;
    throw e;
  };
}

/** The input of an OIDC connection of `organizationId` with the client secret `secret`. */
const connectionInput = (organizationId: string, secret: string) => ({
  organizationId,
  kind: "oidc" as const,
  label: "Acme IdP",
  issuer: "https://login.acme-idp.example/v2.0",
  clientId: "acme-client",
  clientSecret: secret,
});

/**
 * Runs `run` with a recording sink, then with no observe (the default
 * lines). It answers the events and the error lines. Neither holds a value
 * of `secrets`, the values that the run answers.
 */
async function bothWays(
  run: (observe: AuthConfig["observe"] | undefined) => Promise<unknown>,
  secrets: (answer: string) => string[],
): Promise<{ sink: AuthEvent[]; lines: unknown[][] }> {
  const r = recording();
  const first = await run({ sink: r.sink });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const second = await run(undefined);
  const lines = log.mock.calls.map((c) => [...c]);
  log.mockRestore();
  const values = [...secrets(String(first ?? "")), ...secrets(String(second ?? ""))];
  for (const value of values) {
    expect(JSON.stringify(r.events())).not.toContain(value);
    expect(JSON.stringify(lines)).not.toContain(value);
  }
  return { sink: r.events(), lines };
}

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

  it("adds the bearer token and each password of a SCIM body to the scrub", async () => {
    const w = await scimAuth();
    const { token } = await scimToken(w);
    const s = spied(w.config);
    const res = await createRouter(
      s.config,
      coreRoutes(s.config),
    )(
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

  it("keeps the bearer token and each password of a SCIM body from a sink and a line", async () => {
    // A handler that emits both values: each event of the request scrubs them.
    const run = async (observe: AuthConfig["observe"] | undefined) => {
      const v = await scimAuth(observe ? { observe } : {});
      const t = (await scimToken(v)).token;
      const probe = scimRoute({
        method: "POST",
        path: "/scim/v2/Probe",
        // A test stub of a path outside ROUTES has no key (ruling 3 of plan 12d).
        key: undefined as never,
        scope: "scim.users.write",
        body: true,
        async handle(ctx, _caller, body) {
          for (const value of [t, (body as { password: string }).password])
            ctx.config.observe.emit({ name: "sso.denied", connectionId: value });
          return scimJson({ ok: true });
        },
      });
      const answer = await createRouter(v.config, [probe])(
        new Request(`${BASE_URL}/auth/scim/v2/Probe`, {
          method: "POST",
          headers: { authorization: `Bearer ${t}`, "content-type": "application/scim+json" },
          body: JSON.stringify({ password: PASSWORD }),
        }),
      );
      expect(answer.status).toBe(200);
      await v.config.observe.flush();
      return t;
    };
    const kept = await bothWays(run, (t) => [t, PASSWORD]);
    expect(kept.sink.filter((e) => e.name === "sso.denied").map((e) => e.connectionId)).toEqual([
      "***",
      "***",
    ]);
    expect(kept.lines).toEqual([
      ["authtempo: sso denied", "***"],
      ["authtempo: sso denied", "***"],
    ]);
  });

  it("adds the client secret of a connection create to the scrub", async () => {
    const secret = "AcmeClientSecretError";
    const w = ssoSignInWorld();
    const organizationId = await seedOrganization(w, "acme");
    const s = spied(w.config);
    const made = await createConnection(s.config, SSO_APP, connectionInput(organizationId, secret));
    expect(made.ok).toBe(true);
    expect(s.seen).toEqual([[secret]]);
  });

  it("keeps the client secret of a connection create from a sink and a line", async () => {
    // Letters that end in Error: the error name kind keeps such a value, so a field holds it.
    const secret = "AcmeClientSecretError";
    // An after hook that throws an error named as the secret: its event field is the secret.
    const run = async (observe: AuthConfig["observe"] | undefined) => {
      const v = ssoSignInWorld({
        ...(observe ? { observe } : {}),
        operator: { users: true },
        hooks: { operator: { afterAction: namedThrow(secret) } },
      });
      const org = await seedOrganization(v, "acme");
      expect((await createConnection(v.config, SSO_APP, connectionInput(org, secret))).ok).toBe(
        true,
      );
      await v.config.observe.flush();
    };
    const kept = await bothWays(run, () => [secret]);
    expect(kept.sink.filter((e) => e.name === "hook.after_failed").map((e) => e.errorName)).toEqual(
      ["***"],
    );
    expect(kept.lines.map((l) => [l[0], l[1], l[3]])).toEqual([
      ["authtempo: after hook failed", "operator.afterAction", "***"],
    ]);
  });

  it("adds the opened client secret of an OIDC callback to the scrub", async () => {
    const secret = "AcmeOidcClientSecretError";
    const w = ssoSignInWorld();
    const { connectionId } = await acmeWithSso(w, { clientSecret: secret });
    const s = spied(w.config);
    const r = await ssoSignIn(
      { ...w, handle: createRouter(s.config, coreRoutes(s.config)) },
      connectionId,
      "acme",
      { sub: "ada-1", email: "ada@acme.example", email_verified: true },
    );
    expect(r.token).not.toBeNull();
    // The callback adds the opened value; the create ran on the config with no spy.
    expect(s.seen).toEqual([[secret]]);
  });

  it("keeps the opened client secret of an OIDC callback from a sink and a line", async () => {
    // Letters that end in Error: the error name kind keeps such a value, so a field holds it.
    const secret = "AcmeOidcClientSecretError";
    // A before hook of the sign-in that throws an error named as the secret.
    const run = async (observe: AuthConfig["observe"] | undefined) => {
      const v = ssoSignInWorld({
        ...(observe ? { observe } : {}),
        hooks: { sso: { beforeSignIn: namedThrow(secret) } },
      });
      const c = await acmeWithSso(v, { clientSecret: secret });
      const answer = await ssoSignIn(v, c.connectionId, "acme", {
        sub: "ada-1",
        email: "ada@acme.example",
        email_verified: true,
      });
      expect(answer.token).toBeNull();
      await v.config.observe.flush();
    };
    const kept = await bothWays(run, () => [secret]);
    expect(
      kept.sink.filter((e) => e.name === "hook.before_failed").map((e) => e.errorName),
    ).toEqual(["***"]);
    // The refused resolution writes its own line too, with the code of the hook failure.
    expect(kept.lines.map((l) => l.slice(0, 3))).toEqual([
      ["authtempo: before hook failed", "sso.beforeSignIn", "***"],
      ["authtempo: sso refused", expect.any(String), "hook_failed"],
    ]);
  });

  it("keeps the SAMLResponse and the RelayState of an ACS post from a sink and a line", async () => {
    // A RelayState that is also the connection id of the path: its event field is the secret.
    const relay = "rs0123456789abcdef";
    const run = async (observe: AuthConfig["observe"] | undefined) => {
      const v = samlWorld(observe ? { observe } : {});
      const res = await v.handle(
        new Request(`${BASE_URL}/auth/sso/${relay}/acs`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: `SAMLResponse=PHg%2B&RelayState=${relay}`,
        }),
      );
      expect(res.headers.get("location")).toContain("auth_error=sso_failed");
      await v.config.observe.flush();
    };
    const kept = await bothWays(run, () => [relay]);
    const failed = kept.sink.filter((e) => e.name === "sso.failed");
    expect(failed.map((e) => [e.connectionId, e.step])).toEqual([["***", "request"]]);
    expect(kept.lines).toEqual([["authtempo: sso failed", "***", "request"]]);
  });
});
