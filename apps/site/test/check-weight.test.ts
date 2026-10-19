import { describe, expect, it } from "vitest";
import { checkWeight, WEIGHT_MAX } from "../scripts/check-weight.ts";

const KIB = 1024;
/** A page of `bytes` bytes that links each file of `links`. */
function pageOf(bytes: number, links: readonly string[]): string {
  const head = links
    .map((l) =>
      l.endsWith(".css") ? `<link rel="stylesheet" href="${l}">` : `<script src="${l}"></script>`,
    )
    .join("");
  const shell = `<html><head>${head}</head><body></body></html>`;
  return shell.replace("<body>", `<body>${"x".repeat(bytes - shell.length)}`);
}
const sizes = (files: Record<string, number>) => (path: string) => files[path] ?? null;

describe("checkWeight", () => {
  it("holds the limit at 64 KiB", () => {
    expect(WEIGHT_MAX).toBe(65536);
  });

  it("passes a page of 10 KiB with a 20 KiB style file", () => {
    const r = checkWeight(
      new Map([["index.html", pageOf(10 * KIB, ["/_astro/a.css"])]]),
      sizes({ "/_astro/a.css": 20 * KIB }),
    );
    expect(r.failures).toEqual([]);
    expect(r.counts).toEqual({ pages: 1, largest_bytes: 30 * KIB });
  });

  it("fails a page of 70 KiB", () => {
    const r = checkWeight(new Map([["index.html", pageOf(70 * KIB, [])]]), sizes({}));
    expect(r.failures).toEqual(["index.html weighs 71680 bytes; the limit is 65536"]);
  });

  it("adds each linked file to the weight of the page", () => {
    const r = checkWeight(
      new Map([["index.html", pageOf(10 * KIB, ["/_astro/a.css", "/x.js"])]]),
      sizes({ "/_astro/a.css": 30 * KIB, "/x.js": 30 * KIB }),
    );
    expect(r.failures).toEqual(["index.html weighs 71680 bytes; the limit is 65536"]);
  });

  it("fails a page with a linked file that the build lacks", () => {
    const r = checkWeight(new Map([["index.html", pageOf(KIB, ["/_astro/gone.css"])]]), sizes({}));
    expect(r.failures).toEqual(["index.html links /_astro/gone.css, which the build lacks"]);
  });

  it("fails on zero pages", () => {
    expect(checkWeight(new Map(), sizes({})).failures).toEqual(["read 0 pages"]);
  });
});
