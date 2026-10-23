import type { ResolvedConfig, ResolvedSso } from "../../config.js";
import { safeNext } from "../../http/safe-next.js";
import { ipKey } from "../../limiter/ip-key.js";
import {
  constantTimeEqual,
  randomBase64Url,
  randomToken,
  sha256Base64Url,
  sha256Hex,
} from "../../primitives/crypto.js";
import { isPublicHost } from "../../primitives/host.js";
import { newId } from "../../primitives/ids.js";
import { readCapped } from "../../primitives/read-capped.js";
import { hasControlChar } from "../../primitives/text.js";
import { fail, ok, type Result } from "../../result.js";
import type { SsoConnectionRow } from "../../schema.js";
import { discover, type OidcEndpoints, oidcProvider } from "../../social/oidc.js";
import { buildQuery, type OidcProvider, stringClaim } from "../../social/provider.js";
import type { SignInChallenge } from "../second-factor.js";
import { exchangeProviderCode, OAUTH_STATE_PREFIX, type SocialComplete } from "../social.js";
import { validImageUrl, validUserName } from "../users.js";
import { connectionSecret } from "./connections.js";
import { kindOn } from "./discover.js";
import { resolveSsoUser, type SsoProfile, type SsoSignedIn } from "./resolve.js";
import { startSaml } from "./saml-sp.js";

/**
 * The OIDC sign-in of one SSO connection (plan 12d Task 4, spec 30 item 6).
 * It follows the social flow of section 8.3: the `oauth-state` row, PKCE,
 * the nonce, and the binding cookie. The connection lives in the database,
 * so its redirect URI and its state name the connection id.
 */

/** The most discovery results that one isolate keeps (spec 30 item 6). */
export const SSO_DISCOVERY_MAX = 500;
/** How long one isolate keeps a discovery result. */
export const SSO_DISCOVERY_TTL_MS = 60 * 60 * 1000;

/*
 * The byte caps of the three IdP answers that a connection reads (review m2
 * of plan 12d Task 4b). A tenant names the IdP host, so core bounds each
 * read through `readCapped`, as the DoH answer of the domain proof (16 KB).
 * An IdP document is larger than one TXT answer, so each cap is 64 KiB.
 * The value is an estimate with room: no test reads a real IdP.
 */
/** The byte cap of the discovery document of a connection. */
export const SSO_DISCOVERY_BODY_MAX = 65_536;
/** The byte cap of the token answer of a connection: the ID token, the access token, and the refresh token. */
export const SSO_TOKEN_BODY_MAX = 65_536;
/** The byte cap of the JWKS of a connection. */
export const SSO_JWKS_BODY_MAX = 65_536;

const STATE_RE = /^os_[A-Za-z0-9_-]{43}$/;
const STATE_TTL_MS = 10 * 60_000;
/** `sso-start:ip`: 30 per 15 minutes (spec 30 item 23). */
const START_LIMIT = { seconds: 15 * 60, max: 30 };
/** The identity key of a subject, as the social bound of plan 9c. */
const SUBJECT_MAX = 255;

/** The state row's `identifier` of a connection. The colon is outside `PROVIDER_NAME_RE`, so no social provider has it. */
function stateIdentifier(connectionId: string): string {
  return `sso:${connectionId}`;
}

/** What the start writes into the state row. */
interface SsoStateData {
  verifier: string;
  nonceHash: string;
  bindHash: string;
  next: string;
  connectionId: string;
}

/** The callback of an OIDC connection: `SocialComplete` with the connection id in place of the provider. */
export type SsoOidcComplete = Omit<SocialComplete, "provider" | "user" | "sessionToken"> & {
  connectionId: string;
};

/** A test seam (plan 12d Task 4): it reads the profile before the resolution. Core passes none. */
export interface SsoOidcSeam {
  onProfile?: (profile: SsoProfile) => void;
}

/** The stored `config` of an OIDC row. Core writes it (Task 3), and the kind names the form. */
interface OidcStored {
  issuer: string;
  clientId: string;
  scope: string;
  endpoints: OidcEndpoints | null;
}

/** One discovery result, with the issuer that it is for. */
interface Discovered {
  issuer: string;
  endpoints: OidcEndpoints;
  expiresAt: number;
}

/**
 * The discovery results of this isolate, by connection id. A `Map` keeps
 * insert order, so its first key is the oldest entry. An entry holds the
 * issuer that it read. An update of the issuer in another isolate makes the
 * entry miss here. So no old endpoint serves a new issuer.
 */
const discovered = new Map<string, Discovered>();

/** A signal that never aborts, for a call that passes none. */
const NO_SIGNAL = new AbortController().signal;

/**
 * A fetch whose answer body goes through `readCapped`. A body past `max`
 * bytes, a body that is not UTF-8, or an abort throws. So the caller fails
 * as on a network error. The answer is a new response with the status and
 * the content type of the original.
 */
function cappedFetch(fetchFn: typeof fetch, max: number): typeof fetch {
  return async (input, init) => {
    const res = await fetchFn(input, init);
    const text = await readCapped(res, max, init?.signal ?? NO_SIGNAL);
    if (text === null) throw new Error(`the answer is past ${max} bytes, not UTF-8, or late`);
    const type = res.headers.get("content-type");
    return new Response(text, {
      status: res.status,
      headers: type === null ? {} : { "content-type": type },
    });
  };
}

/**
 * The capped JWKS fetch of each `sso.fetch`, made once. The jwt seam keeps
 * one key set per JWKS URL and fetch. A new function per call would make a
 * new set and a new JWKS read for each sign-in.
 */
const jwksFetches = new WeakMap<typeof fetch, typeof fetch>();

function jwksFetchOf(fetchFn: typeof fetch): typeof fetch {
  let capped = jwksFetches.get(fetchFn);
  if (!capped) {
    capped = cappedFetch(fetchFn, SSO_JWKS_BODY_MAX);
    jwksFetches.set(fetchFn, capped);
  }
  return capped;
}

/** Removes the discovery result of one connection (an update or a delete of the row). */
export function dropDiscovery(connectionId: string): void {
  discovered.delete(connectionId);
}

/** The redirect URI of a connection: `<baseURL><basePath>/sso/<connectionId>/callback`. */
export function ssoCallbackUrl(config: ResolvedConfig, connectionId: string): string {
  return `${config.baseURL}${config.basePath}/sso/${connectionId}/callback`;
}

/** A value, or the name of the step that failed. */
type Stepped<T> = { ok: true; value: T } | { ok: false; step: string };

/** The one log line of a refused step (Global Constraints of plan 12d): the connection id, the step, and the IP. */
function refused(connectionId: string, step: string, ip: string | null): Result<never> {
  console.error("authtempo: sso failed", connectionId, step, ip);
  return fail("sso_failed");
}

/** A discovered endpoint: an https URL of a public host with no credentials (plan 12d deviation 7). */
function publicEndpoint(config: ResolvedConfig, value: string): boolean {
  const u = new URL(value);
  return u.username === "" && u.password === "" && isPublicHost(u.hostname, config.baseURL);
}

/** The endpoints of a row with no `endpoints`: the kept result, or a read of the issuer's document. */
async function discoveredEndpoints(
  config: ResolvedConfig,
  sso: ResolvedSso,
  row: SsoConnectionRow,
  issuer: string,
): Promise<Stepped<OidcEndpoints>> {
  const now = config.clock.now().getTime();
  const kept = discovered.get(row.id);
  if (kept && kept.issuer === issuer && kept.expiresAt > now)
    return { ok: true, value: kept.endpoints };
  discovered.delete(row.id);
  // `discover` refuses a document whose issuer is not this issuer, so another tenant's document fails.
  const endpoints = await discover("sso", issuer, cappedFetch(sso.fetch, SSO_DISCOVERY_BODY_MAX));
  if (!endpoints) return { ok: false, step: "discovery" };
  // The document is on the tenant's host, and core fetches these URLs (spec 30 item 5).
  if (
    ![endpoints.authorizeUrl, endpoints.tokenUrl, endpoints.jwksUrl].every((u) =>
      publicEndpoint(config, u),
    )
  )
    return { ok: false, step: "discovery_host" };
  const oldest = discovered.size >= SSO_DISCOVERY_MAX ? discovered.keys().next().value : undefined;
  if (oldest !== undefined) discovered.delete(oldest);
  discovered.set(row.id, { issuer, endpoints, expiresAt: now + SSO_DISCOVERY_TTL_MS });
  return { ok: true, value: endpoints };
}

/** The provider of a row with the step of its failure: `secret`, `discovery`, or `discovery_host`. */
async function providerOf(
  config: ResolvedConfig,
  sso: ResolvedSso,
  row: SsoConnectionRow,
): Promise<Stepped<OidcProvider>> {
  const c = row.config as unknown as OidcStored;
  const clientSecret = await connectionSecret(config, row);
  if (clientSecret === null) return { ok: false, step: "secret" };
  let endpoints = c.endpoints;
  if (!endpoints) {
    const found = await discoveredEndpoints(config, sso, row, c.issuer);
    if (!found.ok) return found;
    endpoints = found.value;
  }
  // The name is a log name only: `ssoCallbackUrl` gives the redirect URI.
  const provider = oidcProvider({
    name: "sso",
    label: row.label,
    issuer: c.issuer,
    clientId: c.clientId,
    clientSecret,
    scope: c.scope,
    endpoints,
  });
  // With endpoints, `oidcProvider` builds the provider and never a discovery entry.
  return provider.kind === "oidc"
    ? { ok: true, value: provider }
    : { ok: false, step: "discovery" };
}

/**
 * The provider of an OIDC row (plan 12d Task 4 Behavior 3), or null. It
 * opens the sealed client secret through `connectionSecret`; a secret that
 * does not open answers null. A row with no `endpoints` reads the issuer's
 * discovery document once per hour per isolate. Each discovered endpoint
 * must be on a public host, else null with the log step `discovery_host`.
 */
export async function connectionProvider(
  config: ResolvedConfig,
  row: SsoConnectionRow,
): Promise<OidcProvider | null> {
  if (!config.sso || row.kind !== "oidc") return null;
  const r = await providerOf(config, config.sso, row);
  if (!r.ok) {
    console.error("authtempo: sso failed", row.id, r.step, null);
    return null;
  }
  return r.value;
}

/** The connection row of a sign-in, or `sso_not_configured`: no row, a row that is off, or a kind that is off. */
async function liveConnection(
  config: ResolvedConfig,
  connectionId: string,
): Promise<Result<{ sso: ResolvedSso; row: SsoConnectionRow }>> {
  const sso = config.sso;
  if (!sso) return fail("sso_not_configured");
  const row = await config.storage.findOne("ssoConnection", [
    { field: "id", op: "eq", value: connectionId },
  ]);
  if (!row?.enabled) return fail("sso_not_configured");
  // A kind that is off signs in no one (`sso.oidc`, `sso.saml`).
  if (!kindOn(sso, row.kind)) return fail("sso_not_configured");
  return ok({ sso, row });
}

/**
 * The start of an SSO sign-in (plan 12d Task 4 Behavior 4). The limit
 * `sso-start:ip` comes first, so it bounds the discovery reads. The row
 * must exist and be enabled, else `sso_not_configured`. The state row has
 * the identifier `sso:<connectionId>` and lives 10 minutes. The answer is
 * the authorize URL and the clear binding value for the cookie. A SAML
 * connection goes to `startSaml` (plan 12d Task 8).
 */
export async function startSso(
  config: ResolvedConfig,
  input: { connectionId: string; next?: string | undefined; ip: string | null },
): Promise<Result<{ location: string; bindToken: string }>> {
  if (!(await config.limiter.allow(`sso-start:ip:${ipKey(input.ip)}`, START_LIMIT)))
    return fail("rate_limited");
  const live = await liveConnection(config, input.connectionId);
  if (!live.ok) return live;
  const { sso, row } = live.value;
  // A SAML connection sends an AuthnRequest (plan 12d Task 8).
  if (row.kind === "saml") return startSaml(config, row, input);
  const provider = await providerOf(config, sso, row);
  if (!provider.ok) return refused(row.id, provider.step, input.ip);
  const now = config.clock.now();
  const state = randomToken(OAUTH_STATE_PREFIX);
  const verifier = randomBase64Url(32);
  const nonce = randomBase64Url(32);
  const bindToken = randomBase64Url(32);
  const data: SsoStateData = {
    verifier,
    nonceHash: await sha256Hex(nonce),
    bindHash: await sha256Hex(bindToken),
    next: safeNext(input.next),
    connectionId: row.id,
  };
  await config.storage.create("verification", {
    id: newId(now),
    purpose: "oauth-state",
    identifier: stateIdentifier(row.id),
    valueHash: await sha256Hex(state),
    expiresAt: new Date(now.getTime() + STATE_TTL_MS),
    consumedAt: null,
    data: { ...data },
    createdAt: now,
    updatedAt: now,
    secretVersion: config.keyring.current,
  });
  const query = buildQuery({
    client_id: provider.value.clientId,
    redirect_uri: ssoCallbackUrl(config, row.id),
    response_type: "code",
    scope: provider.value.scope,
    state,
    nonce,
    code_challenge: await sha256Base64Url(verifier),
    code_challenge_method: "S256",
  });
  return ok({ location: `${provider.value.authorizeUrl}?${query}`, bindToken });
}

/** The strings of a list claim, or `[]` when the claim is not a list. */
function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * The profile of verified claims (plan 12d Task 4 Behavior 5), or null for
 * a bad subject. A bad name or image is dropped, as the social bound does.
 * `email_verified` is never read.
 */
function profileOf(claims: Record<string, unknown>): SsoProfile | null {
  const subject = claims.sub;
  if (
    typeof subject !== "string" ||
    subject.length < 1 ||
    subject.length > SUBJECT_MAX ||
    hasControlChar(subject) ||
    subject.trim().length === 0
  )
    return null;
  const name = stringClaim(claims, "name");
  const image = stringClaim(claims, "picture");
  return {
    subject,
    email: stringClaim(claims, "email"),
    name: name !== null && validUserName(name) ? name : null,
    image: image !== null && validImageUrl(image) ? image : null,
    amr: stringList(claims.amr),
    acr: typeof claims.acr === "string" ? claims.acr : null,
    // SAML fields: an OIDC sign-in has neither.
    authnContext: null,
    sessionNotOnOrAfter: null,
  };
}

/**
 * The callback of an OIDC connection (plan 12d Task 4 Behavior 5), in the
 * order of `completeSocial`. One conditional update spends the state row
 * first, so a replayed callback fails before any network call. Then the
 * state must name the connection of the path, and the binding cookie must
 * match. Then the code exchange with the connection's redirect URI, the ID
 * token through the jwt seam, and the nonce. Each failure answers
 * `sso_failed` with one log line that names the step.
 */
export async function completeSsoOidc(
  config: ResolvedConfig,
  input: SsoOidcComplete,
  seam: SsoOidcSeam = {},
): Promise<Result<SsoSignedIn | SignInChallenge>> {
  const id = input.connectionId;
  const no = (step: string) => refused(id, step, input.ip);
  const state = input.state ?? "";
  if (!STATE_RE.test(state)) return no("state");
  const now = config.clock.now();
  const row = await config.storage.findOne("verification", [
    { field: "valueHash", op: "eq", value: await sha256Hex(state) },
    { field: "purpose", op: "eq", value: "oauth-state" },
  ]);
  if (!row) return no("state");
  const spent = await config.storage.update(
    "verification",
    [
      { field: "id", op: "eq", value: row.id },
      { field: "consumedAt", op: "eq", value: null },
      { field: "expiresAt", op: "gt", value: now },
    ],
    { consumedAt: now, updatedAt: now },
  );
  if (spent !== 1) return no("state");
  // From here the state is spent. Every failure below sends the person back to start again.
  if (row.identifier !== stateIdentifier(id)) return no("state_connection");
  const data = row.data as SsoStateData | null;
  // The start writes this form into every row of the identifier `sso:<id>`; the check narrows the type.
  if (!data || typeof data.verifier !== "string") return no("state");
  if (!input.bindToken || !constantTimeEqual(await sha256Hex(input.bindToken), data.bindHash))
    return no("binding");
  if (input.error) {
    console.error("authtempo: sso denied", id, input.ip);
    return fail("oauth_denied");
  }
  if (!input.code) return no("code");
  const live = await liveConnection(config, id);
  if (!live.ok) return live;
  const { sso, row: connection } = live.value;
  // A state row of `sso:<id>` comes from an OIDC start; a kind change is not possible (Task 3).
  if (connection.kind !== "oidc") return fail("sso_not_configured");
  const provider = await providerOf(config, sso, connection);
  if (!provider.ok) return no(provider.step);
  const p = provider.value;
  // Each IdP call goes through `sso.fetch` with its byte cap (plan 12d), the JWKS read too.
  const token = await exchangeProviderCode(
    config,
    p,
    input.code,
    data.verifier,
    now,
    ssoCallbackUrl(config, id),
    cappedFetch(sso.fetch, SSO_TOKEN_BODY_MAX),
  );
  if (token === null) return no("exchange");
  let claims: Record<string, unknown>;
  try {
    claims = await config.jwt.verifyIdToken({
      token,
      jwksUrl: p.jwksUrl,
      issuer: p.issuer,
      audience: p.clientId,
      now,
      fetch: jwksFetchOf(sso.fetch),
    });
  } catch {
    return no("id_token");
  }
  const nonce = claims.nonce;
  if (typeof nonce !== "string" || !constantTimeEqual(await sha256Hex(nonce), data.nonceHash))
    return no("nonce");
  const profile = profileOf(claims);
  if (!profile) return no("subject");
  seam.onProfile?.(profile);
  return resolveSsoUser(config, connection, profile, {
    next: safeNext(data.next),
    ip: input.ip,
    userAgent: input.userAgent,
    trustDevice: input.trustDevice,
  });
}
