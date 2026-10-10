import type { ClientCode } from "@tempo-auth/client";
import type { Auth, Result } from "@tempo-auth/core";
import { APIError, apiError, NOT_SUPPORTED, passwordPolicyCode } from "../errors.js";
import type { CompatServerApi } from "../types.js";
import type { Mapped } from "./map-options.js";
import { readToken, toInvitation, toNext, toOrganization, toSession, toUser } from "./shapes.js";

export function createApi(auth: Auth, mapped: Mapped): CompatServerApi {
  const { origin, basePath, clientIp, plugins, appOrigin, minPasswordLength } = mapped;
  const storage = mapped.config.storage;
  const requestOf = (headers?: Headers) =>
    new Request(`${origin}${basePath}/session`, { headers: headers ?? new Headers() });
  const unwrap = <T>(r: Result<T>): T => {
    if (!r.ok) throw apiError(r.code as ClientCode, r.status);
    return r.value;
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
        throw new APIError(501, NOT_SUPPORTED, "core takes no image at sign-up");
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
      const req = requestOf(headers);
      const v = unwrap(
        await passwords().signIn({
          email: body.email,
          password: body.password,
          ip: clientIp(req),
          userAgent: req.headers.get("user-agent"),
        }),
      );
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
        throw new APIError(501, NOT_SUPPORTED, "core takes no name at the magic link");
      const next = toNext(body.callbackURL, appOrigin);
      if (next === null) throw new APIError(403, "INVALID_CALLBACK_URL");
      unwrap(
        await auth.api.requestMagicLink({
          email: body.email,
          ...(next !== undefined ? { next } : {}),
          ip: clientIp(requestOf(headers)),
        }),
      );
      return { status: true };
    },
    async sendVerificationEmail() {
      throw new APIError(
        501,
        NOT_SUPPORTED,
        "core has no resend route for the verify mail until plan 8b",
      );
    },
    async createInvitation({ body, headers }) {
      const s = await caller(headers);
      const organizationId = body.organizationId ?? s.session.activeOrganizationId;
      if (!organizationId) throw new APIError(400, "NO_ACTIVE_ORGANIZATION");
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
      if (!row) throw new APIError(404, "INVITATION_NOT_FOUND");
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
