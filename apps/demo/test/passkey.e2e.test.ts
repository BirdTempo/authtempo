import { SoftAuthenticator } from "@authtempo/core/testing";
import { describe, expect, it } from "vitest";
import { call, newSandbox, SESSION_COOKIE, sameSandbox, signInByLink, whoami } from "./helpers.js";

const EMAIL = "ada@example.com";

describe("passkey", () => {
  it("registers and signs in with a soft authenticator", async () => {
    const jar = await newSandbox();
    await signInByLink(jar, EMAIL);
    const soft = await SoftAuthenticator.create({
      rpID: "demo.authtempo.com",
      origin: "https://demo.authtempo.com",
    });
    const options = await call(jar, "POST", "/auth/passkey/register/options", {});
    expect(options.status).toBe(200);
    const creation = (await options.json()) as { challenge: string; rp: { id: string } };
    expect(creation.rp.id).toBe("demo.authtempo.com");
    const registered = await call(jar, "POST", "/auth/passkey/register/verify", {
      response: await soft.register(creation.challenge),
      name: "Demo device",
    });
    expect(registered.status).toBe(200);

    // A second visitor of the sandbox signs in with the passkey alone.
    const other = sameSandbox(jar);
    const request = await call(other, "POST", "/auth/passkey/authenticate/options", {});
    expect(request.status).toBe(200);
    const { challenge } = (await request.json()) as { challenge: string };
    const signIn = await call(other, "POST", "/auth/passkey/authenticate/verify", {
      response: await soft.authenticate(challenge),
    });
    expect(signIn.status).toBe(200);
    expect(other.cookies.has(SESSION_COOKIE)).toBe(true);
    expect(await whoami(other)).toMatchObject({ kind: "session", email: EMAIL });
  });
});
