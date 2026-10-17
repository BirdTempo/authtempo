import { describe, expect, it } from "vitest";
import { auth0Source } from "../../src/readers/auth0.js";
import { authjsSource } from "../../src/readers/authjs.js";
import { clerkSource } from "../../src/readers/clerk.js";
import { cognitoSource } from "../../src/readers/cognito.js";
import { jsonFaultOffset } from "../../src/readers/common.js";
import { firebaseSource } from "../../src/readers/firebase.js";
import { AUTH0_USERS, CLERK_CSV, CLERK_USERS } from "../fixtures/readers.js";
import { all } from "./all.js";

// An export path can name a secret file (plan 11e, the final review's L5).
// V8's parse text quotes up to 20 characters of the input. So each JSON
// reader gives a fixed text: the input key and the place, never the file.

/** A .env file named as an export. */
const SECRET = "DATABASE_URL=postgres://owner:Zq9xK7wV@db.example.net/app\nAUTH_SECRET=sk_9f8e7d\n";

/** Each run of four characters of the file: none may reach the fault text. */
function windows(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i + 4 <= text.length; i++) out.push(text.slice(i, i + 4));
  return out;
}

async function faultOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error("the reader did not throw");
}

describe("the JSON readers give a fixed fault text (plan 11e)", () => {
  const cases: [string, () => Promise<unknown>][] = [
    ["Cognito users", () => all(cognitoSource({ users: SECRET }))],
    [
      "firebase users",
      () => all(firebaseSource({ users: SECRET, hashConfig: { rounds: 8, memCost: 14 } })),
    ],
    ["Clerk users", () => all(clerkSource({ csv: CLERK_CSV, users: SECRET }))],
    [
      "Clerk organizations",
      () => all(clerkSource({ csv: CLERK_CSV, users: CLERK_USERS, organizations: SECRET })),
    ],
    ["Auth.js tables", () => all(authjsSource({ tables: SECRET }))],
    ["Auth0 organizations", () => all(auth0Source({ users: AUTH0_USERS, organizations: SECRET }))],
  ];

  for (const [input, run] of cases)
    it(`names the ${input} input and the place, and no character run of the file`, async () => {
      const message = await faultOf(run);
      expect(message).toBe(
        `authtempo import: the ${input} input is not JSON (the fault is at line 1, column 1)`,
      );
      for (const w of windows(SECRET)) expect(message).not.toContain(w);
    });

  it("places a fault on a later line and column", async () => {
    const message = await faultOf(() =>
      all(cognitoSource({ users: '{\n  "Users": [1,\n  x]\n}' })),
    );
    expect(message).toBe(
      "authtempo import: the Cognito users input is not JSON (the fault is at line 3, column 3)",
    );
  });
});

describe("jsonFaultOffset", () => {
  // The oracle is V8: where its text names a position, the offset equals it.
  const BAD = [
    '{"a":1,}',
    "[1,2",
    '{"a" 1}',
    '"ab\u0001"',
    "[1] x",
    '{\n  "a": 1,\n}',
    '["\\q"]',
    '"\\u12x4"',
    '"abc',
    "-",
    "1.",
    "1e",
    "",
    "   ",
    '{"a":01}',
  ];

  for (const text of BAD)
    it(`equals the V8 position for ${JSON.stringify(text)}`, () => {
      let message = "";
      try {
        JSON.parse(text);
      } catch (e) {
        message = (e as Error).message;
      }
      const m = /position (\d+)/.exec(message);
      const v8 =
        m === null ? (/end of JSON input/.test(message) ? text.length : null) : Number(m[1]);
      expect(v8, message).not.toBeNull();
      expect(jsonFaultOffset(text)).toBe(v8);
    });

  it("answers -1 for text that parses", () => {
    for (const text of ['{"a":[1,2.5e3,true,false,null,"x\\u00e9"]}', " 0 ", "[]"])
      expect(jsonFaultOffset(text)).toBe(-1);
  });
});
