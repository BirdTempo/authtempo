import type { HelpText } from "./help/types.js";
import type { Ctx } from "./output.js";

/** One command of the table in main.ts (spec 19). */
export interface Command {
  help: HelpText;
  /**
   * The parseArgs options of the command. The common test holds the help's
   * flag list to these names, and checks that no flag takes a secret.
   */
  options: Readonly<Record<string, { readonly type: "string" | "boolean" }>>;
  /** The arguments after the command's name. Answers the exit code. */
  run(argv: string[], ctx: Ctx): Promise<number>;
}
