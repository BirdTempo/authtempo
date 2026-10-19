import { LEGACY_VERIFY_HASH } from "@authtempo/core";
import { importUsers, readSource } from "@authtempo/import";
import { FIXTURE_EXPORTS } from "@authtempo/import/testing";
import { describe, expect, it } from "vitest";
import { call, type Harness, harness } from "../support/harness.ts";
import { createCognitoAuth } from "./cognito.ts";

// The fixture export of the Cognito reader holds Cara, one CONFIRMED user, with no hash.
const f = FIXTURE_EXPORTS.cognito;

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

/** Reads the hash of the one password row in the database. */
async function onlyHash(h: Harness): Promise<string> {
  const rows = await h.storage.findMany("password", []);
  expect(rows.length).toBe(1);
  return rows[0]?.hash ?? "";
}

describe("move users from Amazon Cognito", () => {
  it("imports the fixture export with the marker", async () => {
    const h = harness();
    const report = await importUsers(h.storage, await readSource(f.bundle), {
      formats: [],
      legacyVerify: true,
    });
    expect(report.created.password).toBe(1);
    // Core reads this marker as "ask the old system".
    expect(await onlyHash(h)).toBe(LEGACY_VERIFY_HASH);

    const cognito = fakeCognito("right horse battery");
    const auth = createCognitoAuth(h, cognito.impl);
    const res = await call(auth, "POST", "/auth/password/sign-in", {
      email: "cara@example.com",
      password: "right horse battery",
    });
    expect(res.status).toBe(200);
    expect(cognito.calls).toEqual(["cara@example.com"]);
    expect((await onlyHash(h)).startsWith("pbkdf2-sha256$")).toBe(true);
  });

  it("asks Cognito once at the first sign-in, then signs in with core's own hash", async () => {
    const h = harness();
    const report = await importUsers(h.storage, await readSource(f.bundle), {
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
    await importUsers(h.storage, await readSource(f.bundle), {
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
