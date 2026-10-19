import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { SITE } from "../scripts/lib/paths.ts";

const source = readFileSync(`${SITE}src/scripts/theme-toggle.js`, "utf8");

/** The toggle button of the page. The script checks a click target with instanceof Element. */
class FakeElement {
  label = "";
  setAttribute(_name: string, value: string) {
    this.label = value;
  }
  closest() {
    return this;
  }
}

/**
 * Runs the toggle in a new context with a fake page. `stored` is the value
 * of the key, null for no value, or "throw" for a store that the browser blocks.
 */
function load(stored: string | null, systemLight: boolean) {
  const store = new Map<string, string>();
  if (stored !== null && stored !== "throw") store.set("starlight-theme", stored);
  const listeners = new Map<string, (event: { target: unknown }) => void>();
  const button = new FakeElement();
  const root = { dataset: {} as Record<string, string> };
  const blocked = () => {
    throw new Error("blocked");
  };
  runInNewContext(source, {
    document: {
      documentElement: root,
      querySelector: () => button,
      addEventListener: (type: string, f: (event: { target: unknown }) => void) =>
        listeners.set(type, f),
    },
    localStorage:
      stored === "throw"
        ? { getItem: blocked, setItem: blocked }
        : {
            getItem: (k: string) => store.get(k) ?? null,
            setItem: (k: string, v: string) => store.set(k, v),
          },
    matchMedia: () => ({ matches: systemLight }),
    Element: FakeElement,
  });
  return { root, store, button, click: () => listeners.get("click")?.({ target: button }) };
}

describe("the theme toggle (brand spec 12)", () => {
  it("reads each value that Starlight's select writes", () => {
    expect(load("dark", true).root.dataset).toEqual({ theme: "dark", themeChoice: "dark" });
    expect(load("light", false).root.dataset).toEqual({ theme: "light", themeChoice: "light" });
    expect(load("", true).root.dataset).toEqual({ theme: "light", themeChoice: "auto" });
    expect(load("", false).root.dataset).toEqual({ theme: "dark", themeChoice: "auto" });
  });

  it("follows the system scheme with no stored choice", () => {
    const page = load(null, false);
    expect(page.root.dataset).toEqual({ theme: "dark", themeChoice: "auto" });
    expect(page.button.label).toBe("Use the light theme");
  });

  it("cycles auto, light, dark, and auto, and stores what Starlight's select stores", () => {
    const page = load(null, true);
    page.click();
    expect([
      page.root.dataset.themeChoice,
      page.store.get("starlight-theme"),
      page.button.label,
    ]).toEqual(["light", "light", "Use the dark theme"]);
    page.click();
    expect([page.root.dataset.theme, page.store.get("starlight-theme"), page.button.label]).toEqual(
      ["dark", "dark", "Use the system theme"],
    );
    page.click();
    expect([
      page.root.dataset.themeChoice,
      page.store.get("starlight-theme"),
      page.button.label,
    ]).toEqual(["auto", "", "Use the light theme"]);
  });

  it("cycles when the store throws", () => {
    const page = load("throw", false);
    expect(page.root.dataset).toEqual({ theme: "dark", themeChoice: "auto" });
    page.click();
    expect(page.root.dataset).toEqual({ theme: "light", themeChoice: "light" });
  });
});
