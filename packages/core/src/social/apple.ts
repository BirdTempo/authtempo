import { type Provider, stringClaim } from "./provider.js";

export interface AppleConfig {
  /** The Services ID for web sign-in, for example `com.example.web`. */
  clientId: string;
  teamId: string;
  keyId: string;
  /** PKCS#8 PEM of the Sign in with Apple key. Rotate it in the developer portal; this config is the only copy. */
  privateKey: string;
}

const APPLE_AUDIENCE = "https://appleid.apple.com";
/** Apple allows up to six months. Five minutes covers one exchange and never needs rotation. */
const CLIENT_SECRET_LIFE_SECONDS = 300;

/** Endpoints from Apple's "Sign in with Apple REST API" docs, checked 2026-10-09. */
export function appleProvider(c: AppleConfig): Provider {
  return {
    name: "apple",
    authorizeUrl: "https://appleid.apple.com/auth/authorize",
    tokenUrl: "https://appleid.apple.com/auth/token",
    jwksUrl: "https://appleid.apple.com/auth/keys",
    issuer: [APPLE_AUDIENCE],
    clientId: c.clientId,
    scope: "name email",
    // Apple requires form_post when the scope has name or email. The
    // callback is then a cross-site POST, so its route allows that.
    authorizeParams: { response_mode: "form_post" },
    callbackMethod: "POST",
    async clientSecret(ctx) {
      const iat = Math.floor(ctx.now.getTime() / 1000);
      return ctx.jwt.signES256({
        privateKeyPem: c.privateKey,
        keyId: c.keyId,
        payload: {
          iss: c.teamId,
          sub: c.clientId,
          aud: APPLE_AUDIENCE,
          iat,
          exp: iat + CLIENT_SECRET_LIFE_SECONDS,
        },
      });
    },
    profile(claims, extra) {
      const verified = claims.email_verified;
      return {
        subject: stringClaim(claims, "sub") ?? "",
        email: stringClaim(claims, "email"),
        // Apple sends a boolean or the string "true".
        emailVerified: verified === true || verified === "true",
        name: nameFromUserField(extra.user),
        image: null,
      };
    },
  };
}

/**
 * Apple posts `user` as JSON on the first sign-in only:
 * `{"name":{"firstName":"Ada","lastName":"Lovelace"},"email":"..."}`.
 * Anything that is not that shape gives null.
 */
function nameFromUserField(user: string | undefined): string | null {
  if (!user) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(user);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const name = (parsed as { name?: unknown }).name;
  if (typeof name !== "object" || name === null) return null;
  const { firstName, lastName } = name as { firstName?: unknown; lastName?: unknown };
  const parts = [firstName, lastName]
    .filter((p): p is string => typeof p === "string")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return parts.length ? parts.join(" ") : null;
}
