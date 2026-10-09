import { describe, expect, it } from "vitest";
import {
  continueHandoff,
  continuePath,
  redeemHandoff,
  startHandoff,
} from "../src/engine/handoff.js";
import { resolveSession } from "../src/engine/sessions.js";
import { randomBase64Url, sha256Base64Url, sha256Hex } from "../src/primitives/crypto.js";
import { makeAuth } from "./helpers.js";

const SCHEMES = ["consumera://"];
const DEV = /^exp:\/\/[\d.]+:\d+\/--\/auth$/;

function handoffAuth(over: Parameters<typeof makeAuth>[0] = {}) {
  return makeAuth({ handoff: { schemes: SCHEMES, devRedirectPattern: DEV }, ...over });
}

async function pkce() {
  const verifier = randomBase64Url(32);
  return { verifier, challenge: await sha256Base64Url(verifier) };
}

async function rows(auth: ReturnType<typeof makeAuth>) {
  const found = await auth.storage.findMany("verification", [
    { field: "purpose", op: "eq", value: "handoff-code" },
  ]);
  // The clock is frozen, so row ids tie on time and sort at random. Put the start row first.
  return found.sort((a, b) => Number(b.identifier === "start") - Number(a.identifier === "start"));
}

describe("startHandoff", () => {
  it("writes a start row with the challenge and redirect and returns the handoff id", async () => {
    const auth = handoffAuth();
    const { challenge } = await pkce();
    const r = await startHandoff(auth.config, {
      challenge,
      redirect: "consumera://auth",
      ip: "1.1.1.1",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.handoffId).toMatch(/^hs_[A-Za-z0-9_-]{43}$/);
    expect(continuePath(auth.config, r.value.handoffId)).toBe(
      `/auth/handoff/continue?h=${r.value.handoffId}`,
    );
    const [row] = await rows(auth);
    expect(row).toMatchObject({
      identifier: "start",
      consumedAt: null,
      data: { challenge, redirect: "consumera://auth" },
    });
    expect(row?.valueHash).toBe(await sha256Hex(r.value.handoffId));
    expect(row?.expiresAt.getTime()).toBe(auth.clock.now().getTime() + 10 * 60_000);
    expect(JSON.stringify(row)).not.toContain(r.value.handoffId.slice(3));
  });
  it("accepts a dev redirect that matches the pattern, and refuses other redirects and bad challenges (Review Focus 5)", async () => {
    const auth = handoffAuth();
    const { challenge } = await pkce();
    expect(
      (
        await startHandoff(auth.config, {
          challenge,
          redirect: "exp://192.168.1.5:8081/--/auth",
          ip: null,
        })
      ).ok,
    ).toBe(true);
    for (const redirect of [
      "https://evil.example/auth",
      "consumera://evil",
      "consumera://auth?x=1",
      "exp://evil.example:80/--/auth",
      "",
    ]) {
      expect(await startHandoff(auth.config, { challenge, redirect, ip: null })).toMatchObject({
        ok: false,
        code: "invalid_body",
      });
    }
    expect(
      await startHandoff(auth.config, {
        challenge: "short",
        redirect: "consumera://auth",
        ip: null,
      }),
    ).toMatchObject({ ok: false, code: "invalid_body" });
    expect(await rows(auth)).toHaveLength(1);
    const plain = makeAuth({ handoff: { schemes: SCHEMES } });
    expect(
      await startHandoff(plain.config, {
        challenge,
        redirect: "exp://192.168.1.5:8081/--/auth",
        ip: null,
      }),
    ).toMatchObject({ ok: false, code: "invalid_body" });
    const off = makeAuth();
    expect(
      await startHandoff(off.config, { challenge, redirect: "consumera://auth", ip: null }),
    ).toMatchObject({ ok: false, code: "not_found" });
  });
  it("limits starts to 30 per ip per 15 minutes", async () => {
    const auth = handoffAuth();
    const { challenge } = await pkce();
    for (let i = 0; i < 30; i++)
      expect(
        (
          await startHandoff(auth.config, {
            challenge,
            redirect: "consumera://auth",
            ip: "9.9.9.9",
          })
        ).ok,
      ).toBe(true);
    expect(
      await startHandoff(auth.config, { challenge, redirect: "consumera://auth", ip: "9.9.9.9" }),
    ).toMatchObject({ ok: false, code: "rate_limited" });
  });
});

describe("continueHandoff and redeemHandoff", () => {
  async function started(auth: ReturnType<typeof makeAuth>) {
    const { verifier, challenge } = await pkce();
    const r = await startHandoff(auth.config, {
      challenge,
      redirect: "consumera://auth",
      ip: null,
    });
    if (!r.ok) throw new Error(r.code);
    return { verifier, handoffId: r.value.handoffId };
  }
  async function continued(auth: ReturnType<typeof makeAuth>, handoffId: string, userId: string) {
    const r = await continueHandoff(auth.config, { handoffId, userId });
    if (!r.ok) throw new Error(r.code);
    const url = new URL(r.value.location);
    return { location: r.value.location, code: url.searchParams.get("code") ?? "" };
  }

  it("consumes the start row, mints a code row for the user, and redeems it for a bearer session", async () => {
    const auth = handoffAuth();
    const user = await auth.seedUser("ada@example.com");
    const { verifier, handoffId } = await started(auth);
    const { location, code } = await continued(auth, handoffId, user.id);
    expect(location).toBe(`consumera://auth?code=${code}`);
    expect(code).toMatch(/^hc_[A-Za-z0-9_-]{43}$/);
    const all = await rows(auth);
    expect(all).toHaveLength(2);
    expect(all[0]?.consumedAt).not.toBeNull();
    expect(all[1]).toMatchObject({ identifier: user.id, consumedAt: null });
    expect(all[1]?.valueHash).toBe(await sha256Hex(code));
    expect(all[1]?.expiresAt.getTime()).toBe(auth.clock.now().getTime() + 2 * 60_000);
    const r = await redeemHandoff(auth.config, {
      code,
      verifier,
      ip: "2.2.2.2",
      userAgent: "consumera/1.0",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.user.id).toBe(user.id);
    expect(r.value.token).toMatch(/^ts_/);
    expect((await resolveSession(auth.config, r.value.token))?.session.userAgent).toBe(
      "consumera/1.0",
    );
    expect((await rows(auth))[1]?.consumedAt).not.toBeNull();
  });

  it("rejects a wrong verifier and consumes the code (Review Focus 3)", async () => {
    const auth = handoffAuth();
    const user = await auth.seedUser("ada@example.com");
    const { handoffId } = await started(auth);
    const { code } = await continued(auth, handoffId, user.id);
    const other = await pkce();
    expect(
      await redeemHandoff(auth.config, {
        code,
        verifier: other.verifier,
        ip: null,
        userAgent: null,
      }),
    ).toMatchObject({ ok: false, code: "invalid_token" });
    expect(await auth.storage.findMany("session", [])).toHaveLength(0);
    expect((await rows(auth))[1]?.consumedAt).not.toBeNull();
  });

  it("rejects a replayed code and keeps one session (Review Focus 4)", async () => {
    const auth = handoffAuth();
    const user = await auth.seedUser("ada@example.com");
    const { verifier, handoffId } = await started(auth);
    const { code } = await continued(auth, handoffId, user.id);
    expect(
      (await redeemHandoff(auth.config, { code, verifier, ip: null, userAgent: null })).ok,
    ).toBe(true);
    expect(
      await redeemHandoff(auth.config, { code, verifier, ip: null, userAgent: null }),
    ).toMatchObject({ ok: false, code: "invalid_token" });
    expect(await auth.storage.findMany("session", [])).toHaveLength(1);
  });

  it("rejects an expired code, a malformed code, a start id used as a code, and a reused or unknown handoff id", async () => {
    const auth = handoffAuth();
    const user = await auth.seedUser("ada@example.com");
    const { verifier, handoffId } = await started(auth);
    expect(
      await redeemHandoff(auth.config, { code: handoffId, verifier, ip: null, userAgent: null }),
    ).toMatchObject({ ok: false, code: "invalid_token" });
    const { code } = await continued(auth, handoffId, user.id);
    expect(await continueHandoff(auth.config, { handoffId, userId: user.id })).toMatchObject({
      ok: false,
      code: "invalid_token",
    });
    expect(
      await continueHandoff(auth.config, { handoffId: "hs_nope", userId: user.id }),
    ).toMatchObject({ ok: false, code: "invalid_token" });
    auth.clock.advance(2 * 60_000);
    expect(
      await redeemHandoff(auth.config, { code, verifier, ip: null, userAgent: null }),
    ).toMatchObject({ ok: false, code: "token_expired" });
    expect(
      await redeemHandoff(auth.config, { code: "nope", verifier, ip: null, userAgent: null }),
    ).toMatchObject({ ok: false, code: "invalid_token" });
    const { handoffId: h2 } = await started(auth);
    auth.clock.advance(10 * 60_000);
    expect(await continueHandoff(auth.config, { handoffId: h2, userId: user.id })).toMatchObject({
      ok: false,
      code: "token_expired",
    });
  });

  it("refuses a malformed verifier without spending the code", async () => {
    const auth = handoffAuth();
    const user = await auth.seedUser("ada@example.com");
    const { verifier, handoffId } = await started(auth);
    const { code } = await continued(auth, handoffId, user.id);
    expect(
      await redeemHandoff(auth.config, { code, verifier: "short", ip: null, userAgent: null }),
    ).toMatchObject({ ok: false, code: "invalid_token" });
    expect((await rows(auth))[1]?.consumedAt).toBeNull();
    expect(
      (await redeemHandoff(auth.config, { code, verifier, ip: null, userAgent: null })).ok,
    ).toBe(true);
  });

  it("limits redeems to 20 per ip per 15 minutes", async () => {
    const auth = handoffAuth();
    for (let i = 0; i < 20; i++) {
      expect(
        await redeemHandoff(auth.config, {
          code: "nope",
          verifier: "v",
          ip: "8.8.8.8",
          userAgent: null,
        }),
      ).toMatchObject({ ok: false, code: "invalid_token" });
    }
    expect(
      await redeemHandoff(auth.config, {
        code: "nope",
        verifier: "v",
        ip: "8.8.8.8",
        userAgent: null,
      }),
    ).toMatchObject({ ok: false, code: "rate_limited" });
  });
});
