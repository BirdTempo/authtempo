import { describe, expect, it } from "vitest";

/**
 * The two node:fs calls of the scan. Core's typecheck has no Node types,
 * because core runs on Workers; vitest runs in Node. A specifier in a
 * constant keeps the import out of the typecheck (operator-audit-source.test.ts).
 */
interface SourceFs {
  readdirSync(dir: URL): string[];
  readFileSync(file: URL, encoding: "utf8"): string;
}
const FS_MODULE = "node:fs";

/**
 * The password writes and hasher reads of one source text (plan 12f2,
 * Global Constraints: no operator path sets a password). A write is a
 * `create` or an `update` of the `password` model, also split over lines.
 * A hasher read is an import of the password hash seam, or a read of
 * `password.hash` or `password?.hash` of the config.
 */
function passwordWrites(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/\.(create|update)\(\s*["'`]password["'`]/g)) found.push(m[0]);
  for (const m of text.matchAll(/from\s+["'][^"']*seams\/password-hash[^"']*["']/g))
    found.push(m[0]);
  for (const m of text.matchAll(/password\??\.hash\b/g)) found.push(m[0]);
  return found;
}

describe("no operator path sets a password (plan 12f2 Task 4, spec 26)", () => {
  it("names no password write under engine/operator", async () => {
    const { readdirSync, readFileSync }: SourceFs = await import(/* @vite-ignore */ FS_MODULE);
    const dir = new URL("../src/engine/operator/", import.meta.url);
    const files = readdirSync(dir).filter((file) => file.endsWith(".ts"));
    // The scan must read the files of the acts: a list with no file finds no hit.
    expect(files).toContain("accounts.ts");
    expect(files).toContain("ban.ts");
    const hits = files.flatMap((file) =>
      passwordWrites(readFileSync(new URL(file, dir), "utf8")).map((hit) => `${file}: ${hit}`),
    );
    expect(hits).toEqual([]);
  });

  it("finds each form of a password write in a fixture text", () => {
    const fixture = [
      'await tx.update(\n  "password",\n  [{ field: "userId", op: "eq", value: id }],\n  { hash },\n);',
      'await config.storage.create("password", row);',
      'import { hashPassword } from "../../seams/password-hash.js";',
      "const hash = await config.password?.hash(plain);",
    ].join("\n");
    expect(passwordWrites(fixture)).toEqual([
      '.update(\n  "password"',
      '.create("password"',
      'from "../../seams/password-hash.js"',
      "password?.hash",
    ]);
  });
});
