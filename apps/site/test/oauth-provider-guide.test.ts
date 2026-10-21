import { readFileSync } from "node:fs";
import * as core from "@authtempo/core";
import { describe, expect, it } from "vitest";
import { DOCS, REPO } from "../scripts/lib/paths.ts";

// The OAuth provider guide against the code of plan 12e (the docs review of
// 86c5a94). A fact changed on one side only fails this test.
const GUIDE = readFileSync(`${DOCS}docs/guides/oauth-provider.mdx`, "utf8");
const ROUTE = readFileSync(`${REPO}packages/core/src/http/routes/oauth.ts`, "utf8");
/** A file of the core engine. */
const engine = (name: string) => readFileSync(`${REPO}packages/core/src/engine/${name}.ts`, "utf8");

/** The text of a `## ` section of the guide, from its heading to the next one. */
function section(heading: string): string {
  const start = GUIDE.indexOf(`\n## ${heading}\n`);
  expect({ heading, found: start >= 0 }).toEqual({ heading, found: true });
  const end = GUIDE.indexOf("\n## ", start + 1);
  return GUIDE.slice(start, end < 0 ? undefined : end);
}

describe("the OAuth provider guide", () => {
  // Rulings 46 and 47: a framed GET with no session gets a page with a top-level link.
  it("states the framed end-session page that core serves", () => {
    expect(ROUTE).toContain('kind: "framed"');
    const text = section("Sign-out at the provider");
    expect(text).toContain("`Sec-Fetch-Dest` other than `document`");
    expect(text).toContain("a page with a top-level link to the same GET");
    // The signed-out page is the last case: a framed request never gets it.
    expect(text.indexOf("Sec-Fetch-Dest")).toBeLessThan(text.indexOf("the signed-out page"));
  });

  // Low L1: each client auth route counts on its own per-IP key first.
  // The key is a family of limit() since plan 12h Task 7.
  it("names the per-IP key of each route that takes a client auth", () => {
    expect(engine("oauth-token")).toContain('"oauth-token:ip", ipKey(');
    expect(engine("oauth-introspect")).toContain('"oauth-introspect:ip", ipKey(');
    expect(ROUTE).toContain('"oauth-device:ip", ipKey(');
    expect(section("Confidential clients")).toContain(
      "The token and revoke routes count `oauth-token:ip`, introspection `oauth-introspect:ip`, and the device start `oauth-device:ip`.",
    );
  });

  // Low L2: introspection refuses `none` (RFC 7662 section 4), as the metadata states.
  it("states that introspection takes each method but none", () => {
    const wellKnown = readFileSync(`${REPO}packages/core/src/http/well-known.ts`, "utf8");
    expect(wellKnown).toContain('AUTH_METHODS.filter((m) => m !== "none")');
    const text = section("Confidential clients");
    expect(text).toContain("The token, revoke, and device routes take four client auth methods.");
    expect(text).toContain("The introspection route takes each method but `none`.");
  });

  // Low L3: the guide names each member that a metadata document can lose.
  it("names each member that core drops from a metadata document", () => {
    const src = engine("oauth-clients");
    const dropped = [
      ...[...src.matchAll(/dropped\.push\("([a-z_]+)"\)/g)].map((m) => m[1]),
      ...[...src.matchAll(/servedList\([^)]*, "([a-z_]+)", dropped\)/g)].map((m) => m[1]),
    ];
    expect(new Set(dropped)).toEqual(
      new Set([
        "backchannel_logout_uri",
        "backchannel_logout_session_required",
        "sector_identifier_uri",
        "grant_types",
        "id_token_signed_response_alg",
        "response_types",
      ]),
    );
    const text = section("Client metadata documents");
    for (const member of dropped)
      expect({ member, named: text.includes(`\`${member}\``) }).toEqual({ member, named: true });
  });

  // Low L4 (ruling 48 m1): a drop to `none` deletes the device codes too.
  it("names the device codes that a drop to none deletes", () => {
    expect(engine("oauth-clients")).toContain('await tx.delete("oauthDevice"');
    expect(section("Client metadata documents")).toMatch(
      /from `private_key_jwt` to `none`, core revokes every refresh token and deletes every device code/,
    );
  });

  // Low L7: a code name in the guide is one that an app can import.
  it("names only constants that @authtempo/core exports", () => {
    const names = [...GUIDE.matchAll(/`([A-Z][A-Z0-9]*_[A-Z0-9_]+)`/g)].map((m) => m[1] ?? "");
    for (const name of names)
      expect({ name, exported: name in core }).toEqual({ name, exported: true });
  });
});
