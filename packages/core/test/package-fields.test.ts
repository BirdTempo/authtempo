import { describe, expect, it } from "vitest";
import manifestText from "../package.json?raw";
import { SCHEMA_VERSION } from "../src/schema.js";

// Core's tests have no Node types, so the file comes in as Vite's ?raw text (test/raw.d.ts).
const manifest = JSON.parse(manifestText) as {
  files?: string[];
  authtempo?: { schemaVersion?: unknown };
};

describe("the release fields of core's package.json (plan 12j Task 3)", () => {
  // `authtempo upgrade` reads the field from the registry document, with no download.
  it("holds the schema field to SCHEMA_VERSION, which upgrade reads from the registry", () => {
    expect(manifest.authtempo?.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it("lists CHANGELOG.md in files", () => {
    expect(manifest.files).toContain("CHANGELOG.md");
  });
});
