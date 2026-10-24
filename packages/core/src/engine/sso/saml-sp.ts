import type { ResolvedConfig } from "../../config.js";
import { ERRORS } from "../../errors.js";
import { safeNext } from "../../http/safe-next.js";
import { ipKey } from "../../limiter/ip-key.js";
import { limit } from "../../limiter/limit.js";
import { withSecrets } from "../../observe/observer.js";
import {
  constantTimeEqual,
  randomBase64Url,
  randomToken,
  sha256Hex,
} from "../../primitives/crypto.js";
import { newId } from "../../primitives/ids.js";
import { fail, ok, type Result } from "../../result.js";
import { checkResponse, NS_SAML, NS_SAMLP, type SamlStep } from "../../saml/assertion.js";
import { importVerifyKey, readCertificate, strictBase64 } from "../../saml/der.js";
import { NS_DSIG } from "../../saml/dsig.js";
import { childElements, parseXml, textOf, XML_LIMITS, type XmlElement } from "../../saml/xml.js";
import type { SsoConnectionRow } from "../../schema.js";
import { StorageError } from "../../storage/port.js";
import type { SignInChallenge } from "../second-factor.js";
import { acsUrl, type SamlStored, spEntityId } from "./connections.js";
import { resolveSsoUser, type SsoSignedIn } from "./resolve.js";

/**
 * The SAML service provider of one connection (plan 12d Task 8, spec 30
 * item 9). The start sends an AuthnRequest by the HTTP-Redirect binding.
 * The IdP posts the Response to the ACS by the HTTP-POST binding. The
 * metadata names the two URLs. Each URL holds the connection id, so a
 * Response for one connection fails the audience check of another.
 */

export { acsUrl, spEntityId };

/** The life of a `saml-request` row: the life of the binding cookie and of the OIDC state row. */
export const SAML_REQUEST_TTL_MS = 10 * 60_000;
/** The prefix of a `RelayState` token (deviation 17): 3 + 43 characters, under the 80 bytes of SAML Bindings 3.4.3. */
export const RELAY_STATE_PREFIX = "rs_";
/** The base64 characters of a Response of `XML_LIMITS.bytes` (spec 30 item 7): 349 528. */
const RESPONSE_BASE64_MAX = Math.ceil(XML_LIMITS.bytes / 3) * 4;
/** An IdP may break its base64 lines: a CRLF after each 64 characters (the PEM width) is 5 462 breaks. */
const RESPONSE_LINE_BREAKS = Math.ceil(RESPONSE_BASE64_MAX / 64);
/**
 * The most bytes of one ACS form: 1 081 519. The form must carry each
 * Response of `XML_LIMITS.bytes`, so the cap counts the worst encoding.
 * Each character of the two values takes at most 3 bytes in the URL
 * encoding: `%2B` for `+`, `%2F` for `/`, `%3D` for `=`, and `%0D%0A` for
 * a line break. The values are the base64 with its line breaks, and a
 * `RelayState` of 46 characters. An IdP that breaks its lines more often
 * than each 64 characters can go over this cap, and then it answers `form`.
 */
export const SAML_FORM_MAX =
  "SAMLResponse=".length +
  3 * (RESPONSE_BASE64_MAX + 2 * RESPONSE_LINE_BREAKS) +
  "&RelayState=".length +
  3 * (RELAY_STATE_PREFIX.length + 43);
/** The most bytes of an IdP metadata document (Behavior 6). */
export const IDP_METADATA_MAX = 100 * 1024;

const NS_MD = "urn:oasis:names:tc:SAML:2.0:metadata";
const PROTOCOL = "urn:oasis:names:tc:SAML:2.0:protocol";
const BINDING_REDIRECT = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect";
const BINDING_POST = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST";
const FORMAT_PERSISTENT = "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent";
const RELAY_STATE_RE = /^rs_[A-Za-z0-9_-]{43}$/;
/** The XML white space that a base64 value may hold: an IdP may break its lines. */
const XML_SPACE = /[ \t\r\n]/g;
/** `sso-acs:ip`: 60 per 15 minutes (Behavior 2). */
const ACS_LIMIT = { seconds: 15 * 60, max: 60 };
/** The most connections that one isolate keeps for the expired certificate warning. */
const WARNED_MAX = 500;
const DAY_MS = 86_400_000;

/** What the start writes into the `saml-request` row (deviation 17). */
interface SamlRequestData {
  requestId: string;
  next: string;
  bindHash: string;
}

/**
 * The one fault event of a refused step (Global Constraints of plan 12d):
 * the connection id and the step. The IP is an address input, so only the
 * include rule writes it (plan 12h).
 */
function refused(
  config: ResolvedConfig,
  connectionId: string,
  step: SamlStep,
  ip: string | null,
): Result<never> {
  config.observe.emit({ name: "sso.failed", connectionId, step, ip });
  return fail("sso_failed");
}

function escapeAttr(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** An `xs:dateTime` in UTC with a `Z` and whole seconds. */
function instant(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function hexOf(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function base64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Raw DEFLATE (RFC 1951) through the web platform's `CompressionStream`: no Node module. */
async function deflateRaw(text: string): Promise<Uint8Array> {
  const stream = new Blob([new TextEncoder().encode(text)])
    .stream()
    .pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The SAML config of a SAML row. Core writes it (Task 3), and the kind names the form. */
function samlConfig(row: SsoConnectionRow): SamlStored {
  return row.config as unknown as SamlStored;
}

/**
 * The start of a SAML sign-in (Behavior 1). The caller runs the limit
 * `sso-start:ip` and the connection check first. The AuthnRequest is not
 * signed in plan 12d. It goes by the HTTP-Redirect binding: raw DEFLATE,
 * base64, and the URL encoding, as `SAMLRequest` with `RelayState`. The
 * `saml-request` row is keyed by the hash of `RelayState` (deviation 17).
 */
export async function startSaml(
  config: ResolvedConfig,
  row: SsoConnectionRow,
  input: { next?: string | undefined; ip: string | null },
): Promise<Result<{ location: string; bindToken: string }>> {
  const c = samlConfig(row);
  const now = config.clock.now();
  const requestId = `_${hexOf(crypto.getRandomValues(new Uint8Array(32)))}`;
  const relayState = randomToken(RELAY_STATE_PREFIX);
  const bindToken = randomBase64Url(32);
  const policy =
    c.subjectAttribute === null ? `<samlp:NameIDPolicy Format="${FORMAT_PERSISTENT}"/>` : "";
  const request =
    `<samlp:AuthnRequest xmlns:samlp="${NS_SAMLP}" xmlns:saml="${NS_SAML}"` +
    ` ID="${requestId}" Version="2.0" IssueInstant="${instant(now)}"` +
    ` Destination="${escapeAttr(c.ssoUrl)}"` +
    ` AssertionConsumerServiceURL="${escapeAttr(acsUrl(config, row.id))}"` +
    ` ProtocolBinding="${BINDING_POST}">` +
    `<saml:Issuer>${escapeAttr(spEntityId(config, row.id))}</saml:Issuer>${policy}` +
    "</samlp:AuthnRequest>";
  const data: SamlRequestData = {
    requestId,
    next: safeNext(input.next),
    bindHash: await sha256Hex(bindToken),
  };
  await config.storage.create("verification", {
    id: newId(now),
    purpose: "saml-request",
    identifier: row.id,
    valueHash: await sha256Hex(relayState),
    expiresAt: new Date(now.getTime() + SAML_REQUEST_TTL_MS),
    consumedAt: null,
    data: { ...data },
    createdAt: now,
    updatedAt: now,
    secretVersion: config.keyring.current,
  });
  const query = new URLSearchParams({
    SAMLRequest: base64(await deflateRaw(request)),
    RelayState: relayState,
  });
  const joiner = c.ssoUrl.includes("?") ? "&" : "?";
  return ok({ location: `${c.ssoUrl}${joiner}${query}`, bindToken });
}

/**
 * The connections that this isolate warned for, by the day of the warning.
 * A `Map` keeps insert order, so its first key is the oldest entry.
 */
const warned = new Map<string, number>();

/**
 * One warning event per connection per day per isolate for a certificate
 * past its `notAfter` (Behavior 7). The certificate still verifies: many
 * IdPs sign with an expired certificate, and the owner's upload is the trust.
 */
function warnExpired(config: ResolvedConfig, connectionId: string, now: Date): void {
  const day = Math.floor(now.getTime() / DAY_MS);
  if (warned.get(connectionId) === day) return;
  warned.delete(connectionId);
  const oldest = warned.size >= WARNED_MAX ? warned.keys().next().value : undefined;
  if (oldest !== undefined) warned.delete(oldest);
  warned.set(connectionId, day);
  config.observe.emit({ name: "saml.certificate_expired", connectionId });
}

/** The verify keys of the row's certificates. A certificate that does not import gives no key. */
async function keysOf(
  config: ResolvedConfig,
  row: SsoConnectionRow,
  now: Date,
): Promise<CryptoKey[]> {
  const keys: CryptoKey[] = [];
  let expired = false;
  for (const pem of samlConfig(row).certificates) {
    const info = readCertificate(pem);
    const key = info === null ? null : await importVerifyKey(info);
    if (info === null || key === null) continue;
    if (info.notAfter.getTime() <= now.getTime()) expired = true;
    keys.push(key);
  }
  if (expired) warnExpired(config, row.id, now);
  return keys;
}

/** The input of the ACS: the form, the binding cookie, and the request facts. */
export interface SamlComplete {
  connectionId: string;
  form: URLSearchParams;
  bindToken: string | null;
  ip: string | null;
  userAgent: string | null;
  trustDevice: string | undefined;
}

/**
 * The ACS of a SAML connection (Behaviors 2 to 4). The limit `sso-acs:ip`
 * comes first. The form holds `SAMLResponse` once and `RelayState` once.
 * The `saml-request` row of the `RelayState` hash must name this
 * connection. It must be live and hold the hash of the binding cookie,
 * else `request`. A spent row answers `request_spent`. Then the connection,
 * `checkResponse`, the spend of the row by one conditional update, and the
 * `saml-assertion` row, whose unique key refuses a replay (Profiles
 * 4.1.4.5). Each failure answers `sso_failed` with one `sso.failed` event.
 */
export async function completeSaml(
  outer: ResolvedConfig,
  input: SamlComplete,
): Promise<Result<SsoSignedIn | SignInChallenge>> {
  // The bearer values of the post: each event of the act scrubs them (plan 12d on 12h).
  const config = withSecrets(outer, [
    ...input.form.getAll("SAMLResponse"),
    ...input.form.getAll("RelayState"),
  ]);
  const id = input.connectionId;
  const no = (step: SamlStep) => refused(config, id, step, input.ip);
  if (!(await limit(config, "sso-acs:ip", ipKey(input.ip), ACS_LIMIT))) return fail("rate_limited");
  const sso = config.sso;
  if (!sso?.saml) return fail("sso_not_configured");
  const responses = input.form.getAll("SAMLResponse");
  const states = input.form.getAll("RelayState");
  const [encoded] = responses;
  const [relayState] = states;
  if (responses.length !== 1 || states.length !== 1 || encoded === undefined) return no("form");
  if (relayState === undefined || !RELAY_STATE_RE.test(relayState)) return no("request");
  const now = config.clock.now();
  const row = await config.storage.findOne("verification", [
    { field: "valueHash", op: "eq", value: await sha256Hex(relayState) },
    { field: "purpose", op: "eq", value: "saml-request" },
  ]);
  if (!row || row.identifier !== id || row.expiresAt.getTime() <= now.getTime())
    return no("request");
  const data = row.data as SamlRequestData | null;
  // The start writes this form into every `saml-request` row; the check narrows the type.
  if (!data || typeof data.requestId !== "string" || typeof data.bindHash !== "string")
    return no("request");
  if (!input.bindToken || !constantTimeEqual(await sha256Hex(input.bindToken), data.bindHash))
    return no("request");
  // A spent row: the second post of one Response. No signature check runs for it.
  if (row.consumedAt !== null) return no("request_spent");

  const connection = await config.storage.findOne("ssoConnection", [
    { field: "id", op: "eq", value: id },
  ]);
  if (!connection?.enabled || connection.kind !== "saml") return fail("sso_not_configured");
  const c = samlConfig(connection);
  const xml = strictBase64(encoded, XML_SPACE);
  if (xml === null) return no("form");
  // A second guard: parseXml refuses the same size at the step parse. This
  // check costs nothing, and it stops a large text before the parse starts.
  if (xml.length > XML_LIMITS.bytes) return no("parse");
  const skewMs = sso.saml.clockSkewSeconds * 1000;
  const checked = await checkResponse(xml, {
    acsUrl: acsUrl(config, id),
    spEntityId: spEntityId(config, id),
    idpEntityId: c.idpEntityId,
    requestId: data.requestId,
    keys: await keysOf(config, connection, now),
    now,
    skewMs,
    subjectAttribute: c.subjectAttribute,
    attributes: c.attributes,
  });
  if (!checked.ok) return no(checked.step);

  const spent = await config.storage.update(
    "verification",
    [
      { field: "id", op: "eq", value: row.id },
      { field: "consumedAt", op: "eq", value: null },
      // A second guard: the read above refused an expired row with the same
      // now, and no write changes expiresAt. So no test reaches this term.
      { field: "expiresAt", op: "gt", value: now },
    ],
    { consumedAt: now, updatedAt: now },
  );
  if (spent !== 1) return no("request_spent");
  // The row is created unconsumed, so the sweep removes it only after expiresAt.
  try {
    await config.storage.create("verification", {
      id: newId(now),
      purpose: "saml-assertion",
      identifier: id,
      valueHash: await sha256Hex(`${id}:${checked.value.assertionId}`),
      expiresAt: checked.value.validUntil,
      consumedAt: null,
      data: null,
      createdAt: now,
      updatedAt: now,
      secretVersion: config.keyring.current,
    });
  } catch (err) {
    if (err instanceof StorageError && err.code === "unique_violation") return no("replay");
    throw err;
  }
  return resolveSsoUser(config, connection, checked.value.profile, {
    next: safeNext(data.next),
    ip: input.ip,
    userAgent: input.userAgent,
    trustDevice: input.trustDevice,
  });
}

/**
 * The SP metadata of a SAML connection (Behavior 5): one `EntityDescriptor`
 * with one `SPSSODescriptor` and one HTTP-POST `AssertionConsumerService`.
 * It is not signed: an owner copies it into the IdP by hand.
 */
export function spMetadata(config: ResolvedConfig, row: SsoConnectionRow): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<md:EntityDescriptor xmlns:md="${NS_MD}" entityID="${escapeAttr(spEntityId(config, row.id))}">` +
    `<md:SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="true"` +
    ` protocolSupportEnumeration="${PROTOCOL}">` +
    `<md:AssertionConsumerService Binding="${BINDING_POST}"` +
    ` Location="${escapeAttr(acsUrl(config, row.id))}" index="0"/>` +
    "</md:SPSSODescriptor></md:EntityDescriptor>"
  );
}

/** `invalid_body` with a message that names the rule. */
function refuse(message: string): Result<never> {
  return { ok: false, code: "invalid_body", status: ERRORS.invalid_body, message };
}

/** The value of the attribute with no namespace and this local name, or null. */
function attr(el: XmlElement, local: string): string | null {
  for (const a of el.attrs) if (a.ns === null && a.local === local) return a.value;
  return null;
}

/** A PEM certificate from the base64 text of an `X509Certificate`, 64 characters a line. */
function pemOf(text: string): string {
  const body = text.replace(XML_SPACE, "");
  const lines = body.match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`;
}

/** The certificate of one `KeyDescriptor`: one `KeyInfo`, one `X509Data`, one `X509Certificate`. */
function keyDescriptorPem(descriptor: XmlElement): string | null {
  const [info, ...moreInfo] = childElements(descriptor, NS_DSIG, "KeyInfo");
  if (info === undefined || moreInfo.length > 0) return null;
  const [data, ...moreData] = childElements(info, NS_DSIG, "X509Data");
  if (data === undefined || moreData.length > 0) return null;
  const [cert, ...moreCerts] = childElements(data, NS_DSIG, "X509Certificate");
  if (cert === undefined || moreCerts.length > 0) return null;
  const t = textOf(cert);
  if (!t.ok) return null;
  const pem = pemOf(t.value);
  return readCertificate(pem) === null ? null : pem;
}

/**
 * Reads an IdP metadata document (Behavior 6), at most 100 KB, through
 * `parseXml`. It holds one `EntityDescriptor` with `entityID`, and one
 * `IDPSSODescriptor` with the SAML 2.0 protocol. That holds one
 * `SingleSignOnService` of the HTTP-Redirect binding with an https
 * `Location`, and 1 or 2 signing certificates through `readCertificate`. A `KeyDescriptor` with `use="encryption"` gives none.
 * The caller holds the `Location` host to `isPublicHost`, as for an
 * `ssoUrl` that an owner types. The metadata signature is not checked: the
 * owner uploads the document, and the upload is the trust. Core never
 * fetches a metadata URL in plan 12d.
 */
export function importIdpMetadata(
  xml: string,
): Result<{ idpEntityId: string; ssoUrl: string; certificates: string[] }> {
  const parsed = parseXml(xml, { bytes: IDP_METADATA_MAX });
  if (!parsed.ok)
    return refuse(`idpMetadata is not an XML document of at most ${IDP_METADATA_MAX} bytes`);
  const root = parsed.root;
  if (root.ns !== NS_MD || root.local !== "EntityDescriptor")
    return refuse("idpMetadata holds one EntityDescriptor");
  const idpEntityId = attr(root, "entityID");
  if (idpEntityId === null || idpEntityId === "") return refuse("idpMetadata names no entityID");
  const descriptors = childElements(root, NS_MD, "IDPSSODescriptor");
  const [idp] = descriptors;
  const protocols =
    idp === undefined ? [] : (attr(idp, "protocolSupportEnumeration") ?? "").split(" ");
  if (descriptors.length !== 1 || idp === undefined || !protocols.includes(PROTOCOL))
    return refuse("idpMetadata holds one IDPSSODescriptor of the SAML 2.0 protocol");
  const services = childElements(idp, NS_MD, "SingleSignOnService").filter(
    (s) => attr(s, "Binding") === BINDING_REDIRECT,
  );
  const [service] = services;
  const ssoUrl = service === undefined ? null : attr(service, "Location");
  if (services.length !== 1 || ssoUrl === null || !ssoUrl.startsWith("https://"))
    return refuse("idpMetadata holds one HTTP-Redirect SingleSignOnService with an https Location");
  const certificates: string[] = [];
  for (const descriptor of childElements(idp, NS_MD, "KeyDescriptor")) {
    const use = attr(descriptor, "use");
    if (use !== null && use !== "signing") continue;
    const pem = keyDescriptorPem(descriptor);
    if (pem === null)
      return refuse("each signing KeyDescriptor holds one X509Certificate of an RSA or P-256 key");
    certificates.push(pem);
  }
  if (certificates.length < 1 || certificates.length > 2)
    return refuse("idpMetadata holds 1 or 2 signing certificates");
  return ok({ idpEntityId, ssoUrl, certificates });
}
