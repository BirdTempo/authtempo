import { createHash } from "node:crypto";
import type { OperatorAuditRow } from "@authtempo/core";
import { describe, expect, it } from "vitest";
import { APP, call, harness, linkIn, signIn } from "../support/harness.ts";
import { ADMIN_ACTOR, adminAudit, adminBan, createOperatorAuth } from "./operator-tools.ts";

const SUPPORT = "support-secret-0123456789abcdef0123456789";
const INCIDENT = "incident-secret-0123456789abcdef012345678";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");

function setup() {
  const h = harness();
  const copies: OperatorAuditRow[] = [];
  const auth = createOperatorAuth(h, {
    supportHash: hash(SUPPORT),
    incidentHash: hash(INCIDENT),
    copy: async (row) => {
      copies.push(row);
    },
  });
  return { h, auth, copies };
}

/** A POST of the admin page to the app's own route. */
const banRequest = (body: unknown) =>
  new Request(`${APP}/admin/ban`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

async function userIdOf(auth: ReturnType<typeof setup>["auth"], email: string): Promise<string> {
  const found = await auth.api.operator.users.search({ actor: ADMIN_ACTOR, email });
  if (!found.ok) throw new Error(found.code);
  return found.value.users[0]?.id ?? "";
}

describe("the operator tools", () => {
  it("bans a user from the app's admin route, with an audit row and its copy", async () => {
    const { h, auth, copies } = setup();
    const cookie = await signIn(auth, h, "ada@example.com");
    const userId = await userIdOf(auth, "ada@example.com");
    const res = await adminBan(
      auth,
      banRequest({ userId, reason: "Spam from this account" }),
      async () => true,
    );
    expect([res.status, await res.json()]).toEqual([200, { auditId: expect.any(String) }]);
    // The ban ended the session in its transaction.
    expect((await call(auth, "GET", "/auth/session", undefined, { cookie })).status).toBe(401);
    // A new sign-in proves the credential first, and then learns of the ban.
    await call(auth, "POST", "/auth/magic-link/request", { email: "ada@example.com" });
    const token = linkIn(h, "ada@example.com").searchParams.get("token") ?? "";
    const again = await call(auth, "POST", "/auth/magic-link/verify", { token });
    expect([again.status, await again.json()]).toEqual([403, { error: "account_banned" }]);
    const rows = await adminAudit(auth, userId);
    expect(rows.map((r) => [r.actorKind, r.actorId, r.action, r.reason])).toEqual([
      ["app", "admin-page", "ban", "Spam from this account"],
    ]);
    expect(copies.map((r) => r.id)).toEqual(rows.map((r) => r.id));
  });

  it("writes nothing when the app's own staff check refuses", async () => {
    const { h, auth, copies } = setup();
    await signIn(auth, h, "ada@example.com");
    const userId = await userIdOf(auth, "ada@example.com");
    const res = await adminBan(auth, banRequest({ userId, reason: "Spam" }), async () => false);
    expect(res.status).toBe(403);
    expect([await adminAudit(auth, userId), copies]).toEqual([[], []]);
  });

  it("gives each named secret the scopes of its job only", async () => {
    const { h, auth } = setup();
    await signIn(auth, h, "ada@example.com");
    const list = (secret: string) =>
      call(auth, "GET", "/auth/operator/users", undefined, {
        authorization: `Operator ${secret}`,
      });
    const support = await list(SUPPORT);
    expect(support.status).toBe(200);
    const incident = await list(INCIDENT);
    expect([incident.status, await incident.json()]).toEqual([403, { error: "operator_required" }]);
  });
});
