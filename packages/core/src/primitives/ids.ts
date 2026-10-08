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
