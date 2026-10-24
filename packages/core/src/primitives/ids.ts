const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A ULID: 10 chars of time, 16 chars of randomness. Sorts by creation time. */
export function newId(now: Date): string {
  let ms = now.getTime();
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[ms % 32] + time;
    ms = Math.floor(ms / 32);
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let rand = "";
  for (let i = 0; i < 16; i++) rand += CROCKFORD[(bytes[i] ?? 0) % 32];
  return time + rand;
}

/**
 * The time in the first 10 chars of a ULID of `newId`, in ms, or null when
 * `id` does not start with 10 chars of the Crockford alphabet.
 */
export function idTime(id: string): number | null {
  let ms = 0;
  for (const c of id.slice(0, 10)) {
    const digit = CROCKFORD.indexOf(c);
    if (digit < 0) return null;
    ms = ms * 32 + digit;
  }
  return id.length >= 10 ? ms : null;
}

/** The last id of `newMonotonicId` in this isolate, or "" before the first. */
let lastMonotonic = "";

/** The id plus 1, with the carry of the last char into the char before it. */
function increment(id: string): string {
  const chars = id.split("");
  for (let i = chars.length - 1; i >= 0; i--) {
    const digit = CROCKFORD.indexOf(chars[i] ?? "");
    if (digit < 31) {
      chars[i] = CROCKFORD[digit + 1] ?? "";
      return chars.join("");
    }
    chars[i] = "0";
  }
  throw new Error("authtempo: the monotonic id has no next value");
}

/**
 * A monotonic ULID (the ULID spec, section "Monotonicity"). In a later
 * millisecond it is a new `newId`. In the same millisecond as the last id
 * of this isolate, it is the last id plus 1. When the clock goes back, it
 * is the last id plus 1 too, so each id of one isolate sorts after the one
 * before it. The ids of two isolates in one millisecond have no defined
 * order between them.
 *
 * Only the audit rows use it (ruling 58 Q4 of plan 12f). The audit list
 * reads them in id order, and a record lists in the order it happened.
 * The other tables keep `newId`. A monotonic id tells its neighbor: from
 * one session, handoff, or verification id, the next id of that millisecond
 * is the id plus 1. Those ids reach the client, and an audit id reaches
 * only an operator.
 */
export function newMonotonicId(now: Date): string {
  const fresh = newId(now);
  const next = fresh.slice(0, 10) > lastMonotonic.slice(0, 10) ? fresh : increment(lastMonotonic);
  lastMonotonic = next;
  return next;
}
