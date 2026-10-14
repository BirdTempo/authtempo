#!/usr/bin/env node
import { ALIAS_LINES, nodeImportIo, runCli, scrubbedIo } from "../commands/import-alias.js";

const argv = process.argv.slice(2);
// Every line of the alias, also the line of an error that runCli throws, passes the scrub.
const io = scrubbedIo(argv, nodeImportIo);
// The deprecation lines print here, not in runCli, so runCli keeps the old
// contract word for word (spec 19, owner decision 4).
console.error(ALIAS_LINES.renamed);
if (argv.some((a) => a === "--postgres" || a.startsWith("--postgres=")))
  console.error(ALIAS_LINES.postgres);
runCli(argv, io).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    io.err(e instanceof Error ? e.message : String(e));
    process.exitCode = 2;
  },
);
