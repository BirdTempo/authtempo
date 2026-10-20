import type { DnsTxtPort } from "../../src/engine/sso/dns.js";

/** A DNS port of a test: it answers from a map and counts its calls. A name not in the map answers `[]`. */
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
      const answer = answers[asked] ?? [];
      if (answer === "throw") throw new Error(`the fake resolver ${name} fails`);
      return answer;
    },
  };
}
