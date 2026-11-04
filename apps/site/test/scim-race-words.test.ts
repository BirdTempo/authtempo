import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DOCS, REPO } from "../scripts/lib/paths.ts";

// The errors page and the SCIM guide state the SCIM answer of a lost race.
// Each sentence is held to the source that answers it (decision 1 of plan
// 12o). A change of the detail or of the scimType fails here until the pages
// say the new rule.

/** The text of a file with each run of white space as one space: a line wraps. */
const flat = (path: string) => readFileSync(path, "utf8").replace(/\s+/g, " ");
const ENGINE = `${REPO}packages/core/src/engine/`;

/** The detail of the code `conflict` on a SCIM route. */
const DETAIL = "Another request changed this user at the same time. Send the request again.";

/** The text of the errors page from the heading of `code` to the next heading. */
function errorSection(code: string): string {
  const text = flat(`${DOCS}docs/reference/errors.md`);
  const at = text.indexOf(`<h3 id="${code}">`);
  if (at < 0) throw new Error(`no entry ${code} on the errors page`);
  const end = text.indexOf("<h3 ", at + 1);
  return text.slice(at, end < 0 ? undefined : end);
}

const ERRORS_WORDS = `**On a SCIM route:** The code answers 409 in the SCIM error message, with no \`scimType\`. Its \`detail\` is "${DETAIL}" A resend can pass, so the directory sends the same request again.`;

const GUIDE_WORDS = `A create can race another request on the same user. On D1, a magic link or another proof can verify an unverified user before the create claims it. On any store, an account delete of the user can stop the create. Core then answers 409 with no \`scimType\`, and keeps no row of the create. The \`detail\` is "${DETAIL}" The directory sends the same request again. On D1, that request links the verified user. A \`userName\` in use still answers 409 \`uniqueness\`, and a resend does not pass.`;

const ERROR_FORM_WORDS =
  "A SCIM route answers the SCIM error message of RFC 7644. A value in use has the `scimType` `uniqueness`, and a race has no `scimType`.";

describe("the SCIM race answer on the pages (decision 1 of plan 12o)", () => {
  const scim = flat(`${ENGINE}scim/users.ts`);
  const users = flat(`${ENGINE}users.ts`);

  it("is the detail of failAnswer for the code conflict, with no scimType", () => {
    expect(scim).toContain(`const RACE_DETAIL = "${DETAIL}";`);
    expect(scim).toContain('if (r.code === "conflict") return scimFail(r.status, RACE_DETAIL);');
    // A value in use keeps `uniqueness` (uniqueAnswer).
    expect(scim).toContain(
      '"another User of this organization has the userName", "uniqueness", );',
    );
  });

  it("names the two causes of the guide as the engine stops them", () => {
    // On D1 a lost claim answers conflict, with no claim retry.
    expect(users).toContain('if (storage.queryLimitPerInvocation === true) return "conflict";');
    // On any store a user that an account delete took answers conflict at the claim.
    expect(users).toContain(
      'if (!(await tx.findOne("user", [{ field: "id", op: "eq", value: userId }]))) stopWith("conflict");',
    );
  });

  it("is in the conflict entry of the errors page", () => {
    expect(errorSection("conflict")).toContain(ERRORS_WORDS);
  });

  it("is in the race paragraph and the error form of the SCIM guide", () => {
    const guide = flat(`${DOCS}docs/guides/scim.mdx`);
    expect(guide).toContain(GUIDE_WORDS);
    expect(guide).toContain(ERROR_FORM_WORDS);
  });
});
