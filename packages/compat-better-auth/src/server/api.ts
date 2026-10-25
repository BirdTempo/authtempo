import type { ClientCode } from "@authtempo/client";
import {
  type Auth,
  newId,
  normalizeEmail,
  PENDING_HASH_PREFIX,
  type ResolvedSession,
  type Result,
  type StorageAdapter,
} from "@authtempo/core";
import {
  APIError,
  apiError,
  BETTER_AUTH_CODES,
  compatApiError,
  passwordPolicyCode,
} from "../errors.js";
import type { Account, ApiKeyServerApi, CompatServerApi } from "../types.js";
import { type AdminCallInput, adminCall, roleOf, toAdminSession, toAdminUser } from "./admin.js";
import { apiKeyApi } from "./api-key.js";
import { sha256Hex } from "./mail.js";
import type { Mapped } from "./map-options.js";
import {
  listedSession,
  readToken,
  toInvitation,
  toNext,
  toOrganization,
  toSession,
  toUser,
} from "./shapes.js";
import { signInAdditionsCall } from "./sign-in-additions.js";
import { cookieValue, TRUST_DEVICE_COOKIE } from "./two-factor.js";

/** A request with the caller's headers, for core's session read and the client IP. */
function requestOf(mapped: Mapped, headers?: Headers): Request {
  return new Request(`${mapped.origin}${mapped.basePath}/session`, {
    headers: headers ?? new Headers(),
  });
}

/** Core's answer, or Better Auth's APIError of its code. */
function unwrap<T>(r: Result<T>): T {
  if (r.ok) return r.value;
  // A hook refusal carries the app's own text (plan 9d). Every other code keeps the text of its name.
  if (r.message !== undefined)
    throw new APIError(r.status, BETTER_AUTH_CODES[r.code as ClientCode], r.message);
  throw apiError(r.code as ClientCode, r.status);
}

async function callerOf(auth: Auth, mapped: Mapped, headers: Headers): Promise<ResolvedSession> {
  const s = await auth.session(requestOf(mapped, headers));
  if (!s) throw apiError("unauthorized", 401);
  return s;
}

// Plan 12a. The Better Auth logic of the account operations, in one place.
// `auth.api` calls core in process. The handler posts core's own routes, so
// core's router applies its Origin rule, CORS, and the cookie renewals
// (account.ts). Both call these helpers, so the two answer alike.

/** The body of Better Auth's delete-user that the shim reads. */
export interface DeleteUserBody {
  password?: string;
  token?: string;
  callbackURL?: string;
}

/**
 * Better Auth's delete-user checks before core's delete. 404 with the
 * option off (dist/api/routes/update-user.mjs:294, read 2026-10-17).
 * `token` is the confirm of a mailed link (plan 12a Task 20). Core's page
 * lands on the app after a delete, so `callbackURL` answers NOT_SUPPORTED.
 */
export function deleteUserChecks(mapped: Mapped, body: DeleteUserBody): void {
  if (!mapped.account.deleteUser) throw apiError("not_found", 404);
  if (body.callbackURL !== undefined)
    throw compatApiError(
      "NOT_SUPPORTED",
      "core answers JSON at the delete; the app redirects after the answer",
    );
}

/** Better Auth's update-user body as core's profile patch: `name` and `image` only. */
export function profilePatch(body: Record<string, unknown>): {
  name?: string | null;
  image?: string | null;
} {
  // Better Auth 1.7.2 refuses the address before any other field (update-user.mjs:52).
  if (body.email !== undefined) throw compatApiError("EMAIL_CAN_NOT_BE_UPDATED");
  const extra = Object.keys(body).filter((k) => k !== "name" && k !== "image");
  if (extra.length > 0)
    throw compatApiError(
      "FIELD_NOT_ALLOWED",
      `core takes name and image only: ${extra.join(", ")}`,
    );
  const { name, image } = body;
  if (name !== undefined && typeof name !== "string") throw apiError("invalid_body", 400);
  if (image !== undefined && image !== null && typeof image !== "string")
    throw apiError("invalid_body", 400);
  return {
    // Better Auth keeps an empty name; core keeps null for no name.
    ...(name !== undefined ? { name: name === "" ? null : name } : {}),
    ...(image !== undefined ? { image } : {}),
  };
}

/**
 * The username fields of Better Auth's sign-up and update-user bodies (plan
 * 12i Task 16), apart from the rest. Core keeps the typed name as
 * `displayUsername`, so a `displayUsername` that is not the typed username
 * answers NOT_SUPPORTED. Without the username plugin, either field answers
 * FIELD_NOT_ALLOWED, as an unknown field does.
 */
export function usernameOf(
  body: Record<string, unknown>,
  on: boolean,
): { username: string | undefined; rest: Record<string, unknown> } {
  const { username, displayUsername, ...rest } = body;
  if (username === undefined && displayUsername === undefined) return { username: undefined, rest };
  if (!on) throw compatApiError("FIELD_NOT_ALLOWED", "username needs the username plugin");
  if (typeof username !== "string") throw apiError("invalid_body", 400);
  if (displayUsername !== undefined && displayUsername !== username)
    throw compatApiError(
      "NOT_SUPPORTED",
      "core keeps the typed username as displayUsername; send the same value or leave it out",
    );
  return { username, rest };
}

/**
 * The session id of Better Auth's `token`. The list answers the id in
 * `token`, so an id passes as it is. A clear token of the caller's own
 * session maps to its row; any other value is read as an id.
 */
export async function sessionIdOf(
  storage: StorageAdapter,
  userId: string,
  token: string,
): Promise<string> {
  const row = await storage.findOne("session", [
    { field: "tokenHash", op: "eq", value: await sha256Hex(token) },
  ]);
  return row?.userId === userId ? row.id : token;
}

/** Better Auth's accounts of a user: each provider identity, and the password as `credential`. */
export async function accountsOf(storage: StorageAdapter, userId: string): Promise<Account[]> {
  const rows = await storage.findMany("identity", [{ field: "userId", op: "eq", value: userId }]);
  const accounts = rows
    // The `email` identity is core's marker of a proved mailbox: Better Auth has no such account.
    .filter((r) => r.provider !== "email")
    .map(
      (r): Account => ({
        id: r.id,
        providerId: r.provider,
        accountId: r.subject,
        userId: r.userId,
        scopes: [],
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }),
    );
  const pw = await storage.findOne("password", [{ field: "userId", op: "eq", value: userId }]);
  // A pending hash is a password row with no password yet: no way in.
  if (pw && !pw.hash.startsWith(PENDING_HASH_PREFIX))
    accounts.push({
      id: pw.id,
      providerId: "credential",
      // Better Auth writes the credential row with accountId equal to the user id.
      accountId: userId,
      userId,
      scopes: [],
      createdAt: pw.createdAt,
      updatedAt: pw.updatedAt,
    });
  return accounts;
}

/** True when `accountId` is the user's password row: Better Auth's credential account. */
export async function isCredential(
  storage: StorageAdapter,
  userId: string,
  accountId: string,
): Promise<boolean> {
  const pw = await storage.findOne("password", [
    { field: "id", op: "eq", value: accountId },
    { field: "userId", op: "eq", value: userId },
  ]);
  return pw !== null;
}

/**
 * Better Auth's get-session answer of a resolved session (plan 12a). Both
 * `auth.api.getSession` and the handler's `/get-session` answer it, so the
 * two answer alike. `needsRefresh` is there only when core's read set it:
 * a read-only read with `session.deferSessionRefresh` on.
 */
export async function sessionAnswerOf(
  auth: Auth,
  mapped: Mapped,
  s: ResolvedSession,
  token: string,
): Promise<NonNullable<Awaited<ReturnType<CompatServerApi["getSession"]>>>> {
  // Computed from core's row (plan 9f): the Better Auth twoFactor table is not read.
  const factor = mapped.plugins.has("two-factor")
    ? await auth.api.totp?.status({ userId: s.user.id })
    : undefined;
  // With the admin plugin, Better Auth's user holds role and the ban fields (plan 12f, ruling 53).
  const adminFields =
    mapped.platformRole !== null
      ? toAdminUser(s.user, mapped.plugins, await roleOf(mapped, s.user.id), new Date())
      : null;
  return {
    session: adminFields ? toAdminSession(s.session, token) : toSession(s.session, token),
    user: {
      ...(adminFields ?? toUser(s.user, mapped.plugins)),
      ...(factor?.ok ? { twoFactorEnabled: factor.value.enabled } : {}),
    },
    ...(s.needsRefresh !== undefined ? { needsRefresh: s.needsRefresh } : {}),
  };
}

/** Better Auth unlinks a credential account; core has no password removal. */
export const CREDENTIAL_UNLINK = "core has no password removal; the credential account stays";

export function createApi(
  auth: Auth,
  mapped: Mapped,
): CompatServerApi<true, true> & Partial<ApiKeyServerApi> {
  const { clientIp, plugins, appOrigin, minPasswordLength } = mapped;
  const storage = mapped.config.storage;
  const caller = (headers: Headers) => callerOf(auth, mapped, headers);
  const reqOf = (headers?: Headers) => requestOf(mapped, headers);
  const passwords = () => {
    const pw = auth.api.password;
    if (!pw) throw apiError("not_found", 404);
    return pw;
  };
  // The admin calls run the handler's steps of their paths (ruling 60 m2): core
  // serves them to a user actor only through its routes.
  const admin = <T>(method: "GET" | "POST", path: string, input: AdminCallInput) =>
    adminCall(auth, mapped, method, path, input) as Promise<T>;
  // The calls of the sign-in plugins (plan 12i Task 16) run the handler's steps of their paths.
  const additions = <T>(
    method: "GET" | "POST",
    path: string,
    input: { body?: unknown; headers?: Headers | undefined },
  ) => signInAdditionsCall(auth, mapped, method, path, input) as Promise<T>;
  return {
    // Plan 12k Task 12: the api-key calls, with the plugin only, as in Better Auth.
    ...apiKeyApi(auth, mapped, caller),
    async getSession({ headers }) {
      // A GET request: with session.deferSessionRefresh on, core reads with no write (plan 12a).
      const s = await auth.session(reqOf(headers));
      if (!s) return null;
      return sessionAnswerOf(auth, mapped, s, readToken(headers) ?? "");
    },
    async signUpEmail({ body: given, headers }) {
      // Plan 12i Task 16: the username plugin's fields go to core's sign-up.
      const { username, rest } = usernameOf(given, plugins.has("username"));
      const body = rest as typeof given;
      if (body.image !== undefined)
        throw compatApiError("NOT_SUPPORTED", "core takes no image at sign-up");
      // Core's verify link lands on the app origin; a callbackURL would be dropped in silence.
      if (body.callbackURL !== undefined)
        throw compatApiError("NOT_SUPPORTED", "core takes no callbackURL at sign-up");
      const req = reqOf(headers);
      const r = await passwords().signUp({
        email: body.email,
        password: body.password,
        ...(body.name !== "" ? { name: body.name } : {}),
        ...(username !== undefined ? { username } : {}),
        ip: clientIp(req),
        userAgent: req.headers.get("user-agent"),
      });
      if (!r.ok && r.code === "password_policy")
        throw new APIError(400, passwordPolicyCode(body.password, minPasswordLength));
      // disableSignUp on every method maps to core's signUp: false (plan 12b).
      // Better Auth 1.7.2 answers that sign-up with its own code and 400
      // (dist/api/routes/sign-up.mjs lines 145 to 147, read 2026-10-15).
      if (!r.ok && r.code === "sign_up_closed")
        throw new APIError(400, "EMAIL_PASSWORD_SIGN_UP_DISABLED");
      // With requireEmailVerification, Better Auth 1.7.2 answers a taken
      // address as a new one: { token: null, user } with a synthetic user
      // under a new id (dist/api/routes/sign-up.mjs lines 163 to 199,
      // buildGenericDuplicateResponse, read 2026-10-14). Core has hashed the
      // password before its check, as Better Auth does.
      if (
        !r.ok &&
        (r.code === "email_taken" || r.code === "email_taken_unverified") &&
        mapped.config.password?.requireVerified === true
      ) {
        const now = new Date();
        // The synthetic user holds the typed username as a new user's row
        // would, so the answer does not tell a taken address. The two forms
        // follow core's normalizeUsername: NFKC, then lower case for the stored form.
        const typed = username?.normalize("NFKC") ?? null;
        return {
          token: null,
          user: toUser(
            {
              id: newId(now),
              // Core answered email_taken, so the address is well-formed.
              email: normalizeEmail(body.email) ?? body.email,
              emailVerified: false,
              name: body.name !== "" ? body.name : null,
              image: null,
              bannedAt: null,
              banReason: null,
              banUntil: null,
              username: typed?.toLowerCase() ?? null,
              displayUsername: typed,
              phone: null,
              isAnonymous: false,
              createdAt: now,
              updatedAt: now,
            },
            mapped.plugins,
          ),
        };
      }
      const v = unwrap(r);
      // This line cannot run: createApi takes only the config of mapOptions,
      // which sets uniformSignUp: false, so core never answers `{ sent: true }`.
      // The type cannot know that, because the setting is a value, so no typed
      // exhaustiveness check fits. The throw keeps a later change of the map a
      // clear fault, not a wrong answer.
      if ("sent" in v) throw compatApiError("NOT_SUPPORTED", "core answered the uniform sign-up");
      // Core's answer while requireVerified is on: the user and no session.
      if (!("token" in v)) return { token: null, user: toUser(v.user, mapped.plugins) };
      return { token: v.token, user: toUser(v.user, mapped.plugins) };
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
      const req = reqOf(headers);
      // The trust cookie of the caller's request, as the handler's sign-in
      // reads it (review M-1): a trusted device skips the factor here too.
      const trustDevice = plugins.has("two-factor")
        ? (cookieValue(req, TRUST_DEVICE_COOKIE) ?? undefined)
        : undefined;
      const v = unwrap(
        await passwords().signIn({
          email: body.email,
          password: body.password,
          ip: clientIp(req),
          userAgent: req.headers.get("user-agent"),
          ...(trustDevice ? { trustDevice } : {}),
        }),
      );
      // Better Auth's answer for a user with the factor on. A server caller has
      // no cookie jar, so no caller can reach the challenge: it is deleted, and
      // the browser repeats the sign-in through the handler.
      if (!("token" in v)) {
        await storage.delete("verification", [
          { field: "valueHash", op: "eq", value: await sha256Hex(v.twoFactor.challenge) },
          { field: "purpose", op: "eq", value: "two-factor" },
        ]);
        return { twoFactorRedirect: true, twoFactorMethods: ["totp"] };
      }
      return {
        redirect: false,
        token: v.token,
        url: undefined,
        user: toUser(v.user, mapped.plugins),
      };
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
          ip: clientIp(reqOf(headers)),
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
          ip: clientIp(reqOf(headers)),
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
    async listSessions({ headers }) {
      const s = await caller(headers);
      return unwrap(await auth.api.session.list({ session: s })).map((x) =>
        listedSession(x, s.user.id),
      );
    },
    async revokeSession({ body, headers }) {
      const s = await caller(headers);
      const id = await sessionIdOf(storage, s.user.id, body.token);
      const r = await auth.api.session.revoke({ session: s, id });
      // Better Auth 1.7.2 answers status true for a token it does not know
      // (dist/api/routes/session.mjs:398 to :408, read 2026-10-17).
      if (!r.ok && r.code !== "not_found") unwrap(r);
      return { status: true };
    },
    async revokeOtherSessions({ headers }) {
      const s = await caller(headers);
      unwrap(await auth.api.session.revokeOthers({ session: s }));
      return { status: true };
    },
    async revokeSessions({ headers }) {
      const s = await caller(headers);
      unwrap(await auth.api.session.revokeOthers({ session: s }));
      unwrap(await auth.api.session.revoke({ session: s, id: s.session.id }));
      return { status: true };
    },
    async updateUser({ body, headers }) {
      const s = await caller(headers);
      const { username, rest } = usernameOf(body, plugins.has("username"));
      if (username !== undefined) {
        const req = reqOf(headers);
        unwrap(
          await auth.api.user.setUsername({
            session: s,
            username,
            ip: clientIp(req),
            userAgent: req.headers.get("user-agent"),
          }),
        );
        if (Object.keys(rest).length === 0) return { status: true };
      }
      unwrap(await auth.api.user.update({ session: s, ...profilePatch(rest) }));
      return { status: true };
    },
    async changeEmail({ body, headers }) {
      const s = await caller(headers);
      // Better Auth 1.7.2's answer with the option off (update-user.mjs:440 to :443).
      if (!mapped.account.changeEmail) throw compatApiError("CHANGE_EMAIL_DISABLED");
      const next = toNext(body.callbackURL, appOrigin);
      if (next === null) throw compatApiError("INVALID_CALLBACK_URL");
      unwrap(
        await auth.api.user.changeEmail({
          session: s,
          newEmail: body.newEmail,
          ...(next !== undefined ? { next } : {}),
        }),
      );
      return { status: true };
    },
    async deleteUser({ body, headers }) {
      // Better Auth 1.7.2 reads the session first, then the option (update-user.mjs:237 and :294).
      let s = await caller(headers);
      deleteUserChecks(mapped, body);
      const req = reqOf(headers);
      if (body.password !== undefined) {
        // Better Auth's password path skips freshAge (update-user.mjs:335): a re-authentication first.
        unwrap(
          await auth.api.session.reauthenticate({
            session: s,
            proof: { password: body.password },
            ip: clientIp(req),
          }),
        );
        // The session row now holds the new freshAt.
        s = await caller(headers);
      }
      const who = { session: s, ip: clientIp(req), userAgent: req.headers.get("user-agent") };
      // Better Auth 1.7.2 spends the token before any other step (update-user.mjs:307 to :315).
      if (body.token !== undefined) {
        unwrap(await auth.api.user.confirmDelete({ ...who, token: body.token }));
        return { success: true, message: "User deleted" };
      }
      const r = unwrap(await auth.api.user.delete(who));
      return { success: true, message: "sent" in r ? "Verification email sent" : "User deleted" };
    },
    async listUserAccounts({ headers }) {
      const s = await caller(headers);
      return accountsOf(storage, s.user.id);
    },
    async unlinkAccount({ body, headers }) {
      const s = await caller(headers);
      // Better Auth 1.7.2 checks the fresh rule first (account.mjs:266), so a
      // stale session answers SESSION_NOT_FRESH for any id, as there.
      unwrap(auth.api.session.requireFresh(s));
      // Better Auth 1.7.2 takes the account row id only (account.mjs:265).
      const identity = await storage.findOne("identity", [
        { field: "id", op: "eq", value: body.accountId },
        { field: "userId", op: "eq", value: s.user.id },
      ]);
      if (!identity || identity.provider === "email") {
        if (await isCredential(storage, s.user.id, body.accountId))
          throw compatApiError("NOT_SUPPORTED", CREDENTIAL_UNLINK);
        throw compatApiError("ACCOUNT_NOT_FOUND");
      }
      const req = reqOf(headers);
      unwrap(
        await auth.api.identities.unlink({
          session: s,
          id: identity.id,
          ip: clientIp(req),
          userAgent: req.headers.get("user-agent"),
        }),
      );
      return { status: true };
    },
    listUsers: ({ query, headers }) =>
      admin("GET", "/admin/list-users", { headers, ...(query ? { query: { ...query } } : {}) }),
    getUser: ({ query, headers }) => admin("GET", "/admin/get-user", { headers, query }),
    banUser: ({ body, headers }) => admin("POST", "/admin/ban-user", { headers, body }),
    unbanUser: ({ body, headers }) => admin("POST", "/admin/unban-user", { headers, body }),
    setRole: ({ body, headers }) => admin("POST", "/admin/set-role", { headers, body }),
    revokeUserSessions: ({ body, headers }) =>
      admin("POST", "/admin/revoke-user-sessions", { headers, body }),
    impersonateUser: ({ body, headers }) =>
      admin("POST", "/admin/impersonate-user", { headers, body }),
    stopImpersonating: ({ headers }) => admin("POST", "/admin/stop-impersonating", { headers }),
    adminUpdateUser: ({ body, headers }) => admin("POST", "/admin/update-user", { headers, body }),
    removeUser: ({ body, headers }) => admin("POST", "/admin/remove-user", { headers, body }),
    createUser: ({ body, headers }) => admin("POST", "/admin/create-user", { headers, body }),
    signInAnonymous: (input) =>
      additions("POST", "/sign-in/anonymous", { headers: input?.headers }),
    deleteAnonymousUser: ({ headers }) =>
      additions("POST", "/delete-anonymous-user", { headers, body: {} }),
    signInUsername: ({ body, headers }) =>
      additions("POST", "/sign-in/username", { body, headers }),
    isUsernameAvailable: ({ body, headers }) =>
      additions("POST", "/is-username-available", { body, headers }),
    sendPhoneNumberOTP: ({ body, headers }) =>
      additions("POST", "/phone-number/send-otp", { body, headers }),
    verifyPhoneNumber: ({ body, headers }) =>
      additions("POST", "/phone-number/verify", { body, headers }),
    signInPhoneNumber: ({ body, headers }) =>
      additions("POST", "/sign-in/phone-number", { body, headers }),
    oneTapCallback: ({ body, headers }) =>
      additions("POST", "/one-tap/callback", { body, headers }),
    signInSocial: ({ body, headers }) => additions("POST", "/sign-in/social", { body, headers }),
    listDeviceSessions: ({ headers }) =>
      additions("GET", "/multi-session/list-device-sessions", { headers }),
    setActiveSession: ({ body, headers }) =>
      additions("POST", "/multi-session/set-active", { body, headers }),
    revokeDeviceSession: ({ body, headers }) =>
      additions("POST", "/multi-session/revoke", { body, headers }),
  };
}
