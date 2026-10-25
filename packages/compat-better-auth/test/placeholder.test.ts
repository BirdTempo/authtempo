import { StorageError } from "@authtempo/core";
import { describe, expect, it, vi } from "vitest";
import { anonymous, emailOTP, magicLink, phoneNumber } from "../src/plugins.js";
import { checkOptions } from "../src/server/check-options.js";
import { PLACEHOLDER_ADDRESS_TEXT } from "../src/server/hooks.js";
import { isPlaceholder, placeholderFor } from "../src/storage/placeholder.js";
import type { BetterAuthOptions, EmailCallbackData } from "../src/types.js";
import { at } from "./mapping-cases.js";
import {
  BASE,
  betterAuth,
  betterAuthTables,
  browser,
  fastHash,
  json,
  PASSWORD,
  signInOptions,
} from "./sign-in-helpers.js";

// Plan 12i Task 16, deviation 7: Better Auth's user.email is NOT NULL, and
// core's address is nullable. The storage writes Better Auth's placeholder
// for a null and reads every placeholder back as null.

const userRow = (id: string, email: string | null) => ({
  id,
  email,
  emailVerified: false,
  name: null,
  image: null,
  bannedAt: null,
  banReason: null,
  banUntil: null,
  username: null,
  displayUsername: null,
  phone: null,
  isAnonymous: true,
  createdAt: at,
  updatedAt: at,
});

describe("the placeholder address", () => {
  it("writes the placeholder for a null address and reads it back as null", async () => {
    const t = await betterAuthTables();
    const s = t.database.storage;
    await s.create("user", userRow("u-1", null));
    expect(t.row('SELECT email FROM "user" WHERE id = ?', "u-1")).toEqual({
      email: "u-1@anonymous.placeholder.invalid",
    });
    expect(await s.findOne("user", [{ field: "id", op: "eq", value: "u-1" }])).toMatchObject({
      email: null,
    });
    expect(
      (await s.findMany("user", [{ field: "email", op: "eq", value: null }])).map((u) => u.id),
    ).toEqual(["u-1"]);
    // A placeholder value matches no row: core never finds a user by it.
    expect(
      await s.findOne("user", [
        { field: "email", op: "eq", value: "u-1@anonymous.placeholder.invalid" },
      ]),
    ).toBeNull();
    // A person's address never takes the form: a write of one fails before any statement.
    await expect(
      s.create("user", userRow("u-2", "u-9@anonymous.placeholder.invalid")),
    ).rejects.toMatchObject({ name: "StorageError", code: "invalid_argument", model: "user" });
    await expect(
      s.update("user", [{ field: "id", op: "eq", value: "u-1" }], { email: null }),
    ).rejects.toBeInstanceOf(StorageError);
    // The emailDomainName form: betterAuth sets the rule of the storage.
    betterAuth(
      signInOptions(t.database, { plugins: [anonymous({ emailDomainName: "anon.example.com" })] }),
    );
    await s.create("user", userRow("u-3", null));
    expect(t.row('SELECT email FROM "user" WHERE id = ?', "u-3")).toEqual({
      email: "temp-u-3@anon.example.com",
    });
    expect(
      (await s.findMany("user", [{ field: "email", op: "eq", value: null }]))
        .map((u) => u.id)
        .sort(),
    ).toEqual(["u-1", "u-3"]);
    expect([
      isPlaceholder("temp-u-3@anon.example.com", "anon.example.com", "u-3"),
      isPlaceholder("temp-u-3@anon.example.com", "anon.example.com", "u-9"),
      isPlaceholder("temp-sales@anon.example.com", "anon.example.com", "u-3"),
      isPlaceholder("staff@anon.example.com", "anon.example.com", "u-3"),
      isPlaceholder("x@tiktok.placeholder.invalid", null, null),
      placeholderFor("u-4", null),
    ]).toEqual([true, false, false, false, true, "u-4@anonymous.placeholder.invalid"]);
  });

  it("reads temp-<id>@<emailDomainName> as no address only on the row of that id (ruling 42 M1)", async () => {
    const t = await betterAuthTables();
    const s = t.database.storage;
    betterAuth(
      signInOptions(t.database, { plugins: [anonymous({ emailDomainName: "anon.example.com" })] }),
    );
    // A person's own address of the temp- form, verified, as Better Auth stored it;
    // a row with its own temp- form; a row with the temp- form of another row's id.
    t.db.exec(`
      INSERT INTO "user" ("id","name","email","emailVerified","image","createdAt","updatedAt")
        VALUES ('ba-sales','Sales','temp-sales@anon.example.com',1,NULL,'2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z'),
               ('u-7','Anon','temp-u-7@anon.example.com',0,NULL,'2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z'),
               ('u-8','Other','TEMP-U-7@anon.example.com',0,NULL,'2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z');
    `);
    const byId = async (id: string) =>
      (await s.findOne("user", [{ field: "id", op: "eq", value: id }]))?.email;
    expect([await byId("ba-sales"), await byId("u-7"), await byId("u-8")]).toEqual([
      "temp-sales@anon.example.com",
      null,
      "TEMP-U-7@anon.example.com",
    ]);
    expect(await s.findOne("user", [{ field: "id", op: "eq", value: "ba-sales" }])).toMatchObject({
      emailVerified: true,
    });
    // A lookup by address finds the person, never the row whose own placeholder it is.
    const byEmail = async (email: string) =>
      (await s.findMany("user", [{ field: "email", op: "eq", value: email }])).map((u) => u.id);
    expect(await byEmail("temp-sales@anon.example.com")).toEqual(["ba-sales"]);
    expect(await byEmail("temp-u-7@anon.example.com")).toEqual([]);
    expect(
      (
        await s.findMany("user", [
          {
            field: "email",
            op: "in",
            value: ["temp-u-7@anon.example.com", "TEMP-U-7@anon.example.com"],
          },
        ])
      ).map((u) => u.id),
    ).toEqual(["u-8"]);
    // A write of a row's own temp- form fails; the temp- form of another id is an address.
    await expect(
      s.create("user", { ...userRow("u-5", "temp-u-5@anon.example.com"), isAnonymous: false }),
    ).rejects.toMatchObject({ name: "StorageError", code: "invalid_argument", model: "user" });
    await expect(
      s.update("user", [{ field: "id", op: "eq", value: "u-8" }], {
        email: "temp-u-8@anon.example.com",
      }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(
      s.update("user", [{ field: "name", op: "eq", value: "Other" }], {
        email: "temp-x@anon.example.com",
      }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
    await s.update("user", [{ field: "id", op: "eq", value: "u-8" }], {
      email: "temp-sales2@anon.example.com",
    });
    expect(await byId("u-8")).toBe("temp-sales2@anon.example.com");
  });

  it("refuses a sign-up and a change of address in a placeholder form with 403, not 500 (ruling 42 L1)", async () => {
    const t = await betterAuthTables();
    const errors = vi.spyOn(console, "error");
    const verifies: EmailCallbackData[] = [];
    const codes: { email: string; otp: string }[] = [];
    const auth = betterAuth(
      signInOptions(
        t.database,
        {
          plugins: [
            anonymous({ emailDomainName: "anon.example.com" }),
            emailOTP({
              sendVerificationOTP: async (d) => void codes.push(d),
              changeEmail: { enabled: true },
            }),
          ],
          user: { changeEmail: { enabled: true } },
        },
        verifies,
      ),
    );
    const { send } = browser(auth.handler);
    const refused = { error: "hook_refused", message: PLACEHOLDER_ADDRESS_TEXT };
    for (const email of ["eve@x.placeholder.invalid", "eve@placeholder.invalid"]) {
      const res = await send("/password/sign-up", { email, password: PASSWORD });
      expect([res.status, await json(res)]).toEqual([403, refused]);
    }
    await expect(
      auth.api.signUpEmail({
        body: { email: "eve@x.placeholder.invalid", password: PASSWORD, name: "Eve" },
      }),
    ).rejects.toMatchObject({ status: "FORBIDDEN", body: { code: "HOOK_REFUSED" } });
    expect(t.row('SELECT count(*) AS n FROM "user"')).toEqual({ n: 0 });
    // temp-sales is a person's address at the domain: it signs up.
    const ok = await send("/password/sign-up", {
      email: "temp-sales@anon.example.com",
      password: PASSWORD,
    });
    expect(ok.status).toBe(200);
    const id = ((await json(ok)).user as { id: string }).id;
    expect((await send("/password/verify", { token: verifies[0]?.token })).status).toBe(200);
    // The link change: refused before core mails the new address.
    const own = `temp-${id.toLowerCase()}@anon.example.com`;
    for (const newEmail of [own, "eve@x.placeholder.invalid"]) {
      const res = await send("/user/change-email", { newEmail });
      expect([res.status, await json(res)]).toEqual([403, refused]);
      // Better Auth's own path, in Better Auth's shape (ruling 44 L-A).
      const own = await send("/change-email", { newEmail });
      expect([own.status, await json(own)]).toEqual([
        403,
        { code: "HOOK_REFUSED", message: PLACEHOLDER_ADDRESS_TEXT },
      ]);
    }
    expect(verifies).toHaveLength(1);
    // A real address still goes through Better Auth's path, and core mails it.
    expect((await send("/change-email", { newEmail: "sales@example.com" })).status).toBe(200);
    expect(verifies).toHaveLength(2);
    // The code change: the code goes out, and core's user hook refuses the commit.
    await send("/email-otp/request-email-change", { newEmail: own });
    const code = codes.find((c) => c.email === own)?.otp;
    const res = await send("/email-otp/change-email", { newEmail: own, otp: code });
    expect([res.status, (await json(res)).code]).toEqual([403, "HOOK_REFUSED"]);
    expect(t.row('SELECT email FROM "user" WHERE id = ?', id)).toEqual({
      email: "temp-sales@anon.example.com",
    });
    expect(errors.mock.calls.flat().join(" ")).not.toMatch(/unhandled error/);
    errors.mockRestore();
  });

  it("reads a getTempEmail address back as null", async () => {
    const t = await betterAuthTables();
    // A row as Better Auth 1.7.2's phone-number plugin writes it at a sign-up by
    // code (routes.mjs:363 to :369): getTempEmail's address and a proved number.
    t.db.exec(`
      INSERT INTO "user" ("id","name","email","emailVerified","image","createdAt","updatedAt","phoneNumber","phoneNumberVerified")
        VALUES ('ba-phone','+14155550199','+14155550199@phone.placeholder.invalid',0,NULL,'2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z','+14155550199',1);
    `);
    expect(
      await t.database.storage.findOne("user", [{ field: "id", op: "eq", value: "ba-phone" }]),
    ).toMatchObject({ email: null, emailVerified: false, phone: "+14155550199" });
  });

  it("refuses a getTempEmail on another domain", () => {
    const refusals = (getTempEmail: (n: string) => string) =>
      checkOptions({
        baseURL: BASE,
        secret: "s",
        plugins: [phoneNumber({ sendOTP: () => {}, signUpOnVerification: { getTempEmail } })],
        authtempo: { phone: { regions: ["+1"] } },
      } as BetterAuthOptions).refusals.filter((r) => r.startsWith("plugins"));
    expect(refusals((n) => `${n}@phone.placeholder.invalid`)).toEqual([]);
    expect(refusals((n) => `${n}@example.com`)).toEqual([
      "plugins[phone-number].signUpOnVerification.getTempEmail: must answer an address on placeholder.invalid or a subdomain of it, such as <number>@phone.placeholder.invalid; core keeps no address for a phone user, and any other domain would read back as a real address",
    ]);
  });

  it("a placeholder never reaches core: no mail goes to a user with no address, and a placeholder row stays unverified", async () => {
    const t = await betterAuthTables();
    // A TikTok user as Better Auth 1.7.2 wrote it (social-providers/tiktok.mjs:61 to :67).
    t.db.exec(`
      INSERT INTO "user" ("id","name","email","emailVerified","image","createdAt","updatedAt")
        VALUES ('ba-tt','Tik','tt-1@tiktok.placeholder.invalid',0,NULL,'2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z');
    `);
    const deletes: unknown[] = [];
    const links: { url: string }[] = [];
    const codes: string[] = [];
    const auth = betterAuth(
      signInOptions(t.database, {
        plugins: [
          anonymous(),
          magicLink({ sendMagicLink: async (d) => void links.push(d) }),
          phoneNumber({
            sendOTP: (d) => void codes.push(d.code),
            signUpOnVerification: { getTempEmail: (n) => `${n}@phone.placeholder.invalid` },
          }),
        ],
        authtempo: { passwordHash: fastHash, phone: { regions: ["+1"] } },
        user: {
          deleteUser: {
            enabled: true,
            sendDeleteAccountVerification: async (d) => void deletes.push(d),
          },
        },
      }),
    );
    // An anonymous user in Better Auth's shape shows the placeholder; core reads none.
    const b = browser(auth.handler);
    const anon = (await json(await b.send("/sign-in/anonymous", {}))).user as {
      id: string;
      email: string;
    };
    expect(anon.email).toBe(`${anon.id}@anonymous.placeholder.invalid`);
    const session = await json(await b.send("/session"));
    expect((session.user as { email: unknown }).email).toBeNull();
    // A phone user has no address: its delete mails no confirm link, and a
    // fresh session deletes it at once (ruling 15 of plan 12i).
    const p = browser(auth.handler);
    await p.send("/phone-number/send-otp", { phoneNumber: "+14155550177" });
    await vi.waitFor(() => expect(codes).toHaveLength(1));
    await p.send("/phone-number/verify", { phoneNumber: "+14155550177", code: codes[0] });
    const del = await p.send("/delete-user", {});
    expect([del.status, await json(del)]).toEqual([
      200,
      { success: true, message: "User deleted" },
    ]);
    expect(deletes).toEqual([]);
    // A link to the TikTok placeholder finds no user, so it cannot verify the row.
    const other = browser(auth.handler);
    await other.send("/magic-link/request", { email: "tt-1@tiktok.placeholder.invalid" });
    const token = links[0] ? (new URL(links[0].url).searchParams.get("token") ?? "") : "";
    const verify = await other.send("/magic-link/verify", { token });
    expect(verify.status).not.toBe(200);
    expect(t.row('SELECT email, emailVerified FROM "user" WHERE id = ?', "ba-tt")).toEqual({
      email: "tt-1@tiktok.placeholder.invalid",
      emailVerified: 0,
    });
    expect(other.jar.cookies.size).toBe(0);
  });
});
