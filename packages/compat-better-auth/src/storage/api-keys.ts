import {
  type ApiTokenRow,
  newId,
  type OrganizationTokenRow,
  type StorageAdapter,
  validMetadata,
  validTokenName,
} from "@authtempo/core";
import { CORE_STATEMENTS } from "@authtempo/core/access";
import { BetterAuthCompatError } from "../compat-error.js";
import { toCoreNames } from "../role-map.js";
import type { D1SchemaStorage, PostgresSchemaStorage } from "./index.js";
import type { Names } from "./names.js";
import { rawReadOf } from "./raw.js";

// Plan 12k Task 12 (owner decision 4, rulings 2 and 4): the move of Better
// Auth's apikey rows into core's token tables. The rules of the stored row
// were read in @better-auth/api-key 1.7.5 (dist/index.mjs and
// dist/types-y22rgFHR.d.mts) on 2026-10-21.

/** What the move did or would do. Counts, row and owner ids, and prefixes only: never a key, a digest, or metadata. */
export interface ApiKeyMoveReport {
  moved: number;
  skipped: {
    /** `enabled` is false. */
    disabled: number;
    /** `expiresAt` is past. */
    expired: number;
    /** The digest is not 43 base64url characters: `disableKeyHashing` or another hasher. */
    noDigest: number;
    /** An earlier run moved the row and recorded it (`movedToken`). A revoke since then stays a revoke. */
    present: number;
    /** An organization key with no creator in its metadata and no owner in its organization. */
    noCreator: number;
    /** The user or the organization of `referenceId` is gone, so the key could never act. */
    noOwner: number;
    /** The name breaks core's rule: over 80 characters, or a control character. */
    invalidName: number;
    /** The metadata breaks core's rule: its JSON is over 4096 bytes. */
    invalidMetadata: number;
    /**
     * Core cannot hold the window without a wider rate: a stored max below 1,
     * or a window over one day whose share of the max in one day is below 1.
     */
    wideWindow: number;
  };
  /**
   * Each skipped row: its apikey id (never the key), its owner, and the
   * reason, sorted by id. Runbook step 3 tells each such owner.
   */
  skippedKeys: { id: string; owner: string; reason: SkipReason }[];
  /** The moved keys per owner: the user id, or the organization id. */
  byOwner: Record<string, number>;
  /** The resources and actions that the moved sets lost, because core's statements do not know them. */
  dropped: number;
  /** The organization keys whose creator is the organization's first owner, for want of `metadata.createdByUserId`. */
  ownerFallback: number;
  /** Each stored `prefix` value, sorted: each one goes in `authtempo.movedKeyPrefixes` or `defaultPrefix`. */
  prefixes: string[];
}

/** Why the move skipped a row: a key of `ApiKeyMoveReport.skipped`. */
export type SkipReason =
  | "disabled"
  | "expired"
  | "noDigest"
  | "present"
  | "noCreator"
  | "noOwner"
  | "invalidName"
  | "invalidMetadata"
  | "wideWindow";

export interface ApiKeyMoveInput {
  names: Names;
  /** The api-key plugin's `references`: which core table takes the keys. */
  references: "user" | "organization";
  /** True: read and count, and write nothing. */
  dryRun: boolean;
  /**
   * Core's `tokens.movedPrefixes` of the app: `movedKeyPrefixesOf(options)`.
   * Only a bearer with one of them reaches the lookup of the moved keys. So
   * the move refuses a stored prefix outside the list (ruling 40 of plan 12k).
   */
  movedPrefixes: readonly string[];
  /**
   * The plugin's `rateLimit.enabled` (Better Auth's default: true). False:
   * Better Auth skips the window of every key (`evaluateRateLimit`,
   * dist/index.mjs:1586), so the move writes no window.
   */
  rateLimitEnabled: boolean;
  /**
   * The app's own statements in Better Auth's names, as its `ac` holds them.
   * Core's six resources are always known. Absent: only those.
   */
  statements?: Record<string, readonly string[]>;
}

/** The name of a moved key that Better Auth stored with none: core keeps a name on every token. */
const NAMELESS = "Moved key";
/** The `source` of each `movedToken` record that the move writes. */
const SOURCE = "better-auth:apikey";
/** Better Auth's digest: SHA-256 in base64url with no padding (`defaultKeyHasher`). */
const DIGEST_RE = /^[A-Za-z0-9_-]{43}$/;
/**
 * Core's window bounds (core engine/token-use.ts `validWindow`; core does not
 * export them). The move cuts a longer window to one day, and checkOptions
 * refuses a plugin window outside them.
 */
export const WINDOW_SECONDS_MAX = 86_400;
export const WINDOW_CALLS_MAX = 100_000;
const COUNT_MAX = 2_147_483_647;

/** The hex of a base64url digest, the form of core's `tokenHash`. */
function hexOf(digest: string): string {
  const std = digest.replace(/-/g, "+").replace(/_/g, "/");
  const bytes = atob(`${std}=`);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes.charCodeAt(i).toString(16).padStart(2, "0");
  return hex;
}

/** A stored date: a Date (Postgres), epoch milliseconds, or text (SQLite). Null for none. */
function dateOf(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === "number") return new Date(v);
  if (typeof v === "string") {
    // SQLite's own text has a space and no zone; SQLite reads it as UTC.
    const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(v)
      ? `${v.replace(" ", "T")}Z`
      : v;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

const numberOf = (v: unknown): number | null =>
  typeof v === "number" ? v : typeof v === "string" && v !== "" ? Number(v) : null;

/** SQLite keeps a boolean as 0 or 1. Null keeps Better Auth's default. */
const boolOf = (v: unknown, otherwise: boolean): boolean =>
  v === null || v === undefined ? otherwise : v === true || v === 1 || v === "1" || v === "t";

/**
 * A JSON text column. Better Auth 1.7 stored some metadata as a string of a
 * JSON string (`migrateDoubleStringifiedMetadata`), so a string result is
 * read once more. Anything that is not an object reads as null.
 */
function jsonObjectOf(v: unknown): Record<string, unknown> | null {
  let value = v;
  for (let i = 0; i < 2 && typeof value === "string"; i++) {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * A stored set as core's set of known names: `apiKey` becomes `apiToken`
 * (role-map.ts). An unknown resource and an unknown action go, and each
 * one counts, because a key's set may only narrow. No set is `{}`: Better
 * Auth's check of a key with no set grants nothing (dist/index.mjs:1665).
 */
function narrowSet(
  raw: unknown,
  known: Record<string, readonly string[]>,
): { set: Record<string, string[]>; dropped: number } {
  const parsed = jsonObjectOf(raw);
  if (parsed === null) return { set: {}, dropped: 0 };
  const named = toCoreNames(parsed) as Record<string, unknown>;
  const set: Record<string, string[]> = {};
  let dropped = 0;
  for (const [resource, actions] of Object.entries(named)) {
    const allowed = Object.hasOwn(known, resource) ? known[resource] : undefined;
    if (!allowed || !Array.isArray(actions)) {
      dropped++;
      continue;
    }
    const kept = actions.filter((a): a is string => typeof a === "string" && allowed.includes(a));
    dropped += actions.length - kept.length;
    if (kept.length > 0) set[resource] = [...new Set(kept)];
  }
  return { set, dropped };
}

/**
 * The window of a stored key, never wider than Better Auth's. Null: no
 * window, as Better Auth skips one with no time or no max
 * (`evaluateRateLimit`, dist/index.mjs:1594). "wide": core cannot hold the
 * window without a wider rate, so the move skips the key (final review of
 * plan 12k, m1). With a max below 1, Better Auth allows one call and then
 * refuses each call until a window passes with no call (dist/index.mjs:1847).
 * Core's window takes a max of 1 or more (`validWindow`).
 */
function windowOf(row: Record<string, unknown>): { seconds: number; max: number } | null | "wide" {
  const ms = numberOf(row.rateLimitTimeWindow);
  const max = numberOf(row.rateLimitMax);
  if (!boolOf(row.rateLimitEnabled, true) || ms === null || max === null || ms <= 0) return null;
  if (max < 1) return "wide";
  // Rounded up: a longer window with the same max is narrower.
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  if (seconds <= WINDOW_SECONDS_MAX) return { seconds, max: Math.min(max, WINDOW_CALLS_MAX) };
  // One day with the share of the max that the day holds, rounded down, so the rate never grows.
  // A share below 1 would grow the rate, so such a key does not move.
  const share = Math.floor((max * WINDOW_SECONDS_MAX) / seconds);
  if (share < 1) return "wide";
  return { seconds: WINDOW_SECONDS_MAX, max: Math.min(share, WINDOW_CALLS_MAX) };
}

/** The quota of a stored key. Better Auth sets `remaining` at a refill; core does the same (deviation 6). */
function quotaOf(row: Record<string, unknown>) {
  const remaining = numberOf(row.remaining);
  if (remaining === null) {
    return { remaining: null, refillAmount: null, refillSeconds: null, lastRefillAt: null };
  }
  const amount = numberOf(row.refillAmount);
  const interval = numberOf(row.refillInterval);
  const refill = amount !== null && interval !== null && amount >= 1 && interval > 0;
  return {
    remaining: Math.min(Math.max(0, Math.floor(remaining)), COUNT_MAX),
    refillAmount: refill ? Math.min(Math.floor(amount), COUNT_MAX) : null,
    // Rounded up: a longer interval is narrower.
    refillSeconds: refill ? Math.min(Math.ceil(interval / 1000), COUNT_MAX) : null,
    lastRefillAt: refill ? dateOf(row.lastRefillAt) : null,
  };
}

/** The member row of the organization's first owner by `createdAt`, or null. */
async function firstOwner(
  storage: PostgresSchemaStorage | D1SchemaStorage,
  organizationId: string,
): Promise<string | null> {
  const members = await storage.storage.findMany(
    "member",
    [{ field: "organizationId", op: "eq", value: organizationId }],
    { sort: [{ field: "createdAt", dir: "asc" }] },
  );
  const owner = members.find((m) =>
    m.role
      .split(",")
      .map((r) => r.trim())
      .includes("owner"),
  );
  return owner?.userId ?? null;
}

/**
 * Ruling 40 of plan 12k: the check before the first write, and on a dry run
 * too. A moved key acts only when its bearer starts with a moved prefix. So
 * a stored prefix outside the list, or a row with no prefix, would move a
 * key that never acts. The move then throws and writes nothing.
 */
function unroutable(
  rows: readonly Record<string, unknown>[],
  stored: ReadonlySet<string>,
  movedPrefixes: readonly string[],
): void {
  const missing = [...stored].sort().filter((p) => !movedPrefixes.some((m) => p.startsWith(m)));
  const bare = rows.filter((r) => typeof r.prefix !== "string" || r.prefix === "").length;
  const out: string[] = [];
  if (missing.length > 0)
    out.push(
      `moveBetterAuthApiKeys: no moved prefix starts the stored prefixes ${missing.join(", ")}; put each one in authtempo.movedKeyPrefixes`,
    );
  if (bare > 0)
    out.push(
      `moveBetterAuthApiKeys: apikey rows with no prefix: ${bare}; such a key never reaches the lookup of the moved keys, so re-issue it and delete its row`,
    );
  if (out.length > 0) throw new BetterAuthCompatError(out);
}

/**
 * Moves each apikey row into core's token table (owner decision 4 of plan
 * 12k). By ruling 2 a moved row acts as the old key, under the same secret:
 * the move writes no retired mark. One-shot for each row: the move records
 * each moved row (`movedToken`) in the transaction of its token, and a later
 * run skips a recorded row. So a revoked key stays revoked after a second
 * run (review finding M2). A disabled, expired, or undigested row is
 * skipped, and its key answers `token_retired` by its prefix after the
 * cutover. `dryRun: true` writes nothing and answers the same report.
 * Before any write, a stored prefix outside `movedPrefixes`, or a row with
 * no prefix, throws (`unroutable`).
 *
 * Storage calls: one raw read of apikey. Then per row: one findOne of the
 * record, one findOne of the owner, and one transaction of two creates
 * unless `dryRun`. An
 * organization key with no creator in its metadata adds one findMany of
 * members. A digest that a core token holds already fails the unique index,
 * and the run stops with that row and its record undone.
 */
export async function moveBetterAuthApiKeys(
  storage: PostgresSchemaStorage | D1SchemaStorage,
  input: ApiKeyMoveInput,
): Promise<ApiKeyMoveReport> {
  const read = rawReadOf(storage);
  if (!read)
    throw new BetterAuthCompatError([
      "moveBetterAuthApiKeys: pass the storage of betterAuthSchemaStorage or drizzleAdapter",
    ]);
  const n = input.names;
  const known: Record<string, readonly string[]> = { ...input.statements, ...CORE_STATEMENTS };
  const report: ApiKeyMoveReport = {
    moved: 0,
    skipped: {
      disabled: 0,
      expired: 0,
      noDigest: 0,
      present: 0,
      noCreator: 0,
      noOwner: 0,
      invalidName: 0,
      invalidMetadata: 0,
      wideWindow: 0,
    },
    skippedKeys: [],
    byOwner: {},
    dropped: 0,
    ownerFallback: 0,
    prefixes: [],
  };
  const prefixes = new Set<string>();
  // A Map, so an owner id such as `__proto__` stays data.
  const byOwner = new Map<string, number>();
  const rows = (await read(`SELECT * FROM ${n.table("apikey")}`)).map((raw) => {
    const row: Record<string, unknown> = {};
    for (const [column, value] of Object.entries(raw)) {
      const field = n.fieldOf("apikey", column);
      if (field !== null) row[field] = value;
    }
    return row;
  });
  for (const row of rows)
    if (typeof row.prefix === "string" && row.prefix !== "") prefixes.add(row.prefix);
  unroutable(rows, prefixes, input.movedPrefixes);
  const now = new Date();
  const db = storage.storage;
  for (const row of rows) {
    const skip = (reason: SkipReason) => {
      report.skipped[reason]++;
      report.skippedKeys.push({ id: String(row.id), owner: String(row.referenceId), reason });
    };
    if (!boolOf(row.enabled, true)) {
      skip("disabled");
      continue;
    }
    const expiresAt = dateOf(row.expiresAt);
    if (expiresAt !== null && expiresAt.getTime() <= now.getTime()) {
      skip("expired");
      continue;
    }
    const digest = typeof row.key === "string" ? row.key : "";
    if (!DIGEST_RE.test(digest)) {
      skip("noDigest");
      continue;
    }
    const sourceId = String(row.id);
    const recorded = await db.findOne("movedToken", [
      { field: "source", op: "eq", value: SOURCE },
      { field: "sourceId", op: "eq", value: sourceId },
    ]);
    if (recorded !== null) {
      skip("present");
      continue;
    }
    const tokenHash = hexOf(digest);
    const ownerId = String(row.referenceId);
    // A key of a gone owner would move and then answer INVALID_API_KEY (review finding L2).
    const byId = [{ field: "id" as const, op: "eq" as const, value: ownerId }];
    const owner =
      input.references === "organization"
        ? await db.findOne("organization", byId)
        : await db.findOne("user", byId);
    if (owner === null) {
      skip("noOwner");
      continue;
    }
    // A moved row meets core's create rules (review finding L6). A key with no name gets one.
    const name = typeof row.name === "string" && row.name !== "" ? row.name : NAMELESS;
    if (!validTokenName(name)) {
      skip("invalidName");
      continue;
    }
    const metadata = jsonObjectOf(row.metadata);
    if (metadata !== null && !validMetadata(metadata)) {
      skip("invalidMetadata");
      continue;
    }
    const { set, dropped } = narrowSet(row.permissions, known);
    const window = input.rateLimitEnabled ? windowOf(row) : null;
    if (window === "wide") {
      skip("wideWindow");
      continue;
    }
    const quota = quotaOf(row);
    const createdAt = dateOf(row.createdAt) ?? now;
    const fields = {
      name,
      tokenHash,
      hint: typeof row.start === "string" ? row.start : "",
      expiresAt,
      lastUsedAt: dateOf(row.lastRequest),
      permissions: set,
      metadata,
      rateLimitSeconds: window === null ? null : window.seconds,
      rateLimitMax: window === null ? null : window.max,
      ...quota,
      // Ruling 2 of plan 12k: a moved key acts, so no retired mark.
      retiredAt: null,
      createdAt,
      updatedAt: dateOf(row.updatedAt) ?? createdAt,
    };
    let write: (tx: StorageAdapter) => Promise<unknown>;
    let tokenId: string;
    if (input.references === "organization") {
      let createdById =
        typeof metadata?.createdByUserId === "string" ? metadata.createdByUserId : null;
      if (createdById === null) {
        createdById = await firstOwner(storage, ownerId);
        if (createdById === null) {
          skip("noCreator");
          continue;
        }
        report.ownerFallback++;
      }
      const data: OrganizationTokenRow = {
        id: newId(createdAt),
        organizationId: ownerId,
        createdById,
        ...fields,
      };
      tokenId = data.id;
      write = (tx) => tx.create("organizationToken", data);
    } else {
      const data: ApiTokenRow = {
        id: newId(createdAt),
        userId: ownerId,
        organizationId: null,
        ...fields,
      };
      tokenId = data.id;
      write = (tx) => tx.create("apiToken", data);
    }
    // The token and its record commit together, so a run that stops between rows moves each row once.
    if (!input.dryRun)
      await db.transaction(async (tx) => {
        await write(tx);
        await tx.create("movedToken", {
          id: newId(now),
          source: SOURCE,
          sourceId,
          tokenId,
          createdAt: now,
          updatedAt: now,
        });
      });
    report.moved++;
    report.dropped += dropped;
    byOwner.set(ownerId, (byOwner.get(ownerId) ?? 0) + 1);
  }
  report.skippedKeys.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  report.byOwner = Object.fromEntries(byOwner);
  report.prefixes = [...prefixes].sort();
  return report;
}
