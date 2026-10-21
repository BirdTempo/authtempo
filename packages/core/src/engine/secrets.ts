import type { ResolvedConfig } from "../config.js";
import { fail, ok, type Result } from "../result.js";
import type { ModelName, Models, VerificationPurpose } from "../schema.js";
import { meterOf } from "../storage/meter.js";
import type { Sort, StorageAdapter, Where } from "../storage/port.js";
import { rewrapKeyRow } from "./jwt.js";
import { rewrapConnectionRow } from "./sso/connections.js";
import { SWEEP_CALL_BUDGET, SWEEP_CALL_BUDGET_MAX } from "./sweep.js";
import { isLiveSetupWithCodes, rewrapTotpRow } from "./totp.js";

/**
 * The operator's view of the app secrets (plan 12b, spec 22). `status`
 * counts the rows under each version, so an operator can see when an old
 * version may leave the config. `rewrap` reseals the sealed values under the
 * current version for a user who does not sign in. A keyed hash cannot be
 * rehashed: core never sees its code again. The operator routes of plan
 * 11c2 serve both calls, for `authtempo secret status` and `secret rewrap`.
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
  /**
   * OIDC client secrets of SSO connections sealed under this version (plan
   * 12d, ruling 31). A SAML connection seals no secret and does not count.
   */
  ssoClientSecrets: number;
  /**
   * Live sealed app payloads of a social flow (plan 12i Task 19): state rows
   * and challenge rows. `rewrap` leaves them: they live at most 10 minutes.
   */
  stateData: number;
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
 * every row of the five tables by pages of ids: one query per 1000 rows of
 * each table, and of each of the two code reads. The port sets no maximum limit (checked 2026-10-15), and a
 * page of 1000 is the most rows that `rewrap` reads in one call.
 */
const PAGE = 1000;
/** The purposes whose `valueHash` is a keyed hash (plan 9e). */
const KEYED_PURPOSES: readonly VerificationPurpose[] = ["email-otp", "password-reset-otp"];
/**
 * The purposes of a social state row, which can hold a sealed app payload
 * (plan 12i Task 19). The read of the keyed codes reads them too, so status
 * makes no more queries for them.
 */
const STATE_PURPOSES: readonly VerificationPurpose[] = ["oauth-state", "oauth-link-state"];
/**
 * The sealed tables in the order of a pass. The cursor names the table and
 * the last id read. Plan 12d adds the client secrets of the SSO connections.
 */
const SEALED = ["totp", "jwk", "ssoConnection"] as const;
type Sealed = (typeof SEALED)[number];
const CURSOR = /^(totp|jwk|ssoConnection):(.+)$/;
/** The rows of a table that hold a sealed value: a SAML connection has no client secret. */
const SEALED_ONLY: { readonly [M in Sealed]: Where<M>[] } = {
  totp: [],
  jwk: [],
  ssoConnection: [{ field: "clientSecret", op: "ne", value: null }],
};

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
        ssoClientSecrets: 0,
        stateData: 0,
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
  // Ruling 31 of plan 12d: a version is not free while a client secret is sealed under it.
  await eachRow(storage, "ssoConnection", SEALED_ONLY.ssoConnection, (r) => {
    entry(r.secretVersion).ssoClientSecrets++;
  });
  const now = config.clock.now();
  const live: Where<"verification">[] = [
    { field: "consumedAt", op: "eq", value: null },
    { field: "expiresAt", op: "gt", value: now },
  ];
  await eachRow(
    storage,
    "verification",
    [{ field: "purpose", op: "in", value: [...KEYED_PURPOSES, ...STATE_PURPOSES] }, ...live],
    (r) => {
      if (KEYED_PURPOSES.includes(r.purpose)) entry(r.secretVersion).emailCodes++;
      // A state row seals its payload under the row's version.
      else if (typeof r.data?.sealedData === "string") entry(r.secretVersion).stateData++;
    },
  );
  // Plan 12c: the email code of a challenge is a keyed hash in `data`.
  await eachRow(
    storage,
    "verification",
    [{ field: "purpose", op: "eq", value: "two-factor" }, ...live],
    (r) => {
      if (typeof r.data?.emailCodeHash === "string") entry(r.secretVersion).emailCodes++;
      // The payload of a challenge names its own version: an email code
      // send moves the row's `secretVersion` (plan 12i Task 19).
      const payload = r.data?.sealedDataVersion;
      if (typeof r.data?.sealedData === "string" && typeof payload === "number")
        entry(payload).stateData++;
    },
  );
  const order = (c: SecretVersionCount) => {
    const at = keyring.versions.indexOf(c.version);
    return at === -1 ? keyring.versions.length + c.version : at;
  };
  return { versions: [...counts.values()].sort((a, b) => order(a) - order(b)) };
}

/**
 * The calls of one rewrap on Workers Free: D1 Free allows 50 queries per
 * invocation (D1 limits page updated 21 April 2026, read 2026-10-21). The
 * bounds are those of the sweep (ruling 33 of plan 12d).
 */
export const REWRAP_CALL_BUDGET = SWEEP_CALL_BUDGET;
/** The largest `callBudget` of a rewrap: D1 Paid allows 1000 queries per invocation. */
export const REWRAP_CALL_BUDGET_MAX = SWEEP_CALL_BUDGET_MAX;
/**
 * The calls of the invocation before a rewrap, by caller: the form of
 * `OPERATOR_CALLS_BEFORE` of plan 12f (ruling 34 of plan 12d). The route
 * asks the limiter per IP (`operator-secrets:ip`) first, one query on the
 * D1 limiter. The app calls no limiter. The storage counter cannot see the
 * limiter query: it goes to the binding, not through the adapter. With 1
 * left out, one route call sent 51 queries on D1.
 */
export const REWRAP_CALLS_BEFORE = { route: 1, app: 0 } as const;
/** The worst calls of one row: its conditional update. The open and the seal call no storage. */
const ROW_CALLS = 1;
/** The reads at the end of a pass: one per table, for `more`. */
const LEFT_CALLS = SEALED.length;

/**
 * Reads up to `limit` sealed values under a configured old version, after
 * the cursor `after`, and reseals each under the current version. The TOTP
 * secrets come first, then the keys, then the client secrets of the SSO
 * connections. A row under a version that the config does not hold is
 * never read, so a pass always ends; `status` lists it.
 *
 * The call stays inside `callBudget` storage calls, 50 by default for D1
 * Free, up to 1000 (ruling 33 of plan 12d). The meter counts the calls
 * of `caller` before the act (`REWRAP_CALLS_BEFORE`), the ready check, each
 * read, each row, and the end reads. A call that the budget
 * stops early answers `more: true` and the cursor of its last row: the
 * operator calls again with it. A `callBudget` outside 50 to 1000 answers
 * `invalid_body`.
 */
export async function rewrapSecrets(
  config: ResolvedConfig,
  input: { limit?: number; after?: string; callBudget?: number } = {},
  caller: keyof typeof REWRAP_CALLS_BEFORE = "app",
): Promise<Result<SecretsRewrap>> {
  const limit = input.limit ?? REWRAP_LIMIT.default;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > REWRAP_LIMIT.max)
    return fail("invalid_body");
  const calls = input.callBudget ?? REWRAP_CALL_BUDGET;
  if (!Number.isSafeInteger(calls) || calls < REWRAP_CALL_BUDGET || calls > REWRAP_CALL_BUDGET_MAX)
    return fail("invalid_body");
  const cursor = input.after === undefined ? null : CURSOR.exec(input.after);
  if (input.after !== undefined && !cursor) return fail("invalid_body");
  const { keyring, storage } = config;
  const old = keyring.versions.filter((v) => v !== keyring.current);
  if (old.length === 0) return ok({ resealed: 0, failed: 0, skipped: 0, more: false, next: null });
  // The ready check of the storage counts too: `readyStatements`, or 1 when the storage has none.
  const meter = meterOf(
    storage,
    REWRAP_CALLS_BEFORE[caller] + ((await storage.readyStatements?.()) ?? 1),
  );
  const counts = { resealed: 0, failed: 0, skipped: 0 };
  // A row that does not open counts as failed. So does a row whose
  // conditional write matched nothing: a concurrent sign-in, signature, or
  // new setup changed it first. A later pass reads it again.
  const failedRow = (model: Sealed, row: { id: string; secretVersion: number }) => {
    counts.failed++;
    config.observe.emit({
      name: "secrets.rewrap_failed",
      model,
      rowId: row.id,
      version: row.secretVersion,
    });
  };
  const now = config.clock.now();
  const startTable = SEALED.find((t) => t === cursor?.[1]) ?? SEALED[0];
  let budget = limit;
  let next: string | null = null;
  // The cursor of the last row that this call handled, or the cursor it got.
  let last: string | null = input.after ?? null;
  for (const model of SEALED.slice(SEALED.indexOf(startTable))) {
    // The rows that fit after the read of the page and the end reads.
    const fit = Math.floor((calls - meter.used - 1 - LEFT_CALLS) / ROW_CALLS);
    if (fit < 1) {
      next = last;
      break;
    }
    const take = Math.min(budget, fit);
    const after: Where<Sealed>[] =
      cursor && model === startTable ? [{ field: "id", op: "gt", value: cursor[2] ?? "" }] : [];
    const opts = { sort: byId<Sealed>(), limit: take };
    let read: Array<{ id: string }>;
    if (model === "totp") {
      const rows = await storage.findMany(
        "totp",
        [{ field: "secretVersion", op: "in", value: old }, ...after],
        opts,
      );
      meter.step(1);
      for (const row of rows) {
        if (isLiveSetupWithCodes(row, now)) counts.skipped++;
        else if (await rewrapTotpRow(config, row)) counts.resealed++;
        else failedRow(model, row);
        meter.step(ROW_CALLS);
      }
      read = rows;
    } else if (model === "jwk") {
      const rows = await storage.findMany(
        "jwk",
        [{ field: "secretVersion", op: "in", value: old }, ...after],
        opts,
      );
      meter.step(1);
      for (const row of rows) {
        if (await rewrapKeyRow(config, row)) counts.resealed++;
        else failedRow(model, row);
        meter.step(ROW_CALLS);
      }
      read = rows;
    } else {
      const rows = await storage.findMany(
        "ssoConnection",
        [
          { field: "secretVersion", op: "in", value: old },
          ...SEALED_ONLY.ssoConnection,
          ...(after as Where<"ssoConnection">[]),
        ],
        opts,
      );
      meter.step(1);
      for (const row of rows) {
        if (await rewrapConnectionRow(config, row)) counts.resealed++;
        else failedRow(model, row);
        meter.step(ROW_CALLS);
      }
      read = rows;
    }
    budget -= read.length;
    const end = read.at(-1);
    if (end) last = `${model}:${end.id}`;
    // The limit of rows, or the budget of calls, ends the pass in this table.
    if (budget === 0 || (read.length === take && take < budget + read.length)) {
      if (end) next = last;
      break;
    }
  }
  const left = async <M extends Sealed>(model: M) => {
    const found = await storage.findMany(
      model,
      [
        { field: "secretVersion" as Where<M>["field"], op: "in", value: old },
        ...SEALED_ONLY[model],
      ],
      { limit: 1 },
    );
    meter.step(1);
    return found.length > 0;
  };
  return ok({
    ...counts,
    more: (await left("totp")) || (await left("jwk")) || (await left("ssoConnection")),
    next,
  });
}
