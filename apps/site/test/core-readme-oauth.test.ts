import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sentences, wordCount } from "../scripts/lib/markdown.ts";
import { REPO } from "../scripts/lib/paths.ts";

// The OAuth bullets of the core README against the code of plan 12e (Lows L3
// to L7 of the docs review of 86c5a94). A fact changed on one side only fails.
const README = readFileSync(`${REPO}packages/core/README.md`, "utf8");

/** The README bullet that starts with `start`. */
function bullet(start: string): string {
  const line = README.split("\n").find((l) => l.startsWith(`- ${start}`));
  expect({ start, found: line !== undefined }).toEqual({ start, found: true });
  return line ?? "";
}

const CIMD = "`POST /oauth/register` is off by default since plan 12e";
const CREDENTIALS = "The `client_credentials` grant (plan 12e";
const PAIRWISE = "Pairwise subjects (plan 12e";

describe("the OAuth bullets of the core README", () => {
  // Low L5 (ruling 52): the default resource answers a grant that names none.
  it("states the default resource beside invalid_target of client_credentials", () => {
    expect(bullet(CREDENTIALS)).toContain(
      "No `resource`, and no `oauth.defaultResource`, answers `invalid_target`.",
    );
  });

  // Low L6: Simplified Technical English holds a sentence to 25 words.
  it("holds each sentence of the CIMD, credentials, and pairwise bullets to 25 words", () => {
    for (const start of [CIMD, CREDENTIALS, PAIRWISE])
      for (const s of sentences(bullet(start)))
        expect({ s, short: wordCount(s) <= 25 }).toEqual({ s, short: true });
  });

  // Lows L3 and L4: each member that a document can lose, and the device codes of a drop to none.
  it("names each dropped member and the device codes of a drop to none", () => {
    const text = bullet(CIMD);
    for (const member of [
      "backchannel_logout_uri",
      "backchannel_logout_session_required",
      "sector_identifier_uri",
      "grant_types",
      "id_token_signed_response_alg",
      "response_types",
    ])
      expect({ member, named: text.includes(`\`${member}\``) }).toEqual({ member, named: true });
    expect(text).toContain("core revokes every refresh token and deletes every device code");
  });

  // Low L7: core does not export CIMD_REVISION, so the README does not name it.
  it("names no CIMD_REVISION", () => {
    expect(README).not.toContain("CIMD_REVISION");
  });
});
