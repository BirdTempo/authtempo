import type { SourceName } from "./types.js";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * The id of an imported user or organization: 26 Crockford base32
 * characters, the length and alphabet of core's `newId`, taken from
 * SHA-256 of the kind, the source, and the source's id. The same record
 * gets the same id on every run, so a second run finds it and writes
 * nothing. The id does not sort by time. Core sorts lists by a field first
 * and uses the id only to break a tie (spec 6), so no core path needs that.
 */
export async function importId(
  kind: "user" | "organization",
  source: SourceName,
  sourceId: string,
): Promise<string> {
  const text = `tempo-auth-import\u001f${kind}\u001f${source}\u001f${sourceId}`;
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );
  let out = "";
  for (let i = 0; i < 26; i++) out += CROCKFORD[(digest[i] ?? 0) % 32];
  return out;
}
