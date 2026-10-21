import type { AuthConfig, SsoConfig } from "../../src/config.js";
import { type ConnectionFields, createConnection } from "../../src/engine/sso/connections.js";
import { acsUrl, spEntityId } from "../../src/engine/sso/saml-sp.js";
import { parseXml } from "../../src/saml/xml.js";
import {
  attrOf,
  createTestIdp,
  elementsIn,
  parseOrThrow,
  serializeXml,
  type TestIdp,
  type TestResponseInput,
} from "../../src/testing/saml-idp.js";
import { get } from "../helpers.js";
import { FAST } from "../password-helpers.js";
import { NS_SAML } from "../saml/corpus.js";
import { SSO_APP, seedOrganization, ssoAuth, verifiedDomain } from "./helpers.js";

/** The Origin and the Fetch Metadata header of a form that an IdP page posts. */
export const IDP_ORIGIN = "https://idp.example";
const BIND = "__Secure-tempo_session_oauth";
const SESSION = "__Host-tempo_session";

/**
 * A memory engine for the SAML service provider of plan 12d Task 8:
 * organizations, `sso.saml` with the two fake DNS ports, and the password.
 * `overrides` replaces a top key; its `sso` keeps `saml` and the ports.
 */
export function samlWorld(overrides: Partial<AuthConfig> = {}) {
  const sso: SsoConfig = { saml: true, ...(overrides.sso || {}) };
  return ssoAuth({ password: { hash: FAST, uniformSignUp: false }, ...overrides, sso });
}

export type SamlWorld = ReturnType<typeof samlWorld>;

/** The fields of a SAML connection that a test changes. */
export type SamlExtra = Omit<ConnectionFields, "organizationId" | "kind" | "label">;

/** One SAML connection of the organization with the certificate of `idp`, made by the app. Its id. */
export async function samlConnection(
  w: SamlWorld,
  organizationId: string,
  idp: TestIdp,
  extra: SamlExtra = {},
): Promise<string> {
  const r = await createConnection(w.config, SSO_APP, {
    organizationId,
    kind: "saml",
    label: "SAML IdP",
    idpEntityId: idp.entityId,
    ssoUrl: "https://idp.example/sso",
    certificates: [idp.certificatePem],
    ...extra,
  });
  if (!r.ok) throw new Error(`${r.code} ${r.message ?? ""}`);
  return r.value.id;
}

/** The organization of `slug` with its verified domain and one SAML connection of a new RSA test IdP. */
export async function orgWithSaml(w: SamlWorld, slug = "acme", extra: SamlExtra = {}) {
  const idp = await createTestIdp({ alg: "rsa" });
  const organizationId = await seedOrganization(w, slug);
  await verifiedDomain(w, organizationId, `${slug}.example`);
  const connectionId = await samlConnection(w, organizationId, idp, extra);
  return { idp, organizationId, connectionId };
}

/** What a start answered: the AuthnRequest text, its ID, the RelayState, and the binding cookie. */
export interface SamlStart {
  location: URL;
  request: string;
  requestId: string;
  relayState: string;
  bind: string;
}

/** Inflates the `SAMLRequest` of a redirect: base64, then raw DEFLATE. */
export async function inflateRequest(value: string): Promise<string> {
  const bytes = Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Response(stream).text();
}

/** The start of a SAML sign-in through the route. */
export async function samlStart(w: SamlWorld, connectionId: string): Promise<SamlStart> {
  const res = await w.handle(get(`/auth/sso/${connectionId}/start?next=/home`));
  if (res.status !== 302) throw new Error(`the start answered ${res.status}`);
  const location = new URL(res.headers.get("location") ?? "");
  const request = await inflateRequest(location.searchParams.get("SAMLRequest") ?? "");
  const parsed = parseXml(request);
  if (!parsed.ok) throw new Error("the AuthnRequest does not parse");
  const bind =
    res.headers
      .getSetCookie()
      .find((c) => c.startsWith(`${BIND}=`))
      ?.split(";")[0]
      ?.split("=")[1] ?? "";
  return {
    location,
    request,
    requestId: attrOf(parsed.root, "ID") ?? "",
    relayState: location.searchParams.get("RelayState") ?? "",
    bind,
  };
}

/** The valid Response input for a start of the connection, for Ada at `now`. */
export function responseFor(
  w: SamlWorld,
  connectionId: string,
  start: Pick<SamlStart, "requestId">,
  extra: Partial<TestResponseInput> = {},
): TestResponseInput {
  const now = w.clock.now();
  return {
    audience: spEntityId(w.config, connectionId),
    recipient: acsUrl(w.config, connectionId),
    inResponseTo: start.requestId,
    nameId: "ada-1",
    attributes: { email: ["ada@acme.example"] },
    notBefore: new Date(now.getTime() - 60_000),
    notOnOrAfter: new Date(now.getTime() + 5 * 60_000),
    now,
    ...extra,
  };
}

/** What the ACS answered: the redirect, its `auth_error`, the challenge, and the session token. */
export interface AcsAnswer {
  res: Response;
  error: string | null;
  challenge: string | null;
  token: string | null;
}

/** A POST of the IdP's form to the ACS, cross-site, with the binding cookie of `bind`. */
export async function postAcs(
  w: SamlWorld,
  connectionId: string,
  form: Record<string, string> | URLSearchParams,
  bind: string | null,
): Promise<AcsAnswer> {
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    origin: IDP_ORIGIN,
    "sec-fetch-site": "cross-site",
  };
  if (bind !== null) headers.cookie = `${BIND}=${bind}`;
  const res = await w.handle(
    new Request(`https://api.example.com/auth/sso/${connectionId}/acs`, {
      method: "POST",
      headers,
      body: new URLSearchParams(form).toString(),
    }),
  );
  const location = new URL(res.headers.get("location") ?? "", "https://x.invalid");
  const session = res.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${SESSION}=`))
    ?.split(";")[0]
    ?.split("=")[1];
  return {
    res,
    error: location.searchParams.get("auth_error"),
    challenge: location.searchParams.get("challenge"),
    token: session ? decodeURIComponent(session) : null,
  };
}

/** base64 of a UTF-8 text, the form of `SAMLResponse`. */
export function b64(xml: string): string {
  let bin = "";
  for (const b of new TextEncoder().encode(xml)) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Posts `xml` for the start: the form of the HTTP-POST binding, with the start's cookie. */
export function postResponse(
  w: SamlWorld,
  connectionId: string,
  start: Pick<SamlStart, "relayState" | "bind">,
  xml: string,
): Promise<AcsAnswer> {
  return postAcs(
    w,
    connectionId,
    { SAMLResponse: b64(xml), RelayState: start.relayState },
    start.bind,
  );
}

/** One whole SAML sign-in: a start, a Response of `idp` with `extra`, and the post. */
export async function samlSignIn(
  w: SamlWorld,
  connectionId: string,
  idp: TestIdp,
  extra: Partial<TestResponseInput> = {},
): Promise<AcsAnswer & { start: SamlStart; xml: string }> {
  const start = await samlStart(w, connectionId);
  const xml = await idp.response(responseFor(w, connectionId, start, extra));
  return { ...(await postResponse(w, connectionId, start, xml)), start, xml };
}

/**
 * The Response with one edit of its Assertion, signed again by `idp`: a
 * Response that the IdP itself sends with that value.
 */
export async function editAssertion(
  idp: TestIdp,
  xml: string,
  edit: (assertion: ReturnType<typeof parseOrThrow>) => void,
): Promise<string> {
  const root = parseOrThrow(xml);
  const assertion = elementsIn(root).find((e) => e.ns === NS_SAML && e.local === "Assertion");
  const id = assertion === undefined ? null : attrOf(assertion, "ID");
  if (assertion === undefined || id === null) throw new Error("no Assertion");
  edit(assertion);
  return idp.sign(serializeXml(root), id);
}

/** The element of the subtree with this SAML local name. */
export function samlElement(el: ReturnType<typeof parseOrThrow>, local: string) {
  const found = elementsIn(el).find((e) => e.ns === NS_SAML && e.local === local);
  if (found === undefined) throw new Error(`no ${local}`);
  return found;
}

/** The count of rows of each model that a refused sign-in must not add. */
export async function rowCounts(w: SamlWorld) {
  return {
    users: (await w.storage.findMany("user", [])).length,
    sessions: (await w.storage.findMany("session", [])).length,
    members: (await w.storage.findMany("member", [])).length,
    identities: (await w.storage.findMany("identity", [])).length,
  };
}
