import { beforeAll, describe, expect, it } from "vitest";
import { everyFlow } from "./flows.js";
import { EXCHANGES, type Exchange } from "./helpers.js";

/** The path of the request of one exchange. */
const pathOf = (e: Exchange) => new URL(e.url).pathname;

/**
 * Each link token and each code that the mailbox showed in this file. The
 * mail texts of core put a token after "token=" or "invitation=", and a code
 * after "is" ("Your code is 123456.").
 */
function mailed(): Set<string> {
  const found = new Set<string>();
  for (const e of EXCHANGES.filter((x) => pathOf(x) === "/mailbox")) {
    for (const m of e.body.matchAll(/[?&](?:amp;)?(?:token|invitation)=([A-Za-z0-9_-]{16,})/g))
      found.add(m[1] ?? "");
    for (const m of e.body.matchAll(/\bis (\d{6,8})\b/g)) found.add(m[1] ?? "");
  }
  return found;
}

/** True when `text` holds `value` as a whole token, not inside a longer word or number. */
function holds(text: string, value: string): boolean {
  const at = new RegExp(`(?<![A-Za-z0-9_-])${value}(?![A-Za-z0-9_-])`);
  return at.test(text);
}

// Spec 24 item 9 and final review m2 of plan 11b. The mailbox page is the
// only place where a link or a code of a mail appears. Each answer of every flow
// outside /mailbox (the status, the headers, and the body) holds no such
// value. An answer may hold a value that its own request sent, as the
// confirm page holds the token of its URL.
describe("the mailbox", () => {
  beforeAll(async () => {
    await everyFlow();
  });

  it("reads the links and codes of every flow", () => {
    const secrets = mailed();
    // everyFlow mails 2 address links, 1 reset link, 3 magic links, 2 codes, and 1 invitation.
    expect(secrets.size).toBe(9);
    const kinds = [...secrets].map((v) => (/^\d+$/.test(v) ? "code" : v.split("_")[0]));
    expect(kinds.sort()).toEqual(["code", "code", "inv", "ml", "ml", "ml", "pr", "pv", "pv"]);
  });

  it("is the only answer that holds a link or a code of a mail", () => {
    const secrets = [...mailed()];
    const leaks: string[] = [];
    for (const e of EXCHANGES) {
      if (pathOf(e) === "/mailbox") continue;
      const asked = `${e.url}\n${e.sent}`;
      const answer = [String(e.status), ...e.headers.map(([n, v]) => `${n}: ${v}`), e.body].join(
        "\n",
      );
      for (const s of secrets)
        if (!asked.includes(s) && holds(answer, s)) leaks.push(`${e.method} ${pathOf(e)}: ${s}`);
    }
    expect(EXCHANGES.length).toBeGreaterThan(50);
    expect(leaks).toEqual([]);
  });
});
