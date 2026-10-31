/**
 * True when a key or a string value anywhere in a parsed body holds a NUL or
 * a lone surrogate (plan 12g fix wave, m1). The storage port refuses both in
 * a where value (rulings 16 and 17 of the 12g lane). So each body reader
 * refuses them first, and a route answers its refusal, not 500. The walk
 * uses a stack, so a deep body cannot overflow the call stack.
 *
 * The readers are readJson and readBody (json.ts, body.ts), and the OAuth
 * readObject and formParams (routes/oauth.ts). Plan 12i adds
 * readOptionalJson (json.ts) for the passkey options. The operator
 * readRewrapBody and readStopBody (routes/operator.ts) read through it.
 * Plan 12d adds the SCIM body (readScimBody, routes/scim.ts), the SAML form
 * of the ACS, and the query of the SSO manager reads (acsForm and
 * readQuery, routes/sso.ts).
 * One helper holds the rule, so the readers cannot drift.
 */
export function holdsBadText(raw: unknown): boolean {
  // The stack holds only arrays and objects. A string is checked where the
  // walk meets it, and an array is walked by index (ruling 46 of the 12j
  // lane): Object.entries made a pair for each of 4 million elements, and
  // a body of 8 MiB then took more than 512 MB.
  if (typeof raw !== "object" || raw === null) return badText(raw);
  const stack: object[] = [raw];
  while (stack.length > 0) {
    const value = stack.pop() as object;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) if (visit(value[i], stack)) return true;
    } else {
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        if (badText(key) || visit((value as Record<string, unknown>)[key], stack)) return true;
      }
    }
  }
  return false;
}

/** True for a string with a NUL or a lone surrogate. */
function badText(value: unknown): boolean {
  return typeof value === "string" && (value.includes("\u0000") || /\p{Cs}/u.test(value));
}

/** Checks a string at once, and puts an array or an object on the stack. */
function visit(value: unknown, stack: object[]): boolean {
  if (typeof value === "object" && value !== null) stack.push(value);
  return badText(value);
}
