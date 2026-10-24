import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@authtempo/core";

/** How one ceremony runs (plan 11d). `mediation: "conditional"` waits for the autofill of a field. */
export interface CeremonyOptions {
  mediation?: "conditional" | undefined;
  /**
   * Aborts a waiting ceremony; the seam then throws `WebAuthnCancelled`. Call
   * `abort()` with no reason: a custom reason passes through as an error, and
   * the client answers `unexpected`. The client's own `abort()` sends none.
   */
  signal?: AbortSignal | undefined;
}

/** The WebAuthn ceremonies as the client sees them: JSON in, JSON out. Tests inject a soft one. */
export interface BrowserWebAuthn {
  create(options: PublicKeyCredentialCreationOptionsJSON): Promise<RegistrationResponseJSON>;
  get(
    options: PublicKeyCredentialRequestOptionsJSON,
    ceremony?: CeremonyOptions,
  ): Promise<AuthenticationResponseJSON>;
}

/** The part of `navigator.credentials` the seam calls. */
export interface CredentialsContainerLike {
  create(options: { publicKey?: PublicKeyCredentialCreationOptions }): Promise<unknown>;
  get(options: {
    publicKey?: PublicKeyCredentialRequestOptions;
    mediation?: "conditional";
    signal?: AbortSignal;
  }): Promise<unknown>;
}

/** The part of a `PublicKeyCredential` the conversion reads. */
export interface PublicKeyCredentialLike {
  id: string;
  rawId: ArrayBuffer;
  type: string;
  authenticatorAttachment?: string | null;
  response: {
    clientDataJSON: ArrayBuffer;
    attestationObject?: ArrayBuffer;
    authenticatorData?: ArrayBuffer;
    signature?: ArrayBuffer;
    userHandle?: ArrayBuffer | null;
    getTransports?: () => string[];
  };
  getClientExtensionResults(): Record<string, unknown>;
  toJSON?: () => unknown;
}

/** The person dismissed the prompt, or no authenticator matched. The client answers `cancelled`. */
export class WebAuthnCancelled extends Error {
  constructor() {
    super("The passkey prompt was dismissed");
    this.name = "WebAuthnCancelled";
  }
}

interface PublicKeyCredentialStatic {
  parseCreationOptionsFromJSON?: (json: unknown) => PublicKeyCredentialCreationOptions;
  parseRequestOptionsFromJSON?: (json: unknown) => PublicKeyCredentialRequestOptions;
  isConditionalMediationAvailable?: () => Promise<boolean>;
}

function pkcStatic(): PublicKeyCredentialStatic | undefined {
  return (globalThis as { PublicKeyCredential?: PublicKeyCredentialStatic }).PublicKeyCredential;
}

/**
 * The Signal API of WebAuthn Level 3 (plan 12i): three static methods of
 * `PublicKeyCredential`. A browser without them has none, so the client
 * reads each one at the call. Every id is base64url.
 */
interface SignalStatic {
  signalUnknownCredential?: (input: { rpId: string; credentialId: string }) => Promise<unknown>;
  signalAllAcceptedCredentials?: (input: {
    rpId: string;
    userId: string;
    allAcceptedCredentialIds: string[];
  }) => Promise<unknown>;
  signalCurrentUserDetails?: (input: {
    rpId: string;
    userId: string;
    name: string;
    displayName: string;
  }) => Promise<unknown>;
}

/**
 * Tells the passkey provider of the browser (plan 12i). Each call answers
 * true when the browser has the method and it settled, else false. It
 * never throws: a signal is advice to the device, so a failure must not
 * break the flow that sends it. It sends nothing to the server.
 */
export async function signalPasskeys<K extends keyof SignalStatic>(
  method: K,
  input: Parameters<NonNullable<SignalStatic[K]>>[0],
): Promise<boolean> {
  const pkc = (globalThis as { PublicKeyCredential?: SignalStatic }).PublicKeyCredential;
  const fn = pkc?.[method];
  if (typeof fn !== "function") return false;
  try {
    await (fn as (i: typeof input) => Promise<unknown>).call(pkc, input);
    return true;
  } catch {
    return false;
  }
}

export function supportsPasskeys(): boolean {
  return pkcStatic() !== undefined;
}

/**
 * True when the browser can offer passkeys in the autofill of a field with
 * `autocomplete="username webauthn"` (conditional mediation, WebAuthn Level 3).
 */
export async function supportsAutofill(): Promise<boolean> {
  const pkc = pkcStatic();
  if (typeof pkc?.isConditionalMediationAvailable !== "function") return false;
  try {
    return await pkc.isConditionalMediationAvailable();
  } catch {
    return false;
  }
}

export function base64UrlEncode(bytes: ArrayBuffer | ArrayBufferView): string {
  const view =
    bytes instanceof ArrayBuffer
      ? new Uint8Array(bytes)
      : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let bin = "";
  for (const b of view) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(s: string): ArrayBuffer {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** PRF values `{ first, second? }` with each base64url string as bytes. */
function binaryPrfValues(values: unknown): unknown {
  if (!isRecord(values)) return values;
  const out: Record<string, unknown> = { ...values };
  for (const key of ["first", "second"] as const) {
    const v = values[key];
    if (typeof v === "string") out[key] = base64UrlDecode(v);
  }
  return out;
}

/**
 * The binary fields of the extension inputs (plan 12i): the PRF salts and a
 * large blob to write. The browser's own parser does the same.
 */
function binaryExtensions(extensions: unknown): unknown {
  if (!isRecord(extensions)) return extensions;
  const out: Record<string, unknown> = { ...extensions };
  const prf = extensions.prf;
  if (isRecord(prf)) {
    const binary: Record<string, unknown> = { ...prf };
    if (prf.eval !== undefined) binary.eval = binaryPrfValues(prf.eval);
    if (isRecord(prf.evalByCredential)) {
      const byCredential: Record<string, unknown> = {};
      for (const [id, values] of Object.entries(prf.evalByCredential))
        byCredential[id] = binaryPrfValues(values);
      binary.evalByCredential = byCredential;
    }
    out.prf = binary;
  }
  const largeBlob = extensions.largeBlob;
  if (isRecord(largeBlob) && typeof largeBlob.write === "string")
    out.largeBlob = { ...largeBlob, write: base64UrlDecode(largeBlob.write) };
  return out;
}

/** The options with their extension inputs in binary form, when they have some. */
function withBinaryExtensions<T extends object>(options: T): T {
  const extensions = (options as { extensions?: unknown }).extensions;
  return extensions === undefined
    ? options
    : ({ ...options, extensions: binaryExtensions(extensions) } as T);
}

/**
 * The package's own `parseCreationOptionsFromJSON`. Only the fields WebAuthn
 * defines as binary change; every other field passes through.
 */
export function toBinaryCreationOptions(
  json: PublicKeyCredentialCreationOptionsJSON,
): PublicKeyCredentialCreationOptions {
  const { challenge, user, excludeCredentials, ...rest } = withBinaryExtensions(json);
  return {
    ...(rest as Omit<
      PublicKeyCredentialCreationOptions,
      "challenge" | "user" | "excludeCredentials"
    >),
    challenge: base64UrlDecode(challenge),
    user: { ...user, id: base64UrlDecode(user.id) },
    ...(excludeCredentials
      ? {
          excludeCredentials: excludeCredentials.map(
            (c) => ({ ...c, id: base64UrlDecode(c.id) }) as PublicKeyCredentialDescriptor,
          ),
        }
      : {}),
  };
}

export function toBinaryRequestOptions(
  json: PublicKeyCredentialRequestOptionsJSON,
): PublicKeyCredentialRequestOptions {
  const { challenge, allowCredentials, ...rest } = withBinaryExtensions(json);
  return {
    ...(rest as Omit<PublicKeyCredentialRequestOptions, "challenge" | "allowCredentials">),
    challenge: base64UrlDecode(challenge),
    ...(allowCredentials
      ? {
          allowCredentials: allowCredentials.map(
            (c) => ({ ...c, id: base64UrlDecode(c.id) }) as PublicKeyCredentialDescriptor,
          ),
        }
      : {}),
  };
}

function isBinary(value: unknown): value is ArrayBuffer | ArrayBufferView {
  return value instanceof ArrayBuffer || ArrayBuffer.isView(value);
}

/**
 * The client extension outputs in JSON form, as the browser's `toJSON()`
 * writes them: the PRF results and a large blob as base64url (plan 12i).
 */
function extensionResultsToJSON(results: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...results };
  const prf = results.prf;
  if (isRecord(prf) && isRecord(prf.results)) {
    const values: Record<string, unknown> = { ...prf.results };
    for (const key of ["first", "second"] as const) {
      const v = prf.results[key];
      if (isBinary(v)) values[key] = base64UrlEncode(v);
    }
    out.prf = { ...prf, results: values };
  }
  const largeBlob = results.largeBlob;
  if (isRecord(largeBlob) && isBinary(largeBlob.blob))
    out.largeBlob = { ...largeBlob, blob: base64UrlEncode(largeBlob.blob) };
  return out;
}

/**
 * The outputs of one ceremony that stay in the browser (plan 12i): the PRF
 * results and a large blob, each as base64url. The client never sends them
 * to the server; it gives them to the app.
 */
export interface PasskeyExtensionResults {
  prf?: { first: string; second?: string };
  largeBlob?: string;
}

/**
 * Splits a ceremony response in two: the response without `prf.results`
 * and `largeBlob.blob`, which the client sends, and those two outputs,
 * which stay in the browser (plan 12i). The server drops both again, so a
 * client that sends them still has no output stored or logged.
 */
export function splitExtensionResults<T extends object>(
  response: T,
): { response: T; results: PasskeyExtensionResults } {
  const outputs = (response as { clientExtensionResults?: unknown }).clientExtensionResults;
  if (!isRecord(outputs)) return { response, results: {} };
  const kept: Record<string, unknown> = { ...outputs };
  const results: PasskeyExtensionResults = {};
  const asText = (v: unknown): string | null =>
    typeof v === "string" ? v : isBinary(v) ? base64UrlEncode(v) : null;
  const prf = outputs.prf;
  if (isRecord(prf) && "results" in prf) {
    const { results: values, ...rest } = prf;
    kept.prf = rest;
    const first = isRecord(values) ? asText(values.first) : null;
    const second = isRecord(values) ? asText(values.second) : null;
    if (first !== null) results.prf = second === null ? { first } : { first, second };
  }
  const largeBlob = outputs.largeBlob;
  if (isRecord(largeBlob) && "blob" in largeBlob) {
    const { blob, ...rest } = largeBlob;
    kept.largeBlob = rest;
    const text = asText(blob);
    if (text !== null) results.largeBlob = text;
  }
  return { response: { ...response, clientExtensionResults: kept }, results };
}

/** The package's own `toJSON()`. Field names follow the WebAuthn Level 3 JSON serialization. */
export function credentialToJSON(
  credential: PublicKeyCredentialLike,
): RegistrationResponseJSON | AuthenticationResponseJSON {
  const r = credential.response;
  const response: Record<string, unknown> = { clientDataJSON: base64UrlEncode(r.clientDataJSON) };
  if (r.attestationObject) response.attestationObject = base64UrlEncode(r.attestationObject);
  if (r.authenticatorData) response.authenticatorData = base64UrlEncode(r.authenticatorData);
  if (r.signature) response.signature = base64UrlEncode(r.signature);
  if (r.userHandle) response.userHandle = base64UrlEncode(r.userHandle);
  if (typeof r.getTransports === "function") response.transports = r.getTransports();
  const json: Record<string, unknown> = {
    id: credential.id,
    rawId: base64UrlEncode(credential.rawId),
    type: credential.type,
    clientExtensionResults: extensionResultsToJSON(credential.getClientExtensionResults()),
    response,
  };
  if (credential.authenticatorAttachment != null)
    json.authenticatorAttachment = credential.authenticatorAttachment;
  return json as unknown as RegistrationResponseJSON | AuthenticationResponseJSON;
}

/**
 * A dismissed prompt, no matching authenticator, or an aborted autofill. An
 * abort rejects with the signal's reason: `abort()` with no argument makes it
 * a DOMException named AbortError (WebAuthn Level 3, read 2026-10-15).
 */
function cancelled(e: unknown): boolean {
  const name = typeof e === "object" && e !== null ? (e as { name?: unknown }).name : undefined;
  return name === "NotAllowedError" || name === "AbortError";
}

/**
 * The seam over `navigator.credentials`. When the browser has the Level 3
 * JSON parsers and `toJSON`, it uses them; otherwise the package converts.
 * The fallback exists because the parsers arrived late (Chrome 129, Firefox
 * 119, Safari 18.4), and the client must work where they are missing.
 */
export function browserWebAuthn(container?: CredentialsContainerLike): BrowserWebAuthn {
  const creds = () => {
    const c =
      container ??
      (globalThis as { navigator?: { credentials?: CredentialsContainerLike } }).navigator
        ?.credentials;
    if (!c) throw new Error("navigator.credentials is not available");
    return c;
  };
  const toJSON = (cred: unknown) => {
    const c = cred as PublicKeyCredentialLike;
    return typeof c.toJSON === "function"
      ? (c.toJSON() as RegistrationResponseJSON & AuthenticationResponseJSON)
      : (credentialToJSON(c) as RegistrationResponseJSON & AuthenticationResponseJSON);
  };
  return {
    async create(options) {
      const parse = pkcStatic()?.parseCreationOptionsFromJSON;
      const publicKey = parse ? parse(options) : toBinaryCreationOptions(options);
      try {
        return toJSON(await creds().create({ publicKey }));
      } catch (e) {
        if (cancelled(e)) throw new WebAuthnCancelled();
        throw e;
      }
    },
    async get(options, ceremony) {
      const parse = pkcStatic()?.parseRequestOptionsFromJSON;
      const publicKey = parse ? parse(options) : toBinaryRequestOptions(options);
      try {
        return toJSON(
          await creds().get({
            publicKey,
            ...(ceremony?.mediation ? { mediation: ceremony.mediation } : {}),
            ...(ceremony?.signal ? { signal: ceremony.signal } : {}),
          }),
        );
      } catch (e) {
        if (cancelled(e)) throw new WebAuthnCancelled();
        throw e;
      }
    },
  };
}
