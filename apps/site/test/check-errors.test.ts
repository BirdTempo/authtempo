import { describe, expect, it } from "vitest";
import { checkErrors } from "../scripts/check-errors.ts";

const core = { invalid_token: 400, rate_limited: 429 };
const oauth = { invalid_token: 401 };
const page = `<h2 id="core">Core</h2>
<h3 id="invalid_token"><code>invalid_token</code> 400</h3>
<h3 id="rate_limited"><code>rate_limited</code> 429</h3>
<h3 id="oauth-invalid_token"><code>invalid_token</code> 401</h3>`;

describe("checkErrors", () => {
  it("passes a page with one anchor and the right status per code of both tables", () => {
    const r = checkErrors(page, core, oauth);
    expect(r.failures).toEqual([]);
    expect(r.counts).toEqual({ codes: 3, anchors: 3 });
  });

  it("refuses a code that ERRORS gains with no anchor on the page (plan 11a)", () => {
    const r = checkErrors(page, { ...core, new_code: 400 }, oauth);
    expect(r.failures).toEqual(["core code new_code has no anchor #new_code"]);
  });

  it("refuses an anchor that names no code, and a status that differs from the table", () => {
    const r = checkErrors(`${page}\n<h3 id="gone"><code>gone</code> 400</h3>`, core, {
      invalid_token: 400,
    });
    expect(r.failures).toEqual([
      "#oauth-invalid_token says status 401; OAUTH_ERRORS says 400",
      "anchor #gone names no code",
    ]);
  });

  it("fails on an empty page", () => {
    expect(checkErrors("", {}, {}).failures).toEqual(["read 0 codes", "read 0 anchors"]);
  });
});
