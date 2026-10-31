import { expect, it } from "vitest";
import manifestText from "../package.json?raw";
import {
  DEFAULT_RESERVED_SLUGS,
  LEGACY_VERIFY_HASH,
  newId,
  normalizeEmail,
  PENDING_HASH_PREFIX,
  VERSION,
  validOrganizationName,
  validUserName,
} from "../src/index.js";

it("exports the version of package.json", () => {
  expect(VERSION).toBe((JSON.parse(manifestText) as { version: string }).version);
});

it("exports what the importer (plan 9b) consumes", () => {
  expect(LEGACY_VERIFY_HASH).toBe("legacy-verify$");
  expect(PENDING_HASH_PREFIX).toBe("pending$");
  expect(DEFAULT_RESERVED_SLUGS).toContain("admin");
  expect(normalizeEmail(" Ada@Example.com ")).toBe("ada@example.com");
  expect(typeof newId(new Date())).toBe("string");
  expect(validOrganizationName("Acme")).toBe(true);
  expect(validUserName("Ada")).toBe(true);
});
