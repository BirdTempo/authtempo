import { describe, expect, it } from "vitest";
import { DEVICE_GRANT } from "../src/engine/oauth-device.js";
import { fromBase64Url } from "../src/primitives/crypto.js";
import { BASE_URL, get, post } from "./helpers.js";
import {
  approvedDevice,
  authorizeParams,
  basicHeader,
  codeFor,
  type Handle,
  ISSUER,
  OTHER_RESOURCE,
  oauthHandle,
  pkce,
  REDIRECT,
  RESOURCE,
  registered,
  SCOPES,
  signedIn,
  tokenPost,
} from "./oauth-helpers.js";

/**
 * `oauth.defaultResource` (plan 12e ruling 52). With the key, a request
 * that names no resource takes it. Without the key, each rule of plans 9g
 * and 12e holds: such a request answers `invalid_target`.
 */

const dec = new TextDecoder();

/** Two resources, the device grant on, and `OTHER_RESOURCE` as the default when `on`. */
function handle(on: boolean): Handle {
  return oauthHandle({
    oauth: {
      resources: [RESOURCE, OTHER_RESOURCE],
      scopes: SCOPES,
      registration: { cimd: false, dynamic: true },
      device: {},
      ...(on ? { defaultResource: OTHER_RESOURCE } : {}),
    },
  });
}

const audOf = (jwt: string) =>
  (JSON.parse(dec.decode(fromBase64Url(jwt.split(".")[1] ?? ""))) as { aud: unknown }).aud;

/** The code exchange of `c` with no `resource` in the form. */
const exchangeNoResource = (c: { code: string; clientId: string; verifier: string }) =>
  tokenPost({
    grant_type: "authorization_code",
    code: c.code,
    code_verifier: c.verifier,
    client_id: c.clientId,
    redirect_uri: REDIRECT,
  });

async function tokens(res: Response) {
  const body = (await res.json()) as Record<string, string>;
  if (res.status !== 200) throw new Error(`token answered ${res.status} ${body.error}`);
  return body;
}

describe("oauth.defaultResource (plan 12e ruling 52)", () => {
  it("gives an authorize request with no resource the default, and invalid_target without the key", async () => {
    const on = handle(true);
    const c = await codeFor(on, "openid mcp:read", { resource: null, nonce: "n-1" });
    const t = await tokens(await on.auth.handle(exchangeNoResource(c)));
    expect(audOf(t.access_token ?? "")).toBe(OTHER_RESOURCE);
    expect(
      (await on.auth.caller(get("/files/a", { authorization: `Bearer ${t.access_token}` })))?.kind,
    ).toBe("oauth");
    // A named resource still wins over the default.
    const on2 = handle(true);
    const named = await codeFor(on2, "mcp:read", { resource: RESOURCE });
    const n = await tokens(await on2.auth.handle(exchangeNoResource(named)));
    expect(audOf(n.access_token ?? "")).toBe(RESOURCE);

    const off = handle(false);
    await expect(codeFor(off, "mcp:read", { resource: null })).rejects.toThrow(
      /error=invalid_target/,
    );
  });

  it("gives a client_credentials grant with no resource the default, and invalid_target without the key", async () => {
    for (const [on, expected] of [
      [true, { status: 200, aud: OTHER_RESOURCE }],
      [false, { status: 400, error: "invalid_target" }],
    ] as const) {
      const h = handle(on);
      const made = await h.auth.api.oauth?.clients.create({
        name: "Billing service",
        authMethod: "client_secret_basic",
        grantTypes: ["client_credentials"],
        credentialsScopes: ["mcp:read"],
      });
      if (!made?.ok || !made.value.clientSecret) throw new Error("create failed");
      const res = await h.auth.handle(
        tokenPost(
          { grant_type: "client_credentials" },
          { authorization: basicHeader(made.value.client.id, made.value.clientSecret) },
        ),
      );
      const body = (await res.json()) as Record<string, string>;
      expect(
        res.status === 200
          ? { status: res.status, aud: audOf(body.access_token ?? "") }
          : { status: res.status, error: body.error },
      ).toEqual(expected);
    }
  });

  it("gives a device start with no resource the default, and invalid_target without the key", async () => {
    for (const [on, expected] of [
      [true, 200],
      [false, 400],
    ] as const) {
      const h = handle(on);
      const reg = await h.auth.handle(
        post("/auth/oauth/register", {
          redirect_uris: [REDIRECT],
          client_name: "Living room TV",
          grant_types: ["authorization_code", "refresh_token", DEVICE_GRANT],
        }),
      );
      const { client_id } = (await reg.json()) as { client_id: string };
      const res = await h.auth.handle(
        new Request(`${ISSUER}/oauth/device_authorization`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ client_id, scope: "mcp:read" }).toString(),
        }),
      );
      const body = (await res.json()) as Record<string, string>;
      expect({ on, status: res.status, error: body.error ?? null }).toEqual({
        on,
        status: expected,
        error: expected === 200 ? null : "invalid_target",
      });
    }
  });

  it("keeps the resource of the grant at a code exchange and a refresh with no resource, with or without the key", async () => {
    for (const on of [true, false]) {
      const h = handle(on);
      // The code is for RESOURCE; the default, when set, is OTHER_RESOURCE.
      const c = await codeFor(h, "mcp:read offline_access", { resource: RESOURCE });
      const t = await tokens(await h.auth.handle(exchangeNoResource(c)));
      const r = await tokens(
        await h.auth.handle(
          tokenPost({
            grant_type: "refresh_token",
            refresh_token: t.refresh_token ?? "",
            client_id: c.clientId,
          }),
        ),
      );
      expect({ on, auds: [audOf(t.access_token ?? ""), audOf(r.access_token ?? "")] }).toEqual({
        on,
        auds: [RESOURCE, RESOURCE],
      });
    }
  });

  it("does not change the metadata documents", async () => {
    const doc = async (h: Handle) =>
      (await h.auth.wellKnown(new Request(`${BASE_URL}/.well-known/openid-configuration`))).json();
    expect(await doc(handle(true))).toEqual(await doc(handle(false)));
  });
});

const UNKNOWN = "https://api.example.com/unknown";

/** The error of an authorize request whose query `edit` changes, or null for no error. */
async function authorizeError(h: Handle, edit: (q: URLSearchParams) => void) {
  const s = await signedIn(h);
  const clientId = await registered(h);
  const p = await pkce();
  const q = new URLSearchParams(
    authorizeParams({ clientId, challenge: p.challenge, scope: "mcp:read" }),
  );
  edit(q);
  const res = await h.auth.handle(
    new Request(`${ISSUER}/oauth/authorize?${q}`, { headers: { cookie: s.cookie } }),
  );
  const location = res.headers.get("location");
  return location ? new URL(location).searchParams.get("error") : null;
}

/** A client_credentials answer of a new machine client: the audience, or the error. */
async function credentials(h: Handle, form: Record<string, string>) {
  const made = await h.auth.api.oauth?.clients.create({
    name: "Billing service",
    authMethod: "client_secret_basic",
    grantTypes: ["client_credentials"],
    credentialsScopes: ["mcp:read"],
  });
  if (!made?.ok || !made.value.clientSecret) throw new Error("create failed");
  const res = await h.auth.handle(
    tokenPost(
      { grant_type: "client_credentials", ...form },
      { authorization: basicHeader(made.value.client.id, made.value.clientSecret) },
    ),
  );
  const body = (await res.json()) as Record<string, string>;
  return res.status === 200 ? { aud: audOf(body.access_token ?? "") } : { error: body.error };
}

/** A device client of `h` through the route. */
async function deviceClient(h: Handle): Promise<string> {
  const reg = await h.auth.handle(
    post("/auth/oauth/register", {
      redirect_uris: [REDIRECT],
      grant_types: ["authorization_code", "refresh_token", DEVICE_GRANT],
    }),
  );
  return ((await reg.json()) as { client_id: string }).client_id;
}

/** The device grant of `h` through approval and the poll: the audience, or the start error. */
async function device(h: Handle, resource: string | null) {
  const clientId = await deviceClient(h);
  const { cookie } = await signedIn(h);
  let code: string;
  try {
    code = await approvedDevice(h, clientId, cookie, "mcp:read", resource);
  } catch {
    const res = await h.auth.handle(
      new Request(`${ISSUER}/oauth/device_authorization`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          scope: "mcp:read",
          ...(resource !== null ? { resource } : {}),
        }).toString(),
      }),
    );
    return { error: ((await res.json()) as { error: string }).error };
  }
  const t = await tokens(
    await h.auth.handle(
      tokenPost({ grant_type: DEVICE_GRANT, device_code: code, client_id: clientId }),
    ),
  );
  return { aud: audOf(t.access_token ?? "") };
}

describe("a named resource wins over oauth.defaultResource (ruling 53 m1)", () => {
  it("at authorize: an unknown or a repeated resource answers invalid_target, another valid one gets its audience", async () => {
    expect(await authorizeError(handle(true), (q) => q.set("resource", UNKNOWN))).toBe(
      "invalid_target",
    );
    expect(
      await authorizeError(handle(true), (q) => {
        q.set("resource", RESOURCE);
        q.append("resource", RESOURCE);
      }),
    ).toBe("invalid_target");
    const h = handle(true);
    const c = await codeFor(h, "mcp:read", { resource: RESOURCE });
    const t = await tokens(await h.auth.handle(exchangeNoResource(c)));
    expect(audOf(t.access_token ?? "")).toBe(RESOURCE);
  });

  it("at the client_credentials grant: an unknown resource answers invalid_target, another valid one gets its audience", async () => {
    expect(await credentials(handle(true), { resource: UNKNOWN })).toEqual({
      error: "invalid_target",
    });
    expect(await credentials(handle(true), { resource: RESOURCE })).toEqual({ aud: RESOURCE });
  });

  it("at the device start: an unknown resource answers invalid_target, another valid one gets its audience", async () => {
    expect(await device(handle(true), UNKNOWN)).toEqual({ error: "invalid_target" });
    expect(await device(handle(true), RESOURCE)).toEqual({ aud: RESOURCE });
    expect(await device(handle(true), null)).toEqual({ aud: OTHER_RESOURCE });
  });
});

describe("an empty resource counts as absent (RFC 6749 section 3.1, ruling 53 L4)", () => {
  it("at authorize, the client_credentials grant, and the device start, both ways", async () => {
    for (const [on, expected] of [
      [true, { aud: OTHER_RESOURCE }],
      [false, { error: "invalid_target" }],
    ] as const) {
      const authorized = on
        ? await (async () => {
            const h = handle(true);
            const c = await codeFor(h, "mcp:read", { resource: "" });
            const t = await tokens(await h.auth.handle(exchangeNoResource(c)));
            return { aud: audOf(t.access_token ?? "") };
          })()
        : { error: await authorizeError(handle(false), (q) => q.set("resource", "")) };
      expect({ on, path: "authorize", ...authorized }).toEqual({
        on,
        path: "authorize",
        ...expected,
      });
      expect({
        on,
        path: "credentials",
        ...(await credentials(handle(on), { resource: "" })),
      }).toEqual({ on, path: "credentials", ...expected });
      expect({ on, path: "device", ...(await device(handle(on), "")) }).toEqual({
        on,
        path: "device",
        ...expected,
      });
    }
  });

  it("keeps the resource of the grant at a code exchange and a refresh with resource=", async () => {
    for (const on of [true, false]) {
      const h = handle(on);
      const c = await codeFor(h, "mcp:read offline_access", { resource: RESOURCE });
      const t = await tokens(
        await h.auth.handle(
          tokenPost({
            grant_type: "authorization_code",
            code: c.code,
            code_verifier: c.verifier,
            client_id: c.clientId,
            redirect_uri: REDIRECT,
            resource: "",
          }),
        ),
      );
      const r = await tokens(
        await h.auth.handle(
          tokenPost({
            grant_type: "refresh_token",
            refresh_token: t.refresh_token ?? "",
            client_id: c.clientId,
            resource: "",
          }),
        ),
      );
      expect({ on, auds: [audOf(t.access_token ?? ""), audOf(r.access_token ?? "")] }).toEqual({
        on,
        auds: [RESOURCE, RESOURCE],
      });
    }
  });
});
