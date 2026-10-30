/**
 * The capped body read of a fetch that core makes from a tenant's or a
 * client's input. Plan 12d moved it here from `oauth-clients.ts`, so the
 * client documents and the DNS proofs read a body by one rule.
 */

/** The body as text, or null past `max` bytes, on a read error, when `signal` aborts, or when it is not UTF-8. */
export async function readCapped(
  res: Response,
  max: number,
  signal: AbortSignal,
): Promise<string | null> {
  const bytes = await readCappedBytes(res, max, signal);
  if (bytes === null) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * The body as bytes, or null past `max` bytes, on a read error, when
 * `signal` aborts, or at a chunk that is not bytes. A caller that must tell
 * a long body from a body that is not UTF-8 decodes the bytes itself, as
 * the SCIM body read does.
 *
 * The read does not wait for a cancel. A body that is one branch of a tee,
 * such as a request that an app cloned, settles its cancel only when the
 * other branch ends too. A wait there never ends (ruling 43 of the 12j lane).
 *
 * `take`, when given, gets the bytes of each chunk before the read keeps
 * it. A false answer stops the read, which then answers null too. The
 * budget of the large request reads uses it (ruling 51 of the 12j lane).
 */
export async function readCappedBytes(
  res: Response,
  max: number,
  signal: AbortSignal,
  take?: (bytes: number) => boolean,
): Promise<Uint8Array | null> {
  const read = await readCappedOutcome(res, max, signal, take);
  return read instanceof Uint8Array ? read : null;
}

/**
 * Why a capped read gave no bytes: `cap` past `max` or at a false answer of
 * `take`, `chunk` at a chunk that is not a `Uint8Array`, and `error` at a
 * read error or an abort.
 */
export type CappedRefusal = "cap" | "chunk" | "error";

/**
 * The read of `readCappedBytes`, with the cause of a refusal in place of
 * null. A chunk that is not a `Uint8Array` cancels the read before any
 * count: a stream of strings has no `byteLength`, so it passed the cap and
 * turned the count of the budget into NaN (ruling 59 Low 1 of the 12j
 * lane). The body read of a request answers it as a bad body.
 */
export async function readCappedOutcome(
  res: Response,
  max: number,
  signal: AbortSignal,
  take?: (bytes: number) => boolean,
): Promise<Uint8Array | CappedRefusal> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > max) {
    res.body?.cancel().catch(() => {});
    return "cap";
  }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const aborted = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) reject(new Error("aborted"));
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
  // A rejection after the read ended has no reader: it must not count as unhandled.
  aborted.catch(() => {});
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      if (!((value as unknown) instanceof Uint8Array)) {
        reader.cancel().catch(() => {});
        return "chunk";
      }
      total += value.byteLength;
      if (total > max || (take !== undefined && !take(value.byteLength))) {
        reader.cancel().catch(() => {});
        return "cap";
      }
      chunks.push(value);
    }
  } catch {
    reader.cancel().catch(() => {});
    return "error";
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}
