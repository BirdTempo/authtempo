import { createExecutionContext, env, SELF } from "cloudflare:test";
import {
  createAuth,
  createMemoryAdapter,
  createPbkdf2PasswordHash,
  type MailMessage,
} from "@authtempo/core";
import { describe, expect, it, vi } from "vitest";
import {
  CONFORMANCE_EMAIL,
  conformanceConfig,
  conformanceOn,
  SUITE_CALLBACK,
  SUITE_ORIGIN,
  seedConformance,
  suiteFetch,
} from "../src/conformance.js";
import conformanceWorker from "../src/conformance-worker.js";
import conformanceText from "../wrangler.conformance.jsonc?raw";
import wranglerText from "../wrangler.jsonc?raw";
import { BASE } from "./helpers.js";

/** The conformance mode of plan 12e Task 17 (rulings 51 and 52). */

const LOCAL = "https://host.docker.internal:8787";

/** A core instance with the mode's config on memory storage, and its mail. */
function conformanceAuth(inner: typeof fetch = vi.fn()) {
  const mail: MailMessage[] = [];
  const auth = createAuth({
    baseURL: LOCAL,
    secret: "0123456789abcdef0123456789abcdef",
    trustedOrigins: [LOCAL],
    storage: createMemoryAdapter(),
    mail: {
      send: async (m) => {
        mail.push(m);
      },
    },
    password: { hash: createPbkdf2PasswordHash({ iterations: 1000 }) },
    ...conformanceConfig(LOCAL, inner),
  });
  const takeLink = () => /https:\/\/\S+/.exec(mail.at(-1)?.text ?? "")?.[0] ?? null;
  return { auth, takeLink };
}

describe("the conformance mode of the example Worker (plan 12e Task 17)", () => {
  it("runs the real conformance entry: no seed and no answer off the mode, a dropped failed seed, then RS256 and the seeded user", async () => {
    const LOCAL_ENV = { ...env, BASE_URL: LOCAL, TEST_MODE: "0" } as unknown as Env;
    const ask = (path: string, extra: Partial<Env>, init?: RequestInit) =>
      conformanceWorker.fetch(
        new Request(`${LOCAL}${path}`, init),
        { ...LOCAL_ENV, ...extra },
        createExecutionContext(),
      );
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        ask("/auth/.well-known/openid-configuration", {
          CONFORMANCE_MODE: "0",
          CONFORMANCE_PASSWORD: "conformance password 1",
        }),
      ).rejects.toThrow("needs CONFORMANCE_MODE set to 1");
      // A password that the sign-up refuses: the seed logs one line, and the next request tries again.
      const on = { CONFORMANCE_MODE: "1" };
      await expect(
        ask("/auth/.well-known/openid-configuration", { ...on, CONFORMANCE_PASSWORD: "x" }),
      ).rejects.toThrow("the sign-up of the test user failed");
      expect(errors.mock.calls.map((c) => String(c[0]))).toEqual(["conformance: the seed failed:"]);
      const good = { ...on, CONFORMANCE_PASSWORD: "conformance password 1" };
      const doc = (await (
        await ask("/auth/.well-known/openid-configuration", good)
      ).json()) as Record<string, unknown>;
      expect([
        doc.id_token_signing_alg_values_supported,
        doc.device_authorization_endpoint,
      ]).toEqual([["RS256"], `${LOCAL}/auth/oauth/device_authorization`]);
      const lines = errors.mock.calls.map((c) => String(c[0]));
      expect(
        lines.filter((l) => /^conformance: conformance client(?: 2)? client_id=cl_/.test(l)),
      ).toHaveLength(2);
      const signIn = await ask("/auth/password/sign-in", good, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: LOCAL,
          "cf-connecting-ip": "203.0.113.172",
        },
        body: JSON.stringify({ email: CONFORMANCE_EMAIL, password: "conformance password 1" }),
      });
      expect(signIn.status).toBe(200);
    } finally {
      errors.mockRestore();
    }
  });

  it("keeps the mode out of wrangler.jsonc and names its own entry in wrangler.conformance.jsonc", () => {
    const mainOf = (text: string) => /"main":\s*"([^"]*)"/.exec(text)?.[1];
    const modeOf = (text: string) =>
      [...text.matchAll(/"CONFORMANCE_MODE":\s*"([^"]*)"/g)].map((m) => m[1]);
    expect({ main: mainOf(wranglerText), mode: modeOf(wranglerText) }).toEqual({
      main: "src/index.ts",
      mode: [],
    });
    expect({ main: mainOf(conformanceText), mode: modeOf(conformanceText) }).toEqual({
      main: "src/conformance-worker.ts",
      mode: ["1"],
    });
  });

  it("turns on for the exact value 1 only", () => {
    const cases = ["1", "0", "", "true", "yes", " 1", "1 ", undefined];
    expect(cases.map((v) => conformanceOn(v === undefined ? {} : { CONFORMANCE_MODE: v }))).toEqual(
      [true, false, false, false, false, false, false, false],
    );
  });

  it("serves the default config while the mode is off: no RS256, no device grant, no default resource", async () => {
    const doc = (await (await SELF.fetch(`${BASE}/.well-known/openid-configuration`)).json()) as {
      id_token_signing_alg_values_supported: string[];
      device_authorization_endpoint?: string;
    };
    expect(doc.id_token_signing_alg_values_supported).toEqual(["EdDSA"]);
    expect(doc.device_authorization_endpoint).toBeUndefined();
    const reg = await SELF.fetch(`${BASE}/auth/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.171" },
      body: JSON.stringify({ redirect_uris: ["http://127.0.0.1:33418/callback"] }),
    });
    const { client_id } = (await reg.json()) as { client_id: string };
    const query = new URLSearchParams({
      response_type: "code",
      client_id,
      redirect_uri: "http://127.0.0.1:33418/callback",
      scope: "mcp:tools",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
      state: "s1",
    });
    const res = await SELF.fetch(`${BASE}/auth/oauth/authorize?${query}`, { redirect: "manual" });
    expect(new URL(res.headers.get("location") ?? `${BASE}/`).searchParams.get("error")).toBe(
      "invalid_target",
    );
  });

  it("builds RS256, the device grant, dynamic registration, and the default resource when on", async () => {
    const { auth } = conformanceAuth();
    const doc = (await (
      await auth.wellKnown(new Request(`${LOCAL}/.well-known/openid-configuration`))
    ).json()) as Record<string, unknown>;
    expect({
      algs: doc.id_token_signing_alg_values_supported,
      device: doc.device_authorization_endpoint,
      registration: doc.registration_endpoint,
      backchannel: doc.backchannel_logout_supported,
    }).toEqual({
      algs: ["RS256"],
      device: `${LOCAL}/auth/oauth/device_authorization`,
      registration: `${LOCAL}/auth/oauth/register`,
      backchannel: true,
    });
    // The suite sends no resource: the default stands in, so no invalid_target comes back.
    const reg = await auth.handle(
      new Request(`${LOCAL}/auth/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: [SUITE_CALLBACK] }),
      }),
    );
    const { client_id } = (await reg.json()) as { client_id: string };
    const query = new URLSearchParams({
      response_type: "code",
      client_id,
      redirect_uri: SUITE_CALLBACK,
      scope: "openid",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
      state: "s1",
    });
    const res = await auth.handle(new Request(`${LOCAL}/auth/oauth/authorize?${query}`));
    const location = res.headers.get("location") ?? "";
    expect({ status: res.status, signIn: location.includes("/oauth/sign-in") }).toEqual({
      status: 302,
      signIn: true,
    });
  });

  it("writes a verified test user and two clients, and a second seed rotates each secret", async () => {
    const { auth, takeLink } = conformanceAuth();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await seedConformance(auth, "conformance password 1", takeLink);
      await seedConformance(auth, "conformance password 1", takeLink);
      const lines = errors.mock.calls.map((c) => String(c[0]));
      const ids = lines.map((l) => /client_id=(\S+)/.exec(l)?.[1]);
      const secrets = lines.map((l) => /client_secret=(\S+)/.exec(l)?.[1]);
      expect(lines).toHaveLength(4);
      // The same two clients, each with a new secret on the second seed.
      expect([ids[2], ids[3]]).toEqual([ids[0], ids[1]]);
      expect(new Set(secrets).size).toBe(4);
      const listed = await auth.api.oauth?.clients.list();
      expect(
        listed?.ok &&
          listed.value.clients
            .map((c) => [c.name, c.authMethod, c.redirectUris])
            .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      ).toEqual([
        ["conformance client", "client_secret_basic", [SUITE_CALLBACK]],
        ["conformance client 2", "client_secret_post", [SUITE_CALLBACK]],
      ]);
      const signIn = await auth.api.password?.signIn({
        email: CONFORMANCE_EMAIL,
        password: "conformance password 1",
        ip: null,
        userAgent: null,
      });
      expect(signIn?.ok && "user" in signIn.value && signIn.value.user.emailVerified).toBe(true);
    } finally {
      errors.mockRestore();
    }
  });

  it("lets oauth.fetch reach the suite origin only, with no request to another host", async () => {
    const inner = vi.fn(async () => new Response(null, { status: 204 }));
    const guarded = suiteFetch(inner as unknown as typeof fetch);
    await expect(guarded("https://example.com/logout", { method: "POST" })).rejects.toThrow(
      "the conformance fetch refuses https://example.com",
    );
    await expect(guarded(`${LOCAL}/x`)).rejects.toThrow(TypeError);
    expect(inner).toHaveBeenCalledTimes(0);
    expect((await guarded(`${SUITE_ORIGIN}/test/a/authtempo/backchannel`)).status).toBe(204);
    expect(inner).toHaveBeenCalledTimes(1);
  });
});
