/** A redirect target the engine will follow: a relative path, not a second origin. */
export function safeNext(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return "/";
  if (!value.startsWith("/")) return "/";
  if (value.startsWith("//") || value.startsWith("/\\")) return "/";
  if (hasControlOrBackslash(value)) return "/";
  return value;
}

// Browsers strip tabs and newlines from URLs, so "/\t/x" reads as "//x".
// A loop, not a regex: Biome rejects control characters in regex literals.
function hasControlOrBackslash(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f || ch === "\\") return true;
  }
  return false;
}
