import { COMMON_FLAGS, type HelpText } from "./types.js";

export const GENERATE_HELP: HelpText = {
  command: "generate",
  page: "generate",
  purpose:
    "Print the schema of the authtempo tables as SQL, as a Drizzle schema, or as Prisma models. The command reads no database, no config, no variable, and no network.",
  usage: [
    "authtempo generate --format <sql|drizzle|prisma> --dialect <sqlite|postgres|mysql> [--out <file>]",
  ],
  examples: [
    {
      line: "authtempo generate --format sql --dialect postgres",
      says: "Print the SQL that makes the tables on an empty Postgres database.",
    },
    {
      line: "authtempo generate --format drizzle --dialect sqlite --out src/authtempo-schema.ts",
      says: "Write a Drizzle schema for the reads of an app on SQLite to a new file.",
    },
    {
      line: "authtempo generate --format prisma --dialect mysql",
      says: "Print the Prisma models of the tables on MySQL.",
    },
  ],
  flags: [
    {
      flag: "--format <sql|drizzle|prisma>",
      says: "The form of the output. It has no default.",
    },
    {
      flag: "--dialect <sqlite|postgres|mysql>",
      says: "The database of the output. It has no default. A D1 app applies the files of @authtempo/adapter-d1 with wrangler.",
    },
    {
      flag: "--out <file>",
      says: "Write the output to a new file. The command writes no file over a file.",
    },
    ...COMMON_FLAGS,
  ],
  exits: [
    { code: 0, says: "The output is printed or written." },
    { code: 2, says: "A usage error, or the file of --out exists." },
  ],
};
