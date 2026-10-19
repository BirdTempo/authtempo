import { describe, expect, it } from "vitest";
import { markFresh, requireFresh } from "../src/engine/fresh.js";
import { continueHandoff, redeemHandoff, startHandoff } from "../src/engine/handoff.js";
import { fromBase64Url, sha256Base64Url } from "../src/primitives/crypto.js";
import { BASE_URL, get } from "./helpers.js";
import {
  authorizeParams,
  consentPost,
  exchange,
  type Handle,
  oauthHandle,
  pkce,
  registered,
  requestIdOf,
  signedIn,
} from "./oauth-helpers.js";

const DAY_MS = 86_400_000;
const dec = new TextDecoder();
const claimsOf = (jwt: string): Record<string, unknown> =>
  JSON.parse(dec.decode(fromBase64Url(jwt.split(".")[1] ?? ""))) as Record<string, unknown>;
const locationOf = (res: Response) => new URL(res.headers.get("location") ?? "about:blank");

/** The app's handoff from the browser session `s`: start, continue, and redeem. Answers the bearer session. */
async function handoff(h: Handle, s: { user: { id: string }; session: { id: string } }) {
  const verifier = "v".repeat(43);
  const started = await startHandoff(h.config, {
    challenge: await sha256Base64Url(verifier),
    redirect: "example://auth",
    ip: null,
  });
  if (!started.ok) throw new Error(`start ${started.code}`);
  const cont = await continueHandoff(h.config, {
    handoffId: started.value.handoffId,
    userId: s.user.id,
    sessionId: s.session.id,
  });
  if (!cont.ok) throw new Error(`continue ${cont.code}`);
  const code = new URL(cont.value.location.replace("example://", "https://x/")).searchParams.get(
    "code",
  );
  const red = await redeemHandoff(h.config, {
    code: code ?? "",
    verifier,
    ip: null,
    userAgent: null,
  });
  if (!red.ok) throw new Error(`redeem ${red.code}`);
  return red.value;
}

describe("the sign-in time of a handoff session (plan 12e ruling 41)", () => {
  it("keeps the browser session's sign-in: prompt=login gets the sign-in step, and auth_time is the old sign-in", async () => {
    const h = oauthHandle({ handoff: { schemes: ["example://"] } });
    const s = await signedIn(h);
    const signIn = h.clock.now().getTime();
    const clientId = await registered(h);
    const p = await pkce();
    // The browser session is one day old.
    h.clock.advance(DAY_MS);
    const q = new URLSearchParams(
      authorizeParams({ clientId, challenge: p.challenge, scope: "openid mcp:read" }),
    );
    const login = new URLSearchParams(q);
    login.set("prompt", "login");
    const held = await h.auth.handle(
      new Request(`${BASE_URL}/auth/oauth/authorize?${login}`, { headers: { cookie: s.cookie } }),
    );
    const next = locationOf(held).searchParams.get("next") ?? "";
    const id = next.slice(next.indexOf("=") + 1);
    expect(id).toMatch(/^oq_/);
    // The holder of the old cookie runs a handoff: no password, no link, no passkey.
    const red = await handoff(h, s);
    expect(red.session.freshAt?.getTime()).toBe(signIn);
    const bearer = { authorization: `Bearer ${red.token}` };
    const again = await h.auth.handle(get(`/auth/oauth/authorize?request_id=${id}`, bearer));
    expect(again.status).toBe(302);
    expect(locationOf(again).pathname).toBe("/auth/oauth/sign-in");
    // With no prompt the handoff session goes on, and auth_time is the real sign-in.
    const page = await h.auth.handle(
      new Request(`${BASE_URL}/auth/oauth/authorize?${q}`, { headers: bearer }),
    );
    expect(page.status).toBe(200);
    const done = await h.auth.handle(
      consentPost({ request_id: requestIdOf(await page.text()), decision: "allow" }, bearer),
    );
    const code = locationOf(done).searchParams.get("code") ?? "";
    const t = await h.auth.handle(exchange(code, clientId, p.verifier));
    const idToken = ((await t.json()) as { id_token: string }).id_token;
    expect(claimsOf(idToken).auth_time).toBe(Math.floor(signIn / 1000));
  });

  it("the fresh rule of plan 12a refuses a handoff session of an old sign-in, and takes one of a new re-authentication", async () => {
    const h = oauthHandle({ handoff: { schemes: ["example://"] } });
    const s = await signedIn(h);
    h.clock.advance(DAY_MS);
    const old = await handoff(h, s);
    expect(requireFresh(h.config, old.session)).toMatchObject({
      ok: false,
      code: "session_not_fresh",
    });
    // A re-authentication of the browser session is a sign-in, and the next handoff keeps it.
    expect((await markFresh(h.config, s.session.id)).ok).toBe(true);
    const at = h.clock.now().getTime();
    h.clock.advance(1_000);
    const fresh = await handoff(h, s);
    expect(fresh.session.freshAt?.getTime()).toBe(at);
    expect(requireFresh(h.config, fresh.session).ok).toBe(true);
  });
});
