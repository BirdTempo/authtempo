/**
 * A minimal DER reader for one X.509 certificate (plan 12d). It reads only the fields that
 * the SAML verifier needs: the subject public key and the end of the validity. It checks no
 * chain and no revocation: the configured certificate is the trust anchor, as in SAML
 * metadata practice. Each fault answers null, never a throw.
 */

export interface CertificateInfo {
  spki: Uint8Array<ArrayBuffer>;
  key: "rsa" | "ec-p256";
  notAfter: Date;
}

const TAG_INTEGER = 0x02;
const TAG_BIT_STRING = 0x03;
const TAG_NULL = 0x05;
const TAG_OID = 0x06;
const TAG_UTC_TIME = 0x17;
const TAG_GENERALIZED_TIME = 0x18;
const TAG_SEQUENCE = 0x30;
const TAG_VERSION = 0xa0;

// The content bytes of each object identifier that the reader accepts.
const OID_RSA_ENCRYPTION = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01];
const OID_EC_PUBLIC_KEY = [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01];
const OID_PRIME256V1 = [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07];

/** The smallest RSA modulus that the profile accepts (spec 30 item 7). */
export const RSA_MIN_BITS = 2048;

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Strict base64 (RFC 4648 section 4) with the padding, after the removal of each character
 * of `drop`. Any other character outside the alphabet answers null.
 */
export function strictBase64(text: string, drop: RegExp): Uint8Array<ArrayBuffer> | null {
  const body = text.replace(drop, "");
  if (body.length % 4 !== 0 || !BASE64_RE.test(body)) return null;
  let bin: string;
  try {
    bin = atob(body);
  } catch {
    return null;
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** One TLV: the tag, the offset of the tag byte, the start of the content, and the end. */
interface Tlv {
  tag: number;
  at: number;
  start: number;
  end: number;
}

/**
 * Reads one element at `at` that must end at or before `limit`. A high tag number, an
 * indefinite length, a length of more than four bytes, and a non-minimal length answer null.
 */
function readTlv(bytes: Uint8Array, at: number, limit: number): Tlv | null {
  if (at + 2 > limit) return null;
  const tag = bytes[at] ?? 0;
  if ((tag & 0x1f) === 0x1f) return null;
  const first = bytes[at + 1] ?? 0;
  let length = 0;
  let start = at + 2;
  if (first < 0x80) {
    length = first;
  } else {
    const count = first & 0x7f;
    if (count === 0 || count > 4 || start + count > limit) return null;
    for (let k = 0; k < count; k++) length = length * 256 + (bytes[start + k] ?? 0);
    // DER: the long form only for a length of 128 or more, with no leading zero byte.
    if (length < 0x80 || (bytes[start] ?? 0) === 0) return null;
    start += count;
  }
  const end = start + length;
  if (end > limit) return null;
  return { tag, at, start, end };
}

/** Reads one element of the expected tag, or null. */
function expect(bytes: Uint8Array, at: number, limit: number, tag: number): Tlv | null {
  const tlv = readTlv(bytes, at, limit);
  return tlv !== null && tlv.tag === tag ? tlv : null;
}

function contentIs(bytes: Uint8Array, tlv: Tlv, want: readonly number[]): boolean {
  if (tlv.end - tlv.start !== want.length) return false;
  for (let k = 0; k < want.length; k++) if (bytes[tlv.start + k] !== want[k]) return false;
  return true;
}

function digits(bytes: Uint8Array, from: number, count: number): number | null {
  let n = 0;
  for (let k = 0; k < count; k++) {
    const c = bytes[from + k] ?? 0;
    if (c < 0x30 || c > 0x39) return null;
    n = n * 10 + (c - 0x30);
  }
  return n;
}

/**
 * A `UTCTime` (`YYMMDDHHMMSSZ`) or a `GeneralizedTime` (`YYYYMMDDHHMMSSZ`) in the form of
 * RFC 5280 section 4.1.2.5. A two-digit year of 50 or more is 19YY, else 20YY.
 */
function readTime(bytes: Uint8Array, tlv: Tlv): Date | null {
  const yearDigits = tlv.tag === TAG_UTC_TIME ? 2 : tlv.tag === TAG_GENERALIZED_TIME ? 4 : 0;
  if (yearDigits === 0 || tlv.end - tlv.start !== yearDigits + 11) return null;
  if (bytes[tlv.end - 1] !== 0x5a) return null;
  const year2 = digits(bytes, tlv.start, yearDigits);
  const rest = [0, 1, 2, 3, 4].map((k) => digits(bytes, tlv.start + yearDigits + 2 * k, 2));
  if (year2 === null || rest.some((v) => v === null)) return null;
  const [month = 0, day = 0, hour = 0, minute = 0, second = 0] = rest as number[];
  const year = yearDigits === 4 ? year2 : year2 >= 50 ? 1900 + year2 : 2000 + year2;
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  const date = new Date(ms);
  // A field out of its range (month 13, second 60) moves the date: refuse it.
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  )
    return null;
  return date;
}

/** The DER bytes of one PEM `CERTIFICATE` block, or null. */
function pemBody(pem: string): Uint8Array<ArrayBuffer> | null {
  const begin = "-----BEGIN CERTIFICATE-----";
  const end = "-----END CERTIFICATE-----";
  const text = pem.trim();
  if (!text.startsWith(begin) || !text.endsWith(end)) return null;
  const inner = text.slice(begin.length, text.length - end.length);
  // A second block puts a dash inside, which the base64 alphabet refuses.
  return strictBase64(inner, /[\r\n]/g);
}

/**
 * Reads the key and `notAfter` of one PEM certificate. The key is RSA (`rsaEncryption`) or
 * EC on P-256 (`id-ecPublicKey` with `prime256v1`); any other key answers null.
 */
export function readCertificate(pem: string): CertificateInfo | null {
  const der = pemBody(pem);
  if (der === null) return null;
  const cert = expect(der, 0, der.length, TAG_SEQUENCE);
  // Trailing bytes after the outer SEQUENCE answer null.
  if (cert === null || cert.end !== der.length) return null;

  const tbs = expect(der, cert.start, cert.end, TAG_SEQUENCE);
  if (tbs === null) return null;
  const sigAlg = expect(der, tbs.end, cert.end, TAG_SEQUENCE);
  if (sigAlg === null) return null;
  const sigValue = expect(der, sigAlg.end, cert.end, TAG_BIT_STRING);
  if (sigValue === null || sigValue.end !== cert.end) return null;

  let at = tbs.start;
  const first = readTlv(der, at, tbs.end);
  if (first === null) return null;
  if (first.tag === TAG_VERSION) at = first.end;
  const serial = expect(der, at, tbs.end, TAG_INTEGER);
  if (serial === null) return null;
  const signature = expect(der, serial.end, tbs.end, TAG_SEQUENCE);
  if (signature === null) return null;
  const issuer = expect(der, signature.end, tbs.end, TAG_SEQUENCE);
  if (issuer === null) return null;
  const validity = expect(der, issuer.end, tbs.end, TAG_SEQUENCE);
  if (validity === null) return null;
  const subject = expect(der, validity.end, tbs.end, TAG_SEQUENCE);
  if (subject === null) return null;
  const spki = expect(der, subject.end, tbs.end, TAG_SEQUENCE);
  if (spki === null) return null;

  const notBefore = readTlv(der, validity.start, validity.end);
  if (notBefore === null || readTime(der, notBefore) === null) return null;
  const notAfterTlv = readTlv(der, notBefore.end, validity.end);
  if (notAfterTlv === null || notAfterTlv.end !== validity.end) return null;
  const notAfter = readTime(der, notAfterTlv);
  if (notAfter === null) return null;

  const algorithm = expect(der, spki.start, spki.end, TAG_SEQUENCE);
  if (algorithm === null) return null;
  const keyBits = expect(der, algorithm.end, spki.end, TAG_BIT_STRING);
  if (keyBits === null || keyBits.end !== spki.end) return null;
  const oid = expect(der, algorithm.start, algorithm.end, TAG_OID);
  if (oid === null) return null;
  const params = readTlv(der, oid.end, algorithm.end);
  if (params === null || params.end !== algorithm.end) return null;

  let key: CertificateInfo["key"];
  if (contentIs(der, oid, OID_RSA_ENCRYPTION)) {
    // RFC 3279 section 2.3.1: the parameters are NULL.
    if (params.tag !== TAG_NULL || params.end !== params.start) return null;
    key = "rsa";
  } else if (contentIs(der, oid, OID_EC_PUBLIC_KEY)) {
    if (params.tag !== TAG_OID || !contentIs(der, params, OID_PRIME256V1)) return null;
    key = "ec-p256";
  } else {
    return null;
  }

  return { spki: der.slice(spki.at, spki.end), key, notAfter };
}

/**
 * Imports the public key of `info` for `verify` only: RSASSA-PKCS1-v1_5 with SHA-256, or
 * ECDSA on P-256. An RSA modulus under 2048 bits, or a key that Web Crypto refuses, answers null.
 */
export async function importVerifyKey(info: CertificateInfo): Promise<CryptoKey | null> {
  try {
    if (info.key === "rsa") {
      const key = await crypto.subtle.importKey(
        "spki",
        info.spki,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
      const bits = (key.algorithm as RsaHashedKeyAlgorithm).modulusLength;
      return bits >= RSA_MIN_BITS ? key : null;
    }
    return await crypto.subtle.importKey(
      "spki",
      info.spki,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
  } catch {
    return null;
  }
}
