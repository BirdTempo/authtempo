import { describe, expect, it } from "vitest";
import { parseReturnedUrl } from "../src/redirect.js";

describe("parseReturnedUrl", () => {
  it("accepts the redirect with a query, and a dev redirect that already has one", () => {
    expect(parseReturnedUrl("consumera://auth", "consumera://auth?code=hc_1")).toEqual({
      ok: true,
      params: { code: "hc_1" },
    });
    expect(
      parseReturnedUrl(
        "http://127.0.0.1:5000/auth?x=1",
        "http://127.0.0.1:5000/auth?x=1&code=hc_2",
      ),
    ).toEqual({
      ok: true,
      params: { x: "1", code: "hc_2" },
    });
    expect(parseReturnedUrl("consumera://auth", "consumera://auth")).toEqual({
      ok: true,
      params: {},
    });
  });
  it("decodes percent-encoding and keeps the first value of a repeated key", () => {
    expect(parseReturnedUrl("a://auth", "a://auth?code=hc%5F1&code=hc_2")).toEqual({
      ok: true,
      params: { code: "hc_1" },
    });
  });
  it("refuses another host, another path, a prefix that is not a boundary, and a fragment trick (Review Focus 3)", () => {
    for (const url of [
      "consumera://evil?code=hc_1",
      "consumera://auth.example?code=hc_1",
      "consumera://authx?code=hc_1",
      "consumera://auth/../other?code=hc_1",
      "consumera://auth#?code=hc_1",
      "CONSUMER_A://auth?code=hc_1",
      "https://evil.example/consumera://auth?code=hc_1",
    ]) {
      expect(parseReturnedUrl("consumera://auth", url)).toEqual({ ok: false });
    }
  });
});
