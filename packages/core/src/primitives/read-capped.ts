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
 * The body as bytes, or null past `max` bytes, on a read error, or when
 * `signal` aborts. A caller that must tell a long body from a body that is
 * not UTF-8 decodes the bytes itself, as the SCIM body read does.
 *
 * The read does not wait for a cancel. A body that is one branch of a tee,
 * such as a request that an app cloned, settles its cancel only when the
 * other branch ends too. A wait there never ends (ruling 43 of the 12j lane).
 */
export async function readCappedBytes(
  res: Response,
  max: number,
  signal: AbortSignal,
): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > max) {
    res.body?.cancel().catch(() => {});
    return null;
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
      total += value.byteLength;
      if (total > max) {
        reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch {
    reader.cancel().catch(() => {});
    return null;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}
