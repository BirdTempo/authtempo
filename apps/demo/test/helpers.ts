import { env, runInDurableObject, SELF } from "cloudflare:test";
import { expect } from "vitest";

export const ORIGIN = "https://demo.authtempo.com";
export const SANDBOX_COOKIE = "__Host-demo_sandbox";
export const SESSION_COOKIE = "__Host-tempo_session";
export const PASSWORD = "correct horse battery";

/**
 * The cookies of one visitor, as a browser keeps them. Each test starts with
 * a fresh sandbox, so no test reads the rows of another.
 */
export interface Jar {
  cookies: Map<string, string>;
  /** The cf-connecting-ip of this visitor. call() sets a new one at the first request. */
  ip?: string;
}

let ips = 0;

/**
 * A new address in 198.18.0.0/15 (RFC 2544, a test range) for each visitor.
 * The gate admits 5 sandboxes per IP, so one address for all tests fails.
 */
export function nextIp(): string {
  ips += 1;
  return `198.18.${(ips >> 8) & 255}.${ips & 255}`;
}

/** The address of the visitor of `jar`, set at its first use. */
export function ipOf(jar: Jar): string {
  if (jar.ip === undefined) jar.ip = nextIp();
  return jar.ip;
}

/** A first visit: the Worker makes a sandbox and sets its cookie. */
export async function newSandbox(): Promise<Jar> {
  const jar: Jar = { cookies: new Map() };
  const res = await call(jar, "GET", "/");
  if (res.status !== 303 || !jar.cookies.has(SANDBOX_COOKIE))
    throw new Error(`no sandbox: ${res.status}`);
  return jar;
}

/** A second visitor of the same sandbox: the sandbox cookie only, with no session. */
export function sameSandbox(jar: Jar): Jar {
  const id = jar.cookies.get(SANDBOX_COOKIE);
  if (id === undefined) throw new Error("the jar has no sandbox");
  return { cookies: new Map([[SANDBOX_COOKIE, id]]), ip: nextIp() };
}

/** The id of the sandbox of `jar`. */
export function sandboxId(jar: Jar): string {
  const id = jar.cookies.get(SANDBOX_COOKIE);
  if (id === undefined) throw new Error("the jar has no sandbox");
  return id;
}

/** Runs one query in the store of the sandbox of `jar` and answers its rows. */
export function rowsIn(jar: Jar, query: string, ...values: SqlStorageValue[]) {
  const stub = env.SANDBOX.get(env.SANDBOX.idFromName(sandboxId(jar)));
  return runInDurableObject(stub, (_instance, state) =>
    state.storage.sql.exec(query, ...values).toArray(),
  );
}

/**
 * Each Set-Cookie line that an answer of call() carried in this test file,
 * in order. cookies.test.ts reads every attribute of each line.
 */
export const SET_COOKIES: string[] = [];

function keep(jar: Jar, res: Response): void {
  for (const line of res.headers.getSetCookie()) {
    SET_COOKIES.push(line);
    const pair = line.split(";")[0] ?? "";
    const at = pair.indexOf("=");
    if (at < 1) continue;
    const name = pair.slice(0, at);
    const value = pair.slice(at + 1);
    // A cleared cookie has an empty value or Max-Age=0.
    if (value === "" || /;\s*max-age=0(;|$)/i.test(line)) jar.cookies.delete(name);
    else jar.cookies.set(name, value);
  }
}

/**
 * One request through the Worker, with the cookies of `jar` and the demo
 * origin and IP. Cloudflare always sets cf-connecting-ip, so each call sends
 * it unless `headers` names it. A string body goes as it is, an object body as JSON, a
 * URLSearchParams body as a form. The Set-Cookie lines of the answer go into
 * the jar. No redirect is followed.
 */
export async function call(
  jar: Jar,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const h = new Headers(headers);
  if (!h.has("origin")) h.set("origin", ORIGIN);
  if (!h.has("cf-connecting-ip")) h.set("cf-connecting-ip", ipOf(jar));
  const cookie = [...jar.cookies].map(([n, v]) => `${n}=${v}`).join("; ");
  if (cookie !== "") h.set("cookie", cookie);
  let payload: string | null = null;
  if (typeof body === "string") {
    // A raw body keeps the content-type of `headers`, or none.
    payload = body;
  } else if (body instanceof URLSearchParams) {
    h.set("content-type", "application/x-www-form-urlencoded");
    payload = body.toString();
  } else if (body !== undefined) {
    h.set("content-type", "application/json");
    payload = JSON.stringify(body);
  }
  const url = path.startsWith("https://") ? path : `${ORIGIN}${path}`;
  const res = await SELF.fetch(url, { method, headers: h, body: payload, redirect: "manual" });
  keep(jar, res);
  return res;
}

export interface Mail {
  id: number;
  to: string;
  subject: string;
  text: string;
  at: number;
}

/** The mail of the sandbox of `jar`, newest first, from /mailbox as JSON. */
export async function mailbox(jar: Jar): Promise<Mail[]> {
  const res = await call(jar, "GET", "/mailbox", undefined, { accept: "application/json" });
  if (res.status !== 200) throw new Error(`mailbox answered ${res.status}`);
  return ((await res.json()) as { mail: Mail[] }).mail;
}

/** The first link of the newest mail to `to` that holds a link of the demo origin. */
export async function lastLink(jar: Jar, to: string): Promise<URL> {
  for (const m of await mailbox(jar)) {
    if (m.to !== to) continue;
    const link = m.text.match(/https:\/\/demo\.authtempo\.com\/\S*/)?.[0];
    if (link !== undefined) return new URL(link.replace(/[.,)]+$/, ""));
  }
  throw new Error(`no link mailed to ${to}`);
}

/** The code of the newest mail to `to` that holds one ("... is 123456."). */
export async function lastCode(jar: Jar, to: string): Promise<string> {
  for (const m of await mailbox(jar)) {
    if (m.to !== to) continue;
    const code = m.text.match(/\bis (\d{6,8})\b/)?.[1];
    if (code !== undefined) return code;
  }
  throw new Error(`no code mailed to ${to}`);
}

/** The email of the caller of `jar`, or null when /whoami answers 401. */
export async function whoami(jar: Jar, headers: Record<string, string> = {}) {
  const res = await call(jar, "GET", "/whoami", undefined, headers);
  if (res.status === 401) return null;
  if (res.status !== 200) throw new Error(`whoami answered ${res.status}`);
  return (await res.json()) as { kind: string; id: string; email: string };
}

/** Signs in by the magic link of the mailbox. The jar then holds the session cookie. */
export async function signInByLink(jar: Jar, email: string): Promise<void> {
  const sent = await call(jar, "POST", "/auth/magic-link/request", { email });
  if (sent.status !== 200) throw new Error(`magic link request answered ${sent.status}`);
  const token = (await lastLink(jar, email)).searchParams.get("token") ?? "";
  const res = await call(jar, "POST", "/auth/magic-link/verify", new URLSearchParams({ token }));
  if (res.status !== 302 || !jar.cookies.has(SESSION_COOKIE))
    throw new Error(`magic link verify answered ${res.status}`);
}

/** A password user whose address the mailbox link proved. The jar holds its session. */
export async function verifiedUser(jar: Jar, email: string): Promise<void> {
  const up = await call(jar, "POST", "/auth/password/sign-up", { email, password: PASSWORD });
  if (up.status !== 200) throw new Error(`sign-up answered ${up.status}`);
  const token = (await lastLink(jar, email)).searchParams.get("token") ?? "";
  const res = await call(jar, "POST", "/auth/password/verify", new URLSearchParams({ token }));
  if (res.status !== 302 || !jar.cookies.has(SESSION_COOKIE))
    throw new Error(`verify answered ${res.status}`);
}

// The demo provider (plan 11b Task 9): the PKCE pair and the steps that a test drives by hand.
export const CALLBACK = `${ORIGIN}/auth/social/demo/callback`;

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function challengeOf(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

export function newVerifier(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** The authorize step of the demo provider: the picked identity answers a code for the callback. */
export async function pick(jar: Jar, authorize: string, identity: string): Promise<URL> {
  const page = await call(jar, "GET", authorize);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("Demo provider: pick a test identity");
  const res = await call(jar, "POST", authorize, new URLSearchParams({ identity }));
  expect(res.status).toBe(302);
  const back = new URL(res.headers.get("location") ?? "");
  expect(`${back.origin}${back.pathname}`).toBe(CALLBACK);
  return back;
}

/** A code of the demo provider for a PKCE pair that the test holds. */
export async function codeFor(jar: Jar, verifier: string): Promise<string> {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: "demo-provider-client",
    redirect_uri: CALLBACK,
    state: "test-state",
    code_challenge: await challengeOf(verifier),
    code_challenge_method: "S256",
  });
  const back = await pick(jar, `/provider/authorize?${q}`, "ada");
  return back.searchParams.get("code") ?? "";
}

export function exchange(jar: Jar, code: string, verifier: string): Promise<Response> {
  return call(
    jar,
    "POST",
    "/provider/token",
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: CALLBACK,
      client_id: "demo-provider-client",
      client_secret: "demo-provider-secret-not-a-secret",
      code_verifier: verifier,
    }),
  );
}
