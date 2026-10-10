/** The one construction error. `refusals` lists every refused item as `<path>: <reason>`, sorted by path. */
export class BetterAuthCompatError extends Error {
  readonly refusals: readonly string[];
  constructor(refusals: readonly string[]) {
    const sorted = [...refusals].sort();
    super(
      `tempo-auth compat: this config uses ${sorted.length} ${sorted.length === 1 ? "item" : "items"} that tempo-auth cannot keep:\n${sorted.map((r) => `- ${r}`).join("\n")}`,
    );
    this.name = "BetterAuthCompatError";
    this.refusals = sorted;
  }
}
