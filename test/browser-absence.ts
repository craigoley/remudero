import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test as nodeTest } from "node:test";

import { requiredChromiumDirs } from "../src/lib/review.js";
import { isCiEnv } from "../src/lib/self-sync.js";
import { playwrightCacheRoot } from "../src/lib/worker-home.js";

/**
 * test/browser-absence.ts — W1-T3018. Whether the pinned Chromium build is actually here, and what
 * a browser-driving suite should do when it is not.
 *
 * WHY THIS EXISTS. With the build missing, all eleven `serve.*` suites launched anyway and emitted
 * one raw Playwright error per test — indistinguishable from a real regression. A session read that
 * as `origin/main` being 189-red and put the false claim in two merged PR bodies, while CI's own
 * shards were green on the same commits. `test/serve-launch-uniformity.test.ts` records the same
 * misreading from W1-T202: "the review host had no Chromium build matching the pinned Playwright,
 * so every launch failed deterministically and the gate reported it as a defect in the code under
 * review."
 *
 * THIS IS NOT A QUARANTINE, AND EVERY PROPERTY BELOW EXISTS TO KEEP IT FROM BECOMING ONE.
 * CLAUDE.md forbids skipping a test to reach green, so the mechanism is built to be USELESS for
 * that:
 *   - {@link skipReasonFor} returns `undefined` under CI. In CI the browser IS installed; if it is
 *     missing there, that is the defect, and the suites must fail exactly as they do today. Nothing
 *     merges on an author-time run, which is what makes the rest of this safe.
 *   - it fires only on VERIFIED absence, evaluated BEFORE any launch. A launch that fails for any
 *     other reason still fails, loudly. Conflating absence with failure is the whole defect being
 *     fixed; reproducing it inside the fix would be worse than leaving it alone.
 *   - an unreadable manifest is `unknown`, never `absent` — a skip on a guess is a quarantine.
 *
 * NOT A `.test.ts` FILE, DELIBERATELY. `test/serve-browser-teardown.test.ts` enumerates
 * browser-launching suites with a fixed-string `grep -rl -F --include=*.test.ts`, and
 * `test/serve-launch-uniformity.test.ts` does the same; a `.test.ts` helper would be recruited into
 * contracts it has no browser to satisfy.
 *
 * FALSIFIER: test/an-absent-browser-reads-as-a-repo-full-of-broken-tests.test.ts.
 */

/** What {@link classifyBrowserAbsence} reads, injected so the decision is provable without a
 *  filesystem — the same seam shape `BrowserPreflightDeps` (src/lib/review.ts) already uses. */
export interface BrowserAbsenceDeps {
  /** The pinned Playwright's `browsers.json`, or `null` when it could not be read. */
  browsersJsonText: string | null;
  /** True when `<cacheRoot>/<dir>` holds a COMPLETE install — Playwright writes
   *  `INSTALLATION_COMPLETE` last, so a half-extracted directory reads as absent. */
  isInstalled: (dir: string) => boolean;
}

/** THREE OUTCOMES, NEVER TWO. `unknown` is the one that keeps this honest: "we could not tell"
 *  must not collapse into either "it is here" or "it is missing". */
export type BrowserAbsence =
  | { kind: "present" }
  | { kind: "absent"; missing: string[]; reason: string }
  | { kind: "unknown"; reason: string };

/** Is the pinned Chromium build here? Reuses {@link requiredChromiumDirs}, the manifest reader the
 *  browser preflight already owns, rather than a second copy that could drift from it. */
export function classifyBrowserAbsence(deps: BrowserAbsenceDeps): BrowserAbsence {
  if (deps.browsersJsonText === null) {
    return { kind: "unknown", reason: "playwright's browsers.json could not be read" };
  }
  let required: string[];
  try {
    required = requiredChromiumDirs(deps.browsersJsonText);
  } catch {
    return { kind: "unknown", reason: "playwright's browsers.json is malformed" };
  }
  // AN EMPTY REQUIREMENT SET IS NOT A SATISFIED ONE. `missing.length === 0` is true over both, and
  // they mean opposite things — the vacuous-pass family this repo has paid for repeatedly. A
  // manifest that parses but names no chromium build (an `installByDefault` flag moved, a schema
  // change) must read as `unknown`, never as a healthy host.
  if (required.length === 0) {
    return { kind: "unknown", reason: "playwright's browsers.json names no chromium build to require" };
  }
  const missing = required.filter((dir) => !deps.isInstalled(dir));
  if (missing.length === 0) return { kind: "present" };
  return {
    kind: "absent",
    missing,
    reason: `the pinned Playwright needs ${missing.join(", ")} and the cache does not hold ${
      missing.length === 1 ? "it" : "them"
    }`,
  };
}

/** The skip reason, or `undefined` when the suite must RUN — including every case where running
 *  will fail. Under CI that is the whole point: an absent browser there is a real failure. */
export function skipReasonFor(absence: BrowserAbsence, opts: { ci: boolean }): string | undefined {
  if (absence.kind !== "absent") return undefined;
  if (opts.ci) return undefined;
  return `SKIPPED — no browser: ${absence.reason}. Run \`npx playwright install chromium\`. This suite did NOT pass; it did not run.`;
}

/** One line per PROCESS, not per suite: eleven suites must not turn 173 errors into 11 lines.
 *  A factory rather than module state, so a test can drive it without resetting a global. */
export function browserAbsenceAnnouncement(log: (msg: string) => void): (reason: string) => void {
  let announced = false;
  return (reason: string) => {
    if (announced) return;
    announced = true;
    log(reason);
  };
}

function readBrowsersJson(): string | null {
  try {
    return readFileSync(join(process.cwd(), "node_modules", "playwright-core", "browsers.json"), "utf8");
  } catch {
    return null;
  }
}

/** The live answer for this process, computed ONCE. A suite reads {@link BROWSER_SKIP} and, when it
 *  is set, neither launches nor registers its tests as anything but skipped. */
export const BROWSER_ABSENCE: BrowserAbsence = classifyBrowserAbsence({
  browsersJsonText: readBrowsersJson(),
  isInstalled: (dir) => existsSync(join(playwrightCacheRoot(), dir, "INSTALLATION_COMPLETE")),
});

export const BROWSER_SKIP: string | undefined = skipReasonFor(BROWSER_ABSENCE, { ci: isCiEnv(process.env) });

const announce = browserAbsenceAnnouncement((m) => console.error(m));
if (BROWSER_SKIP !== undefined) announce(BROWSER_SKIP);

/**
 * `test`, but SKIPPED (never failed, never silently absent) when the browser is verifiably missing
 * on an author-time host. Suites import it as `test`, so no call site changes and the skip cannot
 * be applied to one test and forgotten on another.
 *
 * EVERY test in the file is registered as skipped rather than dropped: `# skipped N` then reports
 * the real number, so nothing vanishes from the accounting. The single NAMED announcement is
 * emitted once per process by the module body above — replacing 173 errors with 173 lines would
 * not be an improvement.
 *
 * NOT FOR test/workflow-playwright-install.test.ts. That file is W1-T1027's falsifier: it exists to
 * prove `npx playwright install chromium` produced a working browser, so an absent browser IS its
 * finding and skipping it would delete the only thing it checks. The exclusion is enforced by
 * {@link test/an-absent-browser-reads-as-a-repo-full-of-broken-tests.test.ts}, not left to memory.
 */
export type BrowserTestFn = (t: unknown) => void | Promise<void>;
export type BrowserTestOptions = Record<string, unknown>;

export function browserTest(name: string, optionsOrFn: BrowserTestOptions | BrowserTestFn, maybeFn?: BrowserTestFn): void {
  const options: BrowserTestOptions = typeof optionsOrFn === "function" ? {} : optionsOrFn;
  const fn: BrowserTestFn | undefined = typeof optionsOrFn === "function" ? optionsOrFn : maybeFn;
  const withSkip = BROWSER_SKIP === undefined ? options : { ...options, skip: BROWSER_SKIP };
  // One `as` at the boundary rather than fighting node:test's overload tuple in four places — the
  // shape is checked above, and the cast is confined to this single call.
  (nodeTest as unknown as (n: string, o: BrowserTestOptions, f?: BrowserTestFn) => void)(name, withSkip, fn);
}
