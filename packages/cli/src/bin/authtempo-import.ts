#!/usr/bin/env node
import { ALIAS_LINES, nodeImportIo, runCli } from "../commands/import-alias.js";

const argv = process.argv.slice(2);
// The deprecation lines print here, not in runCli, so runCli keeps the old
// contract word for word (spec 19, owner decision 4).
console.error(ALIAS_LINES.renamed);
if (argv.some((a) => a === "--postgres" || a.startsWith("--postgres=")))
  console.error(ALIAS_LINES.postgres);
runCli(argv, nodeImportIo).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 2;
  },
);
