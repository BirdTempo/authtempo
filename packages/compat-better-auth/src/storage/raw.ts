/**
 * The raw read of a Better Auth table that no model maps (plan 12k Task 12):
 * `moveBetterAuthApiKeys` reads `apikey` with it. `betterAuthSchemaStorage`
 * registers one reader per storage, so the public storage type holds no SQL
 * handle. The SQL comes from `Names`, never from a caller's value.
 */
export type RawRead = (sql: string) => Promise<Record<string, unknown>[]>;

const READERS = new WeakMap<object, RawRead>();

export function registerRawRead(storage: object, read: RawRead): void {
  READERS.set(storage, read);
}

export function rawReadOf(storage: object): RawRead | undefined {
  return READERS.get(storage);
}
