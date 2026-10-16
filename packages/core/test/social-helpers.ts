import type { AuthConfig } from "../src/config.js";
import { resolveSession } from "../src/engine/sessions.js";
import { completeSocial, startSocial } from "../src/engine/social.js";
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

/** Starts a Google flow; the callback needs the state, the nonce, and the binding value. */
export async function startGoogle(
  auth: Pick<ReturnType<typeof socialAuth>, "config">,
  next = "/home",
) {
  const r = await startSocial(auth.config, { provider: "google", next, ip: "1.1.1.1" });
  if (!r.ok) throw new Error(`start failed: ${r.code}`);
  const url = new URL(r.value.location);
  return {
    state: url.searchParams.get("state") ?? "",
    nonce: url.searchParams.get("nonce") ?? "",
    bindToken: r.value.bindToken,
  };
}

/** A Google ID token for the fake jwt seam, with the flow's nonce. */
export function googleClaims(nonce: string, claims: Record<string, unknown>): FakeIdToken {
  return {
    audience: GOOGLE.clientId,
    issuer: "https://accounts.google.com",
    claims: {
      sub: "g-1",
      email: "ada@example.com",
      email_verified: true,
      name: "Ada",
      picture: "https://p/a.png",
      nonce,
      ...claims,
    },
  };
}

/**
 * A Google sign-in to its end: the session token and the resolved session
 * (plan 12a). A verified address that a user holds links Google to that
 * user. An unverified address with no user makes an unverified user.
 */
export async function googleSignIn(
  auth: Pick<ReturnType<typeof socialAuth>, "config">,
  jwtTokens: Record<string, FakeIdToken>,
  claims: Record<string, unknown> = {},
) {
  const s = await startGoogle(auth);
  jwtTokens["idtok-default"] = googleClaims(s.nonce, claims);
  const done = await completeSocial(auth.config, {
    provider: "google",
    state: s.state,
    code: "c",
    error: null,
    bindToken: s.bindToken,
    ip: null,
    userAgent: null,
  });
  if (!done.ok || !("token" in done.value)) throw new Error("the social sign-in opened no session");
  const resolved = await resolveSession(auth.config, done.value.token);
  if (!resolved) throw new Error("no session");
  return { ...resolved, token: done.value.token };
}
