import { readFileSync } from "node:fs";
import { openApiDocument, openApiJson, openApiReferenceOptions } from "@authtempo/core/openapi";
import { describe, expect, it } from "vitest";
import { checkOpenApi } from "../scripts/check-openapi.ts";

// The document of three features, from the generator, and the reference page of its two tables.
const json = openApiJson(
  openApiDocument({
    ...openApiReferenceOptions(),
    features: new Set(["session", "tokens", "operator"] as const),
  }),
);
const page = readFileSync(new URL("./fixtures/openapi/openapi.html", import.meta.url), "utf8");
// GET /session, POST /session/refresh, POST /sign-out, the five token routes, and the four operator routes.
const ROUTE_COUNT = 12;
const DIFFERS =
  "the built file differs from openApiDocument of openApiReferenceOptions(); build again";

/** A text with one part replaced. It throws when the part is not in the text. */
function edit(source: string, from: string, to: string): string {
  if (!source.includes(from)) throw new Error(`the fixture lacks ${from}`);
  return source.replace(from, to);
}

/** The page with the row of one table that starts with `first` deleted. */
function withoutRow(first: string): string {
  const row = new RegExp(`<tr>\\n<td><code dir="auto">${first}</code></td>[\\s\\S]*?</tr>\\n`);
  if (!row.test(page)) throw new Error(`the fixture has no row ${first}`);
  return page.replace(row, "");
}

describe("checkOpenApi", () => {
  it("passes when the built file equals the generator", () => {
    const r = checkOpenApi(json, json, page, ROUTE_COUNT);
    expect(r.failures).toEqual([]);
    expect(r.counts).toEqual({ operations: 12, routes: 12, schemes: 4, tags: 3 });
  });

  it("fails when the built file is absent", () => {
    expect(checkOpenApi(null, json, page, ROUTE_COUNT).failures).toEqual([
      "dist/docs/reference/openapi.json does not exist",
      "read 0 operations",
      "read 0 schemes",
      "read 0 tags",
    ]);
  });

  it("fails when the built file differs from the generator", () => {
    const changed = edit(json, '"title": "authtempo API"', '"title": "authtempo APi"');
    expect(checkOpenApi(changed, json, page, ROUTE_COUNT).failures).toEqual([DIFFERS]);
    expect(checkOpenApi("{", json, page, ROUTE_COUNT).failures).toEqual([
      DIFFERS,
      "the built file is not JSON",
      "read 0 operations",
      "read 0 schemes",
      "read 0 tags",
    ]);
  });

  it("fails when an operation is missing", () => {
    const doc = JSON.parse(json) as { paths: Record<string, unknown> };
    delete doc.paths["/tokens/current"];
    const r = checkOpenApi(JSON.stringify(doc), json, page, ROUTE_COUNT);
    expect(r.failures).toEqual([DIFFERS, "operations=11 of 12"]);
  });

  it("fails when the page's tag table differs from the document", () => {
    expect(checkOpenApi(json, json, withoutRow("operator"), ROUTE_COUNT).failures).toEqual([
      "tag operator has no row on the page",
    ]);
    const wrong = edit(
      page,
      '<td><code dir="auto">operator</code></td>\n<td>off</td>',
      '<td><code dir="auto">operator</code></td>\n<td>on</td>',
    );
    expect(checkOpenApi(json, json, wrong, ROUTE_COUNT).failures).toEqual([
      "tag operator: the page says default on; the document says off",
    ]);
    const key = edit(page, "<td>always on</td>", "<td>session</td>");
    expect(checkOpenApi(json, json, key, ROUTE_COUNT).failures).toEqual([
      "tag session: the page says config key session; the document says always on",
    ]);
    const tagRow = edit(
      page,
      '<td><code dir="auto">operator</code></td>\n<td><code dir="auto">operator</code></td>\n<td>off</td>\n</tr>\n',
      '<td><code dir="auto">operator</code></td>\n<td><code dir="auto">operator</code></td>\n<td>off</td>\n</tr>\n<tr>\n<td><code dir="auto">passkey</code></td>\n<td>passkey</td>\n<td>off</td>\n</tr>\n',
    );
    expect(checkOpenApi(json, json, tagRow, ROUTE_COUNT).failures).toEqual([
      "the page names tag passkey, which the document lacks",
    ]);
  });

  it("fails when the page's scheme table differs from the document", () => {
    expect(checkOpenApi(json, json, withoutRow("apiToken"), ROUTE_COUNT).failures).toEqual([
      "scheme apiToken has no row on the page",
    ]);
    const type = edit(
      page,
      '<td><code dir="auto">apiToken</code></td>\n<td><code dir="auto">http</code></td>',
      '<td><code dir="auto">apiToken</code></td>\n<td><code dir="auto">apiKey</code></td>',
    );
    expect(checkOpenApi(json, json, type, ROUTE_COUNT).failures).toEqual([
      "scheme apiToken: the page says type apiKey; the document says http",
    ]);
    const extra = edit(
      page,
      '<tr>\n<td><code dir="auto">operatorSecret</code></td>',
      '<tr>\n<td><code dir="auto">oauth</code></td>\n<td><code dir="auto">oauth2</code></td>\n<td>An access token</td>\n</tr>\n<tr>\n<td><code dir="auto">operatorSecret</code></td>',
    );
    expect(checkOpenApi(json, json, extra, ROUTE_COUNT).failures).toEqual([
      "the page names scheme oauth, which the document lacks",
    ]);
  });

  it("fails when the page lacks a table", () => {
    expect(
      checkOpenApi(
        json,
        json,
        edit(page, '<h2 id="tags">Tags</h2>', '<h2 id="t">T</h2>'),
        ROUTE_COUNT,
      ).failures,
    ).toEqual(["the page has no section Tags with a table"]);
  });

  it("fails at zero operations", () => {
    const empty = JSON.stringify({ ...JSON.parse(json), paths: {} });
    expect(checkOpenApi(empty, empty, page, 0).failures).toEqual([
      "read 0 operations",
      "read 0 routes",
    ]);
  });
});
