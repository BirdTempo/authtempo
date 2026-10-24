import type { AnswerOf, BodyOf } from "@authtempo/core/openapi";
import type { RouteKey } from "@authtempo/core/routes";
import type { CLIENT_CALLS, ClientCall, ClientOperation, Selected } from "../src/calls.js";
import type { Client } from "../src/client.js";
import type { ClientResult } from "../src/result.js";

/**
 * The client's types held to the route contract (plan 11g). `tsc -p
 * tsconfig.test.json` reads this file; vitest does not run it. A method of
 * `Client` answers each row of `CLIENT_CALLS` but the uncompared ones. Its
 * answer equals the part of the contract's answer that the row's `select`
 * names. For each row of `BODY_AS_INPUT`, the method's input equals the body.
 * `calls.test.ts` holds the three lists to the table.
 */

/** True only when A and B are the same type, both ways (plan 11g). */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

/** The row of an operation. */
type Row<O extends ClientOperation> = Extract<(typeof CLIENT_CALLS)[number], { operation: O }>;
/** The route key of a row. */
type KeyOf<O extends ClientOperation> = `${Row<O>["method"]} ${Row<O>["path"]}` & RouteKey;
/** The `select` of a row, or undefined for a row with none. */
type SelectOf<O extends ClientOperation> =
  Row<O> extends { readonly select: infer S } ? S : undefined;
/** The part of the route's answer that the row selects. */
type Answer<O extends ClientOperation> = Selected<AnswerOf<KeyOf<O>>, SelectOf<O>>;
/** The `value` of a method's `ClientResult`. */
type Unwrap<M> = M extends (...args: never[]) => Promise<ClientResult<infer V>> ? V : never;
/** The first argument of a method. */
type Input<M> = M extends (input: infer I, ...rest: never[]) => unknown ? I : never;
/** The member of `Client` at a dotted path: `passkeys.list` is `Client["passkeys"]["list"]`. */
type Walk<T, P extends string> = P extends `${infer Head}.${infer Rest}`
  ? Head extends keyof T
    ? Walk<T[Head], Rest>
    : never
  : P extends keyof T
    ? T[P]
    : never;

/**
 * The rows whose method is not at the row's dotted path: the second call of
 * a ceremony, and `reauth`, whose row serves three proof methods.
 */
interface MethodAt {
  reauth: Client["reauth"]["password"];
  "reauth.email.request": Client["reauth"]["requestEmailCode"];
  "passkey.register.verify": Client["passkey"]["register"];
  "passkey.signIn.verify": Client["passkey"]["signIn"];
  "secondFactor.passkey.enable.verify": Client["secondFactor"]["passkey"]["enable"];
  "secondFactor.passkey.verify.verify": Client["secondFactor"]["passkey"]["verify"];
}
type Method<O extends ClientOperation> = O extends keyof MethodAt ? MethodAt[O] : Walk<Client, O>;

/** The two reads answer `null` for a 401: that null is the client's, not the wire's. */
type NullOn401 = "session" | "session.refresh";
type Value<O extends ClientOperation> = O extends NullOn401
  ? Exclude<Unwrap<Method<O>>, null>
  : Unwrap<Method<O>>;

/**
 * One shape for a type and its intersection or `Omit` form, with `undefined`
 * dropped from an optional key: the wire has no `undefined`.
 */
type Flat<T> = T extends readonly (infer U)[]
  ? Flat<U>[]
  : T extends object
    ? { [K in keyof T]: Flat<Exclude<T[K], undefined>> }
    : T;

type AnswerEqual<O extends ClientOperation> = Equal<Flat<Value<O>>, Flat<Answer<O>>>;
type BodyEqual<O extends ClientOperation> = Equal<Flat<Input<Method<O>>>, Flat<BodyOf<KeyOf<O>>>>;

/**
 * The rows whose method answers the route's answer, or the part that
 * `select` names. The other rows are in `NOT_COMPARED`, each with its reason.
 */
export const COMPARED = [
  "session",
  "session.refresh",
  "signOut",
  "magicLink.request",
  "magicLink.verify",
  "handoff.redeem",
  "passkey.register.verify",
  "passkey.signIn.verify",
  "passkeys.list",
  "passkeys.delete",
  "passkeys.rename",
  "password.signUp",
  "password.signIn",
  "password.resendVerification",
  "password.verifyEmail",
  "password.verifyCode",
  "password.requestReset",
  "password.reset",
  "password.change",
  "emailOtp.request",
  "emailOtp.verify",
  "emailOtp.requestReset",
  "emailOtp.reset",
  "phone.request",
  "phone.verify",
  "phone.add",
  "phone.verifyAdd",
  "phone.remove",
  "anonymous.signIn",
  "anonymous.delete",
  "organizations.create",
  "organizations.list",
  "organizations.update",
  "organizations.delete",
  "organizations.members.list",
  "organizations.members.add",
  "organizations.members.role",
  "organizations.members.remove",
  "organizations.invitations.invite",
  "organizations.invitations.list",
  "organizations.invitations.revoke",
  "organizations.invitations.accept",
  "organizations.invitations.decline",
  "organizations.setActive",
  "organizations.hasPermission",
  "organizations.permissions",
  "organizations.checkSlug",
  "organizations.roles.list",
  "organizations.roles.get",
  "organizations.roles.create",
  "organizations.roles.update",
  "organizations.roles.delete",
  "organizations.teams.list",
  "organizations.teams.create",
  "organizations.teams.update",
  "organizations.teams.delete",
  "organizations.teams.members.list",
  "organizations.teams.members.add",
  "organizations.teams.members.remove",
  "organizations.teams.setActive",
  "organizations.teams.mine",
  "organizations.tokens.create",
  "organizations.tokens.list",
  "organizations.tokens.update",
  "organizations.tokens.revoke",
  "organizations.tokens.current",
  "tokens.create",
  "tokens.list",
  "tokens.revoke",
  "tokens.update",
  "tokens.current",
  "jwt.token",
  "oauth.grants",
  "oauth.revoke",
  "totp.setup",
  "totp.enable",
  "totp.verify",
  "totp.disable",
  "totp.regenerateBackupCodes",
  "totp.status",
  "totp.revokeTrustedDevices",
  "secondFactor.passkey.enable.verify",
  "secondFactor.passkey.verify.verify",
  "secondFactor.email.enable",
  "secondFactor.email.send",
  "secondFactor.disable",
  "sessions.list",
  "sessions.revoke",
  "sessions.revokeOthers",
  "reauth",
  "reauth.email.request",
  "user.update",
  "user.changeEmail",
  "user.confirmEmailChange",
  "user.verifyEmailChange",
  "user.delete",
  "user.confirmDelete",
  "username.available",
  "username.set",
  "identities.list",
  "identities.unlink",
  "identities.link",
  "sso.discover",
  "sso.domains.list",
  "sso.domains.add",
  "sso.domains.verify",
  "sso.domains.update",
  "sso.domains.delete",
  "sso.connections.list",
  "sso.connections.create",
  "sso.connections.update",
  "sso.connections.delete",
  "scim.tokens.list",
  "scim.tokens.create",
  "scim.tokens.revoke",
] as const satisfies readonly ClientOperation[];
type Compared = (typeof COMPARED)[number];

/**
 * One `true` per compared row: a row whose method answer differs from the
 * contract refuses it on its own line.
 */
export const ANSWER_ROWS: { readonly [O in Compared]: AnswerEqual<O> } = {
  session: true,
  "session.refresh": true,
  signOut: true,
  "magicLink.request": true,
  "magicLink.verify": true,
  "handoff.redeem": true,
  "passkey.register.verify": true,
  "passkey.signIn.verify": true,
  "passkeys.list": true,
  "passkeys.delete": true,
  "passkeys.rename": true,
  "password.signUp": true,
  "password.signIn": true,
  "password.resendVerification": true,
  "password.verifyEmail": true,
  "password.verifyCode": true,
  "password.requestReset": true,
  "password.reset": true,
  "password.change": true,
  "emailOtp.request": true,
  "emailOtp.verify": true,
  "emailOtp.requestReset": true,
  "emailOtp.reset": true,
  "phone.request": true,
  "phone.verify": true,
  "phone.add": true,
  "phone.verifyAdd": true,
  "phone.remove": true,
  "anonymous.signIn": true,
  "anonymous.delete": true,
  "organizations.create": true,
  "organizations.list": true,
  "organizations.update": true,
  "organizations.delete": true,
  "organizations.members.list": true,
  "organizations.members.add": true,
  "organizations.members.role": true,
  "organizations.members.remove": true,
  "organizations.invitations.invite": true,
  "organizations.invitations.list": true,
  "organizations.invitations.revoke": true,
  "organizations.invitations.accept": true,
  "organizations.invitations.decline": true,
  "organizations.setActive": true,
  "organizations.hasPermission": true,
  "organizations.permissions": true,
  "organizations.checkSlug": true,
  "organizations.roles.list": true,
  "organizations.roles.get": true,
  "organizations.roles.create": true,
  "organizations.roles.update": true,
  "organizations.roles.delete": true,
  "organizations.teams.list": true,
  "organizations.teams.create": true,
  "organizations.teams.update": true,
  "organizations.teams.delete": true,
  "organizations.teams.members.list": true,
  "organizations.teams.members.add": true,
  "organizations.teams.members.remove": true,
  "organizations.teams.setActive": true,
  "organizations.teams.mine": true,
  "organizations.tokens.create": true,
  "organizations.tokens.list": true,
  "organizations.tokens.update": true,
  "organizations.tokens.revoke": true,
  "organizations.tokens.current": true,
  "tokens.create": true,
  "tokens.list": true,
  "tokens.revoke": true,
  "tokens.update": true,
  "tokens.current": true,
  "jwt.token": true,
  "oauth.grants": true,
  "oauth.revoke": true,
  "totp.setup": true,
  "totp.enable": true,
  "totp.verify": true,
  "totp.disable": true,
  "totp.regenerateBackupCodes": true,
  "totp.status": true,
  "totp.revokeTrustedDevices": true,
  "secondFactor.passkey.enable.verify": true,
  "secondFactor.passkey.verify.verify": true,
  "secondFactor.email.enable": true,
  "secondFactor.email.send": true,
  "secondFactor.disable": true,
  "sessions.list": true,
  "sessions.revoke": true,
  "sessions.revokeOthers": true,
  reauth: true,
  "reauth.email.request": true,
  "user.update": true,
  "user.changeEmail": true,
  "user.confirmEmailChange": true,
  "user.verifyEmailChange": true,
  "user.delete": true,
  "user.confirmDelete": true,
  "username.available": true,
  "username.set": true,
  "identities.list": true,
  "identities.unlink": true,
  "identities.link": true,
  "sso.discover": true,
  "sso.domains.list": true,
  "sso.domains.add": true,
  "sso.domains.verify": true,
  "sso.domains.update": true,
  "sso.domains.delete": true,
  "sso.connections.list": true,
  "sso.connections.create": true,
  "sso.connections.update": true,
  "sso.connections.delete": true,
  "scim.tokens.list": true,
  "scim.tokens.create": true,
  "scim.tokens.revoke": true,
};
/** The compared rows that fail, by name; `true` is refused while one exists. */
type FailingAnswer = { [O in Compared]: AnswerEqual<O> extends true ? never : O }[Compared];
export const noFailingAnswer: [FailingAnswer] extends [never] ? true : FailingAnswer = true;

/**
 * The rows whose method sends its input as the body, unchanged, so the input
 * type equals the body type. The other compared rows build their own body:
 * a captcha header, a renamed key, a ceremony's response, or no input.
 */
export const BODY_AS_INPUT = [
  "magicLink.verify",
  "handoff.redeem",
  "passkeys.delete",
  "passkeys.rename",
  "password.resendVerification",
  "password.verifyEmail",
  "password.verifyCode",
  "password.reset",
  "password.change",
  "emailOtp.verify",
  "emailOtp.reset",
  "phone.verify",
  "phone.add",
  "phone.verifyAdd",
  "organizations.create",
  "organizations.update",
  "organizations.delete",
  "organizations.members.add",
  "organizations.members.role",
  "organizations.members.remove",
  "organizations.invitations.invite",
  "organizations.invitations.revoke",
  "organizations.invitations.accept",
  "organizations.invitations.decline",
  "organizations.setActive",
  "organizations.hasPermission",
  "organizations.checkSlug",
  "organizations.roles.create",
  "organizations.roles.update",
  "organizations.roles.delete",
  "organizations.teams.create",
  "organizations.teams.update",
  "organizations.teams.delete",
  "organizations.teams.members.add",
  "organizations.teams.members.remove",
  "organizations.teams.setActive",
  "organizations.tokens.create",
  "organizations.tokens.update",
  "organizations.tokens.revoke",
  "tokens.revoke",
  "tokens.update",
  "oauth.revoke",
  "totp.setup",
  "totp.enable",
  "totp.disable",
  "totp.regenerateBackupCodes",
  "secondFactor.email.enable",
  "secondFactor.email.send",
  "secondFactor.disable",
  "sessions.revoke",
  "user.update",
  "user.changeEmail",
  "user.confirmEmailChange",
  "user.verifyEmailChange",
  "user.confirmDelete",
  "username.set",
  "identities.unlink",
  "sso.discover",
  "sso.domains.add",
  "sso.domains.verify",
  "sso.domains.update",
  "sso.domains.delete",
  "sso.connections.create",
  "sso.connections.update",
  "sso.connections.delete",
  "scim.tokens.create",
  "scim.tokens.revoke",
] as const satisfies readonly Compared[];
type BodyAsInput = (typeof BODY_AS_INPUT)[number];

/** One `true` per body row: a row whose input differs from the body refuses it on its own line. */
export const BODY_ROWS: { readonly [O in BodyAsInput]: BodyEqual<O> } = {
  "magicLink.verify": true,
  "handoff.redeem": true,
  "passkeys.delete": true,
  "passkeys.rename": true,
  "password.resendVerification": true,
  "password.verifyEmail": true,
  "password.verifyCode": true,
  "password.reset": true,
  "password.change": true,
  "emailOtp.verify": true,
  "emailOtp.reset": true,
  "phone.verify": true,
  "phone.add": true,
  "phone.verifyAdd": true,
  "organizations.create": true,
  "organizations.update": true,
  "organizations.delete": true,
  "organizations.members.add": true,
  "organizations.members.role": true,
  "organizations.members.remove": true,
  "organizations.invitations.invite": true,
  "organizations.invitations.revoke": true,
  "organizations.invitations.accept": true,
  "organizations.invitations.decline": true,
  "organizations.setActive": true,
  "organizations.hasPermission": true,
  "organizations.checkSlug": true,
  "organizations.roles.create": true,
  "organizations.roles.update": true,
  "organizations.roles.delete": true,
  "organizations.teams.create": true,
  "organizations.teams.update": true,
  "organizations.teams.delete": true,
  "organizations.teams.members.add": true,
  "organizations.teams.members.remove": true,
  "organizations.teams.setActive": true,
  "organizations.tokens.create": true,
  "organizations.tokens.update": true,
  "organizations.tokens.revoke": true,
  "tokens.revoke": true,
  "tokens.update": true,
  "oauth.revoke": true,
  "totp.setup": true,
  "totp.enable": true,
  "totp.disable": true,
  "totp.regenerateBackupCodes": true,
  "secondFactor.email.enable": true,
  "secondFactor.email.send": true,
  "secondFactor.disable": true,
  "sessions.revoke": true,
  "user.update": true,
  "user.changeEmail": true,
  "user.confirmEmailChange": true,
  "user.verifyEmailChange": true,
  "user.confirmDelete": true,
  "username.set": true,
  "identities.unlink": true,
  "sso.discover": true,
  "sso.domains.add": true,
  "sso.domains.verify": true,
  "sso.domains.update": true,
  "sso.domains.delete": true,
  "sso.connections.create": true,
  "sso.connections.update": true,
  "sso.connections.delete": true,
  "scim.tokens.create": true,
  "scim.tokens.revoke": true,
};
type FailingBody = { [O in BodyAsInput]: BodyEqual<O> extends true ? never : O }[BodyAsInput];
export const noFailingBody: [FailingBody] extends [never] ? true : FailingBody = true;

/** The rows that no method answers as its own value, each with the reason. */
export const NOT_COMPARED = [
  { operation: "social.start", reason: "a browser navigation to a redirect; no JSON answer" },
  { operation: "passkey.register.options", reason: "the first call of the register ceremony" },
  { operation: "passkey.signIn.options", reason: "the first call of the sign-in ceremony" },
  {
    operation: "secondFactor.passkey.enable.options",
    reason: "the first call of the passkey enable ceremony",
  },
  {
    operation: "secondFactor.passkey.verify.options",
    reason: "the first call of the passkey verify ceremony",
  },
  { operation: "reauth.passkey.options", reason: "the first call of the passkey proof" },
  { operation: "sso.start", reason: "a browser navigation to a redirect; no JSON answer" },
] as const satisfies readonly { operation: ClientOperation; reason: string }[];
/** The two lists name every operation of the table, and no other. */
export type _covered = Expect<
  Equal<Compared | (typeof NOT_COMPARED)[number]["operation"], ClientOperation>
>;

/**
 * A row with `select` and a `:name` path fails the compile (plan 11g Task 4
 * review, Low 3). `part` sends the row's path with no fill. The error line
 * below is the test; it fails the compile the day the type admits the row.
 */
export const TEMPLATE_REFUSED = [
  // @ts-expect-error A select row cannot name a template path.
  { operation: "link", method: "POST", path: "/social/:provider/link", select: "url" },
  { operation: "list", method: "GET", path: "/passkeys", select: "passkeys" },
] as const satisfies readonly ClientCall[];
