import { UsageError } from "../errors.js";

// The argument rules of `authtempo import verify` (owner decision 3 of
// 2026-10-14). The subcommand reads only, so the flags that write or that
// say so are usage errors.

/** The first positional `verify` names the subcommand; the rest is the provider and its files. */
export function splitVerify(positionals: readonly string[]): { verify: boolean; rest: string[] } {
  return positionals[0] === "verify"
    ? { verify: true, rest: positionals.slice(1) }
    : { verify: false, rest: [...positionals] };
}

/**
 * The flags that `import verify` refuses: `--repair` writes, `--dry-run`
 * says what the subcommand always does, and `--target memory` holds no
 * records to check against. A verify needs a database, so no target is the
 * same usage error as the memory target. `--on-email-taken fail` would stop
 * at the first conflict with no count, where the verify counts each one as
 * a record that needs a person (spec 23 item 7).
 */
export function checkVerifyFlags(v: {
  repair?: boolean | undefined;
  "dry-run"?: boolean | undefined;
  "on-email-taken"?: string | undefined;
  target?: string | undefined;
}): void {
  if (v.repair === true) throw new UsageError("import verify reads only; it takes no --repair");
  if (v["dry-run"] === true)
    throw new UsageError("import verify always reads only; it takes no --dry-run");
  if (v["on-email-taken"] !== undefined)
    throw new UsageError("import verify counts each conflict; it takes no --on-email-taken");
  if (v.target === undefined || v.target === "memory")
    throw new UsageError("import verify needs a database: --target postgres or --target d1-bundle");
}
