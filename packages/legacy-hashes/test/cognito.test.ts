import { describe, expect, it } from "vitest";
import { createCognitoLegacyVerify } from "../src/cognito.js";

type Seen = { url: string; init: RequestInit };

function fakeCognito(answer: { status: number; body: unknown } | { status: number; text: string }) {
  const seen: Seen[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return "text" in answer
      ? new Response(answer.text, { status: answer.status })
      : Response.json(answer.body, { status: answer.status });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, seen };
}

const signal = new AbortController().signal;

describe("createCognitoLegacyVerify", () => {
  it("sends USER_PASSWORD_AUTH with the email as USERNAME and answers true for tokens", async () => {
    const c = fakeCognito({ status: 200, body: { AuthenticationResult: { AccessToken: "t" } } });
    const verify = createCognitoLegacyVerify({
      region: "eu-west-1",
      clientId: "abc",
      fetch: c.fetch,
    });
    expect(await verify("ada@example.com", "pw", signal)).toBe(true);
    expect(c.seen[0]?.url).toBe("https://cognito-idp.eu-west-1.amazonaws.com/");
    const headers = c.seen[0]?.init.headers as Record<string, string>;
    expect(headers["x-amz-target"]).toBe("AWSCognitoIdentityProviderService.InitiateAuth");
    expect(JSON.parse(String(c.seen[0]?.init.body))).toEqual({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: "abc",
      AuthParameters: { USERNAME: "ada@example.com", PASSWORD: "pw" },
    });
    expect(c.seen[0]?.init.signal).toBe(signal);
  });

  it("adds SECRET_HASH = base64(HMAC-SHA256(secret, username + clientId))", async () => {
    const c = fakeCognito({ status: 200, body: { AuthenticationResult: {} } });
    const verify = createCognitoLegacyVerify({
      region: "us-east-1",
      clientId: "abc",
      clientSecret: "s3cret",
      fetch: c.fetch,
    });
    await verify("ada@example.com", "pw", signal);
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("s3cret"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("ada@example.comabc")),
    );
    const sent = JSON.parse(String(c.seen[0]?.init.body)).AuthParameters.SECRET_HASH;
    expect(sent).toBe(btoa(String.fromCharCode(...mac)));
  });

  it("answers false for a refusal Cognito names, with or without a namespace", async () => {
    for (const type of [
      "NotAuthorizedException",
      "com.amazonaws.cognito#UserNotFoundException",
      "UserNotConfirmedException",
      "PasswordResetRequiredException",
    ]) {
      const c = fakeCognito({ status: 400, body: { __type: type, message: "no" } });
      const verify = createCognitoLegacyVerify({
        region: "eu-west-1",
        clientId: "abc",
        fetch: c.fetch,
      });
      expect(await verify("ada@example.com", "pw", signal)).toBe(false);
    }
  });

  it("answers false for any other non-2xx answer, also one with a token in its body", async () => {
    for (const answer of [
      { status: 400, body: { __type: "TooManyRequestsException" } },
      { status: 400, body: { __type: "InvalidParameterException" } },
      { status: 500, body: {} },
      { status: 503, body: { AuthenticationResult: { AccessToken: "t" } } },
    ]) {
      const c = fakeCognito(answer);
      const verify = createCognitoLegacyVerify({
        region: "eu-west-1",
        clientId: "abc",
        fetch: c.fetch,
      });
      expect(await verify("ada@example.com", "pw", signal)).toBe(false);
    }
  });

  it("refuses a challenge unless the owner accepts its name", async () => {
    const c = fakeCognito({
      status: 200,
      body: { ChallengeName: "SOFTWARE_TOKEN_MFA", Session: "s" },
    });
    const strict = createCognitoLegacyVerify({
      region: "eu-west-1",
      clientId: "abc",
      fetch: c.fetch,
    });
    expect(await strict("ada@example.com", "pw", signal)).toBe(false);
    const lax = createCognitoLegacyVerify({
      region: "eu-west-1",
      clientId: "abc",
      acceptChallenges: ["SOFTWARE_TOKEN_MFA"],
      fetch: c.fetch,
    });
    expect(await lax("ada@example.com", "pw", signal)).toBe(true);
  });

  it("answers false for a 200 answer that is neither a result nor a challenge", async () => {
    for (const answer of [
      { status: 200, body: {} },
      { status: 200, body: null },
      { status: 200, body: { AuthenticationResult: null } },
      { status: 200, body: { AuthenticationResult: "t" } },
      { status: 200, body: { ChallengeName: 7 } },
      { status: 200, text: "<html>not json</html>" },
    ]) {
      const c = fakeCognito(answer);
      const verify = createCognitoLegacyVerify({
        region: "eu-west-1",
        clientId: "abc",
        fetch: c.fetch,
      });
      expect(await verify("ada@example.com", "pw", signal)).toBe(false);
    }
  });

  it("answers false when the network fails", async () => {
    const fetch = (async () => {
      throw new TypeError("network down");
    }) as unknown as typeof globalThis.fetch;
    const verify = createCognitoLegacyVerify({ region: "eu-west-1", clientId: "abc", fetch });
    expect(await verify("ada@example.com", "pw", signal)).toBe(false);
  });

  it("answers false when the signal aborts, also for a fetch that ignores the signal", async () => {
    // This fetch never answers and never looks at the signal.
    let calls = 0;
    const fetch = (() => {
      calls += 1;
      return new Promise<Response>(() => {});
    }) as unknown as typeof globalThis.fetch;
    const verify = createCognitoLegacyVerify({ region: "eu-west-1", clientId: "abc", fetch });
    const controller = new AbortController();
    const answer = verify("ada@example.com", "pw", controller.signal);
    setTimeout(() => controller.abort(), 10);
    expect(await answer).toBe(false);
    // A signal that aborted before the call answers false and sends no request.
    expect(await verify("ada@example.com", "pw", controller.signal)).toBe(false);
    expect(calls).toBe(1);
  }, 1000);

  it("refuses a bad region and an empty client id at construction", () => {
    expect(() =>
      createCognitoLegacyVerify({ region: "eu-west-1.evil.com", clientId: "abc" }),
    ).toThrow(/not a region name/);
    expect(() => createCognitoLegacyVerify({ region: "eu-west-1", clientId: "" })).toThrow(
      /clientId is empty/,
    );
  });
});
