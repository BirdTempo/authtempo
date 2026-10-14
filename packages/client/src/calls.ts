import type { RouteMethod, RoutePath } from "@authtempo/core/routes";

/** One call of the client: its operation, and the method and path of the route it calls. */
export type ClientCall = {
  [M in RouteMethod]: {
    readonly operation: string;
    readonly method: M;
    readonly path: RoutePath<M>;
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
  { operation: "signOut", method: "POST", path: "/sign-out" },
  { operation: "magicLink.request", method: "POST", path: "/magic-link/request" },
  { operation: "magicLink.verify", method: "POST", path: "/magic-link/verify" },
  // A browser navigation, not a fetch: client.social builds its URL from this row.
  { operation: "social.start", method: "GET", path: "/social/:provider/start" },
  { operation: "handoff.redeem", method: "POST", path: "/handoff/redeem" },
  { operation: "passkey.register.options", method: "POST", path: "/passkey/register/options" },
  { operation: "passkey.register.verify", method: "POST", path: "/passkey/register/verify" },
  { operation: "passkey.signIn.options", method: "POST", path: "/passkey/authenticate/options" },
  { operation: "passkey.signIn.verify", method: "POST", path: "/passkey/authenticate/verify" },
  { operation: "passkeys.list", method: "GET", path: "/passkeys" },
  { operation: "passkeys.delete", method: "POST", path: "/passkeys/delete" },
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
  { operation: "organizations.list", method: "GET", path: "/organizations" },
  { operation: "organizations.update", method: "POST", path: "/organizations/update" },
  { operation: "organizations.delete", method: "POST", path: "/organizations/delete" },
  { operation: "organizations.members.list", method: "GET", path: "/organizations/members" },
  { operation: "organizations.members.add", method: "POST", path: "/organizations/members/add" },
  { operation: "organizations.members.role", method: "POST", path: "/organizations/members/role" },
  {
    operation: "organizations.members.remove",
    method: "POST",
    path: "/organizations/members/remove",
  },
  { operation: "organizations.invitations.invite", method: "POST", path: "/organizations/invite" },
  {
    operation: "organizations.invitations.list",
    method: "GET",
    path: "/organizations/invitations",
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
  { operation: "tokens.list", method: "GET", path: "/tokens" },
  { operation: "tokens.revoke", method: "POST", path: "/tokens/revoke" },
  { operation: "tokens.current", method: "GET", path: "/tokens/current" },
  { operation: "jwt.token", method: "GET", path: "/token" },
  { operation: "oauth.grants", method: "GET", path: "/oauth/grants" },
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
