// Plan 13b Task 12: the adversarial proofs of `authtempo audit export --format csv`. Each probe
// goes in each column. Then a real core writes rows with a formula in the user agent through its
// routes, and the export reads them back.
import { createHash } from "node:crypto";
import {
  type Auth,
  createAuth,
  createMemoryAdapter,
  createMemoryLimiter,
  createPbkdf2PasswordHash,
  type MailMessage,
} from "@authtempo/core";
import { describe, expect, it } from "vitest";
import { main } from "../src/main.js";
import { AUDIT_CSV_COLUMNS } from "../src/operator-tools.js";
import { fakeIo } from "./support/fake-io.js";

const BASE = "https://api.example.com";
const AUDITOR = "operator-auditor-0123456789abcdef-0123";
const ORG = "01J8Z3Q4R5S6T7V8W9X0Y1ORGA";
const AT = "2026-11-23T00:00:00.000Z";
const PW = "correct horse battery";
const FAST = createPbkdf2PasswordHash({ iterations: 1000 });
const hash = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/**
 * Each probe: the formula leads of the OWASP rule, CR, LF, CRLF, a quote, a comma, and a lead
 * after a `;` or a line break, which a reader with `;` as its separator reads as a field start.
 */
const PROBES = [
  "=1+1",
  "+1",
  "-1",
  "@SUM(A1)",
  "\t=1",
  "\r=1",
  "a\rb",
  "a\nb",
  "a\r\nb",
  'a"b',
  "a,b",
  "a;=1",
  'a;"=1',
  "a\n=1",
  "a;",
];

/** One row of `GET /operator/audit`, with the keys of the answer schema. */
function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "01J8Z3Q4R5S6T7V8W9X0Y1ROW1",
    createdAt: AT,
    updatedAt: AT,
    actorKind: "user",
    actorId: "01J8Z3Q4R5S6T7V8W9X0Y1USR1",
    action: "organization_member_add",
    targetUserId: "01J8Z3Q4R5S6T7V8W9X0Y1USR2",
    reason: "member added",
    data: { role: "member" },
    ip: "203.0.113.7",
    userAgent: "Mozilla/5.0",
    organizationId: ORG,
    ...over,
  };
}

/** An RFC 4180 reader: the records of a text, each record a list of cells. */
function readCsv(text: string): string[][] {
  const records: string[][] = [];
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      cells.push(cell);
      cell = "";
    } else if (c === "\n") {
      cells.push(cell);
      records.push(cells);
      cells = [];
      cell = "";
    } else cell += c;
  }
  cells.push(cell);
  records.push(cells);
  return records;
}

/**
 * The cell that a spreadsheet reads for `value`: a `'` after each `;`, CR, or LF that a formula
 * lead, a quote, or the cell end follows (ruling R29), then a leading `'` before a formula lead,
 * and each CR as `?`. The output scrub turns each control character of a line into `?` (ruling
 * R14). A tab stays.
 */
const expectedCell = (value: string) => {
  const split = value.replace(/([;\r\n])(?=[=+\-@\t\r"]|$)/g, "$1'");
  return (/^[=+\-@\t\r]/.test(split) ? `'${split}` : split).replaceAll("\r", "?");
};

/**
 * The cells of the record of `r`, in the order of the columns. The null rule: a null is an empty
 * cell. An empty string is an empty cell too, so the CSV does not tell a null from an empty
 * string. Only the JSON form keeps the difference. `data` is JSON text.
 */
const sourceCells = (r: Record<string, unknown>) =>
  AUDIT_CSV_COLUMNS.map((c) => {
    const v = r[c];
    return expectedCell(v === null ? "" : typeof v === "string" ? v : JSON.stringify(v));
  });

async function exportCsv(
  fetch: (url: string, init: RequestInit) => Promise<Response>,
  organization = ORG,
) {
  const io = fakeIo({ env: { AUTHTEMPO_OPERATOR_SECRET: AUDITOR }, fetch });
  const code = await main(
    ["audit", "export", BASE, "--organization", organization, "--format", "csv"],
    io,
  );
  return { code, io };
}

describe("authtempo audit export under attack (plan 13b Task 12)", () => {
  it("matrix: each probe in each column reads back as one cell, with a lead quote on a formula", async () => {
    for (const column of AUDIT_CSV_COLUMNS)
      for (const probe of PROBES) {
        const value = column === "data" ? { note: probe } : probe;
        const r = row({ [column]: value });
        const fetch = async () => Response.json({ rows: [r], next: null });
        const { code, io } = await exportCsv(fetch);
        const label = `${column} ${JSON.stringify(probe)}`;
        expect(code, label).toBe(0);
        const records = readCsv(io.stdout.join("\n"));
        expect(records, label).toHaveLength(2);
        const cells = records[1] ?? [];
        expect(cells, label).toHaveLength(AUDIT_CSV_COLUMNS.length);
        const at = AUDIT_CSV_COLUMNS.indexOf(column);
        // The data cell is JSON text: it starts with `{`, and JSON escapes each CR and LF. A `;`
        // in it still gets the guard.
        const want = expectedCell(column === "data" ? JSON.stringify(value) : probe);
        expect(cells[at], label).toBe(want);
        // Each other cell equals its source too.
        expect(cells, label).toEqual(sourceCells(r));
        // No cell starts with a formula lead.
        for (const cell of cells)
          expect(/^[=+\-@\t\r]/.test(cell), `${label}: ${cell}`).toBe(false);
      }
  });

  it("nulls: each null field of a reachable row gives an empty cell, the same cell as an empty string", async () => {
    // The row of an in-process revoke, as core writes it: no target, no IP, no user agent. Each
    // row of an organization export has the organization and an object in `data`, so the stub
    // sends no null there. The round trip below takes the same row from a real core.
    const revoke = {
      action: "organization_invitation_revoke",
      reason: "an organization revoked an invitation",
      data: { invitationId: "01J8Z3Q4R5S6T7V8W9X0Y1INV1" },
    };
    const nulls = row({ ...revoke, targetUserId: null, ip: null, userAgent: null });
    const empties = row({
      ...revoke,
      id: "01J8Z3Q4R5S6T7V8W9X0Y1ROW2",
      targetUserId: "",
      ip: "",
      userAgent: "",
    });
    const fetch = async () => Response.json({ rows: [nulls, empties], next: null });
    const { code, io } = await exportCsv(fetch);
    expect(code, io.stderr.join("\n")).toBe(0);
    const [, first, second] = readCsv(io.stdout.join("\n"));
    const cells = (id: string) => [
      id,
      AT,
      "user",
      "01J8Z3Q4R5S6T7V8W9X0Y1USR1",
      "organization_invitation_revoke",
      "",
      ORG,
      "an organization revoked an invitation",
      '{"invitationId":"01J8Z3Q4R5S6T7V8W9X0Y1INV1"}',
      "",
      "",
    ];
    expect(first).toEqual(cells("01J8Z3Q4R5S6T7V8W9X0Y1ROW1"));
    expect(second).toEqual(cells("01J8Z3Q4R5S6T7V8W9X0Y1ROW2"));
  });

  it("round trip: a real core writes a formula in the user agent through its routes, and the export quotes it", async () => {
    let current = new Date("2026-11-01T00:00:00.000Z");
    const clock = { now: () => current };
    const mails: MailMessage[] = [];
    const auth: Auth = createAuth({
      baseURL: BASE,
      trustedOrigins: ["https://app.example.com"],
      storage: createMemoryAdapter(),
      limiter: createMemoryLimiter(clock),
      clock,
      mail: { send: async (m) => void mails.push(m) },
      secret: "0123456789abcdef0123456789abcdef",
      password: { hash: FAST, uniformSignUp: false },
      organizations: {
        platformOrganization: "platform",
        platformRole: "operator",
        ranks: { viewer: 1, member: 2, admin: 3, owner: 4, operator: 5 },
      },
      operator: {
        secrets: [{ name: "auditor", secretHash: hash(AUDITOR), scopes: ["audit"] }],
        users: true,
      },
    });
    let n = 0;
    const verified = async (email: string) => {
      const password = auth.api.password;
      if (!password) throw new Error("no password api");
      n++;
      const up = await password.signUp({ email, password: PW, ip: `10.2.0.${n}`, userAgent: null });
      if (!up.ok) throw new Error(up.code);
      const mail = mails.findLast((m) => m.to === email)?.text ?? "";
      const token = decodeURIComponent(/token=([A-Za-z0-9_%-]+)/.exec(mail)?.[1] ?? "");
      const v = await password.verifyEmail({ token, ip: null, userAgent: null });
      if (!v.ok || v.value.signedIn === null) throw new Error("no verified session");
      current = new Date(current.getTime() + 1000);
      return {
        user: v.value.user,
        token: v.value.signedIn.token,
        session: v.value.signedIn.session,
      };
    };
    const ada = await verified("ada@example.com");
    const bo = await verified("bo@example.com");
    const made = await auth.api.createOrganization({
      user: ada.user,
      slug: "acme",
      name: "Acme",
    });
    if (!made.ok) throw new Error(made.code);
    const organizationId = made.value.organization.id;
    const act = async (path: string, body: Record<string, unknown>, userAgent: string) => {
      const res = await auth.handle(
        new Request(`${BASE}/auth${path}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${ada.token}`,
            "content-type": "application/json",
            origin: "https://app.example.com",
            "user-agent": userAgent,
            "cf-connecting-ip": "203.0.113.9",
          },
          body: JSON.stringify({ organizationId, ...body }),
        }),
      );
      expect([path, res.status]).toEqual([path, 200]);
    };
    const agents = ['=HYPERLINK("http://x.example","a")', "+1", "-1", "@SUM(1)"];
    await act(
      "/organizations/members/add",
      { userId: bo.user.id, role: "member" },
      agents[0] ?? "",
    );
    await act(
      "/organizations/members/role",
      { userId: bo.user.id, role: "admin" },
      agents[1] ?? "",
    );
    await act(
      "/organizations/invite",
      { email: "cy@example.com", role: "member" },
      agents[2] ?? "",
    );
    await act("/organizations/members/remove", { userId: bo.user.id }, agents[3] ?? "");
    // An in-process revoke has no IP, no user agent, and no target: a real row with three nulls.
    const dee = await auth.api.inviteMember({
      user: ada.user,
      organizationId,
      email: "dee@example.com",
      role: "member",
    });
    if (!dee.ok) throw new Error(dee.code);
    const revoked = await auth.api.revokeInvitation({
      user: ada.user,
      organizationId,
      invitationId: dee.value.id,
    });
    expect(revoked.ok).toBe(true);
    const fetch = async (url: string, init: RequestInit) => auth.handle(new Request(url, init));
    const { code, io } = await exportCsv(fetch, organizationId);
    expect(code, io.stderr.join("\n")).toBe(0);
    const records = readCsv(io.stdout.join("\n")).slice(1);
    const at = (c: (typeof AUDIT_CSV_COLUMNS)[number]) => AUDIT_CSV_COLUMNS.indexOf(c);
    expect(
      records.map((r) => [r[at("action")], r[at("userAgent")], r[at("ip")], r[at("targetUserId")]]),
    ).toEqual([
      ["organization_member_add", `'${agents[0]}`, "203.0.113.9", bo.user.id],
      ["organization_member_role_change", `'${agents[1]}`, "203.0.113.9", bo.user.id],
      ["organization_invitation_create", `'${agents[2]}`, "203.0.113.9", ""],
      ["organization_member_remove", `'${agents[3]}`, "203.0.113.9", bo.user.id],
      ["organization_invitation_create", "", "", ""],
      ["organization_invitation_revoke", "", "", ""],
    ]);
    // Each cell of each record equals its source: the JSON row of the operator route.
    const source = await auth.handle(
      new Request(`${BASE}/auth/operator/audit?organizationId=${organizationId}&limit=100`, {
        headers: { authorization: `Operator ${AUDITOR}` },
      }),
    );
    expect(source.status).toBe(200);
    const rows = ((await source.json()) as { rows: Record<string, unknown>[] }).rows;
    expect(rows.map((r) => [r.targetUserId, r.ip, r.userAgent]).slice(-1)).toEqual([
      [null, null, null],
    ]);
    expect(records).toEqual(rows.map(sourceCells));
  });
});
