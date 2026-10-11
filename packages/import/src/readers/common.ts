/** Postgres text output of a timestamptz, `2024-01-15 10:30:00.123456+00`, or ISO 8601. Null when empty or unreadable. */
export function parseTime(text: string | null | undefined): Date | null {
  if (!text) return null;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}(?::?\d{2})?)$/.exec(
    text.trim(),
  );
  if (!m) return null;
  let tz = m[4] ?? "Z";
  if (tz !== "Z")
    tz = tz.length === 3 ? `${tz}:00` : tz.length === 5 ? `${tz.slice(0, 3)}:${tz.slice(3)}` : tz;
  const d = new Date(`${m[1]}T${m[2]}${(m[3] ?? "").slice(0, 4)}${tz}`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Milliseconds since the epoch, as a number or a digit string. Null otherwise. */
export function parseMillis(v: unknown): Date | null {
  const n =
    typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : Number.NaN;
  if (!Number.isFinite(n)) return null;
  const d = new Date(n);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** One JSON value per non-empty line. */
export function ndjson(text: string): unknown[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l, i) => {
      try {
        return JSON.parse(l) as unknown;
      } catch {
        throw new Error(`tempo-auth import: line ${i + 1} is not JSON`);
      }
    });
}

export function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Standard base64 to base64url with no padding, the form core stores a passkey in. */
export function toBase64Url(b64: string): string {
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

export function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
