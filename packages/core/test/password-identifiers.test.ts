import { describe, expect, it, vi } from "vitest";
import type { AuthConfig } from "../src/config.js";
import { type PasswordSignIn, passwordSignIn } from "../src/engine/password.js";
import { requestPhone, verifyPhone } from "../src/engine/phone.js";
import { setUsername } from "../src/engine/username.js";
import { createRouter } from "../src/http/router.js";
import { coreRoutes } from "../src/http/routes/index.js";
import type { PasswordHashSeam } from "../src/seams/password-hash.js";
import { createRecordingSms } from "../src/testing/recording-sms.js";
import { post } from "./helpers.js";
import { FAST } from "./password-helpers.js";
import { type Auth, EMAIL, enrolled, PASSWORD, totpAuth, verifiedSession } from "./totp-helpers.js";

// One sign-in route for three identifiers (plan 12i Task 3, spec 32 item 6).
// The case "signs in by phone" (Task 5) makes its phone user by a real
// code: no test here seeds a phone.

const PHONE = "+14155550100";

/** A seam that records the stored value of each verify. */
function counting(inner: PasswordHashSeam) {
  const verified: string[] = [];
  const seam: PasswordHashSeam = {
    dummy: () => inner.dummy(),
    hash: (p) => inner.hash(p),
    verify: (p, stored) => {
      verified.push(stored);
      return inner.verify(p, stored);
    },
  };
  return { verified, seam };
}

/** The engine with the username on and the detailed sign-up answer of plan 8. */
function world(extra: Partial<AuthConfig> = {}) {
  return totpAuth({ username: {}, ...extra });
}

/** The engine with the username and the phone on, for the numbers of +1 only. */
function phoneWorld(extra: Partial<AuthConfig> = {}) {
  return world({
    phone: { sms: createRecordingSms(), regions: ["+1"], isolateLimiter: "allow" },
    ...extra,
  });
}

/** A verified user with a password and the username `name`, set by the real route engine. */
async function named(auth: Auth, email = EMAIL, name = "Alice") {
  const me = await verifiedSession(auth, email);
  const set = await setUsername(auth.config, {
    session: me,
    username: name,
    ip: null,
    userAgent: null,
  });
  if (!set.ok) throw new Error(set.code);
  return me;
}

/** A sign-in with the given keys. The keys can break the type, as a plain JavaScript caller can. */
const signIn = (auth: Auth, input: Record<string, string>, ip = "203.0.113.9") =>
  passwordSignIn(auth.config, {
    password: PASSWORD,
    ip,
    userAgent: "ua",
    ...input,
  } as unknown as PasswordSignIn);

async function call(handle: (r: Request) => Promise<Response>, request: Request) {
  const res = await handle(request);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("the password sign-in by email, username, or phone (plan 12i Task 3)", () => {
  it("signs in by username", async () => {
    const auth = world();
    const me = await named(auth);
    // The typed form differs from the stored form `alice`: the sign-in normalizes it.
    for (const username of ["Alice", "ALICE", "ａlice"]) {
      const r = await signIn(auth, { username });
      if (!r.ok || !("token" in r.value)) throw new Error(`no session for ${username}`);
      expect(r.value.user.id).toBe(me.user.id);
    }
    // Through the route too: a session with the cookie.
    const handle = createRouter(auth.config, coreRoutes(auth.config));
    const res = await handle(
      post("/auth/password/sign-in", { username: "alice", password: PASSWORD }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { user: { id: string } }).user.id).toBe(me.user.id);
    expect(res.headers.getSetCookie().some((c) => c.startsWith("__Host-tempo_session="))).toBe(
      true,
    );
  });

  it("refuses a phone that is not E.164 or not in a region with invalid_credentials", async () => {
    const { verified, seam } = counting(FAST);
    const auth = phoneWorld({ password: { hash: seam, uniformSignUp: false } });
    await named(auth);
    const dummy = await FAST.dummy();
    // The reads of a user by phone: a bad form reads nothing.
    const reads = vi.spyOn(auth.config.storage, "findOne");
    const byPhone = () =>
      reads.mock.calls.filter(
        ([model, where]) => model === "user" && String(where[0]?.field) === "phone",
      );
    // The last two are E.164 outside the one region +1: no stored phone of
    // them signs in (phoneSignsIn), so they answer as a bad form.
    for (const phone of [
      "555",
      "4155550100",
      "+0123456789",
      "+1415555010012345",
      "+1 415 555",
      "+447700900123",
      "+33612345678",
    ]) {
      verified.length = 0;
      expect(await signIn(auth, { phone }), phone).toMatchObject({
        ok: false,
        code: "invalid_credentials",
      });
      // The bad form costs one verify against the dummy, as an unknown address does.
      expect(verified, phone).toEqual([dummy]);
    }
    expect(byPhone()).toHaveLength(0);
    // A well-formed number that no user holds answers the same, after one read.
    verified.length = 0;
    expect(await signIn(auth, { phone: PHONE })).toMatchObject({ code: "invalid_credentials" });
    expect(verified).toEqual([dummy]);
    expect(byPhone()).toHaveLength(1);
  });

  it("refuses two identifiers or none", async () => {
    const auth = world();
    await named(auth);
    const handle = createRouter(auth.config, coreRoutes(auth.config));
    const bodies = [
      { email: EMAIL, username: "alice", password: PASSWORD },
      { email: EMAIL, phone: PHONE, password: PASSWORD },
      { username: "alice", phone: PHONE, password: PASSWORD },
      { password: PASSWORD },
      { username: "alice" },
      // An empty string is a value, so it counts as a second identifier.
      { email: EMAIL, username: "", password: PASSWORD },
      { email: "", username: "alice", password: PASSWORD },
    ];
    for (const body of bodies)
      expect(
        await call(handle, post("/auth/password/sign-in", body)),
        JSON.stringify(body),
      ).toEqual({ status: 400, body: { error: "invalid_body" } });
    // The engine holds the rule too, for a plain JavaScript caller.
    for (const input of [
      { email: EMAIL, username: "alice" },
      { email: EMAIL, username: "" },
      { email: "", username: "alice" },
      {},
    ])
      expect(await signIn(auth, input), JSON.stringify(input)).toMatchObject({
        ok: false,
        code: "invalid_body",
      });
    // A key the body does not name still passes, as before this plan.
    const extra = await call(
      handle,
      post("/auth/password/sign-in", { email: EMAIL, password: PASSWORD, rememberMe: true }),
    );
    expect(extra.status).toBe(200);
    // With the username off, the field is not a way in.
    const off = totpAuth();
    await verifiedSession(off);
    const offHandle = createRouter(off.config, coreRoutes(off.config));
    expect(
      await call(
        offHandle,
        post("/auth/password/sign-in", { username: "alice", password: PASSWORD }),
      ),
    ).toEqual({ status: 400, body: { error: "invalid_body" } });
  });

  it("refuses a phone with the phone config off, as a username with its config off (ruling 20)", async () => {
    // A compat store can hold a phone that Better Auth proved. With `phone`
    // off no phone code exists, so the number is no way in (ruling 15).
    const { verified, seam } = counting(FAST);
    const off = world({ password: { hash: seam, uniformSignUp: false } });
    await named(off);
    const reads = vi.spyOn(off.config.storage, "findOne");
    const limits = vi.spyOn(off.config.limiter, "allow");
    const handle = createRouter(off.config, coreRoutes(off.config));
    verified.length = 0;
    expect(
      await call(handle, post("/auth/password/sign-in", { phone: PHONE, password: PASSWORD })),
    ).toEqual({ status: 400, body: { error: "invalid_body" } });
    expect(await signIn(off, { phone: PHONE })).toMatchObject({ ok: false, code: "invalid_body" });
    // The same answer as a username with the username config off.
    const noName = totpAuth();
    expect(await signIn(noName, { username: "alice" })).toMatchObject({ code: "invalid_body" });
    // No verify, no read of a user, and no per-phone count.
    expect(verified).toEqual([]);
    expect(reads.mock.calls.filter(([model]) => model === "user")).toHaveLength(0);
    expect(
      limits.mock.calls.map(([key]) => String(key)).filter((k) => k.includes("phone")),
    ).toEqual([]);
  });

  it("answers invalid_credentials for an unknown username and runs the dummy hash", async () => {
    const { verified, seam } = counting(FAST);
    const auth = world({ password: { hash: seam, uniformSignUp: false } });
    await named(auth);
    const handle = createRouter(auth.config, coreRoutes(auth.config));
    const dummy = await FAST.dummy();
    verified.length = 0;
    const unknown = await call(
      handle,
      post("/auth/password/sign-in", { username: "nobody", password: PASSWORD }),
    );
    const unknownVerifies = [...verified];
    verified.length = 0;
    const wrong = await call(
      handle,
      post("/auth/password/sign-in", { username: "alice", password: "a wrong horse battery" }),
    );
    // The same status and the same body.
    expect(unknown).toEqual({ status: 401, body: { error: "invalid_credentials" } });
    expect(wrong).toEqual(unknown);
    // One verify each: the dummy for the unknown name, the real hash for the wrong password.
    expect(unknownVerifies).toEqual([dummy]);
    expect(verified).toHaveLength(1);
    expect(verified[0]).not.toBe(dummy);
    // A name that breaks the form or is reserved answers the same, after the dummy.
    for (const username of ["al", "ada@home", "admin"]) {
      verified.length = 0;
      expect(
        await call(handle, post("/auth/password/sign-in", { username, password: PASSWORD })),
        username,
      ).toEqual(unknown);
      expect(verified, username).toEqual([dummy]);
    }
  });

  it("applies the per-identifier limits", async () => {
    const auth = phoneWorld();
    await named(auth);
    // Ten tries for one name, each from its own IP, in two cases of the name.
    for (let i = 0; i < 10; i++)
      expect(
        await signIn(
          auth,
          { username: i % 2 ? "Alice" : "alice", password: "wrong" },
          `198.51.100.${i}`,
        ),
      ).toMatchObject({ code: "invalid_credentials" });
    expect(await signIn(auth, { username: "alice" }, "198.51.100.200")).toMatchObject({
      code: "rate_limited",
    });
    // The same for one phone.
    for (let i = 0; i < 10; i++)
      expect(await signIn(auth, { phone: PHONE }, `192.0.2.${i}`)).toMatchObject({
        code: "invalid_credentials",
      });
    expect(await signIn(auth, { phone: PHONE }, "192.0.2.200")).toMatchObject({
      code: "rate_limited",
    });
    // Each phone has its own count: another number is not limited.
    expect(await signIn(auth, { phone: "+14155550101" }, "192.0.2.201")).toMatchObject({
      code: "invalid_credentials",
    });
    // Another name and the address still sign in.
    expect(await signIn(auth, { email: EMAIL }, "198.51.100.201")).toMatchObject({ ok: true });
    // The per-IP limit still applies: 20 tries of 20 names from one IP, then 429.
    for (let i = 0; i < 20; i++)
      expect(await signIn(auth, { username: `name${i}` }, "203.0.113.50")).toMatchObject({
        code: "invalid_credentials",
      });
    expect(await signIn(auth, { username: "alice" }, "203.0.113.50")).toMatchObject({
      code: "rate_limited",
    });
  });

  it("signs in by phone", async () => {
    // A user with no address: the phone sign-up by a real code, then a first password.
    const sms = createRecordingSms();
    const auth = world({
      phone: { sms, regions: ["+1"], isolateLimiter: "allow", signUp: true },
    });
    const handle = createRouter(auth.config, coreRoutes(auth.config));
    expect(await requestPhone(auth.config, { phone: PHONE, ip: "203.0.113.7" })).toEqual({
      ok: true,
      value: { sent: true },
    });
    const code = /^(\d+) /.exec(sms.sent.at(-1)?.text ?? "")?.[1] ?? "";
    const made = await verifyPhone(auth.config, {
      phone: PHONE,
      code,
      ip: "203.0.113.7",
      userAgent: "ua",
    });
    if (!made.ok || !("token" in made.value)) throw new Error("no phone session");
    const cookie = { cookie: `${auth.config.cookieName}=${made.value.token}` };
    const first = await call(
      handle,
      post("/auth/password/change", { newPassword: PASSWORD }, cookie),
    );
    expect(first).toEqual({ status: 200, body: { ok: true } });
    const res = await call(
      handle,
      post("/auth/password/sign-in", { phone: PHONE, password: PASSWORD }),
    );
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: made.value.user.id, email: null });
    // A wrong password answers as an unknown number does.
    const wrongPassword = await call(
      handle,
      post("/auth/password/sign-in", { phone: PHONE, password: "a wrong horse battery" }),
    );
    const unknown = await call(
      handle,
      post("/auth/password/sign-in", { phone: "+14155550199", password: PASSWORD }),
    );
    expect(wrongPassword).toEqual({ status: 401, body: { error: "invalid_credentials" } });
    expect(unknown).toEqual(wrongPassword);
  });

  it("gates a username sign-in as an address sign-in", async () => {
    const auth = world();
    const { session } = await enrolled(auth);
    const set = await setUsername(auth.config, {
      session,
      username: "Alice",
      ip: null,
      userAgent: null,
    });
    if (!set.ok) throw new Error(set.code);
    const byName = await signIn(auth, { username: "alice" });
    const byAddress = await signIn(auth, { email: EMAIL });
    if (!byName.ok || !("twoFactor" in byName.value)) throw new Error("no challenge by name");
    if (!byAddress.ok || !("twoFactor" in byAddress.value)) throw new Error("no challenge");
    expect(byName.value.twoFactor.methods).toEqual(byAddress.value.twoFactor.methods);
    expect(byName.value.twoFactor.methods.length).toBeGreaterThan(0);
    // No session opened for either.
    expect("token" in byName.value).toBe(false);
  });
});
