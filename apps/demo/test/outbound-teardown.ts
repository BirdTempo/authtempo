import { escapes, outboundLog } from "./outbound-log.js";

/**
 * The global setup of the pool (ruling 40 of the plan 11b lane). Its teardown
 * runs once after every pool file, in any file order. It fails the run when
 * any file sent a request out of the Worker, so each test is part of the proof.
 */
export default function setup(): () => void {
  return () => {
    const out = escapes(outboundLog());
    if (out.length > 0)
      throw new Error(`demo: ${out.length} request(s) left the Worker: ${out.join(", ")}`);
  };
}
