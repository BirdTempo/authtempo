import type { AuthConfig, SsoConfig } from "../../src/config.js";
import { type ConnectionInput, createConnection } from "../../src/engine/sso/connections.js";
import type { OidcEndpoints } from "../../src/social/oidc.js";
import { get } from "../helpers.js";
import { FAST } from "../password-helpers.js";
import { type FakeIdToken, fakeFetch, fakeJwt, type TokenCall } from "../social-helpers.js";
import { SSO_APP, seedOrganization, ssoAuth, verifiedDomain } from "./helpers.js";

/** The issuer of the IdP of an organization slug. */
export const issuerOf = (slug: string) => `https://login.${slug}-idp.example/v2.0`;

/** The fixed endpoints of the IdP of an organization slug. */
export function endpointsOf(slug: string): OidcEndpoints {
  return {
    authorizeUrl: `https://login.${slug}-idp.example/authorize`,
    tokenUrl: `https://login.${slug}-idp.example/token`,
    jwksUrl: `https://login.${slug}-idp.example/keys`,
  };
}

/**
 * A memory engine for the SSO sign-in of plan 12d Task 5: organizations,
 * OIDC connections, the password, and the fake IdP of plan 9c. The token
 * endpoint answers the code as the ID token, and the jwt seam knows the
 * tokens of `tokens`. `overrides` replaces a top key; its `sso` keeps the
 * fake IdP and the two DNS ports.
 */
export function ssoSignInWorld(overrides: Partial<AuthConfig> = {}) {
  const tokens: Record<string, FakeIdToken> = {};
  const idp = fakeFetch((call: TokenCall) =>
    Response.json({ id_token: call.form.code, token_type: "Bearer" }),
  );
  const sso: SsoConfig = { oidc: true, fetch: idp.fetchFn, ...(overrides.sso || {}) };
  const w = ssoAuth({
    password: { hash: FAST, uniformSignUp: false },
    jwt: fakeJwt(tokens),
    ...overrides,
    sso,
  });
  return { ...w, tokens };
}

export type SsoWorld = ReturnType<typeof ssoSignInWorld>;

/** One OIDC connection of the organization, made by the app. Its id. */
export async function oidcConnection(
  w: SsoWorld,
  organizationId: string,
  slug: string,
  extra: Partial<Extract<ConnectionInput, { kind: "oidc" }>> = {},
): Promise<string> {
  const r = await createConnection(w.config, SSO_APP, {
    organizationId,
    kind: "oidc",
    label: `${slug} IdP`,
    issuer: issuerOf(slug),
    clientId: `${slug}-client`,
    clientSecret: `${slug}-secret-0123456789`,
    endpoints: endpointsOf(slug),
    ...extra,
  });
  if (!r.ok) throw new Error(r.code);
  return r.value.id;
}

/** The organization `acme` with the verified domain `acme.example` and one OIDC connection. */
export async function acmeWithSso(
  w: SsoWorld,
  extra: Partial<Extract<ConnectionInput, { kind: "oidc" }>> = {},
) {
  const organizationId = await seedOrganization(w, "acme");
  const domainId = await verifiedDomain(w, organizationId, "acme.example");
  const connectionId = await oidcConnection(w, organizationId, "acme", extra);
  return { organizationId, domainId, connectionId };
}

/** What a callback answered: the redirect, its `auth_error`, the challenge, and the session token. */
export interface SsoAnswer {
  res: Response;
  error: string | null;
  challenge: string | null;
  token: string | null;
}

let codes = 0;

/**
 * One SSO sign-in through the routes of Task 4: the start, the fake IdP's
 * ID token with the start's nonce and `claims`, and the callback with the
 * binding cookie. `cookie` adds a request cookie, such as a trust cookie.
 */
export async function ssoSignIn(
  w: SsoWorld,
  connectionId: string,
  slug: string,
  claims: Record<string, unknown>,
  cookie = "",
): Promise<SsoAnswer> {
  const started = await w.handle(get(`/auth/sso/${connectionId}/start?next=/home`));
  const url = new URL(started.headers.get("location") ?? "");
  const bind =
    started.headers
      .getSetCookie()
      .find((c) => c.startsWith("__Secure-tempo_session_oauth="))
      ?.split(";")[0]
      ?.split("=")[1] ?? "";
  const code = `token-${++codes}`;
  w.tokens[code] = {
    audience: `${slug}-client`,
    issuer: issuerOf(slug),
    claims: { ...claims, nonce: url.searchParams.get("nonce") ?? "" },
  };
  const q = new URLSearchParams({ code, state: url.searchParams.get("state") ?? "" });
  const res = await w.handle(
    get(`/auth/sso/${connectionId}/callback?${q}`, {
      cookie: [`__Secure-tempo_session_oauth=${bind}`, cookie].filter(Boolean).join("; "),
    }),
  );
  const location = new URL(res.headers.get("location") ?? "", "https://x.invalid");
  const session = res.headers
    .getSetCookie()
    .find((c) => c.startsWith("__Host-tempo_session="))
    ?.split(";")[0]
    ?.split("=")[1];
  return {
    res,
    error: location.searchParams.get("auth_error"),
    challenge: location.searchParams.get("challenge"),
    token: session ? decodeURIComponent(session) : null,
  };
}
