/**
 * The bearer token of a native or desktop app at rest (plan 11d: moved from
 * `electron.ts`, so the Expo store and the Electron store answer one type).
 */
export interface TokenStore {
  get(): Promise<string | null>;
  set(token: string): Promise<void>;
  clear(): Promise<void>;
}
