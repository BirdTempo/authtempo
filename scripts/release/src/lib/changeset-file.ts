export type Bump = "major" | "minor" | "patch";

export interface Changeset {
  releases: { name: string; bump: Bump }[];
  /** The text after the second `---` line, trimmed: the changelog entry. */
  body: string;
}

const RELEASE_LINE = /^(["'])([^"']+)\1:\s*(major|minor|patch)\s*$/;

/**
 * Reads one `.changeset/*.md` file. The frontmatter is the lines between the
 * first two `---` lines, and each one is `"<name>": <bump>` or `'<name>': <bump>`.
 * Any other line throws with its line number, so a typo cannot drop a package.
 */
export function parseChangeset(text: string): Changeset {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[0]?.trim() !== "---") throw new Error('line 1 is not "---"');
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  if (end === -1) throw new Error('the frontmatter has no closing "---" line');
  const releases: Changeset["releases"] = [];
  for (let i = 1; i < end; i++) {
    const line = lines[i] ?? "";
    const match = RELEASE_LINE.exec(line);
    const name = match?.[2];
    const bump = match?.[3];
    if (name === undefined || bump === undefined)
      throw new Error(`line ${i + 1}: "${line}" is not "<name>": major|minor|patch`);
    releases.push({ name, bump: bump as Bump });
  }
  return {
    releases,
    body: lines
      .slice(end + 1)
      .join("\n")
      .trim(),
  };
}
