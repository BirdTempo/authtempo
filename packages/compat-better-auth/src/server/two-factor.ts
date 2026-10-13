import type { ClientCode } from "@tempo-auth/client";
import { type Auth, TWO_FACTOR_TOKEN_RE } from "@tempo-auth/core";
import { BETTER_AUTH_CODES, messageOf, NOT_SUPPORTED } from "../errors.js";
import type { Mapped } from "./map-options.js";
import { readToken, toUser } from "./shapes.js";

/**
 * Better Auth 1.7.2's two-factor paths (dist/plugins/two-factor/index.mjs,
 * totp/index.mjs, backup-codes/index.mjs, verify-two-factor.mjs, read
 * 2026-10-13), served by `auth.handler` with the `two-factor` plugin (plan
 * 9f), in Better Auth's shapes. An error answers Better Auth's body
 * `{ code, message }`. The cookie names are Better Auth's: `two_factor`
 * holds core's `tf_` challenge, and `trust_device` is core's trust cookie
 * under `totp.trustCookieName`.
 */
export const TWO_FACTOR_COOKIE = "better-auth.two_factor";
export const TRUST_DEVICE_COOKIE = "better-auth.trust_device";
/** Better Auth's twoFactorCookieMaxAge default. Core's challenge itself lives 5 minutes. */
const TWO_FACTOR_COOKIE_MAX_AGE = 600;
export const TWO_FACTOR_NOT_SUPPORTED: readonly string[] = [
  "/two-factor/send-otp",
  "/two-factor/verify-otp",
];
const ENABLE = "/two-factor/enable";
const DISABLE = "/two-factor/disable";
const URI = "/two-factor/get-totp-uri";
const CODES = "/two-factor/generate-backup-codes";
const VERIFY_TOTP = "/two-factor/verify-totp";
const VERIFY_BACKUP = "/two-factor/verify-backup-code";
const KNOWN = new Set([ENABLE, DISABLE, URI, CODES, VERIFY_TOTP, VERIFY_BACKUP]);
const NOT_SERVED = "core serves the TOTP second factor only; the email and SMS code is not mapped";
// Core's issuer rule (core config.ts, totp.issuer): 1 to 80 characters, no control character, no colon.
// biome-ignore lint/suspicious/noControlCharactersInRegex: the class names the control characters it refuses.
const ISSUER_RE = /^[^:\u0000-\u001f\u007f]{1,80}$/;

type Body = Record<string, unknown>;

function failure(code: string, status: number, message = messageOf(code), headers?: Headers) {
  return Response.json({ code, message }, { status, ...(headers ? { headers } : {}) });
}

async function readBody(request: Request): Promise<Body | null> {
  const v: unknown = await request
    .clone()
    .json()
    .catch(() => null);
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Body) : null;
}

/** One cookie of the request, never the bearer header. */
export function cookieValue(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim() || null;
  }
  return null;
}

const clearCookie = (name: string, path: string, sameSite: string) =>
  `${name}=; Path=${path}; Max-Age=0; HttpOnly; Secure; SameSite=${sameSite}`;

/** Better Auth's name for a core code on these paths. */
function codeFor(error: unknown, path: string): string {
  if (error === "invalid_code")
    return path === VERIFY_BACKUP ? "INVALID_BACKUP_CODE" : "INVALID_CODE";
  if (error === "too_many_attempts") return "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE";
  if (error === "totp_not_enabled")
    return path === CODES ? "TWO_FACTOR_NOT_ENABLED" : "TOTP_NOT_ENABLED";
  if (error === "invalid_credentials") return "INVALID_PASSWORD";
  return typeof error === "string" && Object.hasOwn(BETTER_AUTH_CODES, error)
    ? BETTER_AUTH_CODES[error as ClientCode]
    : BETTER_AUTH_CODES.unexpected;
}

/** Better Auth answers INVALID_PASSWORD with 400; core answers invalid_credentials with 401. */
const statusFor = (error: unknown, status: number) =>
  error === "invalid_credentials" ? 400 : status;

/**
 * The answer to one of Better Auth's two-factor paths, or null for any
 * other request, which the handler passes to core.
 */
export async function twoFactorRoute(
  auth: Auth,
  mapped: Mapped,
  request: Request,
): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (request.method !== "POST" || !pathname.startsWith(`${mapped.basePath}/two-factor/`))
    return null;
  const path = pathname.slice(mapped.basePath.length);
  if (TWO_FACTOR_NOT_SUPPORTED.includes(path)) return failure(NOT_SUPPORTED, 501, NOT_SERVED);
  if (!KNOWN.has(path)) return null;
  const totp = auth.api.totp;
  const pw = auth.api.password;
  if (!totp || !pw) return failure(BETTER_AUTH_CODES.not_found, 404);
  const body = await readBody(request);
  if (!body) return failure(BETTER_AUTH_CODES.invalid_body, 400);
  const sameSite = mapped.config.cookie?.sameSite ?? "Lax";
  const session = await auth.session(request);
  if (path === VERIFY_TOTP || path === VERIFY_BACKUP) {
    if (typeof body.code !== "string") return failure(BETTER_AUTH_CODES.invalid_body, 400);
    if (session) {
      // With a session, Better Auth's verify-totp confirms the setup.
      if (path === VERIFY_BACKUP)
        return failure(
          NOT_SUPPORTED,
          501,
          "core takes a backup code at the sign-in challenge only",
        );
      const r = await totp.enable({ session, code: body.code });
      if (!r.ok) return failure(codeFor(r.code, path), r.status);
      return Response.json({
        token: readToken(request.headers) ?? "",
        user: { ...toUser(session.user), twoFactorEnabled: true },
      });
    }
    if (body.disableSession === true)
      return failure(NOT_SUPPORTED, 501, "core opens a session at every second-factor verify");
    const challenge = cookieValue(request, TWO_FACTOR_COOKIE);
    if (!challenge) return failure("INVALID_TWO_FACTOR_COOKIE", 401);
    // Core's pattern first: a cookie of another shape (one that real Better
    // Auth set, or one over core's 64-character body bound) is no challenge.
    // Without this check core answers `invalid_body` 400 and the cookie stays.
    if (!TWO_FACTOR_TOKEN_RE.test(challenge)) {
      const cleared = new Headers();
      cleared.append("set-cookie", clearCookie(TWO_FACTOR_COOKIE, "/", sameSite));
      return failure("INVALID_TWO_FACTOR_COOKIE", 401, undefined, cleared);
    }
    const headers = new Headers(request.headers);
    headers.set("content-type", "application/json");
    headers.delete("content-length");
    const res = await auth.handle(
      new Request(`${mapped.origin}${mapped.basePath}/totp/verify`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          challenge,
          ...(path === VERIFY_BACKUP ? { backupCode: body.code } : { code: body.code }),
          trustDevice: body.trustDevice === true,
        }),
      }),
    );
    const out = (await res
      .clone()
      .json()
      .catch(() => null)) as Body | null;
    const answer = new Headers(res.headers);
    answer.delete("content-length");
    if (res.ok && out) {
      answer.append("set-cookie", clearCookie(TWO_FACTOR_COOKIE, "/", sameSite));
      const id = (out.user as { id?: unknown } | undefined)?.id;
      const row =
        typeof id === "string"
          ? await mapped.config.storage.findOne("user", [{ field: "id", op: "eq", value: id }])
          : null;
      if (!row) throw new Error("tempo-auth compat: the signed-in user is gone");
      return Response.json(
        { token: out.token, user: { ...toUser(row), twoFactorEnabled: true } },
        { status: 200, headers: answer },
      );
    }
    if (out?.error === "invalid_token") {
      answer.append("set-cookie", clearCookie(TWO_FACTOR_COOKIE, "/", sameSite));
      return failure("INVALID_TWO_FACTOR_COOKIE", 401, undefined, answer);
    }
    return failure(codeFor(out?.error, path), res.status, undefined, answer);
  }
  // Enable, disable, the URI, and the backup codes: a session and the password (Better Auth's rule).
  if (!session) return failure(BETTER_AUTH_CODES.unauthorized, 401);
  if (path === ENABLE && body.method !== undefined && body.method !== "totp")
    return failure(NOT_SUPPORTED, 501, NOT_SERVED);
  if (typeof body.password !== "string") return failure(BETTER_AUTH_CODES.invalid_body, 400);
  const userId = session.user.id;
  const ip = mapped.clientIp(request);
  if (path === ENABLE) {
    const issuer = body.issuer;
    if (issuer !== undefined && (typeof issuer !== "string" || !ISSUER_RE.test(issuer)))
      return failure(BETTER_AUTH_CODES.invalid_body, 400);
    // Core's setup checks the password itself (plan 9f final fix wave, review
    // I-1), with the same limits as `pw.verify`. One check, not two: a second
    // one here would spend the sign-in's limits twice per enable.
    const r = await totp.setup({
      userId,
      password: body.password,
      ip,
      ...(typeof issuer === "string" ? { issuer } : {}),
    });
    if (!r.ok) return failure(codeFor(r.code, path), statusFor(r.code, r.status));
    return Response.json({
      method: "totp",
      totpURI: r.value.uri,
      backupCodes: r.value.backupCodes,
    });
  }
  const proved = await pw.verify({ userId, password: body.password, ip });
  if (!proved.ok) return failure(codeFor(proved.code, path), statusFor(proved.code, proved.status));
  if (path === DISABLE) {
    const r = await totp.disable({ userId });
    if (!r.ok) return failure(codeFor(r.code, path), r.status);
    const res = Response.json({ status: true });
    res.headers.append(
      "set-cookie",
      clearCookie(TRUST_DEVICE_COOKIE, `${mapped.basePath}/`, sameSite),
    );
    return res;
  }
  if (path === URI) {
    const r = await totp.uri({ userId });
    return r.ok
      ? Response.json({ totpURI: r.value.uri })
      : failure(codeFor(r.code, path), r.status);
  }
  const r = await totp.regenerateBackupCodes({ userId });
  return r.ok
    ? Response.json({ status: true, backupCodes: r.value.backupCodes })
    : failure(codeFor(r.code, path), r.status);
}

/**
 * Core's answers that change with the plugin: a sign-in challenge sets the
 * `two_factor` cookie, and the session answer gains `user.twoFactorEnabled`.
 */
export async function withTwoFactor(
  auth: Auth,
  mapped: Mapped,
  request: Request,
  res: Response,
): Promise<Response> {
  if (!res.ok) return res;
  const path = new URL(request.url).pathname.slice(mapped.basePath.length);
  const signIn = request.method === "POST" && path === "/password/sign-in";
  const session = request.method === "GET" && path === "/session";
  // Core's own verify of a challenge (the compat client's kept challenge,
  // review M-5): the challenge is spent, so the `two_factor` cookie goes,
  // as on the shim's verify paths.
  if (request.method === "POST" && path === "/totp/verify") {
    const out = new Response(res.body, res);
    out.headers.append(
      "set-cookie",
      clearCookie(TWO_FACTOR_COOKIE, "/", mapped.config.cookie?.sameSite ?? "Lax"),
    );
    return out;
  }
  if (!signIn && !session) return res;
  const body = (await res
    .clone()
    .json()
    .catch(() => null)) as Body | null;
  if (!body) return res;
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  if (signIn) {
    const challenge = (body.twoFactor as { challenge?: unknown } | undefined)?.challenge;
    if (typeof challenge !== "string") return res;
    const sameSite = mapped.config.cookie?.sameSite ?? "Lax";
    headers.append(
      "set-cookie",
      `${TWO_FACTOR_COOKIE}=${challenge}; Path=/; Max-Age=${TWO_FACTOR_COOKIE_MAX_AGE}; HttpOnly; Secure; SameSite=${sameSite}`,
    );
    return new Response(JSON.stringify(body), { status: res.status, headers });
  }
  const user = body.user as { id?: unknown } | undefined;
  if (typeof user?.id !== "string") return res;
  const status = await auth.api.totp?.status({ userId: user.id });
  return Response.json(
    { ...body, user: { ...user, twoFactorEnabled: status?.ok === true && status.value.enabled } },
    { status: res.status, headers },
  );
}
