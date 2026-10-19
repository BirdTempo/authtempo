import { DATABASE_FLAGS } from "./check.js";
import { OPERATOR_FLAGS } from "./keys.js";
import { COMMON_FLAGS, type HelpText } from "./types.js";

export const INFO_HELP: HelpText = {
  command: "info",
  page: "info",
  purpose:
    "Print a support report: the tools, the project, the database, and the deployment. The report holds no secret value and no host name.",
  usage: ["authtempo info [<base url>] [--target <d1|postgres> and its inputs]"],
  examples: [
    { line: "authtempo info", says: "Report the tools and the project, and make no network call." },
    {
      line: "authtempo info --target postgres",
      says: "Also report the schema version of the database in DATABASE_URL.",
    },
    {
      line: "authtempo info https://api.example.com",
      says: "Also report the version and the config keys of the deployment.",
    },
  ],
  flags: [
    {
      flag: "--target <d1|postgres>",
      says: "Read this kind of database. Without it, the report has no database part.",
    },
    ...DATABASE_FLAGS,
    ...OPERATOR_FLAGS,
    ...COMMON_FLAGS,
  ],
  exits: [
    { code: 0, says: "Each part that a flag asked for answered." },
    {
      code: 1,
      says: "A part that a flag asked for gave no answer. The report names the part and the reason.",
    },
    { code: 2, says: "A usage error, or a stop before the report." },
  ],
};
