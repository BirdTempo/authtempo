import { readFileSync } from "node:fs";
import { importUsers, readSource } from "@authtempo/import";
import { FIXTURE_EXPORTS } from "@authtempo/import/testing";
import { VECTORS } from "@authtempo/legacy-hashes/testing";
import { describe, expect, it } from "vitest";
import { call, harness } from "../support/harness.ts";
import { AUTHJS_FORMATS, createAuthjsAuth } from "./authjs.ts";

// The fixture export of the Authjs reader: Ida with the bcrypt2a vector in the app's password column.
const f = FIXTURE_EXPORTS.authjs;
const GUIDE = new URL("../../src/content/docs/docs/migrate/authjs.mdx", import.meta.url);

describe("move users from Auth.js", () => {
  it("signs an imported user in with the old password and rewrites the hash as PBKDF2", async () => {
    const h = harness();
    const report = await importUsers(h.storage, await readSource(f.bundle), {
      formats: AUTHJS_FORMATS,
    });
    expect({ passwords: report.created.password, refused: report.refusedHashes }).toEqual({
      passwords: 1,
      refused: [],
    });
    if (f.signIn === null) throw new Error("the fixture names no user that signs in");
    const { email, password } = f.signIn;

    const auth = createAuthjsAuth(h);
    const signIn = (p: string) =>
      call(auth, "POST", "/auth/password/sign-in", { email, password: p });
    expect((await signIn(VECTORS.bcrypt2a.wrong)).status).toBe(401);
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
    expect(AUTHJS_FORMATS).toEqual(f.formats);
  });

  it("gives the guide the formats of this sample", () => {
    const guide = readFileSync(GUIDE, "utf8");
    const flags = [...guide.matchAll(/--formats (\S+)/g)].map((m) => m[1]);
    expect(flags.length).toBeGreaterThan(0);
    for (const list of flags) expect(list).toBe(AUTHJS_FORMATS.join(","));
    const arrays = [...guide.matchAll(/`(\["[^`]*\])`/g)].map((m) => m[1]);
    for (const a of arrays) expect(a).toBe(JSON.stringify(AUTHJS_FORMATS).replaceAll(",", ", "));
  });

  it("moves the passkey only with --same-passkey-rp-id", async () => {
    // The fixture has no authenticator row. This test adds one for Ida, in the columns of the guide's select.
    const tables = JSON.parse(f.bundle.files.tables ?? "{}") as {
      users: { id: string }[];
      authenticators: unknown[];
    };
    const ida = tables.users[0]?.id ?? "";
    tables.authenticators = [
      {
        credentialID: "AQID",
        userId: ida,
        credentialPublicKey: "pQECAyYgASFYIPv/",
        counter: 7,
        credentialDeviceType: "multiDevice",
        credentialBackedUp: true,
        transports: "internal",
      },
    ];
    const files = { ...f.bundle.files, tables: JSON.stringify(tables) };
    const passkeyRow = (storage: ReturnType<typeof harness>["storage"]) =>
      storage.findOne("passkey", [{ field: "credentialId", op: "eq", value: "AQID" }]);

    const h = harness();
    const same = await importUsers(
      h.storage,
      await readSource({ ...f.bundle, files, samePasskeyRpId: true }),
      { formats: AUTHJS_FORMATS },
    );
    expect({ passkeys: same.created.passkey, dropped: same.dropped }).toEqual({
      passkeys: 1,
      dropped: [],
    });
    expect(await passkeyRow(h.storage)).not.toBeNull();

    const other = harness();
    // The same bundle with no samePasskeyRpId field, as a run without --same-passkey-rp-id writes it.
    const dropped = await importUsers(other.storage, await readSource({ ...f.bundle, files }), {
      formats: AUTHJS_FORMATS,
    });
    expect({ passkeys: dropped.created.passkey, dropped: dropped.dropped }).toEqual({
      passkeys: 0,
      dropped: [{ sourceId: ida, item: "passkey:rp_id_not_confirmed" }],
    });
    expect(await passkeyRow(other.storage)).toBeNull();
  });
});
