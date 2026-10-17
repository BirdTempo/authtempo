import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A server root in a temp folder, with a link to a second folder outside it. */
export interface FixtureRoot {
  /** The temp folder that holds the root and the outside folder, and nothing else. */
  base: string;
  /** The server root. root/link is a symbolic link to `outside`. */
  root: string;
  /** A folder outside the root. */
  outside: string;
  /** Each name under base and outside, so a test can show that nothing new is there. */
  around(): { base: string[]; outside: string[] };
  remove(): void;
}

/**
 * Makes base/root and base/outside, and the link root/link to base/outside.
 * Each path has its links resolved, as the server resolves its root at the start.
 */
export function fixtureRoot(): FixtureRoot {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "authtempo-mcp-root-")));
  const root = join(base, "root");
  const outside = join(base, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  symlinkSync(outside, join(root, "link"));
  return {
    base,
    root,
    outside,
    around: () => ({
      base: readdirSync(base).sort(),
      outside: readdirSync(outside, { recursive: true }).map(String).sort(),
    }),
    remove: () => rmSync(base, { recursive: true, force: true }),
  };
}
