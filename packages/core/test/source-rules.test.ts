import { describe, expect, it } from "vitest";

/**
 * The two node:fs calls of the scan. Core's typecheck has no Node types,
 * because core runs on Workers; vitest runs in Node. A specifier in a
 * constant keeps the import out of the typecheck (ip-key-sites.test.ts).
 */
interface SourceFs {
  readdirSync(dir: URL, options: { recursive: true }): string[];
  readFileSync(file: URL, encoding: "utf8"): string;
}
const FS_MODULE = "node:fs";

/**
 * The assertion forms that turn a nullable address into a string (plan 12i
 * Task 1). A user can have no address from schema version 15, so a read
 * of an address takes a guard (`hasAddress`), never an assertion.
 */
const ASSERTIONS = [".email!", "email as string", ".email as string"];

describe("the source rules of plan 12i", () => {
  it("no assertion on an address", async () => {
    const { readdirSync, readFileSync }: SourceFs = await import(/* @vite-ignore */ FS_MODULE);
    const src = new URL("../src/", import.meta.url);
    const files = readdirSync(src, { recursive: true }).filter((file) => file.endsWith(".ts"));
    // The scan must read the files that read an address: a list with no file finds no hit.
    expect(files).toContain("engine/users.ts");
    expect(files).toContain("engine/address.ts");
    const hits = files.flatMap((file) => {
      const text = readFileSync(new URL(file, src), "utf8");
      return ASSERTIONS.filter((form) => text.includes(form)).map((form) => `${file}: ${form}`);
    });
    expect(hits).toEqual([]);
  });
});
