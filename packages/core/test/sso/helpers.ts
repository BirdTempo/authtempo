import type { AuthConfig, SsoConfig } from "../../src/config.js";
import { createOrganization } from "../../src/engine/organizations.js";
import type { DnsTxtPort } from "../../src/engine/sso/dns.js";
import { addDomain, verifyDomain } from "../../src/engine/sso/domains.js";
import { createRouter } from "../../src/http/router.js";
import { coreRoutes } from "../../src/http/routes/index.js";
import { makeAuth } from "../helpers.js";

/**
 * A DNS port of a test: it answers from a map and counts its calls. A name
 * not in the map answers `[]`. An entry of null answers null, the answer of
 * a resolver that gives no usable answer.
 */
export function fakeDns(
  name: string,
  answers: Record<string, string[] | null | "throw">,
): DnsTxtPort & { calls: string[] } {
  const calls: string[] = [];
  return {
    name,
    calls,
    async txt(asked) {
      calls.push(asked);
      // Not `??`: it reads a null entry as a missing name, and a test then never reaches the null path.
      // The cast is safe: `hasOwn` holds, so the entry is of the map's type.
      const answer = Object.hasOwn(answers, asked)
        ? (answers[asked] as string[] | null | "throw")
        : [];
      if (answer === "throw") throw new Error(`the fake resolver ${name} fails`);
      return answer;
    },
  };
}

/** The app as the actor of the engine calls of the SSO tests. */
export const SSO_APP = { kind: "app", name: "sso-test" } as const;

/**
 * A memory engine with `organizations`, `sso` with two fake resolvers, and
 * the test clock of `makeAuth`. `a` and `b` answer from `answers.a` and
 * `answers.b`, which a test changes between calls. `handle` serves the
 * routes. `overrides` replaces a top key; its `sso` keeps the two ports.
 */
export function ssoAuth(overrides: Partial<AuthConfig> = {}) {
  const answers: { a: Record<string, AnswerOf>; b: Record<string, AnswerOf> } = { a: {}, b: {} };
  const a = fakeDns("a", answers.a);
  const b = fakeDns("b", answers.b);
  const sso: SsoConfig = { ...(overrides.sso || {}), dns: [a, b] };
  const auth = makeAuth({
    organizations: {
      platformRole: "operator",
      platformOrganization: "platform-co",
      ranks: { viewer: 1, member: 2, admin: 3, owner: 4, operator: 5 },
    },
    ...overrides,
    sso,
  });
  const handle = createRouter(auth.config, coreRoutes(auth.config));
  return { ...auth, a, b, answers, handle };
}

/** One answer of a fake resolver: a list, null, or a throw. */
type AnswerOf = string[] | null | "throw";

/**
 * An organization with a verified owner, through the organization engine,
 * as `api.createOrganization` makes it. The answer is its id.
 */
export async function seedOrganization(
  auth: ReturnType<typeof makeAuth>,
  slug = "acme",
): Promise<string> {
  const owner = await auth.seedUser(`owner@${slug}.example`);
  const made = await createOrganization(auth.config, { user: owner, slug, name: slug });
  if (!made.ok) throw new Error(made.code);
  return made.value.organization.id;
}

/**
 * A domain verified through both resolvers of `ssoAuth`, the only way to a
 * claim: the add, the record on both resolvers, then the verify.
 */
export async function verifiedDomain(
  w: ReturnType<typeof ssoAuth>,
  organizationId: string,
  domain = "acme.example",
): Promise<string> {
  const added = await addDomain(w.config, SSO_APP, { organizationId, domain });
  if (!added.ok) throw new Error(added.code);
  const record = added.value.record;
  if (record === null) throw new Error("no record");
  w.answers.a[record.name] = [record.value];
  w.answers.b[record.name] = [record.value];
  const verified = await verifyDomain(w.config, SSO_APP, { id: added.value.id });
  if (!verified.ok) throw new Error(verified.code);
  return added.value.id;
}
