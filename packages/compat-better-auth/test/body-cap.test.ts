import { bodyCapOf } from "@authtempo/core/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { admin, emailOTP, organization, twoFactor, username } from "../src/plugins.js";
import { betterAuth } from "../src/server/better-auth.js";
import { sso } from "../src/sso.js";
import { BASE, fakeDns, memory, SECRET, ssoApp } from "./sso-helpers.js";

/**
 * The body reads of the shim (ruling 46 of the 12j lane, Major 2). Each
 * read is core's capped read at the cap of the core route that the body
 * goes to. A body one byte past that cap answers 413 PAYLOAD_TOO_LARGE at
 * the shim's first read: no JSON.parse takes the long text, and no core
 * route runs. The paths are each path that the shim reads before core.
 */

/** Core's floor, the cap of a read with no route. */
const BODY_CAP_FLOOR = bodyCapOf(undefined);
/** The cap of the SSO connection writes, the largest of core. */
const SSO_CAP = bodyCapOf("POST /sso/connections/create");

/** Each path that the shim reads before core, and the cap of its read. */
const FIRST_READS: readonly [path: string, cap: number][] = [
  ["/change-email", BODY_CAP_FLOOR],
  ["/user/change-email", BODY_CAP_FLOOR],
  ["/admin/set-role", BODY_CAP_FLOOR],
  ["/admin/update-user", BODY_CAP_FLOOR],
  ["/admin/create-user", BODY_CAP_FLOOR],
  ["/admin/ban-user", BODY_CAP_FLOOR],
  ["/revoke-session", BODY_CAP_FLOOR],
  ["/update-user", BODY_CAP_FLOOR],
  ["/email-otp/send-verification-otp", BODY_CAP_FLOOR],
  ["/two-factor/enable", BODY_CAP_FLOOR],
  ["/sign-in/social", BODY_CAP_FLOOR],
  ["/sign-in/username", BODY_CAP_FLOOR],
  ["/sso/delete-provider", BODY_CAP_FLOOR],
  ["/sso/request-domain-verification", BODY_CAP_FLOOR],
  ["/sso/verify-domain", BODY_CAP_FLOOR],
  ["/sign-in/sso", BODY_CAP_FLOOR],
];

/**
 * The paths of the SSO connection writes, whose read takes the large cap.
 * The shim reads them only after the session check, as core does.
 */
const SSO_WRITES = [
  "/sso/register",
  "/sso/update-provider",
  "/sso/connections/create",
  "/sso/connections/update",
];

/** An app with every plugin whose path the shim reads first. */
function app() {
  return betterAuth({
    baseURL: BASE,
    secret: SECRET,
    database: memory(),
    authtempo: { platformOrganization: "platform-co", ssoDns: [fakeDns("a", new Map()).port] },
    emailAndPassword: { enabled: true, sendResetPassword: async () => {} },
    emailVerification: { sendVerificationEmail: async () => {} },
    user: { changeEmail: { enabled: true } },
    plugins: [
      organization({ sendInvitationEmail: async () => {} }),
      twoFactor({ accountLockout: { enabled: false } }),
      admin({}),
      emailOTP({ sendVerificationOTP: async () => {}, changeEmail: { enabled: true } }),
      username(),
      sso({ domainVerification: { enabled: true } }),
    ],
  });
}

/** A JSON POST of a small object with spaces to exactly `bytes` bytes, with `cookie` when given. */
function post(path: string, bytes: number, cookie?: string): Request {
  const json = '{"newEmail":"a@example.com","userId":"u","role":"user"}';
  return new Request(`${BASE}/api/auth${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: BASE,
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: json + " ".repeat(bytes - json.length),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the body reads of the shim (ruling 46 of the 12j lane)", () => {
  it.each(FIRST_READS)(
    "answers 413 PAYLOAD_TOO_LARGE at the first read of %s one byte past its cap",
    async (path, cap) => {
      const auth = app();
      const parse = vi.spyOn(JSON, "parse");
      const res = await auth.handler(post(path, cap + 1));
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ code: "PAYLOAD_TOO_LARGE", message: "Payload too large" });
      expect(parse.mock.calls.filter(([t]) => typeof t === "string" && t.length > cap)).toEqual([]);
    },
  );

  it.each(SSO_WRITES)(
    "reads %s only with a session, and answers 413 PAYLOAD_TOO_LARGE one byte past 8 MiB",
    async (path) => {
      const { auth, person } = ssoApp(memory(), [sso({ domainVerification: { enabled: true } })]);
      const anonymous = post(path, SSO_CAP + 1);
      const res = await auth.handler(anonymous);
      expect(res.status).toBe(401);
      expect(anonymous.bodyUsed).toBe(false);
      const { cookie } = await person("ada@example.com");
      const parse = vi.spyOn(JSON, "parse");
      const over = await auth.handler(post(path, SSO_CAP + 1, cookie));
      expect(over.status).toBe(413);
      expect(await over.json()).toEqual({
        code: "PAYLOAD_TOO_LARGE",
        message: "Payload too large",
      });
      expect(
        parse.mock.calls.filter(([t]) => typeof t === "string" && t.length > BODY_CAP_FLOOR),
      ).toEqual([]);
      // A body past the floor and under the cap is read: the answer is not 413.
      expect((await auth.handler(post(path, BODY_CAP_FLOOR + 1, cookie))).status).not.toBe(413);
    },
  );

  it("reads a body at the cap of its route and passes it on", async () => {
    const auth = app();
    // At the floor, the body is read: the answer is not 413, whatever the route answers next.
    for (const [path, cap] of FIRST_READS.filter(([, c]) => c === BODY_CAP_FLOOR)) {
      const res = await auth.handler(post(path, cap));
      expect([path, res.status]).not.toEqual([path, 413]);
    }
  });
});
