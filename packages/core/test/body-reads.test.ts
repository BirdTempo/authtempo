import { describe, expect, it } from "vitest";
import { rawBodyReads } from "../../../scripts/body-reads.mjs";

/**
 * Every read of a request body in core goes through a capped reader (ruling
 * 46 Minor 1 of the 12j lane). The scan of scripts/body-reads.mjs reads the
 * source with the TypeScript compiler API and its type checker, and lists
 * each raw read of a Request. A raw read outside the allowed list fails.
 */

/** The specifier in a constant keeps the compiler API out of core's typecheck. */
const TS_MODULE = "typescript-api";
const pathOf = (relative: string) =>
  decodeURIComponent(new URL(relative, import.meta.url).pathname);
const TSCONFIG = pathOf("../tsconfig.json");

/** Each raw read that core may make, with the reason. Each entry must match one read. */
const ALLOWED: readonly { file: string; read: string; why: string }[] = [
  {
    file: "src/http/body-cap.ts",
    read: "request.body",
    why: "readBodyBytes: every route, the SAML form, and the SCIM body",
  },
  {
    file: "src/engine/social.ts",
    read: "own.arrayBuffer",
    why: "the body of an outgoing request that an app hook builds, not a client's request",
  },
];

const compilerApi = async (): Promise<unknown> =>
  ((await import(/* @vite-ignore */ TS_MODULE)) as { default: unknown }).default;

describe("the raw body reads of core (ruling 46 of the 12j lane)", () => {
  it("reads a request body only in the allowed reader files", { timeout: 60_000 }, async () => {
    const { files, reads } = rawBodyReads(await compilerApi(), TSCONFIG);
    console.log(`body-reads: files=${files} reads=${reads.length}\n${reads.join("\n")}`);
    expect(files).toBeGreaterThan(250);
    const allowed = (r: string) =>
      ALLOWED.some((a) => r.startsWith(`${a.file}:`) && r.endsWith(` ${a.read}`));
    expect(reads.filter((r) => !allowed(r))).toEqual([]);
    // Each entry matches one read, so an entry that no longer reads fails too.
    for (const a of ALLOWED)
      expect(
        reads.filter((r) => r.startsWith(`${a.file}:`) && r.endsWith(` ${a.read}`)),
      ).toHaveLength(1);
  });

  it("finds each form of a raw read of a Request, and no read of a Response", {
    timeout: 60_000,
  }, async () => {
    const fixture = pathOf("./fixtures/raw-body-reads.ts");
    const { reads } = rawBodyReads(await compilerApi(), TSCONFIG, [fixture]);
    expect(reads.map((r) => r.replace(/^.*?:\d+ /, ""))).toEqual([
      "request.json",
      "request.text",
      "request.formData",
      "request.arrayBuffer",
      "request.blob",
      "request.clone().json",
      "request.body",
      "{ body } = request",
      "maybe.text",
    ]);
  });
});
