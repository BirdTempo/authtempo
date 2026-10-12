import {
  createAuth,
  createMemoryAdapter,
  createPbkdf2PasswordHash,
  LEGACY_VERIFY_HASH,
} from "@tempo-auth/core";
import { describe, expect, it, vi } from "vitest";
import { COGNITO_FAILURE_LOG, createCognitoLegacyVerify } from "../src/cognito.js";

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

/** onFailure runs on a 0 ms timer after the answer; a later timer runs after it. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

/**
 * Node's process, typed here because the test tsconfig loads no Node types
 * (tsconfig.test.json, "types": []). Vitest runs these tests in Node.
 */
const nodeProcess = (
  globalThis as unknown as {
    process: {
      on(
        event: "unhandledRejection" | "uncaughtException",
        listener: (reason: unknown) => void,
      ): void;
      off(
        event: "unhandledRejection" | "uncaughtException",
        listener: (reason: unknown) => void,
      ): void;
    };
  }
).process;

function refusing(onFailure: (reason: string) => unknown) {
  const c = fakeCognito({ status: 400, body: { __type: "NotAuthorizedException" } });
  return createCognitoLegacyVerify({
    region: "eu-west-1",
    clientId: "abc",
    onFailure,
    fetch: c.fetch,
  });
}
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
    await settle();
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
      await settle();
      expect(c.reasons).toEqual([reason]);
    }
  });

  it("cuts a long __type to 80 characters and strips its control characters before the log (M-3)", async () => {
    const forged = `Bad\nType\r\u0007\u009b${"x".repeat(200)}`;
    const c = checkWith({ status: 400, body: { __type: `com.amazonaws#${forged}` } });
    expect(await c.verify("ada@example.com", "pw", signal)).toBe(false);
    await settle();
    expect(c.reasons).toEqual([`BadType${"x".repeat(73)}`]);
    // A __type of control characters only gives the fixed reason.
    const only = checkWith({ status: 400, body: { __type: "\n\r\t" } });
    expect(await only.verify("ada@example.com", "pw", signal)).toBe(false);
    await settle();
    expect(only.reasons).toEqual(["malformed"]);
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
    await settle();
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
      await settle();
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
      await settle();
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
      await settle();
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
    await settle();
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
    await settle();
    expect(reasons).toEqual(["timeout", "timeout"]);
  }, 1000);

  it("keeps false when the fetch answers with tokens after the abort (parked Task 2 Minor)", async () => {
    // This fetch ignores the signal and answers with tokens 30 ms after the
    // call; the abort lands at 10 ms, so the answer is already false.
    let late = false;
    const fetch = (() =>
      new Promise<Response>((resolve) =>
        setTimeout(() => {
          late = true;
          resolve(Response.json(TOKENS));
        }, 30),
      )) as unknown as typeof globalThis.fetch;
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
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(late).toBe(true);
    // One report, the timeout: the late true is never read.
    expect(reasons).toEqual(["timeout"]);
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

  it("keeps the answer when onFailure throws, with no uncaught exception", async () => {
    const uncaught: unknown[] = [];
    const listener = (error: unknown) => uncaught.push(error);
    nodeProcess.on("uncaughtException", listener);
    try {
      let called = 0;
      const verify = refusing(() => {
        called += 1;
        throw new Error("owner bug");
      });
      expect(await verify("ada@example.com", "pw", signal)).toBe(false);
      await settle();
      expect(called).toBe(1);
      expect(uncaught).toEqual([]);
    } finally {
      nodeProcess.off("uncaughtException", listener);
    }
  });

  it("drops a rejection from an async onFailure, with no unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    nodeProcess.on("unhandledRejection", listener);
    try {
      let called = 0;
      const verify = refusing(async () => {
        called += 1;
        throw new Error("log store down");
      });
      expect(await verify("ada@example.com", "pw", signal)).toBe(false);
      // Node reports an unhandled rejection after the microtasks of a turn; wait a few turns.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(called).toBe(1);
      expect(unhandled).toEqual([]);
    } finally {
      nodeProcess.off("unhandledRejection", listener);
    }
  });

  it("answers before an async onFailure that resolves after 200 ms", async () => {
    let done = false;
    const verify = refusing(
      () =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            done = true;
            resolve();
          }, 200),
        ),
    );
    const started = Date.now();
    expect(await verify("ada@example.com", "pw", signal)).toBe(false);
    expect(Date.now() - started).toBeLessThan(100);
    expect(done).toBe(false);
  });

  it("answers before a synchronous onFailure that blocks for 200 ms", async () => {
    let ran = false;
    const verify = refusing(() => {
      const end = Date.now() + 200;
      while (Date.now() < end) {
        // Block the thread, as a slow synchronous logger does.
      }
      ran = true;
    });
    const started = Date.now();
    expect(await verify("ada@example.com", "pw", signal)).toBe(false);
    expect(Date.now() - started).toBeLessThan(100);
    expect(ran).toBe(false);
    await settle();
    expect(ran).toBe(true);
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

describe("createCognitoLegacyVerify: the default onFailure and waitUntil (plan 9b2)", () => {
  it("logs one line with the reason only when the app passes no onFailure", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const c = fakeCognito({
        status: 400,
        body: { __type: "NotAuthorizedException", message: "Incorrect username or password." },
      });
      const verify = createCognitoLegacyVerify({
        region: "eu-west-1",
        clientId: "abc",
        fetch: c.fetch,
      });
      expect(await verify("ada@example.com", "pw-secret", signal)).toBe(false);
      await settle();
      expect(error.mock.calls).toEqual([[`${COGNITO_FAILURE_LOG} NotAuthorizedException`]]);
      expect(JSON.stringify(error.mock.calls)).not.toMatch(/ada@example\.com|pw-secret/);
    } finally {
      error.mockRestore();
    }
  });

  it("logs nothing on a match, and the app's onFailure replaces the default line", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const ok = createCognitoLegacyVerify({
        region: "eu-west-1",
        clientId: "abc",
        fetch: fakeCognito({ status: 200, body: TOKENS }).fetch,
      });
      expect(await ok("ada@example.com", "pw", signal)).toBe(true);
      const c = checkWith({ status: 400, body: { __type: "UserNotFoundException" } });
      expect(await c.verify("ada@example.com", "pw", signal)).toBe(false);
      await settle();
      expect(c.reasons).toEqual(["UserNotFoundException"]);
      expect(error).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  it("hands the report to waitUntil, and the promise settles after onFailure ran", async () => {
    const held: Promise<unknown>[] = [];
    let ran = false;
    const verify = createCognitoLegacyVerify({
      region: "eu-west-1",
      clientId: "abc",
      fetch: fakeCognito({ status: 400, body: { __type: "UserNotFoundException" } }).fetch,
      onFailure: () => {
        ran = true;
      },
      waitUntil: (promise) => held.push(promise),
    });
    expect(await verify("ada@example.com", "pw", signal)).toBe(false);
    expect(held).toHaveLength(1);
    expect(ran).toBe(false);
    await held[0];
    expect(ran).toBe(true);
  });

  it("hands the request in flight and the report to waitUntil on a timeout", async () => {
    const held: Promise<unknown>[] = [];
    const reasons: string[] = [];
    // This fetch never answers and never looks at the signal.
    const fetch = (() => new Promise<Response>(() => {})) as unknown as typeof globalThis.fetch;
    const verify = createCognitoLegacyVerify({
      region: "eu-west-1",
      clientId: "abc",
      fetch,
      onFailure: (reason) => reasons.push(reason),
      waitUntil: (promise) => held.push(promise),
    });
    const controller = new AbortController();
    const answer = verify("ada@example.com", "pw", controller.signal);
    setTimeout(() => controller.abort(), 10);
    expect(await answer).toBe(false);
    expect(held).toHaveLength(2);
    // The order is the code's: `keep(asked)` runs before `report(answer)`, so
    // held[0] is the request in flight, which never settles here, and held[1]
    // is the report.
    await held[1];
    expect(reasons).toEqual(["timeout"]);
  }, 1000);

  it("keeps the answer when waitUntil throws outside a request", async () => {
    const reasons: string[] = [];
    const verify = createCognitoLegacyVerify({
      region: "eu-west-1",
      clientId: "abc",
      fetch: fakeCognito({ status: 400, body: { __type: "NotAuthorizedException" } }).fetch,
      onFailure: (reason) => reasons.push(reason),
      waitUntil: () => {
        throw new Error("no request context");
      },
    });
    expect(await verify("ada@example.com", "pw", signal)).toBe(false);
    await settle();
    expect(reasons).toEqual(["NotAuthorizedException"]);
  });
});

describe("a Cognito pool that does not accept the email as a user name (plan 9b2, Review Focus 2)", () => {
  it("answers invalid_credentials through core and logs one reason line per failure", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const storage = createMemoryAdapter();
      const at = new Date("2026-10-12T00:00:00.000Z");
      await storage.create("user", {
        id: "u1",
        email: "ada@example.com",
        emailVerified: true,
        name: null,
        image: null,
        createdAt: at,
        updatedAt: at,
      });
      await storage.create("password", {
        id: "p1",
        userId: "u1",
        hash: LEGACY_VERIFY_HASH,
        createdAt: at,
        updatedAt: at,
      });
      // PreventUserExistenceErrors ENABLED answers NotAuthorizedException for a user
      // name the pool does not know; LEGACY answers UserNotFoundException (AWS docs, read 2026-10-12).
      const c = fakeCognito({ status: 400, body: { __type: "NotAuthorizedException" } });
      const auth = createAuth({
        baseURL: "https://api.example.com",
        secret: "0123456789abcdef0123456789abcdef",
        trustedOrigins: [],
        storage,
        mail: { send: async () => {} },
        password: {
          hash: createPbkdf2PasswordHash({ iterations: 1000 }),
          legacyVerify: {
            verify: createCognitoLegacyVerify({
              region: "eu-west-1",
              clientId: "abc",
              fetch: c.fetch,
            }),
            timeoutMs: 100,
          },
        },
      });
      const pw = auth.api.password;
      if (!pw) throw new Error("the password api is missing");
      for (let i = 0; i < 2; i++)
        expect(
          await pw.signIn({
            email: "ada@example.com",
            password: "the old password",
            ip: null,
            userAgent: null,
          }),
        ).toMatchObject({ ok: false, code: "invalid_credentials" });
      await settle();
      expect(c.seen).toHaveLength(2);
      expect(error.mock.calls).toEqual([
        [`${COGNITO_FAILURE_LOG} NotAuthorizedException`],
        [`${COGNITO_FAILURE_LOG} NotAuthorizedException`],
      ]);
      // The marker stays: a failed check writes no hash.
      expect(
        (await storage.findOne("password", [{ field: "id", op: "eq", value: "p1" }]))?.hash,
      ).toBe(LEGACY_VERIFY_HASH);
    } finally {
      error.mockRestore();
    }
  });
});
