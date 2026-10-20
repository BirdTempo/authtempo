import type { DnsTxtPort } from "../../src/engine/sso/dns.js";

/**
 * A DNS port of a test: it answers from a map and counts its calls. A name
 * not in the map answers `[]`. An entry of null answers null, the answer of
 * a resolver that gives no usable answer.
 */
export function fakeDns(
  name: string,
  answers: Record<string, string[] | null | "throw">,
): DnsTxtPort & { calls: string[] } {
  const calls: string[] = [];
  return {
    name,
    calls,
    async txt(asked) {
      calls.push(asked);
      // Not `??`: it reads a null entry as a missing name, and a test then never reaches the null path.
      // The cast is safe: `hasOwn` holds, so the entry is of the map's type.
      const answer = Object.hasOwn(answers, asked)
        ? (answers[asked] as string[] | null | "throw")
        : [];
      if (answer === "throw") throw new Error(`the fake resolver ${name} fails`);
      return answer;
    },
  };
}
