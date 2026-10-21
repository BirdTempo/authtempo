/**
 * The log lines of the measure entry (plan 12h Task 15). The entry writes
 * them, and apps/site/scripts/measure-performance.ts reads them from the
 * output of `wrangler dev`. One file holds the form for both.
 */
export const MEASURE_PREFIX = "authtempo-measure ";

/** One answer of `handle`, from its `request` event. */
export interface MeasureRequestLine {
  kind: "request";
  traceId: string;
  route: string;
  status: number;
  durationMs: number;
}

/** One mail of the outbox. */
export interface MeasureMailLine {
  kind: "mail";
  to: string;
  text: string;
}

export type MeasureLine = MeasureRequestLine | MeasureMailLine;

/** The line of one value: the prefix and one JSON object. */
export function measureLine(line: MeasureLine): string {
  return `${MEASURE_PREFIX}${JSON.stringify(line)}`;
}
