import { cssRules, declarations } from "./lib/css.ts";
import { pageCss } from "./lib/html.ts";
import { type CheckReport, requireCounts } from "./lib/report.ts";

/** The three motions of brand spec 7 that use keyframes: the beat, the entrance, the icon draw. */
export const MOTION_KEYFRAMES = ["at-beat", "at-enter", "at-draw"] as const;
const REDUCE = "@media (prefers-reduced-motion: reduce)";
const ALL = "*, *::before, *::after";

/**
 * Brand spec 7 and 14. Every keyframe lives in tokens.css and sets a start
 * state only. No animation keeps its end state, so an element rests at its
 * own style. Under reduced motion every animation is none, on every page.
 */
export function checkMotion(input: {
  tokensCss: string;
  sources: readonly { path: string; text: string }[];
  pages: ReadonlyMap<string, string>;
  read: (href: string) => string | null;
}): CheckReport {
  const r: CheckReport = {
    name: "check-motion",
    counts: { pages: 0, keyframes: 0, animations: 0 },
    failures: [],
  };
  const rules = cssRules(input.tokensCss);
  const reduce = rules.find((x) => x.at === REDUCE && x.selector === ALL);
  const rd = reduce ? declarations(reduce.body) : new Map<string, string>();
  if (
    rd.get("animation") !== "none !important" ||
    rd.get("transition-duration") !== "0s !important"
  )
    r.failures.push(
      `tokens.css lacks ${REDUCE} { ${ALL} { animation: none !important; transition-duration: 0s !important; } }`,
    );
  const frames = new Set<string>();
  for (const x of rules) {
    const name = /^@keyframes (\S+)$/.exec(x.at)?.[1];
    if (name === undefined) continue;
    frames.add(name);
    if (x.selector === "to" || x.selector === "100%")
      r.failures.push(
        `@keyframes ${name} sets an end state; the end state is the element's own style`,
      );
  }
  r.counts.keyframes = frames.size;
  for (const name of frames)
    if (!(MOTION_KEYFRAMES as readonly string[]).includes(name))
      r.failures.push(`@keyframes ${name} is not a motion of brand spec section 7`);
  for (const x of rules)
    for (const [prop, value] of declarations(x.body)) {
      if (prop !== "animation" && prop !== "animation-name" && prop !== "animation-fill-mode")
        continue;
      if (prop !== "animation-fill-mode" && !/^none(?: !important)?$/.test(value)) {
        r.counts.animations = (r.counts.animations ?? 0) + 1;
        const used = value.split(/[\s,]+/).find((w) => w.startsWith("at-"));
        if (used === undefined || !frames.has(used))
          r.failures.push(
            `${x.selector} runs an animation with no keyframes of tokens.css: ${value}`,
          );
      }
      if (/\b(?:forwards|both)\b/.test(value))
        r.failures.push(
          `${x.selector} keeps the end state of an animation (${value}); use backwards`,
        );
    }
  for (const f of input.sources)
    if (/@keyframes\b|\banimation(?:-name)?\s*:/.test(f.text))
      r.failures.push(`${f.path} declares an animation; motion lives in tokens.css only`);
  for (const [page, html] of input.pages) {
    const css = pageCss(html, input.read).replace(/\s+/g, "");
    if (css.includes("prefers-reduced-motion:reduce") && css.includes("animation:none!important"))
      r.counts.pages = (r.counts.pages ?? 0) + 1;
    else r.failures.push(`${page} has no CSS with the reduced-motion block`);
  }
  return requireCounts(r, ["pages", "keyframes", "animations"]);
}
