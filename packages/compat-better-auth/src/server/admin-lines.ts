// The admin calls of Better Auth that core does not serve (plans 12f and
// 12f2), in one table. The handler answers each path with its line, and the client's
// `admin` namespace answers each call with the same line (ruling 60 m1).
// This module imports nothing, so the client bundle stays small.

// Plan 12f2 (ruling 1 B9 item 3): a password that an operator knows signs
// in outside the audited impersonation, so no operator path sets one. The
// create-user refusal of a password (admin.ts) gives the same line.
export const NO_PASSWORD_SET =
  "core lets no operator set a password, because a password that an operator knows signs in outside an impersonation; the person resets it through the reset link (spec section 26 item 15)";

/** Each admin call that core does not serve, by path, with its method and its line. */
export const ADMIN_NOT_SUPPORTED: Readonly<
  Record<string, { method: "GET" | "POST"; why: string }>
> = {
  "/admin/set-user-password": { method: "POST", why: NO_PASSWORD_SET },
  "/admin/list-user-sessions": {
    method: "POST",
    why: "core gives an operator the count of live sessions in get-user, never the session rows (spec section 26 item 4)",
  },
  "/admin/revoke-user-session": {
    method: "POST",
    why: "core ends all sessions of a user, never one by its token; use /admin/revoke-user-sessions (spec section 26 item 5)",
  },
  "/admin/has-permission": {
    method: "POST",
    why: "core has no permission statements for operators; the platform role holds every operator tool (spec section 26 items 2 and 15)",
  },
};
