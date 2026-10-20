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

describe("the audit model is append-only (plan 12f Task 4, spec 26 item 8)", () => {
  it("names no update and no delete of the audit model in core", async () => {
    const { readdirSync, readFileSync }: SourceFs = await import(/* @vite-ignore */ FS_MODULE);
    const src = new URL("../src/", import.meta.url);
    const files = readdirSync(src, { recursive: true }).filter((file) => file.endsWith(".ts"));
    // The scan must read the writer: a list with no file finds no hit.
    expect(files).toContain("engine/operator/audit.ts");
    // The pattern spans lines, so a call split over two lines still matches.
    const hits = files.filter((file) =>
      /\.(update|delete)\(\s*["']operatorAudit["']/.test(readFileSync(new URL(file, src), "utf8")),
    );
    expect(hits).toEqual([]);
    // The sweep never reads the table, so no expiry removes a row.
    expect(readFileSync(new URL("engine/sweep.ts", src), "utf8")).not.toContain("operatorAudit");
  });
});
