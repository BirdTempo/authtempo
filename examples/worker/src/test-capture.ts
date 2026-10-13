/**
 * The TEST_MODE code capture of the example Worker (plan 9e; bounded by plan
 * 9h). The example has no mail transport, so it keeps the last code per
 * address for the end-to-end test. An isolate lives on between requests, so
 * the map has a bound: at most `max` addresses, and the oldest write goes
 * first. 100 is far above the addresses of one test run (each test uses its
 * own few) and keeps the map small in a long `wrangler dev` session.
 */
export const CAPTURE_MAX = 100;

export function rememberCode(
  codes: Map<string, string>,
  to: string,
  code: string | null,
  max = CAPTURE_MAX,
): void {
  // A delete before the set moves the address to the newest place: a Map
  // keeps the order of the first insert.
  codes.delete(to);
  if (code === null) return;
  codes.set(to, code);
  while (codes.size > max) {
    const oldest = codes.keys().next();
    if (oldest.done) break;
    codes.delete(oldest.value);
  }
}
