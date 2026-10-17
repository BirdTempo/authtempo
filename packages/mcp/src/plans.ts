// The plan handle of migrate.plan and migrate.run (plan 11e Task 8), and of
// schema.migrate (Task 9). A real run takes the id of a plan against the
// database. The id binds the run to the input, the bytes of each file, and
// the database of that plan. The store is in memory: a new server holds no plan.
import { createHash, randomBytes } from "node:crypto";

/**
 * How long a plan stays valid: 10 minutes, the owner's decision of
 * 2026-10-14. An older plan can show rows that the database no longer holds.
 */
export const PLAN_TTL_MS = 600_000;

/**
 * The most plans that the store holds; the oldest goes first. The server is
 * one person's tool; 16 plans is more than one session uses.
 */
export const PLAN_MAX = 16;

/** The fixed texts of a refusal. A test compares each one as a literal. */
export const PLAN_REFUSALS = {
  input: "the input differs from the plan",
  database: "the database differs from the plan",
} as const;

/** The refusal text for a file whose SHA-256 differs from the plan. */
export const fileChanged = (key: string): string => `the file ${key} changed since the plan`;

/**
 * The tool that made a plan: "import" for migrate.plan, "schema" for a dry
 * run of schema.migrate. A plan of another kind is an unknown id.
 */
export type PlanKind = "import" | "schema";

/**
 * The refusal of an id that the store does not hold for this kind: unknown,
 * used, or old. It names the call that makes a new plan of the kind.
 */
export const UNKNOWN_PLAN: Readonly<Record<PlanKind, string>> = {
  import: "no held plan has this id; run migrate.plan again",
  schema: "no held plan has this id; run schema.migrate with dry_run: true again",
};

/** One held plan. `input` is canonical JSON; `files` maps each file input to its SHA-256. */
export interface Held {
  kind: PlanKind;
  input: string;
  files: Readonly<Record<string, string>>;
  /** The SHA-256 of the connection string of the plan. Only the store reads it; no answer holds it. */
  database: string;
  report: unknown;
  at: number;
}

/** A refusal of take: one of the fixed texts. */
export interface PlanError {
  refused: string;
}

export const isPlanError = (v: Held | PlanError): v is PlanError => "refused" in v;

/** The SHA-256 of bytes or of a text, in hex. */
export const sha256 = (data: string | Uint8Array): string =>
  createHash("sha256").update(data).digest("hex");

/**
 * The canonical JSON of a tool input: the keys sorted at each level, with no
 * plan_id and no confirm. Two inputs with the same values give the same text.
 */
export function canonicalInput(input: Readonly<Record<string, unknown>>): string {
  const sorted = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sorted);
    if (v !== null && typeof v === "object")
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((k) => [k, sorted((v as Record<string, unknown>)[k])]),
      );
    return v;
  };
  const rest = Object.fromEntries(
    Object.entries(input).filter(([k, v]) => k !== "plan_id" && k !== "confirm" && v !== undefined),
  );
  return JSON.stringify(sorted(rest));
}

/** The files of two plans are the same set of keys. */
const sameKeys = (a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>) =>
  JSON.stringify(Object.keys(a).sort()) === JSON.stringify(Object.keys(b).sort());

/**
 * The held plans of one server. The clock is a parameter, so a test can
 * move the time past PLAN_TTL_MS with no wait.
 */
export class PlanStore {
  readonly #plans = new Map<string, Held>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** The number of plans that the store holds. */
  get size(): number {
    return this.#plans.size;
  }

  /**
   * Holds a plan and answers its new id: mp_ and 22 random base64url
   * characters (16 random bytes). The id carries no part of the input.
   */
  hold(
    kind: PlanKind,
    input: Readonly<Record<string, unknown>>,
    files: Readonly<Record<string, string>>,
    report: unknown,
    database: string,
  ): string {
    while (this.#plans.size >= PLAN_MAX) {
      const oldest = this.#plans.keys().next();
      if (oldest.done === true) break;
      this.#plans.delete(oldest.value);
    }
    const id = `mp_${randomBytes(16).toString("base64url")}`;
    this.#plans.set(id, {
      kind,
      input: canonicalInput(input),
      files: { ...files },
      database,
      report,
      at: this.#now(),
    });
    return id;
  }

  /**
   * Takes a plan for one run. The entry goes first, so an id serves one run
   * only, also when a check refuses it. Then each check refuses with its
   * fixed text. The checks are an unknown or old id, a plan of another kind,
   * another input, a changed file, and another database.
   */
  take(
    kind: PlanKind,
    id: string,
    input: Readonly<Record<string, unknown>>,
    files: Readonly<Record<string, string>>,
    database: string,
  ): Held | PlanError {
    const held = this.#plans.get(id);
    this.#plans.delete(id);
    if (held === undefined || held.kind !== kind || this.#now() - held.at > PLAN_TTL_MS)
      return { refused: UNKNOWN_PLAN[kind] };
    if (held.input !== canonicalInput(input) || !sameKeys(held.files, files))
      return { refused: PLAN_REFUSALS.input };
    for (const [key, digest] of Object.entries(held.files))
      if (files[key] !== digest) return { refused: fileChanged(key) };
    if (held.database !== database) return { refused: PLAN_REFUSALS.database };
    return held;
  }
}
