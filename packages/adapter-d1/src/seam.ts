/**
 * The seam of plan 12g. These types name no Workers type, so a Node or Bun
 * app compiles against them. A D1 binding satisfies them (the check is in
 * `index.ts`), and each SQLite driver entry of `@authtempo/adapter-sqlite`
 * builds one over its own handle.
 */

/** The part of a D1 binding that the D1 adapter, the limiter, and the version check call (plan 12g). */
export interface D1Subset {
  prepare(sql: string): D1SubsetStatement;
  batch(statements: D1SubsetStatement[]): Promise<D1SubsetResult[]>;
}

export interface D1SubsetStatement {
  bind(...values: unknown[]): D1SubsetStatement;
  run(): Promise<D1SubsetResult>;
  all(): Promise<D1SubsetResult>;
  /** The first row, or one column of it, or null when no row matches. */
  first(column?: string): Promise<unknown>;
}

export interface D1SubsetResult {
  results: Record<string, unknown>[];
  meta: { changes: number };
}
