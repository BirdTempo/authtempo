/**
 * The Better Auth versions whose API this package answers (spec 33 item 1.6).
 * A new Better Auth minor gets a compat change in an authtempo minor; the
 * range never changes in a patch. package.json holds the same value in
 * `authtempo.betterAuth`, and a test holds the two equal.
 *
 * The range starts at 1.7.7, not 1.7.0 (ruling 45 of plan 12j, a plan
 * deviation): GHSA-965c-763c-88jm affects each version below 1.7.7, and the
 * rollback system must run 1.7.7 or later. The shim was read on the 1.7.2
 * shapes and on the API key plugin of 1.7.5.
 */
export const BETTER_AUTH_RANGE = ">=1.7.7 <1.8.0";

/** A plain release version: three numbers and no prerelease or build part. */
const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
/** The one range form this package reads: `>=a.b.c <d.e.f`. */
const RANGE = /^>=(\d+\.\d+\.\d+) <(\d+\.\d+\.\d+)$/;

function parts(version: string): [number, number, number] | null {
  const m = VERSION.exec(version);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Below 0 when `a` is below `b`, 0 when equal, above 0 when above. */
function compare(a: readonly number[], b: readonly number[]): number {
  for (const [i, x] of a.entries()) {
    const y = b[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/**
 * True when `version` is inside `range`. The grammar is closed: a range of
 * another form throws. A prerelease or a version that is not three numbers is
 * outside every range, so 1.7.7-beta.1 is not a supported version.
 */
export function inRange(version: string, range: string): boolean {
  const r = RANGE.exec(range);
  const low = r?.[1] === undefined ? null : parts(r[1]);
  const high = r?.[2] === undefined ? null : parts(r[2]);
  if (low === null || high === null)
    throw new Error(`the range ${range} is not of the form >=a.b.c <d.e.f`);
  const v = parts(version);
  if (v === null) return false;
  return compare(v, low) >= 0 && compare(v, high) < 0;
}
