import { describe, expect, it } from "vitest";
import { rawBodyReads } from "../../../scripts/body-reads.mjs";

/**
 * The shim reads each request body with `readJsonOf` (src/server/body.ts),
 * which is core's capped reader (ruling 46 Minor 1 of the 12j lane). The
 * scan of scripts/body-reads.mjs lists each raw read of a Request with the
 * TypeScript compiler API and its type checker. The shim has none.
 */

/** The specifier in a constant keeps the compiler API out of the typecheck. */
const TS_MODULE = "typescript-api";
const pathOf = (relative: string) =>
  decodeURIComponent(new URL(relative, import.meta.url).pathname);
const TSCONFIG = pathOf("../tsconfig.json");

const compilerApi = async (): Promise<unknown> =>
  ((await import(/* @vite-ignore */ TS_MODULE)) as { default: unknown }).default;

describe("the raw body reads of the shim (ruling 46 of the 12j lane)", () => {
  it("has no raw read of a request body", { timeout: 60_000 }, async () => {
    const { files, reads } = rawBodyReads(await compilerApi(), TSCONFIG);
    console.log(`body-reads: files=${files} reads=${reads.length}`);
    expect(files).toBeGreaterThan(40);
    expect(reads).toEqual([]);
  });

  it("sees a raw read of a Request with the options of the shim", { timeout: 60_000 }, async () => {
    const fixture = pathOf("./fixtures/raw-body-reads.ts");
    const { reads } = rawBodyReads(await compilerApi(), TSCONFIG, [fixture]);
    expect(reads.map((r) => r.replace(/^.*?:\d+ /, ""))).toEqual(["request.clone().json"]);
  });
});
