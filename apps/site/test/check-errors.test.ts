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
    const r = checkErrors(page, core, oauth, []);
    expect(r.failures).toEqual([]);
    expect(r.counts).toEqual({ codes: 3, anchors: 3 });
  });

  it("refuses a code that ERRORS gains with no anchor on the page (plan 11a)", () => {
    const r = checkErrors(page, { ...core, new_code: 400 }, oauth, []);
    expect(r.failures).toEqual(["core code new_code has no anchor #new_code"]);
  });

  it("refuses an anchor that names no code, and a status that differs from the table", () => {
    const r = checkErrors(
      `${page}\n<h3 id="gone"><code>gone</code> 400</h3>`,
      core,
      {
        invalid_token: 400,
      },
      [],
    );
    expect(r.failures).toEqual([
      "#oauth-invalid_token says status 401; OAUTH_ERRORS says 400",
      "anchor #gone names no code",
    ]);
  });

  it("says a heading states no status, not undefined", () => {
    const r = checkErrors('<h3 id="a"><code>a</code></h3>', { a: 400 }, {}, []);
    expect(r.failures).toEqual(["#a states no status; ERRORS says 400"]);
  });

  it("fails on an empty page", () => {
    expect(checkErrors("", {}, {}, []).failures).toEqual(["read 0 codes", "read 0 anchors"]);
  });

  it("holds the storage codes: one anchor each, with no status, and no code of ERRORS (plan 12g)", () => {
    const storagePage = `${page}\n<h3 id="config_mismatch"><code>config_mismatch</code></h3>`;
    const r = checkErrors(storagePage, core, oauth, ["config_mismatch"]);
    expect(r.failures).toEqual([]);
    expect(r.counts).toEqual({ codes: 4, anchors: 4 });
    expect(checkErrors(page, core, oauth, ["config_mismatch"]).failures).toEqual([
      "storage code config_mismatch has no anchor #config_mismatch",
    ]);
    const withStatus = `${page}\n<h3 id="config_mismatch"><code>config_mismatch</code> 500</h3>`;
    expect(checkErrors(withStatus, core, oauth, ["config_mismatch"]).failures).toEqual([
      "#config_mismatch must state the code config_mismatch only; a storage code has no status",
    ]);
    expect(checkErrors(page, core, oauth, ["rate_limited"]).failures).toEqual([
      "storage code rate_limited is also in ERRORS; the anchor #rate_limited cannot be both",
    ]);
  });
});
