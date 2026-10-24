/**
 * A DER writer for test certificates (plan 12d). It is test code: the SAML test IdP and the
 * DER reader tests make self-signed X.509 certificates with it. No product code imports it.
 */

/** One DER element: the tag, the length in the shortest form, and the content. */
export function tlv(tag: number, content: Uint8Array): Uint8Array<ArrayBuffer> {
  const n = content.length;
  const len: number[] = [];
  if (n < 0x80) len.push(n);
  else {
    const bytes: number[] = [];
    for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
    len.push(0x80 | bytes.length, ...bytes);
  }
  const out = new Uint8Array(1 + len.length + n);
  out[0] = tag;
  out.set(len, 1);
  out.set(content, 1 + len.length);
  return out;
}

export function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export const seq = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => tlv(0x30, concat(...parts));
export const set = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => tlv(0x31, concat(...parts));
export const nullValue = (): Uint8Array<ArrayBuffer> => tlv(0x05, new Uint8Array(0));
export const explicit = (n: number, inner: Uint8Array): Uint8Array<ArrayBuffer> =>
  tlv(0xa0 | n, inner);
export const bitString = (bytes: Uint8Array): Uint8Array<ArrayBuffer> =>
  tlv(0x03, concat(new Uint8Array([0]), bytes));
export const utf8 = (text: string): Uint8Array<ArrayBuffer> =>
  tlv(0x0c, new TextEncoder().encode(text));

/** An INTEGER from unsigned big-endian bytes: leading zeros off, a zero byte before a high bit. */
export function uint(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  let from = 0;
  while (from < bytes.length - 1 && bytes[from] === 0) from++;
  const body = bytes.slice(from);
  const high = (body[0] ?? 0) & 0x80;
  return tlv(0x02, high ? concat(new Uint8Array([0]), body) : body);
}

/** An OBJECT IDENTIFIER from its dotted form. */
export function oid(dotted: string): Uint8Array<ArrayBuffer> {
  const arcs = dotted.split(".").map(Number);
  const [a = 0, b = 0, ...rest] = arcs;
  const out: number[] = [40 * a + b];
  for (const arc of rest) {
    const bytes: number[] = [arc & 0x7f];
    for (let v = Math.floor(arc / 128); v > 0; v = Math.floor(v / 128))
      bytes.unshift(0x80 | (v & 0x7f));
    out.push(...bytes);
  }
  return tlv(0x06, new Uint8Array(out));
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

/** RFC 5280 section 4.1.2.5: a `UTCTime` through 2049, a `GeneralizedTime` after. */
export function time(date: Date): Uint8Array<ArrayBuffer> {
  const y = date.getUTCFullYear();
  const rest =
    pad(date.getUTCMonth() + 1, 2) +
    pad(date.getUTCDate(), 2) +
    pad(date.getUTCHours(), 2) +
    pad(date.getUTCMinutes(), 2) +
    pad(date.getUTCSeconds(), 2) +
    "Z";
  if (y >= 1950 && y < 2050) return tlv(0x17, new TextEncoder().encode(pad(y % 100, 2) + rest));
  return tlv(0x18, new TextEncoder().encode(pad(y, 4) + rest));
}

/** A Name with one `commonName` attribute. */
export function name(commonName: string): Uint8Array<ArrayBuffer> {
  return seq(set(seq(oid("2.5.4.3"), utf8(commonName))));
}

export const OIDS = {
  rsaEncryption: "1.2.840.113549.1.1.1",
  sha256WithRSAEncryption: "1.2.840.113549.1.1.11",
  ecPublicKey: "1.2.840.10045.2.1",
  prime256v1: "1.2.840.10045.3.1.7",
  ecdsaWithSha256: "1.2.840.10045.4.3.2",
  dsa: "1.2.840.10040.4.1",
} as const;

/** The 64-byte `r || s` form of Web Crypto as the DER `ECDSA-Sig-Value` of RFC 3279. */
export function ecdsaDer(raw: Uint8Array): Uint8Array<ArrayBuffer> {
  return seq(uint(raw.slice(0, 32)), uint(raw.slice(32)));
}

export interface CertificateInput {
  /** The DER SubjectPublicKeyInfo, from `exportKey("spki")` or written by hand. */
  spki: Uint8Array;
  /** The key that signs the TBS bytes: RSA PKCS #1 v1.5 or ECDSA P-256, with SHA-256. */
  signer: CryptoKey;
  commonName: string;
  notBefore: Date;
  notAfter: Date;
  serial?: Uint8Array;
}

/** A self-signed X.509 v3 certificate with no extensions, as DER bytes. */
export async function certificateDer(input: CertificateInput): Promise<Uint8Array<ArrayBuffer>> {
  const rsa = input.signer.algorithm.name === "RSASSA-PKCS1-v1_5";
  const sigAlg = rsa
    ? seq(oid(OIDS.sha256WithRSAEncryption), nullValue())
    : seq(oid(OIDS.ecdsaWithSha256));
  const serial = input.serial ?? crypto.getRandomValues(new Uint8Array(16));
  const tbs = seq(
    explicit(0, uint(new Uint8Array([2]))),
    uint(serial),
    sigAlg,
    name(input.commonName),
    seq(time(input.notBefore), time(input.notAfter)),
    name(input.commonName),
    input.spki,
  );
  const raw = new Uint8Array(
    rsa
      ? await crypto.subtle.sign("RSASSA-PKCS1-v1_5", input.signer, tbs)
      : await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, input.signer, tbs),
  );
  return seq(tbs, sigAlg, bitString(rsa ? raw : ecdsaDer(raw)));
}

/** The PEM text of DER bytes, in lines of 64 characters. */
export function pem(label: string, der: Uint8Array): string {
  let bin = "";
  for (const b of der) bin += String.fromCharCode(b);
  const lines = btoa(bin).match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}
