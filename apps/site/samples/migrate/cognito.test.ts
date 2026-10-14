import { cognitoSource, importUsers } from "@authtempo/import";
import { describe, expect, it } from "vitest";
import { call, harness } from "../support/harness.ts";
import { createCognitoAuth } from "./cognito.ts";

// One confirmed user, as `aws cognito-idp list-users` prints it.
const USERS = JSON.stringify({
  Users: [
    {
      Username: "c0ffee",
      Attributes: [
        { Name: "sub", Value: "sub-1" },
        { Name: "email", Value: "cara@example.com" },
        { Name: "email_verified", Value: "true" },
      ],
      UserCreateDate: 1700000000.5,
      Enabled: true,
      UserStatus: "CONFIRMED",
    },
  ],
});

/** A fake Cognito: InitiateAuth passes for one password and refuses every other. */
function fakeCognito(password: string) {
  const calls: string[] = [];
  const impl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      AuthParameters: { USERNAME: string; PASSWORD: string };
    };
    calls.push(body.AuthParameters.USERNAME);
    return body.AuthParameters.PASSWORD === password
      ? Response.json({ AuthenticationResult: { AccessToken: "cognito-access-token" } })
      : Response.json({ __type: "NotAuthorizedException" }, { status: 400 });
  }) as typeof fetch;
  return { impl, calls };
}

describe("move users from Amazon Cognito", () => {
  it("asks Cognito once at the first sign-in, then signs in with core's own hash", async () => {
    const h = harness();
    const report = await importUsers(h.storage, cognitoSource({ users: USERS }), {
      formats: [],
      legacyVerify: true,
    });
    expect(report.created.password).toBe(1);

    const cognito = fakeCognito("right horse battery");
    const auth = createCognitoAuth(h, cognito.impl);
    const signIn = (password: string) =>
      call(auth, "POST", "/auth/password/sign-in", { email: "cara@example.com", password });
    expect((await signIn("right horse battery")).status).toBe(200);
    expect((await signIn("right horse battery")).status).toBe(200);
    expect(cognito.calls).toEqual(["cara@example.com"]);
  });

  it("answers invalid_credentials when Cognito refuses the password", async () => {
    const h = harness();
    await importUsers(h.storage, cognitoSource({ users: USERS }), {
      formats: [],
      legacyVerify: true,
    });
    const auth = createCognitoAuth(h, fakeCognito("right horse battery").impl);
    const res = await call(auth, "POST", "/auth/password/sign-in", {
      email: "cara@example.com",
      password: "wrong",
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_credentials" });
  });
});
