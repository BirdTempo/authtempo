/**
 * The checks of one SAML Response (plan 12d Task 8), in the order of the
 * design's section 6.2. Each failure names its step, and no failure says
 * more. The checks read every value from the one Assertion node that
 * `wrappingGuard` answers. They never search the document again (XML
 * Signature 1.1 section 8.1.3, "see what is signed").
 */
import type { SsoProfile } from "../engine/sso/resolve.js";
import { hasControlChar } from "../primitives/text.js";
import { type DsigStep, NS_DSIG, verifyEnveloped } from "./dsig.js";
import { childElements, parseXml, textOf, type XmlElement } from "./xml.js";

export const NS_SAML = "urn:oasis:names:tc:SAML:2.0:assertion";
export const NS_SAMLP = "urn:oasis:names:tc:SAML:2.0:protocol";

const STATUS_SUCCESS = "urn:oasis:names:tc:SAML:2.0:status:Success";
const BEARER = "urn:oasis:names:tc:SAML:2.0:cm:bearer";
const FORMAT_PERSISTENT = "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent";
const FORMAT_EMAIL = "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress";
const FORMAT_ENTITY = "urn:oasis:names:tc:SAML:2.0:nameid-format:entity";
/** The longest subject: the identity key of the social bound of plan 9c. */
const SUBJECT_MAX = 255;

/**
 * An `xs:dateTime` in UTC with a `Z` (spec 30 item 8). Fractional seconds
 * are allowed, because Entra ID writes seven digits. Any other form, an
 * offset such as `+00:00` too, is refused at its step.
 */
const INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;

export type SamlStep =
  | "form"
  | "request"
  | "parse"
  | "wrapping"
  | DsigStep
  | "status"
  | "destination"
  | "issuer"
  | "conditions"
  | "audience"
  | "subject_confirmation"
  | "authn_statement"
  | "request_spent"
  | "replay"
  | "subject"
  | "address";

/** What one Response must match: the connection, the request, the keys, and the clock. */
export interface SamlExpect {
  acsUrl: string;
  spEntityId: string;
  idpEntityId: string;
  requestId: string;
  keys: readonly CryptoKey[];
  now: Date;
  skewMs: number;
  /** The attribute of the subject, or null for the persistent `NameID`. */
  subjectAttribute: string | null;
  attributes: { email: string; name: string | null };
}

export interface SamlChecked {
  assertionId: string;
  /** The later of the two `NotOnOrAfter` values plus the skew: the life of the replay row. */
  validUntil: Date;
  profile: SsoProfile;
}

/** A failure in flight. Only `checkResponse` catches it. */
class Fail {
  readonly step: SamlStep;
  constructor(step: SamlStep) {
    this.step = step;
  }
}

/** Each element in the subtree of `el`, `el` first, in document order. */
function* subtree(el: XmlElement): Generator<XmlElement> {
  const stack: XmlElement[] = [el];
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    yield next;
    const kids = next.children.filter((c): c is XmlElement => c.kind === "element");
    stack.push(...kids.reverse());
  }
}

/** The value of the attribute with no namespace and this local name, or null. */
function attr(el: XmlElement, local: string): string | null {
  for (const a of el.attrs) if (a.ns === null && a.local === local) return a.value;
  return null;
}

/** The one child of `el` with this name, or a failure at `step` for none or more. */
function only(el: XmlElement, ns: string, local: string, step: SamlStep): XmlElement {
  const found = childElements(el, ns, local);
  const [first] = found;
  if (found.length !== 1 || first === undefined) throw new Fail(step);
  return first;
}

/** The child of `el` with this name, or null; a second one fails at `step`. */
function optional(el: XmlElement, ns: string, local: string, step: SamlStep): XmlElement | null {
  const found = childElements(el, ns, local);
  if (found.length > 1) throw new Fail(step);
  return found[0] ?? null;
}

/** The text of `el` through `textOf`, or a failure at `step`. */
function text(el: XmlElement, step: SamlStep): string {
  const t = textOf(el);
  if (!t.ok) throw new Fail(step);
  return t.value;
}

/** The instant of an `xs:dateTime` in UTC with a `Z`, or a failure at `step`. */
function instant(value: string | null, step: SamlStep): number {
  const m = value === null ? null : INSTANT_RE.exec(value);
  if (m === null) throw new Fail(step);
  const [, y, mo, d, h, mi, s, frac] = m;
  const parts = [y, mo, d, h, mi, s].map(Number);
  const [year, month, day, hour, minute, second] = parts;
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined
  )
    throw new Fail(step);
  const ms = frac === undefined ? 0 : Number(frac.padEnd(3, "0").slice(0, 3));
  const at = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  // Date.UTC rolls an out-of-range field over, so a read back finds a day such as 02-30.
  const back = new Date(at);
  if (
    back.getUTCFullYear() !== year ||
    back.getUTCMonth() !== month - 1 ||
    back.getUTCDate() !== day ||
    back.getUTCHours() !== hour ||
    back.getUTCMinutes() !== minute ||
    back.getUTCSeconds() !== second
  )
    throw new Fail(step);
  return at;
}

/**
 * The wrapping guard (Behavior 3). The root is the `samlp:Response`, and
 * each `ID` value of the document is unique. The document holds exactly
 * one `saml:Assertion` element, a child of the root. An `EncryptedAssertion`
 * anywhere is out of plan 12d. An Assertion inside `Advice` counts too, so
 * a Response with Advice is refused (ruling 22 L4 of plan 12d). The
 * profile reads one Assertion, and a second one is a place for a wrapping shape.
 */
export function wrappingGuard(
  root: XmlElement,
): { ok: true; assertion: XmlElement } | { ok: false } {
  if (root.ns !== NS_SAMLP || root.local !== "Response") return { ok: false };
  const ids = new Set<string>();
  const assertions: XmlElement[] = [];
  for (const el of subtree(root)) {
    for (const a of el.attrs) {
      if (a.ns !== null || a.local !== "ID") continue;
      if (ids.has(a.value)) return { ok: false };
      ids.add(a.value);
    }
    if (el.ns === NS_SAML && el.local === "EncryptedAssertion") return { ok: false };
    if (el.ns === NS_SAML && el.local === "Assertion") assertions.push(el);
  }
  const [assertion] = assertions;
  if (assertions.length !== 1 || assertion === undefined || assertion.parent !== root)
    return { ok: false };
  return { ok: true, assertion };
}

/** An `Issuer` with no format or the entity format (Profiles 4.1.4.2), equal to the IdP entity id. */
function checkIssuer(el: XmlElement, idpEntityId: string): void {
  const format = attr(el, "Format");
  if (format !== null && format !== FORMAT_ENTITY) throw new Fail("issuer");
  if (text(el, "issuer") !== idpEntityId) throw new Fail("issuer");
}

/** The attributes of the Assertion by name. A name given twice fails at `address`. */
function attributesOf(assertion: XmlElement): Map<string, XmlElement> {
  const out = new Map<string, XmlElement>();
  for (const statement of childElements(assertion, NS_SAML, "AttributeStatement")) {
    for (const a of childElements(statement, NS_SAML, "Attribute")) {
      const name = attr(a, "Name");
      if (name === null) continue;
      if (out.has(name)) throw new Fail("address");
      out.set(name, a);
    }
  }
  return out;
}

/** The one value of an attribute through `textOf`, or a failure at `step`. */
function oneValue(attribute: XmlElement, step: SamlStep): string {
  return text(only(attribute, NS_SAML, "AttributeValue", step), step);
}

/** The value of an optional attribute with one value, or null when it is absent or not one text. */
function softValue(attributes: Map<string, XmlElement>, name: string): string | null {
  const a = attributes.get(name);
  if (a === undefined) return null;
  const values = childElements(a, NS_SAML, "AttributeValue");
  const [first] = values;
  if (values.length !== 1 || first === undefined) return null;
  const t = textOf(first);
  return t.ok ? t.value : null;
}

/** A subject of 1 to 255 characters with no control character, else a failure at `subject`. */
function checkSubject(value: string): string {
  if (
    value.length < 1 ||
    value.length > SUBJECT_MAX ||
    hasControlChar(value) ||
    value.trim().length === 0
  )
    throw new Fail("subject");
  return value;
}

/** The checks after the signatures, on the guard's Assertion. */
function checkAssertion(root: XmlElement, assertion: XmlElement, expect: SamlExpect): SamlChecked {
  const now = expect.now.getTime();
  const skew = expect.skewMs;

  const status = only(root, NS_SAMLP, "Status", "status");
  const code = only(status, NS_SAMLP, "StatusCode", "status");
  if (attr(code, "Value") !== STATUS_SUCCESS) throw new Fail("status");

  const destination = attr(root, "Destination");
  if (destination !== null && destination !== expect.acsUrl) throw new Fail("destination");

  const responseIssuer = optional(root, NS_SAML, "Issuer", "issuer");
  if (responseIssuer !== null) checkIssuer(responseIssuer, expect.idpEntityId);
  checkIssuer(only(assertion, NS_SAML, "Issuer", "issuer"), expect.idpEntityId);

  const conditions = only(assertion, NS_SAML, "Conditions", "conditions");
  const notBefore = instant(attr(conditions, "NotBefore"), "conditions");
  const notOnOrAfter = instant(attr(conditions, "NotOnOrAfter"), "conditions");
  if (!(notBefore - skew <= now && now < notOnOrAfter + skew)) throw new Fail("conditions");
  // Fail closed (SAML Core 2.5.1.5): a condition that core does not know is not met.
  for (const c of conditions.children) {
    if (c.kind !== "element") continue;
    const known =
      c.ns === NS_SAML && (c.local === "AudienceRestriction" || c.local === "OneTimeUse");
    if (!known) throw new Fail("conditions");
  }
  if (childElements(conditions, NS_SAML, "OneTimeUse").length > 1) throw new Fail("conditions");
  const restriction = only(conditions, NS_SAML, "AudienceRestriction", "audience");
  const audience = only(restriction, NS_SAML, "Audience", "audience");
  if (text(audience, "audience") !== expect.spEntityId) throw new Fail("audience");

  const subject = only(assertion, NS_SAML, "Subject", "subject_confirmation");
  const bearers = childElements(subject, NS_SAML, "SubjectConfirmation").filter(
    (c) => attr(c, "Method") === BEARER,
  );
  const [bearer] = bearers;
  if (bearers.length !== 1 || bearer === undefined) throw new Fail("subject_confirmation");
  const data = only(bearer, NS_SAML, "SubjectConfirmationData", "subject_confirmation");
  if (attr(data, "Recipient") !== expect.acsUrl) throw new Fail("subject_confirmation");
  const dataNotOnOrAfter = instant(attr(data, "NotOnOrAfter"), "subject_confirmation");
  if (!(now < dataNotOnOrAfter + skew)) throw new Fail("subject_confirmation");
  if (attr(data, "InResponseTo") !== expect.requestId) throw new Fail("subject_confirmation");
  // Profiles 4.1.4.2: a bearer confirmation has no NotBefore.
  if (attr(data, "NotBefore") !== null) throw new Fail("subject_confirmation");
  // The Response names the same request when it names one.
  const responseTo = attr(root, "InResponseTo");
  if (responseTo !== null && responseTo !== expect.requestId)
    throw new Fail("subject_confirmation");

  const statement = only(assertion, NS_SAML, "AuthnStatement", "authn_statement");
  const sessionEnd = attr(statement, "SessionNotOnOrAfter");
  const sessionNotOnOrAfter =
    sessionEnd === null ? null : new Date(instant(sessionEnd, "authn_statement"));
  // A session that the IdP already ended opens no session here.
  if (sessionNotOnOrAfter !== null && sessionNotOnOrAfter.getTime() <= now)
    throw new Fail("authn_statement");
  const context = optional(statement, NS_SAML, "AuthnContext", "authn_statement");
  const classRef =
    context === null ? null : optional(context, NS_SAML, "AuthnContextClassRef", "authn_statement");
  const authnContext = classRef === null ? null : text(classRef, "authn_statement");

  const attributes = attributesOf(assertion);
  const nameIdEl = optional(subject, NS_SAML, "NameID", "subject");
  // A BaseID or an EncryptedID is out of the profile: only a NameID names the person.
  if (
    childElements(subject, NS_SAML, "BaseID").length > 0 ||
    childElements(subject, NS_SAML, "EncryptedID").length > 0
  )
    throw new Fail("subject");
  const nameId =
    nameIdEl === null
      ? null
      : { format: attr(nameIdEl, "Format"), value: text(nameIdEl, "subject") };
  let subjectValue: string;
  if (expect.subjectAttribute === null) {
    // A transient NameID changes at each sign-in, so it names no lasting identity.
    if (nameId === null || nameId.format !== FORMAT_PERSISTENT) throw new Fail("subject");
    subjectValue = checkSubject(nameId.value);
  } else {
    const a = attributes.get(expect.subjectAttribute);
    if (a === undefined) throw new Fail("subject");
    subjectValue = checkSubject(oneValue(a, "subject"));
  }

  const emailAttribute = attributes.get(expect.attributes.email);
  let email: string;
  if (emailAttribute !== undefined) email = oneValue(emailAttribute, "address");
  else if (nameId !== null && nameId.format === FORMAT_EMAIL) email = nameId.value;
  else throw new Fail("address");

  let name: string | null;
  if (expect.attributes.name !== null) name = softValue(attributes, expect.attributes.name);
  else {
    const given = softValue(attributes, "givenName");
    const surname = softValue(attributes, "surname");
    name = given !== null && surname !== null ? `${given} ${surname}` : (given ?? surname);
  }

  const assertionId = attr(assertion, "ID");
  // The signature check needs the ID, so this is a second guard.
  if (assertionId === null || assertionId === "") throw new Fail("wrapping");
  return {
    assertionId,
    validUntil: new Date(Math.max(notOnOrAfter, dataNotOnOrAfter) + skew),
    profile: {
      subject: subjectValue,
      email,
      name,
      image: null,
      amr: [],
      acr: null,
      authnContext,
      sessionNotOnOrAfter,
    },
  };
}

/**
 * Checks one decoded Response against `expect` (Behavior 3). The parse
 * comes first, then the wrapping guard and the signature of the Assertion.
 * The signature of the Response follows when it holds one, and then the
 * values of the Assertion. The answer is the checked Assertion, or the step of the first
 * failure. The caller checks the size of the text first (`XML_LIMITS.bytes`);
 * the parser holds the same bound.
 */
export async function checkResponse(
  xml: Uint8Array,
  expect: SamlExpect,
): Promise<{ ok: true; value: SamlChecked } | { ok: false; step: SamlStep }> {
  const parsed = parseXml(xml);
  if (!parsed.ok) return { ok: false, step: "parse" };
  const guard = wrappingGuard(parsed.root);
  if (!guard.ok) return { ok: false, step: "wrapping" };
  // SAML Profiles 4.1.4.5: with the POST binding the Assertion is signed.
  const signed = await verifyEnveloped(guard.assertion, expect.keys);
  if (!signed.ok) return signed;
  if (childElements(parsed.root, NS_DSIG, "Signature").length > 0) {
    const response = await verifyEnveloped(parsed.root, expect.keys);
    if (!response.ok) return response;
  }
  try {
    return { ok: true, value: checkAssertion(parsed.root, guard.assertion, expect) };
  } catch (err) {
    if (err instanceof Fail) return { ok: false, step: err.step };
    throw err;
  }
}
