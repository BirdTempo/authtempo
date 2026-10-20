import {
  type Auth,
  createAuth,
  type MailPort,
  type OperatorAuditRow,
  type StorageAdapter,
} from "@authtempo/core";

/** The jobs of the operator secrets, and the copy of the audit rows. The host gives each value. */
export interface OperatorSetup {
  /** The SHA-256 of each secret, as `authtempo secret --operator` prints it. Never the secret. */
  supportHash: string;
  incidentHash: string;
  /** Sends one audit row to a system that the app's database cannot change. */
  copy: (row: OperatorAuditRow) => Promise<void>;
}

/**
 * The user tools on. With no setup, only the platform operators and the app
 * act. With a setup, each job gets its own named secret, and each audit row
 * gets a copy.
 */
export function createOperatorAuth(
  deps: { storage: StorageAdapter; mail: MailPort; secret: string },
  setup?: OperatorSetup,
) {
  return createAuth({
    baseURL: "https://api.example.com",
    trustedOrigins: [],
    secret: deps.secret,
    storage: deps.storage,
    mail: deps.mail,
    // A platform operator is a user with the role `admin` in the organization `staff`.
    organizations: { platformOrganization: "staff", platformRole: "admin" },
    operator: {
      users: true,
      ...(setup && {
        secrets: [
          // The support desk reads and bans users, and reads the audit table.
          { name: "support", secretHash: setup.supportHash, scopes: ["users", "audit"] },
          // The incident script ends sessions, and does nothing else.
          { name: "incident", secretHash: setup.incidentHash, scopes: ["sessions"] },
        ],
      }),
    },
    ...(setup && {
      hooks: {
        operator: {
          // After the commit, once per row. A person with write access to the database can change the table.
          afterAction: ({ audit }) => setup.copy(audit),
        },
      },
    }),
  });
}

/**
 * The actor of the app's admin page. Each audit row names it. Core trusts an
 * app actor, so the app checks its own staff and counts its own limit first.
 */
export const ADMIN_ACTOR = { kind: "app", name: "admin-page" } as const;

/**
 * The app's admin route: POST with the JSON body `{ userId, reason }`.
 * `isStaff` is the app's own check of the person who calls it.
 */
export async function adminBan(
  auth: Auth,
  request: Request,
  isStaff: (request: Request) => Promise<boolean>,
): Promise<Response> {
  if (!(await isStaff(request))) return Response.json({ error: "forbidden" }, { status: 403 });
  const body: unknown = await request.json().catch(() => null);
  const { userId, reason } = (body ?? {}) as { userId?: unknown; reason?: unknown };
  if (typeof userId !== "string" || typeof reason !== "string")
    return Response.json({ error: "invalid_body" }, { status: 400 });
  const banned = await auth.api.operator.users.ban({
    actor: ADMIN_ACTOR,
    userId,
    reason,
    // The staff member's address and browser, never the user's. Off Workers, pass the IP of your host.
    ip: request.headers.get("cf-connecting-ip"),
    userAgent: request.headers.get("user-agent"),
  });
  if (!banned.ok) return Response.json({ error: banned.code }, { status: banned.status });
  return Response.json({ auditId: banned.value.auditId });
}

/** The audit rows of one user, oldest first, for the admin page. */
export async function adminAudit(auth: Auth, userId: string) {
  const page = await auth.api.operator.audit.list({ actor: ADMIN_ACTOR, targetUserId: userId });
  return page.ok ? page.value.rows : [];
}
