import { parseArgs } from "node:util";
import { parseOrUsage } from "../args.js";
import type { Command } from "../command.js";
import { Stop, UsageError } from "../errors.js";
import { CREATE_ADMIN_HELP } from "../help/create-admin.js";
import type { CreateAdminJson } from "../json.js";
import { readOperatorSecret } from "../operator-client.js";
import { ask, needYes, reasonOf, toolCall, toolTarget, WRITE_OPTIONS } from "../operator-tools.js";
import { type Ctx, printJson } from "../output.js";

const OPTIONS = {
  ...WRITE_OPTIONS,
  email: { type: "string" },
  name: { type: "string" },
} as const;

/** The last stderr line of a run: the new operator has no power yet (spec 26 item 11). */
export const CREATE_ADMIN_NEXT =
  "Next: sign in with a mailed link or code at this address, then turn a second factor on. Until then the account has no operator power.";

/** The answer of the create-admin route, or null when the body is not one. */
function createAnswer(body: unknown): { userId: string; created: boolean; auditId: string } | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.userId !== "string" || typeof b.created !== "boolean") return null;
  if (typeof b.auditId !== "string") return null;
  return { userId: b.userId, created: b.created, auditId: b.auditId };
}

/**
 * `authtempo create-admin <base url> --email <address>` (plan 12f Task 12,
 * spec 26 item 11). One transaction of the route makes the member row. It
 * also makes the platform organization when it is absent. It makes the user
 * when no user holds the address, with no verified address and no password.
 * The user id goes to stdout. No stderr line, and so no question, names the
 * address.
 */
async function run(argv: string[], ctx: Ctx): Promise<number> {
  const { values, positionals } = parseOrUsage(
    () => parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true }),
    Object.keys(OPTIONS),
  );
  const [target, ...extra] = positionals;
  if (extra.length > 0) throw new UsageError(`unexpected argument ${extra[0]}`);
  const t = toolTarget(target, values);
  if (values.email === undefined) throw new UsageError("give --email <address> of the operator");
  const reason = reasonOf(values.reason);
  needYes(ctx, values, "create-admin");
  const secret = readOperatorSecret(ctx, values);
  const path = "/operator/users/create-admin";
  ctx.err(`posting ${t.base}${t.basePath}${path}`);
  await ask(ctx, values, "Make the user of the given address a platform operator?", "operator");
  const body = await toolCall(
    ctx,
    { ...t, secret },
    {
      path,
      method: "POST",
      body: {
        email: values.email,
        ...(values.name === undefined ? {} : { name: values.name }),
        reason,
      },
      scope: "users",
      invalid:
        "--email must be an address, and --name 1 to 200 characters with no control character",
    },
  );
  const answer = createAnswer(body);
  if (answer === null)
    throw new Stop(`POST ${t.base}${t.basePath}${path} answered 200 with no create-admin answer`);
  if (values.json === true)
    printJson(ctx, { ...answer, exit: 0, stopped: null } satisfies CreateAdminJson);
  else ctx.out(answer.userId);
  ctx.err(
    answer.created
      ? `made a new user and gave it the platform role; audit row ${answer.auditId}`
      : `the address had a user: gave it the platform role; audit row ${answer.auditId}`,
  );
  ctx.err(CREATE_ADMIN_NEXT);
  return 0;
}

/** `authtempo create-admin` (plan 12f Task 12): one command, no subcommand. */
export const createAdminCommand: Command = {
  help: CREATE_ADMIN_HELP,
  options: OPTIONS,
  run,
};
