import type { AuthConfig } from "../../src/config.js";
import { createOrganization } from "../../src/engine/organizations.js";
import { createScimToken } from "../../src/engine/scim/tokens.js";
import type { ScimScope } from "../../src/schema.js";
import { BASE_URL } from "../helpers.js";
import { FAST } from "../password-helpers.js";
import { ssoAuth, verifiedDomain } from "../sso/helpers.js";
import { enrolled } from "../totp-helpers.js";

/** The app as the actor of the token calls of the SCIM tests: the actor of `api.scim.tokens`. */
export const SCIM_APP = { kind: "app", name: "scim-test" } as const;

/** The IP of each SCIM request of a test, unless a test names another. */
export const SCIM_IP = "203.0.113.20";

/**
 * A memory engine with `organizations`, `sso` with two fake resolvers,
 * `scim`, and password sign-in, on the test clock of `makeAuth`. It holds
 * the organization `acme` and its owner, with a second factor and a fresh
 * session. The domain `acme.example` is verified through the fake DNS
 * ports, the only way to a claim. `overrides` replaces a top key.
 */
export async function scimAuth(overrides: Partial<AuthConfig> = {}) {
  const w = ssoAuth({
    password: { hash: FAST, uniformSignUp: false },
    scim: {},
    ...overrides,
  });
  // The owner turns on a factor first, so the sign-in of the enable is fresh.
  const owner = await enrolled(w, "owner@acme.example");
  const made = await createOrganization(w.config, { user: owner.user, slug: "acme", name: "Acme" });
  if (!made.ok) throw new Error(made.code);
  const org = made.value.organization.id;
  const domainId = await verifiedDomain(w, org);
  return { ...w, owner: owner.session, org, domainId };
}
export type ScimWorld = Awaited<ReturnType<typeof scimAuth>>;

/**
 * A SCIM token of the organization, through the call that `api.scim.tokens.create`
 * makes. The answer is the clear token and its id.
 */
export async function scimToken(
  w: ScimWorld,
  scopes?: ScimScope[],
  organizationId: string = w.org,
): Promise<{ token: string; id: string }> {
  const made = await createScimToken(w.config, SCIM_APP, {
    organizationId,
    name: "directory",
    ...(scopes === undefined ? {} : { scopes }),
  });
  if (!made.ok) throw new Error(made.code);
  return { token: made.value.token, id: made.value.id };
}

/**
 * The world of `scimAuth` with one token of every scope. The SCIM limit
 * tests and the list measure (test/measure) use it.
 */
export async function scimTokenWorld(): Promise<ScimTokenWorld> {
  const w = await scimAuth();
  const { token } = await scimToken(w);
  return { ...w, token };
}
export type ScimTokenWorld = ScimWorld & { token: string };

/**
 * One SCIM request through the routes, with the bearer `token` (none for
 * null). A `body` that is not undefined goes as JSON. The IP is `SCIM_IP`
 * unless `headers` names another.
 */
export function scim(
  w: { handle: (request: Request) => Promise<Response> },
  token: string | null,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const h: Record<string, string> = {
    "cf-connecting-ip": SCIM_IP,
    ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    ...(body === undefined ? {} : { "content-type": "application/scim+json" }),
    ...headers,
  };
  return w.handle(
    new Request(`${BASE_URL}/auth/scim/v2${path}`, {
      method,
      headers: h,
      ...(body === undefined
        ? {}
        : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    }),
  );
}

/** One request of a provider page (plan 12d Task 12): the files of `fixtures/<provider>/`. */
export interface ProviderRequest {
  method: string;
  path: string | null;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * Core's typecheck has no Node types, because core runs on Workers; vitest
 * runs in Node. A specifier in a constant keeps the import out of the
 * typecheck (as access.test.ts does).
 */
interface FixtureFs {
  readFileSync(file: URL, encoding: "utf8"): string;
}
const FS_MODULE = "node:fs";

/** The answer of one replayed request, with the file name for the message of each assertion. */
export interface Replayed {
  file: string;
  status: number;
  headers: Headers;
  body: Record<string, unknown>;
}

/**
 * Sends one request of `fixtures/<provider>/<name>.json` through the routes
 * with `token`. Each key of `ids` (an id of the page) becomes its value (an
 * id that the server answered), in the path and in the body. A file with no
 * path takes `path`. The header names go in lower case, so the content
 * type of the file and of `scim` do not both go.
 */
export async function replay(
  w: { handle: (request: Request) => Promise<Response> },
  token: string,
  provider: "entra" | "okta",
  name: string,
  ids: Record<string, string> = {},
  path?: string,
): Promise<Replayed> {
  const file = `${provider}/${name}.json`;
  const { readFileSync }: FixtureFs = await import(/* @vite-ignore */ FS_MODULE);
  let text = readFileSync(new URL(`./fixtures/${file}`, import.meta.url), "utf8");
  for (const [from, to] of Object.entries(ids)) text = text.split(from).join(to);
  const request = JSON.parse(text) as ProviderRequest;
  const target = request.path ?? path;
  if (target === undefined) throw new Error(`${file} has no path, and the test gives none`);
  const headers = Object.fromEntries(
    Object.entries(request.headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const res = await scim(
    w,
    token,
    request.method,
    target,
    request.body === null ? undefined : request.body,
    headers,
  );
  const body = await res.text();
  return {
    file,
    status: res.status,
    headers: res.headers,
    body: (body === "" ? null : JSON.parse(body)) as Record<string, unknown>,
  };
}
