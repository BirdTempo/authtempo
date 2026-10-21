/**
 * True when a key or a string value anywhere in a parsed body holds a NUL or
 * a lone surrogate (plan 12g fix wave, m1). The storage port refuses both in
 * a where value (rulings 16 and 17 of the 12g lane). So each body reader
 * refuses them first, and a route answers its refusal, not 500. The walk
 * uses a stack, so a deep body cannot overflow the call stack.
 *
 * The readers are readJson and readBody (json.ts, body.ts) and the OAuth
 * readObject and formParams (routes/oauth.ts). One helper holds the rule,
 * so the readers cannot drift.
 */
export function holdsBadText(raw: unknown): boolean {
  const stack: unknown[] = [raw];
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value === "string") {
      if (value.includes("\u0000") || /\p{Cs}/u.test(value)) return true;
    } else if (typeof value === "object" && value !== null) {
      for (const [key, item] of Object.entries(value)) stack.push(key, item);
    }
  }
  return false;
}
