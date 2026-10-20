// The admin calls of Better Auth that core does not serve (plan 12f), in
// one table. The handler answers each path with its line, and the client's
// `admin` namespace answers each call with the same line (ruling 60 m1).
// This module imports nothing, so the client bundle stays small.

const NOT_A_DELETE =
  "core has no password set and no user delete by an operator in plan 12f; an operator bans, and the person resets the password or deletes the account (spec section 26 item 15)";

/** Each admin call that core does not serve, by path, with its method and its line. */
export const ADMIN_NOT_SUPPORTED: Readonly<
  Record<string, { method: "GET" | "POST"; why: string }>
> = {
  "/admin/set-user-password": { method: "POST", why: NOT_A_DELETE },
  "/admin/remove-user": { method: "POST", why: NOT_A_DELETE },
  "/admin/create-user": {
    method: "POST",
    why: "core has no user create by an operator in plan 12f; createAdmin makes the first operator only (spec section 26 items 11 and 15)",
  },
  "/admin/update-user": {
    method: "POST",
    why: "core has no user update by an operator in plan 12f (spec section 26 item 15)",
  },
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
