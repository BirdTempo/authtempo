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
/** One module specifier of a file, with the range of its string token. */
export interface ImportRef {
  spec: string;
  start: number;
  end: number;
}
/** The module specifiers of `text`. Throws on an import that it cannot read. */
export declare function importsOf(text: string, file: string): ImportRef[];
/** Reads each .js file under `dir`: every import names a file under `dir` by a relative path. */
export declare function checkAssets(dir?: string): { files: number; imports: number };
