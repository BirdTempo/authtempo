import { describe, expect, it } from "vitest";
import { z } from "zod";
import { scimBase } from "../src/engine/scim/discovery.js";
import { acsUrl, spEntityId } from "../src/engine/sso/connections.js";
import { ssoCallbackUrl } from "../src/engine/sso/oidc.js";
import { fillGuide, GUIDES, guideOf, type SpField } from "../src/sso/guides/index.js";
import { makeAuth } from "./helpers.js";

/**
 * The guide records of plan 13a Task 6. The age rule of `checkedOn` (180
 * days) is the release check of Task 13, not this file: a test must not
 * fail from the date alone (spec 6.3 item 4).
 */

const SP_FIELDS = ["acsUrl", "entityId", "redirectUri", "scimBaseUrl", "scimToken"] as const;
const START = "/sso/<id>/start";
const GAP = "Gap: ";

/** A real calendar date: the parse gives back the same text. */
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    const d = new Date(`${s}T00:00:00.000Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, "not a real date");

const guideSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  kinds: z.array(z.enum(["oidc", "saml"])).min(1),
  checkedOn: isoDate,
  fields: z.strictObject({
    acsUrl: z.string(),
    entityId: z.string(),
    redirectUri: z.string(),
    scimBaseUrl: z.string(),
    scimToken: z.string(),
  }),
  steps: z
    .array(
      z.strictObject({
        text: z.string().min(1),
        value: z.enum(SP_FIELDS).optional(),
        unconfirmed: z.string().min(1).optional(),
      }),
    )
    .min(1),
  launch: z.string(),
  launchUnconfirmed: z.string().min(1).optional(),
  directory: z.string().min(1).nullable(),
});

/**
 * The gerund lint list (ASD-STE100: no -ing word as a noun). It reads the
 * text outside double quotes, because a quoted part is the provider's own
 * label and must stay as the provider writes it.
 */
const ING_ALLOWED = new Set<string>([]);
function gerunds(text: string): string[] {
  const outside = text.replace(/"[^"]*"/g, " ");
  return (outside.match(/\b[A-Za-z]+ings?\b/g) ?? []).filter(
    (w) => !ING_ALLOWED.has(w.toLowerCase()),
  );
}

function words(text: string): number {
  return text.trim().split(/\s+/).length;
}

describe("the IdP guides (plan 13a Task 6)", () => {
  it("five guides: the ids, in order", () => {
    expect(GUIDES.map((g) => g.id)).toEqual([
      "okta",
      "entra",
      "google-workspace",
      "generic-saml",
      "generic-oidc",
    ]);
    expect(guideOf("entra")?.name).toBe("Microsoft Entra ID");
    expect(guideOf("onelogin")).toBeNull();
  });

  it("shape: each guide parses, and checkedOn is a real date that is not in the future", () => {
    // The latest date on Earth (UTC+14): a reader in any zone may write the date of their own day.
    const today = new Date(Date.now() + 14 * 3_600_000).toISOString().slice(0, 10);
    for (const g of GUIDES) {
      const parsed = guideSchema.safeParse(g);
      expect(parsed.success, `${g.id}: ${parsed.error?.message}`).toBe(true);
      expect(g.checkedOn <= today, `${g.id} checkedOn ${g.checkedOn}`).toBe(true);
    }
  });

  it("shape: a step value has a label, a kind has its labels, and a directory has its labels", () => {
    for (const g of GUIDES) {
      for (const s of g.steps) {
        if (s.value === undefined) continue;
        const label = g.fields[s.value];
        expect(label, `${g.id}: ${s.text}`).not.toBe("");
        // One source: the step names the label of `fields`, so the two cannot drift.
        expect(s.text, `${g.id}: ${s.text}`).toContain(`"${label}"`);
      }
      if (g.kinds.includes("saml")) {
        expect(g.fields.acsUrl, g.id).not.toBe("");
        expect(g.fields.entityId, g.id).not.toBe("");
      }
      if (g.kinds.includes("oidc")) expect(g.fields.redirectUri, g.id).not.toBe("");
      if (g.directory !== null) {
        expect(g.fields.scimBaseUrl, g.id).not.toBe("");
        expect(g.fields.scimToken, g.id).not.toBe("");
      }
    }
  });

  it("fill: each value resolves to the real URL of that connection", () => {
    const { config } = makeAuth();
    const id = "ssoc_fill1";
    const want: Record<SpField, string | null> = {
      acsUrl: acsUrl(config, id),
      entityId: spEntityId(config, id),
      redirectUri: ssoCallbackUrl(config, id),
      scimBaseUrl: scimBase(config),
      // The token is shown once at its mint; no guide holds it.
      scimToken: null,
    };
    const seen = new Set<SpField>();
    for (const g of GUIDES) {
      const filled = fillGuide(config, g, id);
      expect(filled.guide).toBe(g);
      expect(filled.steps).toHaveLength(g.steps.length);
      g.steps.forEach((s, i) => {
        const f = filled.steps[i];
        expect(f?.text).toBe(s.text);
        if (s.value === undefined) {
          expect(f?.field).toBeNull();
          expect(f?.value).toBeNull();
          return;
        }
        seen.add(s.value);
        expect(f?.field).toBe(s.value);
        expect(f?.value, `${g.id}: ${s.value}`).toBe(want[s.value]);
      });
      if (g.launch.includes(START)) {
        expect(filled.launch).toContain(`${config.baseURL}${config.basePath}/sso/${id}/start`);
        expect(filled.launch).not.toContain("<id>");
      } else {
        expect(filled.launch).toBe(g.launch);
      }
    }
    // Each field comes in at least one step, so each branch of the fill ran.
    expect([...seen].sort()).toEqual([...SP_FIELDS].sort());
  });

  it("step text: one instruction, at most 20 words, no gerund as a noun", () => {
    for (const g of GUIDES) {
      for (const s of g.steps) {
        expect(words(s.text), `${g.id}: ${s.text}`).toBeLessThanOrEqual(20);
        // One sentence: it starts with a capital and ends with the one full stop.
        expect(s.text, `${g.id}: ${s.text}`).toMatch(/^[A-Z][\s\S]*\.$/);
        expect(s.text.slice(0, -1), `${g.id}: ${s.text}`).not.toMatch(/[.;!?](\s|$)/);
        expect(gerunds(s.text), `${g.id}: ${s.text}`).toEqual([]);
      }
    }
  });

  it("launch and directory: each sentence has at most 20 words and no gerund as a noun", () => {
    for (const g of GUIDES) {
      for (const text of [g.launch, g.directory ?? ""]) {
        // The whole text: a quoted doc sentence can hold a full stop, and the lint skips quotes.
        expect(gerunds(text), `${g.id}: ${text}`).toEqual([]);
        for (const sentence of text.split(/(?<=[.;:!?]"?)\s+/).filter((t) => t !== "")) {
          expect(words(sentence), `${g.id}: ${sentence}`).toBeLessThanOrEqual(20);
        }
      }
    }
  });

  it("SAML: a step asks for a persistent NameID, and a step asks for an attribute email", () => {
    // Core sends a NameIDPolicy of the persistent format and reads the address from the attribute
    // `email` (engine/sso/saml-sp.ts, saml/assertion.ts). A guide without these steps fails at sign-in.
    for (const g of GUIDES) {
      if (!g.kinds.includes("saml")) continue;
      const saml = g.steps
        .map((s) => s.text)
        .filter((t) => !t.startsWith("For OIDC,") && !t.startsWith("For SCIM,"));
      const nameId = saml.filter(
        (t) => /persistent/i.test(t) && /name ?id|name identifier/i.test(t),
      );
      const email = saml.filter((t) => /\bemail\b/.test(t) && /attribute|claim/i.test(t));
      expect(nameId.length, `${g.id}: NameID step`).toBeGreaterThanOrEqual(1);
      expect(email.length, `${g.id}: email step`).toBeGreaterThanOrEqual(1);
    }
  });

  it("launch: non-empty, and names the start route or states the gap", () => {
    for (const g of GUIDES) {
      expect(g.launch.trim(), g.id).not.toBe("");
      expect(g.launch.includes(START) || g.launch.startsWith(GAP), g.id).toBe(true);
    }
  });

  it("step text lint: the gerund list catches an -ing noun and skips a quoted label", () => {
    expect(gerunds("Do the setting of the app.")).toEqual(["setting"]);
    expect(gerunds('Open "SAML Settings" on the tab.')).toEqual([]);
  });
});
