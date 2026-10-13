import type { ClientCode } from "@tempo-auth/client";
import type { Auth, Result } from "@tempo-auth/core";
import {
  APIError,
  apiError,
  BETTER_AUTH_CODES,
  compatApiError,
  passwordPolicyCode,
} from "../errors.js";
import type { CompatServerApi } from "../types.js";
import type { Mapped } from "./map-options.js";
import { readToken, toInvitation, toNext, toOrganization, toSession, toUser } from "./shapes.js";

export function createApi(auth: Auth, mapped: Mapped): CompatServerApi {
  const { origin, basePath, clientIp, plugins, appOrigin, minPasswordLength } = mapped;
  const storage = mapped.config.storage;
  const requestOf = (headers?: Headers) =>
    new Request(`${origin}${basePath}/session`, { headers: headers ?? new Headers() });
  const unwrap = <T>(r: Result<T>): T => {
    if (r.ok) return r.value;
    // A hook refusal carries the app's own text (plan 9d). Every other code keeps the text of its name.
    if (r.message !== undefined)
      throw new APIError(r.status, BETTER_AUTH_CODES[r.code as ClientCode], r.message);
    throw apiError(r.code as ClientCode, r.status);
  };
  const caller = async (headers: Headers) => {
    const s = await auth.session(requestOf(headers));
    if (!s) throw apiError("unauthorized", 401);
    return s;
  };
  const passwords = () => {
    const pw = auth.api.password;
    if (!pw) throw apiError("not_found", 404);
    return pw;
  };
  return {
    async getSession({ headers }) {
      const s = await auth.session(requestOf(headers));
      return s
        ? { session: toSession(s.session, readToken(headers) ?? ""), user: toUser(s.user) }
        : null;
    },
    async signUpEmail({ body, headers }) {
      if (body.image !== undefined)
        throw compatApiError("NOT_SUPPORTED", "core takes no image at sign-up");
      // Core's verify link lands on the app origin; a callbackURL would be dropped in silence.
      if (body.callbackURL !== undefined)
        throw compatApiError("NOT_SUPPORTED", "core takes no callbackURL at sign-up");
      const req = requestOf(headers);
      const r = await passwords().signUp({
        email: body.email,
        password: body.password,
        ...(body.name !== "" ? { name: body.name } : {}),
        ip: clientIp(req),
        userAgent: req.headers.get("user-agent"),
      });
      if (!r.ok && r.code === "password_policy")
        throw new APIError(400, passwordPolicyCode(body.password, minPasswordLength));
      const v = unwrap(r);
      return { token: v.token, user: toUser(v.user) };
    },
    async signInEmail({ body, headers }) {
      // Each would be dropped in silence: core answers a token, not a redirect,
      // and every session lives session.expiresIn.
      if (body.callbackURL !== undefined)
        throw compatApiError("NOT_SUPPORTED", "core takes no callbackURL at sign-in");
      // rememberMe: true is Better Auth's default and what core does, so it is
      // accepted. false asks for a browser-session cookie, which core does not set.
      if (body.rememberMe === false)
        throw compatApiError(
          "NOT_SUPPORTED",
          "core takes no rememberMe: false: every session lives session.expiresIn",
        );
      const req = requestOf(headers);
      const v = unwrap(
        await passwords().signIn({
          email: body.email,
          password: body.password,
          ip: clientIp(req),
          userAgent: req.headers.get("user-agent"),
        }),
      );
      // The config sets totp: false until Task 7 of plan 9f, so core answers no challenge here.
      if (!("token" in v)) throw apiError("unexpected", 500);
      return { redirect: false, token: v.token, url: undefined, user: toUser(v.user) };
    },
    async signOut({ headers }) {
      const token = readToken(headers);
      if (token) await auth.api.signOut(token);
      return { success: true };
    },
    async signInMagicLink({ body, headers }) {
      if (!plugins.has("magic-link")) throw apiError("not_found", 404);
      if (body.name !== undefined)
        throw compatApiError("NOT_SUPPORTED", "core takes no name at the magic link");
      const next = toNext(body.callbackURL, appOrigin);
      if (next === null) throw compatApiError("INVALID_CALLBACK_URL");
      unwrap(
        await auth.api.requestMagicLink({
          email: body.email,
          ...(next !== undefined ? { next } : {}),
          ip: clientIp(requestOf(headers)),
        }),
      );
      return { status: true };
    },
    async sendVerificationEmail({ body, headers }) {
      // Core's verify link lands on the app origin; a callbackURL would be dropped in silence.
      if (body.callbackURL !== undefined)
        throw compatApiError("NOT_SUPPORTED", "core takes no callbackURL at the verify mail");
      unwrap(
        await passwords().resendVerification({
          email: body.email,
          ip: clientIp(requestOf(headers)),
        }),
      );
      return { status: true };
    },
    async createInvitation({ body, headers }) {
      const s = await caller(headers);
      const organizationId = body.organizationId ?? s.session.activeOrganizationId;
      if (!organizationId) throw compatApiError("NO_ACTIVE_ORGANIZATION");
      const v = unwrap(
        await auth.api.inviteMember({
          user: s.user,
          organizationId,
          email: body.email,
          role: body.role,
        }),
      );
      return toInvitation(v, v.id, "pending");
    },
    async cancelInvitation({ body, headers }) {
      const s = await caller(headers);
      const row = await storage.findOne("invitation", [
        { field: "id", op: "eq", value: body.invitationId },
      ]);
      if (!row) throw compatApiError("INVITATION_NOT_FOUND");
      unwrap(
        await auth.api.revokeInvitation({
          user: s.user,
          organizationId: row.organizationId,
          invitationId: row.id,
        }),
      );
      return toInvitation(row, row.id, "canceled");
    },
    async listOrganizations({ headers }) {
      const s = await caller(headers);
      return unwrap(await auth.api.listOrganizations({ user: s.user })).map((x) =>
        toOrganization(x.organization),
      );
    },
    async setActiveOrganization({ body, headers }) {
      const s = await caller(headers);
      unwrap(
        await auth.api.setActiveOrganization({ session: s, organizationId: body.organizationId }),
      );
      if (body.organizationId === null) return null;
      const list = unwrap(await auth.api.listOrganizations({ user: s.user }));
      const found = list.find((x) => x.organization.id === body.organizationId);
      return found ? toOrganization(found.organization) : null;
    },
  };
}
