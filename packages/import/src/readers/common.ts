import type { ImportUser } from "../types.js";

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

/**
 * The offset of the first character that is not JSON, or -1 if the text
 * parses. It runs only after JSON.parse throws, to place the fault.
 */
export function jsonFaultOffset(text: string): number {
  const n = text.length;
  let i = 0;
  const ws = () => {
    while (i < n && " \t\n\r".includes(text.charAt(i))) i++;
  };
  const word = (w: string): boolean => {
    let k = 0;
    while (k < w.length && text.charAt(i + k) === w.charAt(k)) k++;
    i += k;
    return k === w.length;
  };
  const string = (): boolean => {
    i++;
    while (i < n) {
      const c = text.charAt(i);
      if (c === '"') {
        i++;
        return true;
      }
      if (text.charCodeAt(i) < 0x20) return false;
      if (c !== "\\") {
        i++;
        continue;
      }
      const e = text.charAt(i + 1);
      i++;
      if (e === "u") {
        i++;
        for (let k = 0; k < 4; k++, i++) if (!/[0-9a-fA-F]/.test(text.charAt(i))) return false;
      } else if (e !== "" && '"\\/bfnrt'.includes(e)) i++;
      else return false;
    }
    return false;
  };
  const digit = () => /[0-9]/.test(text.charAt(i));
  const digits = (): boolean => {
    if (!digit()) return false;
    while (digit()) i++;
    return true;
  };
  const number = (): boolean => {
    if (text.charAt(i) === "-") i++;
    if (text.charAt(i) === "0") i++;
    else if (!digits()) return false;
    if (text.charAt(i) === ".") {
      i++;
      if (!digits()) return false;
    }
    if (text.charAt(i) === "e" || text.charAt(i) === "E") {
      i++;
      if (text.charAt(i) === "+" || text.charAt(i) === "-") i++;
      if (!digits()) return false;
    }
    return true;
  };
  const value = (): boolean => {
    ws();
    const c = text.charAt(i);
    if (c === "{" || c === "[") {
      const close = c === "{" ? "}" : "]";
      i++;
      ws();
      if (text.charAt(i) === close) {
        i++;
        return true;
      }
      for (;;) {
        if (c === "{") {
          ws();
          if (text.charAt(i) !== '"' || !string()) return false;
          ws();
          if (text.charAt(i) !== ":") return false;
          i++;
        }
        if (!value()) return false;
        ws();
        if (text.charAt(i) === ",") i++;
        else if (text.charAt(i) === close) {
          i++;
          return true;
        } else return false;
      }
    }
    if (c === '"') return string();
    if (c === "t") return word("true");
    if (c === "f") return word("false");
    if (c === "n") return word("null");
    return number();
  };
  try {
    if (!value()) return i;
  } catch {
    // A nest deep enough to end the stack: no place to name.
    return -1;
  }
  ws();
  return i < n ? i : -1;
}

/**
 * JSON.parse with a fixed fault text. V8's own text quotes up to 20
 * characters of the input. An export path can name a secret file, such as
 * .env, so the text names the input key and the place only (plan 11e).
 */
export function parseJson(text: string, input: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    const at = jsonFaultOffset(text);
    if (at === -1) throw new Error(`authtempo import: the ${input} input is not JSON`);
    const before = text.slice(0, at).split("\n");
    const line = before.length;
    const column = (before.at(-1) ?? "").length + 1;
    throw new Error(
      `authtempo import: the ${input} input is not JSON (the fault is at line ${line}, column ${column})`,
    );
  }
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
        throw new Error(`authtempo import: line ${i + 1} is not JSON`);
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

/**
 * The provider name a reader gives an identity of the older LinkedIn API
 * (the `r_liteprofile` member id), as opposed to the OIDC `sub` that core's
 * LinkedIn preset answers. No id form tells the two apart, so the reader
 * decides by the export's provider key. The importer drops this name and
 * lists it as `identity:linkedin_legacy` (plan 9b2).
 */
export const LINKEDIN_LEGACY = "linkedin_legacy";

/**
 * The record for a user row with no provider id. It has no import key, so it
 * is skipped as `no_source_id`, a conflict (the CLI exits 1), and never
 * dropped in silence. `where` names the row, for example "csv row 3", so the
 * operator can find it: the sourceId is "(none) " plus `where`.
 */
export function noSourceIdUser(where: string): ImportUser {
  return {
    kind: "user",
    sourceId: `(none) ${where}`,
    email: null,
    emailVerified: false,
    name: null,
    image: null,
    createdAt: null,
    identities: [],
    password: null,
    passkeys: [],
    skip: "no_source_id",
  };
}
