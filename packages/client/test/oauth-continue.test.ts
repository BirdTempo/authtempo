import { describe, expect, it } from "vitest";
import { continueAuthorizeURL } from "../src/oauth/index.js";

const ID = `oq_${"a".repeat(43)}`;

describe("continueAuthorizeURL (plan 12e)", () => {
  it("builds <baseURL><basePath>/oauth/authorize?request_id=", () => {
    expect(continueAuthorizeURL({ baseURL: "https://api.example.com", requestId: ID })).toBe(
      `https://api.example.com/auth/oauth/authorize?request_id=${ID}`,
    );
    expect(
      continueAuthorizeURL({ baseURL: "https://api.example.com/", basePath: "/id", requestId: ID }),
    ).toBe(`https://api.example.com/id/oauth/authorize?request_id=${ID}`);
  });

  it("refuses an id that is not an oq_ id", () => {
    for (const requestId of [
      "",
      `or_${"a".repeat(43)}`,
      `oq_${"a".repeat(42)}`,
      `oq_${"a".repeat(44)}`,
      `oq_${"a".repeat(42)}&`,
      `${ID}&next=https://evil.example`,
    ])
      expect(() => continueAuthorizeURL({ baseURL: "https://api.example.com", requestId })).toThrow(
        TypeError,
      );
  });
});
