import { ERRORS, OAUTH_ERRORS } from "@authtempo/core/errors";
import { describe, expect, it } from "vitest";
import {
  DOCS_ORIGIN,
  ERROR_TEXT,
  ERROR_TEXTS,
  errorAnchor,
  errorDocsURL,
  errorText,
  LOCALES,
  type Locale,
  pickLocale,
  resolveLocale,
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

  it("tells a platform operator that operator_self is about the own account only (plan 12f)", () => {
    // An act on another platform operator answers operator_required, as the error page says.
    expect(errorText("operator_self")).toBe("You cannot do this action on your own account.");
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
  it("has a table for each locale, with a text for every code of both core tables and of an SDK", () => {
    expect(LOCALES).toEqual(["en"]);
    expect(ERROR_TEXTS.en).toBe(ERROR_TEXT);
    for (const locale of LOCALES) {
      const t = ERROR_TEXTS[locale];
      expect(Object.keys(t.core).sort()).toEqual(Object.keys(ERRORS).sort());
      expect(Object.keys(t.oauth).sort()).toEqual(Object.keys(OAUTH_ERRORS).sort());
      expect(Object.keys(t.sdk).sort()).toEqual(Object.keys(ERROR_TEXT.sdk).sort());
      for (const table of [t.core, t.oauth, t.sdk])
        for (const text of Object.values(table)) expect(text.trim().length).toBeGreaterThan(0);
    }
  });

  it("answers the text of a locale, with the table first for an OAuth code", () => {
    expect(errorText("invalid_token", "en")).toBe(ERROR_TEXTS.en.core.invalid_token);
    expect(errorText("invalid_token", "oauth", "en")).toBe(ERROR_TEXTS.en.oauth.invalid_token);
    expect(errorText("invalid_token", "oauth")).toBe(ERROR_TEXTS.en.oauth.invalid_token);
    expect(errorText("network", "en")).toBe(ERROR_TEXTS.en.sdk.network);
  });

  it("resolves a language tag to a locale of the list, else to English", () => {
    expect(resolveLocale("en")).toBe("en");
    expect(resolveLocale("EN-gb")).toBe("en");
    expect(resolveLocale("fr-FR")).toBe("en");
    expect(resolveLocale("")).toBe("en");
    expect(resolveLocale(undefined)).toBe("en");
  });

  it("matches a tag over a list of three languages: the exact tag, then its first part, else English", () => {
    // The public list holds English only, so the rule runs here over a list of three.
    const list = ["en", "fr", "pt-br"] as const;
    expect(pickLocale("fr", list)).toBe("fr");
    expect(pickLocale("FR-ca", list)).toBe("fr");
    expect(pickLocale("fr_FR", list)).toBe("fr");
    expect(pickLocale("pt-BR", list)).toBe("pt-br");
    expect(pickLocale("pt-PT", list)).toBe("en");
    expect(pickLocale("de", list)).toBe("en");
    expect(pickLocale(null, list)).toBe("en");
  });
  it("answers English, never a throw, for a locale outside LOCALES", () => {
    // A JavaScript caller, or a stored value, can pass a tag that the type refuses.
    expect(errorText("invalid_token", "en-US" as unknown as Locale)).toBe(
      ERROR_TEXT.core.invalid_token,
    );
    expect(errorText("invalid_token", "oauth", "de" as unknown as Locale)).toBe(
      ERROR_TEXT.oauth.invalid_token,
    );
  });
});
