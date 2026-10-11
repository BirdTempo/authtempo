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

/** A check with a fake Cognito and a list of the reasons that onFailure got. */
function checkWith(answer: { status: number; body: unknown } | { status: number; text: string }) {
  const c = fakeCognito(answer);
  const reasons: string[] = [];
  const verify = createCognitoLegacyVerify({
    region: "eu-west-1",
    clientId: "abc",
    onFailure: (reason) => reasons.push(reason),
    fetch: c.fetch,
  });
  return { verify, reasons, seen: c.seen };
}

const TOKENS = { AuthenticationResult: { AccessToken: "t" } };
const signal = new AbortController().signal;

describe("createCognitoLegacyVerify", () => {
  it("sends USER_PASSWORD_AUTH with the email as USERNAME and answers true for tokens", async () => {
    const c = checkWith({ status: 200, body: TOKENS });
    expect(await c.verify("ada@example.com", "pw", signal)).toBe(true);
    expect(c.seen[0]?.url).toBe("https://cognito-idp.eu-west-1.amazonaws.com/");
    expect(c.seen[0]?.init.method).toBe("POST");
    expect(c.seen[0]?.init.headers).toEqual({
      "content-type": "application/x-amz-json-1.1",
      "x-amz-target": "AWSCognitoIdentityProviderService.InitiateAuth",
    });
    expect(JSON.parse(String(c.seen[0]?.init.body))).toEqual({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: "abc",
      AuthParameters: { USERNAME: "ada@example.com", PASSWORD: "pw" },
    });
    expect(c.seen[0]?.init.signal).toBe(signal);
    expect(c.reasons).toEqual([]);
  });

  it("adds SECRET_HASH = base64(HMAC-SHA256(secret, username + clientId))", async () => {
    const c = fakeCognito({ status: 200, body: TOKENS });
    const verify = createCognitoLegacyVerify({
      region: "us-east-1",
      clientId: "abc",
      clientSecret: "s3cret",
      fetch: c.fetch,
    });
    expect(await verify("ada@example.com", "pw", signal)).toBe(true);
    // A known answer from tools outside this code (2026-10-11); both printed the same:
    //   printf 'ada@example.comabc' | openssl dgst -sha256 -hmac s3cret -binary | base64
    //   python3 -c "import hmac,hashlib,base64;print(base64.b64encode(hmac.new(b's3cret',b'ada@example.comabc',hashlib.sha256).digest()).decode())"
    const sent = JSON.parse(String(c.seen[0]?.init.body)).AuthParameters.SECRET_HASH;
    expect(sent).toBe("BMsr64nwa3I+C3qAp5z1jgB2r4cY7tkwuPsAdlC4OWs=");
  });

  it("builds the amazonaws.com.cn host for a China region", async () => {
    const c = fakeCognito({ status: 200, body: TOKENS });
    const verify = createCognitoLegacyVerify({
      region: "cn-north-1",
      clientId: "abc",
      fetch: c.fetch,
    });
    await verify("ada@example.com", "pw", signal);
    expect(c.seen[0]?.url).toBe("https://cognito-idp.cn-north-1.amazonaws.com.cn/");
  });

  it("answers false for a refusal Cognito names and reports the type without its namespace", async () => {
    for (const [type, reason] of [
      ["NotAuthorizedException", "NotAuthorizedException"],
      ["com.amazonaws.cognito#UserNotFoundException", "UserNotFoundException"],
      ["UserNotConfirmedException", "UserNotConfirmedException"],
      ["PasswordResetRequiredException", "PasswordResetRequiredException"],
    ]) {
      const c = checkWith({ status: 400, body: { __type: type, message: "no" } });
      expect(await c.verify("ada@example.com", "pw", signal)).toBe(false);
      expect(c.reasons).toEqual([reason]);
    }
  });

  it("reports a misconfigured client by its type only, never the username or password", async () => {
    const c = checkWith({
      status: 400,
      body: {
        __type: "InvalidParameterException",
        message: "USER_PASSWORD_AUTH flow not enabled for this client",
      },
    });
    expect(await c.verify("ada@example.com", "pw-secret", signal)).toBe(false);
    expect(c.reasons).toEqual(["InvalidParameterException"]);
  });

  it("answers false for any other non-2xx answer, also one with a token in its body", async () => {
    for (const [answer, reason] of [
      [{ status: 400, body: { __type: "TooManyRequestsException" } }, "TooManyRequestsException"],
      [{ status: 500, body: {} }, "malformed"],
      [{ status: 503, body: TOKENS }, "malformed"],
      [{ status: 502, text: "<html>bad gateway</html>" }, "malformed"],
    ] as const) {
      const c = checkWith(answer);
      expect(await c.verify("ada@example.com", "pw", signal)).toBe(false);
      expect(c.reasons).toEqual([reason]);
    }
  });

  it("answers false for every challenge, also one beside tokens", async () => {
    for (const body of [
      { ChallengeName: "NEW_PASSWORD_REQUIRED", Session: "s" },
      { ChallengeName: "SMS_MFA", Session: "s" },
      { ChallengeName: "SOFTWARE_TOKEN_MFA", Session: "s" },
      { ChallengeName: "SELECT_MFA_TYPE", Session: "s" },
      { ...TOKENS, ChallengeName: "SOFTWARE_TOKEN_MFA" },
    ]) {
      const c = checkWith({ status: 200, body });
      expect(await c.verify("ada@example.com", "pw", signal)).toBe(false);
      expect(c.reasons).toEqual(["challenge"]);
    }
  });

  it("answers false for a 200 answer with no non-empty AccessToken", async () => {
    for (const answer of [
      { status: 200, body: {} },
      { status: 200, body: null },
      { status: 200, body: { AuthenticationResult: {} } },
      { status: 200, body: { AuthenticationResult: { AccessToken: "" } } },
      { status: 200, body: { AuthenticationResult: { AccessToken: 7 } } },
      { status: 200, body: { AuthenticationResult: { IdToken: "t" } } },
      { status: 200, body: { AuthenticationResult: null } },
      { status: 200, body: { AuthenticationResult: "t" } },
      { status: 200, text: "<html>not json</html>" },
    ]) {
      const c = checkWith(answer);
      expect(await c.verify("ada@example.com", "pw", signal)).toBe(false);
      expect(c.reasons).toEqual(["malformed"]);
    }
  });

  it("answers false when the network fails", async () => {
    const reasons: string[] = [];
    const fetch = (async () => {
      throw new TypeError("network down");
    }) as unknown as typeof globalThis.fetch;
    const verify = createCognitoLegacyVerify({
      region: "eu-west-1",
      clientId: "abc",
      onFailure: (reason) => reasons.push(reason),
      fetch,
    });
    expect(await verify("ada@example.com", "pw", signal)).toBe(false);
    expect(reasons).toEqual(["network"]);
  });

  it("answers false when the signal aborts, also for a fetch that ignores the signal", async () => {
    // This fetch never answers and never looks at the signal.
    let calls = 0;
    const fetch = (() => {
      calls += 1;
      return new Promise<Response>(() => {});
    }) as unknown as typeof globalThis.fetch;
    const reasons: string[] = [];
    const verify = createCognitoLegacyVerify({
      region: "eu-west-1",
      clientId: "abc",
      onFailure: (reason) => reasons.push(reason),
      fetch,
    });
    const controller = new AbortController();
    const answer = verify("ada@example.com", "pw", controller.signal);
    setTimeout(() => controller.abort(), 10);
    expect(await answer).toBe(false);
    // A signal that aborted before the call answers false and sends no request.
    expect(await verify("ada@example.com", "pw", controller.signal)).toBe(false);
    expect(calls).toBe(1);
    expect(reasons).toEqual(["timeout", "timeout"]);
  }, 1000);

  it("sends no request when the signal aborts during the secret hash", async () => {
    let calls = 0;
    const fetch = (async () => {
      calls += 1;
      return Response.json(TOKENS);
    }) as unknown as typeof globalThis.fetch;
    const verify = createCognitoLegacyVerify({
      region: "eu-west-1",
      clientId: "abc",
      clientSecret: "s3cret",
      fetch,
    });
    const controller = new AbortController();
    const answer = verify("ada@example.com", "pw", controller.signal);
    // The hash awaits Web Crypto, so this abort lands before the fetch.
    controller.abort();
    expect(await answer).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toBe(0);
  });

  it("keeps the answer when onFailure throws", async () => {
    const c = fakeCognito({ status: 400, body: { __type: "NotAuthorizedException" } });
    const verify = createCognitoLegacyVerify({
      region: "eu-west-1",
      clientId: "abc",
      onFailure: () => {
        throw new Error("owner bug");
      },
      fetch: c.fetch,
    });
    expect(await verify("ada@example.com", "pw", signal)).toBe(false);
  });

  it("refuses a bad region and an empty client id at construction", () => {
    expect(() =>
      createCognitoLegacyVerify({ region: "eu-west-1.evil.com", clientId: "abc" }),
    ).toThrow(/not a region name/);
    expect(() => createCognitoLegacyVerify({ region: "eu-west-1", clientId: "" })).toThrow(
      /clientId is empty/,
    );
  });
});
