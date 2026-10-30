import { nearest } from "./args.js";
import type { Command } from "./command.js";
import { auditCommand } from "./commands/audit.js";
import { checkCommand } from "./commands/check.js";
import { createAdminCommand } from "./commands/create-admin.js";
import { generateCommand } from "./commands/generate.js";
import { importCommand } from "./commands/import.js";
import { infoCommand } from "./commands/info.js";
import { initCommand } from "./commands/init.js";
import { keysCommand } from "./commands/keys.js";
import { mcpCommand } from "./commands/mcp.js";
import { migrateCommand } from "./commands/migrate.js";
import { secretCommand } from "./commands/secret.js";
import { sessionsCommand } from "./commands/sessions.js";
import { upgradeCommand } from "./commands/upgrade.js";
import { usersCommand } from "./commands/users.js";
import { UsageError } from "./errors.js";
import { ROOT_HELP } from "./help/authtempo.js";
import { type HelpText, renderHelp, shortHelp } from "./help/types.js";
import type { Io } from "./io.js";
import { STOP_JSON, type VersionJson } from "./json.js";
import { type Ctx, guarded, printJson } from "./output.js";
import { CLI_VERSION, SCHEMA_VERSION } from "./version.js";

/** The command table (spec 19), in the order of the root help. */
export const COMMANDS: Readonly<Record<string, Command>> = {
  init: initCommand,
  migrate: migrateCommand,
  import: importCommand,
  check: checkCommand,
  keys: keysCommand,
  mcp: mcpCommand,
  secret: secretCommand,
  info: infoCommand,
  users: usersCommand,
  sessions: sessionsCommand,
  audit: auditCommand,
  "create-admin": createAdminCommand,
  generate: generateCommand,
  upgrade: upgradeCommand,
};

/**
 * The help of `<command> [<sub>]`, and its key in `STOP_JSON` (plan 11c2).
 * When `rest[0]` is an own key of the command's subcommands, the answer is
 * that subcommand's help and the key `<name> <sub>`. Else the answer is the
 * command's own help and the key `<name>`. `name` is the key of the table:
 * the help's `command` can differ from it, as `keys rotate` does.
 */
export function helpOf(
  name: string,
  command: Command,
  rest: readonly string[],
): { key: string; help: HelpText } {
  const sub = rest[0];
  const entry =
    sub !== undefined &&
    command.subcommands !== undefined &&
    Object.hasOwn(command.subcommands, sub)
      ? command.subcommands[sub]
      : undefined;
  if (entry) return { key: `${name} ${sub}`, help: entry.help };
  return { key: name, help: command.help };
}

/**
 * The stop document of `--json` (plan 11e deviation 19): the empty shape of
 * the command, exit 2, and the reason. A name with no shape prints nothing.
 */
function printStop(ctx: Ctx, name: string, reason: string): void {
  if (!Object.hasOwn(STOP_JSON, name)) return;
  const shape = STOP_JSON[name as keyof typeof STOP_JSON];
  printJson(ctx, { ...shape, exit: 2, stopped: reason });
}

/**
 * The program (spec 19) over a command table: `--version`, `help`, the
 * commands, and the exit codes. A usage error prints the short help of its
 * command or subcommand and exits 2; any other error prints one `stopped:`
 * line and exits 2. With `--json`, both also print the stop document on
 * stdout. Every line passes the scrub of `guarded`. The tests build a
 * program over a table of their own; `main` is the program over `COMMANDS`.
 */
export function makeMain(
  commands: Readonly<Record<string, Command>>,
): (argv: readonly string[], io: Io) => Promise<number> {
  /** A command by its name; `constructor` and the other names of Object.prototype are no command. */
  const lookup = (name: string): Command | undefined =>
    Object.hasOwn(commands, name) ? commands[name] : undefined;

  const rootHelp = (): HelpText => ({
    ...ROOT_HELP,
    commands: Object.values(commands).map((c) => ({ name: c.help.command, says: c.help.purpose })),
  });

  const unknown = (ctx: Ctx, name: string): 2 => {
    const near = nearest(name, Object.keys(commands));
    ctx.err(near ? `unknown command ${name}. Did you mean ${near}?` : `unknown command ${name}`);
    ctx.err("Run authtempo --help");
    return 2;
  };

  return async (argv, io) => {
    const ctx = guarded(io);
    const [first, ...rest] = argv;
    if (first === undefined) {
      for (const line of shortHelp(ROOT_HELP)) ctx.err(line);
      return 2;
    }
    if (first === "--help" || first === "-h") {
      for (const line of renderHelp(rootHelp())) ctx.out(line);
      return 0;
    }
    if (first === "--version") {
      if (rest.includes("--json"))
        printJson(ctx, { cli: CLI_VERSION, schemaVersion: SCHEMA_VERSION } satisfies VersionJson);
      else ctx.out(`authtempo ${CLI_VERSION} (schema version ${SCHEMA_VERSION})`);
      return 0;
    }
    if (first === "help") {
      const name = rest[0];
      if (name === undefined) {
        for (const line of renderHelp(rootHelp())) ctx.out(line);
        return 0;
      }
      const c = lookup(name);
      if (!c) return unknown(ctx, name);
      for (const line of renderHelp(helpOf(name, c, rest.slice(1)).help)) ctx.out(line);
      return 0;
    }
    const command = lookup(first);
    if (!command) return unknown(ctx, first);
    const { key, help } = helpOf(first, command, rest);
    if (rest.includes("--help") || rest.includes("-h")) {
      for (const line of renderHelp(help)) ctx.out(line);
      return 0;
    }
    // A command that returns 2 with no throw prints its own document; only a throw gets this one.
    const json = rest.includes("--json");
    try {
      return await command.run([...rest], ctx);
    } catch (e) {
      let reason: string;
      if (e instanceof UsageError) {
        ctx.err(e.message);
        // Every usage line of the command: migrate has one line for each target.
        const [first, ...tail] = shortHelp(help);
        const usage = help.usage.map((u) => `Usage: ${u}`);
        for (const line of [...(usage.length > 0 ? usage : [first ?? ""]), ...tail]) ctx.err(line);
        // The reason is the first stderr line: the message of the usage error.
        reason = e.message.split("\n")[0] ?? "";
      } else {
        reason = e instanceof Error ? e.message : String(e);
        ctx.err(`stopped: ${reason}`);
      }
      if (json) printStop(ctx, key, reason);
      return 2;
    }
  };
}

/** The program over the command table (spec 19). The binary and the MCP server call it. */
export const main = makeMain(COMMANDS);
