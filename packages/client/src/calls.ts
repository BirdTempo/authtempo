import type { RouteMethod, RoutePath } from "@authtempo/core/routes";

/**
 * One call of the client: its operation, and the method and path of the
 * route it calls. `select` names the one key of the route's answer that the
 * client method answers (plan 11g): `passkeys.list` answers the `passkeys`
 * of `{ passkeys }`. The call reads the key through `selected`, and the
 * type test holds the method's answer to the same key of the contract. A
 * row with `select` has no `:name` in its path: the client's `part` fills
 * no template, so the type refuses one.
 */
export type ClientCall = {
  [M in RouteMethod]:
    | {
        readonly operation: string;
        readonly method: M;
        readonly path: RoutePath<M>;
        readonly select?: undefined;
      }
    | {
        readonly operation: string;
        readonly method: M;
        readonly path: Exclude<RoutePath<M>, `${string}/:${string}`>;
        readonly select: string;
      };
}[RouteMethod];

/**
 * Every route that the client calls (plan 11d, spec 20). The client takes each
 * path from this table, `calls.test.ts` proves that a run of every operation
 * calls exactly these routes, and the drift test of plan 11d Task 13 (the SDK
 * conformance package) holds the table to `ROUTES`. A ceremony of two calls
 * has one row per call, and two operations can call one route.
 */
export const CLIENT_CALLS = [
  { operation: "session", method: "GET", path: "/session" },
  { operation: "session.refresh", method: "POST", path: "/session/refresh" },
  { operation: "signOut", method: "POST", path: "/sign-out" },
  { operation: "magicLink.request", method: "POST", path: "/magic-link/request" },
  { operation: "magicLink.verify", method: "POST", path: "/magic-link/verify" },
  // A browser navigation, not a fetch: client.social builds its URL from this row.
  { operation: "social.start", method: "GET", path: "/social/:provider/start" },
  { operation: "handoff.redeem", method: "POST", path: "/handoff/redeem" },
  { operation: "passkey.register.options", method: "POST", path: "/passkey/register/options" },
  {
    operation: "passkey.register.verify",
    method: "POST",
    path: "/passkey/register/verify",
    select: "passkey",
  },
  { operation: "passkey.signIn.options", method: "POST", path: "/passkey/authenticate/options" },
  { operation: "passkey.signIn.verify", method: "POST", path: "/passkey/authenticate/verify" },
  { operation: "passkeys.list", method: "GET", path: "/passkeys", select: "passkeys" },
  { operation: "passkeys.delete", method: "POST", path: "/passkeys/delete" },
  { operation: "passkeys.rename", method: "POST", path: "/passkeys/rename", select: "passkey" },
  { operation: "password.signUp", method: "POST", path: "/password/sign-up" },
  { operation: "password.signIn", method: "POST", path: "/password/sign-in" },
  { operation: "password.resendVerification", method: "POST", path: "/password/verify/resend" },
  { operation: "password.verifyEmail", method: "POST", path: "/password/verify" },
  { operation: "password.requestReset", method: "POST", path: "/password/reset/request" },
  { operation: "password.reset", method: "POST", path: "/password/reset" },
  { operation: "password.change", method: "POST", path: "/password/change" },
  { operation: "emailOtp.request", method: "POST", path: "/otp/request" },
  { operation: "emailOtp.verify", method: "POST", path: "/otp/verify" },
  { operation: "emailOtp.requestReset", method: "POST", path: "/otp/reset/request" },
  { operation: "emailOtp.reset", method: "POST", path: "/otp/reset" },
  { operation: "organizations.create", method: "POST", path: "/organizations/create" },
  {
    operation: "organizations.list",
    method: "GET",
    path: "/organizations",
    select: "organizations",
  },
  {
    operation: "organizations.update",
    method: "POST",
    path: "/organizations/update",
    select: "organization",
  },
  { operation: "organizations.delete", method: "POST", path: "/organizations/delete" },
  {
    operation: "organizations.members.list",
    method: "GET",
    path: "/organizations/members",
    select: "members",
  },
  {
    operation: "organizations.members.add",
    method: "POST",
    path: "/organizations/members/add",
    select: "member",
  },
  {
    operation: "organizations.members.role",
    method: "POST",
    path: "/organizations/members/role",
    select: "member",
  },
  {
    operation: "organizations.members.remove",
    method: "POST",
    path: "/organizations/members/remove",
  },
  {
    operation: "organizations.invitations.invite",
    method: "POST",
    path: "/organizations/invite",
    select: "invitation",
  },
  {
    operation: "organizations.invitations.list",
    method: "GET",
    path: "/organizations/invitations",
    select: "invitations",
  },
  {
    operation: "organizations.invitations.revoke",
    method: "POST",
    path: "/organizations/invitations/revoke",
  },
  {
    operation: "organizations.invitations.accept",
    method: "POST",
    path: "/organizations/invitations/accept",
  },
  {
    operation: "organizations.invitations.decline",
    method: "POST",
    path: "/organizations/invitations/decline",
  },
  { operation: "organizations.setActive", method: "POST", path: "/organizations/active" },
  { operation: "tokens.create", method: "POST", path: "/tokens" },
  { operation: "tokens.list", method: "GET", path: "/tokens", select: "tokens" },
  { operation: "tokens.revoke", method: "POST", path: "/tokens/revoke" },
  { operation: "tokens.current", method: "GET", path: "/tokens/current" },
  { operation: "jwt.token", method: "GET", path: "/token" },
  { operation: "oauth.grants", method: "GET", path: "/oauth/grants", select: "grants" },
  { operation: "oauth.revoke", method: "POST", path: "/oauth/grants/revoke" },
  { operation: "totp.setup", method: "POST", path: "/totp/setup" },
  { operation: "totp.enable", method: "POST", path: "/totp/enable" },
  { operation: "totp.verify", method: "POST", path: "/totp/verify" },
  { operation: "totp.disable", method: "POST", path: "/totp/disable" },
  { operation: "totp.regenerateBackupCodes", method: "POST", path: "/totp/backup-codes" },
  { operation: "totp.status", method: "GET", path: "/totp" },
  { operation: "totp.revokeTrustedDevices", method: "POST", path: "/totp/devices/revoke" },
  // Plan 12c: the second-factor methods. The passkey enable takes a sign-in
  // assertion, and the passkey verify ends at the TOTP verify route.
  {
    operation: "secondFactor.passkey.enable.options",
    method: "POST",
    path: "/passkey/authenticate/options",
  },
  {
    operation: "secondFactor.passkey.enable.verify",
    method: "POST",
    path: "/second-factor/passkey/enable",
  },
  {
    operation: "secondFactor.passkey.verify.options",
    method: "POST",
    path: "/second-factor/passkey/options",
  },
  { operation: "secondFactor.passkey.verify.verify", method: "POST", path: "/totp/verify" },
  { operation: "secondFactor.email.enable", method: "POST", path: "/second-factor/email/enable" },
  { operation: "secondFactor.email.send", method: "POST", path: "/second-factor/email/send" },
  { operation: "secondFactor.disable", method: "POST", path: "/second-factor/disable" },
  // Plan 12a: the settings page. `reauth.password`, `reauth.emailCode`, and
  // `reauth.passkey` send their proof to one route, so they share the row
  // "reauth". `GET /user/change-email/confirm` and `GET /user/delete/confirm`
  // are the pages of the mailed links, not client calls.
  { operation: "sessions.list", method: "GET", path: "/sessions", select: "sessions" },
  { operation: "sessions.revoke", method: "POST", path: "/sessions/revoke" },
  { operation: "sessions.revokeOthers", method: "POST", path: "/sessions/revoke-others" },
  { operation: "reauth", method: "POST", path: "/reauth" },
  { operation: "reauth.email.request", method: "POST", path: "/reauth/email" },
  { operation: "reauth.passkey.options", method: "POST", path: "/reauth/passkey/options" },
  { operation: "user.update", method: "POST", path: "/user/update" },
  { operation: "user.changeEmail", method: "POST", path: "/user/change-email" },
  { operation: "user.confirmEmailChange", method: "POST", path: "/user/change-email/confirm" },
  { operation: "user.verifyEmailChange", method: "POST", path: "/user/change-email/verify" },
  { operation: "user.delete", method: "POST", path: "/user/delete" },
  { operation: "user.confirmDelete", method: "POST", path: "/user/delete/confirm" },
  { operation: "identities.list", method: "GET", path: "/identities" },
  { operation: "identities.unlink", method: "POST", path: "/identities/unlink" },
  // A POST, not a navigation: the start needs the session. client.identities.link
  // puts the provider's name in the template, then navigates to the answer's URL.
  { operation: "identities.link", method: "POST", path: "/social/:provider/link" },
] as const satisfies readonly ClientCall[];

/** The name of one row of `CLIENT_CALLS`. */
export type ClientOperation = (typeof CLIENT_CALLS)[number]["operation"];

type CallOf<O extends ClientOperation> = Extract<(typeof CLIENT_CALLS)[number], { operation: O }>;

const BY_OPERATION: ReadonlyMap<string, ClientCall> = new Map(
  CLIENT_CALLS.map((c) => [c.operation, c]),
);

/** The method and path of an operation. A name that the table lacks fails the compile. */
export function callOf<O extends ClientOperation>(operation: O): CallOf<O> {
  const c = BY_OPERATION.get(operation);
  // Unreachable: the type of `operation` is a name of the table.
  if (!c) throw new Error(`authtempo client: no call ${operation}`);
  return c as CallOf<O>;
}

/** The part of an answer `V` that a row's `select` names, or the whole answer for a row with none. */
export type Selected<V, S> = S extends keyof V ? V[S] : V;

/**
 * The part of a route's answer that the row's `select` names (plan 11g).
 * The one place that reads the key, so the call and the type test agree.
 */
export function selected<V, R extends ClientCall>(row: R, value: V): Selected<V, R["select"]> {
  const key = row.select;
  if (key === undefined) return value as Selected<V, R["select"]>;
  return (value as Record<string, unknown>)[key] as Selected<V, R["select"]>;
}
