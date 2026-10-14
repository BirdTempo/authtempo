import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@authtempo/core";

/** How one ceremony runs (plan 11d). `mediation: "conditional"` waits for the autofill of a field. */
export interface CeremonyOptions {
  mediation?: "conditional" | undefined;
  /** Aborts a waiting ceremony; the seam then throws `WebAuthnCancelled`. */
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

/**
 * The package's own `parseCreationOptionsFromJSON`. Only the fields WebAuthn
 * defines as binary change; every other field passes through.
 */
export function toBinaryCreationOptions(
  json: PublicKeyCredentialCreationOptionsJSON,
): PublicKeyCredentialCreationOptions {
  const { challenge, user, excludeCredentials, ...rest } = json;
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
  const { challenge, allowCredentials, ...rest } = json;
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
    clientExtensionResults: credential.getClientExtensionResults(),
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
