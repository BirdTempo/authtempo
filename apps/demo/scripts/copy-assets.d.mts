// The types of copy-assets.mjs, for test/node/copy-assets.test.ts.
export interface CopyOptions {
  out?: string;
  publicDir?: string;
  tokens?: string;
  fonts?: string;
  client?: string;
  coreDist?: string;
}
export declare const ALLOWED: Readonly<Record<string, string>>;
export declare const SOURCES: Readonly<Required<Omit<CopyOptions, "out">>>;
/** Writes the assets into `out` (dist/public by default) and answers the files written. */
export declare function copyAssets(options?: CopyOptions): string[];
