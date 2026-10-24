import { createRecordingSms } from "@authtempo/core/testing";
import { describe, expect, it } from "vitest";
import { createClient } from "../src/client.js";
import { BASE_URL, inProcessFetch, makeServer } from "./harness.js";

/** The code of the last SMS: the default text starts with it. */
function lastCode(sms: ReturnType<typeof createRecordingSms>): string {
  return /^(\d+) /.exec(sms.sent.at(-1)?.text ?? "")?.[1] ?? "";
}

describe("the phone (plan 12i Task 5)", () => {
  it("signs up by a code, adds and removes a phone, and passes the refusals through", async () => {
    const sms = createRecordingSms();
    const server = makeServer({
      phone: { sms, regions: ["+1"], isolateLimiter: "allow", signUp: true },
    });
    const client = createClient({ baseURL: BASE_URL, fetch: inProcessFetch(server.auth).fetch });
    expect(await client.phone.add({ phone: "+14155550101" })).toMatchObject({
      ok: false,
      code: "unauthorized",
      status: 401,
    });
    expect(await client.phone.request({ phone: "+14155550100" })).toEqual({
      ok: true,
      value: { sent: true },
    });
    const signedIn = await client.phone.verify({ phone: "+14155550100", code: lastCode(sms) });
    expect(signedIn).toMatchObject({ ok: true, value: { user: { email: null } } });
    // The phone is the last way in of this user.
    expect(await client.phone.remove()).toMatchObject({
      ok: false,
      code: "last_credential",
      status: 409,
    });
    expect(await client.phone.add({ phone: "+14155550101" })).toEqual({
      ok: true,
      value: { sent: true },
    });
    expect(await client.phone.verifyAdd({ code: lastCode(sms) })).toEqual({
      ok: true,
      value: { phone: "+14155550101" },
    });
    expect(await client.phone.request({ phone: "+44770090012" })).toMatchObject({
      ok: false,
      code: "phone_region",
      status: 400,
    });
  });

  it("answers not_found while the server has no phone config", async () => {
    const server = makeServer();
    const client = createClient({ baseURL: BASE_URL, fetch: inProcessFetch(server.auth).fetch });
    expect(await client.phone.request({ phone: "+14155550100" })).toMatchObject({
      ok: false,
      code: "not_found",
      status: 404,
    });
  });
});
