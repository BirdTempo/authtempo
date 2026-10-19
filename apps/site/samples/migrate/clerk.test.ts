import { readFileSync } from "node:fs";
import { importUsers, readSource } from "@authtempo/import";
import { FIXTURE_EXPORTS } from "@authtempo/import/testing";
import { VECTORS } from "@authtempo/legacy-hashes/testing";
import { describe, expect, it } from "vitest";
import { call, harness } from "../support/harness.ts";
import { CLERK_FORMATS, createClerkAuth } from "./clerk.ts";

// The fixture export of the Clerk reader: Kim with the bcrypt2b vector.
const f = FIXTURE_EXPORTS.clerk;
const GUIDE = new URL("../../src/content/docs/docs/migrate/clerk.mdx", import.meta.url);

describe("move users from Clerk", () => {
  it("signs an imported user in with the old password and rewrites the hash as PBKDF2", async () => {
    const h = harness();
    const report = await importUsers(h.storage, await readSource(f.bundle), {
      formats: CLERK_FORMATS,
    });
    expect({ passwords: report.created.password, refused: report.refusedHashes }).toEqual({
      passwords: 1,
      refused: [],
    });
    if (f.signIn === null) throw new Error("the fixture names no user that signs in");
    const { email, password } = f.signIn;

    const auth = createClerkAuth(h);
    const signIn = (p: string) =>
      call(auth, "POST", "/auth/password/sign-in", { email, password: p });
    expect((await signIn(VECTORS.bcrypt2b.wrong)).status).toBe(401);
    const first = await signIn(password);
    expect(first.status).toBe(200);
    const { user } = (await first.json()) as { user: { id: string } };
    const row = await h.storage.findOne("password", [
      { field: "userId", op: "eq", value: user.id },
    ]);
    expect(row?.hash.startsWith("pbkdf2-sha256$")).toBe(true);
    expect((await signIn(password)).status).toBe(200);
  });

  it("uses the formats of the fixture", () => {
    expect(CLERK_FORMATS).toEqual(f.formats);
  });

  it("gives the guide the formats of this sample", () => {
    const guide = readFileSync(GUIDE, "utf8");
    const flags = [...guide.matchAll(/--formats (\S+)/g)].map((m) => m[1]);
    expect(flags.length).toBeGreaterThan(0);
    for (const list of flags) expect(list).toBe(CLERK_FORMATS.join(","));
    const arrays = [...guide.matchAll(/`(\["[^`]*\])`/g)].map((m) => m[1]);
    for (const a of arrays) expect(a).toBe(JSON.stringify(CLERK_FORMATS).replaceAll(",", ", "));
  });
});
