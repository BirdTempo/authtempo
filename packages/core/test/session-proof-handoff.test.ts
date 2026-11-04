import { describe, expect, it } from "vitest";
import type { AuthConfig } from "../src/config.js";
import { createAuth } from "../src/create-auth.js";
import { createMemoryLimiter } from "../src/limiter/memory.js";
import { sha256Base64Url, sha256Hex } from "../src/primitives/crypto.js";
import { newId } from "../src/primitives/ids.js";
import type { SessionRow } from "../src/schema.js";
import { createMemoryAdapter } from "../src/storage/memory.js";
import { createRecordingSms } from "../src/testing/recording-sms.js";
import { APP_ORIGIN, BASE_URL, recordCredential } from "./helpers.js";

// The flag of a handoff session (plan 12p, ruling 32). `provedAtOpen`
// answers the flag that the code carries from its browser session first.
// For a user with an address, the verified flag gives the same value, or
// the redeem guard refuses the code. So one state needs the carried flag. A
// user with no address holds a proved session and an unproved one from
// before version 16.
//
// The fill of decision 1 leaves that state, as the consent test says. This
// test writes the old row through the storage, as that test does. A
// handoff of the old session gives an unproved session, so that user signs
// in again for verified powers.

const PHONE = "+14155550100";
const APP_REDIRECT = "consumera://auth";
const COOKIE = "__Host-tempo_session";
const DAY = 86_400_000;
/** The token of the session of version 15: the form of a session token. */
const OLD = recordCredential(`ts_${"o".repeat(43)}`);

function world() {
  let current = new Date("2026-11-05T00:00:00.000Z");
  const clock = {
    now: () => current,
    advance(ms: number) {
      current = new Date(current.getTime() + ms);
    },
  };
  const storage = createMemoryAdapter();
  const sms = createRecordingSms();
  const input: AuthConfig = {
    baseURL: BASE_URL,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [APP_ORIGIN],
    storage,
    limiter: createMemoryLimiter(clock),
    clock,
    mail: { send: async () => {} },
    phone: { sms, regions: ["+1"], isolateLimiter: "allow", signUp: true },
    handoff: { schemes: ["consumera://"] },
  };
  const auth = createAuth(input);
  /** `handle` that waits for the work after the answer too, such as the text of a code. */
  const handle = async (request: Request): Promise<Response> => {
    const after: Promise<unknown>[] = [];
    const res = await auth.handle(request, { waitUntil: (p) => void after.push(p) });
    await Promise.all(after);
    return res;
  };
  return { auth: { handle }, storage, sms, clock };
}
type World = ReturnType<typeof world>;

let ip = 0;
const nextIp = () => `198.51.100.${(++ip % 250) + 1}`;
const cookieOf = (token: string) => `${COOKIE}=${token}`;

/** A JSON request of the routes, with the Origin of the app. */
function req(path: string, body: unknown, cookie?: string) {
  return new Request(`${BASE_URL}/auth${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: APP_ORIGIN,
      "cf-connecting-ip": nextIp(),
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

/** The status and the error code of an answer: "200 ok", "403 email_unverified". */
async function answer(res: Response): Promise<string> {
  const body = (await res.clone().json()) as { error?: string };
  return `${res.status} ${body.error ?? "ok"}`;
}

/** A phone sign-up by a code, through the routes. Answers the user id and the session token. */
async function phoneUser(w: World): Promise<{ userId: string; token: string }> {
  expect((await w.auth.handle(req("/phone/request", { phone: PHONE }))).status).toBe(200);
  const code = /^(\d+) is your /.exec(w.sms.sent.findLast((x) => x.to === PHONE)?.text ?? "")?.[1];
  const res = await w.auth.handle(req("/phone/verify", { phone: PHONE, code }));
  expect(res.status).toBe(200);
  const line = res.headers.getSetCookie().find((c) => c.startsWith(`${COOKIE}=`)) ?? "";
  const token = recordCredential(line.slice(COOKIE.length + 1).split(";")[0] ?? "");
  const user = await w.storage.findOne("user", [{ field: "phone", op: "eq", value: PHONE }]);
  if (!user || token === "") throw new Error("the phone sign-up opened no session");
  expect(user.email).toBeNull();
  expect(user.isAnonymous).toBe(false);
  return { userId: user.id, token };
}

/** The session row of version 15 after the fill of 0016: `proved` false. */
async function sessionOfVersion15(w: World, userId: string): Promise<SessionRow> {
  const now = w.clock.now();
  return w.storage.create("session", {
    id: newId(now),
    userId,
    tokenHash: await sha256Hex(OLD),
    expiresAt: new Date(now.getTime() + DAY),
    lastSeenAt: now,
    ip: null,
    userAgent: null,
    activeOrganizationId: null,
    freshAt: now,
    actorId: null,
    activeTeamId: null,
    proved: false,
    createdAt: now,
    updatedAt: now,
  });
}

/** The session row of a token. */
async function rowOf(w: World, token: string): Promise<SessionRow | null> {
  return w.storage.findOne("session", [
    { field: "tokenHash", op: "eq", value: await sha256Hex(token) },
  ]);
}

/**
 * A handoff through the routes, as an app and a browser run it. The app
 * starts it, the browser of `cookie` continues it, and the app redeems the
 * code. Answers the token of the redeemed session.
 */
async function handoff(w: World, cookie: string): Promise<string> {
  const verifier = recordCredential("h".repeat(43));
  const query = new URLSearchParams({
    challenge: await sha256Base64Url(verifier),
    redirect: APP_REDIRECT,
  });
  const page = await w.auth.handle(
    new Request(`${BASE_URL}/auth/handoff/start?${query}`, {
      headers: { "cf-connecting-ip": nextIp() },
    }),
  );
  expect(page.status).toBe(200);
  const h = /data-continue="\/auth\/handoff\/continue\?h=(hs_[A-Za-z0-9_-]+)"/.exec(
    await page.text(),
  )?.[1];
  if (!h) throw new Error("the start page names no handoff");
  // The confirm page posts the form from baseURL, with the browser's cookie.
  const done = await w.auth.handle(
    new Request(`${BASE_URL}/auth/handoff/continue`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: BASE_URL,
        "cf-connecting-ip": nextIp(),
        cookie,
      },
      body: new URLSearchParams({ h }).toString(),
    }),
  );
  expect(done.status).toBe(302);
  const back = done.headers.get("location") ?? "";
  expect(back.startsWith(`${APP_REDIRECT}?`)).toBe(true);
  const code = recordCredential(new URL(back).searchParams.get("code") ?? "");
  const redeemed = await w.auth.handle(req("/handoff/redeem", { code, verifier }));
  expect(await answer(redeemed)).toBe("200 ok");
  return recordCredential(((await redeemed.json()) as { token: string }).token);
}

describe("the handoff of an unproved session of a user with no address (plan 12p, ruling 32)", () => {
  it("redeems a handoff of the session of version 15 into an unproved session", async () => {
    const w = world();
    const { userId } = await phoneUser(w);
    const old = await sessionOfVersion15(w, userId);
    const token = await handoff(w, cookieOf(OLD));
    const row = await rowOf(w, token);
    expect(row?.userId).toBe(userId);
    expect(row?.id).not.toBe(old.id);
    // The new session carries the flag of its browser session, not the rule of the user.
    expect(row?.proved).toBe(false);
    // So it has no verified power: the user signs in again for one.
    const made = await w.auth.handle(req("/tokens", { name: "ci" }, cookieOf(token)));
    expect(await answer(made)).toBe("403 email_unverified");
    expect(await w.storage.findMany("apiToken", [])).toHaveLength(0);
    // The browser session stays live and unproved.
    expect((await rowOf(w, OLD))?.proved).toBe(false);
  });

  it("redeems a handoff of the proved session into a proved session (the control)", async () => {
    const w = world();
    const { userId, token: browser } = await phoneUser(w);
    await sessionOfVersion15(w, userId);
    expect((await rowOf(w, browser))?.proved).toBe(true);
    const token = await handoff(w, cookieOf(browser));
    const row = await rowOf(w, token);
    expect(row?.userId).toBe(userId);
    expect(row?.proved).toBe(true);
    const made = await w.auth.handle(req("/tokens", { name: "ci" }, cookieOf(token)));
    expect(await answer(made)).toBe("200 ok");
    expect(await w.storage.findMany("apiToken", [])).toHaveLength(1);
  });
});
