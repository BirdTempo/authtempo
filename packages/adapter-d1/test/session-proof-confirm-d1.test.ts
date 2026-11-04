import { applyD1Migrations, env } from "cloudflare:test";
import { createAuth, type MailMessage } from "@authtempo/core";
import { createRecordingSms } from "@authtempo/core/testing";
import { describe, expect, it } from "vitest";
import { createD1Adapter, createD1Limiter } from "../src/index.js";

// The confirm of a change of address on D1 (decision 7 of plan 12p). The
// confirm sets `proved` on the session that it keeps. Since ruling 20 the
// engine proves each new session of a user with no address that is not
// anonymous. So the one unproved session of such a user is one of version
// 15. The fill of 0016 leaves it false, and so does a Worker of version 15
// that writes during the deploy. The test makes that row with the SQL of
// version 15, then runs the shipped 0016 and real requests.

const BASE = "https://api.example.com";
const APP_ORIGIN = "https://app.example.com";
const PHONE = "+14155550100";
const ADDRESS = "pat@example.com";
const HOUR = 3_600_000;
/** The token of the session of version 15: the form of a session token. */
const OLD = `ts_${"o".repeat(43)}`;

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

let ip = 0;
const post = (path: string, body: unknown, token: string) =>
  new Request(`${BASE}/auth${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: APP_ORIGIN,
      authorization: `Bearer ${token}`,
      "cf-connecting-ip": `198.51.100.${++ip}`,
    },
    body: JSON.stringify(body),
  });

/** The status and the error code of an answer: "200 ok", "403 email_unverified". */
async function answer(res: Response): Promise<string> {
  const body = (await res.clone().json()) as { error?: string };
  return `${res.status} ${body.error ?? "ok"}`;
}

describe("the confirm of a change of address on a session of version 15 (plan 12p decision 7)", () => {
  it("sets proved on the session that the confirm keeps, for a user who had no address", async () => {
    const i0016 = env.TEST_MIGRATIONS.findIndex((m) => m.name.startsWith("0016_"));
    expect(i0016).toBe(15);
    await applyD1Migrations(env.STAGED, env.TEST_MIGRATIONS.slice(0, i0016));
    // A phone user and its session, as a Worker of version 15 writes them.
    const now = Date.now();
    await env.STAGED.batch([
      env.STAGED.prepare(
        "INSERT INTO ta_user (id, created_at, updated_at, email, email_verified, name, image, banned_at, ban_reason, ban_until, username, display_username, phone, is_anonymous) VALUES (?, ?, ?, NULL, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, 0)",
      ).bind("u-phone", now - HOUR, now - HOUR, PHONE),
      env.STAGED.prepare(
        "INSERT INTO ta_session (id, created_at, updated_at, user_id, token_hash, expires_at, last_seen_at, ip, user_agent, active_organization_id, fresh_at, actor_id, active_team_id) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, NULL, NULL)",
      ).bind(
        "s-old",
        now - HOUR,
        now - HOUR,
        "u-phone",
        await sha256Hex(OLD),
        now + 24 * HOUR,
        now - HOUR,
        now - HOUR,
      ),
    ]);
    await applyD1Migrations(env.STAGED, env.TEST_MIGRATIONS.slice(0, i0016 + 1));
    const proved = () =>
      env.STAGED.prepare("SELECT id, proved FROM ta_session ORDER BY id").all<{
        id: string;
        proved: number;
      }>();
    // The fill leaves the session of a user with no address unproved.
    expect((await proved()).results).toEqual([{ id: "s-old", proved: 0 }]);
    const sms = createRecordingSms();
    const mail: MailMessage[] = [];
    const auth = createAuth({
      baseURL: BASE,
      secret: "0123456789abcdef0123456789abcdef",
      trustedOrigins: [APP_ORIGIN],
      storage: createD1Adapter(env.STAGED),
      limiter: createD1Limiter(env.STAGED),
      mail: {
        send: async (m) => {
          mail.push(m);
        },
      },
      phone: { sms, regions: ["+1"] },
    });
    const handle = async (request: Request) => {
      const after: Promise<unknown>[] = [];
      const res = await auth.handle(request, { waitUntil: (p) => void after.push(p) });
      await Promise.all(after);
      return res;
    };
    // The old session is live, and it makes no token.
    expect(await answer(await handle(post("/tokens", { name: "ci" }, OLD)))).toBe(
      "403 email_unverified",
    );
    // A sign-in by the phone code. The engine proves its session (ruling 20).
    expect(await answer(await handle(post("/phone/request", { phone: PHONE }, OLD)))).toBe(
      "200 ok",
    );
    const code = /^(\d+) /.exec(sms.sent.at(-1)?.text ?? "")?.[1] ?? "";
    const signedIn = await handle(post("/phone/verify", { phone: PHONE, code }, OLD));
    expect(await answer(signedIn)).toBe("200 ok");
    const fresh = ((await signedIn.json()) as { token: string }).token;
    // The new session asks for the address. The old session confirms the code and stays.
    const asked = await handle(
      post("/user/change-email", { newEmail: ADDRESS, method: "code" }, fresh),
    );
    expect(await answer(asked)).toBe("200 ok");
    const mailed = /\b(\d{6})\b/.exec(mail.findLast((m) => m.to === ADDRESS)?.text ?? "")?.[1];
    const confirmed = await handle(post("/user/change-email/verify", { code: mailed }, OLD));
    expect(await answer(confirmed)).toBe("200 ok");
    // The confirm kept the old session, ended the new one, and set the flag.
    expect((await proved()).results).toEqual([{ id: "s-old", proved: 1 }]);
    expect(await answer(await handle(post("/tokens", { name: "ci" }, OLD)))).toBe("200 ok");
  });
});
