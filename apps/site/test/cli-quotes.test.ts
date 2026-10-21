import { readFileSync } from "node:fs";
import {
  bannedText,
  familyEndWarning,
  HELP,
  secretHashLine,
  USER_HEADER,
  userRow,
  writtenLine,
} from "@authtempo/cli";
import { describe, expect, it } from "vitest";
import { DOCS } from "../scripts/lib/paths.ts";

// The words that the CLI help and the docs pages share (ruling 62 of plan
// 12f). A text changed on one side only fails here.

/** The text of a page under docs/. */
const page = (path: string) => readFileSync(`${DOCS}docs/${path}`, "utf8");

/** The help of one command, by its words after `authtempo`. */
function helpOf(command: string) {
  const h = HELP.find((x) => x.command === command);
  if (!h) throw new Error(`no help for ${command}`);
  return h;
}

describe("the session text of a ban and a revoke (ruling 62 m4)", () => {
  // A ban and a revoke end one page of sessions in the call budget, and the
  // sweep ends the rest (ruling 44). No text may say that the act ends every session.
  const SENTENCE = "The act ends a page of the user's sessions, and the sweep ends the rest.";
  const CLAUSE = "the act ends a page of the user's sessions, and the sweep ends the rest.";

  it("holds the help of users ban and users platform-role to one sentence", () => {
    expect(helpOf("users ban").purpose).toContain(SENTENCE);
    const role = helpOf("users platform-role");
    expect(role.purpose).toContain(SENTENCE);
    expect(role.flags.find((f) => f.flag === "--revoke")?.says).toBe(
      `Revoke the role. ${SENTENCE}`,
    );
  });

  it("holds the users pages to the same words, and no page says every session", () => {
    for (const path of [
      "reference/cli/users-ban.md",
      "reference/cli/users-platform-role.md",
      "reference/cli/users.md",
    ]) {
      const text = page(path);
      expect({ path, has: text.toLowerCase().includes(CLAUSE.toLowerCase()) }).toEqual({
        path,
        has: true,
      });
      expect({ path, every: /every session of the user/.test(text) }).toEqual({
        path,
        every: false,
      });
    }
    expect(page("reference/cli/users-platform-role.md")).toContain(
      `| \`--revoke\` | Revoke the role. ${SENTENCE} |`,
    );
  });
});

describe("the CLI quotes of the operator runbooks (ruling 62 m7)", () => {
  /** A user row of the CLI table, with `ban` set. */
  const row = (ban: { at: string; reason: string | null; until: string | null } | null) =>
    userRow({
      id: "u1",
      email: "ada@example.com",
      emailVerified: true,
      name: null,
      createdAt: "2026-10-01T00:00:00.000Z",
      ban,
      platformOperator: false,
      secondFactor: [],
      sessions: 0,
      identities: [],
    });
  const AT = "2026-10-01T00:00:00.000Z";

  it("holds the BAN column words of the runbook and the list pages to the table of the CLI", () => {
    const ban = USER_HEADER.indexOf("BAN");
    expect(row({ at: AT, reason: "spam", until: null })[ban]).toBe("no-end");
    expect(row(null)[ban]).toBe("-");
    const runbook = page("operations/ban-a-user.mdx");
    expect(runbook).toContain("Read the `BAN` column: `no-end`, or the end of the ban.");
    expect(runbook).toContain("A `-` means that no ban holds.");
    for (const path of ["reference/cli/users-list.md", "reference/cli/users-search.md"])
      expect(page(path)).toContain("`BAN` is `-` for no ban, `no-end` for a ban with no end");
  });

  it("holds the column names that the runbooks read to the header of the CLI", () => {
    expect([...USER_HEADER]).toEqual(
      expect.arrayContaining(["ID", "BAN", "VERIFIED", "OPERATOR", "FACTORS"]),
    );
    expect(page("operations/first-operator.mdx")).toContain(
      "Read the columns `VERIFIED`, `OPERATOR`, and `FACTORS`.",
    );
    for (const path of ["operations/ban-a-user.mdx", "operations/second-factor-recovery.mdx"])
      expect(page(path)).toContain("Copy the user id from the `ID` column.");
  });

  it("holds the warning line of familyEndFailed in the runbook and the ban page to the CLI", () => {
    const line = familyEndWarning("<user id>");
    expect(line).toBe(
      "warning: the act ran, but the end of the OAuth refresh families failed (familyEndFailed); run authtempo sessions end <base url> <user id> with a secret of the sessions scope",
    );
    for (const path of ["operations/ban-a-user.mdx", "reference/cli/users-ban.md"])
      expect(page(path)).toContain(`\`\`\`text\n${line}\n\`\`\``);
  });

  it("holds the result lines that the runbooks quote to the CLI", () => {
    const done = writtenLine(bannedText("<user id>"), "<id>");
    expect(done).toBe("banned <user id>; audit row <id>");
    expect(page("operations/ban-a-user.mdx")).toContain(
      `The command prints \`${done}\` on stdout.`,
    );
    const hash = secretHashLine("<hex>");
    expect(hash).toBe("secretHash: <hex>");
    expect(page("operations/first-operator.mdx")).toContain(`stdout gets \`${hash}\`.`);
  });
});
