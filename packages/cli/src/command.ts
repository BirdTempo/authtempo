import type { HelpText } from "./help/types.js";
import type { Ctx } from "./output.js";

/** One command of the table in main.ts (spec 19). */
export interface Command {
  help: HelpText;
  /**
   * The parseArgs options of the command. The common test holds the help's
   * flag list to these names, checks that no flag takes a secret, and holds
   * each short form to -h for --help or -n for --dry-run (spec 19).
   */
  options: Readonly<
    Record<string, { readonly type: "string" | "boolean"; readonly short?: string }>
  >;
  /**
   * The subcommands of the command, by their word (plan 11c2): `status` and
   * `rewrap` of `secret`. Each has its own help and its own parser options,
   * because the common test holds each help's flag list to the names of its
   * parser. `main` prints a subcommand's help for `<command> <sub> --help`
   * and its usage on a usage error; `run` parses the subcommand itself.
   */
  subcommands?: Readonly<Record<string, { help: HelpText; options: Command["options"] }>>;
  /** The arguments after the command's name. Answers the exit code. */
  run(argv: string[], ctx: Ctx): Promise<number>;
}
