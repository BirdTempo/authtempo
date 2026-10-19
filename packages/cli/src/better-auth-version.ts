import type { Ctx } from "./output.js";

/**
 * Better Auth 1.7.7 fixed a magic link takeover (the Better Auth changelog,
 * read 2026-10-14; the review of 2026-10-14, row f19). During the move
 * window the old system is the rollback target, so a fault in it stays open.
 */
export const BETTER_AUTH_FIXED: readonly [1, 7, 7] = [1, 7, 7];

const FIXED_TEXT = BETTER_AUTH_FIXED.join(".");

/** A version as npm writes it: three numbers, then a prerelease part, then a build part. */
const VERSION = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

/** The three parts in numeric order: below 0 under `fixed`, 0 equal, above 0 over it. */
function order(parts: readonly number[], fixed: readonly number[]): number {
  for (const [i, f] of fixed.entries()) {
    const p = parts[i] ?? 0;
    if (p !== f) return p - f;
  }
  return 0;
}

/** True when `version` is below the fix; null when the text is no version. */
function below(version: string): boolean | null {
  const m = VERSION.exec(version);
  if (!m) return null;
  const parts = [Number(m[1]), Number(m[2]), Number(m[3])];
  const o = order(parts, BETTER_AUTH_FIXED);
  if (o !== 0) return o < 0;
  // A prerelease of the fixed version, such as 1.7.7-beta.1, is below it.
  if (m[4] !== undefined) return true;
  return false;
}

/**
 * The warning of `authtempo migrate --tables compat` (spec 23 item 12). It
 * reads node_modules/better-auth/package.json of the project folder `dir`.
 * No file: null. A file it cannot read or parse, or a version it cannot
 * read: the "cannot read" line. The alias of the compatibility package, or
 * another package under that name: null. `better-auth` below the fix: the
 * "below" line. Else null. The module imports no Node module, so a test
 * runs it on a memory io.
 */
export function betterAuthWarning(
  ctx: Pick<Ctx, "exists" | "readFile">,
  dir: string,
): string | null {
  const path = `${dir}/node_modules/better-auth/package.json`;
  const unreadable = `warning: cannot read the version of better-auth in ${path}; upgrade Better Auth to ${FIXED_TEXT} or later before the move`;
  let pkg: unknown;
  try {
    // An io that refuses the path, such as the confined io of the MCP
    // server on a link outside its root, throws here: the version is unread.
    if (!ctx.exists(path)) return null;
    pkg = JSON.parse(ctx.readFile(path));
  } catch {
    return unreadable;
  }
  if (typeof pkg !== "object" || pkg === null) return unreadable;
  const { name, version } = pkg as { name?: unknown; version?: unknown };
  if (name !== "better-auth") return null;
  if (typeof version !== "string") return unreadable;
  const low = below(version);
  if (low === null) return unreadable;
  if (!low) return null;
  return `warning: better-auth ${version} is below ${FIXED_TEXT}, which fixed a magic link takeover; upgrade it before the move, because the old system stays the rollback target`;
}
