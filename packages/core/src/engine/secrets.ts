import type { ResolvedConfig } from "../config.js";
import { fail, ok, type Result } from "../result.js";
import type { ModelName, Models } from "../schema.js";
import type { Sort, StorageAdapter, Where } from "../storage/port.js";
import { rewrapKeyRow } from "./jwt.js";
import { isLiveSetupWithCodes, rewrapTotpRow } from "./totp.js";

/**
 * The operator's view of the app secrets (plan 12b, spec 22). `status`
 * counts the rows under each version, so an operator can see when an old
 * version may leave the config. `rewrap` reseals the sealed values under the
 * current version for a user who does not sign in. A keyed hash cannot be
 * rehashed: core never sees its code again. Neither call has a route: the
 * CLI wraps them (row 11c2).
 */

export interface SecretVersionCount {
  version: number;
  /** False for a version that a row names and the config does not hold. */
  configured: boolean;
  current: boolean;
  /** TOTP rows, confirmed or not, sealed under this version. */
  totpSecrets: number;
  /** Unused backup codes keyed under this version, summed over the users. */
  backupCodes: number;
  /** Signing keys and retired keys that the sweep has not deleted. */
  signingKeys: number;
  /** Live email codes: unspent, unexpired rows of a keyed purpose. */
  emailCodes: number;
}

export interface SecretsStatus {
  versions: SecretVersionCount[];
}

export interface SecretsRewrap {
  /** Rows that this call moved to the current version. */
  resealed: number;
  /** Rows under a configured old version that did not open or did not write. The log names each. */
  failed: number;
  /**
   * Live TOTP setups that hold backup codes. They stay under their version
   * until the enable, a new setup, or the end of their 15 minutes. Run a
   * new pass after 15 minutes to move them.
   */
  skipped: number;
  /** True while a row under a configured old version remains, also a row that failed or was skipped. */
  more: boolean;
  /**
   * The cursor of this pass: pass it as `after` to read the next rows. Null
   * when this call reached the last row. A pass reads each row once, so a
   * row that fails or is skipped never blocks a later row.
   */
  next: string | null;
}

/** `limit` of `rewrap`: the rows it reads in one call, over all tables. */
export const REWRAP_LIMIT = { default: 100, max: 1000 } as const;
/**
 * The page of a status read. The storage port has no count, so status reads
 * every row of the four tables by pages of ids: one query per 1000 rows of
 * each table. The port sets no maximum limit (checked 2026-10-15), and a
 * page of 1000 is the most rows that `rewrap` reads in one call.
 */
const PAGE = 1000;
/** The purposes whose `valueHash` is a keyed hash (plan 9e). */
const KEYED_PURPOSES = ["email-otp", "password-reset-otp"] as const;
/** The sealed tables in the order of a pass. The cursor names the table and the last id read. */
const SEALED = ["totp", "jwk"] as const;
type Sealed = (typeof SEALED)[number];
const CURSOR = /^(totp|jwk):(.+)$/;

/** The sort by id. `id` is a field of every model (`BaseRow`), and the port's generic cannot see that. */
function byId<M extends ModelName>(): Sort<M> {
  return { field: "id" as Sort<M>["field"], dir: "asc" };
}

/** Every row of `model` that `where` matches, by pages of ids. */
async function eachRow<M extends ModelName>(
  storage: StorageAdapter,
  model: M,
  where: Where<M>[],
  visit: (row: Models[M]) => void,
): Promise<void> {
  let last = "";
  for (;;) {
    const page = await storage.findMany(
      model,
      [...where, { field: "id" as Where<M>["field"], op: "gt", value: last }],
      { sort: byId<M>(), limit: PAGE },
    );
    for (const row of page) visit(row);
    const end = page.at(-1);
    if (!end || page.length < PAGE) return;
    last = end.id;
  }
}

export async function secretsStatus(config: ResolvedConfig): Promise<SecretsStatus> {
  const { keyring, storage } = config;
  const counts = new Map<number, SecretVersionCount>();
  const entry = (version: number): SecretVersionCount => {
    let c = counts.get(version);
    if (!c) {
      c = {
        version,
        configured: keyring.valueOf(version) !== null,
        current: version === keyring.current,
        totpSecrets: 0,
        backupCodes: 0,
        signingKeys: 0,
        emailCodes: 0,
      };
      counts.set(version, c);
    }
    return c;
  };
  for (const v of keyring.versions) entry(v);
  await eachRow(storage, "totp", [], (r) => {
    entry(r.secretVersion).totpSecrets++;
  });
  await eachRow(storage, "secondFactor", [], (r) => {
    if (r.backupCodes.length > 0) entry(r.secretVersion).backupCodes += r.backupCodes.length;
  });
  await eachRow(storage, "jwk", [], (r) => {
    entry(r.secretVersion).signingKeys++;
  });
  const now = config.clock.now();
  const live: Where<"verification">[] = [
    { field: "consumedAt", op: "eq", value: null },
    { field: "expiresAt", op: "gt", value: now },
  ];
  await eachRow(
    storage,
    "verification",
    [{ field: "purpose", op: "in", value: [...KEYED_PURPOSES] }, ...live],
    (r) => {
      entry(r.secretVersion).emailCodes++;
    },
  );
  // Plan 12c: the email code of a challenge is a keyed hash in `data`.
  await eachRow(
    storage,
    "verification",
    [{ field: "purpose", op: "eq", value: "two-factor" }, ...live],
    (r) => {
      if (typeof r.data?.emailCodeHash === "string") entry(r.secretVersion).emailCodes++;
    },
  );
  const order = (c: SecretVersionCount) => {
    const at = keyring.versions.indexOf(c.version);
    return at === -1 ? keyring.versions.length + c.version : at;
  };
  return { versions: [...counts.values()].sort((a, b) => order(a) - order(b)) };
}

/**
 * Reads up to `limit` sealed values under a configured old version, after
 * the cursor `after`, and reseals each under the current version: the TOTP
 * secrets first, then the keys. A row under a version that the config does
 * not hold is never read, so a pass always ends; `status` lists it.
 */
export async function rewrapSecrets(
  config: ResolvedConfig,
  input: { limit?: number; after?: string } = {},
): Promise<Result<SecretsRewrap>> {
  const limit = input.limit ?? REWRAP_LIMIT.default;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > REWRAP_LIMIT.max)
    return fail("invalid_body");
  const cursor = input.after === undefined ? null : CURSOR.exec(input.after);
  if (input.after !== undefined && !cursor) return fail("invalid_body");
  const { keyring, storage } = config;
  const old = keyring.versions.filter((v) => v !== keyring.current);
  if (old.length === 0) return ok({ resealed: 0, failed: 0, skipped: 0, more: false, next: null });
  const counts = { resealed: 0, failed: 0, skipped: 0 };
  // A row that does not open counts as failed. So does a row whose
  // conditional write matched nothing: a concurrent sign-in, signature, or
  // new setup changed it first. A later pass reads it again.
  const failedRow = (model: Sealed, row: { id: string; secretVersion: number }) => {
    counts.failed++;
    console.error(
      "authtempo: a sealed value did not move to the current secret; it did not open, or a concurrent write changed it first",
      model,
      row.id,
      `version ${row.secretVersion}`,
    );
  };
  const now = config.clock.now();
  const startTable = SEALED.find((t) => t === cursor?.[1]) ?? SEALED[0];
  let budget = limit;
  let next: string | null = null;
  for (const model of SEALED.slice(SEALED.indexOf(startTable))) {
    const after: Where<Sealed>[] =
      cursor && model === startTable ? [{ field: "id", op: "gt", value: cursor[2] ?? "" }] : [];
    const opts = { sort: byId<Sealed>(), limit: budget };
    let read: Array<{ id: string }>;
    if (model === "totp") {
      const rows = await storage.findMany(
        "totp",
        [{ field: "secretVersion", op: "in", value: old }, ...after],
        opts,
      );
      for (const row of rows) {
        if (isLiveSetupWithCodes(row, now)) counts.skipped++;
        else if (await rewrapTotpRow(config, row)) counts.resealed++;
        else failedRow(model, row);
      }
      read = rows;
    } else {
      const rows = await storage.findMany(
        "jwk",
        [{ field: "secretVersion", op: "in", value: old }, ...after],
        opts,
      );
      for (const row of rows) {
        if (await rewrapKeyRow(config, row)) counts.resealed++;
        else failedRow(model, row);
      }
      read = rows;
    }
    budget -= read.length;
    const end = read.at(-1);
    if (budget === 0) {
      if (end) next = `${model}:${end.id}`;
      break;
    }
  }
  const left = async (model: Sealed) =>
    (
      await storage.findMany(model, [{ field: "secretVersion", op: "in", value: old }], {
        limit: 1,
      })
    ).length > 0;
  return ok({ ...counts, more: (await left("totp")) || (await left("jwk")), next });
}
