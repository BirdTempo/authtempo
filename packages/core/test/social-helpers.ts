import type { AuthConfig } from "../src/config.js";
import { sha256Hex } from "../src/primitives/crypto.js";
import type { JwtSeam } from "../src/seams/jwt.js";
import { makeAuth } from "./helpers.js";

export const GOOGLE = { clientId: "gid", clientSecret: "gsecret" };
export const APPLE = {
  clientId: "com.example.web",
  teamId: "TEAM1",
  keyId: "KEY1",
  privateKey: "pem",
};

export interface FakeIdToken {
  claims: Record<string, unknown>;
  audience: string;
  issuer: string;
}

/**
 * A jwt seam that knows a fixed set of tokens. `verifyIdToken` succeeds
 * when the token is known, its issuer is in the list, and its audience
 * matches, else it throws, as jose would.
 */
export function fakeJwt(tokens: Record<string, FakeIdToken>): JwtSeam {
  return {
    async verifyIdToken(input) {
      const t = tokens[input.token];
      const issuers = Array.isArray(input.issuer) ? input.issuer : [input.issuer];
      if (!t || t.audience !== input.audience || !issuers.includes(t.issuer)) {
        throw new Error("fake jwt: verify failed");
      }
      return t.claims;
    },
    async signES256(input) {
      return `es256.${input.keyId}.${String(input.payload.exp)}`;
    },
  };
}

export interface TokenCall {
  url: string;
  form: Record<string, string>;
  headers: Record<string, string>;
}

/**
 * A fetch that answers the token endpoints. `answer` decides per call;
 * every call is recorded with its form body for assertions.
 */
export function fakeFetch(answer: (call: TokenCall) => Response | Promise<Response>) {
  const calls: TokenCall[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init?.body === "string" ? init.body : "";
    const form: Record<string, string> = {};
    for (const [k, v] of new URLSearchParams(body)) form[k] = v;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const call = { url, form, headers };
    calls.push(call);
    return answer(call);
  };
  return { fetchFn, calls };
}

/** A fetch whose token endpoint always answers one id_token. */
export function tokenEndpoint(idToken: string) {
  return fakeFetch(() =>
    Response.json({ id_token: idToken, access_token: "at", token_type: "Bearer" }),
  );
}

export function socialAuth(overrides: Partial<AuthConfig> = {}, jwt: JwtSeam = fakeJwt({})) {
  const { fetchFn, calls } = tokenEndpoint("idtok-default");
  const made = makeAuth({
    social: { google: GOOGLE, apple: APPLE, fetch: fetchFn },
    jwt,
    ...overrides,
  });
  return { ...made, calls };
}

/** The verification row of a started flow, by its state value. */
export async function stateRow(storage: ReturnType<typeof makeAuth>["storage"], state: string) {
  return storage.findOne("verification", [
    { field: "valueHash", op: "eq", value: await sha256Hex(state) },
  ]);
}
