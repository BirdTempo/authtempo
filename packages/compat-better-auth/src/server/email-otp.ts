import type { ClientCode } from "@authtempo/client";
import { type Auth, normalizeEmail } from "@authtempo/core";
import { BETTER_AUTH_CODES, messageOf, NOT_SUPPORTED, passwordPolicyCode } from "../errors.js";
import { sha256Hex } from "./mail.js";
import type { Mapped } from "./map-options.js";
import { toUser } from "./shapes.js";

/**
 * Better Auth 1.7.2's email OTP paths (dist/plugins/email-otp/routes.mjs,
 * read 2026-10-13), served by `auth.handler` with the `email-otp` plugin
 * (plan 9e). Five map onto core's code routes; these four answer
 * NOT_SUPPORTED (501), except the two change paths with
 * `changeEmail.enabled` (plan 12a). They are a set of Better Auth paths that this
 * handler serves in Better Auth's shapes, because apps post them by hand
 * (consumerd's tests do). An error answers Better Auth's body `{ code,
 * message }` with core's status.
 */
export const EMAIL_OTP_NOT_SUPPORTED: readonly string[] = [
  "/email-otp/verify-email",
  "/email-otp/check-verification-otp",
  "/email-otp/request-email-change",
  "/email-otp/change-email",
];

const SEND = "/email-otp/send-verification-otp";
const SIGN_IN = "/sign-in/email-otp";
const RESET = "/email-otp/reset-password";
/** Better Auth's change of address by code (plan 12a), served with `emailOTP({ changeEmail: { enabled: true } })`. */
const REQUEST_CHANGE = "/email-otp/request-email-change";
const CHANGE = "/email-otp/change-email";
/** The deprecated name and its replacement in Better Auth 1.7.2: one body, one answer. */
const RESET_REQUESTS = new Set(["/forget-password/email-otp", "/email-otp/request-password-reset"]);
const OTP_TYPES = new Set(["sign-in", "email-verification", "forget-password", "change-email"]);
const NOT_SERVED = "core serves the sign-in code and the reset code only; see the plan index";

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

/** Better Auth's shape of one core answer. The headers stay core's: the session cookie and the CORS headers. */
export async function translate(
  res: Response,
  success: (body: Body) => unknown | Promise<unknown>,
): Promise<Response> {
  const body = (await res
    .clone()
    .json()
    .catch(() => null)) as Body | null;
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  if (res.ok && body) return Response.json(await success(body), { status: 200, headers });
  const error = body?.error;
  const code =
    typeof error === "string" && Object.hasOwn(BETTER_AUTH_CODES, error)
      ? BETTER_AUTH_CODES[error as ClientCode]
      : BETTER_AUTH_CODES.unexpected;
  // A hook refusal carries the app's own text (plan 9d).
  const message = typeof body?.message === "string" ? body.message : messageOf(code);
  return failure(code, res.status, message, headers);
}

/**
 * The answer to one of Better Auth's email OTP paths, or null for any other
 * request, which the handler passes to core. `request` is the handler's
 * request after the expo-origin rule.
 */
export async function emailOtpRoute(
  auth: Auth,
  mapped: Mapped,
  request: Request,
): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (request.method !== "POST" || !pathname.startsWith(`${mapped.basePath}/`)) return null;
  const path = pathname.slice(mapped.basePath.length);
  const known =
    path === SEND ||
    path === SIGN_IN ||
    path === RESET ||
    RESET_REQUESTS.has(path) ||
    EMAIL_OTP_NOT_SUPPORTED.includes(path);
  if (!known) return null;
  const change = mapped.account.emailOtpChange && (path === REQUEST_CHANGE || path === CHANGE);
  if (EMAIL_OTP_NOT_SUPPORTED.includes(path) && !change)
    return failure(NOT_SUPPORTED, 501, NOT_SERVED);
  const body = await readBody(request);
  const forward = async (to: string, payload: Body) => {
    const headers = new Headers(request.headers);
    headers.set("content-type", "application/json");
    headers.delete("content-length");
    return auth.handle(
      new Request(`${mapped.origin}${mapped.basePath}${to}`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      }),
    );
  };
  const success = () => ({ success: true });
  // The change paths carry newEmail, not email (Better Auth 1.7.2 routes.mjs:625 and :696).
  if (change) {
    if (!body || typeof body.newEmail !== "string")
      return failure(BETTER_AUTH_CODES.invalid_body, 400);
    if (path === REQUEST_CHANGE)
      return translate(
        await forward("/user/change-email", { newEmail: body.newEmail, method: "code" }),
        success,
      );
    if (typeof body.otp !== "string") return failure(BETTER_AUTH_CODES.invalid_body, 400);
    // Better Auth keys the code by the old and the new address, so a code
    // for another address answers INVALID_OTP (routes.mjs:724). Core keys it
    // by the user and keeps the new address in the row: the shim compares.
    const s = await auth.session(request);
    if (s) {
      const live = await mapped.config.storage.findMany("verification", [
        { field: "purpose", op: "eq", value: "email-change-otp" },
        { field: "identifier", op: "eq", value: s.user.id },
        { field: "consumedAt", op: "eq", value: null },
      ]);
      const asked = normalizeEmail(body.newEmail);
      if (live.some((r) => r.data?.newEmail !== asked))
        return failure(BETTER_AUTH_CODES.invalid_code, 400);
    }
    return translate(await forward("/user/change-email/verify", { code: body.otp }), success);
  }
  if (!body || typeof body.email !== "string") return failure(BETTER_AUTH_CODES.invalid_body, 400);
  const email = body.email;
  if (path === SEND) {
    if (typeof body.type !== "string" || !OTP_TYPES.has(body.type))
      return failure(BETTER_AUTH_CODES.invalid_body, 400);
    // Better Auth answers a malformed address 400 INVALID_EMAIL here (routes.mjs
    // sendVerificationOTP, read 2026-10-13). Core answers { sent: true }; the
    // shape of an address tells nothing about an account.
    if (normalizeEmail(email) === null) return failure("INVALID_EMAIL", 400);
    if (body.type === "sign-in")
      return translate(await forward("/otp/request", { email }), success);
    if (body.type === "forget-password")
      return translate(await forward("/otp/reset/request", { email }), success);
    return failure(NOT_SUPPORTED, 501, NOT_SERVED);
  }
  if (RESET_REQUESTS.has(path))
    return translate(await forward("/otp/reset/request", { email }), success);
  if (typeof body.otp !== "string") return failure(BETTER_AUTH_CODES.invalid_body, 400);
  if (path === SIGN_IN) {
    // Better Auth takes name, image, and other user fields for a new user.
    // Core takes none at a code sign-in, and a dropped field would be silent.
    const extra = Object.keys(body).filter((k) => k !== "email" && k !== "otp");
    if (extra.length > 0)
      return failure(
        NOT_SUPPORTED,
        501,
        `core takes no ${extra.join(", ")} at the email code sign-in`,
      );
    return translate(await forward("/otp/verify", { email, code: body.otp }), async (b) => {
      const id = (b.user as { id?: unknown } | undefined)?.id;
      const row =
        typeof id === "string"
          ? await mapped.config.storage.findOne("user", [{ field: "id", op: "eq", value: id }])
          : null;
      if (!row) throw new Error("authtempo compat: the signed-in user is gone");
      return { token: b.token, user: toUser(row) };
    });
  }
  // RESET
  if (typeof body.password !== "string") return failure(BETTER_AUTH_CODES.invalid_body, 400);
  // Better Auth checks the length before the code (routes.mjs
  // resetPasswordEmailOTP, read 2026-10-13), so a short password keeps the
  // code on this path. Core's other policy refusals spend it.
  const named = passwordPolicyCode(body.password, mapped.minPasswordLength);
  if (named !== "INVALID_PASSWORD") return failure(named, 400);
  return translate(
    await forward("/otp/reset", { email, code: body.otp, password: body.password }),
    async (b) => {
      // Core answers a user with the factor on with a challenge (plan 12c).
      // Better Auth's answer is `{ success: true }`, so no caller holds the
      // challenge: it is deleted, as `api.signInEmail` does.
      const challenge = (b.twoFactor as { challenge?: unknown } | undefined)?.challenge;
      if (typeof challenge === "string")
        await mapped.config.storage.delete("verification", [
          { field: "valueHash", op: "eq", value: await sha256Hex(challenge) },
          { field: "purpose", op: "eq", value: "two-factor" },
        ]);
      return success();
    },
  );
}
