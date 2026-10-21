import type { AuthConfig } from "../src/config.js";
import { matchOperatorSecret, type OperatorActor } from "../src/engine/operator/guards.js";
import { addMember } from "../src/engine/organizations.js";
import { type ResolvedSession, resolveSession } from "../src/engine/sessions.js";
import { sha256Hex } from "../src/primitives/crypto.js";
import { BASE_URL, makeAuth, recordCredential, seedPlatform } from "./helpers.js";
import { FAST, signUpAndVerify } from "./password-helpers.js";
import { enrolled, PASSWORD, verifiedSession } from "./totp-helpers.js";

/** The three named operator secrets of the fixture, each 32 visible characters or more. */
export const OPERATOR_SECRETS = {
  support: "operator-support-0123456789abcdef-0123",
  keys: "operator-keys-0123456789abcdef-0123456",
  audit: "operator-audit-0123456789abcdef-012345",
} as const;

/** The address of the platform operator of the fixture. */
export const OPERATOR_EMAIL = "op@example.com";

/** `Authorization: Operator <secret>`. */
export const operatorHeader = (secret: string) => ({ authorization: `Operator ${secret}` });

/**
 * The engine view of plan 12f: password sign-in, TOTP, the platform
 * organization `platform-co` with the platform role `operator`, and three
 * named secrets with the user tools on. `extra` replaces a top key.
 */
export async function operatorAuth(extra: Partial<AuthConfig> = {}) {
  for (const secret of Object.values(OPERATOR_SECRETS)) recordCredential(secret);
  return makeAuth({
    password: { hash: FAST, uniformSignUp: false },
    organizations: {
      platformRole: "operator",
      platformOrganization: "platform-co",
      ranks: { viewer: 1, member: 2, admin: 3, owner: 4, operator: 5 },
    },
    operator: {
      secrets: [
        {
          name: "support",
          secretHash: await sha256Hex(OPERATOR_SECRETS.support),
          scopes: ["users", "sessions", "audit"],
        },
        {
          name: "keys",
          secretHash: await sha256Hex(OPERATOR_SECRETS.keys),
          scopes: ["keys", "secrets"],
        },
        { name: "audit", secretHash: await sha256Hex(OPERATOR_SECRETS.audit), scopes: ["audit"] },
      ],
      users: true,
    },
    ...extra,
  });
}

export type OperatorAuth = Awaited<ReturnType<typeof operatorAuth>>;

/**
 * A platform operator, built through the flows of the product. The app
 * seeds the platform organization and root through storage, as a
 * migration would (`seedPlatform`; the slug is reserved). The operator
 * signs up and verifies the address, and root adds the member row through
 * `addMember`. Then the operator signs in and turns TOTP on through the
 * enable flow. The sign-in comes after the grant: the guard gives no power
 * to a session from before it (ruling 50). The session is fresh: the
 * sign-in just set `freshAt`. `role: null` leaves the member row out;
 * `factor: false` leaves the factor off.
 */
export async function operatorFixture(
  options: { role?: string | null; factor?: boolean; config?: Partial<AuthConfig> } = {},
) {
  const auth = await operatorAuth(options.config);
  const { root, platformOrg } = await seedPlatform(auth);
  await signUpAndVerify(auth, OPERATOR_EMAIL, PASSWORD);
  const user = await auth.storage.findOne("user", [
    { field: "email", op: "eq", value: OPERATOR_EMAIL },
  ]);
  if (!user) throw new Error("no operator user");
  const role = options.role === undefined ? "operator" : options.role;
  if (role !== null) {
    const added = await addMember(auth.config, {
      user: root,
      organizationId: platformOrg.id,
      userId: user.id,
      role,
    });
    if (!added.ok) throw new Error(added.code);
  }
  const signedIn =
    options.factor === false
      ? await verifiedSession(auth, OPERATOR_EMAIL)
      : (await enrolled(auth, OPERATOR_EMAIL)).session;
  const operator = await sessionOf(auth, signedIn.token);
  return { auth, root, platformOrg, operator };
}

/** The resolved session of a token now, with the token. Throws when the session ended. */
export async function sessionOf(
  auth: OperatorAuth,
  token: string,
): Promise<ResolvedSession & { token: string }> {
  const resolved = await resolveSession(auth.config, token);
  if (!resolved) throw new Error("the session ended");
  return { ...resolved, token };
}

/**
 * The secret actor of a request with the named secret, as the routes build
 * it. The scopes come from the config, so the actor is one the product makes.
 */
export async function secretActor(auth: OperatorAuth, secret: string): Promise<OperatorActor> {
  const request = new Request(`${BASE_URL}/auth/operator/users/create-admin`, {
    method: "POST",
    headers: operatorHeader(secret),
  });
  const entry = await matchOperatorSecret(auth.config, request);
  if (!entry) throw new Error("no secret matched");
  return { kind: "secret", name: entry.name, scopes: entry.scopes };
}
