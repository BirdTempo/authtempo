// `authtempo create-admin` (plan 12f Task 12, spec 26 item 11). The command
// runs against a fresh core handle. The new operator gets power only through
// the flows of the product. A magic link proves the mailbox, a reset link
// sets a password, and the enable flow turns TOTP on.
import { createHash } from "node:crypto";
import {
  type Auth,
  createAuth,
  createMemoryAdapter,
  createMemoryLimiter,
  createPbkdf2PasswordHash,
  type MailMessage,
} from "@authtempo/core";
import { base32Decode, totpCode } from "@authtempo/core/testing";
import { describe, expect, it } from "vitest";
import { main } from "../src/main.js";
import { fakeIo } from "./support/fake-io.js";

const BASE = "https://api.example.com";
const SECRET = "operator-support-0123456789abcdef-0123";
const ADMIN = "root@example.com";
const PW = "correct horse battery";
const IP = "203.0.113.7";

/** The token of the link of a mail. */
function tokenOf(mail: MailMessage | undefined): string {
  const token = /token=([A-Za-z0-9_%-]+)/.exec(mail?.text ?? "")?.[1];
  if (!token) throw new Error("no link in the mail");
  return decodeURIComponent(token);
}

describe("authtempo create-admin (plan 12f Task 12)", () => {
  it("creates the first operator on a fresh handle, and the operator has no power before a proof and a factor", async () => {
    let current = new Date("2026-03-01T00:00:00.000Z");
    const clock = { now: () => current };
    const mails: MailMessage[] = [];
    const auth: Auth = createAuth({
      baseURL: BASE,
      trustedOrigins: ["https://app.example.com"],
      storage: createMemoryAdapter(),
      limiter: createMemoryLimiter(clock),
      clock,
      mail: {
        send: async (m) => {
          mails.push(m);
        },
      },
      secret: "0123456789abcdef0123456789abcdef",
      password: { hash: createPbkdf2PasswordHash({ iterations: 1000 }), uniformSignUp: false },
      organizations: {
        platformOrganization: "platform",
        platformRole: "operator",
        ranks: { viewer: 1, member: 2, admin: 3, owner: 4, operator: 5 },
      },
      operator: {
        secrets: [
          {
            name: "support",
            secretHash: createHash("sha256").update(SECRET, "utf8").digest("hex"),
            scopes: ["users"],
          },
        ],
        users: true,
      },
    });
    const fetch = async (url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      headers.set("cf-connecting-ip", IP);
      return auth.handle(new Request(url, { ...init, headers }));
    };

    const io = fakeIo({ env: { AUTHTEMPO_OPERATOR_SECRET: SECRET }, fetch });
    const code = await main(
      ["create-admin", BASE, "--email", ADMIN, "--reason", "first operator", "--yes"],
      io,
    );
    expect(code, io.stderr.join("\n")).toBe(0);
    expect(io.stdout).toHaveLength(1);
    const userId = io.stdout[0] ?? "";
    expect(userId).toMatch(/^[0-9A-Z]{26}$/);
    expect(io.stderr.at(-1)).toBe(
      "Next: sign in with a mailed link or code at this address, then turn a second factor on. Until then the account has no operator power.",
    );
    for (const line of io.stderr) expect(line).not.toContain(ADMIN);

    /** GET /operator/users with the session token as a bearer: the platform operator's own call. */
    const listAs = async (token: string) =>
      (
        await fetch(`${BASE}/auth/operator/users`, {
          headers: { authorization: `Bearer ${token}` },
        })
      ).status;

    // The first proof of the mailbox: a magic link signs the new operator in.
    const requested = await auth.api.requestMagicLink({ email: ADMIN, ip: null });
    if (!requested.ok) throw new Error(requested.code);
    const link = await auth.api.verifyMagicLink({
      token: tokenOf(mails.at(-1)),
      ip: null,
      userAgent: null,
    });
    if (!link.ok || !("token" in link.value)) throw new Error("the magic link opened no session");
    expect(await listAs(link.value.token)).toBe(403);

    // A password through the reset link, then TOTP through the enable flow.
    const password = auth.api.password;
    const totp = auth.api.totp;
    if (!password || !totp) throw new Error("no password or totp api");
    await password.requestReset({ email: ADMIN, ip: null });
    const reset = await password.reset({
      token: tokenOf(mails.at(-1)),
      password: PW,
      ip: null,
      userAgent: null,
    });
    if (!reset.ok || !("token" in reset.value)) throw new Error("the reset opened no session");
    const token = reset.value.token;
    expect(await listAs(token)).toBe(403);
    const setup = await totp.setup({ userId, password: PW });
    if (!setup.ok) throw new Error(setup.code);
    const session = await auth.session(
      new Request(`${BASE}/auth/session`, { headers: { authorization: `Bearer ${token}` } }),
    );
    if (!session) throw new Error("no session");
    const enabled = await totp.enable({
      session,
      code: await totpCode(base32Decode(setup.value.secret), clock.now()),
    });
    if (!enabled.ok) throw new Error(enabled.code);
    current = new Date(current.getTime() + 30_000);
    expect(await listAs(token)).toBe(200);
  });
});
