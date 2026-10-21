import { fromBase64Url, toBase64Url } from "../primitives/crypto.js";

/**
 * A WebAuthn authenticator in software, on Web Crypto only. It produces
 * registration and authentication responses in the JSON shape a browser's
 * `PublicKeyCredential.toJSON()` returns, with a `none` attestation and
 * an ES256 key, so a test proves the server-side ceremonies without a
 * browser. It is a test tool. It never ships in an app.
 */
export interface SoftAuthenticatorOptions {
  rpID: string;
  origin: string;
  /** Sets the BE and BS flags, as a synced passkey does. Default false. */
  backedUp?: boolean;
  /** Clears the UV flag when false, to test that a server requires it. Default true. */
  userVerified?: boolean;
  /** The bytes of the credential id. Default 16. WebAuthn allows at most 1023. */
  credentialIdBytes?: number;
}

export interface SoftRegistrationResponse {
  id: string;
  rawId: string;
  type: "public-key";
  authenticatorAttachment: "platform";
  clientExtensionResults: Record<string, never>;
  response: { clientDataJSON: string; attestationObject: string; transports: string[] };
}

export interface SoftAuthenticationResponse {
  id: string;
  rawId: string;
  type: "public-key";
  authenticatorAttachment: "platform";
  clientExtensionResults: Record<string, never>;
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    userHandle?: string;
  };
}

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;
const FLAG_AT = 0x40;

/** A fresh array on its own ArrayBuffer, which is the type Web Crypto accepts. */
type Bytes = Uint8Array<ArrayBuffer>;

export class SoftAuthenticator {
  readonly credentialId: string;
  /** The last counter sent. `authenticate` sends counter + 1 unless told otherwise. */
  counter = 0;
  /** Read at ceremony time. Set it to false to send a response without the UV flag. */
  userVerified: boolean;
  private userHandle: Uint8Array | null = null;

  private constructor(
    private readonly opts: SoftAuthenticatorOptions,
    private readonly keys: CryptoKeyPair,
    private readonly credentialIdBytes: Uint8Array,
  ) {
    this.credentialId = toBase64Url(credentialIdBytes);
    this.userVerified = opts.userVerified !== false;
  }

  static async create(opts: SoftAuthenticatorOptions): Promise<SoftAuthenticator> {
    const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const id = new Uint8Array(opts.credentialIdBytes ?? 16);
    crypto.getRandomValues(id);
    return new SoftAuthenticator(opts, keys, id);
  }

  publicKeyJwk(): Promise<JsonWebKey> {
    return crypto.subtle.exportKey("jwk", this.keys.publicKey);
  }

  async register(challenge: string, userHandle?: Uint8Array): Promise<SoftRegistrationResponse> {
    this.userHandle = userHandle ?? null;
    const clientDataJSON = this.clientData("webauthn.create", challenge, this.opts.origin);
    const authData = concat(
      await sha256(utf8(this.opts.rpID)),
      new Uint8Array([FLAG_UP | this.uvFlag() | FLAG_AT | this.backupFlags()]),
      counterBytes(0),
      new Uint8Array(16), // aaguid, zero for a software authenticator
      new Uint8Array([this.credentialIdBytes.length >> 8, this.credentialIdBytes.length & 0xff]),
      this.credentialIdBytes,
      await this.coseKey(),
    );
    const attestationObject = cborMap([
      [cborText("fmt"), cborText("none")],
      [cborText("attStmt"), cborMap([])],
      [cborText("authData"), cborBytes(authData)],
    ]);
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: "public-key",
      authenticatorAttachment: "platform",
      clientExtensionResults: {},
      response: {
        clientDataJSON: toBase64Url(clientDataJSON),
        attestationObject: toBase64Url(attestationObject),
        transports: ["internal"],
      },
    };
  }

  async authenticate(
    challenge: string,
    opts: { counter?: number; origin?: string } = {},
  ): Promise<SoftAuthenticationResponse> {
    const counter = opts.counter ?? this.counter + 1;
    this.counter = counter;
    const clientDataJSON = this.clientData(
      "webauthn.get",
      challenge,
      opts.origin ?? this.opts.origin,
    );
    const authData = concat(
      await sha256(utf8(this.opts.rpID)),
      new Uint8Array([FLAG_UP | this.uvFlag() | this.backupFlags()]),
      counterBytes(counter),
    );
    const signed = concat(authData, await sha256(clientDataJSON));
    const raw = new Uint8Array(
      await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.keys.privateKey, signed),
    );
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: "public-key",
      authenticatorAttachment: "platform",
      clientExtensionResults: {},
      response: {
        clientDataJSON: toBase64Url(clientDataJSON),
        authenticatorData: toBase64Url(authData),
        signature: toBase64Url(derSignature(raw)),
        ...(this.userHandle ? { userHandle: toBase64Url(this.userHandle) } : {}),
      },
    };
  }

  private uvFlag(): number {
    return this.userVerified ? FLAG_UV : 0;
  }

  private backupFlags(): number {
    return this.opts.backedUp ? FLAG_BE | FLAG_BS : 0;
  }

  private clientData(type: string, challenge: string, origin: string): Bytes {
    return utf8(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  /** COSE_Key for EC2 P-256 ES256: {1: 2, 3: -7, -1: 1, -2: x, -3: y}. */
  private async coseKey(): Promise<Uint8Array> {
    const jwk = await this.publicKeyJwk();
    return cborMap([
      [cborInt(1), cborInt(2)],
      [cborInt(3), cborInt(-7)],
      [cborInt(-1), cborInt(1)],
      [cborInt(-2), cborBytes(fromBase64Url(jwk.x ?? ""))],
      [cborInt(-3), cborBytes(fromBase64Url(jwk.y ?? ""))],
    ]);
  }
}

function utf8(text: string): Bytes {
  return new TextEncoder().encode(text);
}

async function sha256(bytes: Bytes): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function counterBytes(n: number): Bytes {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

// A minimal CBOR encoder: unsigned and negative integers below 65536,
// byte strings, text strings, and maps. That is all an attestation
// object and a COSE key need.
function cborHead(major: number, n: number): Bytes {
  const m = major << 5;
  if (n < 24) return new Uint8Array([m | n]);
  if (n < 256) return new Uint8Array([m | 24, n]);
  return new Uint8Array([m | 25, n >> 8, n & 0xff]);
}

function cborInt(n: number): Bytes {
  return n >= 0 ? cborHead(0, n) : cborHead(1, -1 - n);
}

function cborBytes(b: Uint8Array): Bytes {
  return concat(cborHead(2, b.length), b);
}

function cborText(s: string): Bytes {
  const b = utf8(s);
  return concat(cborHead(3, b.length), b);
}

function cborMap(entries: [Uint8Array, Uint8Array][]): Bytes {
  return concat(cborHead(5, entries.length), ...entries.flat());
}

/** Raw r||s (64 bytes) to DER SEQUENCE { INTEGER r, INTEGER s }, as WebAuthn sends it. */
function derSignature(raw: Uint8Array): Bytes {
  const r = derInteger(raw.slice(0, 32));
  const s = derInteger(raw.slice(32, 64));
  const body = concat(r, s);
  return concat(new Uint8Array([0x30, body.length]), body);
}

function derInteger(bytes: Uint8Array): Bytes {
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0) i++;
  let v = bytes.slice(i);
  if ((v[0] ?? 0) & 0x80) v = concat(new Uint8Array([0]), v);
  return concat(new Uint8Array([0x02, v.length]), v);
}

/** Every route that core can serve (plan 11a), for the docs checks and an app's own route tests. */
export { ROUTES, type RouteEntry, type RouteFeature } from "../routes.js";

/**
 * The app secret of the tests (plan 12b): 32 hex characters with 16
 * distinct ones, an estimate of 128 bits, so `createAuth` takes it with no
 * warning. Never use it in a deployment.
 */
export const TEST_SECRET = "0123456789abcdef0123456789abcdef";

/**
 * A software authenticator app for tests (plan 9f): the code that an app
 * shows for a base32 secret at a time. It is a test tool, as the passkey
 * authenticator above is.
 */
export { base32Decode, totpCode } from "../primitives/totp.js";
