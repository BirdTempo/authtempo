import { ERRORS, OAUTH_ERRORS } from "@authtempo/core/errors";
import { describe, expect, it } from "vitest";
import {
  DOCS_ORIGIN,
  ERROR_TEXT,
  errorAnchor,
  errorDocsURL,
  errorText,
} from "../src/error-text.js";

describe("error texts and docs links (plan 11d)", () => {
  it("has one text for each code of both core tables and each code of an SDK", () => {
    expect(Object.keys(ERROR_TEXT.core).sort()).toEqual(Object.keys(ERRORS).sort());
    expect(Object.keys(ERROR_TEXT.oauth).sort()).toEqual(Object.keys(OAUTH_ERRORS).sort());
    expect(Object.keys(ERROR_TEXT.sdk).sort()).toEqual([
      "cancelled",
      "network",
      "redirect_mismatch",
      "unexpected",
    ]);
  });

  it("answers the text of a core code, of an OAuth code, and of an SDK code", () => {
    expect(errorText("rate_limited")).toBe(ERROR_TEXT.core.rate_limited);
    expect(errorText("invalid_token")).toBe(ERROR_TEXT.core.invalid_token);
    expect(errorText("invalid_token", "oauth")).toBe(ERROR_TEXT.oauth.invalid_token);
    expect(errorText("network")).toBe(ERROR_TEXT.sdk.network);
    expect(errorText("redirect_mismatch", "oauth")).toBe(ERROR_TEXT.sdk.redirect_mismatch);
  });

  it("links a core code to its anchor, an OAuth code to its prefixed anchor, and an SDK code to its page", () => {
    expect(errorDocsURL("invalid_token")).toBe(
      `${DOCS_ORIGIN}/docs/reference/errors/#invalid_token`,
    );
    expect(errorDocsURL("invalid_token", "oauth")).toBe(
      `${DOCS_ORIGIN}/docs/reference/errors/#oauth-invalid_token`,
    );
    expect(errorDocsURL("network")).toBe(`${DOCS_ORIGIN}/docs/reference/client/#results`);
    expect(errorDocsURL("cancelled", "oauth")).toBe(
      `${DOCS_ORIGIN}/docs/reference/client/#results`,
    );
    expect(errorDocsURL("redirect_mismatch")).toBe(
      `${DOCS_ORIGIN}/docs/reference/handoff/#failure-codes`,
    );
    expect(errorAnchor("rate_limited", "core")).toBe("rate_limited");
    expect(errorAnchor("rate_limited", "oauth")).toBe("oauth-rate_limited");
  });

  it("writes each text as one or two sentences that end with a period", () => {
    for (const table of [ERROR_TEXT.core, ERROR_TEXT.oauth, ERROR_TEXT.sdk])
      for (const text of Object.values(table)) expect(text).toMatch(/^[A-Z].*\.$/);
  });
});
