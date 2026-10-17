import { describe, expect, it } from "vitest";
import { INSTRUCTIONS } from "../src/server.js";
import { TOOLS } from "../src/tools.js";

/** Each backticked name of a text, in order. */
const named = (text: string): string[] => [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? "");

const on = (surface: "local" | "remote") =>
  TOOLS.filter((t) => t.surfaces.includes(surface)).map((t) => t.name);

describe("the instructions of the server", () => {
  it("names only tools of the local surface in the local text", () => {
    const names = named(INSTRUCTIONS.local);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(on("local"), name).toContain(name);
  });

  it("names only tools of the remote surface in the remote text", () => {
    const names = named(INSTRUCTIONS.remote);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(on("remote"), name).toContain(name);
  });

  it("names every tool of the remote surface in the remote text, or it is version", () => {
    const names = named(INSTRUCTIONS.remote);
    for (const tool of on("remote")) if (tool !== "version") expect(names, tool).toContain(tool);
  });

  it("makes the remote text the first three sentences of the local text", () => {
    const sentences = INSTRUCTIONS.local.split(/(?<=\.) /);
    expect(INSTRUCTIONS.remote).toBe(sentences.slice(0, 3).join(" "));
  });

  it("states the effect of each tool in the first sentence of its description", () => {
    for (const tool of TOOLS) {
      const first = tool.description.split(/(?<=\.) /)[0] ?? "";
      expect(first, tool.name).toMatch(/\b(reads|writes)\b/i);
    }
  });
});
