import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appActor,
  isPlatformOperator,
  matchOperatorSecret,
  requireOperatorUser,
  requireScope,
} from "../src/engine/operator/guards.js";
import { addMember } from "../src/engine/organizations.js";
import { passwordSignUp } from "../src/engine/password.js";
import { constantTimeEqual } from "../src/primitives/crypto.js";
import { BASE_URL } from "./helpers.js";
import {
  OPERATOR_SECRETS,
  operatorAuth,
  operatorFixture,
  operatorHeader,
  sessionOf,
} from "./operator-helpers.js";
import { signUpAndVerify } from "./password-helpers.js";
import { enrolled, PASSWORD } from "./totp-helpers.js";

// A pass-through spy: the real compare runs, and the test counts the calls.
vi.mock("../src/primitives/crypto.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/primitives/crypto.js")>();
  return { ...real, constantTimeEqual: vi.fn(real.constantTimeEqual) };
});

const compare = vi.mocked(constantTimeEqual);

afterEach(() => {
  vi.restoreAllMocks();
});

const MINUTE = 60_000;

const operatorRequest = (secret: string) =>
  new Request(`${BASE_URL}/auth/operator/users`, { headers: operatorHeader(secret) });

describe("the operator user guard (plan 12f)", () => {
  it("answers one code for each failed step of the operator user guard", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const noMember = await operatorFixture({ role: null });
    const viewer = await operatorFixture({ role: "viewer" });
    const noFactor = await operatorFixture({ factor: false });
    const stale = await operatorFixture();
    // The default window of session.freshMinutes is 1440 minutes.
    stale.auth.clock.advance(1441 * MINUTE);
    // A password sign-up with no verify. addMember refuses an unverified
    // user (email_unverified), so this user also holds no member row.
    const unverified = await operatorFixture();
    const up = await passwordSignUp(unverified.auth.config, {
      email: "new@example.com",
      password: PASSWORD,
      ip: null,
      userAgent: null,
    });
    if (!up.ok || !("token" in up.value)) throw new Error("the sign-up opened no session");
    const results = [
      await requireOperatorUser(noMember.auth.config, noMember.operator),
      await requireOperatorUser(viewer.auth.config, viewer.operator),
      await requireOperatorUser(
        unverified.auth.config,
        await sessionOf(unverified.auth, up.value.token),
      ),
      await requireOperatorUser(noFactor.auth.config, noFactor.operator),
      await requireOperatorUser(
        stale.auth.config,
        await sessionOf(stale.auth, stale.operator.token),
      ),
    ];
    for (const r of results)
      expect(r).toEqual({ ok: false, code: "operator_required", status: 403 });
    expect(new Set(results.map((r) => JSON.stringify(r))).size).toBe(1);
    // One log line per refusal, with the route name and no user id.
    const lines = errors.mock.calls.filter((c) => c[0] === "authtempo: operator guard refused");
    expect(lines).toHaveLength(5);
    for (const line of lines) {
      expect(line).toEqual(["authtempo: operator guard refused", "api"]);
      expect(JSON.stringify(line)).not.toContain(noMember.operator.user.id);
    }
  });

  it("passes a platform operator with all five steps", async () => {
    const f = await operatorFixture();
    const r = await requireOperatorUser(f.auth.config, f.operator, "GET /operator/users");
    expect(r.ok && r.value.kind).toBe("user");
    expect(r.ok && r.value.user.id).toBe(f.operator.user.id);
    expect(r.ok && r.value.session.id).toBe(f.operator.session.id);
    expect(await isPlatformOperator(f.auth.config, f.operator.user.id)).toBe(true);
    expect(await isPlatformOperator(f.auth.config, f.root.id)).toBe(true);
  });

  it("counts every call of a platform operator", async () => {
    const f = await operatorFixture();
    for (let i = 0; i < 600; i++) {
      const r = await requireOperatorUser(f.auth.config, f.operator);
      if (!r.ok) throw new Error(`call ${i + 1}: ${r.code}`);
    }
    expect(await requireOperatorUser(f.auth.config, f.operator)).toEqual({
      ok: false,
      code: "rate_limited",
      status: 429,
    });
    // The key holds the user id: a second platform operator keeps a full window.
    // The grant comes before the sign-in, as the guard asks (ruling 50).
    await signUpAndVerify(f.auth, "op2@example.com", PASSWORD);
    const op2 = await f.auth.storage.findOne("user", [
      { field: "email", op: "eq", value: "op2@example.com" },
    ]);
    const added = await addMember(f.auth.config, {
      user: f.root,
      organizationId: f.platformOrg.id,
      userId: op2?.id ?? "",
      role: "operator",
    });
    if (!added.ok) throw new Error(added.code);
    const second = await enrolled(f.auth, "op2@example.com");
    const r = await requireOperatorUser(
      f.auth.config,
      await sessionOf(f.auth, second.session.token),
    );
    expect(r.ok && r.value.user.id).toBe(second.user.id);
  });
});

describe("the operator secret (plan 12f)", () => {
  it("compares the secret against every entry", async () => {
    const auth = await operatorAuth();
    const cases = [
      [OPERATOR_SECRETS.support, "support"],
      [OPERATOR_SECRETS.audit, "audit"],
      ["operator-wrong-0123456789abcdef-0123456", null],
    ] as const;
    for (const [secret, name] of cases) {
      compare.mockClear();
      const entry = await matchOperatorSecret(auth.config, operatorRequest(secret));
      expect(entry?.name ?? null).toBe(name);
      expect(compare, `${name}`).toHaveBeenCalledTimes(3);
    }
  });

  it("answers null with no compare for a header of another form", async () => {
    const auth = await operatorAuth();
    for (const header of ["", `Bearer ${OPERATOR_SECRETS.support}`, "Operator short"]) {
      compare.mockClear();
      const request = new Request(`${BASE_URL}/auth/operator/users`, {
        headers: header === "" ? {} : { authorization: header },
      });
      expect(await matchOperatorSecret(auth.config, request)).toBeNull();
      expect(compare).not.toHaveBeenCalled();
    }
  });
});

describe("the scope and the app actor (plan 12f)", () => {
  it("passes a user actor and an app actor, and a secret actor with the scope only", async () => {
    const f = await operatorFixture();
    const user = await requireOperatorUser(f.auth.config, f.operator);
    if (!user.ok) throw new Error(user.code);
    const app = appActor("billing.job");
    if (!app.ok) throw new Error(app.code);
    const secret = { kind: "secret", name: "audit", scopes: ["audit"] } as const;
    expect(requireScope(user.value, "users")).toEqual({ ok: true, value: true });
    expect(requireScope(app.value, "users")).toEqual({ ok: true, value: true });
    expect(requireScope(secret, "audit")).toEqual({ ok: true, value: true });
    expect(requireScope(secret, "users")).toEqual({
      ok: false,
      code: "operator_required",
      status: 403,
    });
  });

  it("refuses an app name outside 1 to 64 characters of [a-z0-9_.-]", () => {
    expect(appActor("a")).toEqual({ ok: true, value: { kind: "app", name: "a" } });
    expect(appActor("x".repeat(64)).ok).toBe(true);
    for (const name of ["", "x".repeat(65), "Billing", "a b", "a/b", "ä"])
      expect(appActor(name), name).toEqual({ ok: false, code: "invalid_body", status: 400 });
  });
});
