import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { confirmEmailChange, requestEmailChange } from "../../src/engine/email-change.js";
import { passwordSignIn } from "../../src/engine/password.js";
import { resolveSession } from "../../src/engine/sessions.js";
import { tokenFromMail } from "../helpers.js";
import { sessionOnly, signUpAndVerify } from "../password-helpers.js";
import { type ScimWorld, scim, scimAuth, scimToken } from "./helpers.js";

// A SCIM write of a person whose address left the domains of the
// organization (M2 of the final review of plan 12d, ruling 74). The directory
// owns the address of its staff only while a verified domain of the
// organization claims it. A move and a reactivate answer 400 mutability, and
// write nothing.

const USER_URN = "urn:ietf:params:scim:schemas:core:2.0:User";
const PATCH_URN = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
const ADA = "ada@acme.example";
const PERSONAL = "ada@personal.example";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const patch = (...ops: Record<string, unknown>[]) => ({ schemas: [PATCH_URN], Operations: ops });

/**
 * Ada signs up at her work address, Acme's directory creates her SCIM User,
 * and then she moves her account to her personal address by the email
 * change. The answer is her SCIM id and her user id.
 */
async function adaLeft(w: ScimWorld, token: string) {
  await signUpAndVerify(w, ADA);
  const made = await scim(w, token, "POST", "/Users", { schemas: [USER_URN], userName: ADA });
  expect(made.status).toBe(201);
  const id = String(((await made.json()) as { id: string }).id);
  const signed = await sessionOnly(
    passwordSignIn(w.config, {
      email: ADA,
      password: "correct horse battery",
      ip: null,
      userAgent: null,
    }),
  );
  if (!signed.ok) throw new Error(signed.code);
  const me = await resolveSession(w.config, signed.value.token);
  if (!me) throw new Error("no session");
  expect((await requestEmailChange(w.config, { session: me, newEmail: PERSONAL })).ok).toBe(true);
  const link = tokenFromMail(w.mail.findLast((m) => m.to === PERSONAL)?.text ?? "");
  expect((await confirmEmailChange(w.config, { token: link, ip: null, userAgent: null })).ok).toBe(
    true,
  );
  return { id, userId: me.user.id };
}

const userOf = (w: ScimWorld, userId: string) =>
  w.storage.findOne("user", [{ field: "id", op: "eq", value: userId }]);

describe("a SCIM write of a user whose address left the domain (ruling 74 M2)", () => {
  it("moves no personal address back into the domain", async () => {
    const w = await scimAuth();
    const { token } = await scimToken(w);
    const ada = await adaLeft(w, token);
    const before = await userOf(w, ada.userId);
    const moved = await scim(
      w,
      token,
      "PATCH",
      `/Users/${ada.id}`,
      patch({ op: "replace", path: "userName", value: "taken.back@acme.example" }),
    );
    const body = (await moved.json()) as { scimType?: string };
    expect([moved.status, body.scimType]).toEqual([400, "mutability"]);
    expect(await userOf(w, ada.userId)).toEqual(before);
    // A replace with PUT takes the same rule.
    const put = await scim(w, token, "PUT", `/Users/${ada.id}`, {
      schemas: [USER_URN],
      userName: "taken.back@acme.example",
    });
    expect(put.status).toBe(400);
    expect((await userOf(w, ada.userId))?.email).toBe(PERSONAL);
  });

  it("gives no member row back at a reactivate", async () => {
    const w = await scimAuth();
    const { token } = await scimToken(w);
    const ada = await adaLeft(w, token);
    const off = await scim(
      w,
      token,
      "PATCH",
      `/Users/${ada.id}`,
      patch({ op: "replace", path: "active", value: false }),
    );
    expect(off.status).toBe(200);
    // The deactivate keeps the address that Ada chose.
    expect((await userOf(w, ada.userId))?.email).toBe(PERSONAL);
    const member = [{ field: "userId" as const, op: "eq" as const, value: ada.userId }];
    expect(await w.storage.findMany("member", member)).toEqual([]);
    const on = await scim(
      w,
      token,
      "PATCH",
      `/Users/${ada.id}`,
      patch({ op: "replace", path: "active", value: true }),
    );
    const body = (await on.json()) as { scimType?: string };
    expect([on.status, body.scimType]).toEqual([400, "mutability"]);
    expect(await w.storage.findMany("member", member)).toEqual([]);
    const row = await w.storage.findOne("scimUser", [{ field: "id", op: "eq", value: ada.id }]);
    expect(row?.active).toBe(false);
  });

  it("still moves and reactivates a user whose address the organization claims", async () => {
    const w = await scimAuth();
    const { token } = await scimToken(w);
    const made = await scim(w, token, "POST", "/Users", { schemas: [USER_URN], userName: ADA });
    const id = String(((await made.json()) as { id: string }).id);
    const off = await scim(
      w,
      token,
      "PATCH",
      `/Users/${id}`,
      patch({ op: "replace", path: "active", value: false }),
    );
    expect(off.status).toBe(200);
    const on = await scim(
      w,
      token,
      "PATCH",
      `/Users/${id}`,
      patch(
        { op: "replace", path: "active", value: true },
        { op: "replace", path: "userName", value: "ada2@acme.example" },
      ),
    );
    expect(on.status).toBe(200);
    const user = await w.storage.findOne("user", [
      { field: "email", op: "eq", value: "ada2@acme.example" },
    ]);
    expect(user?.emailVerified).toBe(true);
    const member = await w.storage.findMany("member", [
      { field: "userId", op: "eq", value: user?.id ?? "" },
    ]);
    expect(member.length).toBe(1);
  });
});
